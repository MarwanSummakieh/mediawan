"""SQLite storage with numbered migrations instead of ad-hoc ALTER checks."""

import re
import sqlite3
import threading
from pathlib import Path

MIGRATIONS = [
    # 1: core schema
    """
    CREATE TABLE users(
      id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      pw_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE sessions(
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL);
    -- key is the scanner's identity for a title (kind + normalised folder name + year), so
    -- metadata may rename the display name without breaking rescans.
    -- matched: 0 = not tried, 1 = matched, -1 = searched without a match.
    -- locked_fields: fields an admin edited, which metadata refreshes never overwrite.
    -- numbering: 'absolute' for anime episodes numbered 1..N without seasons.
    CREATE TABLE titles(
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('movie','show')),
      key TEXT UNIQUE NOT NULL, name TEXT NOT NULL, year INTEGER, imdb_id TEXT,
      poster TEXT, background TEXT, logo TEXT, description TEXT,
      genres TEXT NOT NULL DEFAULT '[]', runtime TEXT, rating TEXT,
      numbering TEXT NOT NULL DEFAULT 'standard', added_at INTEGER NOT NULL,
      matched INTEGER NOT NULL DEFAULT 0, refreshed_at INTEGER,
      locked_fields TEXT NOT NULL DEFAULT '[]');
    CREATE INDEX titles_added ON titles(added_at DESC);
    CREATE TABLE items(
      id INTEGER PRIMARY KEY, title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
      season INTEGER NOT NULL DEFAULT 0, episode INTEGER NOT NULL DEFAULT 0, name TEXT,
      overview TEXT, thumbnail TEXT, aired TEXT, added_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(title_id, season, episode));
    CREATE TABLE files(
      id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      path TEXT UNIQUE NOT NULL, root TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL,
      mtime REAL NOT NULL, probe TEXT, added_at INTEGER NOT NULL,
      missing INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX files_item ON files(item_id);
    CREATE TABLE subtitles(
      id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      path TEXT UNIQUE NOT NULL, lang TEXT, forced INTEGER NOT NULL DEFAULT 0,
      format TEXT NOT NULL);
    -- Files the parser could not place; admins correct them from the review list.
    CREATE TABLE unmatched(
      id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, root TEXT NOT NULL,
      reason TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, seen_at INTEGER NOT NULL);
    -- Admin placements by path, honoured by every later scan.
    CREATE TABLE overrides(path TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE history(
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      position REAL NOT NULL DEFAULT 0, duration REAL NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0, played_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, item_id));
    CREATE INDEX history_recent ON history(user_id, played_at DESC);
    CREATE TABLE tags(
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
      tag TEXT NOT NULL CHECK(tag IN ('favorite','watchlist')),
      PRIMARY KEY(user_id, title_id, tag));
    CREATE TABLE queues(
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('sequential','shuffle')),
      items TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL);
    CREATE TABLE collections(
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, titles TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE preferences(
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, json TEXT NOT NULL);
    """,
    # 2: progress in online anime (AniList id + episode number; nothing on disk to point at).
    # name/poster/background/available are copied from AniList at play time so the home
    # rail renders without calling AniList.
    """
    CREATE TABLE online_history(
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      anilist_id INTEGER NOT NULL, episode INTEGER NOT NULL,
      lang TEXT NOT NULL DEFAULT 'sub', name TEXT NOT NULL DEFAULT '',
      poster TEXT, background TEXT, available INTEGER NOT NULL DEFAULT 0,
      position REAL NOT NULL DEFAULT 0, duration REAL NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0, played_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, anilist_id, episode));
    CREATE INDEX online_recent ON online_history(user_id, played_at DESC);
    """,
    # 3: progress in online movies and TV, by IMDb id (renamed watch_history in 6). A film is season 0,
    # episode 0. release is the version that was played, so resuming opens the same one;
    # next_* is the episode after this one (0 = none), so the home rail needs no lookup.
    """
    CREATE TABLE usenet_history(
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      imdb_id TEXT NOT NULL, season INTEGER NOT NULL DEFAULT 0,
      episode INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'movie',
      name TEXT NOT NULL DEFAULT '', poster TEXT, background TEXT, release TEXT,
      next_season INTEGER NOT NULL DEFAULT 0, next_episode INTEGER NOT NULL DEFAULT 0,
      position REAL NOT NULL DEFAULT 0, duration REAL NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0, played_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, imdb_id, season, episode));
    CREATE INDEX usenet_recent ON usenet_history(user_id, played_at DESC);
    """,
    # 4: more Cinemeta details for title pages (cast, director, writer, country, awards,
    # release date, status) as JSON. '{}' means not fetched yet; the next refresh fills it.
    """
    ALTER TABLE titles ADD COLUMN extra TEXT NOT NULL DEFAULT '{}';
    """,
    # 5: torrent streaming (torrent.py). Each history row says at what quality it played, so
    # resuming reopens the same. Season
    # locks keep a season on one release group or pack; rejects are releases that turned out
    # to be a different film with the same name, never offered again for that title.
    """
    ALTER TABLE usenet_history ADD COLUMN source TEXT NOT NULL DEFAULT 'usenet';
    ALTER TABLE usenet_history ADD COLUMN quality INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE torrent_locks(
      imdb_id TEXT NOT NULL, season INTEGER NOT NULL, quality INTEGER NOT NULL,
      json TEXT NOT NULL, updated INTEGER NOT NULL,
      PRIMARY KEY(imdb_id, season, quality));
    CREATE TABLE torrent_rejects(
      imdb_id TEXT NOT NULL, hash TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY(imdb_id, hash));
    """,
    # 6: torrents are the only online source. The history table takes the name of what it
    # holds; rows played from the old source keep their place and lose the release they
    # pointed at.
    """
    CREATE TABLE watch_history(
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      imdb_id TEXT NOT NULL, season INTEGER NOT NULL DEFAULT 0,
      episode INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'movie',
      name TEXT NOT NULL DEFAULT '', poster TEXT, background TEXT, release TEXT,
      next_season INTEGER NOT NULL DEFAULT 0, next_episode INTEGER NOT NULL DEFAULT 0,
      position REAL NOT NULL DEFAULT 0, duration REAL NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0, played_at INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'torrent', quality INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, imdb_id, season, episode));
    INSERT INTO watch_history(user_id, imdb_id, season, episode, kind, name, poster, background,
      release, next_season, next_episode, position, duration, completed, played_at, source, quality)
      SELECT user_id, imdb_id, season, episode, kind, name, poster, background,
        CASE WHEN source='torrent' THEN release END, next_season, next_episode, position,
        duration, completed, played_at, 'torrent', quality FROM usenet_history;
    DROP TABLE usenet_history;
    CREATE INDEX watch_recent ON watch_history(user_id, played_at DESC);
    """,
    # 7: the text-subtitle languages found in each torrent file read for streaming (a season
    # pack holds many files under one hash; file_index -1 = the largest video), so a file known
    # to lack the viewer's subtitles is tried last without opening it again.
    """
    CREATE TABLE torrent_subtitles(
      imdb_id TEXT NOT NULL, hash TEXT NOT NULL, file_index INTEGER NOT NULL,
      languages TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY(imdb_id, hash, file_index));
    """,
    # 8: season downloads (downloads.py): one row per episode, saved into the library's TV folder.
    """
    CREATE TABLE downloads(
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      imdb_id TEXT NOT NULL, show_name TEXT NOT NULL, year INTEGER,
      season INTEGER NOT NULL, episode INTEGER NOT NULL, episode_name TEXT NOT NULL DEFAULT '',
      quality INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'queued',
      release TEXT, warnings TEXT NOT NULL DEFAULT '[]', path TEXT, size INTEGER, error TEXT,
      created INTEGER NOT NULL, updated INTEGER NOT NULL,
      UNIQUE(imdb_id, season, episode));
    """,
    # 9: movie downloads share the downloads table (kind='movie', season=0, episode=0).
    """
    ALTER TABLE downloads ADD COLUMN kind TEXT NOT NULL DEFAULT 'show';
    """,
]


class Database:
    def __init__(self, path: Path | str):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA busy_timeout=5000")
        if str(path) != ":memory:":
            self.conn.execute("PRAGMA journal_mode=WAL")
        self._migrate()

    def _migrate(self):
        version = self.conn.execute("PRAGMA user_version").fetchone()[0]
        for number, sql in enumerate(MIGRATIONS[version:], start=version + 1):
            with self.transaction():
                # Comments may contain ";", so drop them before splitting into statements.
                for statement in filter(str.strip, re.sub(r"--[^\n]*", "", sql).split(";")):
                    self.conn.execute(statement)
                self.conn.execute(f"PRAGMA user_version={number}")

    def transaction(self):
        db = self

        class _Tx:
            def __enter__(self):
                db.lock.acquire()
                db.conn.execute("BEGIN IMMEDIATE")

            def __exit__(self, kind, *_):
                try:
                    db.conn.execute("ROLLBACK" if kind else "COMMIT")
                finally:
                    db.lock.release()

        return _Tx()

    def one(self, sql: str, *args) -> dict | None:
        with self.lock:
            row = self.conn.execute(sql, args).fetchone()
        return dict(row) if row else None

    def all(self, sql: str, *args) -> list[dict]:
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def run(self, sql: str, *args) -> int:
        with self.lock:
            cursor = self.conn.execute(sql, args)
            return cursor.lastrowid

    def close(self):
        self.conn.close()
