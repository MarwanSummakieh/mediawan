"""Which torrent release of a film or episode to stream, and why.

Ported from v2 (src/release-score.mjs and src/torrent-policy.mjs), where every rule was earned
the hard way. Two stages:

  assess_stream  the hard rules. A release that fails one is never offered: a cinema capture,
                 the wrong resolution, a WEB-DL label hiding a disc rip, a different film or
                 series that shares the name (labelled with a year outside the title's own), too
                 few seeders, an absurd size.
  rank           orders what passes: an untouched WEB-DL from a known service first; re-encodes,
                 dubs, releases made for another language, upscales, Dolby-Vision-only files and
                 sign-language versions last; for a series, the release group or season pack
                 already used for the season ("season lock").

Pure functions, no I/O, so the tests can pin every rule.
"""

import math
import re

GiB = 1073741824
MiB = 1048576

SERVICES = ["HMAX", "MAX", "AMZN", "NF", "DSNP", "ATVP", "HULU", "PCOK", "PMTP", "CR"]
STREAM_RESOLUTIONS = [480, 720, 1080, 2160]
# Offered in place of 1080p when a title has nothing sound at 1080p (older series mostly).
LOWER_RESOLUTIONS = [720, 480]

RULES = {
    "min_seeders": 5,
    "movie_max_gb": 100,
    "episode_max_gb": 15,
    "reject_unknown": True,
}

# Below these sizes a "WEB-DL" label is almost always a re-encode. When the runtime is known
# the floor follows it instead (bits per second of an untouched service file), so 24-minute
# episodes are not judged against an hour-long drama.
MIN_EPISODE_BYTES = {1080: 2.5 * GiB, 2160: 5 * GiB}
MIN_MOVIE_BYTES = {1080: 4 * GiB, 2160: 10 * GiB}
MIN_BITRATE = {1080: 4.5e6, 2160: 9e6}

_I = re.IGNORECASE


def _boundary(pattern: str) -> re.Pattern:
    return re.compile(rf"(?:^|[^a-z0-9])(?:{pattern})(?:$|[^a-z0-9])", _I)


def _token(word: str) -> re.Pattern:
    return re.compile(rf"(?:^|[^a-z0-9]){word}(?:$|[^a-z0-9])", _I)


def is_series(kind: str) -> bool:
    return kind != "movie"


# ---- what a Torrentio listing says --------------------------------------------------------

_SEEDERS = re.compile(r"(?:👤\s*|seeders?\s*[:=]?\s*)(\d+)", _I)
_SIZE = re.compile(r"(?:💾\s*)?(\d+(?:\.\d+)?)\s*(GB|GiB|MB|MiB)\b", _I)
_RESOLUTION = re.compile(r"(?:^|[^a-z0-9])(480|720|1080|2160)p(?:$|[^a-z0-9])", _I)
_TRACKER = re.compile(r"^(?:udp|https?|wss?)://\S{3,300}$", _I)


def label_resolution(text: str) -> int | None:
    hit = _RESOLUTION.search(text or "")
    if hit:
        return int(hit.group(1))
    return 2160 if re.search(r"\b4k\b", text or "", _I) else None


def parse_torrentio(data: dict) -> list[dict]:
    """Torrentio's /stream/... answer as release dicts (the shape every rule below reads)."""
    out = []
    for s in (data or {}).get("streams") or []:
        info_hash = str(s.get("infoHash") or "").lower()
        if not re.fullmatch(r"[a-f0-9]{40}", info_hash):
            continue
        label = str(s.get("title") or s.get("name") or "")[:600]
        name = str(s.get("name") or "")[:200]
        hints = s.get("behaviorHints") or {}
        seed = _SEEDERS.search(label)
        size = _SIZE.search(label)
        video_size = hints.get("videoSize")
        if isinstance(video_size, (int, float)) and video_size > 0:
            size_bytes = int(video_size)
        elif size:
            size_bytes = round(float(size.group(1)) * (GiB if size.group(2)[0] in "gG" else MiB))
        else:
            size_bytes = None
        trackers = [
            x[8:]
            for x in (s.get("sources") or [])
            if isinstance(x, str) and x.startswith("tracker:") and _TRACKER.match(x[8:])
        ][:40]
        out.append(
            {
                "hash": info_hash,
                "file_index": s["fileIdx"] if isinstance(s.get("fileIdx"), int) else None,
                "label": label,
                "name": name,
                "filename": str(hints.get("filename") or "")[:300],
                "seeders": int(seed.group(1)) if seed else None,
                "size": size_bytes,
                "resolution": label_resolution(f"{label} {name}"),
                "trackers": trackers,
            }
        )
    return out


# ---- the hard rules ---------------------------------------------------------------------------

_WEB_DL = re.compile(r"(?:^|[^a-z0-9])WEB[ ._-]*DL(?:$|[^a-z0-9])", _I)
_POLICY_CONFLICT = re.compile(
    r"(?:^|[^a-z0-9])(?:WEB[ ._-]*RIP|BLU[ ._-]*RAY|BD[ ._-]*RIP|BR[ ._-]*RIP|HDTV|DVD[ ._-]*RIP)"
    r"(?:$|[^a-z0-9])",
    _I,
)
_CAM = re.compile(
    r"(?:^|[\s._\[\]()-])(cam|hdcam|camrip|hdts|hdtc|ts|tsrip|telesync|telecine|tc|dvdscr|"
    r"screener|predvd|hdcamrip)(?:$|[\s._\[\]()-])",
    _I,
)
_PREVIEW = re.compile(r"(?:\s-\s|[\[(])(?:sample|trailer|teaser|prologue)\b", _I)
_NOT_THE_FILM = re.compile(r"\bNOT[\s._-]+THE[\s._-]+[^\r\n]*\b(?:FILM|MOVIE)\b", _I)

# The torrent label can say WEB-DL while the file inside is a disc rip, a re-mux or a capture.
_CONFLICTING_SOURCE = re.compile(
    r"(?:^|[^a-z0-9])(?:BD[ ._-]?(?:Mux|Remux|Rip|25|50)|Blu[ ._-]?Ray|BR[ ._-]?(?:Rip|Mux)|"
    r"UHD[ ._-]?BD|REMUX|WEB[ ._-]?(?:Rip|Mux|Cap)|HD[ ._-]?Rip|HDTV(?:Rip)?|PDTV|SAT[ ._-]?Rip|"
    r"DSR(?:ip)?|TV[ ._-]?Rip|DVD(?:[ ._-]?(?:Rip|Mux|R|5|9|Scr))?)(?:$|[^a-z0-9])",
    _I,
)
_REMUX_SOURCE = _boundary(r"(?:BD[ ._-]?)?REMUX|BD[ ._-]?Mux|UNTOUCHED|BD[ ._-]?(?:25|50|66|100)")
_DISC_SOURCE = _boundary(r"(?:UHD[ ._-]?)?BD[ ._-]?Rip|Blu[ ._-]?Ray|BR[ ._-]?(?:Rip|Mux)|UHD[ ._-]?BD")
_POOR_SOURCE = _boundary(
    r"WEB[ ._-]?(?:Rip|Cap)|WEB[ ._-]?DL[ ._-]?Rip|HD[ ._-]?Rip|HDTV(?:Rip)?|PDTV|SAT[ ._-]?Rip|"
    r"DSR(?:ip)?|TV[ ._-]?Rip|DCP[ ._-]?Rip|DVD(?:[ ._-]?(?:Rip|Mux|R|5|9|Scr))?"
)
_SD_MARKER = _boundary(
    r"(?:360|480|540|576)[pi]|threesixtyp|SD(?:TV)?|DVD(?:[ ._-]?(?:Rip|Mux|R|5|9|Remux))?|XviD|DivX"
)


def _clean(hit: re.Match) -> str:
    return re.sub(r"^[^a-z0-9]|[^a-z0-9]$", "", hit.group(0), flags=_I)


def source_conflict(release: dict) -> str | None:
    hit = _CONFLICTING_SOURCE.search(release.get("filename") or "")
    if hit:
        return f"File is a {_clean(hit)} release, not WEB-DL"
    hit = _CONFLICTING_SOURCE.search(release.get("label") or "")
    if hit:
        return f"Release is {_clean(hit)}, not WEB-DL"
    return None


def source_of(release: dict) -> str | None:
    """web-dl, disc (a Blu-ray encode), remux, poor (captures and re-encoded web rips), None."""
    text = f"{release.get('label') or ''} {release.get('filename') or ''}"
    if _POOR_SOURCE.search(text):
        return "poor"
    if _REMUX_SOURCE.search(text):
        return "remux"
    if _DISC_SOURCE.search(text):
        return "disc"
    return "web-dl" if _WEB_DL.search(text) else None


_YEAR = re.compile(r"(?:^|[^0-9x])((?:19|20)\d{2})(?=$|[^0-9px])", _I)


def year_mismatch(release: dict, year, series: bool = False, end_year=None) -> str | None:
    """A remake, a revival, a lookalike: labelled with a year outside this title's own, it is not
    this title. A film must match its year (one either side for festival and regional dates); a
    series must fall within the years it ran (open-ended while it airs)."""
    try:
        expected = int(year)
    except (TypeError, ValueError):
        return None
    if expected <= 1900:
        return None
    text = f"{(release.get('label') or '').split(chr(10))[0]} {release.get('filename') or ''}"
    years = [int(m.group(1)) for m in _YEAR.finditer(text)]
    if not series:
        last = expected
    else:
        try:
            last = int(end_year) if int(end_year) >= expected else math.inf
        except (TypeError, ValueError):
            last = math.inf
    if not years or any(expected - 1 <= y <= last + 1 for y in years):
        return None
    if series:
        return f"Labelled {years[0]}: a different series with the same name"
    return f"Labelled {years[0]}, not {expected}: a different film"


def stream_resolution(release: dict) -> int | None:
    """Older series were never released at 1080p by a service; their DVD sets carry no
    resolution at all, so SD is read from the label when none is given."""
    if release.get("resolution") in STREAM_RESOLUTIONS:
        return release["resolution"]
    if release.get("resolution") is not None:
        return None
    text = f"{release.get('label') or ''} {release.get('filename') or ''}"
    return 480 if _SD_MARKER.search(text) else None


def _quality_reasons(release: dict, resolution: int) -> list[str]:
    label = f"{release.get('label') or ''} {release.get('name') or ''}"
    reasons = []
    if release.get("resolution") != resolution:
        reasons.append(f"Not a {resolution}p release")
    named = label_resolution(label)
    if named is not None and named != resolution:
        reasons.append("Release label does not match the required resolution")
    in_file = label_resolution(release.get("filename") or "")
    if in_file is not None and in_file != resolution:
        reasons.append("Actual filename does not match the required resolution")
    if not _WEB_DL.search(label):
        reasons.append("WEB-DL required")
    if _POLICY_CONFLICT.search(f"{label} {release.get('filename') or ''}"):
        reasons.append("Release source conflicts with the required WEB-DL source")
    return reasons


def _release_reasons(release: dict, kind: str, resolution: int, rules: dict) -> list[str]:
    reasons = _quality_reasons(release, resolution)
    label = release.get("label") or ""
    if _CAM.search(label):
        reasons.append("CAM / screener release")
    if _PREVIEW.search(label):
        reasons.append("Preview clip, not a full release")
    if _NOT_THE_FILM.search(label):
        reasons.append("Release explicitly identifies a different film")
    seeders = release.get("seeders")
    if seeders is None:
        if rules["reject_unknown"]:
            reasons.append("Seeder count unknown")
    elif seeders < rules["min_seeders"]:
        reasons.append(f"Fewer than {rules['min_seeders']} reported seeders")
    if release.get("resolution") is None:
        if rules["reject_unknown"]:
            reasons.append("Resolution unknown")
    elif release["resolution"] not in STREAM_RESOLUTIONS:
        reasons.append("Resolution outside your rules")
    size = release.get("size")
    limit = (rules["episode_max_gb"] if is_series(kind) else rules["movie_max_gb"]) * GiB
    if size is None:
        if rules["reject_unknown"]:
            reasons.append("File size unknown")
    elif size <= 0 or size > limit:
        reasons.append("Above your file-size limit")
    return reasons


def assess_stream(
    release: dict,
    kind: str,
    resolution: int,
    year=None,
    end_year=None,
    relaxed: bool = False,
    rules: dict | None = None,
) -> tuple[bool, list[str]]:
    """(accepted, reasons). Sources accepted by quality:
      films at 1080p and 4K: WEB-DL and Blu-ray;
      series at 1080p and 4K: WEB-DL, so a season stays consistent, and Blu-ray only when
        `relaxed` (no WEB-DL of that episode exists);
      720p and SD: any source that is not a cinema capture, since nothing better exists."""
    rules = rules or RULES
    lower = resolution < 1080
    effective = stream_resolution(release)
    check = dict(release, resolution=effective if effective is not None else release.get("resolution"))
    reasons = _release_reasons(check, kind, resolution, rules)
    source = source_of(release)
    disc = source in ("disc", "remux")
    if lower or (disc and (not is_series(kind) or relaxed)):
        reasons = [
            r
            for r in reasons
            if not r.startswith("WEB-DL required") and not r.startswith("Release source conflicts")
        ]
    else:
        conflict = source_conflict(release)
        if conflict:
            reasons.append(conflict)
    wrong_year = year_mismatch(release, year, series=is_series(kind), end_year=end_year)
    if wrong_year:
        reasons.append(wrong_year)
    return not reasons, reasons


# ---- ranking ------------------------------------------------------------------------------------

_GROUP = re.compile(r"-([A-Za-z0-9]{2,20})(?:\[[^\]]*\])?(?:\.(?:mkv|mp4))?$")
_OTHER_LANGUAGE = re.compile(
    r"(?:^|[^a-z0-9])(?:iTA|TRUEFRENCH|FRENCH|VFF|VFQ|VF2|VOSTFR|GERMAN|LATINO|LAT|CASTELLANO|"
    r"SPANISH|POLISH|PL|HINDI|NLsubs)(?:$|[^a-z0-9])",
    _I,
)
_FLAG = re.compile("[\U0001f1e6-\U0001f1ff]{2}")


def traits(release: dict) -> dict:
    label = release.get("label") or ""
    lines = label.split("\n")
    filename = release.get("filename") or ""
    name = (filename or lines[0] or "").strip()
    text = f"{label} {filename}"
    group = _GROUP.search(name)
    dolby_vision = bool(re.search(r"(?:^|[^a-z0-9])(?:DV|DoVi|Dolby[ ._]?Vision)(?:$|[^a-z0-9])", text, _I))
    hdr = bool(re.search(r"(?:^|[^a-z0-9])HDR(?:10(?:\+|Plus)?)?(?:$|[^a-z0-9])", text, _I))
    return {
        "group": group.group(1).upper() if group else None,
        "service": next((s for s in SERVICES if _token(s).search(text)), None),
        "dolby_vision": dolby_vision,
        "hdr": hdr,
        "dolby_vision_only": dolby_vision and not hdr,
        "hevc": bool(re.search(r"x265|HEVC|H[ .]?265", text, _I)),
        "mp4": filename.lower().endswith(".mp4"),
        "lossy_stereo": bool(_token("AAC").search(text))
        and not re.search(r"DDP|DD\+?|EAC3|Atmos|TrueHD", text, _I),
        # A title in another script usually means a dub is the default audio track.
        "foreign_dub": bool(re.search("[Ѐ-ӿ]", lines[0]))
        or bool(re.search(r"\b(?:Dub|MVO|Lektor|Dual Audio)\b", text, _I)),
        # Flags other than the English ones on the listing line mean extra dubbed tracks.
        "multi_audio": bool(re.search(r"\bMULTi\b|Multi Audio", text, _I))
        or any(f not in ("🇬🇧", "🇺🇸") for f in _FLAG.findall(text)),
        # Named for another market: the default audio or burnt-in text is often not English.
        "other_language": bool(_OTHER_LANGUAGE.search(name)),
        # Services deliver 1080p as H.264; a 1080p HEVC file labelled WEB-DL is a re-encode.
        "reencoded_1080": release.get("resolution") == 1080
        and bool(re.search(r"x265|HEVC|H[ .]?265|10bit", text, _I)),
        "sign_language": bool(re.search(r"\bwith ASL\b", text, _I)),
        "upscaled": bool(re.search(r"\b(?:Ai[ ._-]?(?:Upscale|Enhanced)|RIFE|60fps)\b", text, _I)),
        "subtitle_hint": bool(re.search(r"Multi[ ._]?Subs?|\bESubs?\b|\bSubs?\b", text, _I)),
        "season_pack": release.get("file_index") is not None and len(lines) > 2,
        "source": source_of(release),
    }


def _size_floor(release: dict, kind: str, runtime: float | None) -> float | None:
    resolution = release.get("resolution")
    if runtime and runtime > 0 and resolution in MIN_BITRATE:
        return runtime * MIN_BITRATE[resolution] / 8
    return (MIN_EPISODE_BYTES if is_series(kind) else MIN_MOVIE_BYTES).get(resolution)


def score(
    release: dict,
    kind: str,
    lock: dict | None = None,
    runtime: float | None = None,
    streaming: bool = True,
) -> dict:
    """{"score", "parts": [(points, reason)], "traits"}. `streaming` weighs the swarm more:
    pieces are needed in order and on time, so a healthy swarm shortens the start."""
    t = traits(release)
    parts: list[tuple[int, str]] = []
    add = lambda points, reason: parts.append((points, reason))
    floor = _size_floor(release, kind, runtime)
    disc = t["source"] in ("disc", "remux")
    if t["source"] == "web-dl" and streaming and not is_series(kind):
        add(10, "WEB-DL source")
    if t["source"] == "disc":
        add(5, "Blu-ray source")
    if t["source"] == "remux":
        add(-20, "Remux: a very large file")
    if t["source"] == "poor":
        add(-10, "Broadcast capture or re-encode")
    if not t["source"]:
        add(-5, "Source not stated")
    if floor and release.get("size") is not None:
        if release["size"] >= floor:
            add(20, "Full-bitrate size")
        else:
            add(-40, "Too small for this running time" if disc else "Too small for an untouched WEB-DL")
    if t["service"]:
        add(15, f"Source service {t['service']}")
    if t["group"]:
        add(5, f"Release group {t['group']}")
    seeders = release.get("seeders")
    if seeders is not None:
        add(
            min(30 if streaming else 20, round(math.log2(seeders + 1) * (4 if streaming else 3))),
            f"{seeders} seeders",
        )
        if streaming and seeders < 8:
            add(-15, "Small swarm, slow start likely")
    if t["dolby_vision_only"]:
        add(-30, "Dolby Vision only, wrong colours on other screens")
    if t["mp4"]:
        add(-10, "MP4 container, limited subtitle tracks")
    if t["lossy_stereo"]:
        add(-15, "Re-encoded audio")
    if t["foreign_dub"]:
        add(-25, "Dubbed audio is likely the default track")
    elif t["other_language"]:
        add(-15, "Made for another language")
    elif t["multi_audio"]:
        add(-5, "Several audio tracks")
    if t["reencoded_1080"] and not disc:
        add(-20, "Re-encoded video")
    if t["sign_language"]:
        add(-60, "Sign-language overlay version")
    if t["upscaled"]:
        add(-50, "Upscaled or frame-interpolated")
    if t["subtitle_hint"]:
        add(5, "Label mentions subtitles")
    if t["season_pack"]:
        add(5, "Season pack")
    if lock:
        if lock.get("hash") and lock["hash"] == release.get("hash"):
            add(40, "Same season pack as earlier episodes")
        elif lock.get("group") and lock["group"] == t["group"] and lock.get("service") == t["service"]:
            add(30, "Same group and service as earlier episodes")
    return {"score": sum(p for p, _ in parts), "parts": parts, "traits": t}


def rank(
    releases: list[dict],
    kind: str,
    lock: dict | None = None,
    runtime: float | None = None,
    streaming: bool = True,
) -> list[dict]:
    """[{"release", "score", "parts", "traits"}], best first (score, then seeders). Stable."""
    scored = [{"release": r, **score(r, kind, lock, runtime, streaming)} for r in releases]
    scored.sort(key=lambda e: (-e["score"], -(e["release"].get("seeders") or 0)))
    return scored


def lock_from(entry: dict | None) -> dict | None:
    if not entry:
        return None
    return {
        "hash": entry["release"]["hash"],
        "group": entry["traits"]["group"],
        "service": entry["traits"]["service"],
    }


def runtime_seconds(text) -> float | None:
    """Cinemeta's "2h 28min", "148 min", "1h" or a bare number of minutes, in seconds."""
    if text is None:
        return None
    value = str(text).strip().lower()
    if re.fullmatch(r"\d+(\.\d+)?", value):
        return float(value) * 60 or None
    hours = re.search(r"(\d+)\s*h", value)
    minutes = re.search(r"(\d+)\s*m", value)
    total = (int(hours.group(1)) * 3600 if hours else 0) + (int(minutes.group(1)) * 60 if minutes else 0)
    return float(total) or None


def end_year(release_info) -> int | None:
    """"2001–2010" in the catalog: the last year a series ran. None while it airs."""
    hit = re.search(r"\d{4}\D+(\d{4})", str(release_info or ""))
    return int(hit.group(1)) if hit else None


def wrong_film(duration: float, expected: float | None) -> str | None:
    """A film file whose real length is far from the catalog's runtime is another film."""
    if not expected or expected < 1200 or not duration or duration <= 0:
        return None
    ratio = duration / expected
    if 0.85 <= ratio <= 1.3:
        return None
    return f"It runs {round(duration / 60)} min; the film runs {round(expected / 60)} min."
