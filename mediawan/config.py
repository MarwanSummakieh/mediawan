"""Settings come from environment variables so Docker and local runs share one path."""

import os
from dataclasses import dataclass, field
from pathlib import Path


def _paths(value: str) -> list[Path]:
    return [Path(p).resolve() for p in value.split(os.pathsep) if p.strip()]


@dataclass
class Config:
    database: Path = Path("data/mediawan.sqlite")
    runtime: Path = Path(".runtime")
    library_roots: list[Path] = field(default_factory=list)
    admin_email: str = ""
    admin_password: str = ""
    secure_cookie: bool = False
    ffmpeg: str = "ffmpeg"
    ffprobe: str = "ffprobe"
    # "none" = software x264, "qsv" = Intel QuickSync (the NAS's N100), "vaapi" = generic VA-API
    hwaccel: str = "none"
    max_transcodes: int = 2
    scan_interval: int = 6 * 3600
    catalog_url: str = "https://v3-cinemeta.strem.io"
    metadata_online: bool = True
    # Search and stream anime from AniList + MegaPlay (see online.py)
    online_anime: bool = True
    # Online movies and TV over BitTorrent (see torrent.py): the torrent sidecar's address
    # (torrentd.py, inside the VPN container's network; empty = off) and the key both share,
    # and where releases are listed.
    torrent_url: str = ""
    torrent_key: str = ""
    torrentio_url: str = "https://torrentio.strem.fun"
    torrent_fallback_seconds: float = 6
    # DEVELOPMENT ONLY: an IMDb id whose releases are replaced by the free film Sintel.
    torrent_dev_sintel: str = ""
    # Release groups the streaming filter trusts; empty = release_rules.TRUSTED_GROUPS.
    torrent_trusted_groups: list[str] = field(default_factory=list)
    # Subtitle languages offered on every title; missing ones are machine-translated by the
    # LibreTranslate server at translate_url (see translate.py). Empty url = no translation.
    subtitle_languages: list[str] = field(default_factory=lambda: ["ar", "da", "pt"])
    # Look up text subtitles online for releases that lack them (see subsource.py).
    subtitles_online: bool = True
    translate_url: str = ""
    translate_api_key: str = ""
    # Live sports from an IPTV provider (see live.py, sports.py). The folder holds the channel
    # list with the provider's login; empty = "live-tv" beside the database, as in v2.
    live_tv: bool = True
    live_dir: Path | None = None
    live_guides: list[str] | None = None  # None = the default epgshare01 guides
    live_fixtures: bool = True

    @classmethod
    def from_env(cls, env: dict | None = None) -> "Config":
        env = os.environ if env is None else env
        return cls(
            database=Path(env.get("MEDIAWAN_DB", "data/mediawan.sqlite")).resolve(),
            runtime=Path(env.get("TRANSCODE_DIR", ".runtime")).resolve(),
            library_roots=_paths(env.get("LIBRARY_ROOTS", "")),
            admin_email=env.get("ADMIN_EMAIL", ""),
            admin_password=env.get("ADMIN_PASSWORD", ""),
            secure_cookie=env.get("COOKIE_SECURE") == "true",
            ffmpeg=env.get("FFMPEG_PATH", "ffmpeg"),
            ffprobe=env.get("FFPROBE_PATH", "ffprobe"),
            hwaccel=env.get("HWACCEL", "none"),
            max_transcodes=max(1, int(env.get("MAX_TRANSCODES", "2"))),
            scan_interval=int(env.get("SCAN_INTERVAL_SECONDS", str(6 * 3600))),
            catalog_url=env.get("CINEMETA_BASE", "https://v3-cinemeta.strem.io"),
            metadata_online=env.get("METADATA_ONLINE", "true") != "false",
            online_anime=env.get("ONLINE_ANIME", "true") != "false",
            torrent_url=env.get("TORRENT_URL", "").strip(),
            torrent_key=env.get("TORRENT_KEY", ""),
            torrentio_url=env.get("TORRENTIO_URL", "https://torrentio.strem.fun"),
            torrent_fallback_seconds=min(60.0, max(2.0, float(env.get("TORRENT_FALLBACK_SECONDS", "6")))),
            torrent_dev_sintel=env.get("TORRENT_DEV_SINTEL", "").strip(),
            torrent_trusted_groups=[
                g.strip() for g in env.get("TORRENT_TRUSTED_GROUPS", "").split(",") if g.strip()
            ],
            subtitle_languages=[
                code.strip().lower()
                for code in env.get("SUBTITLE_LANGUAGES", "ar,da,pt").split(",")
                if code.strip()
            ],
            subtitles_online=env.get("SUBTITLES_ONLINE", "true") != "false",
            translate_url=env.get("TRANSLATE_URL", ""),
            translate_api_key=env.get("TRANSLATE_API_KEY", ""),
            live_tv=env.get("LIVE_TV", "true") != "false",
            live_dir=Path(env["LIVE_TV_DIR"]).resolve() if env.get("LIVE_TV_DIR") else None,
            live_guides=(
                [u.strip() for u in env["LIVE_GUIDES"].split(",") if u.strip()]
                if "LIVE_GUIDES" in env
                else None
            ),
            live_fixtures=env.get("LIVE_FIXTURES", "true") != "false",
        )
