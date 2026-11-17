"""Mediawan's torrent engine: streams one file of a torrent over HTTP while it downloads.

It runs as its own process from the same image (`python -m mediawan.torrentd`), inside the VPN
container's network namespace (docker-compose: service `torrent`, network_mode "service:vpn"),
so peer traffic has no route except the tunnel; Gluetun's kill switch is the real guard. As a
second line it refuses to start torrents unless a tunnel interface is up, binds libtorrent's
sockets to that interface, and drops every torrent the moment the tunnel goes away.

The web app (torrent.py) drives it over a small JSON API, authenticated with a shared key
because other containers share the VPN's network:

  POST   /v1/torrents                        {hash, trackers}     join a swarm (metadata only)
  GET    /v1/torrents/<hash>                                      status: peers, speed, files
  POST   /v1/torrents/<hash>/files           {index, name, mode}  choose the file to stream
  POST   /v1/torrents/<hash>/files/<i>/mode  {mode}               prepare -> play, or download
  DELETE /v1/torrents/<hash>/files/<i>                            stop wanting one file
  POST   /v1/torrents/<hash>/files/<i>/hint  {position}           warm a resume point (bytes)
  DELETE /v1/torrents/<hash>                                      leave and delete the data
                                                                  (files being downloaded stay)
  GET    /v1/status                                               tunnel, disk, every torrent
  GET    /health                                                  liveness, no key

FFmpeg reads the chosen file from GET /file/<token>/<name> with range requests. The token is
a random capability handed out only through the authenticated API.

Pieces are fetched in the order the reader needs them: the head and tail of the file first
(MKV keeps its index at the end), then a window ahead of every reader with deadlines, so a seek
reprioritises at once; while playing, the rest of the file follows in order behind the window.
Data lives in a capped cache folder that is deleted on start, when a torrent is dropped, after
it sits idle, and whenever the disk runs low.

A file in "download" mode (season downloads, downloads.py) is fetched whole, in order. It keeps its
torrent from going idle, and a plain DELETE (a stream that used the same torrent ending) leaves
it in place; the app copies the finished file out and then deletes that one file. Losing the
tunnel or running out of disk still drops everything.
"""

import hmac
import json
import logging
import os
import re
import secrets
import shutil
import socket
import struct
import sys
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote

log = logging.getLogger("mediawan.torrentd")

MiB = 1048576
GiB = 1073741824
VIDEO = re.compile(r"\.(mkv|mp4|m4v|webm|avi|ts|m2ts|mov|wmv|mpg|mpeg)$", re.IGNORECASE)
HASH = re.compile(r"^[a-f0-9]{40}$")
HEAD_BYTES = 8 * MiB
TAIL_BYTES = 4 * MiB
WINDOW_BYTES = 32 * MiB
CACHE_BYTES = 48 * MiB  # pieces read into memory per torrent (the one being sent and the next)
# Trackerless discovery (DHT) does not bootstrap on every network and many listings carry no
# tracker list, so every torrent also announces to these open trackers (v2 learned this).
OPEN_TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://explodie.org:6969/announce",
    "udp://tracker.dler.org:6969/announce",
    "http://tracker.opentrackr.org:1337/announce",
]
TUNNEL_NAMES = re.compile(r"^(tun|tap|wg|nordlynx|proton|mullvad)", re.IGNORECASE)


class Refused(Exception):
    """A request the engine will not carry out. `reason` is machine-readable."""

    def __init__(self, status: int, reason: str, message: str):
        super().__init__(message)
        self.status, self.reason = status, reason


# ---- settings -------------------------------------------------------------------------------


def _flag(env: dict, name: str, default: bool) -> bool:
    value = env.get(name)
    return default if value in (None, "") else value.strip().lower() not in ("0", "false", "no", "off")


@dataclass
class Settings:
    key: str = ""
    host: str = "0.0.0.0"
    port: int = 8792
    directory: Path = Path(".runtime/torrents")
    cache_bytes: int = 60 * GiB
    min_free_bytes: int = 10 * GiB
    require_vpn: bool = True
    interface: str = ""  # empty = any tunnel interface that is up
    bind_tunnel: bool = True
    listen_port: int = 6881
    upload_kbps: int = 1024
    dht: bool = True
    trackers: list = field(default_factory=list)
    idle_seconds: int = 90
    max_torrents: int = 8
    # Development only: refuse every info hash not listed here (empty = no restriction).
    allow_hashes: set = field(default_factory=set)

    @classmethod
    def from_env(cls, env: dict | None = None) -> "Settings":
        env = os.environ if env is None else env
        runtime = Path(env.get("TRANSCODE_DIR", ".runtime"))
        return cls(
            key=env.get("TORRENT_KEY", ""),
            host=env.get("TORRENTD_HOST", "0.0.0.0"),
            port=int(env.get("TORRENTD_PORT", "8792")),
            directory=Path(env.get("TORRENT_DIR") or runtime / "torrents").resolve(),
            cache_bytes=int(float(env.get("TORRENT_CACHE_GB", "60")) * GiB),
            min_free_bytes=int(float(env.get("TORRENT_MIN_FREE_GB", "10")) * GiB),
            require_vpn=_flag(env, "TORRENT_REQUIRE_VPN", True),
            interface=env.get("TORRENT_INTERFACE", "").strip(),
            bind_tunnel=_flag(env, "TORRENT_BIND_TUNNEL", True),
            listen_port=int(env.get("TORRENT_LISTEN_PORT", "6881")),
            upload_kbps=int(env.get("TORRENT_UPLOAD_KBPS", "1024")),
            dht=_flag(env, "TORRENT_DHT", True),
            trackers=[t.strip() for t in env.get("TORRENT_TRACKERS", "").split(",") if t.strip()],
            idle_seconds=max(15, int(env.get("TORRENT_IDLE_SECONDS", "90"))),
            max_torrents=max(1, int(env.get("TORRENT_MAX_TORRENTS", "8"))),
            allow_hashes={
                h.strip().lower() for h in env.get("TORRENT_DEV_ALLOW_HASHES", "").split(",") if h.strip()
            },
        )


# ---- the tunnel check ---------------------------------------------------------------------------


def _ipv4(name: str) -> str | None:
    """The interface's IPv4 address (Linux), or None."""
    try:
        import fcntl

        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            raw = fcntl.ioctl(s.fileno(), 0x8915, struct.pack("256s", name[:15].encode()))  # SIOCGIFADDR
        return socket.inet_ntoa(raw[20:24])
    except (OSError, ImportError):
        return None


def tunnel_interfaces(root: Path = Path("/sys/class/net")) -> list[str]:
    """Tunnel-like interfaces that are up (IFF_UP), from sysfs. Empty on non-Linux systems."""
    found = []
    try:
        names = sorted(p.name for p in root.iterdir())
    except OSError:
        return []
    for name in names:
        if not TUNNEL_NAMES.match(name):
            continue
        try:
            flags = int((root / name / "flags").read_text().strip(), 16)
        except (OSError, ValueError):
            continue
        if flags & 0x1:
            found.append(name)
    return found


def check_tunnel(settings: Settings, interfaces=tunnel_interfaces, address=_ipv4) -> dict:
    """{"ok", "required", "interface", "message"}: may torrents start right now?"""
    if not settings.require_vpn:
        return {
            "ok": True,
            "required": False,
            "interface": None,
            "message": "The tunnel check is off (TORRENT_REQUIRE_VPN=false): peers can see this "
            "machine's own address.",
        }
    up = interfaces()
    if settings.interface:
        up = [name for name in up if name == settings.interface]
    up = [name for name in up if address(name)] if sys.platform.startswith("linux") else up
    if up:
        return {"ok": True, "required": True, "interface": up[0],
                "message": f"Torrents run through the tunnel ({up[0]})."}  # fmt: skip
    wanted = settings.interface or "tun*/wg*"
    return {
        "ok": False,
        "required": True,
        "interface": None,
        "message": f"The VPN tunnel ({wanted}) is not up, so no torrent may start. "
        "Check the vpn container.",
    }


# ---- piece priorities (pure, so it can be tested) ------------------------------------------------


@dataclass
class Span:
    """One selected file in piece terms, with where its readers are."""

    first: int
    last: int
    head_end: int
    tail_start: int
    playing: bool
    readers: list  # piece index of each active reader
    window: int  # pieces ahead of a reader that get deadlines
    behind: int | None = None  # where the last reader was, when none is active now
    hints: list = field(default_factory=list)  # where playback will start (a resume point)


def plan_pieces(num_pieces: int, spans: list[Span]) -> tuple[list[int], list[int]]:
    """(priority of every piece, pieces that get deadlines in order of urgency).

    Head and tail first; a window ahead of every reader with deadlines; while playing, the rest
    of the file from the reader onwards (and then what lies behind it) at lower priorities."""
    priorities = [0] * num_pieces
    urgent: list[int] = []

    def rush(p: int):
        priorities[p] = 7
        if p not in urgent:
            urgent.append(p)

    near = lambda s: max(2, s.window // 8)
    for s in spans:  # what a reader is about to read comes first
        for reader in s.readers:
            for p in range(reader, min(s.last, reader + near(s) - 1) + 1):
                rush(p)
    for s in spans:  # then what FFprobe needs: the head and the tail (MKV/MP4 indexes)
        for p in list(range(s.first, s.head_end + 1)) + list(range(s.tail_start, s.last + 1)):
            rush(p)
    for s in spans:  # then where a prepared stream will resume, so pressing play starts warm
        for hint in s.hints:
            for p in range(hint, min(s.last, hint + max(2, s.window // 2) - 1) + 1):
                rush(p)
    for s in spans:  # then the rest of each reader's window
        for reader in s.readers:
            for p in range(reader, min(s.last, reader + s.window - 1) + 1):
                rush(p)
    for s in spans:  # while playing, the rest of the file: ahead of the reader before behind it
        if s.playing:
            start = min(s.readers) if s.readers else (s.behind if s.behind is not None else s.first)
            for p in range(s.first, s.last + 1):
                priorities[p] = max(priorities[p], 4 if p >= start else 1)
    return priorities, urgent


def _letters(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", Path(text.replace("\\", "/")).stem.lower())


def choose_file(videos: list[dict], files: list[dict], index: int | None, name: str) -> dict | None:
    """The video the listing means: the one with its file name; else the listing's index
    (counted without padding files), when that file's name agrees or no name was given; else,
    when the listing named nothing at all, the largest video. None = refuse."""
    if name:
        want = Path(name.replace("\\", "/")).name.lower()
        hit = next((f for f in videos if Path(f["path"]).name.lower() == want), None)
        hit = hit or next((f for f in videos if _letters(f["path"]) == _letters(name)), None)
        if hit:
            return hit
    if index is not None and 0 <= index < len(files) and VIDEO.search(files[index]["path"]):
        if not name or _letters(files[index]["path"]) == _letters(name):
            return files[index]
        return None
    if not name and index is None:
        return max(videos, key=lambda f: f["size"])
    return None


# ---- torrents ---------------------------------------------------------------------------------


@dataclass
class Reader:
    position: int  # byte offset in the file
    waiting: bool = False
    started: float = field(default_factory=time.time)


@dataclass
class Selected:
    index: int
    path: str
    size: int
    offset: int  # of the file inside the torrent
    token: str
    mode: str = "prepare"  # prepare | play | download
    readers: list = field(default_factory=list)
    last_position: int | None = None
    hint: int | None = None  # byte offset playback will start from

    def url(self) -> str:
        return f"/file/{self.token}/{quote(Path(self.path).name)}"


class Torrent:
    def __init__(self, info_hash: str, handle, directory: Path):
        self.hash, self.handle, self.directory = info_hash, handle, directory
        self.created = self.touched = time.time()
        self.metadata_at: float | None = None
        self.peers_at: float | None = None
        self.error: str | None = None
        self.removed = False
        self.selected: dict[int, Selected] = {}
        self.cond = threading.Condition()
        self.cache: OrderedDict[int, bytes] = OrderedDict()
        self.reads: dict[int, threading.Event] = {}
        self.read_errors: dict[int, str] = {}
        self.deadlines: set[int] = set()
        self.last_priorities: list[int] | None = None

    def touch(self):
        self.touched = time.time()

    def busy(self) -> bool:
        return any(sel.readers or sel.mode == "download" for sel in self.selected.values())

    def downloading(self) -> bool:
        return any(sel.mode == "download" for sel in self.selected.values())


class Engine:
    def __init__(self, settings: Settings, lt=None):
        if lt is None:
            import libtorrent as lt
        self.lt, self.settings = lt, settings
        self.torrents: dict[str, Torrent] = {}
        self.tokens: dict[str, tuple[Torrent, Selected]] = {}
        self.lock = threading.RLock()
        self.stopping = threading.Event()
        self.listen_error: str | None = None
        self.bound: str | None = None
        # Cached data from an earlier run is never trusted.
        shutil.rmtree(settings.directory, ignore_errors=True)
        settings.directory.mkdir(parents=True, exist_ok=True)
        self.tunnel = check_tunnel(settings)
        self.session = lt.session(self._pack(self.tunnel))
        self.threads = [
            threading.Thread(target=self._alerts, name="torrentd-alerts", daemon=True),
            threading.Thread(target=self._tick, name="torrentd-tick", daemon=True),
        ]
        for thread in self.threads:
            thread.start()

    # ---- session settings -----------------------------------------------------------------

    def _pack(self, tunnel: dict) -> dict:
        lt, s = self.lt, self.settings
        port = s.listen_port
        interface = tunnel.get("interface") if s.require_vpn and s.bind_tunnel else None
        self.bound = interface
        category = lt.alert_category
        return {
            "user_agent": "Mediawan",
            # Bound to the tunnel interface when there is one, so libtorrent itself can only
            # use it; local discovery and router port mapping would leak past the VPN.
            "listen_interfaces": f"{interface}:{port}" if interface else f"0.0.0.0:{port},[::]:{port}",
            "outgoing_interfaces": interface or "",
            "enable_dht": s.dht,
            "enable_lsd": False,
            "enable_upnp": False,
            "enable_natpmp": False,
            "upload_rate_limit": max(0, s.upload_kbps) * 1024,
            "announce_to_all_trackers": True,
            "announce_to_all_tiers": True,
            # A prepared stream has all it wants once head and tail are in; libtorrent would then
            # drop every seed, and pressing play (or seeking) would start finding peers again.
            "close_redundant_connections": False,
            "connections_limit": 240,
            "active_downloads": 16,
            "active_limit": 32,
            "alert_mask": category.error | category.status | category.storage | category.piece_progress,
        }

    # ---- alerts ---------------------------------------------------------------------------

    def _find(self, handle) -> Torrent | None:
        try:
            key = str(handle.info_hash())
        except Exception:  # noqa: BLE001 - a handle of a torrent already removed
            return None
        return self.torrents.get(key)

    def _alerts(self):
        lt = self.lt
        while not self.stopping.is_set():
            if not self.session.wait_for_alert(250):
                continue
            for alert in self.session.pop_alerts():
                try:
                    self._on_alert(lt, alert)
                except Exception:
                    log.exception("Alert handling failed")

    def _on_alert(self, lt, alert):
        if isinstance(alert, lt.listen_failed_alert):
            self.listen_error = alert.message()
            log.error("Cannot listen: %s", self.listen_error)
            return
        if isinstance(alert, lt.listen_succeeded_alert):
            self.listen_error = None
            return
        torrent = self._find(alert.handle) if hasattr(alert, "handle") else None
        if torrent is None:
            return
        if isinstance(alert, lt.read_piece_alert):
            with torrent.cond:
                event = torrent.reads.pop(alert.piece, None)
                if alert.error and alert.error.value():
                    torrent.read_errors[alert.piece] = alert.error.message()
                else:
                    torrent.cache[alert.piece] = bytes(alert.buffer)
                    # A byte budget: many small pieces or a few large ones (up to 16 MiB each).
                    while len(torrent.cache) > 2 and sum(map(len, torrent.cache.values())) > CACHE_BYTES:
                        torrent.cache.popitem(last=False)
                if event:
                    event.set()
        elif isinstance(alert, lt.piece_finished_alert):
            with torrent.cond:
                torrent.cond.notify_all()
        elif isinstance(alert, lt.metadata_received_alert):
            torrent.metadata_at = time.time()
        elif isinstance(alert, (lt.torrent_error_alert, lt.file_error_alert)):
            torrent.error = alert.message()
            log.warning("Torrent %s: %s", torrent.hash[:8], torrent.error)
            with torrent.cond:
                torrent.cond.notify_all()

    # ---- the periodic check ---------------------------------------------------------------

    def _tick(self):
        while not self.stopping.wait(1.0):
            try:
                self.tick()
            except Exception:
                log.exception("Tick failed")

    def tick(self):
        tunnel = check_tunnel(self.settings)
        if tunnel["ok"] != self.tunnel["ok"] or tunnel.get("interface") != self.tunnel.get("interface"):
            if not tunnel["ok"]:
                log.error("Tunnel lost: %s", tunnel["message"])
                self.drop_all("vpn", "The VPN tunnel went down, so every torrent was stopped.")
            self.session.apply_settings(self._pack(tunnel))
        self.tunnel = tunnel
        now = time.time()
        for torrent in list(self.torrents.values()):
            if torrent.peers_at is None and self._peers(torrent):
                torrent.peers_at = now
            if not torrent.busy() and now - torrent.touched > self.settings.idle_seconds:
                log.info("Dropping idle torrent %s", torrent.hash[:8])
                self.remove(torrent.hash)
            else:
                self.reprioritize(torrent)
        free = self.free_bytes()
        if self.torrents and free is not None and free < self.settings.min_free_bytes / 2:
            self.drop_all("disk", "The disk is almost full, so every torrent was stopped.")

    def _peers(self, torrent: Torrent) -> int:
        try:
            return torrent.handle.status().num_peers
        except Exception:  # noqa: BLE001
            return 0

    def free_bytes(self) -> int | None:
        try:
            return shutil.disk_usage(self.settings.directory).free
        except OSError:
            return None

    # ---- adding and removing ----------------------------------------------------------------

    def add(self, info_hash: str, trackers: list[str]) -> Torrent:
        lt = self.lt
        info_hash = info_hash.lower()
        if not HASH.match(info_hash):
            raise Refused(400, "bad-request", "Not an info hash")
        if self.settings.allow_hashes and info_hash not in self.settings.allow_hashes:
            raise Refused(403, "not-allowed", "This torrent is not on the development allow-list")
        if not self.tunnel["ok"]:
            self.tunnel = check_tunnel(self.settings)
            if not self.tunnel["ok"]:
                raise Refused(503, "vpn", self.tunnel["message"])
        with self.lock:
            existing = self.torrents.get(info_hash)
            if existing:
                existing.touch()
                return existing
            while len(self.torrents) >= self.settings.max_torrents:
                idle = [t for t in self.torrents.values() if not t.busy()]
                if not idle:
                    raise Refused(409, "limit", "The torrent engine is busy with other streams")
                self.remove(min(idle, key=lambda t: t.touched).hash)
            directory = self.settings.directory / f"{info_hash}-{secrets.token_hex(4)}"
            directory.mkdir(parents=True, exist_ok=True)
            params = lt.parse_magnet_uri(f"magnet:?xt=urn:btih:{info_hash}")
            params.save_path = str(directory)
            announce = []
            for url in [*trackers, *self.settings.trackers, *OPEN_TRACKERS]:
                if isinstance(url, str) and url not in announce and len(announce) < 60:
                    announce.append(url)
            params.trackers = announce
            flags = lt.torrent_flags
            params.flags = (flags.default_flags & ~flags.auto_managed & ~flags.paused) | flags.default_dont_download
            handle = self.session.add_torrent(params)
            torrent = Torrent(info_hash, handle, directory)
            self.torrents[info_hash] = torrent
            log.info("Added torrent %s with %d trackers", info_hash[:8], len(announce))
            return torrent

    def get(self, info_hash: str) -> Torrent:
        torrent = self.torrents.get(info_hash.lower())
        if not torrent:
            raise Refused(404, "gone", "No such torrent; it may have expired")
        return torrent

    def remove(self, info_hash: str):
        with self.lock:
            torrent = self.torrents.pop(info_hash, None)
            if not torrent:
                return
            torrent.removed = True
            for sel in torrent.selected.values():
                self.tokens.pop(sel.token, None)
        with torrent.cond:
            torrent.cond.notify_all()
            for event in torrent.reads.values():
                event.set()
        try:
            self.session.remove_torrent(torrent.handle, self.lt.session.delete_files)
        except Exception:
            log.exception("Removing %s failed", info_hash[:8])

        def wipe():  # files can stay open for a moment after removal (Windows above all)
            for _ in range(10):
                shutil.rmtree(torrent.directory, ignore_errors=True)
                if not torrent.directory.exists():
                    return
                time.sleep(1)

        threading.Thread(target=wipe, daemon=True).start()

    def drop_all(self, reason: str, message: str):
        for info_hash in list(self.torrents):
            torrent = self.torrents.get(info_hash)
            if torrent:
                torrent.error = message
            self.remove(info_hash)
        log.warning("Dropped every torrent (%s)", reason)

    def close(self):
        self.stopping.set()
        for info_hash in list(self.torrents):
            self.remove(info_hash)

    # ---- choosing the file ------------------------------------------------------------------

    def files(self, torrent: Torrent) -> list[dict]:
        info = torrent.handle.torrent_file()
        if info is None:
            return []
        fs = info.files()
        pad = getattr(self.lt.file_storage, "flag_pad_file", 1)
        return [
            {"index": i, "path": fs.file_path(i).replace("\\", "/"), "size": fs.file_size(i)}
            for i in range(fs.num_files())
            if not fs.file_flags(i) & pad
        ]

    def select(self, torrent: Torrent, index: int | None, name: str = "", mode: str = "prepare") -> Selected:
        """Choose the video to stream: the one named in the listing, else the listing's index
        (counted without padding files), else the largest video."""
        torrent.touch()
        info = torrent.handle.torrent_file()
        if info is None:
            raise Refused(409, "not-ready", "The torrent's file list has not arrived yet")
        files = self.files(torrent)
        videos = [f for f in files if VIDEO.search(f["path"])]
        if not videos:
            raise Refused(422, "no-video", "This torrent has no video file")
        chosen = choose_file(videos, files, index, name)
        if chosen is None:
            # The listing named a file this torrent does not have: refuse rather than guess,
            # because guessing is how the wrong episode starts.
            raise Refused(422, "wrong-file", "The file the listing names is not in this torrent")
        with self.lock:
            existing = torrent.selected.get(chosen["index"])
            if existing:
                if mode in ("play", "download") and existing.mode != "download":
                    existing.mode = mode
                self.reprioritize(torrent)
                return existing
            self._ensure_space(torrent, chosen["size"])
            fs = info.files()
            sel = Selected(
                chosen["index"],
                chosen["path"],
                chosen["size"],
                fs.file_offset(chosen["index"]),
                secrets.token_hex(20),
                mode if mode in ("play", "download") else "prepare",
            )
            torrent.selected[sel.index] = sel
            self.tokens[sel.token] = (torrent, sel)
        # Piece priorities alone decide what is fetched. File priorities are deliberately left
        # at 0: libtorrent applies them asynchronously, after (and over) the piece priorities,
        # which made it fetch the whole file rarest-first. Data of a priority-0 file goes to a
        # part file, which read_piece reads just the same and removal deletes.
        torrent.last_priorities = None
        self.reprioritize(torrent)
        return sel

    def set_mode(self, torrent: Torrent, index: int, mode: str):
        sel = torrent.selected.get(index)
        if not sel:
            raise Refused(404, "gone", "That file is not selected")
        sel.mode = mode if mode in ("play", "download") else "prepare"
        torrent.touch()
        self.reprioritize(torrent)

    def unselect(self, torrent: Torrent, index: int):
        """Stop wanting one file; the torrent goes when nothing is left selected."""
        with self.lock:
            sel = torrent.selected.pop(index, None)
            if sel:
                self.tokens.pop(sel.token, None)
            empty = not torrent.selected
        if empty:
            self.remove(torrent.hash)
        else:
            torrent.last_priorities = None
            self.reprioritize(torrent)

    def release(self, torrent: Torrent):
        """A stream is done with this torrent: drop it, unless a file is being downloaded, in which
        case only the other files are let go."""
        if not torrent.downloading():
            return self.remove(torrent.hash)
        for index, sel in list(torrent.selected.items()):
            if sel.mode != "download":
                self.unselect(torrent, index)

    def _ensure_space(self, torrent: Torrent, size: int):
        def committed():
            return sum(s.size for t in self.torrents.values() for s in t.selected.values())

        while True:
            free = self.free_bytes()
            fits_cache = committed() + size <= self.settings.cache_bytes
            fits_disk = free is None or free - size >= self.settings.min_free_bytes
            if fits_cache and fits_disk:
                return
            idle = [t for t in self.torrents.values() if t is not torrent and not t.busy() and t.selected]
            if not idle:
                break
            self.remove(min(idle, key=lambda t: t.touched).hash)
        gb = lambda b: f"{b / GiB:.1f} GB"
        if not fits_cache:
            raise Refused(507, "disk", f"Streams may use {gb(self.settings.cache_bytes)} of disk and this "
                          f"file needs {gb(size)}. Stop another stream first.")  # fmt: skip
        raise Refused(507, "disk", f"Not enough free disk space for this file ({gb(size)}) while keeping "
                      f"{gb(self.settings.min_free_bytes)} free.")  # fmt: skip

    # ---- priorities -------------------------------------------------------------------------

    def reprioritize(self, torrent: Torrent):
        info = torrent.handle.torrent_file() if torrent.selected else None
        if info is None or torrent.removed:
            return
        piece_length, num_pieces = info.piece_length(), info.num_pieces()
        spans = []
        for sel in torrent.selected.values():
            first = sel.offset // piece_length
            last = (sel.offset + max(sel.size, 1) - 1) // piece_length
            head_end = (sel.offset + min(sel.size, HEAD_BYTES) - 1) // piece_length
            tail_start = (sel.offset + max(0, sel.size - TAIL_BYTES)) // piece_length
            readers = sorted({(sel.offset + r.position) // piece_length for r in sel.readers if r.position < sel.size})
            behind = None if sel.last_position is None else (sel.offset + sel.last_position) // piece_length
            window = max(4, WINDOW_BYTES // piece_length)
            hints = [] if sel.hint is None or sel.readers else [(sel.offset + min(sel.hint, sel.size - 1)) // piece_length]
            playing = sel.mode in ("play", "download")  # download: the whole file, in order
            spans.append(Span(first, last, head_end, tail_start, playing, readers, window, behind, hints))
        priorities, urgent = plan_pieces(num_pieces, spans)
        handle = torrent.handle
        if priorities != torrent.last_priorities:
            handle.prioritize_pieces(priorities)
            torrent.last_priorities = priorities
        # Never libtorrent's sequential mode: it takes pieces in index order and ignores the
        # priorities, so the tail FFprobe needs would come last. Deadlines do the ordering.
        missing = [p for p in urgent if not handle.have_piece(p)][:160]
        wanted = set(missing)
        for stale in torrent.deadlines - wanted:
            handle.reset_piece_deadline(stale)
        for rank, piece in enumerate(missing):
            if piece not in torrent.deadlines:
                handle.set_piece_deadline(piece, 150 + rank * 40)
        torrent.deadlines = wanted

    # ---- reading ----------------------------------------------------------------------------

    def prefetch(self, torrent: Torrent, pieces):
        """Start reading pieces that are already downloaded, so they are in memory when needed."""
        with torrent.cond:
            for piece in pieces:
                if piece in torrent.cache or piece in torrent.reads or not torrent.handle.have_piece(piece):
                    continue
                torrent.reads[piece] = threading.Event()
                torrent.handle.read_piece(piece)

    def read_piece(self, torrent: Torrent, piece: int, timeout: float = 30) -> bytes:
        for _ in range(2):  # a prefetched piece can be evicted before it is used: ask again
            with torrent.cond:
                data = torrent.cache.get(piece)
                if data is not None:
                    torrent.cache.move_to_end(piece)
                    return data
                event = torrent.reads.get(piece)
                if event is None:
                    event = torrent.reads[piece] = threading.Event()
                    torrent.handle.read_piece(piece)
            event.wait(timeout)
            with torrent.cond:
                data = torrent.cache.get(piece)
                if data is not None:
                    return data
                torrent.reads.pop(piece, None)
                error = torrent.read_errors.pop(piece, None)
                if error or torrent.removed:
                    raise OSError(error or "The torrent was removed")
        raise OSError("The piece could not be read")

    def wait_for(self, torrent: Torrent, sel: Selected, reader: Reader, piece: int, limit: float = 120) -> bool:
        if torrent.handle.have_piece(piece):
            return True
        reader.waiting = True
        deadline = time.time() + limit
        try:
            while not torrent.removed and time.time() < deadline:
                with torrent.cond:
                    torrent.cond.wait(0.25)
                if torrent.handle.have_piece(piece):
                    return True
                torrent.touch()
            return False
        finally:
            reader.waiting = False

    # ---- status -------------------------------------------------------------------------------

    def status(self, torrent: Torrent) -> dict:
        handle = torrent.handle
        st = handle.status()
        info = handle.torrent_file() if st.has_metadata else None
        selected = []
        if info is not None and torrent.selected:
            piece_length = info.piece_length()
            have = st.pieces
            progress = handle.file_progress(self.lt.torrent_handle.piece_granularity)
            for sel in torrent.selected.values():
                first = sel.offset // piece_length
                last = (sel.offset + max(sel.size, 1) - 1) // piece_length
                head_end = (sel.offset + min(sel.size, HEAD_BYTES) - 1) // piece_length
                tail_start = (sel.offset + max(0, sel.size - TAIL_BYTES)) // piece_length
                needed = sorted(set(range(first, head_end + 1)) | set(range(tail_start, last + 1)))
                done = sum(1 for p in needed if p < len(have) and have[p])
                position = max((r.position for r in sel.readers), default=sel.last_position or 0)
                piece = (sel.offset + position) // piece_length
                while piece <= last and piece < len(have) and have[piece]:
                    piece += 1
                ahead = max(0, min(sel.offset + sel.size, piece * piece_length) - (sel.offset + position))
                selected.append(
                    {
                        "index": sel.index,
                        "path": sel.path,
                        "size": sel.size,
                        "mode": sel.mode,
                        "url": sel.url(),
                        "downloaded": min(sel.size, progress[sel.index]) if sel.index < len(progress) else 0,
                        "complete": all(p < len(have) and have[p] for p in range(first, last + 1)),
                        "ready": done == len(needed),
                        "ready_fraction": round(done / len(needed), 3) if needed else 1.0,
                        "position": position,
                        "buffered_ahead": ahead,
                        "readers": [{"position": r.position, "waiting": r.waiting} for r in sel.readers],
                        "waiting": any(r.waiting and time.time() - r.started > 0.4 for r in sel.readers),
                    }
                )
        return {
            "hash": torrent.hash,
            "name": st.name,
            "has_metadata": bool(st.has_metadata),
            "peers": st.num_peers,
            "seeds": st.num_seeds,
            "download_rate": st.download_payload_rate,
            "upload_rate": st.upload_payload_rate,
            "progress": round(st.progress, 4),
            "error": torrent.error or (st.errc.message() if st.errc and st.errc.value() else None),
            "age": round(time.time() - torrent.created, 1),
            "metadata_after": round(torrent.metadata_at - torrent.created, 2) if torrent.metadata_at else None,
            "files": self.files(torrent)[:400] if info is not None else [],
            "selected": selected,
        }

    def overview(self) -> dict:
        used = sum(s.size for t in self.torrents.values() for s in t.selected.values())
        return {
            "tunnel": self.tunnel,
            "bound": self.bound,
            "listen_error": self.listen_error,
            "disk": {"committed": used, "cap": self.settings.cache_bytes, "free": self.free_bytes(),
                     "reserve": self.settings.min_free_bytes},
            "torrents": [self.status(t) for t in list(self.torrents.values())],
        }


# ---- HTTP ---------------------------------------------------------------------------------------

TYPES = {".mp4": "video/mp4", ".m4v": "video/mp4", ".mkv": "video/x-matroska", ".webm": "video/webm",
         ".avi": "video/x-msvideo", ".ts": "video/mp2t", ".m2ts": "video/mp2t", ".mov": "video/quicktime"}  # fmt: skip


def make_handler(engine: Engine, settings: Settings):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "mediawan-torrentd"

        def log_message(self, fmt, *args):  # quiet: FFmpeg makes many range requests
            log.debug("%s %s", self.address_string(), fmt % args)

        def handle(self):  # a client closing a kept-alive connection is not an error
            try:
                super().handle()
            except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
                pass

        # ---- plumbing ------------------------------------------------------------------
        def _json(self, status: int, body: dict):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return {}
            try:
                value = json.loads(self.rfile.read(min(length, 1 << 20)))
            except ValueError:
                raise Refused(400, "bad-request", "The body is not JSON") from None
            return value if isinstance(value, dict) else {}

        def _authorized(self) -> bool:
            given = self.headers.get("Authorization", "")
            expected = f"Bearer {settings.key}"
            return bool(settings.key) and hmac.compare_digest(given.encode(), expected.encode())

        def _route(self, method: str):
            path = self.path.split("?", 1)[0]
            try:
                if path == "/health":
                    return self._json(200, {"ok": True})
                if path.startswith("/file/"):
                    if method not in ("GET", "HEAD"):
                        raise Refused(405, "method", "Not allowed")
                    return self._file(path, head=method == "HEAD")
                if not path.startswith("/v1/"):
                    raise Refused(404, "missing", "Not found")
                if not self._authorized():
                    raise Refused(401, "key", "A valid TORRENT_KEY is required")
                parts = [unquote(p) for p in path[4:].strip("/").split("/") if p]
                return self._api(method, parts)
            except Refused as error:
                self._json(error.status, {"error": str(error), "reason": error.reason})
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            except Exception as error:
                log.exception("Request failed")
                try:
                    self._json(500, {"error": f"The torrent engine failed: {type(error).__name__}", "reason": "failed"})
                except OSError:
                    pass

        def do_GET(self):
            self._route("GET")

        def do_HEAD(self):
            self._route("HEAD")

        def do_POST(self):
            self._route("POST")

        def do_DELETE(self):
            self._route("DELETE")

        # ---- the control API ------------------------------------------------------------
        def _api(self, method: str, parts: list[str]):
            if parts == ["status"] and method == "GET":
                return self._json(200, engine.overview())
            if parts == ["torrents"] and method == "POST":
                body = self._body()
                trackers = [t for t in body.get("trackers") or [] if isinstance(t, str)][:40]
                torrent = engine.add(str(body.get("hash") or ""), trackers)
                return self._json(201, engine.status(torrent))
            if len(parts) >= 2 and parts[0] == "torrents":
                torrent = engine.get(parts[1])
                if len(parts) == 2 and method == "GET":
                    torrent.touch()
                    return self._json(200, engine.status(torrent))
                if len(parts) == 2 and method == "DELETE":
                    kept = torrent.downloading()
                    engine.release(torrent)
                    return self._json(200, {"ok": True, "kept": kept})
                if len(parts) == 4 and parts[2] == "files" and method == "DELETE":
                    engine.unselect(torrent, int(parts[3]))
                    return self._json(200, {"ok": True})
                if parts[2:] == ["files"] and method == "POST":
                    body = self._body()
                    index = body.get("index")
                    sel = engine.select(
                        torrent,
                        int(index) if isinstance(index, int) else None,
                        str(body.get("name") or ""),
                        str(body.get("mode") or "prepare"),
                    )
                    return self._json(200, {"index": sel.index, "path": sel.path, "size": sel.size, "url": sel.url()})
                if len(parts) == 5 and parts[2] == "files" and parts[4] == "mode" and method == "POST":
                    engine.set_mode(torrent, int(parts[3]), str(self._body().get("mode") or "prepare"))
                    return self._json(200, {"ok": True})
                if len(parts) == 5 and parts[2] == "files" and parts[4] == "hint" and method == "POST":
                    sel = torrent.selected.get(int(parts[3]))
                    if not sel:
                        raise Refused(404, "gone", "That file is not selected")
                    position = self._body().get("position")
                    sel.hint = max(0, int(position)) if isinstance(position, (int, float)) else None
                    engine.reprioritize(torrent)
                    return self._json(200, {"ok": True})
            raise Refused(404, "missing", "Not found")

        # ---- the file itself ------------------------------------------------------------
        def _file(self, path: str, head: bool):
            token = path.split("/")[2] if path.count("/") >= 2 else ""
            found = engine.tokens.get(token)
            if not found or found[0].removed:
                raise Refused(404, "gone", "This stream has ended")
            torrent, sel = found
            size = sel.size
            start, end = 0, size - 1
            ranged = re.match(r"^bytes=(\d*)-(\d*)$", self.headers.get("Range", "").strip())
            if ranged and (ranged.group(1) or ranged.group(2)):
                if ranged.group(1) == "":
                    start = max(0, size - int(ranged.group(2)))
                else:
                    start = int(ranged.group(1))
                    if ranged.group(2):
                        end = min(end, int(ranged.group(2)))
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
            self.send_response(206 if ranged else 200)
            # One request per connection: FFmpeg reuses a kept-alive connection for its next
            # range request while this body is still streaming, which breaks both.
            self.close_connection = True
            self.send_header("Connection", "close")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Type", TYPES.get(Path(sel.path).suffix.lower(), "application/octet-stream"))
            self.send_header("Content-Length", str(end - start + 1))
            if ranged:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            if head:
                return
            torrent.touch()
            reader = Reader(start)
            sel.readers.append(reader)
            engine.reprioritize(torrent)  # a seek moves the download window at once
            info = torrent.handle.torrent_file()
            piece_length = info.piece_length()
            last_piece = (sel.offset + end) // piece_length
            position = start
            planned_at, planned_piece = time.time(), -1
            try:
                while position <= end:
                    absolute = sel.offset + position
                    piece = absolute // piece_length
                    if not engine.wait_for(torrent, sel, reader, piece):
                        log.warning("Gave up waiting for piece %d of %s", piece, torrent.hash[:8])
                        break
                    # Ask for the next pieces already here while this one is sent.
                    ahead = max(1, min(8, CACHE_BYTES // piece_length // 2))
                    engine.prefetch(torrent, range(piece + 1, min(last_piece, piece + ahead) + 1))
                    data = engine.read_piece(torrent, piece)
                    begin = absolute - piece * piece_length
                    stop = min(len(data), sel.offset + end + 1 - piece * piece_length)
                    chunk = memoryview(data)[begin:stop]
                    for i in range(0, len(chunk), 256 * 1024):
                        self.wfile.write(chunk[i : i + 256 * 1024])
                    position += len(chunk)
                    reader.position = position
                    sel.last_position = position
                    torrent.touch()
                    # Move the window as the reader advances, but not after every small piece.
                    if piece - planned_piece >= 8 or time.time() - planned_at > 0.5:
                        planned_at, planned_piece = time.time(), piece
                        engine.reprioritize(torrent)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                self.close_connection = True
            finally:
                if reader in sel.readers:
                    sel.readers.remove(reader)
                if not torrent.removed:
                    engine.reprioritize(torrent)
            if position <= end:
                self.close_connection = True  # the body is short: the client must reconnect

    return Handler


def serve(settings: Settings, engine: Engine | None = None) -> ThreadingHTTPServer:
    engine = engine or Engine(settings)
    server = ThreadingHTTPServer((settings.host, settings.port), make_handler(engine, settings))
    server.daemon_threads = True
    server.engine = engine  # type: ignore[attr-defined]
    return server


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = Settings.from_env()
    if not settings.key:
        sys.exit("TORRENT_KEY is not set. Give the torrent service and Mediawan the same long random key.")
    if settings.allow_hashes:
        log.warning("DEVELOPMENT: only these info hashes may be added: %s", ", ".join(sorted(settings.allow_hashes)))
    server = serve(settings)
    tunnel = server.engine.tunnel  # type: ignore[attr-defined]
    log.info("Torrent engine on %s:%d, cache %s (%.0f GB cap). %s", settings.host, settings.port,
             settings.directory, settings.cache_bytes / GiB, tunnel["message"])  # fmt: skip
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.engine.close()  # type: ignore[attr-defined]


if __name__ == "__main__":
    main()
