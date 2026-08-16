#!/bin/sh
# nas-preflight — check this box can actually run Mediawan, and write the
# machine-specific values into .env.
#
# Run it ON THE NAS, from the project directory, BEFORE `docker compose up`:
#
#   sh scripts/nas-preflight.sh
#
# Four things are host facts that cannot be guessed from a dev machine:
#   • whether /dev/dri exists at all (a missing device is a HARD container
#     start failure, not a warning)
#   • the video/render group ids that own it — wrong ones pass the device
#     through but leave it unopenable, so QuickSync fails SILENTLY and ffmpeg
#     drops to software encoding that an N100 cannot sustain
#   • where the array is mounted, so the source cache doesn't fill the project
#     directory
#   • whether .env carries the secrets compose interpolates at runtime
set -eu

ENV_FILE="${ENV_FILE:-.env}"
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }

# Replace KEY=... in .env, or append it if absent.
setenv() {
  key=$1; val=$2
  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    tmp=$(mktemp)
    sed "s|^${key}=.*|${key}=${val}|" "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
  printf '        set %s=%s\n' "$key" "$val"
}

echo
echo "  Mediawan · NAS preflight"
echo

[ -f "$ENV_FILE" ] || { bad "$ENV_FILE not found — copy .env.example to .env first"; exit 1; }

# ---- 1. QuickSync device ----
echo "  GPU / QuickSync"
FAILED=0
if [ ! -d /dev/dri ]; then
  bad "/dev/dri does not exist."
  echo "        The container will REFUSE TO START with the devices: block in"
  echo "        docker-compose.yml. Either pass the iGPU through to this host"
  echo "        (if Docker runs in a VM), or comment out that block and accept"
  echo "        software encoding."
  FAILED=1
else
  ok "/dev/dri present: $(ls /dev/dri | tr '\n' ' ')"
  # renderD* is the node ffmpeg actually opens; card* is the display node.
  RENDER_NODE=$(ls /dev/dri 2>/dev/null | grep '^renderD' | head -1 || true)
  if [ -z "$RENDER_NODE" ]; then
    warn "no renderD* node — QuickSync needs one; only card* is present"
  fi
  # Read the owning groups off the real devices rather than assuming Debian's.
  VG=$(stat -c '%g' /dev/dri/card0 2>/dev/null || echo "")
  RG=$(stat -c '%g' "/dev/dri/${RENDER_NODE:-renderD128}" 2>/dev/null || echo "")
  [ -n "$VG" ] && setenv VIDEO_GID "$VG"  || warn "could not read the video group id; leaving VIDEO_GID as-is"
  [ -n "$RG" ] && setenv RENDER_GID "$RG" || warn "could not read the render group id; leaving RENDER_GID as-is"
fi
echo

# ---- 2. storage ----
echo "  Storage"
# Largest mounted filesystem that isn't the root/overlay — that's the array.
ARRAY=$(df -P 2>/dev/null | awk 'NR>1 && $6 !~ /^\/(dev|proc|sys|run|etc|$)/ && $4+0 > max { max=$4+0; m=$6 } END { print m }')
if [ -n "${ARRAY:-}" ] && [ "$ARRAY" != "/" ]; then
  AVAIL=$(df -Ph "$ARRAY" | awk 'NR==2 {print $4}')
  ok "largest volume: $ARRAY ($AVAIL free)"
  setenv DATA_DIR  "$ARRAY/mediawan/data"
  setenv MEDIA_DIR "$ARRAY/mediawan/media"
  if mkdir -p "$ARRAY/mediawan/data" "$ARRAY/mediawan/media/cache" 2>/dev/null; then
    ok "created $ARRAY/mediawan/{data,media/cache}"
  else
    warn "could not create those directories — check permissions"
  fi

  # Ownership must be uid 1000 ON THE HOST.
  #
  # The image chowns /data and /media to the `node` user (uid 1000) at build
  # time, but a bind mount OVERLAYS that path: the host directory's ownership
  # is what the container sees, and the image's chown is irrelevant. Created as
  # root — which is what happens when this script is run with sudo — the app
  # cannot write, and the first thing it does is open a SQLite file:
  #   Error: unable to open database file  (ERR_SQLITE_ERROR, errcode 14)
  # which reads like a missing file and is actually a permission denial.
  if chown -R 1000:1000 "$ARRAY/mediawan" 2>/dev/null; then
    ok "chowned $ARRAY/mediawan to uid 1000 (the container's node user)"
  else
    OWNER=$(stat -c '%u' "$ARRAY/mediawan" 2>/dev/null || echo "?")
    if [ "$OWNER" = "1000" ]; then
      ok "$ARRAY/mediawan already owned by uid 1000"
    else
      bad "$ARRAY/mediawan is owned by uid $OWNER, but the app runs as uid 1000."
      echo "        The container will crash on startup with"
      echo "        'unable to open database file'. Fix with:"
      echo "          sudo chown -R 1000:1000 $ARRAY/mediawan"
      FAILED=1
    fi
  fi
else
  warn "couldn't identify a data volume; DATA_DIR/MEDIA_DIR left as-is."
  echo "        Set them by hand — the source cache is budgeted at 2 TB and must"
  echo "        NOT sit in the project directory."
fi
echo

# ---- 3. secrets compose needs at runtime ----
echo "  Configuration"
for k in ADMIN_EMAIL ADMIN_PASSWORD REAL_DEBRID_TOKEN TUNNEL_TOKEN; do
  v=$(grep -E "^${k}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
  case "$k:$v" in
    *:"") bad "$k is empty — compose interpolates it at runtime, so it must be set here"; FAILED=1 ;;
    ADMIN_PASSWORD:changeme) bad "ADMIN_PASSWORD is still 'changeme' — production refuses to start" ; FAILED=1 ;;
    *) ok "$k set" ;;
  esac
done
# tv-build ships in the image; esbuild is a devDependency so it can't be made there.
[ -f public/tv-build/app.js ] \
  && ok "public/tv-build present (old Samsung TVs need it)" \
  || warn "public/tv-build missing — run 'npm run build:tv' on a machine with devDependencies"
echo

if [ "$FAILED" -eq 0 ]; then
  echo "  Ready. Next:"
  echo "    docker compose up -d --build && docker compose run --rm web vainfo"
  echo
  echo "  vainfo should list an iHD driver with H264 entrypoints. Anything else"
  echo "  means the image is fine but you are on software encoding."
else
  echo "  Fix the FAIL lines above before deploying."
  exit 1
fi
echo
