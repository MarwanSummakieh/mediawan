# V2 migration and recovery

The rewrite uses a new application and a separate database. Do not point it at an old database using MEDIAWAN_DB. V1 DB_PATH is not consumed.

1. Keep the previous container image/digest and make a consistent SQLite backup using SQLite's backup facility, or stop the old service before copying its database and WAL files. Also preserve its configuration and permanent library.
2. Choose an empty destination, such as `/data/mediawan-v2.sqlite`. Stop v2 if it has already created a database; preserve that database separately rather than overwriting it.
3. Run `npm run migrate -- OLD.sqlite NEW.sqlite`, or the equivalent command inside the new container with both database paths mounted. The source is opened read-only; repeated migration into the same completed destination is a no-op.
4. Keep media mounted at the same paths. The importer links ready files in place and preserves a per-asset reader list calculated from the old library policies. It does not move or delete files. Check that both an administrator and a restricted member see the appropriate library.
5. Set MEDIAWAN_DB to the migrated path and start v2. Existing password hashes work; old sessions do not carry over, so sign in again. Re-enable acquisition access only for the accounts that should download.
6. Verify one movie, one series, resume from two devices, shuffled queue recovery, subtitles, and a real Real-Debrid acquisition. Do not remove the old container or database until these checks pass.

The migration cannot recover older episode history that the original title-level progress table overwrote. Active legacy downloads, remote transfer ownership, invites, server preferences and native pairing sessions are not imported. Legacy artwork stored behind old API routes may need refreshing. V1 anime collections without the permanent-library migration must be checked after import. Originals and credentials remain untouched.

For older installations with only `cache_files`, complete local movies and TV episodes with explicit `· S1 E2` labels are linked when exactly one saved title matches. Their byte counts are checked and the files are protected from automatic cleanup. The migration reports `cacheAssets` and `unmappedCache`; unlabeled anime episodes, ambiguous identities, missing files and incomplete files remain untouched for explicit administrator import. A title's latest watched episode is not enough to identify an older cached anime file.

Rollback: stop v2 and restart the old image with its original configuration/database and original media mounts. V2 does not modify the old database or remove media, so there is no destructive downgrade. Keep the new database/files if you may want to resume v2 later.

The local source snapshot is `.recovery/before-v2`. It includes the former source folders, scripts, tests, entry point and package/deployment files. It does not include secrets, the live SQLite database, or media. Copy that source snapshot somewhere durable before deleting this checkout; ignored recovery files are not included in a Git push.
