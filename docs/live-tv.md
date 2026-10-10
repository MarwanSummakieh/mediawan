# Live sports

Open **Live sports** (`#/sports`) for the daily schedule. Choose a date, filter by sport or search by team/event/competition. Events are grouped into On now, Upcoming and Finished in the browser's local time zone, including broadcasts that cross midnight. On now follows the scheduled broadcast time; it does not assert a live score or provider availability.

Events come from the configured XMLTV programme guide. Identical titles at the same start time are grouped with their channel choices. Channel-name placeholders, repeated placeholders, news, highlights and replays are excluded. No fixtures or broadcaster rights are invented. When no events are listed or match the selected filters, all imported channels can be searched directly on the page by name, language or quality. Search covers the entire channel list; Show more channels reveals additional results. Browse channels remains available alongside scheduled events.

Administrators can **Add event**, enter a match or event, sport, competition and start/end time, and link imported channels. These events persist in the v2 database and can be edited or deleted. Events without linked channels remain visible without a Watch button. Upcoming events offer channel details; opening a channel plays its current broadcast. Finished events have no replay action.

## Setup and existing installations

Use **Manage live TV** to import an extended M3U file. Its `url-tvg` / `x-tvg-url` supplies the guide source; a single Xtream account also allows discovery of its XMLTV endpoint. An explicit XMLTV URL can be saved in guide settings. Refresh the guide after changing it. Guides refresh every four hours while the server is running; gzip XMLTV is supported. Failed refreshes retain the saved guide and show its stale status. The retained guide covers available programmes from two days before refresh to eight days ahead.

Private configuration defaults to `live-tv/` beside `MEDIAWAN_DB`. Docker uses `/data/live-tv`, matching the old installation's persistent directory. Existing `catalog.json` and `guide.json` files are loaded automatically, including saved channel mappings and provider connection limits. `LIVE_TV_DIR` can select another location. Back up this directory securely alongside the v2 database. A fresh playlist import resets the simultaneous channel limit to one; change it only to the number allowed by the provider.

Playlist stream URLs, guide URLs and provider credentials stay on the server. Viewers receive opaque channel IDs and authenticated playback URLs. Every provider resource and redirect is restricted to public HTTP(S) addresses, with the checked DNS address pinned to the connection. Do not commit playlists or private live-TV files.

## Playback

Watch opens the chosen channel through a bounded FFmpeg HLS buffer. Viewers of the same channel share one upstream session. Different channels are limited by provider settings, and live playback shares a two-conversion budget with local playback. Video uses software H.264 High Profile, level 4.1, up to 1080p at 30 fps, with a 6 Mbps bitrate limit and stereo AAC audio. This also fits first- and second-generation Chromecast video limits. FFmpeg must be installed. Output retains eight segments and a small deletion margin rather than recording indefinitely. Closing playback releases the viewer; disconnected viewers expire after 45 seconds. Source URLs never reach the browser or logs. The upstream proxy retains media file extensions so FFmpeg can validate HLS transport-stream and fragmented-MP4 segments.

## Chromecast

In Chrome, open a channel and choose **Cast to TV**, then select your Chromecast. Use HTTPS (or localhost for development), and keep the sender and TV on the same Wi-Fi. The TV must be able to reach the Mediawan address used by the browser; localhost is not reachable from a separate TV. Casting uses Google's sender SDK and Default Media Receiver, including older Chromecast dongles. There is no custom receiver registration or additional provider connection.

Local playback pauses after the TV accepts the stream. **Pause TV** / **Play on TV** controls the receiver; **Stop casting** returns playback to the browser. Back to sports stops the cast. Closing the browser tab leaves the TV playing; the receiver's media requests keep its stream alive until playback stops or its six-hour access grant expires.

Receiver URLs use a random, session-scoped token instead of a login cookie, with CORS limited to the read-only cast media route. Issuing another grant for that viewer revokes the previous one. Stopping casting revokes its token. Invalid, expired and disabled-user grants cannot fetch media. Browser playback URLs still require login. Provider credentials remain on the server.

No external calendar is involved. A guide containing only channel-name placeholders cannot populate match details; use a richer XMLTV source or add events directly.

Run `npm test` and `npm run build:tv`. Automated checks use synthetic playlists, guides and generated video. Physical Tizen operation and private provider availability still require deployment acceptance checks.
