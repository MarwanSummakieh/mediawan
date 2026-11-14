"""The sports schedule: fixtures from ESPN, and which of your channels show them.

Two sources, because neither is enough alone:

- Fixtures come from ESPN's public scoreboard (no key): every match in the leagues below with
  its kick-off, teams, crests and live score. It says nothing about European or Arabic TV.
- TV guides (XMLTV, by default the free epgshare01 guides for the UK, Germany, the Netherlands
  and beIN) say what each channel broadcasts. Guide channels are matched to the provider's
  channels by name and country; a fixture is "on" a channel when a programme around kick-off
  names its teams. Live programmes the fixtures do not know (MotoGP, cricket, racing…) are
  listed from the guides alone.

Channels that merely carry a competition (a "Sky Sport Bundesliga 3") are offered as
"may show it" when no guide confirms which one has the match.
"""

import bisect
import gzip
import json
import logging
import os
import re
import tempfile
import threading
import time
import unicodedata
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import httpx

from . import live

log = logging.getLogger("mediawan.sports")

EPGSHARE = "https://epgshare01.online/epgshare01/epg_ripper_{}.xml.gz"
DEFAULT_GUIDES = [EPGSHARE.format(c) for c in ("UK1", "DE1", "NL1", "BEIN1")]
ESPN = "https://site.api.espn.com/apis/site/v2/sports/{}/scoreboard?dates={}"
# ESPN path, competition id (live.COMPETITIONS), hours a broadcast usually lasts
LEAGUES = [
    ("soccer/eng.1", "premier-league", 2),
    ("soccer/esp.1", "la-liga", 2),
    ("soccer/ger.1", "bundesliga", 2),
    ("soccer/ita.1", "serie-a", 2),
    ("soccer/fra.1", "ligue-1", 2),
    ("soccer/uefa.champions", "champions-league", 2),
    ("soccer/uefa.europa", "europa-league", 2),
    ("soccer/uefa.europa.conf", "conference-league", 2),
    ("soccer/ksa.1", "saudi-pro-league", 2),
    ("soccer/den.1", "superliga", 2),
    ("soccer/ned.1", "eredivisie", 2),
    ("soccer/tur.1", "super-lig", 2),
    ("soccer/por.1", "primeira-liga", 2),
    ("soccer/eng.fa", "fa-cup", 2),
    ("soccer/eng.league_cup", "league-cup", 2),
    ("basketball/nba", "nba", 2.5),
    ("football/nfl", "nfl", 3.5),
    ("hockey/nhl", "nhl", 2.5),
    ("racing/f1", "formula-1", 2),
    ("mma/ufc", "combat", 5),
]
GUIDE_EVERY = 6 * 3600
GUIDE_BEHIND, GUIDE_AHEAD = 12 * 3600, 4 * 86400  # programmes kept around now
LIVE_RE = re.compile(
    r"\blive\b|\bLIVE\b|مباشر|en direct|en vivo|\bdirecto\b|\bdirekt\b", re.IGNORECASE
)
NOT_LIVE_RE = re.compile(
    r"highlight|replay|review|magazine|preview|classic|rewind|repeat|best of|news|reloaded"
    r"|\bshow\b|studio|daily|weekly|goals|countdown|build-up|ملخص|إعادة|اعادة",
    re.IGNORECASE,
)


def _fold(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    return " " + " ".join(re.sub(r"[^\w]+", " ", text).split()) + " "


def _xmltv_time(value: str) -> float | None:
    m = re.match(r"(\d{14})\s*([+-]\d{4})?", value or "")
    if not m:
        return None
    moment = datetime.strptime(m.group(1), "%Y%m%d%H%M%S")
    offset = m.group(2) or "+0000"
    sign = 1 if offset[0] == "+" else -1
    tz = timezone(sign * timedelta(hours=int(offset[1:3]), minutes=int(offset[3:5])))
    return moment.replace(tzinfo=tz).timestamp()


def guide_region(channel_id: str) -> str | None:
    """The country a guide channel id is for: 'SkySp.PL.HD.uk' → United Kingdom."""
    suffix = channel_id.rsplit(".", 1)[-1].lower() if "." in channel_id else ""
    if suffix == "bein":
        return "Arabic / MENA"
    return live.COUNTRIES.get(suffix)


def guide_keys(channel_id: str, names: list[str]) -> set[str]:
    stem = channel_id.rsplit(".", 1)[0] if guide_region(channel_id) else channel_id
    stem = re.sub(r"(?i)[_.-](AR|EN)$", "", stem)  # beIN's guide language, not the channel's
    keys = {live.channel_key(stem)}
    for n in names:
        keys.add(live.channel_key(re.sub(r"(?i)[_.-](AR|EN)$", "", n or "")))
    return {k for k in keys if k}


def regions_fit(provider: str, guide: str | None) -> bool:
    return guide is None or provider in (guide, "International")


# ---- TV guides ---------------------------------------------------------------------------


class Guide:
    """Programmes for the provider's channels, merged from every guide and saved in guide.json."""

    def __init__(self, folder: Path, catalog: "live.Catalog", sources: list[str], client=None):
        self.folder, self.catalog = Path(folder), catalog
        self.sources = sources
        self.path = self.folder / "guide.json"
        self.client = client or httpx.Client(
            timeout=httpx.Timeout(30, read=120), follow_redirects=True,
            headers={"User-Agent": "Mediawan/3 (+https://github.com/)"},
        )  # fmt: skip
        self.lock = threading.Lock()
        self.running = False
        self.data: dict = {}
        try:
            self.data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.data = {}
        if "programmes" not in self.data:  # v2's guide.json has another shape: start afresh
            self.data = {"programmes": {}, "updated": 0, "sources": []}

    def all_sources(self) -> list[str]:
        own = self.catalog.data.get("guideUrl")
        return [*self.sources, *([own] if own else [])]

    def stale(self) -> bool:
        return time.time() - float(self.data.get("updated") or 0) > GUIDE_EVERY

    def programmes(self, channel_id: str) -> list[list]:
        return self.data["programmes"].get(channel_id, [])

    def now(self, channel_id: str, at: float | None = None) -> dict | None:
        at = at or time.time()
        for start, stop, title, desc in self.programmes(channel_id):
            if start <= at < stop:
                return {"start": start, "stop": stop, "title": title, "desc": desc}
        return None

    def refresh(self) -> dict:
        with self.lock:
            if self.running:
                return self.data
            self.running = True
        try:
            return self._refresh()
        finally:
            self.running = False

    def _refresh(self) -> dict:
        index: dict[str, list[dict]] = {}
        by_epg: dict[str, list[dict]] = {}
        for c in self.catalog.channels:
            index.setdefault(live.channel_key(c["name"]), []).append(c)
            if c.get("epgId"):
                by_epg.setdefault(c["epgId"], []).append(c)
        programmes: dict[str, dict[float, list]] = {}
        report = []
        lo, hi = time.time() - GUIDE_BEHIND, time.time() + GUIDE_AHEAD
        for url in self.all_sources():
            shown = re.sub(r"(username|password)=[^&]+", r"\1=…", url)
            try:
                matched, count = self._read(url, index, by_epg, programmes, lo, hi)
                report.append({"url": shown, "ok": True, "channels": matched, "programmes": count})
            except (httpx.HTTPError, OSError, EOFError, ET.ParseError, ValueError) as error:
                # One broken guide must not lose the others.
                # httpx puts the full URL in its messages; the provider's has the password.
                reason = str(error).replace(url, shown).split("\n")[0]
                reason = re.sub(r"(username|password)=[^&'\s]+", r"\1=…", reason)
                log.warning("Guide %s failed: %s", shown, reason)
                report.append({"url": shown, "ok": False, "error": reason[:200]})
        self.data = {
            "updated": time.time(),
            "sources": report,
            "programmes": {
                cid: sorted(by_start.values(), key=lambda p: p[0])
                for cid, by_start in programmes.items()
            },
        }
        self.folder.mkdir(parents=True, exist_ok=True)
        partial = self.path.with_suffix(".part")
        partial.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")
        os.replace(partial, self.path)
        log.info(
            "Guide refreshed: %d channels have programmes",
            len(self.data["programmes"]),
        )
        return self.data

    def _read(self, url, index, by_epg, programmes, lo, hi) -> tuple[int, int]:
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "guide"
            with self.client.stream("GET", url) as response:
                response.raise_for_status()
                with open(raw, "wb") as out:
                    out.writelines(response.iter_bytes(1 << 16))
            with open(raw, "rb") as f:
                gz = f.read(2) == b"\x1f\x8b"
            matches: dict[str, list[str]] = {}
            count = 0
            with (gzip.open if gz else open)(raw, "rb") as source:
                for _, el in ET.iterparse(source):
                    if el.tag == "channel":
                        gid = el.get("id") or ""
                        names = [d.text or "" for d in el.findall("display-name")]
                        region = guide_region(gid)
                        found = {c["id"] for c in by_epg.get(gid, [])}
                        for key in guide_keys(gid, names):
                            found |= {
                                c["id"]
                                for c in index.get(key, [])
                                if regions_fit(c.get("region") or "International", region)
                            }
                        if found:
                            matches[gid] = sorted(found)
                        el.clear()
                    elif el.tag == "programme":
                        targets = matches.get(el.get("channel") or "")
                        start, stop = _xmltv_time(el.get("start")), _xmltv_time(el.get("stop"))
                        if targets and start and stop and stop > lo and start < hi:
                            title = (el.findtext("title") or "").strip()
                            desc = (el.findtext("desc") or "").strip()[:300]
                            for cid in targets:
                                slot = programmes.setdefault(cid, {})
                                # The same match from two guides (beIN in Arabic and English):
                                # keep the English title, it is the one fixtures can match.
                                if start not in slot or re.search(r"[a-z]", title, re.IGNORECASE):
                                    slot[start] = [start, stop, title, desc]
                            count += 1
                        el.clear()
            return len(matches), count


# ---- fixtures ------------------------------------------------------------------------------


class Fixtures:
    def __init__(self, client=None, leagues=LEAGUES):
        self.client = client or httpx.Client(timeout=15, follow_redirects=True)
        self.leagues = leagues
        self.cache: dict[str, tuple[float, list]] = {}
        self.lock = threading.Lock()

    def day(self, day: str) -> list[dict]:
        """Every fixture ESPN files under this date (YYYYMMDD, US time)."""
        today = datetime.now(UTC).strftime("%Y%m%d")
        ttl = 300 if abs(int(day) - int(today)) <= 1 else 3 * 3600
        hit = self.cache.get(day)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        with ThreadPoolExecutor(len(self.leagues)) as pool:
            parts = list(pool.map(lambda lg: self._league(lg, day), self.leagues))
        events = [e for part in parts for e in part]
        with self.lock:
            self.cache[day] = (time.time(), events)
            for old in [k for k, v in self.cache.items() if time.time() - v[0] > 86400]:
                del self.cache[old]
        return events

    def _league(self, league: tuple, day: str) -> list[dict]:
        path, cid, hours = league
        try:
            response = self.client.get(ESPN.format(path, day))
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as error:
            log.info("Fixtures for %s on %s unavailable: %s", path, day, error)
            return []
        league_name = ((data.get("leagues") or [{}])[0]).get("name") or ""
        out = []
        for e in data.get("events") or []:
            sessions = e.get("competitions") or [{}]
            # A race weekend is several sessions; anything else is one event.
            for comp in sessions if path.startswith("racing/") else sessions[:1]:
                when = comp.get("date") or e.get("date")
                try:
                    start = datetime.fromisoformat(when).timestamp()
                except (AttributeError, ValueError):
                    continue
                status = (comp.get("status") or e.get("status") or {}).get("type") or {}
                teams = []
                for t in comp.get("competitors") or []:
                    team = t.get("team") or {}
                    if not team:
                        continue
                    teams.append(
                        {
                            "name": team.get("displayName") or team.get("name") or "",
                            "short": team.get("shortDisplayName") or "",
                            "nickname": team.get("name") or "",
                            "logo": team.get("logo"),
                            "score": t.get("score") if status.get("state") != "pre" else None,
                            "home": t.get("homeAway") == "home",
                        }
                    )
                teams.sort(key=lambda t: not t["home"])  # home side first
                session = (
                    ((comp.get("type") or {}).get("abbreviation") or "")
                    if path.startswith("racing/")
                    else ""
                )
                title = (
                    f"{teams[0]['name']} v {teams[1]['name']}"
                    if len(teams) == 2
                    else e.get("name") or league_name
                )
                out.append(
                    {
                        "id": f"espn:{e.get('id')}" + (f":{comp.get('id')}" if session else ""),
                        "title": title + (f" · {session}" if session else ""),
                        "competition": cid,
                        "league": league_name,
                        "start": start,
                        "end": start + hours * 3600 if session in ("", "Race") else start + 3600,
                        "state": {"pre": "upcoming", "in": "live", "post": "finished"}.get(
                            status.get("state"), "upcoming"
                        ),
                        "detail": status.get("shortDetail") or "",
                        "teams": teams if len(teams) == 2 else [],
                    }
                )
        return out


# ---- the schedule ----------------------------------------------------------------------------


# Checked in order: the first sport whose words appear in a programme's title or description.
SPORT_WORDS = [
    ("Basketball", r"basket|euroleague|eurocup|\bnba\b|\bbbl\b"),
    ("Ice hockey", r"hockey|\bnhl\b|\bdel\b|\bshl\b"),
    ("American football", r"\bnfl\b|american football|college football|super bowl"),
    (
        "Motorsport",
        r"moto\s*gp|moto[23]\b|formula|\bf1\b|nascar|indycar|rally|\bdtm\b|superbike|grand prix",
    ),
    ("Tennis", r"tennis|\batp\b|\bwta\b|davis cup|billie jean"),
    ("Cricket", r"cricket|\bipl\b|test match|\bt20\b"),
    ("Rugby", r"rugby|six nations|top 14|super league"),
    ("Golf", r"\bgolf|\bpga\b|ryder cup|\bopen championship"),
    ("Combat sports", r"\bufc\b|boxing|boxen|\bmma\b|\bwwe\b|wrestling|ملاكمة"),
    (
        "Football",
        (
            r"football|soccer|fu(?:ss|ß)ball|calcio|f[uú]tbol|voetbal|pokal|\bcup\b|copa|coppa"
            r"|liga|league|eredivisie|bundesliga|serie a|كرة القدم|الدوري"
        ),
    ),
]
_SPORT_RE = [(name, re.compile(pattern, re.IGNORECASE)) for name, pattern in SPORT_WORDS]


def sport_of(text: str) -> str | None:
    return next((name for name, pattern in _SPORT_RE if pattern.search(text or "")), None)


def _clip(text: str, n: int) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[:n].rsplit(" ", 1)[0] + "…"


def _team_names(team: dict) -> list[str]:
    names = {team["name"], team["short"]}
    if len(team.get("nickname") or "") >= 6:
        names.add(team["nickname"])
    trimmed = re.sub(r"(?i)\b(fc|afc|cf|sc|ac|club|calcio|sv|vfb|vfl|1\.)\b", " ", team["name"])
    names.add(trimmed)
    return [f for f in (_fold(n) for n in names if n) if len(f.strip()) >= 4]


def _mentions(text: str, team: dict) -> bool:
    return any(name in text for name in _team_names(team))


def _rank(channel: dict, language: str) -> tuple:
    order = {"4K": 0, "1080p": 1, "HD": 2, "Auto": 3, "SD": 4}
    return (
        channel.get("language") != language if language else 0,
        order.get(channel.get("quality"), 3),
    )


def schedule(
    guide: Guide, fixtures: Fixtures | None, catalog: "live.Catalog", start: float, end: float,
    language: str = "", now: float | None = None,
) -> list[dict]:  # fmt: skip
    now = now or time.time()
    events = []
    if fixtures:
        days = set()
        t = start - 86400  # ESPN files fixtures under US dates: look a day either side
        while t <= end + 86400:
            days.add(datetime.fromtimestamp(t, UTC).strftime("%Y%m%d"))
            t += 86400
        seen = set()
        for day in sorted(days):
            for e in fixtures.day(day):
                if e["id"] not in seen and start <= e["start"] < end:
                    seen.add(e["id"])
                    # Copies: the cached fixtures must survive this request's edits.
                    events.append(dict(e, source="fixtures", teams=[dict(t) for t in e["teams"]]))
    channels = catalog.by_id
    # Programmes that start in the asked range (plus slack), text folded once, by start time.
    window = sorted(
        (p_start, cid, p_stop, title, _fold(f"{title} {desc}"))
        for cid, progs in guide.data["programmes"].items()
        if cid in channels
        for p_start, p_stop, title, desc in progs
        if start - 6 * 3600 <= p_start < end + 3600
    )
    starts = [w[0] for w in window]
    used: set[tuple[str, float]] = set()  # guide programmes already attached to a fixture
    for e in events:
        confirmed, hit = [], set()
        if e["teams"]:
            # A broadcast starts up to 90 minutes before kick-off (build-up) or just after.
            lo = bisect.bisect_left(starts, e["start"] - 5400)
            hi = bisect.bisect_right(starts, e["start"] + 1200)
            for p_start, cid, p_stop, title, text in window[lo:hi]:
                if cid in hit or p_stop < e["start"] + 600 or NOT_LIVE_RE.search(title):
                    continue
                a, b = (_mentions(text, t) for t in e["teams"])
                if (a and b) or ((a or b) and LIVE_RE.search(title)):
                    hit.add(cid)
                    confirmed.append((channels[cid], title))
                    used.add((cid, p_start))
        ids = {c["id"] for c, _ in confirmed}
        maybe = [
            c
            for c in catalog.channels
            if e["competition"] in (c.get("competitions") or []) and c["id"] not in ids
        ]
        confirmed.sort(key=lambda x: _rank(x[0], language))
        maybe.sort(key=lambda c: _rank(c, language))
        e["channels"] = [dict(live.public(c), source="guide", programme=t) for c, t in confirmed]
        e["channels"] += [dict(live.public(c), source="competition") for c in maybe[:8]]
    # Live programmes the fixtures did not cover.
    grouped: dict[tuple[str, float], dict] = {}
    for cid, progs in guide.data["programmes"].items():
        channel = channels.get(cid)
        if not channel:
            continue
        for p_start, p_stop, title, desc in progs:
            if p_stop <= start or p_start >= end or (cid, p_start) in used:
                continue
            if p_start < start and not p_start <= now < p_stop:
                continue  # began on an earlier day: only shown here while it is still on
            if not LIVE_RE.search(title) or NOT_LIVE_RE.search(title):
                continue
            clean = re.sub(r"(?i)^\s*live\s*[:\-]?\s*|\s*[-–:]?\s*\blive\b\s*$", "", title).strip()
            key = (_fold(clean + " " + desc[:60]), p_start)
            ev = grouped.get(key)
            if not ev:
                text = f"{title} {desc}"
                sport = sport_of(text)
                # "Basketball Champions League" is basketball, whatever the name suggests.
                comps = [
                    c for c in live.competition_ids(text)
                    if sport in (None, live.competition(c)["sport"])
                ]  # fmt: skip
                ev = grouped[key] = {
                    "id": f"guide:{abs(hash(key)) % 10**12}",
                    "title": clean or title,
                    "subtitle": _clip(desc, 140),
                    "competition": comps[0] if comps else None,
                    "sport": sport,
                    "league": "",
                    "start": p_start,
                    "end": p_stop,
                    "state": "upcoming",
                    "detail": "",
                    "teams": [],
                    "channels": [],
                    "source": "guide",
                }
            ev["channels"].append(dict(live.public(channel), source="guide", programme=title))
    for ev in grouped.values():
        ev["channels"].sort(key=lambda c: _rank(c, language))
        events.append(ev)
    for e in events:
        if e["source"] == "guide" or e["state"] == "upcoming":
            e["state"] = (
                "finished" if now >= e["end"] else "live" if now >= e["start"] else "upcoming"
            )
        comp = live.competition(e["competition"]) if e["competition"] else None
        e["sport"] = comp["sport"] if comp else e.get("sport") or "Other"
        e["competition"] = comp
        for t in e["teams"]:
            t.pop("nickname", None)
            t.pop("short", None)
    events.sort(key=lambda e: (e["start"], e["title"]))
    return events
