#!/bin/sh
# Saves your NordVPN login for the optional "vpn" service, without showing it on screen
# and without putting it in .env or the compose file.
#
#   sudo ./vpn-credentials.sh           enter or replace the login, then start the tunnel
#   sudo ./vpn-credentials.sh status    show whether the tunnel is connected, and its address
#   sudo ./vpn-credentials.sh remove    stop the tunnel and delete the saved login
#
# Where to find the login: nordaccount.com > NordVPN > "Set up NordVPN manually". That page
# gives SERVICE CREDENTIALS (a long username and password). They are not your NordVPN
# e-mail and password, which will not work here.
set -eu
cd "$(dirname "$0")"

if [ "$(id -u)" != "0" ]; then
  echo "Run this with sudo, so the saved login is readable by root only:  sudo $0 ${1:-}" >&2
  exit 1
fi

DIR="${VPN_SECRETS_DIR:-./vpn-secrets}"
compose() { docker compose --profile vpn "$@"; }

set_env() { # set_env NAME value : add or replace one line in .env
  touch .env
  chmod 600 .env
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

ask_hidden() { # ask_hidden "Prompt" : the answer is left in $REPLY and never echoed
  printf '%s: ' "$1" >&2
  stty -echo
  trap 'stty echo' EXIT INT TERM
  IFS= read -r REPLY
  stty echo
  trap - EXIT INT TERM
  printf '\n' >&2
}

status() {
  if ! compose ps --status running --services 2>/dev/null | grep -qx vpn; then
    echo "The VPN tunnel is not running."
    return 0
  fi
  echo "The VPN tunnel is running. Its last messages:"
  compose logs --no-log-prefix --tail 200 vpn 2>/dev/null \
    | grep -iE "public ip|healthy|AUTH_FAILED|auth failure|error|initialization sequence completed" \
    | tail -6 || true
}

case "${1:-set}" in
  status)
    status
    exit 0
    ;;
  remove)
    compose rm -sf vpn >/dev/null 2>&1 || true
    rm -rf "$DIR"
    echo "The tunnel is stopped and the saved NordVPN login is deleted."
    exit 0
    ;;
  set) ;;
  *)
    echo "Usage: sudo $0 [set|status|remove]" >&2
    exit 1
    ;;
esac

echo "Which NordVPN login do you have?"
echo "  1) Service credentials (username and password from 'Set up NordVPN manually')"
echo "  2) A NordLynx / WireGuard private key"
printf 'Choose 1 or 2 [1]: '
IFS= read -r choice
umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"

if [ "${choice:-1}" = "2" ]; then
  ask_hidden "NordLynx private key"
  [ -n "$REPLY" ] || { echo "Nothing entered; nothing changed." >&2; exit 1; }
  printf '%s' "$REPLY" > "$DIR/wireguard_private_key"
  rm -f "$DIR/openvpn_user" "$DIR/openvpn_password"
  set_env NORDVPN_TYPE wireguard
else
  ask_hidden "Service username"
  user=$REPLY
  ask_hidden "Service password"
  [ -n "$user" ] && [ -n "$REPLY" ] || { echo "Nothing entered; nothing changed." >&2; exit 1; }
  printf '%s' "$user" > "$DIR/openvpn_user"
  printf '%s' "$REPLY" > "$DIR/openvpn_password"
  rm -f "$DIR/wireguard_private_key"
  set_env NORDVPN_TYPE openvpn
fi
REPLY=
chmod 600 "$DIR"/*

printf 'Country to connect through [Netherlands]: '
IFS= read -r country
set_env NORDVPN_COUNTRY "${country:-Netherlands}"

echo "Saved. Starting the tunnel..."
compose up -d --force-recreate vpn
echo "Waiting up to a minute for it to connect..."
n=0
while [ $n -lt 12 ]; do
  sleep 5
  n=$((n + 1))
  if compose logs --no-log-prefix --tail 200 vpn 2>/dev/null | grep -qiE "public ip address is|AUTH_FAILED|auth failure"; then
    break
  fi
done
status
echo
echo "If it says AUTH_FAILED, the login was not accepted: run this again and re-enter it."
