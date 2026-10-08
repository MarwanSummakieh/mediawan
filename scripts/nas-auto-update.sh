#!/bin/sh
# Run every five minutes from the NAS user's crontab. Only web is recreated.
set -eu
umask 077
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH
root=${1:-/volume1/docker/mediawan}
compose=$root/docker-compose.yaml
state=$root/auto-update
mkdir -p "$state"
exec 9>"$state/lock"
flock -n 9 || exit 0

latest=ghcr.io/marwansummakieh/mediawan:latest
timeout 240 docker pull "$latest" >"$state/pull.log" 2>&1
image=$(docker image inspect -f '{{index .RepoDigests 0}}' "$latest")
case "$image" in ghcr.io/marwansummakieh/mediawan@sha256:*) ;; *) exit 1 ;; esac
target=$(docker image inspect -f '{{.Id}}' "$image")
current=$(docker inspect -f '{{.Image}}' mediawan-web-1)
[ "$target" != "$current" ] || exit 0
if [ -f "$state/rejected-image" ] && [ "$(cat "$state/rejected-image")" = "$image" ]; then
  exit 0
fi
revision=$(docker run --rm --network none --entrypoint node "$image" -e 'const r=process.env.APP_REVISION;if(!/^[a-f0-9]{40}$/.test(r||""))process.exit(1);console.log(r)')
release=$root/releases/auto-$revision-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$release"
cp "$compose" "$release/docker-compose.before.yaml"
docker inspect -f '{{.Config.Image}}' mediawan-web-1 >"$release/image.before.txt"
printf '%s\n' "$image" >"$release/image.after.txt"
rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    cp "$release/docker-compose.before.yaml" "$compose"
    docker compose -p mediawan -f "$compose" up -d --no-deps --pull never --force-recreate web >>"$release/deploy.log" 2>&1
    printf '%s\n' "$image" >"$state/rejected-image"
    printf '%s Upgrade to %s failed; restored the previous web image. See %s\n' "$(date -u +%FT%TZ)" "$revision" "$release"
  fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 1' HUP INT TERM
python3 - "$compose" "$image" <<'PY'
import json, os, sys
path,image=sys.argv[1:]
with open(path) as f: config=json.load(f)
before=json.loads(json.dumps(config))
config['services']['web']['image']=image
before['services']['web']['image']=image
assert config==before
with open(path+'.auto-next','w') as f: json.dump(config,f,indent=2)
os.chmod(path+'.auto-next',0o600)
os.replace(path+'.auto-next',path)
PY
docker compose -p mediawan -f "$compose" up -d --no-deps --pull never --force-recreate web >"$release/deploy.log" 2>&1
ready=false
for attempt in $(seq 1 45); do
  if docker exec mediawan-web-1 node -e "fetch('http://127.0.0.1:8787/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)throw Error();return r.json()}).then(h=>{if(!h.ok||h.revision!=='$revision')process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready=true; break
  fi
  sleep 2
done
[ "$ready" = true ]
printf '%s\n' "$revision" >"$state/current-revision"
trap - EXIT HUP INT TERM
printf '%s Deployed Mediawan %s; rollback saved at %s\n' "$(date -u +%FT%TZ)" "$revision" "$release"
