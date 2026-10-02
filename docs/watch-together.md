# Watch together

Watch together synchronizes anime, films and TV episodes across signed-in
Mediawan devices. A room holds up to 12 devices. Each device resolves and plays
its own stream through its account; the room shares the catalog title and
playback clock rather than a stream URL.

## Create or join a room

1. Play a title and wait until the player is ready.
2. In the player, select **Watch together → Create room**.
3. Share the invite link or eight-character room code. Guests must sign in to
   the same Mediawan server, then open the link or choose **Watch together** in
   the sidebar and enter the code. Codes accept lowercase letters and hyphens.

The creator is the host. The room panel lists the host and viewers. Devices
using the same account still join as separate viewers. If the browser blocks
automatic playback, a guest can select **Start playback** to follow the host.

## Playback and leaving

The host controls play, pause, seeking, playback speed and episode changes.
Guests follow the shared timeline. Volume, stream quality, audio tracks and
subtitle choices remain local to each device. The anime sub/dub mode is part of
the host's shared title selection.

Select **Leave room** to return to independent playback. Closing the player
also leaves the room. If the host leaves, or stops contacting the server for
30 seconds, the oldest remaining viewer becomes the host. Playback pauses at
the shared position so the new host can press play when ready. A disconnected
device must join again after its membership expires.

Stop casting before creating or joining a room, and leave the room before
starting a Chromecast session. Watch together follows playback in the local
Mediawan player.

## Lifetime and deployment

Rooms live in the Node process's memory. Restarting the server ends existing
rooms; create a new room afterward. Rooms also end when every device has left
or been absent for 30 seconds, or after 12 hours. Background tab throttling or
device sleep can therefore expire a membership.

The default limits are 100 rooms on a server, 12 devices in a room and 12 room
memberships per account. All API operations require a signed-in session. Only
joined devices can read a room, and only its host device can change playback.
Invite codes grant admission; each joined device receives a separate private
membership token that stays out of the invite link and public member list.

The normal hosted Samsung Tizen app loads the same site and uses its existing
login session. Run `npm run build:tv` after frontend changes to regenerate the
TV-compatible assets. A separately bundled `API_BASE` build retains the
additional cross-origin authentication requirements described in
[the Tizen documentation](../tizen/README.md#b-packaged-build-self-contained-only-if-you-want-offline-chrome).

## API integration

Mount `mountWatchTogetherRoutes(app, { requireAuth })` from
`lib/watch-together-routes.mjs`. Its paths are:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/watch-together` | Create a room from `{ media, state }`. |
| POST | `/api/watch-together/:code/join` | Join by invite code. |
| GET | `/api/watch-together/:code` | Read the room and refresh presence. |
| POST | `/api/watch-together/:code/state` | Host replaces `{ state }`, optionally with a new `media`. |
| POST | `/api/watch-together/:code/leave` | Leave this device's membership. |

POST requests use `Content-Type: application/json`. Create returns HTTP 201;
join and other successful operations return HTTP 200. Create and join return
`{ room, memberId, memberToken }`. Read and state updates return `{ room }`.
Read, update and leave send the private token in the `X-Watch-Member` header;
the token is also bound to the authenticated account. Leaving returns
`{ ok: true }`. Responses use `Cache-Control: no-store`.

`media` contains `kind` (`anime`, `movie` or `tv`), string `id` and `title`.
Anime requires a string `episode`, with optional `mode` (`sub` or `dub`). TV
requires integer `season` and a numeric string `episode`. Films omit episode,
season and mode fields. The API rejects stream URLs and extra media fields.

Clients send `state` as `{ position, paused, rate }`: absolute media position in
seconds, a boolean pause state and playback speed from 0.25 to 2. The room adds
`updatedAt` (server milliseconds) and an increasing `revision`; snapshots also
include `serverTime`. While playing, the current position at receipt is:

```text
state.position + (serverTime - state.updatedAt) / 1000 * state.rate
```

While paused, use `state.position` directly. Add locally elapsed time after
receiving a playing snapshot. This avoids depending on synchronized device
wall clocks. Host transfers publish a paused state with a new revision.

Poll or publish regularly to keep membership active. Requests are limited per
account to 20 creates/joins, 900 reads/leaves and 900 state updates per minute;
HTTP 429 includes `Retry-After`. Invalid input returns 400, invalid membership
or guest controls return 403, and ended rooms return 404. Full rooms return
409. Form posts return 415. The room router bounds JSON bodies to 4 KiB when
it parses them itself; the application's earlier JSON parser can set a
different body limit.
