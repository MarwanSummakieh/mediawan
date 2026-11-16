"""Online movies and TV: Cinemeta for search and details, and each viewer's progress.

The streams themselves come over BitTorrent (torrent.py). This module knows a title by its IMDb
id, what its episodes are, and where each viewer stopped.
"""

import re
import time
from datetime import date

import httpx

from .db import Database
from .library import COMPLETE_RATIO, COMPLETE_REMAINING
from .metadata import Metadata, _year, extra_fields
from .online import OnlineError, _Cache


class Catalog:
    def __init__(self, db: Database, metadata: Metadata):
        self.db, self.metadata = db, metadata
        self.cache = _Cache()

    # ---- Cinemeta ------------------------------------------------------------------------

    def search(self, q: str) -> list[dict]:
        q = q.strip()
        hit = self.cache.get(("search", q))
        if hit is not None:
            return hit
        try:
            found = [
                {"kind": kind, "id": m["imdb_id"], **m}
                for kind in ("movie", "show")
                for m in self.metadata.search(kind, q)[:20]
            ]
        except httpx.HTTPError as error:
            raise OnlineError(f"Cinemeta is unreachable: {error}") from error
        return self.cache.put(("search", q), found, 600)

    def title(self, kind: str, imdb_id: str) -> dict:
        if kind not in ("movie", "show") or not re.fullmatch(r"tt\d+", imdb_id):
            raise OnlineError("No such title", 404)
        hit = self.cache.get(("title", kind, imdb_id))
        if hit is not None:
            return hit
        try:
            meta = self.metadata.fetch(kind, imdb_id)
        except httpx.HTTPError as error:
            raise OnlineError(f"Cinemeta is unreachable: {error}") from error
        if not meta or not meta.get("name"):
            raise OnlineError("Cinemeta has no such title", 404)
        today = date.today().isoformat()
        episodes = sorted(
            (
                {
                    "season": int(v.get("season") or 0),
                    "episode": int(v.get("episode") or v.get("number") or 0),
                    "name": v.get("name") or v.get("title") or "",
                    "overview": v.get("overview") or v.get("description") or "",
                    "thumbnail": v.get("thumbnail"),
                    "aired": (v.get("released") or "")[:10],
                }
                for v in (meta.get("videos") or [] if kind == "show" else [])
                if int(v.get("season") or 0) > 0 and "" < (v.get("released") or "")[:10] <= today
            ),
            key=lambda e: (e["season"], e["episode"]),
        )
        found = {
            "kind": kind,
            "id": imdb_id,
            "name": meta["name"],
            "year": _year(meta),
            "poster": meta.get("poster"),
            "background": meta.get("background"),
            "description": meta.get("description") or "",
            "genres": meta.get("genres") or meta.get("genre") or [],
            "runtime": meta.get("runtime"),
            "rating": str(meta.get("imdbRating") or ""),
            "episodes": episodes,
            **extra_fields(meta),
        }
        return self.cache.put(("title", kind, imdb_id), found, 3 * 3600)

    # ---- per-user progress ---------------------------------------------------------------

    def progress(self, user_id: int, body: dict) -> dict:
        position = max(0.0, float(body.get("position") or 0))
        duration = max(0.0, float(body.get("duration") or 0))
        done = duration > 0 and (
            position >= duration * COMPLETE_RATIO
            or duration - position <= COMPLETE_REMAINING
            and duration > 600
        )
        # `quality` is what played, so resuming reopens the same.
        self.db.run(
            "INSERT INTO watch_history(user_id, imdb_id, season, episode, kind, name, poster, "
            "background, release, next_season, next_episode, position, duration, completed, "
            "played_at, source, quality) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(user_id, imdb_id, season, episode) DO UPDATE SET "
            "name=excluded.name, poster=excluded.poster, background=excluded.background, "
            "release=excluded.release, next_season=excluded.next_season, "
            "next_episode=excluded.next_episode, position=excluded.position, "
            "duration=excluded.duration, "
            "completed=MAX(watch_history.completed, excluded.completed), "
            "played_at=excluded.played_at, source=excluded.source, quality=excluded.quality",
            user_id,
            str(body["id"]),
            int(body.get("season") or 0),
            int(body.get("episode") or 0),
            "show" if body.get("kind") == "show" else "movie",
            str(body.get("name") or "")[:200],
            body.get("poster"),
            body.get("background"),
            body.get("release"),
            int(body.get("next_season") or 0),
            int(body.get("next_episode") or 0),
            0 if done else position,
            duration,
            int(done),
            int(time.time()),
            "torrent",
            int(body.get("quality") or 0),
        )
        return {"completed": done}

    def watched(self, user_id: int, imdb_id: str) -> dict[tuple[int, int], dict]:
        rows = self.db.all(
            "SELECT * FROM watch_history WHERE user_id=? AND imdb_id=?", user_id, imdb_id
        )
        return {(r["season"], r["episode"]): r for r in rows}

    @staticmethod
    def next_up(title: dict, watched: dict) -> dict:
        """What Play should start: the last thing touched, or the episode after it."""
        episodes = [(e["season"], e["episode"]) for e in title["episodes"]] or [(0, 0)]
        at, position = episodes[0], 0.0
        if watched:
            last = max(watched.values(), key=lambda r: r["played_at"])
            pair = (last["season"], last["episode"])
            if not last["completed"]:
                at, position = pair, last["position"]
            elif pair in episodes and pair != episodes[-1]:
                at = episodes[episodes.index(pair) + 1]
        return {"season": at[0], "episode": at[1], "position": position}

    def continue_watching(self, user_id: int, limit: int = 20) -> list[dict]:
        """One card per title: what is in progress, or the next episode of a show."""
        rows = self.db.all(
            "SELECT * FROM watch_history WHERE user_id=? ORDER BY played_at DESC LIMIT ?",
            user_id,
            limit * 5,
        )
        cards, seen = [], set()
        for r in rows:
            if r["imdb_id"] in seen:
                continue
            seen.add(r["imdb_id"])
            card = {k: r[k] for k in ("kind", "name", "poster", "background", "quality")}
            card.update(id=r["imdb_id"], season=r["season"], episode=r["episode"])
            card.update(position=r["position"], duration=r["duration"])
            if r["completed"]:
                if not r["next_episode"]:
                    continue  # a finished film, or a show that is caught up
                card.update(season=r["next_season"], episode=r["next_episode"])
                card.update(position=0.0, duration=0.0)
            cards.append(card)
        return cards[:limit]
