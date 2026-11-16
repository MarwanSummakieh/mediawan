"""Subtitles from the web, for releases that carry none a browser can show.

Many releases, Blu-ray ones above all, only have picture-based subtitles (PGS, VobSub), which
cannot be drawn as text. For those, and for any wanted language a release lacks, text subtitles
are looked up by IMDb id in the public OpenSubtitles catalogue that Stremio uses (no account,
no key). The ones whose file name best matches the release being played are offered, so the
timing is as likely as possible to fit; a second choice per language is listed in case the
first is out of step. That catalogue has gaps (some well-known films have no English at all),
so for a film a language it lacks is looked up at YIFY Subtitles as well.
"""

import hashlib
import html
import io
import logging
import re
import threading
import time
import zipfile
from pathlib import Path

import httpx

from .parse import lang_code

log = logging.getLogger("mediawan.subsource")

CATALOGUE = "https://opensubtitles-v3.strem.io"
FILMS = "https://yifysubtitles.ch"
BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
_FILM_ROW = re.compile(
    r'<tr data-id="\d+">.*?class="label[^"]*">(-?\d+)</span>.*?class="sub-lang">([^<]+)</span>'
    r'.*?<a href="/subtitles/([^"/]+)">(.*?)</a>',
    re.DOTALL,
)
_MARKUP = re.compile(r"<[^>]+>")
_FILM_LANGUAGES = {"brazilian portuguese": "pob", "farsi/persian": "fa", "chinese bg code": "zh"}
# What older subtitle files are written in when they are not UTF-8.
_LEGACY = {
    "ar": "cp1256", "fa": "cp1256", "ru": "cp1251", "uk": "cp1251", "el": "cp1253",
    "tr": "cp1254", "he": "cp1255", "pl": "cp1250", "cs": "cp1250", "hu": "cp1250",
    "ro": "cp1250", "th": "cp874", "vi": "cp1258",
}  # fmt: skip
PER_LANGUAGE = 2
LISTING_SECONDS = 6 * 3600
FAILED_SECONDS = 120
# Codes the catalogue uses that the language table does not know.
_CODES = {"pob": "pt", "pb": "pt", "zht": "zh", "zhe": "zh", "zhc": "zh", "spl": "es", "spn": "es"}
_REGIONAL = {"pob", "pb", "spl", "zhe", "zhc"}  # listed after the plain language
_SPLIT = re.compile(r"\bcd[ ._-]?\d\b|\bpart[ ._-]?\d\b|\b\dof\d\b", re.IGNORECASE)  # half a film
_FOR_DEAF = re.compile(r"(?<![a-z])(sdh|hi|cc)(?![a-z])", re.IGNORECASE)  # sound descriptions too
_WORDS = re.compile(r"[a-z0-9]+")
_SOURCES = {
    "bluray": "disc", "blu": "disc", "bdrip": "disc", "brrip": "disc", "bdremux": "disc",
    "remux": "disc", "uhd": "disc", "dvdrip": "dvd", "dvd": "dvd",
    "web": "web", "webrip": "web", "webdl": "web", "amzn": "web", "nf": "web", "hdtv": "tv",
}  # fmt: skip
_TIMING = re.compile(r"^(\s*(?:\d+:)?\d+:\d+)[,.](\d+\s*-->\s*(?:\d+:)?\d+:\d+)[,.](\d+)", re.MULTILINE)
_SRT_NUMBER = re.compile(r"^\d+\n(?=[^\n]*-->)", re.MULTILINE)
_ASS_TAG = re.compile(r"\{\\[^}]*\}")
_FONT_TAG = re.compile(r"</?font[^>]*>", re.IGNORECASE)


def to_vtt(text: str) -> str:
    """SubRip (or WebVTT) text as WebVTT."""
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    if text.lstrip().startswith("WEBVTT"):
        return text
    text = _TIMING.sub(r"\1.\2.\3", text)
    text = _SRT_NUMBER.sub("", text)
    text = _FONT_TAG.sub("", _ASS_TAG.sub("", text))
    return "WEBVTT\n\n" + text.strip("\n") + "\n"


def decode(raw: bytes, lang: str | None) -> str:
    if raw[:2] in (bytes([255, 254]), bytes([254, 255])):
        return raw.decode("utf-16", errors="replace")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode(_LEGACY.get(lang or "", "cp1252"), errors="replace")


def unpack(raw: bytes) -> bytes:
    """The subtitle inside a zip (the largest .srt or .vtt), or the bytes as they are."""
    if raw[:2] != b"PK":
        return raw
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = [
            i for i in archive.infolist() if i.filename.lower().endswith((".srt", ".vtt"))
        ]
        if not names:
            raise ValueError("No subtitle file in that download")
        best = max(names, key=lambda i: i.file_size)
        if best.file_size > 5_000_000:
            raise ValueError("That subtitle file is too large")
        return archive.read(best)


def _source(words: set[str]) -> str | None:
    return next((kind for word, kind in _SOURCES.items() if word in words), None)


def match(release: str, entry: dict) -> int:
    """How well a subtitle fits a release: same group, same kind of source, shared words."""
    wanted = set(_WORDS.findall(release.lower()))
    name = f"{entry.get('subtitleFileName') or ''} {entry.get('movieReleaseName') or ''}".lower()
    have = set(_WORDS.findall(name))
    score = len(wanted & have)
    group = (entry.get("releaseGroup") or "").lower()
    if group and group in wanted:
        score += 20
    a, b = _source(wanted), _source(have)
    if a and b:
        score += 10 if a == b else -10
    return score


class OnlineSubtitles:
    def __init__(self, folder: Path, client: httpx.Client | None = None, enabled: bool = True):
        self.folder = Path(folder)
        self.enabled = enabled
        self.client = client or httpx.Client(timeout=6, follow_redirects=True)
        self.listings: dict[str, tuple[float, list[dict]]] = {}
        self.lock = threading.Lock()

    def _listing(self, kind: str, imdb_id: str, season: int, episode: int) -> list[dict]:
        show = kind == "show"
        path = f"series/{imdb_id}:{season}:{episode}" if show else f"movie/{imdb_id}"
        with self.lock:
            cached = self.listings.get(path)
        if cached and cached[0] > time.time():
            return cached[1]
        try:
            response = self.client.get(f"{CATALOGUE}/subtitles/{path}.json")
            response.raise_for_status()
            found = [
                e
                for e in response.json().get("subtitles") or []
                if isinstance(e, dict) and str(e.get("url") or "").startswith("https://")
            ]
            keep = LISTING_SECONDS
        except (httpx.HTTPError, ValueError) as error:
            log.warning("Online subtitles could not be listed for %s: %s", path, error)
            found, keep = [], FAILED_SECONDS
        with self.lock:
            self.listings[path] = (time.time() + keep, found)
        return found

    def _films(self, imdb_id: str) -> list[dict]:
        """What YIFY Subtitles lists for a film, in the catalogue's shape."""
        path = f"films/{imdb_id}"
        with self.lock:
            cached = self.listings.get(path)
        if cached and cached[0] > time.time():
            return cached[1]
        try:
            response = self.client.get(
                f"{FILMS}/movie-imdb/{imdb_id}", headers={"User-Agent": BROWSER}
            )
            response.raise_for_status()
            found = [
                {
                    "lang": _FILM_LANGUAGES.get(language.strip().lower(), language.strip()),
                    "url": f"{FILMS}/subtitle/{slug}.zip#{slug}",
                    "subtitleFileName": html.unescape(
                        _MARKUP.sub("", label).replace("subtitle", "", 1)
                    ).strip(),
                    "rating": int(rating),
                }
                for rating, language, slug, label in _FILM_ROW.findall(response.text)
            ]
            keep = LISTING_SECONDS
        except (httpx.HTTPError, ValueError) as error:
            log.warning("Film subtitles could not be listed for %s: %s", imdb_id, error)
            found, keep = [], FAILED_SECONDS
        with self.lock:
            self.listings[path] = (time.time() + keep, found)
        return found

    def find(
        self,
        kind: str,
        imdb_id: str,
        season: int,
        episode: int,
        release: str,
        languages: list[str],
    ) -> list[dict]:
        """Up to PER_LANGUAGE subtitles for each language, best fit for the release first.
        Each is {"lang", "url", "name"}; nothing when the lookup is off or fails."""
        if not self.enabled or not re.fullmatch(r"tt\d+", imdb_id or ""):
            return []
        by_lang: dict[str, list[tuple]] = {}

        def add(listing: list[dict], only: list[str]) -> None:
            for at, entry in enumerate(listing):
                raw = str(entry.get("lang") or "").lower()
                lang = _CODES.get(raw) or lang_code(raw)
                name = str(entry.get("subtitleFileName") or "")
                if lang not in only or _SPLIT.search(name):
                    continue
                rank = (
                    -match(release, entry),
                    raw in _REGIONAL,
                    bool(_FOR_DEAF.search(name)),
                    -int(entry.get("rating") or 0),
                    at,
                )
                url = entry["url"] + (f"&lang={lang}" if "#" in entry["url"] else "")
                by_lang.setdefault(lang, []).append((rank, url, name))

        add(self._listing(kind, imdb_id, season, episode), languages)
        lacking = [lang for lang in languages if lang not in by_lang]
        if lacking and kind == "movie":
            add(self._films(imdb_id), lacking)
        out = []
        for lang in languages:
            for _, url, name in sorted(by_lang.get(lang, []))[:PER_LANGUAGE]:
                out.append({"lang": lang, "url": url, "name": name})
        return out

    def warm(self, kind: str, imdb_id: str, season: int, episode: int) -> None:
        """Fetch the listing in the background, so Play does not wait for it."""
        if self.enabled:
            threading.Thread(
                target=self._listing, args=(kind, imdb_id, season, episode), daemon=True
            ).start()

    def fetch(self, url: str) -> Path:
        """The subtitle at `url` as a WebVTT file on disk (downloaded once)."""
        if not url.startswith("https://"):
            raise ValueError("Not a subtitle address")
        path = self.folder / (hashlib.sha256(url.encode()).hexdigest()[:32] + ".vtt")
        if path.is_file():
            return path
        address, _, note = url.partition("#")
        headers = {}
        if note:  # a film subtitle: the site wants to see its own page as the referrer
            headers = {"User-Agent": BROWSER, "Referer": f"{FILMS}/subtitles/{note.split('&')[0]}"}
        response = self.client.get(address, headers=headers)
        response.raise_for_status()
        lang = note.partition("&lang=")[2] or None
        text = decode(unpack(response.content), lang)
        if "-->" not in text:
            raise ValueError("That was not a subtitle file")
        self.folder.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(".part")
        partial.write_text(to_vtt(text), "utf-8")
        partial.replace(path)
        return path


def entries(found: list[dict], link) -> list[dict]:
    """Player entries for what find() returned; link(url) is where the player reads one."""
    out, seen = [], {}
    for sub in found:
        n = seen[sub["lang"]] = seen.get(sub["lang"], 0) + 1
        out.append(
            {
                "key": f"o-{sub['lang']}-{n}",
                "lang": sub["lang"],
                "title": "Online" if n == 1 else f"Online, alternative {n - 1}",
                "forced": False,
                "default": False,
                "codec": "webvtt",
                "available": True,
                "external": False,
                "online": True,
                "url": link(sub["url"]),
                "_remote": sub["url"],
            }
        )
    return out
