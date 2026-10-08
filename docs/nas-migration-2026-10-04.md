# NAS migration record — 2026-10-04

## Completed

Access uses the user's existing encrypted-credential connection helper at
`C:/Users/brain/Documents/repos/dapd/scripts/connect-nas.ps1`. The current NAS
address is `192.168.50.174`; its verified SSH host identity is retained through
the existing `192.168.50.28` host alias. No credential has been copied into this
repository and no new SSH key has been installed.

Before the rebuild, Mediawan ran revision
`90816819549b70f0978e70a6ac3d2f839eaa99c2`, version 1.1.0.
It has persistent mounts at `/volume1/docker/mediawan/data` and
`/volume1/docker/mediawan/media`. The cache contains 41 completed files totalling
219,134,299,248 bytes, with a 2 TiB budget. The database includes 14 users and
watch-progress records across anime, movies and TV.

The following containers were stopped and their Docker restart policies changed
from `unless-stopped` to `no`:

- `jellyfin`
- `sonarr`
- `radarr`
- `bazarr`
- `jellyseerr`
- `vpn` (the old downloader project's Gluetun container)
- `tuliprox`

The old downloader project also defines qBittorrent, Prowlarr and FlareSolverr,
but no containers for those services existed at inventory time. Do not run its
full `compose up` command just to stop or clean the old stack.

Each of the seven legacy `docker-compose.yaml` files was reversibly renamed to
`docker-compose.yaml.retired-20261004`, within its original project directory.
Their bytes matched the verified configuration archive before the rename.
`retired-project-definitions.json` in the migration backup records the paths and
checksums. UGOS project records and stopped containers remain; restore the file
names before any intentional project redeploy. Only the current user's crontab
was checked for matching Docker restart commands; privileged UGOS scheduled
tasks were not fully audited.

Mediawan, its tunnel and updater remain running. DAPD, Foggin, Trader, Marusic,
Firefox, NAS core services, music and books are outside this video-stack cleanup.
The standalone legacy `cloudflared` container is retained until all its hostname
routes are identified; it shares its network namespace with the stopped
Jellyseerr and Tuliprox containers.

## Backups

Private project configuration and container-state backups are stored on the NAS:

`/volume1/docker/mediawan/releases/nas-migration-20261004-76886817`

The project configuration archive contains nine Compose/environment files.
`containers-before.json` records original restart policies, image IDs and mounts,
without container environments. The verified app-state archive is
`legacy-app-state-v2.tar.gz`: 5,153,112,508 compressed bytes, containing 42,260
regular files and 7,006,510,140 uncompressed bytes. Tar enumeration and a separate
Python archive read completed successfully. The earlier 322-byte archive did
not include the nested bind-mount contents and must not be used for restoration.

A separate, consistent Mediawan database snapshot and copies of `catalog.json`
and `guide.json` are at:

`/volume1/docker/mediawan/data/backups/nas-migration-20261004-76886817`

SQLite integrity verification returned `ok`. The backups contain credentials
and private app data, remain on the NAS, and are not committed here. They do not
include the old media library.

## Checks and limitations

- Mediawan's storage, configured download source, downloader and encoder checks
  all passed. VAAPI encoded a real test frame.
- The isolated smoke test downloaded a synthetic clip, verified its SHA-256,
  encoded H.264/AAC HLS and checked source protection and eviction. Temporary
  smoke-test data was cleaned up.
- Real-Debrid premium was verified active through 2026-11-17. Premiumize is not
  configured.
- A completed cached file was readable. Movie and TV sources for previously
  watched titles resolved and were recognized by `ffprobe` as playable video.
- Mediawan stayed healthy after the seven legacy containers stopped. Its public
  `/healthz` endpoint returned the expected revision. An earlier request using
  Python's default user agent failed; the diagnostic request with an explicit
  user agent succeeded.
- Live TV has 1,440 channels pointing directly to the upstream provider, a ready
  saved guide, active account status and a one-channel connection limit. Its
  stored URLs do not use Tuliprox. A sequential direct probe of a configured
  sports channel succeeded with 1920×1080 H.264 video and AAC audio after
  Tuliprox stopped. A physical TV-client playback test was not performed.
- The sampled movie and TV releases were **480p and 400p** respectively, with
  Spanish/Russian release tags. They were selected despite `MIN_RESOLUTION=1080`.
  This was the pre-rebuild result. English audio preference is not currently an
  English-only admission policy.
  Do not describe these tests as proof of the intended 1080p/English experience.
  The rebuilt movie/TV candidate loop now probes actual source dimensions before
  delivery and skips below-floor files, including untagged or mislabeled ones.
  Rejected candidates are excluded from the automatic download fallback.
  Anime retains its separate selection policy.
- Anime's latest recorded provider health includes title-specific misses and
  stale-index warnings; the existing cache is intact. Source coverage and
  permanent/offline availability are not guaranteed by this migration.
- The web container's Watchtower label remains `false`; automatic updates to
  this container are disabled. The rebuilt image is pinned locally and has
  `pull_policy: never` so a restart does not overwrite the tested fix.

## Media deletion inventory — authorized, execution blocked

The user reviewed the inventory and instructed deletion of all legacy video
media and a Mediawan rebuild. Automatic approval review rejected permanent
removal of approximately 11.65 TiB of media, recycle contents, app state and
caches because of irreversible loss. The rejected command did not run. No
permanent deletion, cache reset or disk reclamation was performed. A direct
human action in the NAS interface is required to complete permanent deletion;
do not bypass the rejection through a script, helper, or split removal commands.

Allocated bytes were measured in one `du` invocation so hardlinks shared across
these roots are counted once. Per-folder attribution depends on traversal order;
the combined total is the useful storage estimate.

| Exact NAS path | Allocated bytes counted | Approximate size |
| --- | ---: | ---: |
| `/volume1/Jellyfin/Movies` | 2,368,288,841,728 | 2.154 TiB |
| `/volume1/Jellyfin/TV Shows` | 3,580,483,502,080 | 3.256 TiB |
| `/volume1/Jellyfin/Anime` | 23,473,373,184 | 21.9 GiB |
| `/volume1/Jellyfin/torrents` | 72,701,992,960 | 67.7 GiB |
| `/volume1/Jellyfin/#recycle` | 256,122,400,768 | 238.5 GiB |
| `/volume1/docker/prawlarr-solvarr-qbit/downloads` | 6,507,774,431,232 | 5.919 TiB |
| **Total** | **12,808,844,541,952** | **11.650 TiB** |

Each root resolves to itself and has no nested mount points. Their permanent
container references belong only to the stopped legacy media apps. A temporary
read-only backup helper mounted `/volume1/docker` while the archive was running;
the archive command has completed. The array uses ext4. Actual reclaimed
space must be measured afterward rather than inferred solely from this table.

Preserve `/volume1/Jellyfin/Music`, `/volume1/Jellyfin/m3us`, Mediawan's entire
data/media directories, the migration backups, `/volume1/Music`, books and
unrelated app data. No global Docker prune or shared-network removal is planned.
Legacy app directories are also retained. Their configuration and app-state
backups are verified; the file renames above preserve all project contents.

## Rebuild and verification

The active NAS image is `mediawan:nas-rebuild-20261004-quality-3`, image ID
`sha256:ef81e0bf847afcd5a27ea0bea5682bd752f289faebf0b0c0841f9311c91814c0`, with
revision `9081681-nas-quality3-20261004`. It layers the tested application source
and regenerated Chromium-69 TV assets over the verified existing production
runtime. Parsed dependency lockfiles were identical; their raw byte checksums
differed because of line endings. No package dependencies were changed.

Build source, build recipe, previous Compose file, image manifest and verification
record are stored at:

`/volume1/docker/mediawan/releases/rebuild-20261004-quality-3`

The uploaded source archive SHA-256 was
`c594103cba8ecb06c8ac07e2747bd6b33f2a8b7b7ccca4fefdbe56e1b3ac994e`. Runtime
data, credentials and media were excluded. The image rebuild used a 2.42 MB
isolated context. Only the web service image and pull policy changed in the
active Compose file; other service configuration was checked for equality.
Only `web` was recreated. Existing mounts, provider credentials, GPU access,
user ID, tunnel and updater were preserved.

A fresh `pre-rebuild-20261004.sqlite` snapshot in the existing database backup
directory passed integrity checking, with 14 users, 66 progress rows and 41
cache rows. No account or watch-history reset occurred.
Additional `pre-rebuild-quality2-20261004.sqlite` and
`pre-rebuild-quality3-20261004.sqlite` snapshots precede the identity fixes.

- All 427 local tests passed. All 81 candidate/source-policy/identity regression tests
  passed inside the new NAS image with no network or production mounts.
- TV assets built successfully for Chromium 69.
- Public health returned HTTP 200 and the new revision; Docker health was healthy.
- Setup checks passed for storage, downloader, FFmpeg and VAAPI. The isolated
  synthetic smoke test verified download SHA-256, H.264/AAC HLS, active source
  protection, eviction and diagnostic cleanup.
- The previously sampled movie now selected actual 3840x2080 HEVC with English
  E-AC3 audio. Interstellar selected actual 1920x1080 H.264 with an English audio
  track among its available tracks.
- Ted Lasso S04E09 did not have an acceptable instant source in the first
  rebuilt check and started a provider download. A successful probe is not a
  physical client playback test or a guarantee of universal source coverage.
- Testing S01E01 exposed an unrelated "Ted" release returned by an ID-mapped
  addon. The final TV candidate list requires the requested title across every
  source; text search also checks title/season, and a single file cannot bypass
  a season/episode mismatch. All 52 listed S01E01 candidates matched Ted Lasso.
  Final source selection returned `Ted Lasso S01 1080p BluRay DD+ 5.1
  x265-edge2020`, probed as 1920x960 HEVC with English E-AC3. Its full 1920-pixel
  width qualifies as a legitimate 1080-class crop.
- The final image passed the synthetic pipeline smoke test again after the
  identity fix. Public HTTP 200 and healthy Docker status were verified at the
  final revision. The live-TV catalogue still contains 1,440 channels.
- Final cache usage remains 41 completed files / 219,134,299,248 bytes. `df`
  reports approximately 8.0 TiB available on the 20 TiB volume. No legacy media
  was deleted and no cleanup space reclamation is claimed.

The source-policy fix is present in the local working tree and the deployed NAS
image. It has not been pushed to the upstream registry. Keep the image pin until
a tested registry release includes the fix. The retained stopped legacy
containers, old app directories and 11.65 TiB library are not disk cleanup.

The active NAS Compose file is `/volume1/docker/mediawan/docker-compose.yaml`.
The final release's `docker-compose.before.yaml` restores the immediately
preceding image. The **original registry-based configuration** is retained in
`/volume1/docker/mediawan/releases/rebuild-20261004-quality-1/docker-compose.before.yaml`
and in the initial private configuration archive. These contain private values;
do not copy them into this repository. A web-image rollback should recreate only
the `web` service with `--no-deps`; it does not require restoring older user data.

## Storage reallocation after rebuild

On 2026-10-04 the user repeated the request to remove all media and allocate the
space to Mediawan. The permanent-deletion rejection remains in effect; it was
not retried or bypassed. Existing media and the 41-file Mediawan cache remain.

The live cache budget was increased from 2 TiB to **18 TiB**
(`CACHE_BUDGET_BYTES=19791209299968`). A **1 TiB free-space reserve**
(`CACHE_RESERVE_BYTES=1099511627776`) protects the shared NAS volume. These are
admission limits, not a disk partition, a reservation of physical blocks, or
evidence of freed storage. With approximately 7.9 TiB currently available,
Mediawan can use about 6.9 TiB of additional available space before reaching the
reserve. Once media is removed directly through the NAS interface, the newly
available space can be used automatically up to the 18 TiB cache budget.

Private configuration backups and a storage manifest are at:

`/volume1/docker/mediawan/releases/storage-reallocation-20261004-123713`

Only the two effective storage settings changed; the full effective Compose
configuration was compared before/after after excluding those settings. Only
the `web` container was recreated. Storage/downloader/VAAPI setup checks passed.
Public health returned HTTP 200 with the expected revision and the 18 TiB cache
budget; Docker health was healthy. The live 1 TiB reserve and seven stopped
legacy containers were verified. `verification.json` records those checks.
The image remains `mediawan:nas-rebuild-20261004-quality-3` with automatic web
updates disabled. Permanent cleanup and actual space reclamation remain blocked.

## Legacy service rollback before media deletion

The seven containers still exist. To restore their prior automatic restart
policy and start them again:

```sh
docker update --restart=unless-stopped jellyfin sonarr radarr bazarr jellyseerr vpn tuliprox
docker start vpn jellyfin sonarr radarr bazarr jellyseerr tuliprox
```

Configuration and app state are retained in place as well as in the backups.
Once old media is permanently deleted, these backups cannot restore the library.
