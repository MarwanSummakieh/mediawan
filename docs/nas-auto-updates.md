# NAS automatic updates

The NAS checks the published Mediawan `latest` image every five minutes using
`scripts/nas-auto-update.sh`. GitHub Actions tests and smoke-tests an image before
publishing it. The updater compares image IDs, pins the new digest in the active
Compose file, and recreates only `web`. Existing settings, mounts and other
services are retained. Watchtower stays disabled for `web` to avoid competing
updates.

The installed script is `/volume1/docker/mediawan/auto-update/update.sh`. The NAS
user's crontab runs it every five minutes. Logs and the last deployed revision
are in `/volume1/docker/mediawan/auto-update/`.

An update must answer `/healthz` with its expected Git revision. If it fails, the
previous Compose file and web image are restored. A rejected image is skipped
until a different image is published. Each attempted update retains its previous
configuration under `/volume1/docker/mediawan/releases/auto-*`.

To check or run the updater manually:

```sh
crontab -l
sh /volume1/docker/mediawan/auto-update/update.sh
cat /volume1/docker/mediawan/auto-update/current-revision
tail /volume1/docker/mediawan/auto-update/updates.log
```

To pause updates, remove the crontab line marked `mediawan-auto-update`. For a
manual rollback, restore the desired `docker-compose.before.yaml` from its
release folder and recreate only `web`; pause automatic updates first to keep
that version in place.
