# Mediawan

A self-hosted, invite-only, Netflix-style streaming front-end for anime, films and
TV. One Node process serves the SPA, authentication, an admin panel, cached
[AniList](https://anilist.co) metadata, stream resolution, local transcoding and a
thin media proxy. There is a companion Samsung Tizen TV app.

---

## ⚠️ Disclaimer — for educational purposes only

**This project is published for educational and research purposes only.**

It is a personal study of media-server architecture: content-metadata modelling,
session-based auth, cache design, adaptive delivery and transcoding pipelines,
and packaging a web app for a TV platform.

- **No content is hosted, bundled, or distributed by this repository.** The code
  ships no media, no indexes, no credentials, and no accounts.
- It resolves playback through **third-party services that you supply your own
  credentials for**. Nothing works out of the box; every source is opt-in and
  disabled until you configure it.
- You are solely responsible for how you use this software and for complying
  with the laws of your jurisdiction and the terms of service of any provider
  you connect it to. Only use it with content you are legally entitled to access.
- Provided **as is, without warranty of any kind**. The author accepts no
  liability for any use or misuse of this code.

If you are the rights-holder of anything referenced here and have a concern,
please open an issue.

---

## Architecture

```
server.mjs           HTTP entry point — SPA, auth, admin, API, media proxy
lib/
  anilist.mjs        cached AniList metadata (titles, seasons, episodes, art)
  movies.mjs tv.mjs  the film and series verticals
  providers/         source resolution, tried in priority order
  debrid/            cached-release backends
  stremio/addons.mjs optional external catalogue add-ons
  transcode/         on-demand remux/transcode sessions + capability probing
  delivery.mjs       picks direct play vs. remux vs. transcode per client
  playable.mjs       what the requesting device can actually decode
  quality.mjs        release ranking
  security.mjs       headers, rate limiting, SSRF guards, signed media tokens
  db.mjs             SQLite (node:sqlite)
public/              the SPA — browser UI and the TV-optimised UI
tizen/               Samsung Tizen wrapper app
scripts/             build, install and diagnostic tooling
test/                node:test suites
```

### Design notes

- **Quality first, with a floor.** Sources are tiered. The app prefers a real
  release file and only falls back to a lower tier when nothing better is
  available; a floor source never outranks a real release.
- **Minimal transcoding.** Streams are copied whenever the target device can
  decode them. Transcoding is a last resort, per-track, not a default — an
  unnecessary lossy generation is treated as a regression.
- **Independent backends.** Any provider being down, rate-limited, or simply not
  holding a title moves on to the next rather than failing the request.

## Requirements

- Node.js **≥ 22.5** (uses the built-in `node:sqlite`)
- `ffmpeg` / `ffprobe` on `PATH` for transcoding
- Docker + Docker Compose for the deployment path

## Running it

```bash
npm install
cp .env.example .env   # then fill it in — see the comments in that file
npm run dev
```

The app listens on `http://localhost:8787`. On first run against an empty
database it seeds a single admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD`; every
other account is created by invite.

`.env.example` is the real documentation for configuration — each variable is
commented with what it does, what it costs you, and what breaks without it.

### Deployment

```bash
docker compose up -d
```

Compose runs the app plus a Cloudflare Tunnel connector, so nothing needs to be
port-forwarded. Point your tunnel's public hostname at `http://web:8787`.

### Downloader and encoder on the NAS

The downloader and encoder run inside `web`. Playback starts from the source
while the downloader saves a reusable copy to the NAS. Two downloads run at a
time by default; further plays still stream, and can start caching on a later
play. Downloads resume from a partial file when that release is requested again.
Completed files use a 2 TiB LRU cache. A 20 GiB free-space reserve also protects
the volume. Encoding adapts playback on demand; it does not replace the original
download with a lower-quality file.

1. In the NAS `.env`, configure `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and at least one
   of `REAL_DEBRID_TOKEN` or `PREMIUMIZE_API_KEY`. The companion Seanime service
   also requires `SEANIME_PASSWORD`; Cloudflare requires `TUNNEL_TOKEN`.
2. Set `DATA_DIR` to persistent app storage and `MEDIA_DIR` to a directory on
   the media array. Set `PUID` / `PGID` to its owner. The container writes cache
   files under `/media/cache` and temporary HLS segments under `/media/transcode`.
3. On an Intel NAS, verify `/dev/dri/renderD128` exists. Set `VIDEO_GID` and
   `RENDER_GID` from the actual device group IDs (`stat -c '%g'`), then retain
   `TRANSCODE_HWACCEL=qsv`. The app tests Quick Sync, then VAAPI on the same GPU
   when Quick Sync is unavailable. Set `TRANSCODE_HWACCEL=vaapi` to select VAAPI
   directly and `TRANSCODE_DEVICE` if the render device is not
   `/dev/dri/renderD128`. Docker must be able to pass `/dev/dri` through.
4. Start or recreate the container with `docker compose up -d`. Open **Admin**
   for cache usage, downloads, encoder sessions and setup checks. Run the same
   checks from the NAS shell with:

   ```bash
   docker compose exec web node scripts/check-pipeline.mjs
   ```

The checks test a real GPU encode, the availability of `ffprobe`, and a cache
write. Provider checks here confirm credentials are configured; use **Check
sources** to test the account and playback sources. The diagnostic exits with
status 1 when setup needs attention and never prints credentials or media URLs.

`CACHE_DOWNLOADS=false` disables background saving. `CACHE_MAX_DOWNLOADS`,
`CACHE_BUDGET_BYTES`, and `CACHE_RESERVE_BYTES` control storage. Encoding uses
`TRANSCODE`, `TRANSCODE_HWACCEL` (`qsv`, `vaapi`, or `none`), `TRANSCODE_REMOTE_MBPS`, and
`TRANSCODE_MAX_SESSIONS`. Recreate the web container after changing `.env`.
Software mode also requires removing the `/dev/dri` device and GPU group entries
from Compose on hosts without that device.

Compose uses the published image. Source edits take effect only after building
and deploying an updated image; pulling `latest` alone does not build this checkout.
The separate Jellyfin/qBittorrent proposal in `docs/phase-0.md` is not required
for this built-in pipeline.

### TV app

```bash
npm run tv-build     # build the Tizen .wgt
npm run tv-install   # sideload onto a TV on your LAN
```

See [`tizen/README.md`](tizen/README.md). The TV UI is a separate build — rebuild
it after changing anything in `public/`.

## Tests

```bash
npm test
```

## Security

Sessions are cookie-based with configurable expiry, passwords are hashed, media
URLs are signed with short-lived tokens, the proxy validates outbound targets
against SSRF, and the app refuses to start in production with a weak or default
admin password. It is still intended for a closed group behind a tunnel — not as
a public service.

## License

No license is granted. All rights reserved. This code is published for reading
and study; see the disclaimer above.
