"""Walk the library folders and keep titles, items, files and subtitles in step with disk."""

import json
import logging
import os
import threading
import time
from pathlib import Path

from .db import Database
from .parse import (
    VIDEO_EXTENSIONS,
    Parsed,
    Unplaced,
    find_sidecars,
    parse_path,
    subtitle_info,
    title_key,
)

log = logging.getLogger("mediawan.scanner")

# NAS housekeeping folders (Synology/UGREEN thumbnails, recycle bins) are never media.
SKIP_DIRS = {"@eadir", "#recycle", "#snapshot", "$recycle.bin", "lost+found", ".trash", "@recycle"}


def within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


class Scanner:
    def __init__(self, db: Database, roots: list[Path], prober=None):
        self.db = db
        self.roots = [Path(r) for r in roots]
        self.prober = prober  # callable(path) -> dict, or None to skip probing
        self.lock = threading.Lock()
        self.last: dict | None = None
        self.running = False

    # ---- walking -------------------------------------------------------------------------

    def _walk(self, root: Path, stats: dict):
        """Yield (logical path, real path, sibling names, videos in folder).

        Symlinks are followed only while they stay inside the root, so a link to /etc or to
        another share can never expose files outside the library.
        """
        root_real = Path(os.path.realpath(root))
        visited = set()
        for dirpath, dirnames, filenames in os.walk(root, followlinks=True):
            real_dir = os.path.realpath(dirpath)
            if real_dir in visited:
                dirnames[:] = []
                continue
            visited.add(real_dir)
            keep = []
            for d in dirnames:
                if d.startswith(".") or d.lower() in SKIP_DIRS:
                    continue
                if not within(Path(os.path.realpath(os.path.join(dirpath, d))), root_real):
                    stats["refused"] += 1
                    log.warning("Refusing folder link outside the library: %s", d)
                    continue
                keep.append(d)
            dirnames[:] = sorted(keep)
            videos = [
                f
                for f in filenames
                if Path(f).suffix.lower() in VIDEO_EXTENSIONS and not f.startswith(".")
            ]
            for name in sorted(videos):
                logical = Path(dirpath) / name
                real = Path(os.path.realpath(logical))
                if not within(real, root_real):
                    stats["refused"] += 1
                    log.warning("Refusing file link outside the library: %s", logical)
                    continue
                yield logical, real, filenames, len(videos)

    # ---- scanning ------------------------------------------------------------------------

    def scan(self) -> dict:
        if not self.lock.acquire(blocking=False):
            return {"running": True}
        self.running = True
        try:
            return self._scan()
        finally:
            self.running = False
            self.lock.release()

    def _scan(self) -> dict:
        started = time.time()
        stats = {
            "roots": len(self.roots),
            "files": 0,
            "added": 0,
            "updated": 0,
            "missing": 0,
            "unmatched": 0,
            "refused": 0,
            "probed": 0,
            "errors": [],
        }
        overrides = {
            r["path"]: json.loads(r["json"])
            for r in self.db.all("SELECT path, json FROM overrides")
        }
        for root in self.roots:
            if not root.is_dir() or not any(root.iterdir()):
                # An unmounted share looks empty. Never mark a whole library missing for that.
                stats["errors"].append(f"Library folder unavailable or empty: {root}")
                continue
            seen: set[str] = set()
            for logical, real, siblings, count in self._walk(root, stats):
                stats["files"] += 1
                seen.add(str(real))
                try:
                    result = self._process(root, logical, real, siblings, count, overrides)
                    if result in stats:
                        stats[result] += 1
                except OSError as error:  # vanished mid-scan, permission denied…
                    stats["errors"].append(f"{logical}: {error}")
            stats["missing"] += self._mark_missing(root, seen)
        self._prune()
        stats["probed"] = self.probe_pending()
        stats["unmatched"] = self.db.one("SELECT COUNT(*) n FROM unmatched")["n"]
        stats["started"], stats["seconds"] = int(started), round(time.time() - started, 2)
        self.last = stats
        log.info("Scan finished: %s", {k: v for k, v in stats.items() if k != "errors"})
        return stats

    def _process(self, root: Path, logical: Path, real: Path, siblings, count, overrides) -> str:
        path = str(real)
        st = real.stat()
        existing = self.db.one("SELECT * FROM files WHERE path=?", path)
        override = overrides.get(path)
        unchanged = existing and existing["size"] == st.st_size and existing["mtime"] == st.st_mtime
        if unchanged and not override:
            if existing["missing"]:
                self.db.run("UPDATE files SET missing=0 WHERE id=?", existing["id"])
            self._sync_subtitles(existing["id"], root, logical, siblings, count)
            return "unchanged"

        if override:
            parsed = Parsed(
                override["kind"],
                override["name"],
                override.get("year"),
                int(override.get("season") or 0),
                int(override.get("episode") or 0),
                bool(override.get("absolute")),
            )
        else:
            parsed = parse_path(logical, root)
        if parsed is None:
            return "skipped"
        if isinstance(parsed, Unplaced):
            if existing:  # keep an earlier placement rather than dropping a playable file
                return "unchanged"
            self.db.run(
                "INSERT INTO unmatched(path, root, reason, size, seen_at) VALUES(?,?,?,?,?) "
                "ON CONFLICT(path) DO UPDATE SET reason=excluded.reason, size=excluded.size, "
                "seen_at=excluded.seen_at",
                path,
                str(root),
                parsed.reason,
                st.st_size,
                int(time.time()),
            )
            return "unmatched_seen"

        now = int(time.time())
        with self.db.transaction():
            item_id = self._ensure_item(parsed, now)
            if existing:
                changed = not unchanged
                self.db.conn.execute(
                    "UPDATE files SET item_id=?, root=?, size=?, mtime=?, missing=0"
                    + (", probe=NULL" if changed else "")
                    + " WHERE id=?",
                    (item_id, str(root), st.st_size, st.st_mtime, existing["id"]),
                )
                file_id = existing["id"]
            else:
                file_id = self.db.conn.execute(
                    "INSERT INTO files(item_id, path, root, size, mtime, added_at) "
                    "VALUES(?,?,?,?,?,?)",
                    (item_id, path, str(root), st.st_size, st.st_mtime, now),
                ).lastrowid
            self.db.conn.execute("DELETE FROM unmatched WHERE path=?", (path,))
        self._sync_subtitles(file_id, root, logical, siblings, count)
        return "updated" if existing else "added"

    def _ensure_item(self, parsed: Parsed, now: int) -> int:
        """Inside a transaction: find or create the title and item for a parsed file."""
        conn = self.db.conn
        key = title_key(parsed.kind, parsed.name, parsed.year)
        row = conn.execute("SELECT id, numbering FROM titles WHERE key=?", (key,)).fetchone()
        if row:
            title_id = row["id"]
            if parsed.absolute and row["numbering"] != "absolute":
                conn.execute("UPDATE titles SET numbering='absolute' WHERE id=?", (title_id,))
        else:
            title_id = conn.execute(
                "INSERT INTO titles(kind, key, name, year, numbering, added_at) "
                "VALUES(?,?,?,?,?,?)",
                (
                    parsed.kind,
                    key,
                    parsed.name,
                    parsed.year,
                    "absolute" if parsed.absolute else "standard",
                    now,
                ),
            ).lastrowid
        season = parsed.season if parsed.kind == "show" else 0
        episode = parsed.episode if parsed.kind == "show" else 0
        item = conn.execute(
            "SELECT id FROM items WHERE title_id=? AND season=? AND episode=?",
            (title_id, season, episode),
        ).fetchone()
        if item:
            return item["id"]
        return conn.execute(
            "INSERT INTO items(title_id, season, episode, added_at) VALUES(?,?,?,?)",
            (title_id, season, episode, now),
        ).lastrowid

    def _sync_subtitles(self, file_id: int, root: Path, logical: Path, siblings, count):
        found = {}
        root_real = Path(os.path.realpath(root))
        for sub in find_sidecars(logical, siblings, count):
            info = subtitle_info(sub, logical)
            sub_real = Path(os.path.realpath(sub))
            if info and within(sub_real, root_real):
                found[str(sub_real)] = info
        current = {
            r["path"]: r["id"]
            for r in self.db.all("SELECT id, path FROM subtitles WHERE file_id=?", file_id)
        }
        for path, sub_id in current.items():
            if path not in found:
                self.db.run("DELETE FROM subtitles WHERE id=?", sub_id)
        for path, info in found.items():
            if path not in current:
                self.db.run(
                    "INSERT OR REPLACE INTO subtitles(file_id, path, lang, forced, format) "
                    "VALUES(?,?,?,?,?)",
                    file_id,
                    path,
                    info["lang"],
                    info["forced"],
                    info["format"],
                )

    def _mark_missing(self, root: Path, seen: set[str]) -> int:
        gone = 0
        for row in self.db.all("SELECT id, path, missing FROM files WHERE root=?", str(root)):
            if row["path"] not in seen and not row["missing"]:
                self.db.run("UPDATE files SET missing=1 WHERE id=?", row["id"])
                gone += 1
        for row in self.db.all("SELECT id, path FROM unmatched WHERE root=?", str(root)):
            if row["path"] not in seen:
                self.db.run("DELETE FROM unmatched WHERE id=?", row["id"])
        return gone

    def _prune(self):
        """Drop items and titles left with no files at all after a re-placement."""
        self.db.run("DELETE FROM items WHERE id NOT IN (SELECT item_id FROM files)")
        self.db.run("DELETE FROM titles WHERE id NOT IN (SELECT title_id FROM items)")

    def probe_pending(self, limit: int = 100000) -> int:
        if not self.prober:
            return 0
        done = 0
        for row in self.db.all(
            "SELECT id, path FROM files WHERE probe IS NULL AND missing=0 LIMIT ?", limit
        ):
            try:
                info = self.prober(row["path"])
            except Exception as error:  # noqa: BLE001 - a corrupt file must not stop the scan
                log.warning("Probe failed for %s: %s", row["path"], error)
                info = {"error": str(error)}
            self.db.run("UPDATE files SET probe=? WHERE id=?", json.dumps(info), row["id"])
            done += 1
        return done

    # ---- admin corrections ---------------------------------------------------------------

    def assign(self, path: str, placement: dict) -> dict:
        """Place a file by hand. The override is kept, so later scans agree with the admin."""
        kind = placement.get("kind")
        name = (placement.get("name") or "").strip()
        if kind not in ("movie", "show") or not name:
            raise ValueError("Choose movie or show and give a name")
        clean = {
            "kind": kind,
            "name": name,
            "year": _int(placement.get("year")),
            "season": _int(placement.get("season")) or 0,
            "episode": _int(placement.get("episode")) or 0,
        }
        if kind == "show" and not clean["episode"]:
            raise ValueError("Episodes need an episode number")
        real = Path(path)
        root = next((r for r in self.roots if within(real, Path(os.path.realpath(r)))), None)
        if root is None or not real.is_file():
            raise ValueError("That file is not inside a library folder")
        self.db.run(
            "INSERT OR REPLACE INTO overrides(path, json) VALUES(?,?)", path, json.dumps(clean)
        )
        siblings = os.listdir(real.parent)
        count = sum(Path(f).suffix.lower() in VIDEO_EXTENSIONS for f in siblings)
        self._process(root, real, real, siblings, count, {path: clean})
        self._prune()
        self.probe_pending()
        file = self.db.one("SELECT id, item_id FROM files WHERE path=?", path)
        return file or {}


def _int(value) -> int | None:
    try:
        return int(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None
