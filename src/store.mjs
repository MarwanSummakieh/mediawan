import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const id = () => randomUUID();
export const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
export const finite = (n, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
export function createStore(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,pw_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member',active INTEGER NOT NULL DEFAULT 1,can_download INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS logins(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS titles(id TEXT PRIMARY KEY,kind TEXT NOT NULL,external_id TEXT NOT NULL,name TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(kind,external_id));
    CREATE TABLE IF NOT EXISTS aliases(kind TEXT NOT NULL,external_id TEXT NOT NULL,title_id TEXT NOT NULL REFERENCES titles(id),PRIMARY KEY(kind,external_id));
    CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,title_id TEXT NOT NULL REFERENCES titles(id),season INTEGER NOT NULL,episode REAL NOT NULL,json TEXT NOT NULL,UNIQUE(title_id,season,episode));
    CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES items(id),path TEXT NOT NULL UNIQUE,bytes INTEGER NOT NULL,added_at INTEGER NOT NULL,json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS asset_item ON assets(item_id);
    CREATE TABLE IF NOT EXISTS history(user_id INTEGER NOT NULL,item_id TEXT NOT NULL,session_id TEXT,position REAL NOT NULL DEFAULT 0,duration REAL NOT NULL DEFAULT 0,completed INTEGER NOT NULL DEFAULT 0,ever_watched INTEGER NOT NULL DEFAULT 0,played_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,item_id));
    CREATE INDEX IF NOT EXISTS history_recent ON history(user_id,played_at DESC);
    CREATE INDEX IF NOT EXISTS history_item ON history(item_id,played_at);
    CREATE TABLE IF NOT EXISTS playback(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,item_id TEXT NOT NULL,seq INTEGER NOT NULL DEFAULT -1,mode TEXT NOT NULL,started INTEGER NOT NULL,position REAL NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS series_state(user_id INTEGER NOT NULL,title_id TEXT NOT NULL,cursor TEXT,hidden INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,title_id));
    CREATE TABLE IF NOT EXISTS queues(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,revision INTEGER NOT NULL,updated INTEGER NOT NULL,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tags(user_id INTEGER NOT NULL,title_id TEXT NOT NULL,tag TEXT NOT NULL,PRIMARY KEY(user_id,title_id,tag));
    CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,name TEXT NOT NULL,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS preferences(user_id INTEGER PRIMARY KEY,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,item_id TEXT NOT NULL,state TEXT NOT NULL,updated INTEGER NOT NULL,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS undo(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,expires INTEGER NOT NULL,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS migrations(name TEXT PRIMARY KEY,completed INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,json TEXT NOT NULL);`);
  db.exec(
    `CREATE TABLE IF NOT EXISTS season_downloads(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,title_id TEXT NOT NULL,season INTEGER NOT NULL,state TEXT NOT NULL,updated INTEGER NOT NULL,json TEXT NOT NULL);`,
  );
  const playbackColumns = new Set(
    db
      .prepare('PRAGMA table_info(playback)')
      .all()
      .map((c) => c.name),
  );
  if (!playbackColumns.has('touched'))
    db.exec('ALTER TABLE playback ADD COLUMN touched INTEGER NOT NULL DEFAULT 0');
  if (!playbackColumns.has('stopped'))
    db.exec('ALTER TABLE playback ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0');
  const retained = new Map();
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const unpack = (row) =>
    row
      ? {
          ...JSON.parse(row.json),
          ...Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'json')),
        }
      : null;
  const store = {
    db,
    one,
    all,
    run,
    unpack,
    evictingTitles: new Set(),
    isTitleInUse(titleId) {
      return (retained.get(titleId) || 0) > 0;
    },
    retainItem(itemId) {
      const titleId = store.item(itemId)?.title_id;
      if (store.evictingTitles.has(titleId))
        fail(503, 'This title is being removed to free storage');
      retained.set(titleId, (retained.get(titleId) || 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = retained.get(titleId) - 1;
        if (count) retained.set(titleId, count);
        else retained.delete(titleId);
      };
    },
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    title(key) {
      return unpack(one('SELECT * FROM titles WHERE id=?', key));
    },
    saveTitle(input) {
      if (!['movie', 'tv', 'anime'].includes(input.kind) || !input.external_id || !input.name)
        fail(400, 'Title identity is required');
      const alias = one(
        'SELECT title_id FROM aliases WHERE kind=? AND external_id=?',
        input.kind,
        String(input.external_id),
      );
      const old = alias
        ? store.title(alias.title_id)
        : unpack(
            one(
              'SELECT * FROM titles WHERE kind=? AND external_id=?',
              input.kind,
              String(input.external_id),
            ),
          );
      const next = {
        ...old,
        ...input,
        id: old?.id || input.id || id(),
        external_id: old?.external_id || String(input.external_id),
      };
      run(
        'INSERT INTO titles VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,json=excluded.json',
        next.id,
        next.kind,
        String(next.external_id),
        next.name,
        JSON.stringify(next),
      );
      run(
        'INSERT OR IGNORE INTO aliases VALUES(?,?,?)',
        input.kind,
        String(input.external_id),
        next.id,
      );
      return store.title(next.id);
    },
    item(key) {
      return unpack(one('SELECT * FROM items WHERE id=?', key));
    },
    saveItem(input) {
      const season = Number(input.season || 0),
        episode = Number(input.episode || 0);
      if (!store.title(input.title_id) || !finite(season) || !finite(episode))
        fail(400, 'Invalid episode');
      const old = unpack(
        one(
          'SELECT * FROM items WHERE title_id=? AND season=? AND episode=?',
          input.title_id,
          season,
          episode,
        ),
      );
      const next = { ...old, ...input, id: old?.id || input.id || id(), season, episode };
      run(
        'INSERT INTO items VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json',
        next.id,
        next.title_id,
        season,
        episode,
        JSON.stringify(next),
      );
      return store.item(next.id);
    },
    items(title) {
      return all('SELECT * FROM items WHERE title_id=? ORDER BY season,episode', title).map(unpack);
    },
    asset(key) {
      return unpack(one('SELECT * FROM assets WHERE id=?', key));
    },
    assets(item) {
      return all('SELECT * FROM assets WHERE item_id=? ORDER BY added_at', item).map(unpack);
    },
    canRead(user, asset) {
      return (
        !!user?.active &&
        (user.role === 'admin' || asset.readers == null || asset.readers.includes(user.id))
      );
    },
    available(user, item) {
      if (store.evictingTitles.has(store.item(item)?.title_id)) return undefined;
      return store.assets(item).find((a) => store.canRead(user, a) && existsSync(a.path));
    },
    canReadItem(user, item) {
      if (!store.item(item)) return false;
      const assets = store.assets(item);
      return !!user?.active && (!assets.length || assets.some((a) => store.canRead(user, a)));
    },
    addAsset(input) {
      const asset = { ...input, id: input.id || id(), added_at: input.added_at || Date.now() };
      run(
        'INSERT INTO assets VALUES(?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET json=excluded.json,bytes=excluded.bytes',
        asset.id,
        asset.item_id,
        asset.path,
        asset.bytes,
        asset.added_at,
        JSON.stringify(asset),
      );
      return unpack(one('SELECT * FROM assets WHERE path=?', asset.path));
    },
    state(user, item) {
      return (
        one('SELECT * FROM history WHERE user_id=? AND item_id=?', user, item) || {
          position: 0,
          duration: 0,
          completed: 0,
          ever_watched: 0,
          played_at: 0,
        }
      );
    },
    prefs(user) {
      return {
        autoplay: true,
        audioLanguage: '',
        subtitleLanguage: '',
        subtitleMode: 'off',
        ...(one('SELECT json FROM preferences WHERE user_id=?', user)
          ? JSON.parse(one('SELECT json FROM preferences WHERE user_id=?', user).json)
          : {}),
      };
    },
    job(key) {
      return unpack(one('SELECT * FROM jobs WHERE id=?', key));
    },
    saveJob(job) {
      const next = { ...job, updated: Date.now() };
      run(
        'INSERT INTO jobs VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated=excluded.updated,json=excluded.json',
        next.id,
        next.user_id,
        next.item_id,
        next.state,
        next.updated,
        JSON.stringify(next),
      );
      return next;
    },
    close() {
      db.close();
    },
  };
  return store;
}
