"""Live TV channels from an IPTV provider, and live streams shared between viewers.

The provider is either an Xtream Codes account (server + username + password) or an extended
M3U playlist. Channel URLs carry the provider's credentials, so they stay on the server: the
browser only ever sees opaque channel ids and our own HLS playlists.

Playback: one FFmpeg per channel turns the provider's stream into a short rolling HLS window.
Everyone watching that channel shares it, because providers sell a fixed number of
simultaneous connections (often one). H.264 video is copied as it is; anything else, and
interlaced broadcasts, are converted to progressive H.264. Audio becomes AAC unless it already
is.

v2 kept the same data in a catalog.json beside its database; that file is read unchanged.
"""

import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlencode, urlparse

import httpx

from . import media

log = logging.getLogger("mediawan.live")

# Many providers refuse anything that does not look like a set-top box or media player.
AGENT = "VLC/3.0.20 LibVLC/3.0.20"
SEGMENT_SECONDS = 4
WINDOW_SEGMENTS = 30  # two minutes kept on disk: enough to pause or rewind a little
VIEWER_SECONDS = 45  # a viewer whose player stopped pinging is gone
PROBE_SECONDS = 6 * 3600
LIVE_FILE = re.compile(r"^(index\.m3u8|seg\d{6}\.ts)$")

# ---- competitions, languages, regions ------------------------------------------------------

# id, name, short code, sport, colour, pattern matched against channel names and event titles
COMPETITIONS = [
    (
        "premier-league",
        "Premier League",
        "PL",
        "Football",
        "#7256ba",
        r"premier\s*lea(?:gue|uge)|\bEPL\b|الدوري الإنجليزي|الدوري الانجليزي",
    ),
    (
        "la-liga",
        "LaLiga",
        "LL",
        "Football",
        "#be4a3b",
        (
            r"^(?!.*(?:hypermotion|smartbank)).*(?:la\s*liga|laliga|primera divisi[oó]n"
            r"|الدوري الاسباني|الدوري الإسباني)"
        ),
    ),
    ("bundesliga", "Bundesliga", "BL", "Football", "#ab3843", r"bundesliga|الدوري الالماني"),
    (
        "champions-league",
        "Champions League",
        "UCL",
        "Football",
        "#344d9d",
        r"champions\s*league|liga\s*(?:de\s*)?campeones|دوري أبطال أوروبا|دوري ابطال اوروبا",
    ),
    ("europa-league", "Europa League", "UEL", "Football", "#b66727", r"europa\s*league"),
    ("conference-league", "Conference League", "UECL", "Football", "#397959", r"conference\s*le"),
    ("serie-a", "Serie A", "SA", "Football", "#3478a5", r"serie\s*a\b|الدوري الايطالي"),
    ("ligue-1", "Ligue 1", "L1", "Football", "#686c28", r"ligue\s*1\b|الدوري الفرنسي"),
    ("saudi-pro-league", "Saudi Pro League", "SPL", "Football", "#2f7a52", r"saudi|roshn|ssc"),
    ("superliga", "Superliga", "DSL", "Football", "#a33b4a", r"superliga|superligaen"),
    ("eredivisie", "Eredivisie", "ERE", "Football", "#c0603a", r"eredivisie"),
    ("super-lig", "Süper Lig", "TSL", "Football", "#b0413e", r"s[uü]per\s*lig"),
    (
        "primeira-liga",
        "Primeira Liga",
        "POR",
        "Football",
        "#3a7f5a",
        r"primeira\s*liga|liga portugal",
    ),
    ("fa-cup", "FA Cup", "FAC", "Football", "#7a4b8f", r"\bfa\s*cup"),
    ("league-cup", "League Cup", "EFL", "Football", "#4b6a8f", r"carabao|league\s*cup|\befl\b"),
    ("nfl", "NFL", "NFL", "American football", "#31548a", r"\bNFL\b|national football league"),
    ("nhl", "NHL", "NHL", "Ice hockey", "#65778c", r"\bNHL\b|national hockey league"),
    ("nba", "NBA", "NBA", "Basketball", "#976431", r"\bNBA\b|national basketball association"),
    (
        "formula-1",
        "Formula 1",
        "F1",
        "Motorsport",
        "#b74040",
        r"formula\s*(?:1|one)|\bF1\b|فورمولا",
    ),
    ("motogp", "MotoGP", "MGP", "Motorsport", "#a8572f", r"moto\s*gp"),
    ("tennis", "Tennis", "TEN", "Tennis", "#748139", r"tennis|wimbledon|\bATP\b|\bWTA\b|تنس"),
    ("rugby", "Rugby", "RUG", "Rugby", "#35766d", r"rugby|top\s*14|six nations"),
    ("cricket", "Cricket", "CRI", "Cricket", "#5d7a35", r"cricket"),
    ("golf", "Golf", "GOL", "Golf", "#4f7d4b", r"\bgolf\b|pga|ryder"),
    (
        "combat",
        "Combat sports",
        "UFC",
        "Combat sports",
        "#98543d",
        r"\bUFC\b|\bWWE\b|boxing|\bmma\b",
    ),
]
_COMPETITION_RE = [(c[0], re.compile(c[5], re.IGNORECASE)) for c in COMPETITIONS]
SPORTS = sorted({c[3] for c in COMPETITIONS}) + ["Other"]


def competition(cid: str) -> dict | None:
    for c in COMPETITIONS:
        if c[0] == cid:
            return {"id": c[0], "name": c[1], "code": c[2], "sport": c[3], "color": c[4]}
    return None


def competition_ids(text: str) -> list[str]:
    return [cid for cid, pattern in _COMPETITION_RE if pattern.search(text or "")]


# Country codes as providers write them in front of channel and category names.
COUNTRIES = {
    "uk": "United Kingdom", "gb": "United Kingdom", "ie": "Ireland", "us": "United States",
    "usa": "United States", "ca": "Canada", "au": "Australia", "de": "Germany",
    "ger": "Germany", "at": "Austria", "ch": "Switzerland", "nl": "Netherlands",
    "be": "Belgium", "fr": "France", "es": "Spain", "it": "Italy", "pt": "Portugal",
    "br": "Brazil", "arg": "Argentina", "mx": "Mexico", "tr": "Turkey", "gr": "Greece",
    "pl": "Poland", "ro": "Romania", "bg": "Bulgaria", "dk": "Denmark", "se": "Sweden",
    "no": "Norway", "fi": "Finland", "ar": "Arabic / MENA", "mena": "Arabic / MENA",
    "ksa": "Arabic / MENA", "qa": "Arabic / MENA", "ae": "Arabic / MENA",
    "al": "Albania", "rs": "Serbia", "hr": "Croatia", "hu": "Hungary", "il": "Israel",
}  # fmt: skip
REGION_LANGUAGE = {
    "Arabic / MENA": "Arabic", "United Kingdom": "English", "Ireland": "English",
    "United States": "English", "Canada": "English", "Australia": "English",
    "Denmark": "Danish", "Spain": "Spanish", "Germany": "German", "Austria": "German",
    "Switzerland": "German", "France": "French", "Belgium": "French", "Italy": "Italian",
    "Norway": "Norwegian", "Sweden": "Swedish", "Netherlands": "Dutch",
    "Portugal": "Portuguese", "Brazil": "Portuguese", "Argentina": "Spanish",
    "Mexico": "Spanish", "Turkey": "Turkish", "Greece": "Greek", "Poland": "Polish",
    "Romania": "Romanian", "Bulgaria": "Bulgarian", "Finland": "Finnish",
    "Hungary": "Hungarian", "Albania": "Albanian", "Israel": "Hebrew",
}  # fmt: skip
LANG_CODES = {
    "en": "English", "eng": "English", "ar": "Arabic", "ara": "Arabic", "da": "Danish",
    "dan": "Danish", "de": "German", "deu": "German", "ger": "German", "es": "Spanish",
    "spa": "Spanish", "fr": "French", "fra": "French", "fre": "French", "pt": "Portuguese",
    "por": "Portuguese", "nl": "Dutch", "it": "Italian", "tr": "Turkish",
}  # fmt: skip
_PREFIX = re.compile(
    r"^\s*(?:\[([a-z]{2,4})\]|\|([a-z]{2,4})\||([a-z]{2,4})\s*[:|])\s*", re.IGNORECASE
)


def region_of(name: str, group: str) -> str:
    """The country a channel is for, from its category ("United Kingdom - Sky…", "UK| …")
    or a prefix on its name ("DE : Sky Sport 1")."""
    for region in set(COUNTRIES.values()):
        if group.lower().startswith(region.lower()):
            return region
    for text in (group, name):
        m = _PREFIX.match(text or "")
        code = m and next(g for g in m.groups() if g)
        if code and code.lower() in COUNTRIES:
            return COUNTRIES[code.lower()]
    if re.search(r"arab|عرب|bein|ssc|alkass|shahid", f"{name} {group}", re.IGNORECASE):
        return "Arabic / MENA"
    return "International"


def language_of(name: str, group: str, region: str, explicit: str = "") -> str:
    if explicit.strip():
        return LANG_CODES.get(explicit.strip().lower(), explicit.strip().title())
    text = f"{name} {group}"
    if re.search(r"\b(?:french|fran[cç]ais)\b|\bFR\b\s*$", name, re.IGNORECASE):
        return "French"
    if re.search(r"\b(?:english|eng)\b|\bEN\b\s*$", name, re.IGNORECASE):
        return "English"
    if re.search(r"arabi|عربي|بالعربي", text, re.IGNORECASE):
        return "Arabic"
    return REGION_LANGUAGE.get(region, "Unspecified")


def quality_of(name: str) -> str:
    if re.search(r"\b(?:[468]\s*k|uhd)\b", name, re.IGNORECASE):
        return "4K"
    if re.search(r"\b(?:fhd|1080[pi]?)\b", name, re.IGNORECASE):
        return "1080p"
    if re.search(r"\bhd\b", name, re.IGNORECASE):
        return "HD"
    if re.search(r"\bsd\b", name, re.IGNORECASE):
        return "SD"
    return "Auto"


# ---- channel names, for matching against TV guides -----------------------------------------

_NOISE = {
    "hd", "fhd", "uhd", "sd", "hevc", "h265", "h264", "4k", "6k", "8k", "vip", "raw", "fps",
    "50fps", "60fps", "backup", "digital", "mono", "logos", "new", "tv", "channel", "plus",
    "bein.com", "com", "d", "hdr", "only", "multi", "audio",
}  # fmt: skip
_ALIASES = [  # applied in order to the space-separated, lower-case name
    (r"\bsky sp\b", "sky sports"),
    (r"\bsky sport\b", "sky sports"),
    (r"\bmain ev\b", "main event"),
    (r"\bbox off\b", "box office"),
    (r"\bboxoffice\b", "box office"),
    (r"\bsky sports pl\b", "sky sports premier league"),
    (r"\btnt sport\b", "tnt sports"),
    (r"\bbein sport\b", "bein sports"),
    (r"\bbeinsports\b", "bein sports"),
    (r"\bbein sports ([0-9]+) en\b", r"bein sports \1 english"),
    (r"\bbein sports ([0-9]+) fr\b", r"bein sports \1 french"),
    (r"\bss\b", "supersport"),
]


def channel_key(name: str) -> str:
    """A channel name reduced to what identifies it: 'UK: SKY SPORTS MAIN EVENT UHD' and the
    guide's 'SkySpMainEvHD' both become 'sky sports main event'."""
    text = unicodedata.normalize("NFKD", name or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", text)
    text = _PREFIX.sub(" ", text)
    text = re.sub(r"(?i)(?<![a-z])be\s*in(?=[\s_.-]*sport)", "Bein ", text)  # not "be IN"
    text = re.sub(r"(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])", " ", text)
    text = re.sub(r"[_.\-+:|/]+", " ", text.lower())
    text = re.sub(r"\b([0-9]+) k\b", r"\1k", text)  # "4 K" from the digit split → "4k"
    words = [w for w in re.sub(r"[^\w ]+", " ", text).split() if w not in _NOISE]
    text = " ".join(words)
    for pattern, replacement in _ALIASES:
        text = re.sub(pattern, replacement, text)
    return re.sub(r"\s+", " ", text).strip()


def channel_id(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:24]


def describe(name: str, group: str, url: str, **extra) -> dict:
    region = region_of(name, group)
    return {
        "id": channel_id(url),
        "name": name.strip(),
        "group": group.strip() or "Other channels",
        "url": url,
        "logo": extra.get("logo") or None,
        "epgId": extra.get("epg_id") or None,
        "streamId": extra.get("stream_id"),
        "quality": quality_of(name),
        "region": region,
        "language": language_of(name, group, region, extra.get("language") or ""),
        "competitions": competition_ids(f"{name} {group}"),
    }


# ---- playlists ---------------------------------------------------------------------------

_ATTR = re.compile(r"([\w-]+)\s*=\s*\"([^\"]*)\"")


def parse_m3u(text: str) -> tuple[list[dict], dict]:
    """Channels from an extended M3U playlist, plus its header attributes (url-tvg…)."""
    text = text.lstrip("﻿")
    if not text.lstrip().startswith("#EXTM3U"):
        raise ValueError("That is not an extended M3U playlist (it must start with #EXTM3U)")
    channels, header, pending, seen = [], {}, None, set()
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("#EXTM3U"):
            header = {k.lower(): v for k, v in _ATTR.findall(line)}
        elif line.startswith("#EXTINF:"):
            attrs = {k.lower(): v for k, v in _ATTR.findall(line)}
            # The name follows the first comma that is not inside a quoted attribute.
            name = re.sub(r"\"[^\"]*\"", "", line).split(",", 1)
            pending = (attrs, (name[1] if len(name) > 1 else attrs.get("tvg-name", "")).strip())
        elif line and not line.startswith("#") and pending:
            attrs, name = pending
            pending = None
            if not re.match(r"^https?://", line, re.IGNORECASE) or not name or line in seen:
                continue
            seen.add(line)
            channels.append(
                describe(
                    name,
                    attrs.get("group-title", ""),
                    line,
                    logo=attrs.get("tvg-logo"),
                    epg_id=attrs.get("tvg-id"),
                    language=attrs.get("tvg-language", ""),
                )
            )
    if not channels:
        raise ValueError("The playlist has no http(s) channels")
    return channels, header


SPORT_GROUPS = re.compile(
    r"sport|bein|dazn|espn|eurosport|sky\s*sp|tnt|arena|ssc|alkass|ppv|events?\b|\bf1\b|nba|nfl"
    r"|nhl|ufc|wwe|racing|golf|tennis|cricket|football|soccer|liga|premier|rugby|boxing"
    r"|رياض",
    re.IGNORECASE,
)
ADULT = re.compile(r"adult|xxx|18\+|porn", re.IGNORECASE)


def xtream_account(url: str) -> dict | None:
    """The account an Xtream stream URL (/live/user/pass/id.ts) belongs to."""
    p = urlparse(url)
    parts = p.path.strip("/").split("/")
    if len(parts) == 4 and parts[0] == "live" and p.hostname:
        port = f":{p.port}" if p.port else ""
        return {
            "server": f"{p.scheme}://{p.hostname}{port}",
            "username": parts[1],
            "password": parts[2],
        }
    return None


# ---- the channel list ----------------------------------------------------------------------


class Catalog:
    """The imported channels, saved as catalog.json in the live TV folder."""

    def __init__(self, folder: Path, client: httpx.Client | None = None):
        self.folder = Path(folder)
        self.path = self.folder / "catalog.json"
        self.client = client or httpx.Client(
            timeout=30, follow_redirects=True, headers={"User-Agent": AGENT}
        )
        self.lock = threading.Lock()
        self.data: dict = {}
        self.by_id: dict[str, dict] = {}
        self._account: tuple[float, dict] | None = None
        self.load()

    def load(self):
        try:
            self.data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.data = {}
        self.data.setdefault("channels", [])
        for c in self.data["channels"]:  # v2 files predate some fields
            c.setdefault("region", region_of(c["name"], c.get("group", "")))
            c.setdefault("quality", quality_of(c["name"]))
            # Always re-derived, so improvements apply to channels imported earlier; only a
            # language the playlist itself stated is kept.
            c["competitions"] = competition_ids(f"{c['name']} {c.get('group', '')}")
            if c.get("languageSource") != "playlist":
                c["language"] = language_of(c["name"], c.get("group", ""), c["region"])
        self.by_id = {c["id"]: c for c in self.data["channels"]}

    def _save(self):
        self.folder.mkdir(parents=True, exist_ok=True)
        partial = self.path.with_suffix(".part")
        partial.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")
        os.replace(partial, self.path)
        try:
            os.chmod(self.path, 0o600)  # it holds the provider's password
        except OSError:
            pass

    @property
    def channels(self) -> list[dict]:
        return self.data["channels"]

    @property
    def max_connections(self) -> int:
        return max(1, int(self.data.get("maxConnections") or 1))

    def set_max_connections(self, value: int):
        with self.lock:
            self.data["maxConnections"] = max(1, min(20, int(value)))
            self._save()

    def account(self) -> dict | None:
        """The Xtream login, saved at import or recovered from the channel URLs (v2)."""
        if self.data.get("xtream"):
            return self.data["xtream"]
        return next(
            (a for a in map(xtream_account, (c["url"] for c in self.channels[:1])) if a), None
        )

    def replace(self, channels: list[dict], name: str, **extra):
        with self.lock:
            keep = {k: self.data[k] for k in ("maxConnections",) if k in self.data}
            self.data = {
                "channels": channels,
                "name": name,
                "importedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                **keep,
                **extra,
            }
            self.by_id = {c["id"]: c for c in channels}
            self._account = None
            self._save()

    def import_m3u(self, text: str, name: str = "Playlist") -> int:
        channels, header = parse_m3u(text)
        guide = header.get("url-tvg") or header.get("x-tvg-url") or ""
        self.replace(channels, name, guideUrl=guide.split(",")[0].strip() or None)
        return len(channels)

    def _player_api(self, account: dict, **params) -> object:
        query = urlencode(
            {"username": account["username"], "password": account["password"], **params}
        )
        response = self.client.get(f"{account['server']}/player_api.php?{query}")
        if response.status_code in (401, 403):
            raise ValueError("The provider refused that username and password")
        response.raise_for_status()
        try:
            return response.json()
        except ValueError as error:
            raise ValueError("The server did not answer like an Xtream Codes provider") from error

    def import_xtream(
        self, server: str, username: str, password: str, everything: bool = False
    ) -> int:
        server = server.strip().rstrip("/")
        if not re.match(r"^https?://[^/\s]+$", server):
            raise ValueError("Enter the server as http(s)://host:port, without a path")
        account = {"server": server, "username": username.strip(), "password": password.strip()}
        info = self._player_api(account)
        user = info.get("user_info") if isinstance(info, dict) else None
        if not user or str(user.get("auth")) != "1":
            raise ValueError("The provider refused that username and password")
        categories = {
            str(c.get("category_id")): c.get("category_name") or ""
            for c in self._player_api(account, action="get_live_categories") or []
        }
        channels, seen = [], set()
        for s in self._player_api(account, action="get_live_streams") or []:
            group = categories.get(str(s.get("category_id")), "")
            name = (s.get("name") or "").strip()
            if not name or ADULT.search(f"{name} {group}"):
                continue
            if not everything and not SPORT_GROUPS.search(f"{group} {name}"):
                continue
            url = f"{server}/live/{account['username']}/{account['password']}/{s['stream_id']}.ts"
            if url in seen:
                continue
            seen.add(url)
            channels.append(
                describe(
                    name,
                    group,
                    url,
                    logo=s.get("stream_icon"),
                    epg_id=s.get("epg_channel_id"),
                    stream_id=str(s["stream_id"]),
                )
            )
        if not channels:
            raise ValueError("The provider returned no matching channels")
        allowed = int(user.get("max_connections") or 1)
        self.replace(
            channels,
            f"{urlparse(server).hostname} ({'all' if everything else 'sports'} channels)",
            xtream=account,
            guideUrl=f"{server}/xmltv.php?"
            + urlencode({"username": account["username"], "password": account["password"]}),
        )
        self.set_max_connections(allowed)
        return len(channels)

    def status(self) -> dict:
        """The provider account as the provider reports it (cached for ten minutes)."""
        account = self.account()
        if not account:
            return {"kind": "m3u" if self.channels else None}
        if self._account and time.time() - self._account[0] < 600:
            return self._account[1]
        try:
            user = self._player_api(account).get("user_info") or {}
            expires = user.get("exp_date")
            result = {
                "kind": "xtream",
                "server": urlparse(account["server"]).hostname,
                "active": str(user.get("auth")) == "1" and user.get("status") == "Active",
                "status": user.get("status") or "Unknown",
                "expires": int(expires) if str(expires or "").isdigit() else None,
                "max_connections": int(user.get("max_connections") or 1),
                "active_connections": int(user.get("active_cons") or 0),
            }
        except (httpx.HTTPError, ValueError, AttributeError) as error:
            result = {"kind": "xtream", "server": urlparse(account["server"]).hostname,
                      "active": False, "status": "Unreachable", "error": str(error)[:200]}  # fmt: skip
        self._account = (time.time(), result)
        return result

    def search(self, q: str = "", language: str = "", limit: int = 60, offset: int = 0) -> dict:
        # Every word must appear in the name as written, its matching form ("sky sp" → "sky
        # sports"), the category or the language.
        fold = lambda t: " ".join(re.sub(r"[^\w]+", " ", t.lower()).split())
        words = set(fold(q).split()) | set(channel_key(q).split()) if q.strip() else set()
        hits = []
        for c in self.channels:
            if language and c.get("language") != language:
                continue
            hay = " ".join(
                (fold(c["name"]), channel_key(c["name"]), fold(c.get("group", "")),
                 (c.get("language") or "").lower())
            )  # fmt: skip
            if all(w in hay for w in words):
                hits.append(c)
        order = {"4K": 0, "1080p": 1, "HD": 2, "Auto": 3, "SD": 4}
        hits.sort(key=lambda c: (order.get(c.get("quality"), 3), c["name"].lower()) if words else 0)
        return {"total": len(hits), "channels": [public(c) for c in hits[offset : offset + limit]]}

    def languages(self) -> list[dict]:
        counts: dict[str, int] = {}
        for c in self.channels:
            counts[c.get("language") or "Unspecified"] = (
                counts.get(c.get("language") or "Unspecified", 0) + 1
            )
        return [{"name": k, "count": v} for k, v in sorted(counts.items(), key=lambda kv: -kv[1])]


def public(c: dict) -> dict:
    """What a browser may see of a channel: never its URL."""
    return {
        "id": c["id"],
        "name": c["name"],
        "group": c.get("group"),
        "logo": f"/api/live/logo/{c['id']}" if c.get("logo") else None,
        "quality": c.get("quality"),
        "language": c.get("language"),
        "region": c.get("region"),
        "competitions": c.get("competitions") or [],
    }


# ---- live streams ---------------------------------------------------------------------------


@dataclass
class Stream:
    id: str
    channel: dict
    dir: Path
    video: str  # "copy" or "encode"
    reasons: list[str]
    info: dict
    viewers: dict = field(default_factory=dict)  # viewer key -> last ping
    interlaced: bool = False
    process: subprocess.Popen | None = None
    started: float = field(default_factory=time.time)
    restarts: int = 0
    error: str | None = None
    stopped: bool = False

    def public(self) -> dict:
        return {
            "id": self.id,
            "channel": public(self.channel),
            "video": self.video,
            "viewers": len(self.viewers),
            "age": int(time.time() - self.started),
            "restarts": self.restarts,
            "error": self.error,
        }


def live_command(
    ffmpeg: str, url: str, info: dict, video: str, hwaccel: str, device: str, interlaced: bool,
    resume: bool = False,
) -> list:  # fmt: skip
    v = info["video"][0] if info.get("video") else None
    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "warning", "-y"]
    pre, out = [], ["-c:v", "copy"]
    if video == "encode" and v:
        pre, out = media.video_encode_args(v, min(v["height"] or 1080, 1080), hwaccel, device)
        if interlaced:  # one picture per field: 1080i50 becomes smooth 50 fps, as sport needs
            vf = out.index("-vf") + 1
            if hwaccel == "qsv":
                out[vf] = out[vf].replace("vpp_qsv=", "vpp_qsv=deinterlace=2:")
            elif hwaccel == "vaapi":
                out[vf] = out[vf].replace(
                    "scale_vaapi=", "deinterlace_vaapi=rate=field,scale_vaapi="
                )
            else:
                out[vf] = "yadif=1:-1:0," + out[vf]
        if "libx264" in out:  # live has to keep up: veryfast at 50 fps barely does on 8 cores
            out[out.index("-preset") + 1] = "superfast"
        out = [x for x in out if not x.startswith("expr:gte(t")]  # keyframes follow -g live
        if "-force_key_frames" in out:
            out.remove("-force_key_frames")
    cmd += [
        *pre,
        "-user_agent",
        AGENT,
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_on_network_error",
        "1",
        "-reconnect_delay_max",
        "5",
        "-rw_timeout",
        "15000000",
        "-fflags",
        "+genpts+discardcorrupt",
        "-i",
        url,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        *out,
    ]
    audio = info["audio"][0] if info.get("audio") else None
    if audio and audio["codec"] == "aac" and (audio.get("channels") or 2) <= 2:
        cmd += ["-c:a", "copy"]
    else:
        cmd += ["-c:a", "aac", "-ac", "2", "-b:a", "192k"]
    cmd += [
        "-sn",
        "-dn",
        "-max_muxing_queue_size",
        "4096",
        "-f",
        "hls",
        "-hls_time",
        str(SEGMENT_SECONDS),
        "-hls_list_size",
        str(WINDOW_SEGMENTS),
        "-hls_segment_type",
        "mpegts",
        "-hls_flags",
        # After a provider hiccup FFmpeg restarts and carries on in the same playlist, marking
        # the join so players reset their clocks.
        "delete_segments+omit_endlist+temp_file" + ("+append_list+discont_start" if resume else ""),
        "-hls_delete_threshold",
        "3",
        "-hls_segment_filename",
        "seg%06d.ts",
        "index.m3u8",
    ]
    return cmd


class Busy(media.Busy):
    pass


class Streams:
    """One FFmpeg per channel being watched, shared by everyone watching it."""

    def __init__(
        self,
        catalog: Catalog,
        ffmpeg: str,
        ffprobe: str,
        runtime: Path,
        hwaccel: str = "none",
        transcodes=None,
        max_transcodes: int = 2,
        device: str = "/dev/dri/renderD128",
    ):
        self.catalog, self.ffmpeg, self.ffprobe = catalog, ffmpeg, ffprobe
        self.root = Path(runtime) / "live"
        self.hwaccel, self.device = hwaccel, device
        self.transcodes = transcodes or (lambda: 0)  # encodes running for library playback
        self.max_transcodes = max_transcodes
        self.items: dict[str, Stream] = {}
        self.probes: dict[str, tuple[float, dict, bool]] = {}
        self.lock = threading.RLock()
        shutil.rmtree(self.root, ignore_errors=True)
        self.root.mkdir(parents=True, exist_ok=True)
        self.stopping = threading.Event()
        threading.Thread(target=self._reaper, name="mediawan-live", daemon=True).start()

    # -- probing --

    def probe(self, channel: dict) -> tuple[dict, bool]:
        """What the channel sends, and whether it is interlaced. Remembered for six hours,
        so switching back to a channel starts faster."""
        cached = self.probes.get(channel["id"])
        if cached and time.time() - cached[0] < PROBE_SECONDS:
            return cached[1], cached[2]
        try:
            result = subprocess.run(
                [self.ffprobe, "-v", "error", "-user_agent", AGENT, "-rw_timeout", "10000000",
                 "-analyzeduration", "3000000", "-probesize", "3000000",
                 # A few decoded frames: broadcasts only reveal interlacing frame by frame.
                 "-read_intervals", "%+#30",
                 "-show_entries", "stream:format:frame=media_type,interlaced_frame",
                 "-of", "json", channel["url"]],
                capture_output=True,
                timeout=25,
            )  # fmt: skip
        except subprocess.TimeoutExpired as error:
            raise media.Busy("The channel did not answer in time. Try another one.") from error
        if result.returncode != 0:
            tail = result.stderr.decode(errors="replace").replace(channel["url"], "<channel>")
            if "403" in tail or "Forbidden" in tail:
                raise media.Busy(
                    "The provider refused this channel. Its connection may be in use elsewhere, "
                    "or the channel is off the air."
                )
            raise media.Busy("This channel is not broadcasting right now")
        raw = json.loads(result.stdout or b"{}")
        info = media.summarise(raw)
        if not info["video"]:
            raise media.Busy("This channel is not sending any video")
        stream = next((s for s in raw.get("streams", []) if s.get("codec_type") == "video"), {})
        frames = [f for f in raw.get("frames", []) if f.get("media_type") == "video"]
        interlaced = stream.get("field_order") in ("tt", "bb", "tb", "bt") or (
            bool(frames)
            and sum(int(f.get("interlaced_frame") or 0) for f in frames) * 2 > len(frames)
        )
        self.probes[channel["id"]] = (time.time(), info, interlaced)
        return info, interlaced

    # -- watching --

    def watch(self, channel_id: str, viewer: str, deinterlaces: bool = False) -> Stream:
        """Join the channel's stream, starting it if nobody is watching. deinterlaces: the
        screen does it in hardware (TVs), so interlaced broadcasts can be copied."""
        channel = self.catalog.by_id.get(channel_id)
        if not channel:
            raise KeyError(channel_id)
        with self.lock:
            stream = self._for_channel(channel_id)
            if stream:
                stream.viewers[viewer] = time.time()
                self._leave_others(viewer, keep=stream.id)
                return stream
            # Switching channel frees this viewer's old one first.
            freed = self._leave_others(viewer)
            self._check_limit()
        try:
            if freed:
                time.sleep(1)  # providers take a moment to notice a dropped connection
            info, interlaced = self.probe(channel)
        except media.Busy:
            time.sleep(2)  # one more try: the provider may still count the old connection
            info, interlaced = self.probe(channel)
        v = info["video"][0]
        reasons = []
        video = "copy"
        if v["codec"] != "h264" or v.get("bit_depth", 8) > 8:
            video = "encode"
            reasons.append(f"{v['codec'].upper()} video is converted to H.264 for every screen")
        elif interlaced and deinterlaces:
            reasons.append("Interlaced H.264 is copied unchanged; the TV smooths it itself")
        elif interlaced:
            video = "encode"
            reasons.append(
                "The broadcast is interlaced, so it is converted to smooth 50 fps progressive video"
            )
        else:
            reasons.append("H.264 video is copied from the provider unchanged")
        if video == "encode" and self.transcodes() >= self.max_transcodes:
            raise Busy("All conversion slots are in use by other playback. Try again shortly.")
        with self.lock:
            existing = self._for_channel(channel_id)  # someone else started it while we probed
            if existing:
                existing.viewers[viewer] = time.time()
                return existing
            self._check_limit()
            sid = secrets.token_hex(8)
            folder = self.root / sid
            folder.mkdir(parents=True)
            stream = Stream(
                sid, channel, folder, video, reasons, info, {viewer: time.time()}, interlaced
            )
            self.items[sid] = stream
            self._spawn(stream)
        return stream

    def _check_limit(self):
        n = self.catalog.max_connections
        if len(self.items) >= n:
            busy = ", ".join(s.channel["name"] for s in self.items.values())
            raise Busy(
                f"Your provider allows {n} channel{'s' if n != 1 else ''} at a time and "
                f"{busy} is being watched. Join that channel, or wait until it ends."
            )

    def _for_channel(self, channel_id: str) -> Stream | None:
        return next((s for s in self.items.values() if s.channel["id"] == channel_id), None)

    def _leave_others(self, viewer: str, keep: str | None = None) -> bool:
        freed = False
        for s in list(self.items.values()):
            if s.id != keep and viewer in s.viewers:
                del s.viewers[viewer]
                if not s.viewers:
                    self.stop(s.id)
                    freed = True
        return freed

    def _spawn(self, s: Stream):
        cmd = live_command(
            self.ffmpeg, s.channel["url"], s.info, s.video, self.hwaccel, self.device,
            s.interlaced, resume=s.restarts > 0,
        )  # fmt: skip
        shown = " ".join(cmd).replace(s.channel["url"], "<channel url>")
        log.info("Live %s (%s, %s): %s", s.id, s.channel["name"], s.video, shown)
        with open(s.dir / "ffmpeg.log", "ab") as logfile:
            s.process = subprocess.Popen(
                cmd, cwd=s.dir, stdin=subprocess.DEVNULL, stdout=logfile, stderr=logfile
            )
        threading.Thread(target=self._watch_process, args=(s, s.process), daemon=True).start()

    def _watch_process(self, s: Stream, process: subprocess.Popen):
        code = process.wait()
        if s.stopped or process is not s.process:
            return
        # Providers drop connections all the time. Carry on in the same playlist, unless
        # the channel keeps failing straight away.
        recent = time.time() - s.started < 20 and s.restarts >= 2
        if s.restarts < 50 and not recent and s.viewers:
            s.restarts += 1
            log.warning("Live %s ended (code %s); reconnecting", s.id, code)
            time.sleep(2)
            if not s.stopped:
                self._spawn(s)
            return
        s.error = self._tail(s) or f"FFmpeg exited with code {code}"
        log.error("Live %s failed: %s", s.id, s.error)

    def _tail(self, s: Stream) -> str:
        try:
            text = (s.dir / "ffmpeg.log").read_text(errors="replace").strip()
        except OSError:
            return ""
        return self.scrub("\n".join(text.splitlines()[-4:]), s.channel["url"])

    def scrub(self, text: str, url: str = "") -> str:
        """FFmpeg's messages without the provider's login (it can print redirected URLs)."""
        text = text.replace(url, "<channel>") if url else text
        account = self.catalog.account() or {}
        for secret in (account.get("password"), account.get("username")):
            if secret and len(secret) >= 4:
                text = text.replace(secret, "…")
        return text

    def get(self, sid: str, viewer: str | None = None) -> Stream | None:
        s = self.items.get(sid)
        if s and viewer:
            s.viewers[viewer] = time.time()
        return s

    def leave(self, sid: str, viewer: str):
        with self.lock:
            s = self.items.get(sid)
            if s and s.viewers.pop(viewer, None) is not None and not s.viewers:
                self.stop(sid)

    def stop(self, sid: str):
        with self.lock:
            s = self.items.pop(sid, None)
        if not s:
            return
        s.stopped = True
        if s.process and s.process.poll() is None:
            s.process.kill()
            try:
                s.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        shutil.rmtree(s.dir, ignore_errors=True)

    def stop_all(self):
        self.stopping.set()
        for sid in list(self.items):
            self.stop(sid)

    def cleanup(self, idle: float = VIEWER_SECONDS) -> int:
        cutoff, stopped = time.time() - idle, 0
        with self.lock:
            for s in list(self.items.values()):
                for viewer, seen in list(s.viewers.items()):
                    if seen < cutoff:
                        del s.viewers[viewer]
                if not s.viewers:
                    log.info("Nobody is watching %s any more", s.channel["name"])
                    self.stop(s.id)
                    stopped += 1
        return stopped

    def _reaper(self):
        while not self.stopping.wait(10):
            try:
                self.cleanup()
            except Exception:  # keep the thread alive
                log.exception("Live cleanup failed")

    def wait_ready(self, s: Stream, timeout: float = 30) -> bool:
        """True once the playlist holds two segments: enough for a player to start smoothly."""
        deadline = time.time() + timeout
        playlist = s.dir / "index.m3u8"
        while time.time() < deadline:
            if s.error or s.stopped:
                return False
            try:
                if playlist.read_text(errors="ignore").count("#EXTINF") >= 2:
                    return True
            except OSError:
                pass
            time.sleep(0.25)
        return False
