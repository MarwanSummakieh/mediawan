"""Per-user library state: history and resume, home rails, tags, collections, queues, prefs."""

import json
import random
import time

from .db import Database

COMPLETE_RATIO = 0.9  # 90% watched, or under three minutes left, counts as finished
COMPLETE_REMAINING = 180
RESUME_MIN = 30  # don't offer to resume the first half-minute

DEFAULT_PREFERENCES = {
    "audio_language": "",  # "" = the file's default track
    "subtitle_language": "",
    "subtitle_mode": "auto",  # off | auto (forced, or when audio isn't your language) | always
    "subtitle_size": "medium",
    "subtitle_color": "white",
    "subtitle_background": "translucent",
    "subtitle_position": "low",
    "autoplay_next": True,
    "max_height": 2160,
    "stereo": False,  # downmix surround to stereo when audio must be converted
}

# Subtitle look: the allowed values of each style preference (mirrored by SUB_STYLE in app.js).
SUBTITLE_STYLE = {
    "subtitle_size": ("small", "medium", "large", "xlarge"),
    "subtitle_color": ("white", "yellow", "cyan", "green"),
    "subtitle_background": ("none", "translucent", "solid"),
    "subtitle_position": ("low", "raised"),
}

# Columns shared by every title card. Hides titles whose files have all gone missing.
TITLE_COLUMNS = (
    "t.id, t.kind, t.name, t.year, t.poster, t.background, t.description, t.genres, "
    "t.imdb_id, t.added_at, t.rating"
)
AVAILABLE = (
    "EXISTS (SELECT 1 FROM items i JOIN files f ON f.item_id=i.id "
    "WHERE i.title_id=t.id AND f.missing=0)"
)


def card(row: dict) -> dict:
    row = dict(row)
    if isinstance(row.get("genres"), str):
        row["genres"] = json.loads(row["genres"])
    for key in ("poster", "background", "logo"):
        if row.get(key):
            row[key] = f"/api/art/{row['id']}/{key}"
    return row


# Cinemeta details stored in titles.extra, shown on title pages ("" or [] when unknown).
EXTRA_FIELDS = {
    "cast": [],
    "director": [],
    "writer": [],
    "country": "",
    "awards": "",
    "released": "",
    "status": "",
    "release_info": "",
}


def episode_label(item: dict) -> str:
    if not item.get("episode"):
        return ""
    return (
        f"S{item['season']:02d}E{item['episode']:02d}"
        if item["season"]
        else f"Special {item['episode']}"
    )


class Library:
    def __init__(self, db: Database):
        self.db = db

    # ---- browsing ------------------------------------------------------------------------

    def titles(
        self,
        user_id: int,
        kind: str | None = None,
        query: str = "",
        genre: str = "",
        sort: str = "name",
        limit: int = 200,
        offset: int = 0,
        tag: str = "",
    ) -> list[dict]:
        where, args = [AVAILABLE], []
        if kind in ("movie", "show"):
            where.append("t.kind=?")
            args.append(kind)
        if tag in ("favorite", "watchlist"):
            where.append(
                "EXISTS (SELECT 1 FROM tags g WHERE g.title_id=t.id AND g.user_id=? AND g.tag=?)"
            )
            args += [user_id, tag]
        if query:
            where.append("(t.name LIKE ? OR t.description LIKE ?)")
            args += [f"%{query}%", f"%{query}%"]
        if genre:
            where.append("t.genres LIKE ?")
            args.append(f'%"{genre}"%')
        order = {
            "name": "t.name COLLATE NOCASE",
            "year": "t.year DESC, t.name",
            "added": "t.added_at DESC",
            "rating": "CAST(t.rating AS REAL) DESC",
        }.get(sort, "t.name COLLATE NOCASE")
        rows = self.db.all(
            f"SELECT {TITLE_COLUMNS} FROM titles t WHERE {' AND '.join(where)} "
            f"ORDER BY {order} LIMIT ? OFFSET ?",
            *args,
            limit,
            offset,
        )
        return self._with_state(user_id, [card(r) for r in rows])

    def genres(self) -> list[str]:
        found = set()
        for row in self.db.all(f"SELECT genres FROM titles t WHERE {AVAILABLE}"):
            found.update(json.loads(row["genres"]))
        return sorted(found)

    def _with_state(self, user_id: int, cards: list[dict]) -> list[dict]:
        if not cards:
            return cards
        ids = [c["id"] for c in cards]
        marks = ",".join("?" * len(ids))
        tags = self.db.all(
            f"SELECT title_id, tag FROM tags WHERE user_id=? AND title_id IN ({marks})",
            user_id,
            *ids,
        )
        watched = {
            r["title_id"]: r
            for r in self.db.all(
                f"SELECT i.title_id, COUNT(DISTINCT i.id) total, "
                f"COUNT(DISTINCT CASE WHEN h.completed=1 THEN i.id END) seen "
                f"FROM items i JOIN files f ON f.item_id=i.id AND f.missing=0 "
                f"LEFT JOIN history h ON h.item_id=i.id AND h.user_id=? "
                f"WHERE i.title_id IN ({marks}) GROUP BY i.title_id",
                user_id,
                *ids,
            )
        }
        for c in cards:
            c["tags"] = [t["tag"] for t in tags if t["title_id"] == c["id"]]
            w = watched.get(c["id"])
            c["watched"] = bool(w and w["total"] and w["seen"] == w["total"])
            c["unwatched"] = (w["total"] - w["seen"]) if w else 0
        return cards

    def title(self, user_id: int, title_id: int) -> dict | None:
        row = self.db.one("SELECT * FROM titles WHERE id=?", title_id)
        if not row:
            return None
        out = card(row)
        out["locked_fields"] = json.loads(row["locked_fields"])
        extra = json.loads(out.pop("extra", None) or "{}")
        for key, empty in EXTRA_FIELDS.items():
            out[key] = extra.get(key) or empty
        out["related"] = self.related(user_id, row)
        items = self.db.all(
            "SELECT i.*, h.position, h.duration, h.completed, h.played_at FROM items i "
            "LEFT JOIN history h ON h.item_id=i.id AND h.user_id=? "
            "WHERE i.title_id=? ORDER BY i.season=0, i.season, i.episode",
            user_id,
            title_id,
        )
        files = self.db.all(
            "SELECT f.id, f.item_id, f.path, f.size, f.missing, f.probe FROM files f "
            "JOIN items i ON i.id=f.item_id WHERE i.title_id=? ORDER BY f.size DESC",
            title_id,
        )
        for item in items:
            item["label"] = episode_label(item)
            if item["thumbnail"]:
                item["thumbnail"] = f"/api/art/item/{item['id']}"
            item["completed"] = bool(item["completed"])
            item["files"] = [_file_summary(f) for f in files if f["item_id"] == item["id"]]
            item["available"] = any(not f["missing"] for f in item["files"])
        out["items"] = items
        out["seasons"] = sorted(
            {i["season"] for i in items if out["kind"] == "show"}, key=lambda s: (s == 0, s)
        )
        out["tags"] = [
            r["tag"]
            for r in self.db.all(
                "SELECT tag FROM tags WHERE user_id=? AND title_id=?", user_id, title_id
            )
        ]
        out["next"] = self.next_for_title(user_id, title_id)
        out["collections"] = [c["id"] for c in self.collections(user_id) if title_id in c["titles"]]
        return out

    def related(self, user_id: int, title: dict, limit: int = 12) -> list[dict]:
        """Titles of the same kind sharing the most genres, best rated first."""
        genres = set(json.loads(title["genres"] or "[]"))
        if not genres:
            return []
        rows = self.db.all(
            f"SELECT {TITLE_COLUMNS} FROM titles t WHERE t.kind=? AND t.id<>? AND {AVAILABLE}",
            title["kind"],
            title["id"],
        )
        scored = []
        for r in rows:
            shared = len(genres & set(json.loads(r["genres"] or "[]")))
            if shared:
                try:
                    rating = float(r["rating"] or 0)
                except ValueError:
                    rating = 0.0
                scored.append((shared, rating, r))
        scored.sort(key=lambda s: (-s[0], -s[1]))
        return self._with_state(user_id, [card(r) for _, _, r in scored[:limit]])

    def item(self, item_id: int) -> dict | None:
        row = self.db.one(
            "SELECT i.*, t.name title_name, t.kind, t.id title_id, t.poster, t.background "
            "FROM items i JOIN titles t ON t.id=i.title_id WHERE i.id=?",
            item_id,
        )
        if row:
            row["label"] = episode_label(row)
        return row

    # ---- history -------------------------------------------------------------------------

    def progress(self, user_id: int, item_id: int, position: float, duration: float) -> dict:
        if not self.db.one("SELECT id FROM items WHERE id=?", item_id):
            raise KeyError(item_id)
        position, duration = max(0.0, float(position)), max(0.0, float(duration))
        done = duration > 0 and (
            position >= duration * COMPLETE_RATIO
            or duration - position <= COMPLETE_REMAINING
            and duration > 600
        )
        self.db.run(
            "INSERT INTO history(user_id, item_id, position, duration, completed, played_at) "
            "VALUES(?,?,?,?,?,?) ON CONFLICT(user_id, item_id) DO UPDATE SET "
            "position=excluded.position, duration=excluded.duration, "
            "completed=MAX(history.completed, excluded.completed), played_at=excluded.played_at",
            user_id,
            item_id,
            0 if done else position,
            duration,
            int(done),
            int(time.time()),
        )
        return {"completed": done}

    def set_watched(self, user_id: int, item_ids: list[int], watched: bool):
        now = int(time.time())
        for item_id in item_ids:
            if watched:
                self.db.run(
                    "INSERT INTO history(user_id, item_id, position, duration, completed, played_at) "
                    "VALUES(?,?,0,0,1,?) ON CONFLICT(user_id, item_id) DO UPDATE SET "
                    "completed=1, position=0, played_at=excluded.played_at",
                    user_id,
                    item_id,
                    now,
                )
            else:
                self.db.run("DELETE FROM history WHERE user_id=? AND item_id=?", user_id, item_id)

    def resume_position(self, user_id: int, item_id: int) -> float:
        row = self.db.one(
            "SELECT position, completed FROM history WHERE user_id=? AND item_id=?",
            user_id,
            item_id,
        )
        if not row or row["completed"] or row["position"] < RESUME_MIN:
            return 0.0
        return row["position"]

    def next_item(self, item_id: int) -> dict | None:
        """The episode after this one, skipping episodes without a playable file."""
        item = self.db.one("SELECT * FROM items WHERE id=?", item_id)
        if not item or not item["episode"]:
            return None
        return self.db.one(
            "SELECT i.* FROM items i WHERE i.title_id=? AND i.season>0 "
            "AND (i.season>? OR (i.season=? AND i.episode>?)) "
            "AND EXISTS (SELECT 1 FROM files f WHERE f.item_id=i.id AND f.missing=0) "
            "ORDER BY i.season, i.episode LIMIT 1",
            item["title_id"],
            item["season"],
            item["season"],
            item["episode"],
        )

    def next_for_title(self, user_id: int, title_id: int) -> dict | None:
        """What the Play button on a title should play: resume, else the next unwatched."""
        rows = self.db.all(
            "SELECT i.id, i.season, i.episode, h.position, h.completed, h.played_at FROM items i "
            "LEFT JOIN history h ON h.item_id=i.id AND h.user_id=? WHERE i.title_id=? "
            "AND EXISTS (SELECT 1 FROM files f WHERE f.item_id=i.id AND f.missing=0) "
            "ORDER BY i.season=0, i.season, i.episode",
            user_id,
            title_id,
        )
        if not rows:
            return None
        started = [
            r
            for r in rows
            if r["played_at"] and not r["completed"] and (r["position"] or 0) >= RESUME_MIN
        ]
        if started:
            r = max(started, key=lambda r: r["played_at"])
            return {"item_id": r["id"], "position": r["position"], "resume": True}
        watched = [r for r in rows if r["completed"]]
        if watched:
            last = max(watched, key=lambda r: r["played_at"])
            following = self.next_item(last["id"])
            if following:
                return {"item_id": following["id"], "position": 0, "resume": False}
        unwatched = [r for r in rows if not r["completed"]]
        target = unwatched[0] if unwatched else rows[0]
        return {"item_id": target["id"], "position": 0, "resume": False}

    # ---- home rails ----------------------------------------------------------------------

    def continue_watching(self, user_id: int, limit: int = 20) -> list[dict]:
        rows = self.db.all(
            "SELECT h.item_id, h.position, h.duration, h.played_at, i.season, i.episode, "
            "i.name item_name, i.thumbnail, t.id, t.kind, t.name, t.year, t.poster, t.background "
            "FROM history h JOIN items i ON i.id=h.item_id JOIN titles t ON t.id=i.title_id "
            "WHERE h.user_id=? AND h.completed=0 AND h.position>=? "
            "AND EXISTS (SELECT 1 FROM files f WHERE f.item_id=i.id AND f.missing=0) "
            "ORDER BY h.played_at DESC LIMIT ?",
            user_id,
            RESUME_MIN,
            limit * 3,
        )
        seen, out = set(), []
        for r in rows:  # one entry per show
            if r["id"] in seen:
                continue
            seen.add(r["id"])
            out.append(self._entry(r))
        return out[:limit]

    def next_up(self, user_id: int, limit: int = 20) -> list[dict]:
        """For shows you are part-way through: the episode after the last one you finished."""
        latest = self.db.all(
            "SELECT i.title_id, MAX(h.played_at) played FROM history h "
            "JOIN items i ON i.id=h.item_id JOIN titles t ON t.id=i.title_id "
            "WHERE h.user_id=? AND t.kind='show' GROUP BY i.title_id ORDER BY played DESC LIMIT ?",
            user_id,
            limit * 2,
        )
        out = []
        for row in latest:
            last = self.db.one(
                "SELECT h.item_id, h.completed FROM history h JOIN items i ON i.id=h.item_id "
                "WHERE h.user_id=? AND i.title_id=? ORDER BY h.played_at DESC, i.season DESC, "
                "i.episode DESC LIMIT 1",
                user_id,
                row["title_id"],
            )
            if not last or not last["completed"]:
                continue  # it is in Continue Watching instead
            following = self.next_item(last["item_id"])
            if not following:
                continue
            done = self.db.one(
                "SELECT completed FROM history WHERE user_id=? AND item_id=?",
                user_id,
                following["id"],
            )
            if done and done["completed"]:
                continue
            r = self.db.one(
                "SELECT i.id item_id, i.season, i.episode, i.name item_name, i.thumbnail, "
                "t.id, t.kind, t.name, t.year, t.poster, t.background FROM items i "
                "JOIN titles t ON t.id=i.title_id WHERE i.id=?",
                following["id"],
            )
            out.append(self._entry({**r, "position": 0, "duration": 0}))
        return out[:limit]

    def _entry(self, r: dict) -> dict:
        entry = card({k: r[k] for k in ("id", "kind", "name", "year", "poster", "background")})
        entry.update(
            {
                "item_id": r["item_id"],
                "position": r.get("position") or 0,
                "duration": r.get("duration") or 0,
                "item_name": r.get("item_name"),
                "label": episode_label(r),
                "thumbnail": f"/api/art/item/{r['item_id']}" if r.get("thumbnail") else None,
            }
        )
        return entry

    def recently_added(self, user_id: int, kind: str, limit: int = 20) -> list[dict]:
        if kind == "movie":
            rows = self.db.all(
                f"SELECT {TITLE_COLUMNS} FROM titles t WHERE t.kind='movie' AND {AVAILABLE} "
                "ORDER BY t.added_at DESC LIMIT ?",
                limit,
            )
        else:  # shows ordered by their newest episode, so a new episode lifts its show
            rows = self.db.all(
                f"SELECT {TITLE_COLUMNS}, MAX(f.added_at) newest FROM titles t "
                "JOIN items i ON i.title_id=t.id JOIN files f ON f.item_id=i.id AND f.missing=0 "
                "WHERE t.kind='show' GROUP BY t.id ORDER BY newest DESC LIMIT ?",
                limit,
            )
        return self._with_state(user_id, [card(r) for r in rows])

    def tagged(self, user_id: int, tag: str) -> list[dict]:
        rows = self.db.all(
            f"SELECT {TITLE_COLUMNS} FROM tags g JOIN titles t ON t.id=g.title_id "
            f"WHERE g.user_id=? AND g.tag=? AND {AVAILABLE} ORDER BY t.name COLLATE NOCASE",
            user_id,
            tag,
        )
        return self._with_state(user_id, [card(r) for r in rows])

    def home(self, user_id: int) -> list[dict]:
        rails = [
            ("continue", "Continue Watching", self.continue_watching(user_id)),
            ("next", "Next Up", self.next_up(user_id)),
            ("movies", "Recently Added Movies", self.recently_added(user_id, "movie")),
            ("shows", "Recently Updated Shows", self.recently_added(user_id, "show")),
            ("watchlist", "Watchlist", self.tagged(user_id, "watchlist")),
            ("favorites", "Favorites", self.tagged(user_id, "favorite")),
        ]
        for c in self.collections(user_id):
            if c["titles"]:
                rails.append(
                    (f"collection-{c['id']}", c["name"], self.collection_titles(user_id, c))
                )
        return [{"id": rid, "name": name, "items": items} for rid, name, items in rails if items]

    # ---- tags ----------------------------------------------------------------------------

    def tag(self, user_id: int, title_id: int, tag: str, on: bool):
        if tag not in ("favorite", "watchlist"):
            raise ValueError("Tags are favorite or watchlist")
        if not self.db.one("SELECT id FROM titles WHERE id=?", title_id):
            raise KeyError(title_id)
        if on:
            self.db.run("INSERT OR IGNORE INTO tags VALUES(?,?,?)", user_id, title_id, tag)
        else:
            self.db.run(
                "DELETE FROM tags WHERE user_id=? AND title_id=? AND tag=?", user_id, title_id, tag
            )

    # ---- collections ---------------------------------------------------------------------

    def collections(self, user_id: int) -> list[dict]:
        rows = self.db.all(
            "SELECT * FROM collections WHERE user_id=? ORDER BY name COLLATE NOCASE", user_id
        )
        for r in rows:
            r["titles"] = json.loads(r["titles"])
        return rows

    def collection(self, user_id: int, collection_id: int) -> dict:
        row = self.db.one(
            "SELECT * FROM collections WHERE id=? AND user_id=?", collection_id, user_id
        )
        if not row:
            raise KeyError(collection_id)
        row["titles"] = json.loads(row["titles"])
        return row

    def collection_titles(self, user_id: int, collection: dict) -> list[dict]:
        ids = collection["titles"]
        if not ids:
            return []
        rows = {
            r["id"]: r
            for r in self.db.all(
                f"SELECT {TITLE_COLUMNS} FROM titles t WHERE t.id IN ({','.join('?' * len(ids))})",
                *ids,
            )
        }
        return self._with_state(user_id, [card(rows[i]) for i in ids if i in rows])

    def save_collection(
        self, user_id: int, name: str, titles: list[int], collection_id: int | None = None
    ) -> dict:
        name = (name or "").strip()
        if not name:
            raise ValueError("Give the collection a name")
        titles = list(dict.fromkeys(int(t) for t in titles))
        if collection_id:
            self.collection(user_id, collection_id)
            self.db.run(
                "UPDATE collections SET name=?, titles=? WHERE id=?",
                name,
                json.dumps(titles),
                collection_id,
            )
        else:
            collection_id = self.db.run(
                "INSERT INTO collections(user_id, name, titles) VALUES(?,?,?)",
                user_id,
                name,
                json.dumps(titles),
            )
        return self.collection(user_id, collection_id)

    def delete_collection(self, user_id: int, collection_id: int):
        self.db.run("DELETE FROM collections WHERE id=? AND user_id=?", collection_id, user_id)

    # ---- queues --------------------------------------------------------------------------

    def _items_for(self, title_ids: list[int], item_ids: list[int]) -> list[int]:
        out = list(item_ids)
        for title_id in title_ids:
            out += [
                r["id"]
                for r in self.db.all(
                    "SELECT i.id FROM items i WHERE i.title_id=? AND "
                    "EXISTS (SELECT 1 FROM files f WHERE f.item_id=i.id AND f.missing=0) "
                    "ORDER BY i.season=0, i.season, i.episode",
                    title_id,
                )
            ]
        return list(dict.fromkeys(out))

    def create_queue(
        self,
        user_id: int,
        name: str,
        mode: str,
        title_ids=(),
        item_ids=(),
        collection_id: int | None = None,
        start_item: int | None = None,
    ) -> dict:
        if mode not in ("sequential", "shuffle"):
            raise ValueError("Queues are sequential or shuffle")
        title_ids = list(title_ids)
        if collection_id:
            title_ids += self.collection(user_id, collection_id)["titles"]
        items = self._items_for(title_ids, list(item_ids))
        if not items:
            raise ValueError("Nothing playable to queue")
        if mode == "shuffle":
            random.shuffle(items)
        position = items.index(start_item) if start_item in items else 0
        queue_id = self.db.run(
            "INSERT INTO queues(user_id, name, mode, items, position, updated) VALUES(?,?,?,?,?,?)",
            user_id,
            name or "Queue",
            mode,
            json.dumps(items),
            position,
            int(time.time()),
        )
        # Keep only the ten most recent queues per person.
        self.db.run(
            "DELETE FROM queues WHERE user_id=? AND id NOT IN (SELECT id FROM queues "
            "WHERE user_id=? ORDER BY updated DESC, id DESC LIMIT 10)",
            user_id,
            user_id,
        )
        return self.queue(user_id, queue_id)

    def queue(self, user_id: int, queue_id: int) -> dict:
        row = self.db.one("SELECT * FROM queues WHERE id=? AND user_id=?", queue_id, user_id)
        if not row:
            raise KeyError(queue_id)
        row["items"] = json.loads(row["items"])
        row["current"] = (
            row["items"][row["position"]] if row["position"] < len(row["items"]) else None
        )
        details = {r["id"]: r for r in (self.item(i) for i in row["items"][:500]) if r}
        row["entries"] = [
            {
                "item_id": i,
                "title": details[i]["title_name"],
                "label": details[i]["label"],
                "name": details[i]["name"],
            }
            for i in row["items"][:500]
            if i in details
        ]
        return row

    def queues(self, user_id: int) -> list[dict]:
        rows = self.db.all(
            "SELECT id, name, mode, position, items, updated FROM queues "
            "WHERE user_id=? ORDER BY updated DESC",
            user_id,
        )
        for r in rows:
            r["length"] = len(json.loads(r.pop("items")))
        return rows

    def step_queue(
        self, user_id: int, queue_id: int, step: int = 1, to_item: int | None = None
    ) -> dict:
        q = self.queue(user_id, queue_id)
        if to_item is not None and to_item in q["items"]:
            position = q["items"].index(to_item)
        else:
            position = q["position"] + step
        position = max(0, min(position, len(q["items"])))  # len = finished
        self.db.run(
            "UPDATE queues SET position=?, updated=? WHERE id=?",
            position,
            int(time.time()),
            queue_id,
        )
        return self.queue(user_id, queue_id)

    def delete_queue(self, user_id: int, queue_id: int):
        self.db.run("DELETE FROM queues WHERE id=? AND user_id=?", queue_id, user_id)

    # ---- preferences ---------------------------------------------------------------------

    def preferences(self, user_id: int) -> dict:
        row = self.db.one("SELECT json FROM preferences WHERE user_id=?", user_id)
        stored = json.loads(row["json"]) if row else {}
        return {
            **DEFAULT_PREFERENCES,
            **{k: v for k, v in stored.items() if k in DEFAULT_PREFERENCES},
        }

    def save_preferences(self, user_id: int, changes: dict) -> dict:
        current = self.preferences(user_id)
        for key, value in changes.items():
            if key not in DEFAULT_PREFERENCES:
                continue
            default = DEFAULT_PREFERENCES[key]
            if isinstance(default, bool):
                value = bool(value)
            elif isinstance(default, int):
                value = int(value)
            else:
                value = str(value)[:20]
            if key == "subtitle_mode" and value not in ("off", "auto", "always"):
                raise ValueError("Subtitle mode is off, auto or always")
            if key in SUBTITLE_STYLE and value not in SUBTITLE_STYLE[key]:
                raise ValueError(f"{key.replace('_', ' ').capitalize()} is one of: {', '.join(SUBTITLE_STYLE[key])}")
            current[key] = value
        self.db.run(
            "INSERT OR REPLACE INTO preferences(user_id, json) VALUES(?,?)",
            user_id,
            json.dumps(current),
        )
        return current


def _file_summary(f: dict) -> dict:
    info = json.loads(f["probe"]) if f.get("probe") else None
    summary = {
        "id": f["id"],
        "name": f["path"].replace("\\", "/").rsplit("/", 1)[-1],
        "size": f["size"],
        "missing": bool(f["missing"]),
    }
    if info and not info.get("error") and info.get("video"):
        v = info["video"][0]
        summary.update(
            {
                "duration": info["duration"],
                "video": v["codec"],
                "height": v["height"],
                "hdr": v.get("hdr", False),
                "audio": [
                    {
                        "index": a["index"],
                        "codec": a["codec"],
                        "lang": a["lang"],
                        "channels": a["channels"],
                        "title": a["title"],
                    }
                    for a in info["audio"]
                ],
            }
        )
    return summary
