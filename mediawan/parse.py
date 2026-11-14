"""Work out what a video file is from its name and the folders around it.

Handles the common layouts:
  Movies/Heat (1995)/Heat.1995.1080p.BluRay.mkv
  TV/Show/Season 02/Show.S02E03.Title.mkv   (also 2x03, S02E03-E04)
  Anime/[Group] Show - 05 [1080p].mkv       (absolute numbering, no season)
"""

import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path, PurePath

VIDEO_EXTENSIONS = {
    ".mkv",
    ".mp4",
    ".m4v",
    ".mov",
    ".avi",
    ".webm",
    ".ts",
    ".m2ts",
    ".mts",
    ".wmv",
    ".mpg",
    ".mpeg",
    ".flv",
    ".ogv",
}
SUBTITLE_EXTENSIONS = {".srt", ".vtt", ".ass", ".ssa"}

# Folders whose contents are bonus material, not library items.
CATEGORY_FOLDERS = {
    **dict.fromkeys(("movies", "movie", "films", "film", "cinema"), "movie"),
    **dict.fromkeys(
        ("tv", "tv shows", "tvshows", "tv-shows", "shows", "series", "anime", "cartoons"), "show"
    ),
}
EXTRA_FOLDERS = {
    "extras",
    "extra",
    "featurettes",
    "behind the scenes",
    "deleted scenes",
    "interviews",
    "trailers",
    "trailer",
    "samples",
    "sample",
    "scenes",
    "shorts",
    "bonus",
}
SPECIALS_FOLDERS = {"specials", "special"}

_SEASON_DIR = re.compile(r"^(?:season|series|saison|staffel|s)[ ._-]*(\d{1,3})$", re.IGNORECASE)
_SXXEYY = re.compile(r"\bs(\d{1,3})[ ._-]?e(\d{1,4})", re.IGNORECASE)
_NXNN = re.compile(r"(?<![\dx])(\d{1,2})x(\d{2,3})(?![\dp])", re.IGNORECASE)
_YEAR = re.compile(r"(?<!\d)((?:19|20)\d\d)(?![\dp])")
# "Show - 05", "Show - 05v2", "Show - 105 (1080p)"
_ABSOLUTE_DASH = re.compile(r"\s-\s(\d{1,4})(?:v\d)?(?:\s|$)")
_EPISODE_WORD = re.compile(r"\b(?:episode|ep|e)[ ._]?(\d{1,4})(?:v\d)?\b", re.IGNORECASE)
_TRAILING_NUMBER = re.compile(r"^(.*?\D)\s(\d{1,4})(?:v\d)?$")
_BRACKETS = re.compile(r"\[[^\]]*\]|\{[^}]*\}")
_PARENS = re.compile(r"\(([^)]*)\)")
_ACRONYM_DOT = re.compile(r"(?<=\b[A-Za-z])\.(?=[A-Za-z]\b)")
# Release noise. Everything from the first of these onwards is dropped from a title.
# Only unambiguous technical words: "Web", "Complete" or "Extended" can be part of a name.
# It never matches the first word, so a title like "Remux Clip" keeps its name.
_NOISE = re.compile(
    r"(?<=\S)\s+(?:2160p|1080[pi]|720p|576p|480p|4k|uhd|hdr10\+?|hdr|dolby ?vision|"
    r"blu-?ray|bdrip|brrip|bdremux|remux|web-?dl|web-?rip|hdtv|dvdrip|hdrip|"
    r"amzn|dsnp|hmax|atvp|x26[45]|h\.?26[45]|hevc|xvid|divx|av1|10-?bit|"
    r"aac(?:2\.0)?|ac3|eac3|ddp(?:5\.1|2\.0)?|dts(?:-?hd)?|truehd|atmos|flac|"
    r"5\.1|7\.1|directors? cut)\b.*$",
    re.IGNORECASE,
)
_PLACEHOLDER = "\x00"

LANGUAGES = {
    "en": "en",
    "eng": "en",
    "english": "en",
    "fr": "fr",
    "fre": "fr",
    "fra": "fr",
    "french": "fr",
    "de": "de",
    "ger": "de",
    "deu": "de",
    "german": "de",
    "es": "es",
    "spa": "es",
    "spanish": "es",
    "it": "it",
    "ita": "it",
    "italian": "it",
    "pt": "pt",
    "por": "pt",
    "portuguese": "pt",
    "ja": "ja",
    "jpn": "ja",
    "japanese": "ja",
    "ar": "ar",
    "ara": "ar",
    "arabic": "ar",
    "nl": "nl",
    "dut": "nl",
    "nld": "nl",
    "dutch": "nl",
    "ru": "ru",
    "rus": "ru",
    "russian": "ru",
    "zh": "zh",
    "chi": "zh",
    "zho": "zh",
    "chinese": "zh",
    "ko": "ko",
    "kor": "ko",
    "korean": "ko",
    "sv": "sv",
    "swe": "sv",
    "pl": "pl",
    "pol": "pl",
    "tr": "tr",
    "tur": "tr",
    "hi": "hi",
    "hin": "hi",
    "hindi": "hi",
    "da": "da",
    "dan": "da",
    "danish": "da",
    "swedish": "sv",
    "no": "no",
    "nor": "no",
    "nob": "no",
    "nno": "no",
    "norwegian": "no",
    "fi": "fi",
    "fin": "fi",
    "finnish": "fi",
    "polish": "pl",
    "turkish": "tr",
    "el": "el",
    "gre": "el",
    "ell": "el",
    "greek": "el",
    "he": "he",
    "heb": "he",
    "hebrew": "he",
    "cs": "cs",
    "cze": "cs",
    "ces": "cs",
    "czech": "cs",
    "hu": "hu",
    "hun": "hu",
    "hungarian": "hu",
    "ro": "ro",
    "rum": "ro",
    "ron": "ro",
    "romanian": "ro",
    "uk": "uk",
    "ukr": "uk",
    "ukrainian": "uk",
    "id": "id",
    "ind": "id",
    "indonesian": "id",
    "ms": "ms",
    "may": "ms",
    "msa": "ms",
    "malay": "ms",
    "th": "th",
    "tha": "th",
    "thai": "th",
    "vi": "vi",
    "vie": "vi",
    "vietnamese": "vi",
    "fa": "fa",
    "per": "fa",
    "fas": "fa",
    "persian": "fa",
}

# Names for the codes above, for labels such as "Danish (translated)".
LANGUAGE_NAMES = {
    "en": "English", "fr": "French", "de": "German", "es": "Spanish", "it": "Italian",
    "pt": "Portuguese", "ja": "Japanese", "ar": "Arabic", "nl": "Dutch", "ru": "Russian",
    "zh": "Chinese", "ko": "Korean", "sv": "Swedish", "pl": "Polish", "tr": "Turkish",
    "hi": "Hindi", "da": "Danish", "no": "Norwegian", "fi": "Finnish", "el": "Greek",
    "he": "Hebrew", "cs": "Czech", "hu": "Hungarian", "ro": "Romanian", "uk": "Ukrainian",
    "id": "Indonesian", "ms": "Malay", "th": "Thai", "vi": "Vietnamese", "fa": "Persian",
}  # fmt: skip


@dataclass
class Parsed:
    kind: str  # "movie" | "show"
    name: str
    year: int | None = None
    season: int = 0
    episode: int = 0
    absolute: bool = False

    @property
    def key(self) -> str:
        return title_key(self.kind, self.name, self.year)


@dataclass
class Unplaced:
    reason: str


def normalise(name: str) -> str:
    """Lower-case ASCII words, for comparing names regardless of punctuation."""
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    text = text.lower().replace("&", " and ")
    text = re.sub(r"['’`]", "", text)
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def title_key(kind: str, name: str, year: int | None) -> str:
    return f"{kind}:{normalise(name)}:{year or ''}"


def lang_code(value: str | None) -> str | None:
    """Two-letter language code from "eng", "English", "en-US"…"""
    if not value:
        return None
    low = value.lower().split("-")[0].split("_")[0]
    return LANGUAGES.get(low, low if len(low) == 2 else None)


def clean(text: str) -> str:
    """Turn a release-style name into a readable title."""
    text = _BRACKETS.sub(" ", text)
    if " " not in text.strip():
        # Release names use dots for spaces. Keep acronym dots: S.H.I.E.L.D.
        text = _ACRONYM_DOT.sub(_PLACEHOLDER, text)
        text = re.sub(r"[._]", " ", text).replace(_PLACEHOLDER, ".")
    else:
        text = text.replace("_", " ")
    text = _NOISE.sub("", text)
    text = re.sub(r"\(\s*\)", " ", text)
    return re.sub(r"\s+", " ", text).strip(" -–_.,([")


def _year_split(text: str) -> tuple[str, int | None]:
    """Split "Heat (1995) 1080p" into ("Heat", 1995), using the last plausible year."""
    text = _BRACKETS.sub(" ", text)
    for match in reversed(list(_YEAR.finditer(text))):
        before = clean(text[: match.start()])
        if before:  # "2001 A Space Odyssey" — a leading number is part of the name
            return before, int(match.group(1))
    return clean(text), None


def _show_from_dirs(parents: list[str]) -> tuple[str | None, int | None, int | None]:
    """Find the show folder name and any season folder number, walking up from the file."""
    season = None
    for folder in parents:
        low = folder.lower().strip()
        if low in SPECIALS_FOLDERS:
            season = 0 if season is None else season
            continue
        match = _SEASON_DIR.match(low)
        if match:
            season = int(match.group(1)) if season is None else season
            continue
        name, year = _year_split(folder)
        if name:
            return name, year, season
    return None, None, season


def library_hint(root: PurePath | str) -> str | None:
    """A root named like "Movies" or "TV Shows" tells us what lives in it."""
    low = (root if isinstance(root, str) else root.name).lower()
    if any(word in low for word in ("movie", "film", "cinema")):
        return "movie"
    if any(word in low for word in ("tv", "show", "series", "anime", "episod")):
        return "show"
    return None


def parse_path(path: PurePath, root: PurePath) -> "Parsed | Unplaced | None":
    """Classify one file. None means "not a library item" (sample, extra, non-video)."""
    if path.suffix.lower() not in VIDEO_EXTENSIONS:
        return None
    try:
        relative = path.relative_to(root)
    except ValueError:
        return Unplaced("outside library root")
    stem = path.stem
    dirs = list(relative.parts[:-1])
    if any(d.lower() in EXTRA_FOLDERS for d in dirs):
        return None
    # Scene samples look like "movie-sample.mkv", "sample-movie.mkv" or just "sample.mkv".
    # A dot after a leading "Sample" is a title ("Sample.Show.S01E01"), not a sample clip.
    if re.search(
        r"(?:^(?:sample|trailer)(?:$|[ _-])|[ ._-](?:sample|trailer)$)", stem, re.IGNORECASE
    ):
        return None
    hint = library_hint(root)
    # A single root such as /media often holds Movies/ and TV/ category folders. Exact names
    # only: a title folder like "The Truman Show" must not be mistaken for a category.
    if len(dirs) > 1 and dirs[0].strip().lower() in CATEGORY_FOLDERS:
        hint = hint or CATEGORY_FOLDERS[dirs[0].strip().lower()]
        dirs = dirs[1:]
    parents = list(reversed(dirs))  # nearest folder first
    folder_name, folder_year, folder_season = _show_from_dirs(parents)

    # 1. Season/episode markers: S02E03, 2x03
    for pattern in (_SXXEYY, _NXNN):
        match = pattern.search(stem)
        if match:
            season, episode = int(match.group(1)), int(match.group(2))
            prefix = stem[: match.start()]
            name, year = _year_split(prefix) if prefix.strip(" ._-") else (None, None)
            # Folder names are curated by people; release-style file prefixes are not.
            if folder_name:
                name, year = folder_name, folder_year or year
            if not name:
                return Unplaced("episode number found but no show name")
            return Parsed("show", name, year, season, episode)

    # 2. Absolute anime numbering: "[Group] Show - 05 [1080p]", "Show Episode 5"
    if hint != "movie":
        text = re.sub(r"\s+", " ", _BRACKETS.sub(" ", stem).replace("_", " ")).strip()
        match = _ABSOLUTE_DASH.search(text + " ") or _EPISODE_WORD.search(text)
        if match and not (_YEAR.fullmatch(match.group(1)) and hint != "show"):
            prefix = text[: match.start()]
            name, year = _year_split(prefix) if prefix.strip() else (None, None)
            return _episode(
                folder_name or name, folder_year or year, folder_season, int(match.group(1))
            )
        if hint == "show" or stem.startswith("["):
            match = _TRAILING_NUMBER.match(_PARENS.sub(" ", text).strip())
            if match and not _YEAR.fullmatch(match.group(2)):
                return _episode(
                    folder_name or clean(match.group(1)),
                    folder_year,
                    folder_season,
                    int(match.group(2)),
                )

    # 3. Movies: "Heat (1995)" folder and/or "Heat.1995.1080p" file
    name, year = _year_split(stem)
    in_movie_folder = bool(folder_name) and folder_season is None and hint != "show"
    if in_movie_folder and (folder_year or year):
        # The file sits in its own movie folder: trust the folder, take the year from either.
        return Parsed("movie", folder_name, folder_year or year)
    if year and name:
        return Parsed("movie", name, year)
    if hint == "movie" and (folder_name or name):
        return Parsed("movie", folder_name or name, folder_year)
    if in_movie_folder:
        return Parsed("movie", folder_name, folder_year)
    return Unplaced("no year, season or episode number to go on")


def _episode(name, year, season, number) -> "Parsed | Unplaced":
    if not name:
        return Unplaced("episode number found but no show name")
    if season is not None:  # a "Season 2" folder turns "05" into S02E05
        return Parsed("show", name, year, season, number)
    return Parsed("show", name, year, 1, number, absolute=True)


def subtitle_info(sub: PurePath, video: PurePath) -> dict | None:
    """Language/forced flags for a sidecar subtitle of this video, else None."""
    if sub.suffix.lower() not in SUBTITLE_EXTENSIONS:
        return None
    if sub.parent == video.parent:
        if not sub.stem.lower().startswith(video.stem.lower()):
            return None
        tags = sub.stem[len(video.stem) :]
    else:
        tags = sub.stem  # Subs/<video>/2_English.srt or Subs/English.srt
    words = [w for w in re.split(r"[ ._\-\[\]()]+", tags.lower()) if w]
    return {
        "lang": next((LANGUAGES[w] for w in reversed(words) if w in LANGUAGES), None),
        "forced": int(any(w in ("forced", "foreign") for w in words)),
        "format": sub.suffix.lower().lstrip("."),
    }


def find_sidecars(video: Path, sibling_names: list[str], videos_in_folder: int) -> list[Path]:
    """Sidecar subtitles: Movie.en.srt beside the video, or a Subs/ folder next to it."""
    found = []
    stem = video.stem.lower()
    for name in sibling_names:
        p = video.parent / name
        if p.suffix.lower() in SUBTITLE_EXTENSIONS and p.stem.lower().startswith(stem):
            found.append(p)
    for folder in ("Subs", "subs", "Subtitles", "subtitles"):
        subs = video.parent / folder
        if not subs.is_dir():
            continue
        candidates = [subs / video.stem] if (subs / video.stem).is_dir() else []
        if videos_in_folder == 1:
            candidates.append(subs)
        for directory in candidates:
            for p in sorted(directory.iterdir()):
                if p.is_file() and p.suffix.lower() in SUBTITLE_EXTENSIONS:
                    found.append(p)
        break
    return found
