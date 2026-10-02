#!/bin/sh
# phase0-preflight — can this NAS host the powerhouse layout?
#
# Read-only. Reports; changes nothing. Run it ON THE NAS as root (docker on
# UGOS needs sudo), from anywhere:
#
#   sudo sh phase0-preflight.sh [/path/to/existing/jellyfin/library]
#
# It answers the four host questions from phase 00 of the build plan that a
# dev machine cannot answer:
#   • can gluetun run here (NET_ADMIN + /dev/net/tun, and kernel WireGuard)
#   • where Jellyfin is, if it is on this box at all
#   • do the library and torrent roots share one filesystem (hardlinks)
#   • is there room for a 15 TB budget plus reserve
set -u

LIB="${1:-${JELLYFIN_LIBRARY:-}}"
MEDIA_ROOT="${MEDIA_ROOT:-/volume1/media}"
BUDGET_TB=15
RESERVE_GB=300

ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
note() { printf '        %s\n' "$1"; }
FAILED=0

echo
echo "  Mediawan · phase 0 preflight"
echo

[ "$(id -u)" -eq 0 ] || warn "not root — docker checks below will probably fail; re-run with sudo"

# ---- 1. VPN prerequisites ----
echo "  VPN container prerequisites"
if [ -c /dev/net/tun ]; then
  ok "/dev/net/tun present"
else
  bad "/dev/net/tun missing — gluetun cannot start."
  note "Try: mkdir -p /dev/net && mknod /dev/net/tun c 10 200 && chmod 600 /dev/net/tun"
  note "If UGOS recreates /dev on boot, that needs a boot script; otherwise fall back"
  note "to a userspace WireGuard image as the plan describes."
  FAILED=1
fi
KVER=$(uname -r)
KMAJ=$(echo "$KVER" | cut -d. -f1); KMIN=$(echo "$KVER" | cut -d. -f2)
if [ -d /sys/module/wireguard ] || modprobe -n wireguard 2>/dev/null; then
  ok "kernel WireGuard available (kernel $KVER)"
elif [ "$KMAJ" -gt 5 ] || { [ "$KMAJ" -eq 5 ] && [ "$KMIN" -ge 6 ]; }; then
  warn "kernel $KVER should include WireGuard but the module is not loaded/visible; gluetun will report it"
else
  warn "kernel $KVER predates in-tree WireGuard (5.6); expect gluetun to need the userspace fallback"
fi
if command -v docker >/dev/null 2>&1; then
  if docker run --rm --cap-add=NET_ADMIN --device=/dev/net/tun:/dev/net/tun alpine:3 sh -c 'ls -l /dev/net/tun >/dev/null && ip link add wgtest0 type wireguard 2>/dev/null && ip link del wgtest0 && echo kernel-wg || echo no-kernel-wg' >/tmp/p0wg 2>/tmp/p0wg.err; then
    case "$(cat /tmp/p0wg)" in
      *kernel-wg*) ok "a container with NET_ADMIN can create a WireGuard interface" ;;
      *) warn "container got NET_ADMIN and the tun device but could not create a WireGuard link"; note "$(head -c 300 /tmp/p0wg.err)" ;;
    esac
  else
    bad "docker could not start a container with NET_ADMIN + /dev/net/tun"
    note "$(head -c 300 /tmp/p0wg.err)"
    FAILED=1
  fi
else
  bad "docker not on PATH"; FAILED=1
fi
echo

# ---- 2. Jellyfin ----
echo "  Jellyfin"
JF=$(docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null | grep -i jellyfin || true)
if [ -n "$JF" ]; then
  ok "container running:"
  echo "$JF" | sed 's/^/        /'
  JFNAME=$(echo "$JF" | head -1 | cut -f1)
  docker inspect "$JFNAME" --format '{{range .Mounts}}        mount {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' 2>/dev/null
  V=$(curl -s -m 3 http://127.0.0.1:8096/System/Info/Public 2>/dev/null || true)
  [ -n "$V" ] && note "version: $(echo "$V" | sed 's/.*"Version":"\([^"]*\)".*/\1/')"
else
  ALL=$(docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null | grep -i jellyfin || true)
  if [ -n "$ALL" ]; then
    warn "a Jellyfin container exists but is not running:"
    echo "$ALL" | sed 's/^/        /'
  else
    warn "no Jellyfin container on this host. If it runs elsewhere, note its address in docs/phase-0.md."
  fi
fi
echo

# ---- 3. one filesystem for library + torrents ----
echo "  Filesystem layout"
if [ -z "$LIB" ]; then
  # Best guess: any dir under the media root, or under the volume, named like a library.
  LIB=$(find /volume1 -maxdepth 3 -type d \( -iname 'movies' -o -iname 'films' -o -iname 'shows' -o -iname 'tv' -o -iname 'series' \) 2>/dev/null | head -1)
  [ -n "$LIB" ] && note "guessing library root from $LIB (pass the real one as the first argument)"
fi
if [ -n "$LIB" ] && [ -d "$LIB" ]; then
  LIBDEV=$(stat -c '%d' "$LIB")
  LIBFS=$(df -PT "$LIB" | awk 'NR==2{print $2" on "$7}')
  ok "library root $LIB is on $LIBFS"
else
  warn "no library root found; skipping the shared-filesystem test"
  LIBDEV=""
fi
TROOT="$MEDIA_ROOT/torrents"
TPARENT="$MEDIA_ROOT"
while [ ! -d "$TPARENT" ] && [ "$TPARENT" != "/" ]; do TPARENT=$(dirname "$TPARENT"); done
TDEV=$(stat -c '%d' "$TPARENT")
note "torrent root would be $TROOT (nearest existing parent: $TPARENT, $(df -PT "$TPARENT" | awk 'NR==2{print $2}'))"
if [ -n "$LIBDEV" ]; then
  if [ "$LIBDEV" = "$TDEV" ]; then
    ok "library and torrent roots share one filesystem (device $LIBDEV) — hardlinks will work"
  else
    bad "library ($LIBDEV) and torrent root ($TDEV) are on different filesystems — hardlinks impossible"
    note "Move the library under $MEDIA_ROOT (same volume = instant mv), or set MEDIA_ROOT to the library's volume."
    FAILED=1
  fi
  # Prove it rather than infer it.
  T1=$(mktemp -p "$LIB" .p0-XXXXXX 2>/dev/null || true)
  if [ -n "$T1" ]; then
    if ln "$T1" "$TPARENT/.p0-link-test" 2>/dev/null; then
      ok "test hardlink $LIB -> $TPARENT succeeded"
      rm -f "$TPARENT/.p0-link-test"
    else
      bad "hardlink from library to $TPARENT refused"
      FAILED=1
    fi
    rm -f "$T1"
  else
    warn "could not create a temp file in $LIB to test linking (permissions?)"
  fi
fi
echo

# ---- 4. room for the budget ----
echo "  Capacity"
SIZE_K=$(df -Pk "$TPARENT" | awk 'NR==2{print $2}')
AVAIL_K=$(df -Pk "$TPARENT" | awk 'NR==2{print $4}')
SIZE_TB=$(awk "BEGIN{printf \"%.2f\", $SIZE_K/1024/1024/1024}")
AVAIL_TB=$(awk "BEGIN{printf \"%.2f\", $AVAIL_K/1024/1024/1024}")
LIB_TB="?"
[ -n "$LIBDEV" ] && LIB_TB=$(du -sk "$LIB" 2>/dev/null | awk '{printf "%.2f", $1/1024/1024/1024}')
note "volume size ${SIZE_TB} TB, free ${AVAIL_TB} TB, existing library ${LIB_TB} TB"
NEED_TB=$(awk "BEGIN{printf \"%.2f\", $BUDGET_TB + $RESERVE_GB/1024}")
if awk "BEGIN{exit !($SIZE_TB >= $NEED_TB)}"; then
  ok "volume can hold the ${BUDGET_TB} TB budget plus ${RESERVE_GB} GB reserve"
else
  bad "volume (${SIZE_TB} TB) is smaller than budget + reserve (${NEED_TB} TB) — lower CACHE_BUDGET_BYTES"
  FAILED=1
fi
echo

# ---- 5. what else is running ----
echo "  Containers on this host"
docker ps --format '        {{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null || note "(docker ps failed)"
echo

if [ "$FAILED" -eq 0 ]; then
  echo "  Host is ready for phase 01. Copy the lines above into docs/phase-0.md."
else
  echo "  Fix the FAIL lines before phase 01."
  exit 1
fi
echo
