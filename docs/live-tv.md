# Live TV

Sports lives at `/sports`. It provides competition shelves, football/NFL/NHL destinations, saved channels, language filtering, and a local-time programme guide. Movies, TV shows and Anime have separate shelf-based libraries at `/library/:kind`; Browse retains the full filters.

An administrator can import an extended M3U through **Sports → Manage live TV**. Playlist URLs and credentials stay in the server's private storage. The browser receives opaque channel IDs, proxied logos, and short-lived playback grants. Do not commit playlists or copy private data into an image.

Storage defaults to `live-tv/` beside `DB_PATH`. With the Docker configuration (`DB_PATH=/data/data.sqlite`), this is `/data/live-tv` on the existing persistent volume. `LIVE_TV_DIR` can override it. Back up this directory securely with the database. The rolling playback buffer is disposable.

For a server-side import, run in the container's normal environment:

```sh
node scripts/import-live.mjs /private/channels.m3u
```

For a single Xtream account, Mediawan checks supported output formats and the concurrent connection limit, and discovers its XMLTV endpoint. Otherwise it uses the playlist's `url-tvg` / `x-tvg-url`, or an administrator-supplied guide URL. Guides refresh every four hours; gzip XMLTV is supported. Failed refreshes retain the last saved guide.

Guide matching uses explicit IDs, provider stream IDs, then unique normalized names. Channel details allow manual guide-ID, language, and competition corrections. Region-derived language is an estimate, shown in channel details. Dedicated channel names and explicit competition groups establish membership; general sports channels are linked by programme listings. Broadcaster rights and fixtures are never invented. Repeated channel-name placeholders do not appear as live programmes.

The supplied playlist's provider currently has one simultaneous upstream channel and no detailed programme listings for the principal sports channels. A richer XMLTV source is needed for a useful fixture guide. Importing a playlist does not guarantee that every provider stream will remain online.

Viewers of the same channel share one FFmpeg session. Another channel is refused when the account limit is reached. Live and on-demand sessions share the NAS encoder budget. Compatible 8-bit H264 video up to 1080p is passed through at its source bitrate, with audio converted to AAC. Other inputs use the selected hardware encoder or software fallback. HLS keeps eight segments plus a small deletion margin rather than an unbounded live recording; passthrough segment duration follows source keyframes. Sessions end when their last viewer leaves, leases expire, or output stalls. The existing VAAPI/QSV probe selects hardware encoding; software encoding is available when hardware is unavailable.

Validation: `npm test` and `npm run build:tv`. Live provider verification must be sequential and respect the account connection limit. Private playlist data is intentionally absent from automated tests.
