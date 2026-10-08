# Mediawan 2

A fresh, local-first media application. Find a title, choose a release, download its original file through qBittorrent or Real-Debrid, and watch it from your own storage.

## Run

Requires Node.js 22.5+ and FFmpeg/FFprobe on PATH.

```sh
npm ci
npm run build
# Copy .env.example to .env and set ADMIN_EMAIL / ADMIN_PASSWORD.
npm start
```

Open http://localhost:8787. The initial password must contain at least ten characters. There is no default account. Configuration remains server-side. The default v2 database is `data/mediawan-v2.sqlite`; v1's `DB_PATH` is deliberately ignored.

```sh
docker compose up --build -d web
```

Ensure the configured PUID/PGID owns the data, media and runtime bind folders. Optional Cloudflare Tunnel: set TUNNEL_TOKEN, COOKIE_SECURE=true, TRUST_PROXY=1 and run `docker compose --profile tunnel up --build -d`. Both listening ports serve the same app; v2 does not infer quality from the port. Compatibility conversion currently uses bounded software H.264/AAC sessions.

## Included

- Movies and series through Cinemeta; anime through AniList with Kitsu release mapping.
- Release discovery, Real-Debrid cloud transfer, verified local download, retry/cancel and free-space checks.
- Automatic space reclamation across both download engines, ranked by the latest watch across all users.
- Home with Continue Watching, Next Up, Recently Added and My List.
- Per-user episode history, replay, dismissal, final-position reporting and stale-session protection.
- Show/season shuffle without replacement, sequential queues, saved queue order and explicit queue resumption.
- Episode/season views, watched actions with undo, library filters, sort and pagination.
- Favorites, watchlist, collections, account playback preferences and administrator-managed accounts.
- Local file import from administrator-approved roots. Files remain in place.
- Direct local playback, compatibility HLS conversion, audio/text-subtitle selection and chapter navigation.
- Responsive layout, keyboard/remote directional navigation and a Chromium-69 JavaScript bundle.

Only completed local media is offered for playback. Playback never silently acquires media or streams it from a provider. Download completion preserves the original file and tracks. Missing sequential episodes stop automatic advancement; shuffle only includes available files. Provider polling continues after restart; interrupted local downloads restart from byte zero with a fresh URL.

## Architecture

### Direct torrents

On the local Windows/Docker setup, run `npm run setup:torrents`, then restart `npm run local`. The setup creates a dedicated qBittorrent 5.2.4 container with its control port bound to `127.0.0.1:8801`. Generated control credentials stay in the ignored `.runtime/local/qbittorrent.json`. Docker must be running. Downloaded files stay in `media/local-test/torrents`. The engine automatically starts with Docker; the Mediawan app still needs `npm run local` to monitor jobs and import completed files.

Open **Settings → Torrent rules** to configure seed count, resolutions, per-file size, timeouts, concurrent downloads and upload/seeding limits. Defaults accept 720p/1080p/4K, at least five reported seeders, movies up to 100 GiB and episodes up to 15 GiB. Unknown seed count, size or resolution and CAM/TS/screener labels are rejected by default. These are source-reported values, not verified peer availability or codec quality. Seeders are complete copies; other peers may only have part of the torrent.

Choose **Direct torrent · qBittorrent** in the release picker. Filtered entries can be shown with their exclusion reasons. Selection is revalidated on the server. The engine retrieves metadata, stops to select only the requested video, checks its actual filename/size and storage headroom, then downloads it. Defaults stop metadata retrieval after three minutes and downloads after ten minutes without progress. Partial data is retained for explicit retry. Pause/resume/cancel act only on Mediawan-owned torrents. Releases are never changed automatically. A single torrent hash is currently managed by one job; for a pack already managed in qBittorrent, use that job or a separate release.

Default upload cap is 1 MiB/s per torrent. Seeding stops at ratio 1 or after 60 minutes, whichever is first; qBittorrent retains the files. Rules changed in Settings apply to new jobs and explicit retries, not already-running jobs. Direct torrenting connects this machine to peers. The local setup uses outgoing connections without opening an incoming peer port.

For a separately installed engine, configure `QBIT_URL`, `QBIT_USERNAME`, `QBIT_PASSWORD`, `QBIT_SAVE_PATH` and `TORRENT_DIR`. Both paths must refer to the same shared storage in each process/container. The main Compose file connects to an existing engine; it does not create one. Keep the authenticated control API private.

`npm run test:torrents:live` verifies a real qBittorrent transfer using a generated video and a temporary local HTTP web seed. It compares the downloaded bytes and verifies FFmpeg probing and library publication without fetching external media.

`server.mjs` is only the process entry point. `src/app.mjs` wires authenticated routes; separate modules own catalog discovery, SQLite storage, history, navigation, queues, downloads and media delivery. The frontend is split into shell/navigation, shared presentation and player modules and bundled with esbuild.

The old application source, including pre-existing uncommitted changes, is preserved locally under `.recovery/before-v2`. It is excluded from Git and Docker. Personal credentials, original databases and media were not removed or migrated by the rewrite.

## Automatic storage cleanup

When a verified release needs more room, both Real-Debrid and direct-torrent downloads automatically reclaim app-managed local files on the download's filesystem. Titles never played are removed first, oldest addition first; other titles are ordered by their most recent playback across every user and episode. Watching any episode protects the series' recency. Cleanup removes the eligible managed files for one title at a time and stops once the new file, other active downloads, and `CACHE_RESERVE_BYTES` fit. The default reserve is 20 GiB.

Any user's favorite protects the title. Active playback, open media requests, conversion sessions, pending or paused downloads, and the title being requested are protected too. Abandoned playback sessions expire after two minutes without a heartbeat. Imported files and files outside the configured managed download folders are never deleted. Metadata, lists, and watch history remain, so a removed title can be downloaded again. Downloads show **Removed to free storage** after cleanup.

Completed Mediawan torrents are removed from qBittorrent without deleting their folders; the app then deletes only the verified local library files. Torrent ownership is checked before removal. Cleanup rechecks actual disk space after each title and shares reservations between both download engines. If the eligible files cannot provide enough room, the request fails without starting cleanup; file locks or changing protection can still prevent completion after cleanup begins.

## Migrate an existing library

Read [V2 migration and recovery](docs/v2-migration.md) before switching a NAS deployment.

```sh
npm run migrate -- /path/to/old.sqlite /path/to/mediawan-v2.sqlite
```

The importer opens the source read-only and requires an empty destination. Run it before the first v2 boot creates an administrator. It preserves existing users/password hashes, per-item history, ready assets, access restrictions and lists. Source media paths must still resolve on the new host/container. Download permissions are reset to administrator approval. Active legacy downloads are not resumed by v2.

## Verification

```sh
npm test
npm run build:tv
node scripts/preview.mjs
```

The preview is an isolated synthetic library on http://127.0.0.1:8799, using generated media and its own database. Its fixture account is `preview@mediawan.test` / `mediawan-preview-only`. It never reads `.env` and should stay bound to loopback. Tests include migration, permissions, progress, queues, a mocked Real-Debrid pipeline and real FFmpeg HLS generation. FFmpeg is required for the media test.

For real downloads on this PC, run `npm run local` and open http://127.0.0.1:8800. This uses the administrator credentials and Real-Debrid token from `.env`, a separate `.runtime/local/mediawan.sqlite` database and the `media/local-test` download folder. It binds only to loopback and preserves the default 20 GiB free-space reserve. Sign in, use Discover to choose a title and release, wait for Downloads to show Ready, then play it. Playback during download is not supported. The synthetic preview credentials do not apply to this instance.

## Rewrite boundaries

The v1 live-TV/sports subsystem, watch-together rooms, casting adapters, scraping fallbacks, Premiumize integration, hardware-specific transcoding and native TV pairing are archived with the old source and are not connected to this replacement. The new app's focus is the local library/navigation/download plan. A JavaScript compatibility build does not certify physical Tizen behavior. Live Real-Debrid acquisition, NAS filesystem permissions, GPU behavior and physical TV operation still need deployment acceptance checks. Follow-series automation remains a future addition.

Use sources and media you are entitled to access. No credentials or media ship with this repository.
