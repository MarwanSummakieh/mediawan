# Retiring the old NAS media stack

Target: Mediawan is the only video media application. Music and books remain
outside this migration. Its workflow is:

1. Browse anime, movies or TV in Mediawan.
2. Mediawan resolves and ranks releases through the configured sources. Movie
   and TV sources are probed before admission to enforce the configured minimum
   resolution, including legitimate cinema crops.
3. Playback begins from the source while an admitted background download saves
   the release to the NAS. Downloads exceeding concurrency or storage limits
   are skipped; playback continues and a later play can retry caching.
4. Completed copies are reused for subsequent playback. Compatible clients get
   direct playback or remuxing; remote playback is adapted by the built-in encoder.
5. The cache evicts least recently used releases when it needs room, protecting
   active playback, in-flight downloads and playback grace periods.

This currently implements an on-demand cache. An imported permanent library,
automatic downloads for followed shows, and a user-facing keep-forever workflow
are not provided by this deployment. The database has a cache pin primitive,
but that alone is not a complete permanent-library feature. External source
services remain dependencies; Mediawan being the only NAS media application
does not make all titles available offline or eliminate provider subscriptions.

## Services

| Existing role | Replacement | Retirement condition |
| --- | --- | --- |
| Jellyfin or another playback server | Mediawan player, delivery planner and encoder | Browser, LAN TV and remote playback verified |
| Separate download client | Mediawan's background HTTP downloader | Source checks and a completed cached download verified |
| Separate movie/TV managers and indexer tools | Mediawan catalogue and source resolution | Accept on-demand acquisition; scheduled episode acquisition needs implementation if required |
| Separate encoding service | Mediawan's FFmpeg pipeline | GPU diagnostics and encoding smoke test pass |
| Seanime companion | Mediawan anime providers | Representative anime playback verified; no Seanime integration remains in this checkout |
| Cloudflare connector | Keep `cloudflared` | Required for the existing public hostname |
| Image updater | Keep `watchtower` if automatic updates are wanted | Confirm the active project image policy and Docker API compatibility |

The repository Compose stack contains `web`, `cloudflared` and `watchtower`.
NAS core services, storage management, backups and unrelated apps stay outside
the media retirement scope. Services listed as possible replacements above
are roles to check, not a verified inventory of this NAS.

## Inventory and backups

Run `sh scripts/nas-inventory.sh` from a NAS shell with Docker access. It reports
containers, Compose project identities, mount paths, volumes, image sizes and
filesystem capacity without printing environment variables or credentials.
For sizes of known legacy directories, pass their absolute paths:

```sh
sh scripts/nas-inventory.sh /actual/legacy/library /actual/legacy/downloads
```

Directory size checks can take time on a large array. Record the results before
changing services. Inventory installed UGOS media apps and scheduled tasks too;
Docker cannot report native applications.

Create a restricted NAS-local backup of the active Compose configuration, its
environment file and legacy app configuration. Credentials must remain private.
Back up Mediawan's persistent data using SQLite's backup facility or while the
app is stopped; a bare live database-file copy can omit its WAL contents.
Record the running image digest for rollback. A configuration backup does not
back up media that will be deleted.

## Establish Mediawan's storage and delivery

Keep the existing Mediawan database and its media cache together; cache rows
refer to file paths. Preserve its working host bind mounts, owner IDs, GPU device
mapping and supplemental groups. Do not run `nas-preflight.sh` against the live
deployment without reviewing it: it rewrites storage paths and recursively
changes ownership.

Use distinct locations for persistent app data and Mediawan's cache/transcode
files. Do not point the cache at the old library or allow cleanup of a shared
directory used by another service. Choose a cache budget and free-space reserve
from actual array capacity and non-media usage. The defaults are 2 TiB and
20 GiB; the earlier 15 TiB proposal is not the current runtime default.

On this NAS, earlier verified GPU results selected VAAPI. Verify those results
again during migration; see [NAS pipeline](nas-pipeline.md). Preserve other
configured sources and settings in the active project when simplifying it.
Repository Compose edits do not update the UGOS project automatically.

Verify the deployed revision with `/healthz`, then run inside `web`:

```sh
node scripts/check-pipeline.mjs
node scripts/smoke-pipeline.mjs
```

Also run **Admin → Check sources** and test a movie, a TV episode and an anime
episode. Confirm browser, LAN TV and remote playback, seeking, audio/subtitle
selection, a completed download and reuse of that cached release. Pipeline
smoke tests use synthetic media and do not prove provider playback works.

## Retirement and deletion review

Once Mediawan passes the checks, stop the obsolete media services and disable
their automatic restart/update or scheduled tasks through their owning project
or native app. Retain their configuration backups for rollback. Retire only
identified media services; never run a global Docker prune or remove shared
networks, volumes or a connector another project still needs.

Prepare a deletion table containing each exact NAS path, measured size, former
owner/service, any other container mount reference and backup decision. Review
the inventory with the user before deleting old media, incomplete downloads,
metadata or app state. Preserve Mediawan's database, cache, tunnel configuration,
backups and unrelated personal data. Resolve symlinks and mount boundaries before
recursive removal. Shared or unknown paths remain pending until identified.

Stopping containers does not reclaim their bind-mounted media. Removing an image
does not reclaim a library. Recycle-bin deletion may retain the full disk usage;
permanent deletion must be separately reviewed before emptying it.

After approved cleanup, check free space and rerun Mediawan's storage check and
representative playback. Record what was retired, actual bytes reclaimed and
the remaining services and storage paths.

## Current migration status

- Repository configuration simplified: unused Seanime service removed.
- NAS access restored through the user's existing `connect-nas.ps1` helper.
- Live inventory and reversible service retirement completed on 2026-10-04.
- Seven legacy media containers stopped with their restart policies set to `no`.
- Seven backed-up legacy Compose files reversibly renamed to prevent redeploys.
- User authorized deletion after reviewing the inventory. Automatic approval
  review blocked the irreversible removal of approximately 11.65 TiB; no media
  or app data has been deleted and that space has not been reclaimed.
- Mediawan rebuilt and deployed with actual-source resolution validation;
  public health, synthetic download and hardware encoding checks passed.
- NAS image is pinned locally with automatic web image updates disabled.
  Physical TV playback and title-specific availability remain limitations.
- Live cache capacity increased to 18 TiB with a 1 TiB free-space reserve.
  This changes admission limits; media remains on disk and no space was freed.

See the [2026-10-04 migration record](nas-migration-2026-10-04.md) for verified
paths, measured sizes, backups, validation and remaining decisions.
