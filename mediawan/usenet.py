"""Online movies and TV: Cinemeta for search and details, Usenet for the streams.

Releases are found on Newznab indexers by IMDb id. The chosen NZB goes to a streaming sidecar
(NzbDAV, one of its forks, or altmount) through the SABnzbd API they all share. The sidecar
serves the file over WebDAV without downloading it first, and FFmpeg reads it from there
through the same copy-first pipeline as library files.
"""

import hashlib
import json
import logging
import re
import time
from datetime import date
from posixpath import basename
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit
from xml.etree import ElementTree

import httpx

from . import media
from .db import Database
from .library import COMPLETE_RATIO, COMPLETE_REMAINING
from .metadata import Metadata, _year, extra_fields
from .online import Online, OnlineError, _Cache
from .parse import VIDEO_EXTENSIONS

log = logging.getLogger("mediawan.usenet")

HEIGHTS = {"2160p": 2160, "1080p": 1080, "720p": 720, "SD": 480}
_RESOLUTION = [
    ("2160p", r"2160p|\b4k\b|\buhd\b"),
    ("1080p", r"1080[pi]"),
    ("720p", r"720p"),
]
_SOURCE = [  # best first; WEBRip is tested before the bare "WEB" of WEB-DL
    ("Remux", r"remux"),
    ("BluRay", r"blu-?ray|bdrip|brrip"),
    ("WEBRip", r"web-?rip"),
    ("WEB-DL", r"web-?dl|\bweb\b"),
    ("HDTV", r"hdtv"),
]
_SOURCE_RANK = {"Remux": 5, "BluRay": 4, "WEB-DL": 3, "WEBRip": 2, "HDTV": 1, "": 0}
_JUNK = re.compile(r"\b(cam|hdcam|ts|telesync|telecine|sample|trailer|3d)\b", re.IGNORECASE)
MIN_SIZE = 300 * 1024 * 1024


def _why(error: Exception) -> str:
    """An upstream failure without its URL, which carries an API key."""
    if isinstance(error, httpx.HTTPStatusError):
        return f"HTTP {error.response.status_code}"
    return str(error) if isinstance(error, OnlineError) else type(error).__name__


def describe(name: str) -> dict:
    """What a release name says about the file inside."""

    def first(table):
        return next(
            (label for label, pattern in table if re.search(pattern, name, re.IGNORECASE)), ""
        )

    resolution = first(_RESOLUTION) or "SD"
    if re.search(r"\bav1\b", name, re.IGNORECASE):
        codec = "av1"
    elif re.search(r"[xh]\.?265|hevc", name, re.IGNORECASE) or resolution == "2160p":
        codec = "hevc"
    else:
        codec = "h264"
    tags = []
    if re.search(r"\b(dv|dovi)\b|dolby.?vision", name, re.IGNORECASE):
        tags.append("DV")
    if re.search(r"hdr", name, re.IGNORECASE):
        tags.append("HDR")
    if re.search(r"atmos", name, re.IGNORECASE):
        tags.append("Atmos")
    return {"resolution": resolution, "source": first(_SOURCE), "codec": codec, "tags": tags}


def parse_newznab(text: str) -> list[dict]:
    root = ElementTree.fromstring(text)
    if root.tag == "error":
        raise OnlineError(f"The indexer refused: {root.get('description') or root.get('code')}")
    out = []
    for item in root.iter("item"):
        attrs = {a.get("name"): a.get("value") for a in item if a.tag.endswith("}attr")}
        enclosure = item.find("enclosure")
        url = enclosure.get("url") if enclosure is not None else item.findtext("link")
        size = attrs.get("size") or (enclosure.get("length") if enclosure is not None else 0)
        name = (item.findtext("title") or "").strip()
        if not url or not name or attrs.get("password") not in (None, "0"):
            continue
        out.append({"name": name, "url": url, "size": int(size or 0)})
    return out


def rank(releases: list[dict]) -> list[dict]:
    """Best picture first: resolution, then source, then size."""
    seen, out = set(), []
    for r in releases:
        if r["name"] in seen or r["size"] < MIN_SIZE or _JUNK.search(r["name"]):
            continue
        seen.add(r["name"])
        out.append({**r, **describe(r["name"])})
    out.sort(
        key=lambda r: (HEIGHTS[r["resolution"]], _SOURCE_RANK[r["source"]], r["size"]),
        reverse=True,
    )
    return out


class Usenet:
    def __init__(
        self,
        db: Database,
        metadata: Metadata,
        signer: Online,
        ffprobe: str,
        indexers: list[tuple[str, str]],
        dav_url: str = "",
        dav_api_key: str = "",
        dav_user: str = "",
        dav_password: str = "",
        category: str = "movies",
        client: httpx.Client | None = None,
    ):
        self.db, self.metadata, self.signer, self.ffprobe = db, metadata, signer, ffprobe
        self.indexers = indexers
        self.dav = dav_url.rstrip("/")
        self.api_key, self.user, self.password = dav_api_key, dav_user, dav_password
        self.category = category
        self.client = client or httpx.Client(timeout=30, follow_redirects=True)
        self.cache = _Cache()

    @property
    def ready(self) -> bool:
        return bool(self.indexers and self.dav)

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

    # ---- Newznab -------------------------------------------------------------------------

    def _need(self):
        if not self.ready:
            raise OnlineError(
                "Online movies need a Usenet indexer and a streaming sidecar "
                "(NEWZNAB_INDEXERS and USENET_DAV_URL)",
                409,
            )

    def _query(self, params: dict) -> list[dict]:
        found, failure = [], None
        for base, key in self.indexers:
            try:
                response = self.client.get(
                    f"{base.rstrip('/')}/api",
                    params={**params, "apikey": key, "extended": 1, "limit": 100},
                )
                response.raise_for_status()
                found += parse_newznab(response.text)
            except (httpx.HTTPError, ElementTree.ParseError, OnlineError) as error:
                failure = _why(error)
                log.warning("Indexer %s failed: %s", urlsplit(base).netloc, failure)
        if not found and failure:
            raise OnlineError(f"The Usenet indexers did not answer: {failure}")
        return found

    def releases(self, title: dict, season: int = 0, episode: int = 0) -> list[dict]:
        """Every version of a film or episode, best first. `id` is what play() takes."""
        self._need()
        key = ("releases", title["id"], season, episode)
        hit = self.cache.get(key)
        if hit is not None:
            return hit
        digits = title["id"][2:]
        if title["kind"] == "movie":
            found = self._query({"t": "movie", "imdbid": digits})
        else:
            episode_of = {"season": season, "ep": episode}
            found = self._query({"t": "tvsearch", "imdbid": digits, **episode_of})
            if not found:  # not every indexer knows shows by IMDb id
                found = self._query({"t": "tvsearch", "q": title["name"], **episode_of})
        ranked = rank(found)
        for r in ranked:
            r["id"] = self.signer.sign(json.dumps({"u": r.pop("url"), "n": r["name"]}))
        return self.cache.put(key, ranked, 15 * 60)

    # ---- the sidecar: SABnzbd API in, WebDAV out -----------------------------------------

    def _sab(self, mode: str, files=None, **params) -> dict:
        try:
            response = self.client.request(
                "POST" if files else "GET",
                f"{self.dav}/api",
                params={"mode": mode, "apikey": self.api_key, "output": "json", **params},
                files=files,
            )
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise OnlineError(f"The Usenet sidecar did not answer: {_why(error)}") from None

    def _slot(self, **match) -> dict | None:
        slots = (self._sab("history", limit=200).get("history") or {}).get("slots") or []
        return next((s for s in slots if all(s.get(k) == v for k, v in match.items())), None)

    def _list(self, folder: str, depth: int = 3) -> list[tuple[str, int]]:
        """(url, size) of every file under a WebDAV folder."""
        try:
            response = self.client.request(
                "PROPFIND", folder, headers={"Depth": "1"}, auth=(self.user, self.password)
            )
        except httpx.HTTPError as error:
            raise OnlineError(f"The Usenet sidecar did not answer: {_why(error)}") from None
        if response.status_code != 207:
            return []
        files = []
        for entry in ElementTree.fromstring(response.text).iter("{DAV:}response"):
            url = urljoin(folder, entry.findtext("{DAV:}href") or "")
            if url.rstrip("/") == folder.rstrip("/"):
                continue
            if entry.find(".//{DAV:}collection") is not None:
                if depth > 1:
                    files += self._list(url, depth - 1)
            else:
                files.append((url, int(entry.findtext(".//{DAV:}getcontentlength") or 0)))
        return files

    def _video(self, slot: dict) -> str:
        folder = "/".join(
            quote(part)
            for part in ("content", slot["category"], basename(slot["storage"]) or slot["name"])
        )
        videos = [
            f
            for f in self._list(f"{self.dav}/{folder}/")
            if unquote(urlsplit(f[0]).path).lower().endswith(tuple(VIDEO_EXTENSIONS))
        ]
        if not videos:
            raise OnlineError("That release has no video file in it")
        return max(videos, key=lambda f: f[1])[0]

    def mount(self, release_id: str) -> dict:
        """Hand a release to the sidecar. Returns {"url", "info"}: its video file and probe."""
        self._need()
        hit = self.cache.get(("mount", release_id))
        if hit is not None:
            return hit
        release = json.loads(self.signer.unsign(release_id))
        name = re.sub(r'[\\/:*?"<>|]', " ", release["n"]).strip()
        slot = self._slot(name=name, status="Completed")
        if not slot:
            try:
                nzb = self.client.get(release["u"])
                nzb.raise_for_status()
            except httpx.HTTPError as error:
                raise OnlineError(f"The indexer did not hand over the NZB: {_why(error)}") from None
            if b"<nzb" not in nzb.content[:2000]:
                raise OnlineError("The indexer did not hand over an NZB (download limit?)")
            added = self._sab(
                "addfile",
                files={"name": (f"{name}.nzb", nzb.content, "application/x-nzb")},
                cat=self.category,
                nzbname=name,
            )
            ids = added.get("nzo_ids") or []
            if not ids:
                raise OnlineError("The Usenet sidecar would not take that release")
            deadline = time.time() + 90
            while True:
                slot = self._slot(nzo_id=ids[0])
                if slot and slot.get("status") == "Completed":
                    break
                if slot and slot.get("status") == "Failed":
                    raise OnlineError(
                        f"That release is incomplete on Usenet: {slot.get('fail_message') or ''}"
                    )
                if time.time() > deadline:
                    raise OnlineError("The Usenet sidecar took too long to open that release")
                time.sleep(1)
        url = self._video(slot)
        try:
            info = media.probe(self.ffprobe, self.authed(url))
        except (RuntimeError, OSError, ValueError) as error:
            raise OnlineError(
                f"FFprobe could not read that release: {media.no_logins(str(error))}"
            ) from None
        return self.cache.put(("mount", release_id), {"url": url, "info": info}, 6 * 3600)

    def open(self, title: dict, season: int, episode: int, release_id: str | None, caps) -> dict:
        """Mount the asked-for release, or else the best one this device plays as it is."""
        if release_id:
            name = json.loads(self.signer.unsign(release_id))["n"]
            return {"id": release_id, "name": name, **self.mount(release_id)}
        found = self.releases(title, season, episode)
        if not found:
            raise OnlineError("No release of this was found on Usenet", 404)
        found = sorted(  # stable, so the quality order holds inside each group
            found,
            key=lambda r: (
                r["codec"] not in caps.video or HEIGHTS[r["resolution"]] > caps.max_height
            ),
        )
        failure = None
        for r in found[:3]:
            try:
                return {"id": r["id"], "name": r["name"], **self.mount(r["id"])}
            except OnlineError as error:
                failure = error
        raise failure

    def authed(self, url: str) -> str:
        """The address FFmpeg reads, with the WebDAV login in it. Never sent to a client."""
        if not self.user:
            return url
        parts = urlsplit(url)
        login = f"{quote(self.user, safe='')}:{quote(self.password, safe='')}"
        return urlunsplit(parts._replace(netloc=f"{login}@{parts.netloc}"))

    def file(self, url: str) -> dict:
        """A stand-in for a library file row, for the session and subtitle code."""
        if not self.dav or not url.startswith(self.dav + "/"):
            raise OnlineError("Bad stream link", 404)
        return {
            "id": "u" + hashlib.sha1(url.encode()).hexdigest()[:16],
            "path": self.authed(url),
            "mtime": 0,
        }

    # ---- per-user progress ---------------------------------------------------------------

    def progress(self, user_id: int, body: dict) -> dict:
        position = max(0.0, float(body.get("position") or 0))
        duration = max(0.0, float(body.get("duration") or 0))
        done = duration > 0 and (
            position >= duration * COMPLETE_RATIO
            or duration - position <= COMPLETE_REMAINING
            and duration > 600
        )
        # Shared by both online sources (Usenet and torrents): `source` and `quality` say what
        # played, so resuming reopens the same.
        self.db.run(
            "INSERT INTO usenet_history(user_id, imdb_id, season, episode, kind, name, poster, "
            "background, release, next_season, next_episode, position, duration, completed, "
            "played_at, source, quality) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(user_id, imdb_id, season, episode) DO UPDATE SET "
            "name=excluded.name, poster=excluded.poster, background=excluded.background, "
            "release=excluded.release, next_season=excluded.next_season, "
            "next_episode=excluded.next_episode, position=excluded.position, "
            "duration=excluded.duration, "
            "completed=MAX(usenet_history.completed, excluded.completed), "
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
            "torrent" if body.get("source") == "torrent" else "usenet",
            int(body.get("quality") or 0),
        )
        return {"completed": done}

    def watched(self, user_id: int, imdb_id: str) -> dict[tuple[int, int], dict]:
        rows = self.db.all(
            "SELECT * FROM usenet_history WHERE user_id=? AND imdb_id=?", user_id, imdb_id
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
            "SELECT * FROM usenet_history WHERE user_id=? ORDER BY played_at DESC LIMIT ?",
            user_id,
            limit * 5,
        )
        cards, seen = [], set()
        for r in rows:
            if r["imdb_id"] in seen:
                continue
            seen.add(r["imdb_id"])
            card = {k: r[k] for k in ("kind", "name", "poster", "background", "source", "quality")}
            card.update(id=r["imdb_id"], season=r["season"], episode=r["episode"])
            card.update(position=r["position"], duration=r["duration"])
            if r["completed"]:
                if not r["next_episode"]:
                    continue  # a finished film, or a show that is caught up
                card.update(season=r["next_season"], episode=r["next_episode"])
                card.update(position=0.0, duration=0.0)
            cards.append(card)
        return cards[:limit]
