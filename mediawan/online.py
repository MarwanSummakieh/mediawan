"""Online anime: AniList for search and details, MegaPlay for the streams.

MegaPlay hosts the old HiAnime library and looks episodes up by AniList or MyAnimeList id.
Its CDN only answers requests that carry `Referer: https://megaplay.buzz/`, which a browser
cannot set, so playlists, segments and subtitles are fetched by Mediawan and passed through
untouched (never re-encoded). Every proxied address is signed with a server key, so the proxy
can only fetch URLs this module produced.
"""

import base64
import hashlib
import hmac
import html
import logging
import re
import secrets
import threading
import time
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx

from .db import Database
from .library import COMPLETE_RATIO, COMPLETE_REMAINING
from .parse import LANGUAGES, normalise

log = logging.getLogger("mediawan.online")

ANILIST = "https://graphql.anilist.co"
MEGAPLAY = "https://megaplay.buzz"
CDN_HEADERS = {
    "Referer": f"{MEGAPLAY}/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36",
}
LANGS = ("sub", "dub")

# Subtitle files are named like track_0_CR_English_eng.vtt; the last part is ISO 639-2.
ISO3 = {
    "eng": "en", "jpn": "ja", "spa": "es", "por": "pt", "fre": "fr", "fra": "fr",
    "ger": "de", "deu": "de", "ita": "it", "ara": "ar", "rus": "ru", "chi": "zh",
    "zho": "zh", "kor": "ko", "ind": "id", "tha": "th", "vie": "vi", "tur": "tr",
    "pol": "pl", "hin": "hi", "may": "ms", "msa": "ms", "dan": "da", "swe": "sv",
    "nor": "no", "nob": "no", "fin": "fi", "dut": "nl", "nld": "nl", "gre": "el",
    "ell": "el", "heb": "he",
}  # fmt: skip

MEDIA_FIELDS = """
  id idMal format status episodes seasonYear averageScore genres duration
  title { romaji english }
  coverImage { extraLarge large }
  bannerImage
  nextAiringEpisode { episode }
"""


class OnlineError(Exception):
    """A lookup failed upstream. `status` is the HTTP status to answer with."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


class _Cache:
    def __init__(self, size: int = 500):
        self.size, self.items, self.lock = size, {}, threading.Lock()

    def get(self, key):
        with self.lock:
            hit = self.items.get(key)
            if hit and hit[0] > time.time():
                return hit[1]
            return None

    def put(self, key, value, ttl: float):
        with self.lock:
            if len(self.items) >= self.size:  # drop the entries closest to expiry
                for old in sorted(self.items, key=lambda k: self.items[k][0])[: self.size // 5]:
                    del self.items[old]
            self.items[key] = (time.time() + ttl, value)
        return value


def _clean(text: str | None) -> str:
    text = re.sub(r"<br\s*/?>", "\n", text or "")
    text = re.sub(r"<[^>]+>", "", text)
    return re.sub(r"\n{3,}", "\n\n", html.unescape(text)).strip()


def available_episodes(media: dict) -> int:
    """Episodes out so far: an airing show stops before its next broadcast."""
    upcoming = (media.get("nextAiringEpisode") or {}).get("episode")
    if upcoming:
        return max(0, upcoming - 1)
    if media.get("status") == "NOT_YET_RELEASED":
        return 0
    return media.get("episodes") or 0


def _key(name: str) -> str:
    """A title for comparing: lower-case words without punctuation."""
    return normalise(name or "")


def card(media: dict) -> dict:
    title = media.get("title") or {}
    cover = media.get("coverImage") or {}
    return {
        "id": media["id"],
        "mal_id": media.get("idMal"),
        "name": title.get("english") or title.get("romaji") or f"AniList {media['id']}",
        "titles": [t for t in (title.get("english"), title.get("romaji")) if t],
        "year": media.get("seasonYear"),
        "format": media.get("format"),
        "status": media.get("status"),
        "poster": cover.get("extraLarge") or cover.get("large"),
        "background": media.get("bannerImage"),
        "score": media.get("averageScore"),
        "genres": media.get("genres") or [],
        "available": available_episodes(media),
        "total": media.get("episodes"),
        "minutes": media.get("duration"),
    }


def episode_names(streaming: list[dict]) -> dict[int, dict]:
    """AniList lists Crunchyroll episodes as "Episode 3 - Name", not always in order."""
    out = {}
    for e in streaming or []:
        match = re.match(r"\s*Episode\s+(\d+)\s*[-–:]\s*(.*)", e.get("title") or "")
        if match:
            out[int(match.group(1))] = {
                "name": match.group(2).strip(),
                "thumbnail": e.get("thumbnail"),
            }
    return out


def subtitle_tracks(tracks: list[dict]) -> list[dict]:
    out = []
    for i, t in enumerate(tracks or []):
        if t.get("kind") not in (None, "captions", "subtitles") or not t.get("file"):
            continue
        name = urlsplit(t["file"]).path.rsplit("/", 1)[-1]
        code = re.search(r"_([a-z]{3})\.vtt$", name)
        label = t.get("label") or name
        lang = ISO3.get(code.group(1)) if code else None
        if not lang:  # labels like "Danish (Danish - [Full])" or "Portuguese (CR …)"
            first = re.match(r"\s*([A-Za-z]+)", label)
            lang = LANGUAGES.get(first.group(1).lower()) if first else None
        out.append(
            {
                "label": label,
                "lang": lang,
                "url": t["file"],
                "default": bool(t.get("default")),
                "n": i,
            }
        )
    return out


def stream_paths(sources: dict) -> list[tuple[str, str]]:
    """(host, /anime/<hash>/<hash>) pairs for this episode's master playlist, best first.

    The `image` URL carries the hashes of the stream that was asked for. Since November 2026
    MegaPlay encrypts the stream address and sends no image, so the hashes then come from the
    first subtitle or thumbnail track, which sits in the same folder as the playlist.
    """
    pattern = re.compile(r"^/anime/[0-9a-f]{32}/[0-9a-f]{32}")
    image = urlsplit(sources.get("image") or "")
    found = pattern.match(image.path)
    hosts = [image.netloc] if found else []
    for t in sources.get("tracks") or []:
        track = urlsplit(t.get("file") or "")
        found = found or pattern.match(track.path)
        if track.netloc and track.netloc not in hosts:
            hosts.append(track.netloc)
    return [(h, found.group(0)) for h in hosts] if found else []


class Online:
    def __init__(
        self,
        db: Database,
        key_file: Path,
        client: httpx.Client | None = None,
        async_client: httpx.AsyncClient | None = None,
        enabled: bool = True,
    ):
        self.db = db
        self.enabled = enabled
        self.client = client or httpx.Client(timeout=15, follow_redirects=True)
        self.aclient = async_client or httpx.AsyncClient(
            timeout=httpx.Timeout(20, connect=10), follow_redirects=True
        )
        self.cache = _Cache()
        self.key = self._load_key(Path(key_file))

    @staticmethod
    def _load_key(path: Path) -> bytes:
        """Kept on disk so links in a playing stream survive a restart."""
        try:
            key = path.read_bytes()
            if len(key) >= 32:
                return key
        except OSError:
            pass
        key = secrets.token_bytes(32)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(key)
        return key

    def _need(self):
        if not self.enabled:
            raise OnlineError("Online anime is turned off (ONLINE_ANIME=false)", 409)

    # ---- AniList -------------------------------------------------------------------------

    def _graphql(self, query: str, variables: dict, ttl: float) -> dict:
        key = (query, tuple(sorted(variables.items())))
        hit = self.cache.get(key)
        if hit is not None:
            return hit
        try:
            response = self.client.post(
                ANILIST, json={"query": query, "variables": variables}, timeout=15
            )
        except httpx.HTTPError as error:
            raise OnlineError(f"AniList is unreachable: {error}") from error
        if response.status_code == 429:
            raise OnlineError("AniList is rate limiting us; try again in a minute", 503)
        if response.status_code == 404:
            raise OnlineError("AniList has no such anime", 404)
        if response.status_code >= 400:
            raise OnlineError(f"AniList answered {response.status_code}")
        data = response.json().get("data") or {}
        return self.cache.put(key, data, ttl)

    def search(self, q: str, limit: int = 30) -> list[dict]:
        self._need()
        q = q.strip()
        if not q:
            return []
        query = (
            "query($q:String,$n:Int){Page(perPage:$n){media(search:$q,type:ANIME,"
            "isAdult:false,sort:[SEARCH_MATCH,POPULARITY_DESC]){" + MEDIA_FIELDS + "}}}"
        )
        data = self._graphql(query, {"q": q, "n": min(limit, 50)}, 600)
        media = (data.get("Page") or {}).get("media") or []
        return [card(m) for m in media]

    def match(self, name: str, year, kind: str) -> int | None:
        """The AniList id of a Cinemeta film or series that is anime, so it plays through the
        anime flow (MegaPlay) instead of torrents. The name must match AniList's English or
        romaji title, the year must agree within one, and the format must fit (a film is a
        MOVIE, a series anything else), so a live-action remake from another year is left
        alone. A series that AniList splits into seasons maps to its first season."""
        if not self.enabled or not name:
            return None
        try:
            found = self.search(name, 15)
        except (OnlineError, httpx.HTTPError):
            return None
        want, year = _key(name), int(year) if str(year or "").isdigit() else None
        hits = [
            a
            for a in found
            if want in {_key(t) for t in a["titles"]}
            and (a["format"] == "MOVIE") == (kind == "movie")
            and (year is None or a["year"] is None or abs(a["year"] - year) <= 1)
        ]
        hits.sort(key=lambda a: (a["year"] or 9999, a["id"]))
        return hits[0]["id"] if hits else None

    def anime(self, anilist_id: int) -> dict:
        self._need()
        query = (
            "query($id:Int){Media(id:$id,type:ANIME){" + MEDIA_FIELDS + " description(asHtml:false)"
            " streamingEpisodes { title thumbnail } season title { native }"
            " studios(isMain:true) { nodes { name } }"
            " characters(sort:[ROLE,RELEVANCE],perPage:12) { edges { role node { name { full }"
            " image { medium } } } } }}"
        )
        media = self._graphql(query, {"id": int(anilist_id)}, 3 * 3600).get("Media")
        if not media:
            raise OnlineError("AniList has no such anime", 404)
        names = episode_names(media.get("streamingEpisodes"))
        result = card(media)
        result["description"] = _clean(media.get("description"))
        result["native"] = (media.get("title") or {}).get("native") or ""
        result["season"] = (media.get("season") or "").title()
        result["studios"] = [
            n["name"] for n in ((media.get("studios") or {}).get("nodes") or []) if n.get("name")
        ]
        result["characters"] = [
            {
                "name": ((e.get("node") or {}).get("name") or {}).get("full") or "",
                "role": (e.get("role") or "").title(),
                "image": ((e.get("node") or {}).get("image") or {}).get("medium"),
            }
            for e in ((media.get("characters") or {}).get("edges") or [])
            if (e.get("node") or {}).get("name")
        ]
        result["episodes"] = [
            {"number": n, **names.get(n, {"name": "", "thumbnail": None})}
            for n in range(1, result["available"] + 1)
        ]
        return result

    # ---- MegaPlay ------------------------------------------------------------------------

    def _embed_id(self, path: str) -> str | None:
        try:
            response = self.client.get(f"{MEGAPLAY}/{path}", headers=CDN_HEADERS)
        except httpx.HTTPError as error:
            raise OnlineError(f"MegaPlay is unreachable: {error}") from error
        match = (
            re.search(r'data-id="(\d+)"', response.text) if response.status_code == 200 else None
        )
        return match.group(1) if match else None

    def resolve(self, anilist_id: int, mal_id: int | None, episode: int, lang: str) -> dict:
        """Find an episode on MegaPlay: master playlist URL, subtitles, intro and outro."""
        self._need()
        if lang not in LANGS:
            raise ValueError("lang is sub or dub")
        key = ("resolve", anilist_id, episode, lang)
        hit = self.cache.get(key)
        if hit is not None:
            return hit
        paths = [f"stream/ani/{anilist_id}/{episode}/{lang}"]
        if mal_id:  # MegaPlay's AniList mapping has gaps the MAL one fills (Dandadan)
            paths.append(f"stream/mal/{mal_id}/{episode}/{lang}")
        embed = next((e for e in map(self._embed_id, paths) if e), None)
        if not embed:
            raise OnlineError(
                f"MegaPlay has no {'dubbed' if lang == 'dub' else 'subtitled'} episode {episode}",
                404,
            )
        try:
            response = self.client.get(
                f"{MEGAPLAY}/stream/getSources",
                params={"id": embed},
                headers={**CDN_HEADERS, "X-Requested-With": "XMLHttpRequest"},
            )
            sources = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise OnlineError(f"MegaPlay did not return sources: {error}") from error
        master = None
        for host, path in stream_paths(sources):
            url = f"https://{host}{path}/master.m3u8"
            try:
                check = self.client.get(url, headers=CDN_HEADERS)
            except httpx.HTTPError:
                continue
            if check.status_code == 200 and check.text.startswith("#EXTM3U"):
                master = url
                break
        if not master:
            raise OnlineError("MegaPlay's video servers did not answer for this episode")

        def window(value):
            if isinstance(value, dict) and (value.get("end") or 0) > (value.get("start") or 0):
                return {"start": float(value["start"]), "end": float(value["end"])}
            return None

        found = {
            "master": master,
            "subtitles": subtitle_tracks(sources.get("tracks")),
            "intro": window(sources.get("intro")),
            "outro": window(sources.get("outro")),
        }
        return self.cache.put(key, found, 20 * 60)

    # ---- signed proxy --------------------------------------------------------------------

    def sign(self, url: str) -> str:
        raw = url.encode()
        mac = hmac.new(self.key, raw, hashlib.sha256).digest()[:12]
        b64 = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")
        return f"{b64(raw)}.{b64(mac)}"

    def unsign(self, token: str) -> str:
        try:
            body, mac = token.split(".", 1)
            pad = lambda s: s + "=" * (-len(s) % 4)
            raw = base64.urlsafe_b64decode(pad(body))
            given = base64.urlsafe_b64decode(pad(mac))
        except (ValueError, TypeError) as error:
            raise OnlineError("Bad stream link", 404) from error
        if not hmac.compare_digest(given, hmac.new(self.key, raw, hashlib.sha256).digest()[:12]):
            raise OnlineError("Bad stream link", 404)
        return raw.decode()

    def link(self, url: str) -> str:
        kind = "hls" if urlsplit(url).path.endswith(".m3u8") else "seg"
        return f"/api/online/{kind}/{self.sign(url)}"

    def rewrite(self, playlist: str, base: str) -> str:
        """Point every playlist entry, and every URI="…" attribute, back through Mediawan."""
        out = []
        for line in playlist.splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                out.append(self.link(urljoin(base, stripped)))
            elif 'URI="' in line:
                out.append(
                    re.sub(
                        r'URI="([^"]+)"',
                        lambda m: f'URI="{self.link(urljoin(base, m.group(1)))}"',
                        line,
                    )
                )
            else:
                out.append(line)
        return "\n".join(out) + "\n"

    async def playlist(self, token: str) -> str:
        url = self.unsign(token)
        try:
            response = await self.aclient.get(url, headers=CDN_HEADERS)
        except httpx.HTTPError as error:
            raise OnlineError(f"The video server did not answer: {error}") from error
        if response.status_code != 200 or not response.text.startswith("#EXTM3U"):
            raise OnlineError(f"The video server answered {response.status_code}")
        return self.rewrite(response.text, url)

    async def open(self, token: str) -> tuple[httpx.Response, str]:
        """Start streaming a segment or subtitle file; the caller iterates and closes it."""
        url = self.unsign(token)
        request = self.aclient.build_request("GET", url, headers=CDN_HEADERS)
        try:
            response = await self.aclient.send(request, stream=True)
        except httpx.HTTPError as error:
            raise OnlineError(f"The video server did not answer: {error}") from error
        if response.status_code != 200:
            await response.aclose()
            raise OnlineError(f"The video server answered {response.status_code}")
        path = urlsplit(url).path.lower()
        kind = (
            "text/vtt; charset=utf-8"
            if path.endswith(".vtt")
            else "video/mp4"
            if path.endswith((".mp4", ".m4s"))
            else "video/mp2t"  # MegaPlay serves MPEG-TS under .jpg/.html/.js names
        )
        return response, kind

    # ---- per-user progress ---------------------------------------------------------------

    def progress(self, user_id: int, body: dict) -> dict:
        anilist_id, episode = int(body["anilist_id"]), int(body["episode"])
        position = max(0.0, float(body.get("position") or 0))
        duration = max(0.0, float(body.get("duration") or 0))
        done = duration > 0 and (
            position >= duration * COMPLETE_RATIO
            or duration - position <= COMPLETE_REMAINING
            and duration > 600
        )
        self.db.run(
            "INSERT INTO online_history(user_id, anilist_id, episode, lang, name, poster, "
            "background, available, position, duration, completed, played_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id, anilist_id, episode) DO UPDATE SET "
            "lang=excluded.lang, name=excluded.name, poster=excluded.poster, "
            "background=excluded.background, available=excluded.available, "
            "position=excluded.position, duration=excluded.duration, "
            "completed=MAX(online_history.completed, excluded.completed), played_at=excluded.played_at",
            user_id,
            anilist_id,
            episode,
            body.get("lang") if body.get("lang") in LANGS else "sub",
            str(body.get("name") or "")[:200],
            body.get("poster"),
            body.get("background"),
            int(body.get("available") or 0),
            0 if done else position,
            duration,
            int(done),
            int(time.time()),
        )
        return {"completed": done}

    def watched(self, user_id: int, anilist_id: int) -> dict[int, dict]:
        rows = self.db.all(
            "SELECT episode, lang, position, duration, completed, played_at FROM online_history "
            "WHERE user_id=? AND anilist_id=?",
            user_id,
            anilist_id,
        )
        return {r["episode"]: r for r in rows}

    @staticmethod
    def next_episode(watched: dict[int, dict], available: int) -> dict | None:
        """What Play should start: the last episode touched, or the one after it if finished."""
        if not watched:
            return {"episode": 1, "position": 0.0} if available else None
        last = max(watched.values(), key=lambda r: (r["played_at"], r["episode"]))
        if not last["completed"]:
            return {"episode": last["episode"], "position": last["position"]}
        if last["episode"] < available:
            return {"episode": last["episode"] + 1, "position": 0.0}
        return {"episode": 1, "position": 0.0}

    def continue_watching(self, user_id: int, limit: int = 20) -> list[dict]:
        """One card per anime: the episode in progress, or the next one once it is out."""
        rows = self.db.all(
            "SELECT * FROM online_history h WHERE user_id=? AND played_at = ("
            " SELECT MAX(played_at) FROM online_history WHERE user_id=h.user_id"
            " AND anilist_id=h.anilist_id) ORDER BY played_at DESC LIMIT ?",
            user_id,
            limit * 2,
        )
        cards, seen = [], set()
        for r in rows:
            if r["anilist_id"] in seen:
                continue
            seen.add(r["anilist_id"])
            if r["completed"]:
                if r["episode"] >= r["available"]:
                    continue  # caught up
                episode, position, duration = r["episode"] + 1, 0.0, 0.0
            else:
                episode, position, duration = r["episode"], r["position"], r["duration"]
            cards.append(
                {
                    "anilist_id": r["anilist_id"],
                    "episode": episode,
                    "lang": r["lang"],
                    "name": r["name"],
                    "poster": r["poster"],
                    "background": r["background"],
                    "position": position,
                    "duration": duration,
                }
            )
        return cards[:limit]
