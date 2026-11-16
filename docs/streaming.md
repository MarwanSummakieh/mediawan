# Stream now

Press play on an episode or movie and watch it while it downloads, at 1080p or 2160p.
This document is the contract between the server (`src/streaming.mjs`, routes in
`src/app.mjs`) and the front end. Every route needs the login cookie unless noted.

## How it works

1. **Release choice.** For each resolution the server ranks the releases from the
   catalog that pass every download rule (seeders, size, CAM/screener, WEB-DL only,
   and the actual file name must not reveal a BluRay/BDMux/WEBRip/Remux source). Unlike
   downloads, both 1080p and 2160p are allowed for movies and series alike. Ranking
   (`src/release-score.mjs`) prefers untouched WEB-DLs from a known service, penalises
   re-encodes, dubs, upscales, Dolby-Vision-only and sign-language versions, and for
   streaming weighs swarm health more. The first stream of a season sets a **season
   lock** per title, season and resolution; later episodes prefer the same season pack
   or the same group and service.
2. **Peers.** One in-process WebTorrent client joins the swarm of the top release. It
   announces to the listing's trackers plus a list of open trackers (trackerless DHT
   alone is unreliable). If no metadata arrives within `STREAM_FALLBACK_SECONDS`
   (default 6 s), the next-ranked release is **raced** against it; the first to answer
   wins and the other is dropped. After another wait the slowest is replaced by the next
   candidate (up to four candidates, 45 s in total). A fallback is reported in `fallback`.
3. **Pieces.** The head (first 8 MiB) and the tail (last 2 MiB, where MKV keeps its
   index) of the file are fetched first. Prepared sessions fetch only those. A playing
   session also downloads the whole file in order. A seek, a resume or an audio switch
   immediately moves a high-priority window to the new position.
4. **Probe.** FFprobe reads the file through a loopback-only HTTP server (never exposed)
   as soon as the head and tail arrive. Duration, audio, subtitles and chapters are then
   available, exactly like a local file.
5. **Playback.** FFmpeg converts to HLS in the same session store as local playback, so
   playlists and segments are served by the existing `/api/media/sessions/:id/:file`
   route and released by `DELETE /api/media/sessions/:id`. **The video is copied** when
   the client can decode it (H.264 8-bit; HEVC when declared), which starts in about
   0.2 s on downloaded data; only the audio is converted to AAC. Otherwise the video is
   transcoded to H.264 at most 1080p (HDR is tone-mapped to SDR). The first segment is
   short (about 1 s, cut at the first keyframe) and the playlist URL is published as soon
   as it exists. Text subtitles are written as WebVTT by the same FFmpeg process.

Snappiness rules the design: the release listing is cached per item (fresh 5 minutes,
answered from memory and refreshed in the background for up to an hour), rankings are
memoised, the next episode's listing is fetched in the background when an episode's
options are requested, and no status request touches the network or the disk.

## Requirements and settings

- FFmpeg/FFprobe (as for local playback).
- A VPN. By default no torrent traffic starts unless a VPN network interface is up.
  While any torrent runs, the interface is re-checked every 0.5 s on its own timer, and
  every check made for a request (options, prepare, start, guard) acts on a failure too:
  the first check that sees the VPN gone destroys every torrent at once, closes the
  client's ports, and fails the sessions with `reason: "vpn"`. Read the guard's limits
  below before relying on it.
- The user must be an administrator or have **can download** (same as downloads).

### What the VPN guard does and does not do

The guard checks that an interface whose **name** matches `STREAM_VPN_INTERFACES` is up
with an address. It does not bind torrent traffic to that interface and does not check
the routing table. So:

- **An unrelated interface with a matching name passes.** A home remote-access
  WireGuard tunnel called `wg0`, or any `tun*`/`tap*` adapter, satisfies the default
  list while torrent traffic leaves by the normal route. If you have such an interface,
  set `STREAM_VPN_INTERFACES` to exactly your VPN's adapter (for example `nordlynx`).
- **A drop is noticed within about half a second**, plus the time to tear down the
  sockets. Traffic already in flight in that window leaves by whatever route the system
  uses once the VPN is gone.
- **Use the VPN's kill switch on Windows** (NordVPN: Kill Switch) for a hard guarantee.
  **On the NAS, run Mediawan inside the VPN container's network namespace** (for example
  Docker `network_mode: "service:gluetun"`), where no route other than the tunnel exists;
  the guard is then a second line of defence.

Binding WebTorrent's sockets to the VPN address was considered and not done: it needs
patches to five dependencies (WebTorrent's peer connections, `bittorrent-tracker`'s UDP,
HTTP and WebSocket clients, `bittorrent-dht` and the uTP module) because none exposes a
local-address option for every socket. On Windows, binding the source address would then
select the VPN interface (strong host model). On Linux it would not without policy routing
or `SO_BINDTODEVICE`, which Node does not expose. Estimate: one to two days plus ongoing
upkeep of the patches, for a guarantee that is only reliable on Windows.

| Variable | Default | Meaning |
| --- | --- | --- |
| `STREAM_VPN` | `required` | `off` disables the VPN guard (peers then see the server's address). |
| `STREAM_VPN_INTERFACES` | `nordlynx,nordvpn*,wireguard*,openvpn*,proton*,mullvad*,wg*,tun*,tap*` | Interface names that count as a VPN; `*` is a wildcard, case-insensitive. An interface counts only while it has a non-loopback address. Behind a Gluetun-style VPN container the app sees `tun0` or `wg0`. |
| `STREAM_MAX_SESSIONS` | `6` | Stream sessions on the server: one per device/player, prepared ones included (each user: at most 4). Idle prepared sessions are evicted first; failed sessions do not count. |
| `STREAM_CACHE_BYTES` | `107374182400` (100 GiB) | Total disk the stream cache may commit. |
| `CACHE_RESERVE_BYTES` | `21474836480` (20 GiB) | Shared with downloads: a stream starts only if its file still leaves this much free. |
| `STREAM_UPLOAD_KBPS` | `1024` | Upload cap for streams (0 = unlimited). |
| `STREAM_FALLBACK_SECONDS` | `6` | Wait for metadata before racing the next release (2–60). |
| `STREAM_DHT` | `true` | `false` disables trackerless discovery. |
| `STREAM_TRACKERS` | — | Extra comma-separated tracker URLs. |

Disk: a stream reserves twice the file size (torrent data plus the HLS copy); several
sessions on the same file (two devices, or two resolution labels of one torrent) reserve
it once. The check and the reservation happen atomically, so concurrent starts cannot
together exceed the limits. Streams never delete library files to make room. Cached data lives under
`<TRANSCODE_DIR>/streams`, is deleted when a session closes, and the whole folder is
deleted when the server starts. If free space falls below half the reserve while
streaming, streams stop with `reason: "disk"`. Local discovery (LSD) and UPnP/NAT-PMP
port mapping are disabled because they would bypass the VPN.

## State machine

```
            prepare / play
                 │
        ┌──── finding-peers ────┐   (no peer connected yet)
        │        │              │
        │  fetching-metadata    │   (peers connected, waiting for the file list)
        │        │              │   fallback: next release raced after 6 s
        │     probing           │   (head+tail downloading, FFprobe reading)
        │        │              │
        │      ready ◄──────────┼── prepared sessions stop here ("warm")
        │        │ play         │
        │    starting           │   (FFmpeg producing the first segment)
        │        │              │
        │      ready ⇄ buffering    (FFmpeg is waiting for pieces and less than
        │        │                   6 s is converted ahead of the playhead)
        └──► failed            stopped (closed by stop/expiry; routes then return 404)
```

`state` is one of `finding-peers`, `fetching-metadata`, `probing`, `ready`, `starting`,
`buffering`, `failed`, `stopped`. `intent` is `prepare` or `play`. A failed session keeps
reporting for 30 s, then closes. `message` is a short sentence for the UI;
`error.reason` is machine-readable (see Errors).

Conversion has its own `conversion.state`: `starting`, `ready` (has `url`), `failed`
(has `error`), or `stopped` (nobody fetched segments for two minutes; call
`/convert` again with the current position).

Lifetimes: a prepared session expires 60 s after it was last touched; a playing session
120 s. Touching = any status/heartbeat request, an open event stream, segment requests
and `/api/playback/:id/events` progress reports. A session prepared with `after` lives
as long as that session. A failed session holds no torrent, disk reservation or slot;
it only keeps reporting its error.

## Devices and players

A session belongs to one **player instance**: one browser tab's player, the TV app, a
cast sender. The client identifies it with `player`, an id it generates itself
(1–64 characters from `A–Z a–z 0–9 _ -`; for example a random id created once per page
load, or once per app launch on the TV) and sends with prepare and start.

- `POST /api/items/:id/stream` with a `player` reuses that player's session for the same
  item and resolution, or claims a prepared one, and **always starts a new conversion**:
  at `position`, or at the saved resume point when no position is sent, with the
  capabilities in that request. This is also how "Try again" recovers after a failed
  conversion.
- A start from another player, or one with no `player`, never takes over a session that
  is playing elsewhere: it gets its own session. Torrents are shared between sessions, so
  the second device starts from a warm swarm and an already-downloaded file.
- A prepared session is not playing anywhere, so any player may claim it.
- `DELETE /api/streams/:sid` stops only that session. The torrent stays while another
  session uses it.
- `status.player` echoes the id. Use it to tell this player's sessions from the user's
  other devices in `GET /api/streams`, and never stop sessions that belong to another
  player.
- `POST /api/playback/:id/events` cannot tell devices apart. It keeps all the user's
  sessions of that item alive, but moves the playhead only when a single device plays
  the item. Send heartbeats for accurate buffer figures.

## Fastest start: recommended sequence

1. **Sheet opens** (episode stream sheet, or focus/hover on the play button):
   `GET /api/items/:id/stream-options` (≈140 ms cold, 2 ms warm) and, if
   `canStream && guard.ok`, immediately `POST /api/items/:id/stream/prepare` with the
   default resolution and this player's `player` id. Open
   `GET /api/streams/:sid/events` to show progress.
2. **Play pressed:** `POST /api/items/:id/stream` with the same resolution, the
   device's `capabilities` and `player`. The prepared session is claimed. Send
   `position` when the player knows it (a restart mid-playback); for Resume it may be
   omitted and the server uses the saved resume point. Then `POST /api/playback`
   `{ itemId }` exactly as for a local file (history and resume).
3. When an event has `conversion.state === "ready"`, load `conversion.url` with hls.js
   (or natively), treat `conversion.offset` as the time of playlist position 0 (same
   meaning as `offset` from `/api/items/:id/convert`), and seek the video to
   `resumePosition - offset` if positive.
4. While playing, send the playhead with `POST /api/streams/:sid/heartbeat` every
   1–5 s (or rely on the existing 10 s playback events) so buffer figures are accurate.
5. At about 80 % of an episode: `POST /api/streams/:sid/prepare-next`. Next Up then
   starts from a warm session (≈0.3 s to playlist when it is already downloaded or
   in the same season pack).
6. Close: `DELETE /api/streams/:sid` (returns at once; cleanup continues in the
   background) and the usual `DELETE /api/media/sessions/:conversionId`.

Seeking outside the converted range (the existing `seekPlan` logic), changing the audio
track, or switching to a device with other capabilities: `POST /api/streams/:sid/convert`.
Changing resolution: `POST /api/streams/:sid/resolution` and keep playing the old
playlist until the new session's `conversion.state` is `ready`; the old session is
closed 20 s after the new one is ready.

### Push vs poll

Use **server-sent events** (`EventSource`). A state change is sent in the same tick it
happens (not on the next poll), and peers/speed/buffer are refreshed once per second only
while they change, over one long-lived connection with no request overhead. EventSource
is available on Chromium 69 (Tizen 5.5) and all current browsers, reconnects by itself
(`retry: 1000`), and sends the cookie on same-origin requests. If a client cannot use it,
poll `GET /api/streams/:sid` — it is answered from memory in well under a millisecond, so
a 500 ms interval is fine.

## Capabilities

The client says what it can decode in `capabilities` (start, convert, resolution):

```json
{ "video": ["h264", "hevc", "hevc10"], "maxHeight": 2160, "audioChannels": 2, "dolbyVision": false, "forceTranscode": false }
```

| Field | Values | Default |
| --- | --- | --- |
| `video` | any of `h264` (8-bit), `hevc` (Main), `hevc10` (Main 10) | `["h264"]` |
| `maxHeight` | `720`, `1080`, `1440`, `2160` | `1080` |
| `audioChannels` | `2` or `6` (AAC 5.1) | `2` |
| `dolbyVision` | `true` if the display renders Dolby Vision profile 5 | `false` |
| `forceTranscode` | `true` forces an H.264 transcode even when the video could be copied. Use it for "compatibility playback" after the copied stream failed to play; `conversion.reason` then includes "Compatibility playback requested". | `false` |

Missing capabilities mean H.264 up to 1080p with stereo audio, which every supported
device plays. The video is copied when the source codec, bit depth and height fit;
otherwise `conversion.mode` is `transcode` and `conversion.reason` says why (for example
"This device does not play 10-bit HEVC; This device plays up to 1080p"). Copied HEVC
uses fragmented-MP4 segments (`segmentFormat: "fmp4"`, hls.js 1.5 supports this);
everything else uses MPEG-TS.

Detecting support in the browser (Media Source Extensions, which hls.js uses):

```js
const mse = (type) => !!window.MediaSource && MediaSource.isTypeSupported(type);
const capabilities = {
  video: [
    mse('video/mp4; codecs="avc1.640028"') && 'h264',
    mse('video/mp4; codecs="hvc1.1.6.L150.B0"') && 'hevc',
    mse('video/mp4; codecs="hvc1.2.4.L153.B0"') && 'hevc10',
  ].filter(Boolean),
  maxHeight: Math.max(screen.width, screen.height) * devicePixelRatio >= 3000 ? 2160 : 1080,
  audioChannels: 2,
};
```

- **Windows browser:** Chrome/Edge report HEVC only with hardware support (Edge may need
  the HEVC extension). The check above is reliable.
- **Samsung Tizen (Chromium 69):** Samsung TVs decode HEVC Main/Main 10 in MSE; use the
  same checks. The packaged app's canvas is often 1920×1080 even on a UHD panel; base
  `maxHeight` on the panel (`webapis.productinfo.isUdPanelSupported()` where available),
  not the canvas.
- **Chromecast:** older Chromecasts play H.264 up to 1080p: cast with
  `{ "video": ["h264"], "maxHeight": 1080 }` (restart with `/convert` before casting).
  Chromecast Ultra/with Google TV also play HEVC and 2160p.

## Routes

Errors use the app's usual body `{ "error": "Readable sentence" }`, with an added
`reason` where the UI should react differently:

| `reason` | Status | Meaning |
| --- | --- | --- |
| `vpn` | 403 | VPN interface missing (or lost while streaming). Show `guard.message`. |
| `permission` | 403 | The account cannot download or stream. |
| `unavailable` | 404 | No release passes the rules at that resolution; `error` explains the best near miss. |
| `limit` | 409 | Too many streams (server or this user). |
| `not-ready` | 409 | Probe or playback not ready yet; retry shortly or wait for events. |
| `disk` | 507 | Not enough free space after the reserve, or the stream cache is full. |
| `no-peers`, `no-release` | in `error` of a failed session | Every candidate timed out / failed. |

A status's `error` object has the same `reason` values plus `failed` and `conversion`.

### `GET /api/streams/guard`

```json
{
  "required": true,
  "ok": true,
  "interface": "NordLynx",
  "patterns": ["nordlynx", "nordvpn*", "wireguard*", "openvpn*", "proton*", "mullvad*", "wg*", "tun*", "tap*"],
  "checkedAt": 1794651788249,
  "message": "Streaming through the VPN (NordLynx)."
}
```

Without a VPN: `"ok": false, "interface": null, "message": "Connect the VPN to stream. Without it, every peer can see this server’s address."`.
With `STREAM_VPN=off`: `"required": false, "ok": true`.

### `GET /api/items/:id/stream-options[?refresh=1]`

What would be streamed at each resolution. Any signed-in user may read it.

```json
{
  "itemId": "8b1c…",
  "kind": "tv",
  "defaultResolution": 1080,
  "resolutions": [
    {
      "resolution": 1080,
      "available": true,
      "release": {
        "hash": "3f0e…",
        "fileIndex": null,
        "name": "House of the Dragon S01E01 The Heirs of the Dragon 1080p HMAX WEB-DL DDP5 1 Atmos H 264-FLUX",
        "filename": "House.of.the.Dragon.S01E01.The.Heirs.of.the.Dragon.1080p.HMAX.WEB-DL.DDP5.1.Atmos.H.264-FLUX.mkv",
        "sizeBytes": 4402341478,
        "seeders": 11,
        "resolution": 1080,
        "service": "HMAX",
        "group": "FLUX",
        "hdr": false,
        "dolbyVision": false,
        "dolbyVisionOnly": false,
        "hevc": false,
        "seasonPack": false,
        "score": 54,
        "why": ["+20 Full-bitrate size", "+15 Source service HMAX", "+5 Release group FLUX", "+14 11 seeders"]
      },
      "alternatives": 10,
      "seasonLock": null,
      "session": null
    },
    {
      "resolution": 2160,
      "available": false,
      "reason": "No 2160p release passes the rules. Best: Fewer than 5 reported seeders"
    }
  ],
  "canStream": true,
  "guard": { "required": true, "ok": true, "interface": "NordLynx", "message": "Streaming through the VPN (NordLynx).", "patterns": ["…"], "checkedAt": 1794652614914 },
  "cached": false,
  "listingAgeSeconds": 0,
  "elapsedMs": 141
}
```

- `defaultResolution`: 2160 for movies and 1080 for series when available, otherwise the
  other one.
- `seasonLock`: `{ "group": "FLUX", "service": "HMAX", "seasonPack": false }` when a lock
  exists for this season and resolution (`seasonPack` true when the top release is the
  locked pack itself).
- `session`: `{ "id", "state" }` when this user already has a session for this item and
  resolution (for example a warm prepared one).
- `cached`/`listingAgeSeconds`: whether the listing came from memory. `?refresh=1`
  forces a new catalog request.

### `POST /api/items/:id/stream/prepare` → 202

Body (all optional): `{ "resolution": 1080, "after": "<session id>", "player": "<player id>" }`.
`after` ties the prepared session's lifetime to a playing session (used by prepare-next).
Starts finding peers and probing; never converts. Returns the status (below) at once,
typically `"state": "finding-peers"`. Calling it again for the same item and resolution
returns this player's session (or an existing prepared one) and keeps it alive.

### `POST /api/items/:id/stream` → 201 (play)

```json
{
  "resolution": 1080,
  "capabilities": { "video": ["h264", "hevc"], "maxHeight": 2160 },
  "audio": 2,
  "position": 812.5,
  "wait": false,
  "player": "tab-5f2c9a"
}
```

All fields optional; send `player` (see Devices and players). Reuses this player's session
for the item and resolution, or claims a prepared one, otherwise creates one; a session
playing on another player is never reused. Every call starts a new conversion with
these capabilities, so calling it again is also the way to retry. `position` defaults to the watch-history resume point (0 when finished); `audio` to the
user's preferred audio language, else the file's default track. Returns the status at
once; the playlist arrives in events. With `"wait": true` the response waits (up to
60 s) until `conversion.state` is `ready` or `failed` — simpler, slightly less live.

### `GET /api/streams` → `{ "items": [status, …] }`

This user's sessions.

### `GET /api/streams/:sid[?position=seconds]` → status

`position` (absolute seconds) updates the playhead. Real example (Sintel, just after
play):

```json
{
  "id": "ac06cb0f-cfb8-4e0b-9480-7a4c8489885e",
  "itemId": "ad04408e-7eab-4300-8995-5833406205cc",
  "titleId": "d1a8579b-f0b3-470c-82bb-b44ceeadc343",
  "resolution": 1080,
  "intent": "play",
  "player": "tab-5f2c9a",
  "state": "ready",
  "message": "Ready",
  "error": null,
  "release": { "hash": "08ada5a7…", "name": "Sintel.2010.1080p.WEB-DL.AAC.H.264-BLENDER", "filename": "Sintel.mp4", "sizeBytes": 129241752, "seeders": 120, "…": "same shape as stream-options" },
  "fallback": null,
  "attempts": [
    { "name": "Sintel.2010.1080p.WEB-DL.AAC.H.264-BLENDER", "hash": "08ada5a7…", "state": "won", "reason": null, "peers": 5 }
  ],
  "peers": 5,
  "downloadSpeed": 2649402,
  "uploadSpeed": 8737,
  "file": { "name": "Sintel.mp4", "size": 129241752, "downloaded": 3494552, "progress": 0.027 },
  "buffer": {
    "position": 0,
    "aheadBytes": 123188,
    "aheadSeconds": 0.8,
    "convertedAheadSeconds": 0,
    "waitingForData": false
  },
  "resumePosition": 0,
  "playback": {
    "itemId": "ad04408e-7eab-4300-8995-5833406205cc",
    "duration": 888.064,
    "video": "h264",
    "width": 1024,
    "height": 436,
    "videoProfile": "High",
    "pixelFormat": "yuv420p",
    "hdr": false,
    "dolbyVision": null,
    "container": "mov,mp4,m4a,3gp,3g2,mj2",
    "bitRate": 1164256,
    "audio": [{ "index": 1, "codec": "aac", "language": "eng", "title": "", "channels": 6, "default": true }],
    "subtitles": [],
    "chapters": [],
    "direct": true,
    "plan": { "mode": "copy", "reason": null, "segmentFormat": "ts" },
    "preferredSubtitles": []
  },
  "conversion": {
    "id": "664fb8db-a85f-48d5-851d-68608bae8115",
    "state": "ready",
    "url": "/api/media/sessions/664fb8db-a85f-48d5-851d-68608bae8115/index.m3u8",
    "offset": 0,
    "requested": 0,
    "mode": "copy",
    "reason": null,
    "segmentFormat": "ts",
    "audio": 1,
    "subtitles": [],
    "convertedSeconds": 0,
    "error": null
  },
  "replaces": null,
  "replacedBy": null,
  "parentId": null,
  "timings": {
    "peersMs": 263,
    "metadataMs": 444,
    "probedMs": 1048,
    "playRequestedMs": 1060,
    "playlistMs": 1279,
    "playToPlaylistMs": 219
  },
  "expiresInMs": 119779
}
```

Field notes:

- `release`: what is (or will be) streamed; before metadata it is the top candidate.
- `fallback`: `null`, or `{ "from": release, "to": release, "reason": "No metadata within 6 s", "at": ms }`
  — show "The first choice had no peers, switched to …".
- `attempts`: each candidate tried: `trying`, `won`, `abandoned` (another answered
  first or it was too slow) or `failed` (with `reason`).
- `peers` / `downloadSpeed` / `uploadSpeed` (bytes per second): of the chosen torrent,
  or the sum of the candidates while connecting.
- `buffer.aheadBytes` / `aheadSeconds`: contiguous downloaded data from the playhead
  (seconds estimated from the average bitrate). `convertedAheadSeconds`: HLS media
  produced beyond the playhead. `waitingForData`: FFmpeg is blocked on missing pieces.
  `state` becomes `buffering` when FFmpeg waits and less than 6 s is converted ahead.
- `playback`: the same fields as `GET /api/items/:id/media` for a local file, plus
  `hdr`, `dolbyVision` (`{ profile, compatibility }`), `videoProfile`, `pixelFormat`,
  `container`, `bitRate`, `audio[].default`, `subtitles[].forced`, `plan` (copy or
  transcode for the session's current capabilities), `direct` (the raw file plays in a
  `<video>` element: MP4 with H.264 and AAC) and `preferredSubtitles`:
  `[{ "language": "ara", "embedded": true }]` for each of the user's preferred subtitle
  languages (`subtitleLanguage` in preferences; comma-separated values are accepted).
- `conversion.offset`: absolute time of the playlist's position 0 — the keyframe at or
  before `requested` when the video is copied (copying cannot cut between keyframes),
  exactly `requested` when transcoding. Absolute position = `video.currentTime + offset`.
- `conversion.audio`: the audio stream index in use; `conversion.subtitles`: embedded
  text-subtitle stream indexes extracted alongside (preferred languages first, at most 8).
- `replaces` / `replacedBy`: resolution switch links. `parentId`: set for a session
  prepared with `after`.
- `timings`: milliseconds since the session was created (for diagnostics and UI).

### `GET /api/streams/:sid/events` (server-sent events)

`Content-Type: text/event-stream`. The first message is the current status; then a
message on every change (state changes immediately, live figures at most once per
second). The final message has `"state": "stopped"` and `message` gives the reason, then
the stream ends. Comments (`: keep-alive`) every 15 s.

```
retry: 1000

event: status
data: {"id":"ac06…","state":"finding-peers","message":"Finding peers…", …}

event: status
data: {"id":"ac06…","state":"probing","peers":5, …}
```

```js
const events = new EventSource(`/api/streams/${id}/events`);
events.addEventListener('status', (e) => render(JSON.parse(e.data)));
```

### `POST /api/streams/:sid/heartbeat`

Body `{ "position": 812.5 }` (absolute seconds). Returns the status. Keeps the session
alive and makes `buffer` describe the real playhead.

### `GET /api/streams/:sid/media`

Probe info, same shape as `status.playback` (and as `GET /api/items/:id/media`). Waits up
to 30 s for the probe; `409 not-ready` if it is still not available.

### `POST /api/streams/:sid/convert` (start or restart conversion)

Body (all optional): `{ "position": 1800, "audio": 2, "capabilities": { … } }`. Stops the
current conversion, moves download priority to `position` at once, starts FFmpeg there,
and answers when the first segment exists:

```json
{
  "id": "1f7c…",
  "state": "ready",
  "url": "/api/media/sessions/1f7c…/index.m3u8",
  "offset": 698.375,
  "requested": 700,
  "mode": "copy",
  "reason": null,
  "segmentFormat": "ts",
  "audio": 1,
  "subtitles": [],
  "convertedSeconds": 0,
  "error": null,
  "sessionId": "ac06…"
}
```

`503` with a readable error when conversion fails (for example both transcode slots
are busy: transcodes share two slots with local playback and live TV; copies have their
own budget of eight).

### `POST /api/streams/:sid/resolution` → 201

Body `{ "resolution": 2160, "position": 1234, "capabilities": { … } }`. Starts (or reuses
a prepared) session for the same item at the other resolution, playing from `position`
(default: the current playhead). Returns the new session's status with `replaces` set;
the new session inherits the old one's `player`. The old session gets `replacedBy` and
keeps working until 20 s after the new one is ready. Going back to the original quality
cancels that: stop the new session (`DELETE`), or start/convert the old one again, and
the old session's `replacedBy` returns to `null`. `404 unavailable` when the resolution
has no acceptable release.

### `POST /api/streams/:sid/prepare-next` → 202

Prepares the next episode in title order at the same resolution, tied to this session.
Returns the new session's status; `404 "This is the last episode"` at the end.

### `GET /api/streams/:sid/subtitles`

```json
{
  "embedded": [
    { "index": 3, "codec": "subrip", "language": "eng", "title": "", "forced": false, "text": true, "available": true, "url": "/api/streams/ac06…/subtitles/embedded/3" },
    { "index": 4, "codec": "hdmv_pgs_subtitle", "language": "ara", "title": "", "forced": false, "text": false, "available": false, "url": null }
  ],
  "online": [
    { "id": "0", "language": "eng", "label": "English", "url": "/api/items/8b1c…/subtitles/online/0" }
  ],
  "onlineError": null,
  "preferred": [{ "language": "ara", "embedded": false, "online": true }]
}
```

- Embedded text tracks become `available` once a conversion is running (they are
  extracted by it). Image subtitles (PGS/VobSub) are listed with `text: false` and cannot
  be shown.
- Online subtitles use the existing provider and routes
  (`/api/items/:id/subtitles` and `/api/items/:id/subtitles/online/:track`), which now
  work for an item with an active stream. The lookup is started when a session is
  prepared, so it is usually cached.

### `GET /api/streams/:sid/subtitles/embedded/:index`

WebVTT of an embedded text track **for the current conversion**: cue times are on the
playlist's timeline (0 = `conversion.offset`), like `?offset=` on the local route, in
both copy and transcode mode and after any seek. (FFmpeg writes the cues in source time;
the server moves them onto the playlist timeline when serving them, dropping cues that
ended before the playlist starts.) The file grows while FFmpeg converts. `409 not-ready`
until `conversion.state` is `ready`. Headers:

- `X-Stream-Offset`: the conversion's offset (seconds).
- `X-Subtitle-Until`: absolute time up to which cues are written.
- `X-Subtitle-Complete`: `true` once the conversion has reached the end of the file.

Re-fetch when playback gets within a minute of `X-Subtitle-Until` (or every 30–60 s)
and add new cues; re-attach after every `/convert` restart.

### `GET /api/streams/:sid/file`

The raw file with range support, only when `playback.direct` is true (MP4 with H.264
and AAC). `409` otherwise. Usually the copied HLS playlist is the better choice because
it starts as quickly and keeps the existing player path.

### `POST /api/streams/:sid/cast`

For Chromecast: returns `{ "url": "/cast/media/<conversion id>/master.m3u8?token=…" }`
once the current conversion has three segments. The URL works without the login cookie
(random token scoped to that conversion, CORS `*`), like live TV casting. The master
playlist declares `CODECS` and `RESOLUTION`. Restart the conversion for the
Chromecast's capabilities first; a new conversion needs a new grant.

### `DELETE /api/streams/:sid` → `{ "ok": true }`

Stops at once: the session disappears from every route immediately, the torrent is
dropped when no other session uses it, and the cached data is deleted in the background.
Send a JSON body (`{}`), like every non-GET request in this app.

## Watch history

`POST /api/playback { itemId }` accepts an item without a local file while the user has a
stream session for it (call it after `POST /api/items/:id/stream` returns). Its response
has `"source": "stream"`. Progress events work unchanged and also update the stream's
playhead. Streamed items are stored with `history.streamed = 1`, so a partly watched
stream appears in Continue Watching and resumes like a local file; Next Up already lists
the next unwatched episode whether or not it is downloaded. The player's local-only
check (`item.available`) is the front end's to relax for streams.

## Season locks

Stored in `stream_locks(title_id, season, resolution)`. The lock is written when the
first stream of a season becomes ready, and replaced when a later stream had to fall back
(the locked choice no longer answers). Movies have no lock.

## Streaming filter: trusted groups and confirmed subtitles

Two torrent rules, both on by default: `trustedOnly` and `requireSubtitles`, with the
editable `trustedGroups` list (Settings → Torrent rules). They affect streaming only.

- **Trusted** means the release group (the `-GROUP` at the end of the name, or `[Group]`
  at the start for anime) is on the list. Torrentio reports no uploader trust, so the
  group is the only signal available.
- **Confirmed subtitles** means the file, read with ffprobe before playback, has a full
  text-subtitle track (not forced, not PGS/VobSub) in the viewer's preferred subtitle
  language, or English when none is set. The listing cannot tell this; the file must be
  opened. The languages found are remembered per file in
  `settings['streamSubtitles:<titleId>']`.
- Releases are tried in four bands, each in score order: trusted; trusted known to lack
  the subtitles; untrusted; untrusted known to lack them. A file without the subtitles is
  dropped for the next one in the same band, up to 3 files read; the attempt is listed
  with state `no-subtitles`, and `fallback.kind` is `subtitles` when another file had
  them. When none do, the best file read is opened again and plays.
- Nothing is refused for these reasons. Status `warnings[]` says what was not met, and
  `release.trusted` / `release.subtitles` (`true`, `false`, or `null` when unknown or the
  filter is off) appear in stream options and status.

## Measured timings

On the development PC (Windows 11, NordLynx VPN, Sintel test torrent, FFmpeg 8.1),
through the HTTP API:

| Step | Time |
| --- | --- |
| Stream options, cold (real Torrentio listing) | 127–147 ms |
| Stream options, warm | 2–7 ms |
| Next episode's options after the background prefetch | 35 ms |
| Prepare request | 12–13 ms |
| Prepare → metadata | 0.53–0.93 s |
| Prepare → warm (probed) | 1.1–3.5 s (swarm-dependent) |
| Play on a warm session → playlist URL | 0.22–0.25 s |
| Play without prepare → playlist URL | 1.5–4.0 s |
| Seek to an undownloaded position → new playlist | 1.3–1.7 s |
| Audio/position restart | 0.65–2.1 s (depends on whether the data is there) |
| Resolution switch → new playlist (shared torrent) | 0.66–1.4 s (one run 11.5 s: the switch position was not downloaded yet) |
| Next Up: prepare → warm (same torrent) / play → playlist | 0.06–0.14 s / 0.26–0.31 s |
| Transcode restart (H.264 software) → playlist | 0.4–0.7 s |
| Stop request | < 10 ms (cleanup ≈1 s in the background) |

## Limitations

- Torrent traffic is not bound to the VPN interface. The guard matches interface names
  only, so an unrelated interface with a matching name (a home `wg0`) satisfies it, and
  traffic can continue for up to about half a second after a drop. See "What the VPN
  guard does and does not do" above; on the NAS, run the app inside the VPN container's
  network namespace so no other route exists.
- Opening a title page, a stream sheet, or focusing or hovering a Stream button prepares a
  stream: the server joins the release's swarm before the viewer presses play (dropped
  after about a minute if not played). This is deliberate, for an instant start.
- The buffer seconds are estimated from the average bitrate.
- Embedded subtitles exist only for the converted range; re-fetch as described above.
- A stream reserves twice its file size on disk while it runs.
- HDR tone mapping needs an FFmpeg build with `zscale` (checked at run time; without it,
  HDR sources that must be transcoded look washed out).
