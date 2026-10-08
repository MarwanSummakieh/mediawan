# Mediawan 2 acceptance record

The replacement is a fresh Express/SQLite application with modular browser code. The source snapshot is in `.recovery/before-v2`. The current personal database, environment files and media have not been changed. This record describes local fixture validation, not a NAS deployment.

## Automated checks

The test suite covers user/session isolation, authentication and same-origin writes; per-item progress and final completion; late-event rejection and deliberate backward seeks; dismissal and replay; unknown duration; missing episode gaps; stable shuffle and queue revision checks; private asset access; bulk watched actions; exact release file selection; read-only/idempotent legacy migration; a mocked Real-Debrid transfer through verified local publication; and actual FFmpeg fixture conversion to HLS.

Latest run: **31 tests passed, zero failures**. Independent queue copies and undo protection against subsequent playback have dedicated regression coverage. Torrent coverage includes reported quality/size/seeder filtering, durable rule validation, server-side revalidation against forged browser claims, permission enforcement, exact-file selection, pause/resume, stall and metadata timeouts, actual-size rejection, ownership isolation and qBittorrent session renewal.

Direct torrents were also tested against local qBittorrent **5.2.4** using a generated five-second, 4,022,085-byte video and a local HTTP web seed. The real transfer completed, its SHA-256 matched the source, FFmpeg probed it, and the worker published it as a library asset in an isolated test store. This validates the transfer/import integration; public-swarm availability and reported seed counts remain dependent on the selected release. No external movie was downloaded during verification.

`npm run build` bundles the browser source for Chromium 69. Runtime browser/device API compatibility still needs a physical device check. Dependency audit was run and compatible fixes applied.

Docker Compose configuration validated and the final image built successfully. The image passed a startup smoke check in an ephemeral container with no external network, published ports or user-data mounts: health, HTML/bundle delivery, anonymous API denial, administrator login and authenticated library access. The smoke script is `scripts/smoke-container.mjs` and is intended to be piped into Node inside the built container. Dependency audit reported zero vulnerabilities after compatible updates.

## Browser checks

An isolated loopback preview on port 8799 uses synthetic metadata and a generated two-minute clip. Verified sign-in, Home shelves, direct local playback, replay, final-position updates after returning to the library, season navigation, show shuffle, advancing through shuffled order, queue display, and bulk watched/undo. Server restart retains its fixture database and queues. A 390-pixel mobile viewport was inspected for layout and navigation overflow.

Live Cinemeta discovery and an explicit movie search returned results in the browser. No live provider transfer was requested. The final Home screenshot is saved locally in `.runtime/preview/home.jpg`; its library titles and video are synthetic fixtures.

## Remaining deployment checks

- Real Real-Debrid account, provider download hosts, transfer availability, and selected-file identity on the user's releases. Provider integration tests use a mock and do not spend or mutate the account.
- NAS filesystem ownership, consistent media mount paths, free-space reserve, actual codec/subtitle combinations and software conversion capacity.
- Physical Samsung/Tizen remote and embedded video behavior. The old pairing/native package workflow is not part of this runtime.
- Review migration counts and restricted-member access against a consistent backup before switching the old installation.

## Explicit scope changes from the original incremental plan

The user subsequently requested a complete restart. This implementation replaces the old runtime and renders a new interface. Playback operates on completed local files; the previous on-demand stream/cache path is archived. Live TV/sports, watch-together, casting, Premiumize, hardware acceleration and native pairing are not wired into v2. Follow-series automation, ordered playlists, intro/credits detection and customizable home shelves remain later work. These are not claimed as completed features.

## Metadata update

Title and episode metadata enrichment, runtime provenance and offline refresh preservation are covered in [metadata.md](metadata.md). The four additional tests cover runtime units, stable item/history identities, offline backoff and accessible local-file duration.

## Full-duration playback timeline

The player uses the probed full-file duration, independently of the growing compatibility HLS playlist. Absolute seeks outside the current converted window restart conversion at the requested time and preserve paused playback. Premature stream endings do not send a completed event or advance the queue. Three regression tests cover time/offset mapping, seek decisions and early-end handling. Live browser verification showed 2:25:00 throughout playback and a paused seek beyond the converted window, followed by a return to the prior position.
