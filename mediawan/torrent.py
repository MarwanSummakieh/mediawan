"""Online movies and TV over BitTorrent: Torrentio for the releases, the torrent sidecar for
the data, and media.py's own copy-first HLS path for playback.

Releases are listed by IMDb id (which Cinemeta already gave the title), checked against the
hard rules and ranked per quality (release_rules.py). Pressing play, or opening a title page,
starts a *stream*: the sidecar (torrentd.py, inside the VPN container's network) joins the top
release's swarm; if no file list arrives within a few seconds the next release is raced against
it. Once a file is chosen FFprobe reads its head and tail through the sidecar, a film whose real
length is far from the catalog's runtime is rejected for good (it is a different film with the
same name) and the next release is tried. A ready stream plays like a library file: the
sidecar's URL goes to media.Sessions, which copies the video into HLS.

The streaming filter (two Playback preferences, both on by default) tries releases from trusted
groups first, and a file whose own text subtitles lack the viewer's language is dropped for the
next one, up to SUBTITLE_CHECKS files. Nothing is refused for these reasons: when no release
passes, the best one plays and the status carries warnings.

Everything the interface asks for is answered from memory; the slow steps run on threads and
the interface polls the stream's status.
"""

import hashlib
import json
import logging
import re
import secrets
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from . import media
from . import release_rules as rr
from .db import Database
from .online import OnlineError

log = logging.getLogger("mediawan.torrent")

QUALITIES = rr.STREAM_RESOLUTIONS  # 480, 720, 1080, 2160
LABELS = {480: "SD", 720: "720p", 1080: "1080p", 2160: "4K"}
# A lower quality replaces 1080p only when 1080p has nothing sound and the lower one scores
# clearly better: resolution is not given up on thin evidence.
SOUND_SCORE, CLEAR_MARGIN = 20, 10
SINTEL_HASH = "08ada5a7a6183aae1e09d831df6748d566095a10"
# At most this many files are opened only to look for subtitles before settling for the best
# one without them; each costs a few seconds of start-up.
SUBTITLE_CHECKS = 3
# The languages of the Settings menus (LANGS in app.js), for messages.
LANGUAGE_NAMES = {"en": "English", "ar": "Arabic", "da": "Danish", "pt": "Portuguese", "fr": "French",
                  "de": "German", "es": "Spanish", "it": "Italian", "ja": "Japanese", "nl": "Dutch",
                  "ko": "Korean", "zh": "Chinese"}  # fmt: skip


def language_list(codes: list[str]) -> str:
    """["ar", "en"] -> "Arabic or English"."""
    names = [LANGUAGE_NAMES.get(c, c) for c in codes]
    return names[0] if len(names) == 1 else f"{', '.join(names[:-1])} or {names[-1]}"


class TorrentError(OnlineError):
    """A failure the interface shows as a screen. `reason` tells it which next step to offer."""

    def __init__(self, message: str, status: int = 502, reason: str = "failed"):
        super().__init__(message, status)
        self.reason = reason


@dataclass
class Timings:
    fresh: float = 300  # a listing is re-fetched after this...
    stale: float = 3600  # ...but answered from memory meanwhile, up to this age
    fallback: float = 6  # wait for a file list before racing the next release
    connect: float = 45  # give up on every candidate after this
    prepared_idle: float = 75  # a prepared stream nobody looks at is dropped
    playing_idle: float = 240
    failed_linger: float = 60
    poll: float = 0.25


# ---- the sidecar -------------------------------------------------------------------------------


class Sidecar:
    """The torrent engine's JSON API (see torrentd.py)."""

    def __init__(self, url: str, key: str, client: httpx.Client | None = None):
        self.url = (url or "").rstrip("/")
        self.key = key
        self.client = client or httpx.Client(timeout=httpx.Timeout(8, connect=3))

    @property
    def enabled(self) -> bool:
        return bool(self.url)

    def _call(self, method: str, path: str, body: dict | None = None) -> dict:
        try:
            response = self.client.request(
                method,
                f"{self.url}{path}",
                json=body,
                headers={"Authorization": f"Bearer {self.key}"},
            )
        except httpx.HTTPError as error:
            raise TorrentError(
                f"The torrent engine is not reachable at {self.url} ({type(error).__name__})",
                503,
                "engine",
            ) from None
        try:
            data = response.json()
        except ValueError:
            data = {}
        if response.status_code >= 400:
            reason = data.get("reason") or "failed"
            if response.status_code == 401:
                raise TorrentError("The torrent engine refused the key (check TORRENT_KEY)", 503, "engine")
            raise TorrentError(data.get("error") or f"Torrent engine error {response.status_code}",
                               response.status_code, reason)  # fmt: skip
        return data

    def add(self, info_hash: str, trackers: list[str]) -> dict:
        return self._call("POST", "/v1/torrents", {"hash": info_hash, "trackers": trackers})

    def status(self, info_hash: str) -> dict:
        return self._call("GET", f"/v1/torrents/{info_hash}")

    def select(self, info_hash: str, index, name: str, mode: str) -> dict:
        return self._call("POST", f"/v1/torrents/{info_hash}/files", {"index": index, "name": name, "mode": mode})

    def mode(self, info_hash: str, index: int, mode: str) -> dict:
        return self._call("POST", f"/v1/torrents/{info_hash}/files/{index}/mode", {"mode": mode})

    def hint(self, info_hash: str, index: int, position: int) -> dict:
        return self._call("POST", f"/v1/torrents/{info_hash}/files/{index}/hint", {"position": position})

    def remove(self, info_hash: str):
        try:
            self._call("DELETE", f"/v1/torrents/{info_hash}")
        except TorrentError:
            pass  # gone already, or the engine is down: it drops idle torrents itself

    def overview(self) -> dict:
        return self._call("GET", "/v1/status")

    def file_url(self, path: str) -> str:
        return f"{self.url}{path}"


# ---- streams ---------------------------------------------------------------------------------


@dataclass
class Attempt:
    entry: dict  # a ranked entry: {"release", "score", "parts", "traits"[, "trusted", "subtitles"]}
    state: str = "trying"  # trying | won | abandoned | failed | no-subtitles
    reason: str | None = None
    started: float = field(default_factory=time.time)
    status: dict = field(default_factory=dict)  # the sidecar's last word on this torrent
    added: bool = False

    @property
    def hash(self) -> str:
        return self.entry["release"]["hash"]


@dataclass
class Stream:
    id: str
    user_id: int
    player: str
    title: dict
    season: int
    episode: int
    quality: int
    intent: str  # prepare | play
    ranked: list
    pinned: str | None = None
    candidates: list = field(default_factory=list)
    attempts: list = field(default_factory=list)
    chosen: Attempt | None = None
    file: dict | None = None
    info: dict | None = None
    fallback: dict | None = None
    error: dict | None = None
    closed: bool = False
    created: float = field(default_factory=time.time)
    touched: float = field(default_factory=time.time)
    failed_at: float = 0.0
    timings: dict = field(default_factory=dict)
    # The viewer's streaming filter when the stream began, the subtitle languages that satisfy
    # it, and whether the chosen file has them (None until it has been read).
    filter: dict = field(default_factory=dict)
    wanted: list = field(default_factory=list)
    subtitles: bool | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def kind(self) -> str:
        return self.title["kind"]

    def live(self) -> bool:
        return not self.closed and not self.error


def summary(entry: dict | None, quality: int | None = None) -> dict | None:
    """What the interface shows about a release."""
    if not entry:
        return None
    r, t = entry["release"], entry["traits"]
    tags = [LABELS.get(quality or r.get("resolution") or 0, "")]
    tags += [{"web-dl": "WEB-DL", "disc": "Blu-ray", "remux": "Remux", "poor": "Rip"}.get(t["source"] or "", "")]
    tags += ["DV" if t["dolby_vision"] else "", "HDR" if t["hdr"] else "", t["service"] or ""]
    return {
        "hash": r["hash"],
        "name": (r.get("label") or "").split("\n")[0],
        "filename": r.get("filename") or None,
        "size": r.get("size"),
        "seeders": r.get("seeders"),
        "resolution": r.get("resolution"),
        "source": t["source"],
        "group": t["group"],
        "service": t["service"],
        "season_pack": t["season_pack"],
        # The streaming filter: None when it is off, or (subtitles) before the file was read.
        "trusted": entry.get("trusted"),
        "subtitles": entry.get("subtitles"),
        "tags": [x for x in tags if x],
        "score": entry["score"],
        "why": [f"{'+' if p > 0 else ''}{p} {reason}" for p, reason in entry["parts"]],
    }


_EPISODE = re.compile(r"(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,3})(?:$|[^0-9])", re.IGNORECASE)


def episode_mismatch(path: str, season: int, episode: int) -> str | None:
    """A season pack can hand over the wrong episode; a file name that says SxxEyy must agree."""
    hit = _EPISODE.search(Path(path.replace("\\", "/")).name)
    if not hit or (int(hit.group(1)), int(hit.group(2))) == (season, episode):
        return None
    return f"The file is S{int(hit.group(1)):02d}E{int(hit.group(2)):02d}, not S{season:02d}E{episode:02d}"


def sintel_listing() -> list[dict]:
    """DEVELOPMENT ONLY (TORRENT_DEV_SINTEL): the freely licensed film Sintel in place of a
    title's real releases, at two quality labels of the same torrent, so the whole flow can be
    tried without joining any other swarm."""
    base = {"hash": SINTEL_HASH, "file_index": 5, "name": "", "filename": "Sintel.mp4",
            "seeders": 60, "size": 129241752, "trackers": []}  # fmt: skip
    return [
        {**base, "label": "Sintel.2010.1080p.WEB-DL.AAC.H.264-BLENDER\n👤 60 💾 123 MB ⚙️ dev", "resolution": 1080},
        {**base, "label": "Sintel.2010.2160p.WEB-DL.AAC.H.265-BLENDER\n👤 60 💾 123 MB ⚙️ dev", "resolution": 2160},
    ]


class Torrents:
    def __init__(
        self,
        db: Database,
        ffprobe: str,
        ffmpeg: str,
        runtime: Path,
        sidecar_url: str = "",
        sidecar_key: str = "",
        torrentio: str = "https://torrentio.strem.fun",
        dev_sintel: str = "",
        client: httpx.Client | None = None,
        sidecar: Sidecar | None = None,
        timings: Timings | None = None,
        probe=None,
        background: bool = True,
        trusted_groups=rr.TRUSTED_GROUPS,
        translate_to=(),
    ):
        self.db, self.ffprobe, self.ffmpeg = db, ffprobe, ffmpeg
        self.trusted_groups = tuple(trusted_groups or ())
        # Languages the server can machine-translate English subtitles into (translate.py):
        # for those, an English track in the file is as good as one in the language itself.
        self.translate_to = set(translate_to or ())
        self.sidecar = sidecar or Sidecar(sidecar_url, sidecar_key)
        self.torrentio = torrentio.rstrip("/")
        self.dev_sintel = dev_sintel.strip()
        self.client = client or httpx.Client(timeout=12, follow_redirects=True,
                                             headers={"User-Agent": "Mozilla/5.0 Mediawan"})  # fmt: skip
        self.timings = timings or Timings()
        self.probe = probe or (lambda url: media.probe(ffprobe, url))
        self.listings: dict[tuple, dict] = {}
        self.listing_lock = threading.Lock()
        self.streams: dict[str, Stream] = {}
        self.lock = threading.RLock()
        self.engine_state: tuple[float, dict] = (0.0, {})
        self.subtitles = SubtitleJobs(ffmpeg, Path(runtime) / "subtitles")
        self.stopping = threading.Event()
        if self.dev_sintel:
            log.warning("DEVELOPMENT: the releases of %s are replaced by Sintel (TORRENT_DEV_SINTEL)", self.dev_sintel)
        if background and self.enabled:
            threading.Thread(target=self._loop, name="mediawan-torrent", daemon=True).start()

    @property
    def enabled(self) -> bool:
        return self.sidecar.enabled

    def stop(self):
        self.stopping.set()
        for stream in list(self.streams.values()):
            self.close(stream, "Server stopping")

    # ---- listings -------------------------------------------------------------------------

    def _fetch(self, title: dict, season: int, episode: int) -> list[dict]:
        if self.dev_sintel and title["id"] == self.dev_sintel:
            return sintel_listing()
        if title["kind"] == "movie":
            path = f"movie/{title['id']}"
        else:
            path = f"series/{title['id']}:{season}:{episode}"
        try:
            response = self.client.get(f"{self.torrentio}/stream/{path}.json")
            response.raise_for_status()
            return rr.parse_torrentio(response.json())
        except (httpx.HTTPError, ValueError) as error:
            raise TorrentError(f"The release listing did not answer ({type(error).__name__})", 502, "listing") from None

    def listing(self, title: dict, season: int, episode: int, refresh: bool = False) -> dict:
        """{"releases", "at", "cached"}: from memory while fresh; a stale one is answered at once
        and refreshed in the background."""
        key = (title["id"], season, episode)
        with self.listing_lock:
            entry = self.listings.get(key)
            age = time.time() - entry["at"] if entry and "releases" in entry else None
            if entry and age is not None and not refresh and age < self.timings.stale:
                if age >= self.timings.fresh and not entry.get("loading"):
                    entry["loading"] = True
                    threading.Thread(target=self._load, args=(title, season, episode, key), daemon=True).start()
                return {"releases": entry["releases"], "at": entry["at"], "cached": True}
            pending = entry.get("pending") if entry else None
            if pending is None:
                pending = threading.Event()
                self.listings.setdefault(key, {})["pending"] = pending
                owner = True
            else:
                owner = False
        if owner:
            self._load(title, season, episode, key)
        else:
            pending.wait(20)
        entry = self.listings.get(key) or {}
        if "releases" not in entry:
            raise TorrentError(entry.get("error") or "The release listing did not answer", 502, "listing")
        return {"releases": entry["releases"], "at": entry["at"], "cached": not owner}

    def _load(self, title: dict, season: int, episode: int, key: tuple):
        try:
            releases = self._fetch(title, season, episode)
            with self.listing_lock:
                entry = self.listings.setdefault(key, {})
                entry.update(releases=releases, at=time.time(), loading=False, error=None)
                if len(self.listings) > 600:
                    oldest = min(self.listings, key=lambda k: self.listings[k].get("at", 0))
                    self.listings.pop(oldest, None)
        except TorrentError as error:
            with self.listing_lock:
                entry = self.listings.setdefault(key, {})
                entry.update(loading=False, error=str(error))
        finally:
            with self.listing_lock:
                pending = self.listings.get(key, {}).pop("pending", None)
            if pending:
                pending.set()

    def prefetch(self, title: dict, season: int, episode: int):
        if (title["id"], season, episode) not in self.listings:
            threading.Thread(target=self._safe_listing, args=(title, season, episode), daemon=True).start()

    def _safe_listing(self, title, season, episode):
        try:
            self.listing(title, season, episode)
        except TorrentError:
            pass

    # ---- locks and rejects ----------------------------------------------------------------

    def read_lock(self, title: dict, season: int, quality: int) -> dict | None:
        if title["kind"] == "movie":
            return None
        row = self.db.one(
            "SELECT json FROM torrent_locks WHERE imdb_id=? AND season=? AND quality=?",
            title["id"], season, quality,
        )  # fmt: skip
        return json.loads(row["json"]) if row else None

    def write_lock(self, title: dict, season: int, quality: int, entry: dict):
        if title["kind"] == "movie":
            return
        self.db.run(
            "INSERT INTO torrent_locks(imdb_id, season, quality, json, updated) VALUES(?,?,?,?,?) "
            "ON CONFLICT(imdb_id, season, quality) DO UPDATE SET json=excluded.json, updated=excluded.updated",
            title["id"], season, quality, json.dumps(rr.lock_from(entry)), int(time.time()),
        )  # fmt: skip

    def rejected(self, imdb_id: str) -> dict[str, str]:
        rows = self.db.all("SELECT hash, reason FROM torrent_rejects WHERE imdb_id=?", imdb_id)
        return {r["hash"]: r["reason"] for r in rows}

    def reject(self, imdb_id: str, info_hash: str, reason: str):
        self.db.run(
            "INSERT OR REPLACE INTO torrent_rejects(imdb_id, hash, reason, at) VALUES(?,?,?,?)",
            imdb_id, info_hash, reason, int(time.time()),
        )  # fmt: skip

    # ---- the streaming filter ---------------------------------------------------------------

    def viewer_filter(self, user_id: int) -> tuple[dict, list[str]]:
        """({"trusted_only", "require_subtitles"}, wanted subtitle languages) from the viewer's
        Playback preferences. Wanted: the subtitle language, else the audio language, else
        English; plus English when the server can translate it into the wanted one."""
        row = self.db.one("SELECT json FROM preferences WHERE user_id=?", user_id)
        prefs = json.loads(row["json"]) if row else {}
        rules = {
            "trusted_only": prefs.get("trusted_only", True) is not False,
            "require_subtitles": prefs.get("require_subtitles", True) is not False,
        }
        lang = prefs.get("subtitle_language") or prefs.get("audio_language") or "en"
        wanted = [lang] + (["en"] if lang != "en" and lang in self.translate_to else [])
        return rules, wanted

    @staticmethod
    def _file_key(release: dict) -> int:
        index = release.get("file_index")
        return index if isinstance(index, int) else -1

    def known_subtitles(self, imdb_id: str) -> dict[tuple, list[str]]:
        rows = self.db.all("SELECT hash, file_index, languages FROM torrent_subtitles WHERE imdb_id=?", imdb_id)
        return {(r["hash"], r["file_index"]): json.loads(r["languages"]) for r in rows}

    def remember_subtitles(self, imdb_id: str, release: dict, languages: list[str]):
        self.db.run(
            "INSERT OR REPLACE INTO torrent_subtitles(imdb_id, hash, file_index, languages, at) VALUES(?,?,?,?,?)",
            imdb_id, release["hash"], self._file_key(release), json.dumps(languages), int(time.time()),
        )  # fmt: skip

    def filtered(self, ranked: list[dict], imdb_id: str, rules: dict, wanted: list[str]) -> list[dict]:
        """With the filter on, releases are tried in four bands, each in score order: trusted;
        trusted known to lack the subtitles; untrusted; untrusted known to lack them. Nothing
        is removed, so a stream still starts (with warnings) when no release passes."""
        if not rules["trusted_only"] and not rules["require_subtitles"]:
            return ranked
        known = self.known_subtitles(imdb_id)
        marked = []
        for entry in ranked:
            release = entry["release"]
            languages = known.get((release["hash"], self._file_key(release)))
            marked.append(
                {
                    **entry,
                    "trusted": bool(rr.trusted_group(release, self.trusted_groups)) if rules["trusted_only"] else None,
                    "subtitles": None if languages is None else any(lang in wanted for lang in languages),
                }
            )

        def band(entry: dict) -> int:
            return (2 if rules["trusted_only"] and not entry["trusted"] else 0) + (
                1 if rules["require_subtitles"] and entry["subtitles"] is False else 0
            )

        return sorted(marked, key=band)  # stable: score order within a band

    def _subtitle_candidates(self, stream: Stream, current: dict, checked: list[dict]) -> list[dict]:
        """Releases still worth opening for subtitles after `current` had none: not failed, not
        a different film, not read already or known to lack them, and (with trusted releases
        preferred) in the same trust band as `current`."""
        failed = {a.hash for a in stream.attempts if a.state == "failed"}
        wrong = self.rejected(stream.title["id"])
        known = self.known_subtitles(stream.title["id"])
        out = []
        for entry in stream.ranked:
            release = entry["release"]
            if release["hash"] in failed or release["hash"] in wrong or any(entry is c for c in checked):
                continue
            if stream.filter.get("trusted_only") and bool(entry.get("trusted")) != bool(current.get("trusted")):
                continue
            languages = known.get((release["hash"], self._file_key(release)))
            if languages is None or any(lang in stream.wanted for lang in languages):
                out.append(entry)
        return out[:4]

    def warnings(self, stream: Stream, entry: dict | None) -> list[str]:
        """What the streaming filter could not satisfy for the release being played."""
        out = []
        if not entry:
            return out
        if stream.filter.get("trusted_only") and not entry.get("trusted"):
            group = f" ({entry['traits']['group']})" if entry["traits"].get("group") else ""
            out.append(
                f"Not from a trusted release group{group}: the trusted releases did not answer."
                if any(e.get("trusted") for e in stream.ranked)
                else f"Not from a trusted release group{group}: no trusted release of this quality is listed."
            )
        if stream.filter.get("require_subtitles") and stream.info and not stream.subtitles:
            out.append(
                f"No {language_list(stream.wanted)} subtitles in this file. Subtitles found online may still cover it."
            )
        return out

    # ---- ranking ----------------------------------------------------------------------------

    def rank(self, title: dict, season: int, episode: int, releases: list[dict]) -> dict[int, dict]:
        """{quality: {"ranked", "lock", "reason"}} for every quality."""
        runtime = rr.runtime_seconds(title.get("runtime"))
        if title["kind"] != "movie":
            episode_info = next(
                (e for e in title.get("episodes") or [] if (e["season"], e["episode"]) == (season, episode)), None
            )
            runtime = rr.runtime_seconds((episode_info or {}).get("runtime")) or runtime
        bad = self.rejected(title["id"])
        end = rr.end_year(title.get("release_info"))
        out = {}
        for quality in QUALITIES:

            def assess(relaxed: bool, quality: int = quality):
                found = []
                for r in releases:
                    if r["hash"] in bad:
                        found.append((r, False, ["A different film with the same name"]))
                        continue
                    ok, why = rr.assess_stream(r, title["kind"], quality, title.get("year"), end, relaxed)
                    found.append((r, ok, why))
                return found

            assessed = assess(False)
            # A series keeps to WEB-DL while one exists; only when none does are Blu-ray
            # releases of that episode accepted.
            if title["kind"] != "movie" and not any(ok for _, ok, _ in assessed):
                relaxed = assess(True)
                if any(ok for _, ok, _ in relaxed):
                    assessed = relaxed
            lock = self.read_lock(title, season, quality)
            ranked = rr.rank([r for r, ok, _ in assessed if ok], title["kind"], lock, runtime)
            reason = None
            if not ranked:
                near = sorted(
                    ((r, why) for r, ok, why in assessed if r.get("resolution") == quality),
                    key=lambda x: -(x[0].get("seeders") or 0),
                )
                reason = (
                    "No releases are listed for this yet"
                    if not releases
                    else f"No {LABELS[quality]} release is listed"
                    if not near
                    else f"No {LABELS[quality]} release passes the checks. Best: {near[0][1][0]}"
                )
            out[quality] = {"ranked": ranked, "lock": lock, "reason": reason}
        return out

    @staticmethod
    def standard(qualities: dict[int, dict]) -> int:
        """The quality shown beside 4K: 1080p, or the best lower one when 1080p has nothing sound."""
        top = lambda q: qualities[q]["ranked"][0]["score"] if qualities[q]["ranked"] else -10**9
        if top(1080) >= SOUND_SCORE:
            return 1080
        lower = max(rr.LOWER_RESOLUTIONS, key=top)
        return lower if top(lower) >= top(1080) + CLEAR_MARGIN else 1080

    def choices(self, title: dict, season: int, episode: int, refresh: bool = False,
                user_id: int | None = None) -> dict:  # fmt: skip
        """Ranked releases per quality; for a viewer, in the order of their streaming filter."""
        found = self.listing(title, season, episode, refresh)
        qualities = self.rank(title, season, episode, found["releases"])
        standard = self.standard(qualities)
        offered = [standard, 2160]
        order = [2160, standard] if title["kind"] == "movie" else [standard, 2160]
        default = next((q for q in order if qualities[q]["ranked"]), order[0])
        if user_id is not None:
            rules, wanted = self.viewer_filter(user_id)
            for option in qualities.values():
                option["ranked"] = self.filtered(option["ranked"], title["id"], rules, wanted)
        return {"qualities": qualities, "offered": offered, "default": default, **found}

    def options(self, user_id: int, title: dict, season: int, episode: int, refresh: bool = False) -> dict:
        found = self.choices(title, season, episode, refresh, user_id)
        pairs = [(e["season"], e["episode"]) for e in title.get("episodes") or []]
        if (season, episode) in pairs and pairs.index((season, episode)) < len(pairs) - 1:
            self.prefetch(title, *pairs[pairs.index((season, episode)) + 1])  # Next Up starts warm
        qualities = []
        for q in found["offered"]:
            option = found["qualities"][q]
            stream = self.find(user_id, title["id"], season, episode, q, None)
            if option["ranked"]:
                lock = option["lock"]
                qualities.append(
                    {
                        "quality": q,
                        "label": LABELS[q],
                        "available": True,
                        "release": summary(option["ranked"][0], q),
                        "alternatives": len(option["ranked"]) - 1,
                        "season_lock": {"group": lock.get("group"), "service": lock.get("service")} if lock else None,
                        "stream": self.public(stream) if stream else None,
                    }
                )
            else:
                qualities.append({"quality": q, "label": LABELS[q], "available": False, "reason": option["reason"]})
        return {
            "enabled": self.enabled,
            "engine": self.engine(),
            "default": found["default"],
            "qualities": qualities,
            "cached": found["cached"],
            "listing_age": round(time.time() - found["at"]),
        }

    def releases(self, title: dict, season: int, episode: int, quality: int, user_id: int | None = None) -> list[dict]:
        found = self.choices(title, season, episode, user_id=user_id)
        q = quality if quality in QUALITIES else found["default"]
        return [summary(e, q) for e in found["qualities"][q]["ranked"][:25]]

    def engine(self, fresh: bool = False) -> dict:
        """The sidecar's health, cached for a few seconds: {"ok", "message", "tunnel"}."""
        at, state = self.engine_state
        if state and not fresh and time.time() - at < 10:
            return state
        if not self.enabled:
            state = {"ok": False, "message": "Torrent streaming is off (TORRENT_URL is not set)"}
        else:
            try:
                overview = self.sidecar.overview()
                tunnel = overview.get("tunnel") or {}
                state = {"ok": bool(tunnel.get("ok")), "message": tunnel.get("message") or "", "tunnel": tunnel}
            except TorrentError as error:
                state = {"ok": False, "message": str(error)}
        self.engine_state = (time.time(), state)
        return state

    # ---- opening streams --------------------------------------------------------------------

    def find(self, user_id: int, imdb_id: str, season: int, episode: int, quality: int, player: str | None,
             pinned: str | None = None) -> Stream | None:  # fmt: skip
        pool = [
            s for s in self.streams.values()
            if s.user_id == user_id and s.title["id"] == imdb_id and (s.season, s.episode, s.quality) == (season, episode, quality)
            and s.live() and (pinned is None or s.pinned == pinned)
        ]  # fmt: skip
        return (
            (player and next((s for s in pool if s.player == player), None))
            or next((s for s in pool if s.intent == "prepare"), None)
            or (pool[0] if player is None and pool else None)
        )

    def open(self, user_id: int, title: dict, season: int, episode: int, quality: int | None, player: str,
             intent: str = "prepare", pinned: str | None = None) -> Stream:  # fmt: skip
        if not self.enabled:
            raise TorrentError("Torrent streaming is off (TORRENT_URL is not set)", 409, "off")
        found = self.choices(title, season, episode, user_id=user_id)
        q = quality if quality in QUALITIES else found["default"]
        option = found["qualities"][q]
        ranked = option["ranked"]
        if pinned:
            ranked = [e for e in ranked if e["release"]["hash"] == pinned] + [
                e for e in ranked if e["release"]["hash"] != pinned
            ]
            if not ranked or ranked[0]["release"]["hash"] != pinned:
                raise TorrentError("That version is no longer listed", 404, "unavailable")
        if not ranked:
            raise TorrentError(option["reason"] or f"No {LABELS[q]} release is available", 404, "unavailable")
        with self.lock:
            stream = self.find(user_id, title["id"], season, episode, q, player, pinned)
            if stream is None:
                self._make_room(user_id)
                stream = Stream(secrets.token_hex(8), user_id, player, title, season, episode, q, intent, ranked, pinned)
                stream.candidates = ranked[:4]
                stream.filter, stream.wanted = self.viewer_filter(user_id)
                stream.timings["created"] = time.time()
                self.streams[stream.id] = stream
                threading.Thread(target=self._run_safely, args=(stream,), name=f"stream-{stream.id}", daemon=True).start()
            stream.player = player or stream.player
            if intent == "play" and stream.intent != "play":
                stream.intent = "play"
                self._play_mode(stream)
            stream.touched = time.time()
        return stream

    def _make_room(self, user_id: int):
        live = lambda: [s for s in self.streams.values() if s.live()]
        for limit, pool in ((4, lambda: [s for s in live() if s.user_id == user_id]), (8, live)):
            while len(pool()) >= limit:
                prepared = sorted((s for s in pool() if s.intent == "prepare"), key=lambda s: s.touched)
                if not prepared:
                    raise TorrentError(f"{len(pool())} streams are already running. Stop one first.", 409, "limit")
                self.close(prepared[0], "Stopped to make room for another stream")

    def _play_mode(self, stream: Stream):
        if stream.chosen and stream.file:
            try:
                self.sidecar.mode(stream.chosen.hash, stream.file["index"], "play")
            except TorrentError as error:
                log.warning("Could not switch %s to play mode: %s", stream.id, error)

    def get(self, user_id: int, stream_id: str) -> Stream:
        stream = self.streams.get(stream_id)
        if not stream or stream.user_id != user_id or stream.closed:
            raise TorrentError("This stream has ended. Press play again.", 404, "gone")
        stream.touched = time.time()
        return stream

    # ---- the stream's own thread ------------------------------------------------------------

    def _run_safely(self, stream: Stream):
        try:
            self._run(stream)
        except TorrentError as error:
            self._fail(stream, error.reason, str(error))
        except Exception as error:
            log.exception("Stream %s failed", stream.id)
            self._fail(stream, "failed", f"The stream failed ({type(error).__name__}). Try again.")

    def _fail(self, stream: Stream, reason: str, message: str):
        if stream.closed:
            return
        stream.error = {"reason": reason, "message": message}
        stream.failed_at = time.time()
        for attempt in stream.attempts:
            if attempt.state == "trying":
                attempt.state = "abandoned"
        self._release_unused(stream)

    def _run(self, stream: Stream):
        wrong = None
        # Files read and found to lack the viewer's subtitles, best first; once the search is
        # over the first of them to answer is accepted without the check. A release the viewer
        # picked by hand is never swapped for subtitles.
        bare: list[dict] = []
        settled = bool(stream.pinned)
        while not stream.closed:
            self._connect(stream)
            if stream.closed:
                return
            stream.timings["probing"] = time.time()
            url = self.sidecar.file_url(stream.file["url"])
            try:
                info = self.probe(url)
            except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
                raise TorrentError(f"FFprobe could not read the video: {media.no_logins(str(error))[:200]}",
                                   502, "probe") from None  # fmt: skip
            if stream.closed:
                return
            if not info.get("video"):
                raise TorrentError("The file has no video stream", 422, "probe")
            mismatch = (
                rr.wrong_film(info.get("duration") or 0, rr.runtime_seconds(stream.title.get("runtime")))
                if stream.kind == "movie" else None
            )  # fmt: skip
            if not mismatch:
                current = stream.chosen.entry
                languages = rr.subtitle_languages(info)
                self.remember_subtitles(stream.title["id"], current["release"], languages)
                stream.subtitles = any(lang in stream.wanted for lang in languages)
                if stream.subtitles or not stream.filter.get("require_subtitles") or settled:
                    break
                # No subtitles in the viewer's language: look at the next files, then settle
                # for the best one read.
                bare.append(current)
                after = self._subtitle_candidates(stream, current, bare) if len(bare) < SUBTITLE_CHECKS else []
                if not after and bare[0] is current:
                    break
                stream.chosen.state = "no-subtitles"
                stream.chosen.reason = f"No {language_list(stream.wanted)} subtitles in this file"
                stream.chosen, stream.file, stream.fallback, stream.subtitles = None, None, None, None
                self._release_unused(stream)
                if after:
                    stream.candidates = after
                else:
                    stream.candidates, settled = list(bare), True
                continue
            # A different film with the same name: never offer it again, try the next release.
            bad = stream.chosen
            self.reject(stream.title["id"], bad.hash, mismatch)
            wrong = wrong or {"entry": bad.entry, "reason": mismatch}
            bad.state, bad.reason = "failed", f"A different film with the same name. {mismatch}"
            stream.chosen, stream.file, stream.fallback = None, None, None
            self._release_unused(stream)
            known = self.rejected(stream.title["id"])
            failed = {a.hash for a in stream.attempts if a.state == "failed"}
            stream.candidates = [
                e for e in stream.ranked
                if e["release"]["hash"] not in failed | set(known) and not any(e is b for b in bare)
            ][:4]  # fmt: skip
            if not stream.candidates and bare:  # only files without subtitles are left
                stream.candidates, settled = list(bare), True
            if not stream.candidates:
                raise TorrentError(
                    f"Every {LABELS[stream.quality]} release listed for this title turned out to be a different "
                    f"film with the same name. {wrong['reason']}",
                    404,
                    "wrong-film",
                )
        if wrong and stream.chosen:
            stream.fallback = {"from": summary(wrong["entry"], stream.quality),
                               "to": summary(stream.chosen.entry, stream.quality),
                               "reason": f"The first choice was a different film with the same name. {wrong['reason']}"}  # fmt: skip
        elif bare and stream.subtitles and stream.chosen:
            stream.fallback = {"from": summary(bare[0], stream.quality),
                               "to": summary(stream.chosen.entry, stream.quality),
                               "kind": "subtitles",
                               "reason": f"The first choice has no {language_list(stream.wanted)} subtitles."}  # fmt: skip
        if stream.closed:
            return
        self._warm_resume_point(stream, info)
        lock = self.read_lock(stream.title, stream.season, stream.quality)
        if stream.chosen and (not lock or stream.fallback):
            self.write_lock(stream.title, stream.season, stream.quality, stream.chosen.entry)
        stream.timings["ready"] = time.time()
        stream.info = info  # ready: playback may start

    def _warm_resume_point(self, stream: Stream, info: dict):
        """A viewer coming back to this resumes mid-file: fetch the data there now, so pressing
        Resume starts as warm as pressing Play."""
        row = self.db.one(
            "SELECT position, completed FROM watch_history WHERE user_id=? AND imdb_id=? AND season=? AND episode=?",
            stream.user_id, stream.title["id"], stream.season, stream.episode,
        )  # fmt: skip
        duration, size = info.get("duration") or 0, (stream.file or {}).get("size") or 0
        if not row or row["completed"] or row["position"] < 30 or not duration or not size:
            return
        # From a little before: copied video starts at the keyframe before the resume point.
        start = max(0.0, row["position"] - 30)
        try:
            self.sidecar.hint(stream.chosen.hash, stream.file["index"], int(start / duration * size))
        except TorrentError as error:
            log.info("Could not warm the resume point of %s: %s", stream.id, error)

    def _connect(self, stream: Stream):
        """Start the top candidate; when it has no file list after the fallback wait, race the
        next one; then replace the slowest until one answers or every candidate failed."""
        wait, deadline = self.timings.fallback, time.time() + self.timings.connect
        queue = [e for e in stream.candidates]
        pending: list[Attempt] = []
        last_error: TorrentError | None = None
        next_race = time.time() + wait

        def start_next() -> bool:
            nonlocal last_error
            while queue:
                attempt = Attempt(queue.pop(0))
                stream.attempts.append(attempt)
                try:
                    attempt.status = self.sidecar.add(attempt.hash, attempt.entry["release"].get("trackers") or [])
                    attempt.added = True
                    pending.append(attempt)
                    return True
                except TorrentError as error:
                    if error.reason in ("vpn", "engine", "limit"):
                        raise
                    attempt.state, attempt.reason = "failed", str(error)
                    last_error = error
            return False

        start_next()
        while not stream.closed:
            if not pending and not start_next():
                break
            for attempt in list(pending):
                try:
                    attempt.status = self.sidecar.status(attempt.hash)
                except TorrentError as error:
                    if error.reason in ("vpn", "engine"):
                        raise
                    attempt.state, attempt.reason = "failed", str(error)
                    pending.remove(attempt)
                    continue
                if attempt.status.get("peers") and "peers" not in stream.timings:
                    stream.timings["peers"] = time.time()
                if attempt.status.get("error"):
                    attempt.state, attempt.reason = "failed", attempt.status["error"]
                    pending.remove(attempt)
                    continue
                if not attempt.status.get("has_metadata"):
                    continue
                release = attempt.entry["release"]
                try:
                    chosen = self.sidecar.select(
                        attempt.hash, release.get("file_index"), release.get("filename") or "",
                        "play" if stream.intent == "play" else "prepare",
                    )  # fmt: skip
                    if stream.kind != "movie":
                        wrong_episode = episode_mismatch(chosen["path"], stream.season, stream.episode)
                        if wrong_episode:
                            raise TorrentError(wrong_episode, 422, "wrong-file")
                except TorrentError as error:
                    if error.reason in ("vpn", "engine", "disk"):
                        raise
                    attempt.state, attempt.reason = "failed", str(error)
                    last_error = error
                    pending.remove(attempt)
                    continue
                attempt.state = "won"
                stream.timings["metadata"] = time.time()
                stream.chosen, stream.file = attempt, chosen
                first = stream.candidates[0]
                if attempt.entry is not first:
                    first_attempt = next((a for a in stream.attempts if a.entry is first), None)
                    stream.fallback = {
                        "from": summary(first, stream.quality),
                        "to": summary(attempt.entry, stream.quality),
                        "reason": (first_attempt.reason if first_attempt and first_attempt.reason
                                   else "The first choice did not answer"),
                    }  # fmt: skip
                for other in pending:
                    if other is not attempt:
                        other.state, other.reason = "abandoned", "Another release answered first"
                self._release_unused(stream)
                return
            now = time.time()
            if now >= deadline:
                break
            if now >= next_race:
                # Slow: race the next candidate, keeping at most two swarms open at once.
                for attempt in pending:
                    attempt.reason = attempt.reason or f"No file list within {round(wait)} s"
                if len(pending) >= 2:
                    slowest = pending.pop(0)
                    slowest.state = "abandoned"
                    slowest.reason = f"No file list within {round(2 * wait)} s"
                    self._release_unused(stream)
                start_next()
                next_race = now + wait
            time.sleep(self.timings.poll)
        if stream.closed:
            return
        for attempt in pending:
            attempt.state, attempt.reason = "abandoned", attempt.reason or "Timed out"
        self._release_unused(stream)
        tried = len(stream.attempts)
        if last_error and all(a.state == "failed" for a in stream.attempts):
            raise TorrentError(f"None of the releases could be streamed. {last_error}", 502, "no-release")
        raise TorrentError(
            f"No peers answered for {'the only release' if tried == 1 else f'any of the {tried} releases'} "
            "tried. Try again in a while, or pick another quality or source.",
            504,
            "no-peers",
        )

    # ---- releasing torrents -----------------------------------------------------------------

    def _in_use(self) -> set[str]:
        used = set()
        for s in self.streams.values():
            if s.closed or s.error:
                continue
            for a in s.attempts:
                if a.state in ("trying", "won") and a.added:
                    used.add(a.hash)
        return used

    def _release_unused(self, stream: Stream):
        used = self._in_use()
        for attempt in stream.attempts:
            if attempt.added and attempt.hash not in used:
                attempt.added = False
                threading.Thread(target=self.sidecar.remove, args=(attempt.hash,), daemon=True).start()

    def close(self, stream: Stream, reason: str = "Stopped"):
        with self.lock:
            if stream.closed:
                return
            stream.closed = True
            stream.closed_reason = reason  # type: ignore[attr-defined]
            self.streams.pop(stream.id, None)
        for attempt in stream.attempts:
            if attempt.state == "trying":
                attempt.state = "abandoned"
        self._release_unused(stream)

    def stop_stream(self, user_id: int, stream_id: str):
        stream = self.streams.get(stream_id)
        if stream and stream.user_id == user_id:
            self.close(stream)

    # ---- the background loop: fresh figures, expiry --------------------------------------

    def _loop(self):
        while not self.stopping.wait(1.0):
            try:
                self.tick()
            except Exception:
                log.exception("Torrent tick failed")

    def tick(self):
        now = time.time()
        for stream in list(self.streams.values()):
            idle = self.timings.playing_idle if stream.intent == "play" else self.timings.prepared_idle
            if stream.error and now - stream.failed_at > self.timings.failed_linger:
                self.close(stream, stream.error["message"])
            elif not stream.error and now - stream.touched > idle:
                self.close(stream, "Expired after being idle")
            elif stream.chosen and stream.live():
                try:  # keeps the torrent alive in the sidecar and the figures fresh
                    stream.chosen.status = self.sidecar.status(stream.chosen.hash)
                except TorrentError as error:
                    if error.reason == "gone" and stream.info:
                        self._fail(stream, "gone", "The torrent engine dropped this stream. Press play again.")
                    elif error.reason == "engine":
                        pass  # shown by the next status; the engine may be restarting
        if self.streams:
            self.engine(fresh=now - self.engine_state[0] > 5)

    # ---- status ------------------------------------------------------------------------------

    def public(self, stream: Stream) -> dict:
        attempt = stream.chosen
        live = attempt.status if attempt else {}
        trying = [a for a in stream.attempts if a.state == "trying"]
        selected = next((f for f in live.get("selected") or [] if stream.file and f["index"] == stream.file["index"]), None)
        peers = live.get("peers", 0) if attempt else sum(a.status.get("peers", 0) for a in trying)
        rate = live.get("download_rate", 0) if attempt else sum(a.status.get("download_rate", 0) for a in trying)
        if stream.error:
            state, message = "failed", stream.error["message"]
        elif stream.info:
            if selected and selected.get("waiting"):
                state, message = "buffering", "Buffering"
            else:
                state, message = "ready", "Ready"
        elif stream.chosen:
            state, message = "buffering", "Buffering the start of the video"
        elif peers:
            state, message = "connecting", f"Connected to {peers} peer{'s' if peers != 1 else ''}, getting the file list"
        else:
            state, message = "finding", "Finding sources"
        entry = attempt.entry if attempt else stream.candidates[0] if stream.candidates else None
        since = lambda key: round(stream.timings[key] - stream.timings["created"], 2) if key in stream.timings else None
        size = (stream.file or {}).get("size")
        release = summary(entry, stream.quality)
        if release and stream.info:  # what this file was found to have
            release["subtitles"] = stream.subtitles
        return {
            "id": stream.id,
            "kind": stream.kind,
            "imdb_id": stream.title["id"],
            "season": stream.season,
            "episode": stream.episode,
            "quality": stream.quality,
            "label": LABELS[stream.quality],
            "intent": stream.intent,
            "state": state,
            "message": message,
            "error": stream.error,
            "release": release,
            "pinned": stream.pinned,
            "fallback": stream.fallback,
            "warnings": self.warnings(stream, entry),
            "attempts": [{"name": (a.entry["release"].get("label") or "").split("\n")[0], "state": a.state,
                          "reason": a.reason, "peers": a.status.get("peers", 0)} for a in stream.attempts],
            "peers": peers,
            "download_rate": rate,
            "ready_fraction": (selected or {}).get("ready_fraction", 0.0),
            "buffered_ahead": (selected or {}).get("buffered_ahead", 0),
            "downloaded": (selected or {}).get("downloaded", 0),
            "size": size,
            "duration": (stream.info or {}).get("duration"),
            "timings": {k: since(k) for k in ("peers", "metadata", "probing", "ready")},
        }

    # ---- playing --------------------------------------------------------------------------

    def remote_file(self, stream: Stream) -> dict:
        """A stand-in for a library file row, for media.Sessions."""
        if not stream.info or not stream.file:
            raise TorrentError("The stream is still starting", 409, "not-ready")
        url = self.sidecar.file_url(stream.file["url"])
        return {"id": "t" + hashlib.sha1(url.encode()).hexdigest()[:16], "path": url, "mtime": 0}

    def subtitle_key(self, stream: Stream, index: int) -> str:
        return f"t-{stream.chosen.hash}-{stream.file['index']}-{index}"


# ---- subtitles from a torrent -------------------------------------------------------------------


class SubtitleJobs:
    """An embedded text subtitle track, extracted to WebVTT in the background. Reading a track
    out of a torrent reads the whole file through the sidecar, so the player gets progress
    (202) instead of a request that hangs for minutes."""

    def __init__(self, ffmpeg: str, folder: Path):
        self.ffmpeg, self.folder = ffmpeg, Path(folder)
        self.jobs: dict[str, dict] = {}
        self.lock = threading.Lock()

    def path(self, key: str) -> Path:
        return self.folder / f"{key}.vtt"

    def request(self, key: str, url: str, index: int, duration: float) -> dict:
        target = self.path(key)
        with self.lock:
            if target.exists():
                return {"status": "ready", "path": target}
            job = self.jobs.get(key)
            if job and (job["status"] == "working" or time.time() - job.get("finished", 0) < 30):
                return job
            job = self.jobs[key] = {"status": "working", "done": 0.0, "total": duration, "path": target, "error": ""}
        threading.Thread(target=self._run, args=(job, url, index, target), daemon=True).start()
        return job

    def _run(self, job: dict, url: str, index: int, target: Path):
        self.folder.mkdir(parents=True, exist_ok=True)
        partial = target.with_suffix(".part")
        cmd = [self.ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-y", "-progress", "pipe:1", "-nostats",
               "-i", url, "-map", f"0:{index}", "-c:s", "webvtt", "-flush_packets", "1", "-f", "webvtt", str(partial)]  # fmt: skip
        try:
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
            for line in process.stdout:
                if line.startswith(b"out_time_us="):
                    try:
                        job["done"] = max(job["done"], int(line.split(b"=")[1]) / 1e6)
                    except ValueError:
                        pass
            error = process.stderr.read().decode(errors="replace")[-300:]
            if process.wait() != 0 or not partial.exists():
                raise RuntimeError(media.no_logins(error) or "conversion failed")
            partial.replace(target)
            job["status"] = "ready"
        except (OSError, RuntimeError) as error:
            partial.unlink(missing_ok=True)
            job.update(status="failed", error=str(error))
        job["finished"] = time.time()

    def so_far(self, job: dict) -> str:
        """The lines read so far while a track is still being read, cut at the last whole one."""
        if job.get("status") != "working":
            return ""
        try:
            text = job["path"].with_suffix(".part").read_text("utf-8", errors="replace")
        except OSError:
            return ""
        text = text.replace("\r\n", "\n")
        cut = text.rfind("\n\n")
        return text[: cut + 2] if cut > 0 and "-->" in text[:cut] else ""

    def wait(self, key: str, url: str, index: int, duration: float, limit: float = 1800) -> Path:
        deadline = time.time() + limit
        while time.time() < deadline:
            job = self.request(key, url, index, duration)
            if job["status"] == "ready":
                return job["path"]
            if job["status"] == "failed":
                raise RuntimeError(job["error"])
            time.sleep(1)
        raise RuntimeError("The subtitle track took too long to read")
