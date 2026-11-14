# Mediawan

A self-hosted, Plex-style media server for the films and shows on your own NAS. Point it at
your folders; it scans them, fetches posters and descriptions, remembers where everyone got
to, and streams to browsers and TVs — copying the original video whenever the device can play
it, and re-encoding only when it can't.

Version 3 is a rewrite in Python (FastAPI) with a dependency-free web UI. The Node.js v2 is
kept on the `backup/v2-before-rebuild` branch.

## What it does

- **Folder scanner.** Walks `LIBRARY_ROOTS` at startup, every six hours and on demand. It
  understands movie folders (`Heat (1995)/Heat.1995.1080p.mkv`), seasons
  (`Show/Season 02/Show.S02E03.mkv`, `2x03`), absolute anime numbering
  (`[Group] Show - 05 [1080p].mkv`) and sidecar subtitles (`Movie.en.srt`,
  `Movie.eng.forced.ass`, `Subs/`). Extras, samples and NAS housekeeping folders (`@eaDir`,
  `#recycle`) are skipped. Symlinks are followed only while they stay inside the library.
  Files it cannot place go to **Admin → Needs review**, where you place them by hand; that
  placement survives every later scan. A folder that comes back empty (an unmounted share) is
  never treated as "everything was deleted".
- **Metadata from Cinemeta** (no API key): posters, backdrops, descriptions, genres, ratings,
  IMDb IDs and episode names. Anything an admin edits is locked and never overwritten by a
  refresh. Artwork is cached locally, so TVs never hotlink and offline still shows posters.
  `METADATA_ONLINE=false` turns all network access off.
- **Playback chosen by codec, not file extension**, per device:

  | Mode | When | What happens |
  | --- | --- | --- |
  | Direct play | MP4/WebM with video and audio the device decodes | The file is served as is, with range requests for seeking |
  | Remux | The video codec plays, but the container or audio doesn't (MKV, DTS, TrueHD, a non-default audio track) | Video is **copied** into HLS untouched; audio is converted to AAC only if the device can't play it |
  | Transcode | The video itself can't be decoded (MPEG-4 ASP, 10-bit H.264, HEVC on a browser without HEVC, above the device's resolution) | Re-encoded to H.264 with QuickSync, VA-API or x264 |

  The browser reports what it can decode (HEVC, AV1, AC-3, E-AC-3…) with each play request,
  so a TV that handles HEVC and E-AC-3 gets them copied. If a device fails to play what it
  claimed it could, the player steps up one level (direct → remux → transcode) and resumes
  where it stopped. A failed hardware encode retries in software automatically.
- **Online anime.** Search also asks AniList, and anime it finds plays from MegaPlay (the old
  HiAnime library), subtitled or dubbed, with Skip Intro and resume. MegaPlay's servers only
  answer requests carrying their own Referer, which browsers cannot send, so Mediawan fetches
  the playlists, segments and subtitles and passes them through unchanged (never re-encoded).
  Proxied links are signed, so the server cannot be used to fetch anything else.
- **Online films and series over BitTorrent**, through the VPN. Title pages from search offer
  one Play with the quality beside it (1080p and 4K; 720p or SD instead of 1080p for older
  series that have nothing sound at 1080p), and Usenet as the other source when it is set up.
  Releases come from Torrentio by IMDb id and are checked and ranked (`release_rules.py`):
  untouched service WEB-DLs first, a season kept on one group or pack, re-encodes, dubs,
  other-language releases, upscales, Dolby-Vision-only and sign-language versions last; films
  may also come from Blu-ray, series only when no WEB-DL of that episode exists. A release
  labelled with a year outside the title's own is never offered, and a film file whose real
  length is far from the catalog runtime is rejected for good and the next release played.
  Opening a title page prepares the stream, so play usually starts at once; while it connects
  the player says what is happening (finding sources, connecting to N peers, buffering N%),
  a slow release is raced against the next one, and every failure is a screen with a next
  step. The engine (`torrentd.py`) is a separate service inside the vpn container's network,
  so torrent traffic has no route but the tunnel; it refuses to start torrents when no tunnel
  is up, fetches the pieces the player needs first (a seek moves the window at once), and
  keeps its data in a capped cache that is deleted when a stream stops or idles.
- **Subtitles in your languages, always.** Arabic, Danish and Portuguese (`SUBTITLE_LANGUAGES`)
  are offered on every film, episode and anime. A real track is used when there is one; otherwise
  the best text track (English first) is translated by the LibreTranslate service in the compose
  file, on the NAS, and saved, so each episode is translated once. Playback starts the missing
  ones in the background, so picking one is usually instant; the player shows progress if not.
- **Live sports.** Bring your IPTV provider (an Xtream Codes login or an M3U playlist) and
  *Live sports* shows the day's matches with the channels that show them. Fixtures and live
  scores come from ESPN's public scoreboard; free TV guides (epgshare01: UK, Germany, the
  Netherlands, beIN) say what each channel broadcasts, and are matched to your provider's
  channels by name and country. Channels can also be browsed and searched by language. One
  FFmpeg per channel is shared by everyone watching it, within the number of connections the
  provider allows. H.264 is copied; interlaced broadcasts become smooth 50 fps for browsers
  (TVs de-interlace themselves); audio becomes AAC. Channel addresses and the provider login
  stay on the server, in `live-tv/` beside the database (v2's `catalog.json` there is reused).
- **Subtitles**: embedded text tracks (SRT, ASS, mov_text) and sidecar files are converted to
  WebVTT once and cached. Picture subtitles (PGS, VobSub) are listed but cannot be shown yet.
- **Per person**: resume positions, Continue Watching, Next Up, Recently Added, favorites,
  watchlist, collections, sequential and shuffle queues, and preferences (audio and subtitle
  language, subtitle mode and size, maximum quality, stereo downmix, autoplay).
- **TV remote navigation**: arrow keys move focus spatially between cards, rails and the menu;
  OK selects; Back (Escape, Backspace, Tizen 10009, webOS 461) closes panels, the player, then
  goes back a page and puts focus where you left it. Media keys work in the player. The UI is
  plain ES2017 so Samsung Tizen's Chromium 69 runs it without a build step. TVs are detected
  by user agent, or add `?tv=1`.

## Running on the NAS

```bash
cp .env.example .env    # then edit it
docker compose up -d --build
docker compose --profile tunnel up -d    # optional Cloudflare tunnel
```

Open `http://<nas>:8787`. If `ADMIN_EMAIL`/`ADMIN_PASSWORD` are blank, the first visit asks
you to create the administrator account.

The media folder is mounted **read-only**: Mediawan never changes your files. The image is
Debian trixie with FFmpeg 7.1, the non-free Intel media driver and Intel VPL, which is what the
N100 needs for QuickSync. The compose file passes `/dev/dri` through and adds the container to
the `video` and `render` groups — check the real group IDs on the NAS with
`stat -c '%g %G %n' /dev/dri/*` and set `VIDEO_GID`/`RENDER_GID`. To confirm the GPU is
usable inside the container:

```bash
docker compose exec mediawan vainfo --display drm --device /dev/dri/renderD128
```

Admin → Now playing shows each stream's mode, why it was chosen, and whether it is running on
`qsv` or fell back to software.

## Configuration

All settings are environment variables; see [.env.example](.env.example).

| Variable | Default | Meaning |
| --- | --- | --- |
| `LIBRARY_ROOTS` | *(none)* | Library folders, separated by `:` (`;` on Windows). Names containing Movies/Film or TV/Show/Series/Anime are used as hints |
| `HWACCEL` | `none` | `qsv`, `vaapi` or `none` (software x264). Only used for transcodes |
| `MAX_TRANSCODES` | `2` | Simultaneous re-encodes; stream copies get four times as many slots |
| `SCAN_INTERVAL_SECONDS` | `21600` | Rescan interval; `0` scans only at startup and on demand |
| `METADATA_ONLINE` | `true` | `false` never contacts Cinemeta |
| `SUBTITLE_LANGUAGES` | `ar,da,pt` | Subtitle languages offered on every title; missing ones are machine-translated |
| `TRANSLATE_URL` | *(compose: the libretranslate service)* | LibreTranslate server for those translations; empty turns translation off |
| `ONLINE_ANIME` | `true` | Anime search and streaming from AniList + MegaPlay; `false` turns it off |
| `TORRENT_URL` | *(none)* | The torrent service (`http://vpn:8792` in the compose file); empty turns torrent streaming off |
| `TORRENT_KEY` | *(none)* | Shared by Mediawan and the torrent service; required by the service |
| `TORRENTIO_URL` | `https://torrentio.strem.fun` | Where releases are listed |
| `TORRENT_FALLBACK_SECONDS` | `6` | Wait for a release's file list before racing the next one (2–60) |
| `TORRENT_CACHE_GB`, `TORRENT_MIN_FREE_GB` | `60`, `10` | Torrent service: cache cap, and free space it always leaves |
| `TORRENT_UPLOAD_KBPS` | `1024` | Torrent service: upload limit (0 = none) |
| `TORRENT_REQUIRE_VPN` | `true` | Torrent service: refuse to start torrents unless a tunnel interface (`tun*`, `wg*`…) is up. `false` only for development |
| `TORRENT_INTERFACE`, `TORRENT_BIND_TUNNEL` | *(any tunnel)*, `true` | Torrent service: which tunnel to require, and whether libtorrent binds its sockets to it |
| `LIVE_TV` | `true` | Live sports and channels from your IPTV provider; `false` turns it off |
| `LIVE_TV_DIR` | `live-tv/` beside the database | Channel list (with the provider login) and TV guide cache |
| `LIVE_GUIDES` | epgshare01 UK1, DE1, NL1, BEIN1 | XMLTV guides, comma-separated (gzip is fine). The provider's own guide is added when it has one |
| `LIVE_FIXTURES` | `true` | Match fixtures and scores from ESPN; `false` lists guide programmes only |
| `CINEMETA_BASE` | `https://v3-cinemeta.strem.io` | Metadata source |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | | First administrator, created once on an empty database |
| `MEDIAWAN_DB` | `data/mediawan.sqlite` | Database (artwork is cached next to it in `art/`) |
| `TRANSCODE_DIR` | `.runtime` | Temporary HLS segments and converted subtitles |
| `COOKIE_SECURE` | `false` | Mark the sign-in cookie HTTPS-only |
| `FORWARDED_ALLOW_IPS` | `127.0.0.1` | Proxies trusted to set `X-Forwarded-For` |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` | Tool locations |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | Where the server listens |

## Development

Needs Python 3.12+, [uv](https://docs.astral.sh/uv/) and FFmpeg on `PATH`.

```bash
uv sync
uv run python -m mediawan.samples media/demo   # a small generated demo library
LIBRARY_ROOTS="media/demo/Movies:media/demo/TV" uv run mediawan
uv run pytest
uv run ruff check mediawan tests
```

`mediawan.samples` builds real clips that cover every playback path: H.264/AAC MP4 (direct),
H.264/AC-3 5.1 MKV with subtitles (remux), MPEG-4 ASP AVI and 10-bit H.264 MKV (transcode),
plus season and anime layouts and one file that lands in the review list.

The tests use real FFmpeg: they check that remuxed video is bit-for-bit the source stream
(same packets, same encoder profile), that transcodes produce 8-bit H.264, that a broken
hardware encoder falls back to software, and that subtitles convert with the right
characters. A test skips itself when FFmpeg is missing.

### Layout

| File | Role |
| --- | --- |
| `mediawan/config.py` | Settings from environment variables |
| `mediawan/db.py` | SQLite with numbered migrations |
| `mediawan/auth.py` | Accounts, scrypt hashes, session cookies, login rate limit |
| `mediawan/parse.py` | File and folder name parser, sidecar subtitle detection |
| `mediawan/scanner.py` | Library walk, missing files, review list, admin placements |
| `mediawan/metadata.py` | Cinemeta matching, locked admin edits, artwork cache |
| `mediawan/media.py` | ffprobe, playback decisions, HLS sessions, hardware encoding, subtitles |
| `mediawan/torrent.py` | Torrent releases (Torrentio), streams with fallback, wrong-film rejection, season locks |
| `mediawan/release_rules.py` | Which release to stream: the hard rules and the ranking (pure functions) |
| `mediawan/torrentd.py` | The torrent engine service: libtorrent, piece priorities, HTTP with ranges, tunnel check |
| `mediawan/live.py` | IPTV channel import (Xtream, M3U), name matching, shared live streams |
| `mediawan/sports.py` | TV guides, ESPN fixtures, and the merged sports schedule |
| `mediawan/live_api.py` | Live sports routes and the Admin → Live TV page |
| `mediawan/library.py` | History, rails, tags, collections, queues, preferences |
| `mediawan/app.py` | FastAPI routes and background jobs |
| `mediawan/static/` | Web UI: `app.js` (router, D-pad navigation, player), `styles.css`, hls.js |

API docs are served at `/api/docs`.
