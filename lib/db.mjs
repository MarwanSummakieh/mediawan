// SQLite via Node 22's built-in driver — no native deps, no separate DB server.
// Holds users, sessions, invites, the metadata cache, and watch progress.
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbFile = config.dbPath || path.join(__dirname, "..", "data.sqlite");
const db = new DatabaseSync(dbFile);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id       INTEGER PRIMARY KEY,
    email    TEXT UNIQUE NOT NULL,
    name     TEXT NOT NULL,
    pw_hash  TEXT,
    role     TEXT NOT NULL DEFAULT 'member',
    active   INTEGER NOT NULL DEFAULT 1,
    created  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invites (
    token    TEXT PRIMARY KEY,
    email    TEXT NOT NULL,
    name     TEXT NOT NULL,
    role     TEXT NOT NULL DEFAULT 'member',
    used     INTEGER NOT NULL DEFAULT 0,
    created  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token    TEXT PRIMARY KEY,
    user_id  INTEGER NOT NULL,
    created  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta_cache (
    anilist_id INTEGER PRIMARY KEY,
    json       TEXT NOT NULL,
    updated    INTEGER NOT NULL
  );

  -- Watch progress for EVERY vertical, in one table, because "continue where
  -- you left off" is one question the viewer asks — they don't think of anime,
  -- films and shows as separate places they left off in. One table is also what
  -- makes the home row a single ORDER BY: interleaving three sorted lists in
  -- the client would put a film watched last week above an episode from an
  -- hour ago whenever the lists happened to be different lengths.
  --
  -- media_id is TEXT because the three verticals identify things differently:
  -- anime by AniList id, films and shows by IMDb id ("tt…") or, for records
  -- that only exist in apibay's index, a synthesized "m-…" slug.
  -- season is NULL for anime (AniList models a season as its own entry) and
  -- for films; episode is '' for a film.
  CREATE TABLE IF NOT EXISTS progress (
    user_id    INTEGER NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'anime',   -- anime | movie | tv
    media_id   TEXT NOT NULL,
    title      TEXT NOT NULL,
    cover      TEXT,
    season     INTEGER,
    episode    TEXT NOT NULL DEFAULT '',
    seconds    REAL NOT NULL DEFAULT 0,
    duration   REAL NOT NULL DEFAULT 0,
    updated    INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, media_id)
  );

  -- quick per-title tags: heart (favorites) and save-for-later (My List)
  CREATE TABLE IF NOT EXISTS favorites (
    user_id    INTEGER NOT NULL,
    anilist_id INTEGER NOT NULL,
    created    INTEGER NOT NULL,
    PRIMARY KEY (user_id, anilist_id)
  );
  CREATE TABLE IF NOT EXISTS watchlist (
    user_id    INTEGER NOT NULL,
    anilist_id INTEGER NOT NULL,
    created    INTEGER NOT NULL,
    PRIMARY KEY (user_id, anilist_id)
  );

  -- user-named collections and their members
  CREATE TABLE IF NOT EXISTS collections (
    id       INTEGER PRIMARY KEY,
    user_id  INTEGER NOT NULL,
    name     TEXT NOT NULL,
    created  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS collection_items (
    collection_id INTEGER NOT NULL,
    anilist_id    INTEGER NOT NULL,
    created       INTEGER NOT NULL,
    PRIMARY KEY (collection_id, anilist_id)
  );

  -- preferred playback sources, hearted in the player's Servers panel. A key is
  -- a KIND of source, not one release: a provider label ("AnimePahe") or a
  -- release signature ("q1080|WEB-DL"), so the preference carries to the next
  -- episode and title. Per-user, so it follows them across devices.
  CREATE TABLE IF NOT EXISTS server_favs (
    user_id INTEGER NOT NULL,
    key     TEXT NOT NULL,
    created INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  );

  -- The source cache: release files pulled to the array so playback reads from
  -- local disk instead of the debrid CDN. An LRU WORKING SET, not a library --
  -- it evicts against a byte budget. "pinned" opts a title out of eviction;
  -- "state" distinguishes a complete file from one still being fetched, which
  -- matters because playback may begin before the download finishes.
  CREATE TABLE IF NOT EXISTS cache_files (
    key        TEXT PRIMARY KEY,   -- stable identity: provider + release + episode
    path       TEXT NOT NULL,      -- absolute path on the array
    bytes      INTEGER NOT NULL DEFAULT 0,  -- bytes on disk right now
    total      INTEGER NOT NULL DEFAULT 0,  -- expected final size (0 = unknown)
    state      TEXT NOT NULL DEFAULT 'partial', -- partial | complete | failed
    title      TEXT,
    source_url TEXT,
    pinned     INTEGER NOT NULL DEFAULT 0,
    created    INTEGER NOT NULL,
    last_used  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS cache_lru ON cache_files (pinned, last_used);
`);

// ---- migration: progress was anime-only ----
//
// The original table was keyed (user_id, anilist_id) with no notion of a
// vertical. CREATE TABLE IF NOT EXISTS above is a no-op against a database that
// already has it, so an existing install keeps the old shape and every query
// below breaks — this rebuilds it in place and carries the rows over as
// 'anime'. SQLite can't retype a column or change a primary key, so a rebuild
// is the only route: rename, create, copy, drop.
//
// Guarded on the COLUMN, not on a version number, so it is idempotent and a
// database created fresh from the schema above skips it entirely.
{
  const cols = db.prepare("PRAGMA table_info(progress)").all().map((c) => c.name);
  if (cols.length && !cols.includes("kind")) {
    db.exec(`
      BEGIN;
      ALTER TABLE progress RENAME TO progress_old;
      CREATE TABLE progress (
        user_id    INTEGER NOT NULL,
        kind       TEXT NOT NULL DEFAULT 'anime',
        media_id   TEXT NOT NULL,
        title      TEXT NOT NULL,
        cover      TEXT,
        season     INTEGER,
        episode    TEXT NOT NULL DEFAULT '',
        seconds    REAL NOT NULL DEFAULT 0,
        duration   REAL NOT NULL DEFAULT 0,
        updated    INTEGER NOT NULL,
        PRIMARY KEY (user_id, kind, media_id)
      );
      INSERT INTO progress (user_id, kind, media_id, title, cover, season, episode, seconds, duration, updated)
        SELECT user_id, 'anime', CAST(anilist_id AS TEXT), title, cover, NULL, episode, seconds, duration, updated
        FROM progress_old;
      DROP TABLE progress_old;
      COMMIT;
    `);
  }
}

// ---- password hashing (scrypt, built in) ----
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pw, salt, 32);
  return `${salt.toString("hex")}:${dk.toString("hex")}`;
}
export function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(":");
  const dk = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 32);
  return crypto.timingSafeEqual(dk, Buffer.from(hashHex, "hex"));
}
const token = () => crypto.randomBytes(24).toString("hex");
const now = () => Date.now();

// ---- users ----
export const getUserByEmail = (email) =>
  db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase());
export const getUserById = (id) =>
  db.prepare("SELECT * FROM users WHERE id = ?").get(id);
export const listUsers = () =>
  db.prepare("SELECT id,email,name,role,active,created FROM users ORDER BY created").all();
export function createUser({ email, name, password, role = "member" }) {
  const info = db
    .prepare("INSERT INTO users (email,name,pw_hash,role,active,created) VALUES (?,?,?,?,1,?)")
    .run(email.toLowerCase(), name, password ? hashPassword(password) : null, role, now());
  return getUserById(info.lastInsertRowid);
}
export const setUserActive = (id, active) =>
  db.prepare("UPDATE users SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
export const deleteUser = (id) =>
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
export const countAdmins = () =>
  db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").get().c;

// ---- invites ----
export function createInvite({ email, name, role = "member" }) {
  const t = token();
  db.prepare("INSERT INTO invites (token,email,name,role,used,created) VALUES (?,?,?,?,0,?)")
    .run(t, email.toLowerCase(), name, role, now());
  return t;
}
export const getInvite = (t) =>
  db.prepare("SELECT * FROM invites WHERE token = ? AND used = 0").get(t);
export const useInvite = (t) =>
  db.prepare("UPDATE invites SET used = 1 WHERE token = ?").run(t);
export const listInvites = () =>
  db.prepare("SELECT token,email,name,role,used,created FROM invites ORDER BY created DESC").all();

// ---- sessions ----
export function createSession(userId) {
  const t = token();
  db.prepare("INSERT INTO sessions (token,user_id,created) VALUES (?,?,?)").run(t, userId, now());
  return t;
}
export function getSessionUser(t, maxAgeMs) {
  if (!t) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE token = ?").get(t);
  if (!s) return null;
  if (maxAgeMs && Date.now() - s.created > maxAgeMs) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(t); // expired
    return null;
  }
  const u = getUserById(s.user_id);
  return u && u.active ? u : null;
}
export const destroySession = (t) =>
  db.prepare("DELETE FROM sessions WHERE token = ?").run(t);
export const destroyUserSessions = (id) =>
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id); // instant revoke

// ---- metadata cache ----
export function cacheMeta(list) {
  const stmt = db.prepare(
    "INSERT INTO meta_cache (anilist_id,json,updated) VALUES (?,?,?) " +
      "ON CONFLICT(anilist_id) DO UPDATE SET json=excluded.json, updated=excluded.updated"
  );
  for (const m of list) stmt.run(m.anilistId, JSON.stringify(m), now());
}
export function getCachedMeta(id) {
  const row = db.prepare("SELECT json FROM meta_cache WHERE anilist_id = ?").get(id);
  return row ? JSON.parse(row.json) : null;
}
// Same, plus HOW OLD the copy is. Callers that serve an airing show's episode
// list need this: the grid is derived from the cached `airing.episode`, so a
// week-old copy silently hides a week of episodes.
export function getCachedMetaAge(id) {
  const row = db.prepare("SELECT json, updated FROM meta_cache WHERE anilist_id = ?").get(id);
  if (!row) return null;
  return { meta: JSON.parse(row.json), updated: row.updated, ageMs: now() - row.updated };
}

// ---- watch progress ----
//
// `title` and `cover` are COALESCEd rather than overwritten, because the client
// doesn't always know them. A film opened from a deep link (/moviewatch/tt…
// pasted, or resumed from this very row) has no catalog record in memory yet,
// so its first progress ping carries a null cover — and a plain
// `cover=excluded.cover` would blank out the art the row already had, leaving a
// grey card on the home page. Nulls mean "no news", not "erase".
export function saveProgress({ userId, kind = "anime", mediaId, title, cover, season = null, episode = "", seconds, duration }) {
  db.prepare(
    "INSERT INTO progress (user_id,kind,media_id,title,cover,season,episode,seconds,duration,updated) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(user_id,kind,media_id) DO UPDATE SET " +
      // NULLIF, because `title` is NOT NULL and so an unknown title has to be
      // written as '' on the first insert — without it that empty string would
      // then overwrite a good title on every later update.
      "title=COALESCE(NULLIF(excluded.title,''), title), " +
      "cover=COALESCE(NULLIF(excluded.cover,''), cover), " +
      "season=excluded.season, episode=excluded.episode, " +
      "seconds=excluded.seconds, duration=excluded.duration, updated=excluded.updated"
  ).run(userId, kind, String(mediaId), title ?? "", cover ?? "",
    season == null ? null : Number(season), String(episode ?? ""), seconds, duration, now());
}

// How much of a FILM has to be watched before it stops counting as "left off".
//
// A finished film has nowhere to continue to, so without this it sits at the
// head of the row forever with a full progress bar — the one item guaranteed
// not to be what the viewer wants. 95% rather than 100% because credits are
// never watched to the last frame, and duration is often a few seconds off the
// real runtime. A row with no known duration is always kept: unknown is not
// finished.
//
// Episodic kinds are deliberately EXEMPT. Finishing an episode doesn't finish
// the show — it is the strongest possible signal that the viewer is in the
// middle of one — so applying this to them would make a series disappear from
// the row at the exact moment it became most relevant, and not come back until
// the next episode had already been started somewhere else.
const DONE_FRACTION = 0.95;

export const getContinueWatching = (userId) =>
  db.prepare(
    "SELECT * FROM progress WHERE user_id = ? " +
      "AND (kind <> 'movie' OR duration <= 0 OR seconds / duration < ?) " +
      "ORDER BY updated DESC LIMIT 12"
  ).all(userId, DONE_FRACTION);

export const getProgressFor = (userId, kind, mediaId) =>
  db.prepare("SELECT * FROM progress WHERE user_id = ? AND kind = ? AND media_id = ?")
    .get(userId, kind, String(mediaId));

// distinct titles the user has watched, newest first — seeds recommendations.
// Anime only: recommendations are built from AniList genres, and a film's IMDb
// id resolves to nothing in that cache.
export const getWatchedTitles = (userId) =>
  db.prepare("SELECT CAST(media_id AS INTEGER) AS anilist_id, title, updated FROM progress " +
    "WHERE user_id = ? AND kind = 'anime' ORDER BY updated DESC LIMIT 20").all(userId);

// ---- metadata helpers ----
// Resolve a list of anilist ids to cached metadata, preserving order.
export function metasForIds(ids) {
  return ids.map((id) => getCachedMeta(id)).filter(Boolean);
}

// ---- favorites / watchlist (generic tag tables) ----
// `table` is a fixed internal name (never user input) so interpolation is safe.
function toggleTag(table, userId, anilistId) {
  const has = db.prepare(`SELECT 1 FROM ${table} WHERE user_id=? AND anilist_id=?`).get(userId, anilistId);
  if (has) { db.prepare(`DELETE FROM ${table} WHERE user_id=? AND anilist_id=?`).run(userId, anilistId); return false; }
  db.prepare(`INSERT INTO ${table} (user_id, anilist_id, created) VALUES (?,?,?)`).run(userId, anilistId, now());
  return true;
}
const tagIds = (table, userId) =>
  db.prepare(`SELECT anilist_id FROM ${table} WHERE user_id=? ORDER BY created DESC`).all(userId).map((r) => r.anilist_id);

// ---- server favourites (player source preferences) ----
export function toggleServerFav(userId, key) {
  const has = db.prepare("SELECT 1 FROM server_favs WHERE user_id=? AND key=?").get(userId, key);
  if (has) { db.prepare("DELETE FROM server_favs WHERE user_id=? AND key=?").run(userId, key); return false; }
  db.prepare("INSERT INTO server_favs (user_id,key,created) VALUES (?,?,?)").run(userId, key, now());
  return true;
}
export const serverFavs = (userId) =>
  db.prepare("SELECT key FROM server_favs WHERE user_id=? ORDER BY created DESC").all(userId).map((r) => r.key);

export const toggleFavorite = (userId, id) => toggleTag("favorites", userId, id);
export const toggleWatchlist = (userId, id) => toggleTag("watchlist", userId, id);
export const favoriteIds = (userId) => tagIds("favorites", userId);
export const watchlistIds = (userId) => tagIds("watchlist", userId);

// ---- collections ----
export function createCollection(userId, name) {
  const info = db.prepare("INSERT INTO collections (user_id,name,created) VALUES (?,?,?)").run(userId, name, now());
  return { id: Number(info.lastInsertRowid), name };
}
export const listCollections = (userId) =>
  db.prepare("SELECT id, name, created FROM collections WHERE user_id=? ORDER BY created").all(userId);
export const ownsCollection = (userId, id) =>
  !!db.prepare("SELECT 1 FROM collections WHERE id=? AND user_id=?").get(id, userId);
export function deleteCollection(userId, id) {
  if (!ownsCollection(userId, id)) return false;
  db.prepare("DELETE FROM collection_items WHERE collection_id=?").run(id);
  db.prepare("DELETE FROM collections WHERE id=?").run(id);
  return true;
}
export const collectionItemIds = (id) =>
  db.prepare("SELECT anilist_id FROM collection_items WHERE collection_id=? ORDER BY created DESC").all(id).map((r) => r.anilist_id);
export function addToCollection(id, anilistId) {
  db.prepare("INSERT OR IGNORE INTO collection_items (collection_id, anilist_id, created) VALUES (?,?,?)").run(id, anilistId, now());
}
export const removeFromCollection = (id, anilistId) =>
  db.prepare("DELETE FROM collection_items WHERE collection_id=? AND anilist_id=?").run(id, anilistId);
// which of the user's collections contain a given title
export const collectionsContaining = (userId, anilistId) =>
  db.prepare(
    "SELECT c.id FROM collections c JOIN collection_items ci ON ci.collection_id=c.id " +
    "WHERE c.user_id=? AND ci.anilist_id=?"
  ).all(userId, anilistId).map((r) => r.id);

// ---- source cache index ----
// Only the bookkeeping lives here; the files and the eviction policy are
// lib/cache/store.mjs. Kept in SQLite (not a JSON sidecar) so a crash mid-write
// can't lose track of gigabytes sitting on the array.
export const getCacheEntry = (key) =>
  db.prepare("SELECT * FROM cache_files WHERE key = ?").get(key) ?? null;

export function putCacheEntry({ key, path: p, bytes = 0, total = 0, state = "partial", title = null, sourceUrl = null }) {
  const t = now();
  db.prepare(
    "INSERT INTO cache_files (key,path,bytes,total,state,title,source_url,pinned,created,last_used) " +
    "VALUES (?,?,?,?,?,?,?,0,?,?) ON CONFLICT(key) DO UPDATE SET " +
    "path=excluded.path, bytes=excluded.bytes, total=excluded.total, state=excluded.state, " +
    "title=COALESCE(excluded.title,cache_files.title), source_url=COALESCE(excluded.source_url,cache_files.source_url), last_used=excluded.last_used"
  ).run(key, p, bytes, total, state, title, sourceUrl, t, t);
}

export const updateCacheEntry = (key, { bytes, state }) =>
  db.prepare("UPDATE cache_files SET bytes=COALESCE(?,bytes), state=COALESCE(?,state) WHERE key=?")
    .run(bytes ?? null, state ?? null, key);

// Touch on every read — this is what makes the LRU ordering meaningful.
export const touchCacheEntry = (key) =>
  db.prepare("UPDATE cache_files SET last_used=? WHERE key=?").run(now(), key);

export const deleteCacheEntry = (key) =>
  db.prepare("DELETE FROM cache_files WHERE key=?").run(key);

export const setCachePinned = (key, pinned) =>
  db.prepare("UPDATE cache_files SET pinned=? WHERE key=?").run(pinned ? 1 : 0, key);

export const cacheTotalBytes = () =>
  db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM cache_files").get().n;

// Eviction order: unpinned first, least-recently-used first. Partial downloads
// are included — an abandoned half-file is exactly what you want to reclaim.
export const cacheEvictionCandidates = () =>
  db.prepare("SELECT * FROM cache_files WHERE pinned=0 ORDER BY last_used ASC").all();

export const listCacheEntries = () =>
  db.prepare("SELECT * FROM cache_files ORDER BY last_used DESC").all();

// Prune expired sessions (called on boot and periodically).
export function pruneSessions(maxAgeMs) {
  db.prepare("DELETE FROM sessions WHERE created < ?").run(Date.now() - maxAgeMs);
}

export function closeDb() {
  try { db.close(); } catch {}
}

export default db;
