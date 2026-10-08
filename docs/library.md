# Permanent library

Mediawan can retain original media acquired through its existing sources, or
index files already on the server. The **Saved library** navigation entry opens
the local catalog. Completed files play without contacting streaming providers.
External services are still needed to discover or acquire new sourced content.

## Save and play

- **Play** keeps the existing immediate streaming and evictable background cache.
- **Add to library** queues a permanent original download. Choose a destination
  library and, for a series, the released episodes of the selected season.
- A season selection is a snapshot; it does not subscribe to future episodes.
- TV episodes with unknown air dates are excluded until released metadata is available.
- Saved titles show download status, retry/cancel actions, per-episode watched
  state and resume positions. Favorites, watchlists and collections work across
  anime, movies and TV. Personal state belongs to each account.
- Default source selection uses Mediawan's release ranking. The acquisition API
  accepts an explicit release ID from the existing source selector. Original
  media retains its audio and subtitle tracks; delivery settings only affect
  the playback session.

Cached and uncached originals can be acquired through configured Real-Debrid
and Premiumize accounts. Premiumize transfers download into its cloud first,
then Mediawan selects the matching original file, including nested episode packs.
Browser transcodes and HLS sources are rejected. Provider transfer IDs survive
restarts. Polling stops on cancellation or shutdown and is bounded to six hours
per backend attempt. Retry resumes checking the saved transfer. Cancellation
removes only a transfer created by that acquisition and unused by another saved
job; shared transfers are preserved. Shutdown leaves remote transfers available
for recovery. The adapter follows [Premiumize's documented API](https://www.premiumize.me/api).

Administrators can save by default. To approve a member, open **Administration →
Saved library → Acquisition permissions**, select their accessible libraries and
enable **Can add media**. Defaults permit viewing the three shared libraries but
do not permit member acquisition. Permission changes are checked when queued
work starts and before it publishes an asset.

## Storage and imports

`LIBRARY_DIR` defaults to the `library` directory beside `CACHE_DIR`. Compose sets
it to `/media/library` within the existing media mount. The cache and transcoder
continue using `/media/cache` and `/media/transcode`.

Permanent media is not subject to `CACHE_BUDGET_BYTES` or LRU eviction. All local
downloads share `CACHE_MAX_DOWNLOADS` and the `CACHE_RESERVE_BYTES` free-space
reserve. Insufficient space stops a save with a visible error; it never removes
another permanent file. Interrupted local transfers restart from the beginning
with a freshly resolved original, avoiding corruption from expired or changed
source URLs. Reuse of the cache requires a matching source identity/URL and size;
otherwise Mediawan downloads another verified original.

Import folders are administrator-configured absolute **server/container** paths.
Bind-mount existing media folders into the container before registering them.
Keep import folders separate from the managed library, cache and transcode
directories. Overlapping import roots and symlink traversal are refused.

Scans run at startup, daily, and on **Scan folders**. Override the interval with
`LIBRARY_SCAN_INTERVAL_MS` if needed. Filename and NFO identifiers are used for
matching; ambiguous files appear in the import review list for explicit identity
and episode correction. Local poster artwork and fetched artwork are copied into
the library's `.artwork` directory. Metadata edits remain locked across refreshes.

Imported files stay in place. Missing or invalid files are shown as unavailable.
Removing an imported asset only removes its catalog membership and does not
delete the original; the next scan does not silently re-add it. Deleting a
managed asset removes its retained file. Both actions are administrator-only,
and deletion is refused while the asset has an active playback lease.

## Migration, backup and rollback

The first startup creates versioned library tables in the existing SQLite
database. Migration preserves users, the latest known episode position for each
legacy title, anime favorites/watchlists and collections. Earlier episode history
that was never stored cannot be reconstructed. Existing cache entries remain
evictable until explicitly saved; filenames alone do not justify promotion.

Before upgrading, stop the application or use SQLite's backup facility to make a
consistent database backup. Copying only a live `.sqlite` file can miss its WAL.
Back up the database, environment/configuration, live-TV state and `LIBRARY_DIR`
together. Imported media needs its own backup. Record the current image digest.

Deploy the new image with the same persistent data and media mounts. Confirm
that `/media/library` is writable by the configured PUID/PGID and that the admin
queue and scanner display no setup failures. Source changes in this checkout do
not update the running NAS container until its image is built and deployed.

For rollback, stop the new image, restore the matching pre-upgrade database and
configuration, and run the recorded prior image. Preserve the permanent files
and new database backup separately so post-upgrade work can be recovered; the
older application does not understand the new library catalog. No automated
destructive downgrade migration is provided.

## Verification

Run `npm test` and `npm run build:tv`. The library acceptance test generates real
FFmpeg media, acquires a movie and episode set through an isolated test source,
reopens the database, shuts down that source, and verifies local playback and
resume. It skips only when FFmpeg/FFprobe are unavailable.

Before relying on a NAS deployment, save one movie and a selected season through
your configured Mediawan accounts; wait for completion, restart, and verify
saved playback while those sources are disabled. Check seeking, audio selection,
subtitles and TV remote controls on the actual devices. Local fixtures do not
verify provider subscriptions, NAS permissions/GPU drivers, or physical Tizen
hardware.

This release keeps the current codec baseline. DVR, future-episode monitoring,
additional native clients, Jellyfin API compatibility, music/books/photos,
parental-rating controls and additional GPU/codec support are separate work.
