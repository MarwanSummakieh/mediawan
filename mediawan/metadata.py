"""Posters, descriptions and IMDb IDs from Cinemeta, which needs no API key.

Admin edits are recorded in titles.locked_fields and never overwritten by a refresh.
With METADATA_ONLINE=false nothing is fetched and titles keep their parsed names.
"""

import hashlib
import json
import logging
import re
import time
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import quote

import httpx

from .db import Database
from .parse import normalise

log = logging.getLogger("mediawan.metadata")

EDITABLE = (
    "name",
    "year",
    "description",
    "poster",
    "background",
    "logo",
    "genres",
    "imdb_id",
    "runtime",
    "rating",
)
STALE_MATCHED = 30 * 86400  # re-read matched titles monthly, for new episode names
STALE_MISSED = 7 * 86400  # retry titles Cinemeta did not know a week later


def _year(meta: dict) -> int | None:
    for value in (meta.get("year"), meta.get("releaseInfo"), meta.get("released")):
        match = re.search(r"(19|20)\d\d", str(value or ""))
        if match:
            return int(match.group(0))
    return None


def extra_fields(meta: dict) -> dict:
    """The details title pages show beyond the basics: people, country, awards, dates."""

    def names(value) -> list[str]:
        if isinstance(value, str):
            value = [v.strip() for v in value.split(",")]
        return [str(v) for v in (value or []) if v][:12]

    found = {
        "cast": names(meta.get("cast")),
        "director": names(meta.get("director")),
        "writer": names(meta.get("writer")),
        "country": str(meta.get("country") or ""),
        "awards": str(meta.get("awards") or ""),
        "released": str(meta.get("released") or "")[:10],
        "status": str(meta.get("status") or ""),
        "release_info": str(meta.get("releaseInfo") or ""),
    }
    return {k: v for k, v in found.items() if v}


def score(name: str, year: int | None, candidate: dict) -> float:
    """How well a search result fits: name similarity, nudged by the year."""
    a, b = normalise(name), normalise(candidate.get("name", ""))
    if not a or not b:
        return 0.0
    similarity = 1.0 if a == b else SequenceMatcher(None, a, b).ratio()
    found = _year(candidate)
    if year and found:
        similarity += 0.15 if abs(found - year) <= 1 else -0.3
    return similarity


class Metadata:
    def __init__(
        self,
        db: Database,
        base: str,
        online: bool,
        art_dir: Path,
        client: httpx.Client | None = None,
    ):
        self.db = db
        self.base = base.rstrip("/")
        self.online = online
        self.art_dir = Path(art_dir)
        self.client = client or httpx.Client(
            timeout=10, follow_redirects=True, headers={"User-Agent": "mediawan/3"}
        )

    # ---- Cinemeta ------------------------------------------------------------------------

    def _get(self, path: str) -> dict:
        response = self.client.get(f"{self.base}/{path}")
        response.raise_for_status()
        return response.json()

    def search(self, kind: str, query: str) -> list[dict]:
        if not self.online or not query.strip():
            return []
        kind = "series" if kind == "show" else "movie"
        data = self._get(f"catalog/{kind}/top/search={quote(query.strip())}.json")
        return [
            {
                "imdb_id": m.get("imdb_id") or m.get("id"),
                "name": m.get("name"),
                "year": _year(m),
                "poster": m.get("poster"),
            }
            for m in data.get("metas", [])
            if str(m.get("id", "")).startswith("tt")
        ]

    def fetch(self, kind: str, imdb_id: str) -> dict | None:
        data = self._get(f"meta/{'series' if kind == 'show' else 'movie'}/{imdb_id}.json")
        return data.get("meta") or None

    def find(self, title: dict) -> dict | None:
        """Best search result for a title, or None when nothing is a confident match."""
        kind = "series" if title["kind"] == "show" else "movie"
        query = title["name"]
        data = self._get(f"catalog/{kind}/top/search={quote(query)}.json")
        best, best_score = None, 0.0
        for candidate in data.get("metas", [])[:10]:
            if not str(candidate.get("id", "")).startswith("tt"):
                continue
            value = score(query, title["year"], candidate)
            if value > best_score:
                best, best_score = candidate, value
        return best if best_score >= 0.85 else None

    # ---- refresh -------------------------------------------------------------------------

    def refresh(self, title_id: int, force: bool = False) -> dict:
        title = self.db.one("SELECT * FROM titles WHERE id=?", title_id)
        if not title:
            raise KeyError(title_id)
        if not self.online:
            return title
        locked = set(json.loads(title["locked_fields"]))
        now = int(time.time())
        imdb_id = title["imdb_id"]
        if not imdb_id or (force and "imdb_id" not in locked):
            found = self.find(title)
            if not found:
                self.db.run(
                    "UPDATE titles SET matched=-1, refreshed_at=? WHERE id=?", now, title_id
                )
                return self.db.one("SELECT * FROM titles WHERE id=?", title_id)
            imdb_id = found["id"]
        meta = self.fetch(title["kind"], imdb_id)
        if not meta:
            self.db.run("UPDATE titles SET matched=-1, refreshed_at=? WHERE id=?", now, title_id)
            return self.db.one("SELECT * FROM titles WHERE id=?", title_id)
        values = {
            "imdb_id": imdb_id,
            "name": meta.get("name") or title["name"],
            "year": _year(meta) or title["year"],
            "description": meta.get("description"),
            "poster": meta.get("poster"),
            "background": meta.get("background"),
            "logo": meta.get("logo"),
            "genres": json.dumps(meta.get("genres") or meta.get("genre") or []),
            "runtime": meta.get("runtime"),
            "rating": str(meta.get("imdbRating") or "") or None,
        }
        values = {k: v for k, v in values.items() if k not in locked}
        # Never empty once fetched ("v" marks it), so refresh_pending can tell it apart.
        values["extra"] = json.dumps({"v": 1, **extra_fields(meta)})
        sets = ", ".join(f"{k}=?" for k in values)
        self.db.run(
            f"UPDATE titles SET {sets}, matched=1, refreshed_at=? WHERE id=?",
            *values.values(),
            now,
            title_id,
        )
        if title["kind"] == "show":
            self._episodes(title, meta.get("videos") or [])
        return self.db.one("SELECT * FROM titles WHERE id=?", title_id)

    def _episodes(self, title: dict, videos: list[dict]):
        def number(v):
            return int(v.get("episode") or v.get("number") or 0)

        by_pair = {(int(v.get("season") or 0), number(v)): v for v in videos}
        # Absolute anime numbering: episode N is the Nth regular (non-special) episode.
        ordered = sorted(
            (v for v in videos if int(v.get("season") or 0) > 0),
            key=lambda v: (int(v["season"]), number(v)),
        )
        for item in self.db.all("SELECT * FROM items WHERE title_id=?", title["id"]):
            if title["numbering"] == "absolute" and item["season"] == 1:
                index = item["episode"] - 1
                video = ordered[index] if 0 <= index < len(ordered) else None
            else:
                video = by_pair.get((item["season"], item["episode"]))
            if not video:
                continue
            self.db.run(
                "UPDATE items SET name=?, overview=?, thumbnail=?, aired=? WHERE id=?",
                video.get("name") or video.get("title"),
                video.get("overview") or video.get("description"),
                video.get("thumbnail"),
                (video.get("released") or "")[:10] or None,
                item["id"],
            )

    def refresh_pending(self, limit: int = 200) -> int:
        if not self.online:
            return 0
        now = int(time.time())
        rows = self.db.all(
            "SELECT id FROM titles WHERE matched=0 "
            "OR (matched=-1 AND COALESCE(refreshed_at,0) < ?) "
            "OR (matched=1 AND COALESCE(refreshed_at,0) < ?) "
            "OR (matched=1 AND extra='{}') "  # matched before cast and crew were stored
            "ORDER BY matched=0 DESC, added_at DESC LIMIT ?",
            now - STALE_MISSED,
            now - STALE_MATCHED,
            limit,
        )
        done = 0
        for row in rows:
            try:
                self.refresh(row["id"])
                done += 1
            except (httpx.HTTPError, ValueError) as error:
                log.warning("Metadata refresh failed for title %s: %s", row["id"], error)
                break  # Cinemeta is down or unreachable: try again on the next run
        return done

    # ---- admin edits ---------------------------------------------------------------------

    def edit(self, title_id: int, changes: dict) -> dict:
        """Apply admin changes and lock those fields. A new imdb_id re-reads the rest."""
        title = self.db.one("SELECT * FROM titles WHERE id=?", title_id)
        if not title:
            raise KeyError(title_id)
        changes = {k: v for k, v in changes.items() if k in EDITABLE}
        if "genres" in changes:
            genres = changes["genres"]
            if isinstance(genres, str):
                genres = [g.strip() for g in genres.split(",") if g.strip()]
            changes["genres"] = json.dumps(genres)
        if "year" in changes:
            changes["year"] = int(changes["year"]) if changes["year"] not in (None, "") else None
        if (
            "imdb_id" in changes
            and changes["imdb_id"]
            and not re.fullmatch(r"tt\d{5,10}", changes["imdb_id"])
        ):
            raise ValueError("IMDb IDs look like tt0113277")
        locked = set(json.loads(title["locked_fields"])) | set(changes)
        if changes:
            sets = ", ".join(f"{k}=?" for k in changes)
            self.db.run(
                f"UPDATE titles SET {sets}, locked_fields=? WHERE id=?",
                *changes.values(),
                json.dumps(sorted(locked)),
                title_id,
            )
        if changes.get("imdb_id") and self.online:
            try:
                self.refresh(title_id)
            except httpx.HTTPError as error:
                log.warning("Could not read %s from Cinemeta: %s", changes["imdb_id"], error)
        return self.db.one("SELECT * FROM titles WHERE id=?", title_id)

    def unlock(self, title_id: int, fields: list[str]) -> dict:
        title = self.db.one("SELECT * FROM titles WHERE id=?", title_id)
        if not title:
            raise KeyError(title_id)
        locked = set(json.loads(title["locked_fields"])) - set(fields)
        self.db.run(
            "UPDATE titles SET locked_fields=? WHERE id=?", json.dumps(sorted(locked)), title_id
        )
        return self.db.one("SELECT * FROM titles WHERE id=?", title_id)

    # ---- artwork cache -------------------------------------------------------------------

    def artwork(self, url: str | None) -> Path | None:
        """A local copy of a poster or backdrop, so TVs never hotlink and offline still works."""
        if not url or not url.startswith(("http://", "https://")):
            return None
        target = self.art_dir / (hashlib.sha1(url.encode()).hexdigest() + ".img")
        if target.exists():
            return target
        if not self.online:
            return None
        try:
            response = self.client.get(url)
            response.raise_for_status()
        except httpx.HTTPError:
            return None
        if not response.headers.get("content-type", "").startswith("image/"):
            return None
        self.art_dir.mkdir(parents=True, exist_ok=True)
        partial = target.with_suffix(".part")
        partial.write_bytes(response.content)
        partial.replace(target)
        return target
