"""Probing, playback decisions, HLS sessions and subtitle conversion.

The decision is made from the codecs ffprobe reports, never from the file extension:

  direct     the browser can play the file as it is (MP4/WebM with codecs it supports)
  remux      the video stream is copied into HLS untouched; only audio is converted, and
             only when the browser cannot play it (DTS, TrueHD…)
  transcode  the last resort, for video the browser cannot decode (MPEG-4 ASP, 10-bit H.264,
             HEVC on a browser without HEVC…). Uses QuickSync or VA-API when configured.
"""

import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from .parse import lang_code

log = logging.getLogger("mediawan.media")

TEXT_SUBTITLE_CODECS = {"subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"}
HLS_FILE = re.compile(r"^(index\.m3u8|init\.mp4|seg\d{5}\.m4s)$")
SEGMENT_SECONDS = 4
IDLE_SECONDS = 90
HW_DECODE = {"h264", "hevc", "mpeg2video", "vc1", "vp8", "vp9", "av1", "mjpeg"}


class Busy(Exception):
    """Every transcode slot is in use."""


# ---- probing -------------------------------------------------------------------------------


def _fps(rate: str | None) -> float:
    try:
        num, den = (rate or "0/1").split("/")
        return float(num) / float(den) if float(den) else 0.0
    except ValueError:
        return 0.0


def summarise(raw: dict) -> dict:
    """Reduce ffprobe JSON to what playback decisions need."""
    fmt = raw.get("format", {})
    out = {
        "container": fmt.get("format_name", ""),
        "duration": float(fmt.get("duration") or 0),
        "start": float(fmt.get("start_time") or 0),
        "bitrate": int(fmt.get("bit_rate") or 0),
        "video": [],
        "audio": [],
        "subtitles": [],
    }
    for s in raw.get("streams", []):
        tags = {k.lower(): v for k, v in (s.get("tags") or {}).items()}
        disp = s.get("disposition") or {}
        kind = s.get("codec_type")
        base = {
            "index": s["index"],
            "codec": s.get("codec_name", "unknown"),
            "lang": lang_code(tags.get("language")) if tags.get("language") != "und" else None,
            "title": tags.get("title"),
            "default": bool(disp.get("default")),
        }
        if kind == "video" and not disp.get("attached_pic"):
            pix = s.get("pix_fmt") or ""
            depth = int(s.get("bits_per_raw_sample") or 0) or (
                10 if "10" in pix else 12 if "12" in pix else 8
            )
            out["video"].append(
                {
                    **base,
                    "profile": s.get("profile"),
                    "pix_fmt": pix,
                    "width": s.get("width", 0),
                    "height": s.get("height", 0),
                    "bit_depth": depth,
                    "hdr": s.get("color_transfer") in ("smpte2084", "arib-std-b67"),
                    "fps": round(_fps(s.get("avg_frame_rate") or s.get("r_frame_rate")), 3),
                }
            )
        elif kind == "audio":
            out["audio"].append(
                {**base, "channels": s.get("channels", 2), "layout": s.get("channel_layout")}
            )
        elif kind == "subtitle":
            out["subtitles"].append(
                {
                    **base,
                    "forced": bool(disp.get("forced")),
                    "text": s.get("codec_name") in TEXT_SUBTITLE_CODECS,
                }
            )
    if not out["duration"]:
        durations = [float(s.get("duration") or 0) for s in raw.get("streams", [])]
        out["duration"] = max(durations, default=0.0)
    return out


def probe(ffprobe: str, path: str | Path) -> dict:
    result = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        capture_output=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(
            result.stderr.decode(errors="replace").strip()[-400:] or "ffprobe failed"
        )
    return summarise(json.loads(result.stdout or b"{}"))


# ---- what the client can play ----------------------------------------------------------------


@dataclass
class Caps:
    video: set = field(default_factory=lambda: {"h264"})
    audio: set = field(default_factory=lambda: {"aac", "mp3"})
    containers: set = field(default_factory=lambda: {"mp4"})
    max_height: int = 2160
    channels: int = 6
    # Audio the device plays inside our fMP4 HLS. Can be narrower than `audio`: Chromium plays an
    # MP3 file but rejects MP3 in fMP4 through MediaSource. None = same as `audio`.
    hls_audio: set | None = None

    def streamable_audio(self) -> set:
        return self.audio if self.hls_audio is None else self.hls_audio

    @classmethod
    def parse(cls, data: dict | None) -> "Caps":
        """From the browser's own MediaSource/canPlayType checks, sent with each play request."""
        data = data or {}
        caps = cls()

        def words(value, allowed):
            items = value.split(",") if isinstance(value, str) else (value or [])
            return {w.strip().lower() for w in items if w and w.strip().lower() in allowed}

        caps.video |= words(data.get("video"), {"h264", "hevc", "av1", "vp9", "vp8"})
        audio_codecs = {"aac", "mp3", "opus", "flac", "ac3", "eac3", "vorbis"}
        caps.audio |= words(data.get("audio"), audio_codecs)
        if "hls_audio" in data:  # replaces the default rather than adding to it
            caps.hls_audio = {"aac"} | words(data.get("hls_audio"), audio_codecs)
        caps.containers |= words(data.get("containers"), {"mp4", "webm"})
        if data.get("max_height"):
            caps.max_height = max(240, int(data["max_height"]))
        if data.get("channels"):
            caps.channels = max(1, min(8, int(data["channels"])))
        return caps


@dataclass
class Plan:
    mode: str  # direct | remux | transcode
    video: str  # copy | encode
    audio: str  # copy | aac | none
    audio_index: int | None
    reasons: list = field(default_factory=list)
    height: int = 0  # output height when encoding


def video_playable(v: dict, caps: Caps) -> str | None:
    """None if the browser can decode this video stream as it is, else why not."""
    if v["codec"] not in caps.video:
        return f"{v['codec']} video is not supported by this device"
    if v["codec"] == "h264" and (
        v["bit_depth"] > 8 or "444" in v["pix_fmt"] or "422" in v["pix_fmt"]
    ):
        return "10-bit or 4:2:2/4:4:4 H.264 does not decode in browsers"
    if v["height"] > caps.max_height:
        return f"{v['height']}p is above this device's {caps.max_height}p limit"
    return None


def pick_audio(
    info: dict, requested: int | None = None, language: str | None = None
) -> dict | None:
    tracks = info["audio"]
    if not tracks:
        return None
    if requested is not None:
        for t in tracks:
            if t["index"] == requested:
                return t
    if language:
        matching = [t for t in tracks if t["lang"] == language]
        if matching:
            return next((t for t in matching if t["default"]), matching[0])
    return next((t for t in tracks if t["default"]), tracks[0])


def container_of(info: dict, path: str) -> str | None:
    name = info["container"]
    if "mp4" in name or "mov" in name:
        return "mp4"
    # Matroska and WebM share a format name; only WebM-legal codecs in a .webm play natively.
    if name.startswith("matroska") and str(path).lower().endswith(".webm"):
        return "webm"
    return None


def plan(
    info: dict,
    caps: Caps,
    path: str = "",
    audio_index: int | None = None,
    language: str | None = None,
) -> Plan:
    if not info.get("video"):
        raise ValueError("This file has no video stream")
    v = info["video"][0]
    a = pick_audio(info, audio_index, language)
    reasons = []
    video_problem = video_playable(v, caps)
    audio_ok = a is None or (a["codec"] in caps.audio and a["channels"] <= max(caps.channels, 2))
    container = container_of(info, path)
    if (
        not video_problem
        and audio_ok
        and container in caps.containers
        and (a is None or a["index"] == info["audio"][0]["index"])
    ):
        return Plan("direct", "copy", "copy" if a else "none", a and a["index"], ["plays as is"])
    if container not in caps.containers:
        reasons.append(f"{info['container'].split(',')[0]} container needs repackaging")
    elif a and a["index"] != info["audio"][0]["index"]:
        reasons.append("a non-default audio track was chosen")
    stream_ok = audio_ok and (a is None or a["codec"] in caps.streamable_audio())
    if a and not stream_ok:
        reasons.append(f"{a['codec']} audio is converted to AAC")
    audio = "none" if a is None else ("copy" if stream_ok else "aac")
    if not video_problem:
        reasons.append(f"{v['codec']} video is copied without re-encoding")
        return Plan("remux", "copy", audio, a and a["index"], reasons)
    reasons.append(video_problem)
    height = min(v["height"] or 1080, caps.max_height, 1080)
    return Plan("transcode", "encode", audio, a and a["index"], reasons, height)


def escalate(the_plan: Plan, info: dict, caps: Caps, mode: str) -> Plan:
    """The browser failed with the chosen mode: step up to remux or transcode, never down."""
    order = ["direct", "remux", "transcode"]
    if mode not in order or order.index(mode) <= order.index(the_plan.mode):
        return the_plan
    v = info["video"][0]
    if mode == "remux":
        track = next((a for a in info["audio"] if a["index"] == the_plan.audio_index), None)
        audio = the_plan.audio
        if audio == "copy" and track and track["codec"] not in caps.streamable_audio():
            audio = "aac"
        return Plan(
            "remux",
            "copy",
            audio,
            the_plan.audio_index,
            ["direct play failed on this device; repackaging instead"],
        )
    height = min(v["height"] or 1080, caps.max_height, 1080)
    return Plan(
        "transcode",
        "encode",
        "aac" if the_plan.audio_index is not None else "none",
        the_plan.audio_index,
        ["this device could not play the copied stream"],
        height,
    )


def choose_file(files: list[dict], caps: Caps) -> dict | None:
    """Of several copies of one item, prefer the one needing the least work, then the sharpest."""
    rank = {"direct": 0, "remux": 1, "transcode": 2}
    best, best_key = None, None
    for f in files:
        if f.get("missing"):
            continue
        info = json.loads(f["probe"]) if isinstance(f.get("probe"), str) else f.get("probe")
        if not info or info.get("error") or not info.get("video"):
            key = (3, 0)
        else:
            key = (rank[plan(info, caps, f["path"]).mode], -info["video"][0]["height"])
        if best_key is None or key < best_key:
            best, best_key = f, key
    return best


# ---- ffmpeg commands ---------------------------------------------------------------------------


def _even(value: float) -> int:
    return max(2, round(value / 2) * 2)


def video_encode_args(v: dict, height: int, hwaccel: str, device: str) -> tuple[list, list]:
    """(input args, output args) to encode video to 8-bit H.264."""
    width = _even(v["width"] * height / v["height"]) if v["height"] else 1920
    scale = v["height"] > height
    gop = str(max(24, round((v.get("fps") or 24) * SEGMENT_SECONDS)))
    # Codecs the GPU can decode. Anything else (MPEG-4 ASP, WMV, 10-bit H.264) is decoded in
    # software and uploaded, so the expensive encode still runs on the GPU.
    gpu_decode = v["codec"] in HW_DECODE and not (v["codec"] == "h264" and v["bit_depth"] > 8)
    if hwaccel == "qsv":
        vpp = "vpp_qsv=format=nv12" + (f":w={width}:h={height}" if scale else "")
        if v.get("hdr"):
            vpp += ":tonemap=1"
        decode = ["-hwaccel", "qsv", "-hwaccel_output_format", "qsv"] if gpu_decode else []
        upload = "" if gpu_decode else "format=nv12,hwupload=extra_hw_frames=64,"
        return (
            [
                "-init_hw_device",
                f"vaapi=va:{device}",
                "-init_hw_device",
                "qsv=qs@va",
                "-filter_hw_device",
                "qs",
                *decode,
            ],
            [
                "-vf",
                upload + vpp,
                "-c:v",
                "h264_qsv",
                "-preset",
                "veryfast",
                "-global_quality",
                "23",
                "-look_ahead",
                "0",
                "-g",
                gop,
                "-profile:v",
                "high",
            ],
        )
    if hwaccel == "vaapi":
        sv = "scale_vaapi=format=nv12" + (f":w={width}:h={height}" if scale else "")
        decode = ["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi"] if gpu_decode else []
        upload = "" if gpu_decode else "format=nv12,hwupload,"
        return (
            [
                "-init_hw_device",
                f"vaapi=va:{device}",
                "-filter_hw_device",
                "va",
                *(["-hwaccel_device", "va"] if gpu_decode else []),
                *decode,
            ],
            [
                "-vf",
                upload + sv,
                "-c:v",
                "h264_vaapi",
                "-qp",
                "23",
                "-g",
                gop,
                "-profile:v",
                "high",
            ],
        )
    vf = (f"scale={width}:{height}," if scale else "") + "format=yuv420p"
    return (
        [],
        [
            "-vf",
            vf,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "21",
            "-profile:v",
            "high",
            "-g",
            gop,
            "-force_key_frames",
            f"expr:gte(t,n_forced*{SEGMENT_SECONDS})",
        ],
    )


def audio_args(info: dict, the_plan: Plan, caps: Caps) -> list:
    if the_plan.audio == "none":
        return ["-an"]
    if the_plan.audio == "copy":
        return ["-c:a", "copy"]
    track = next(a for a in info["audio"] if a["index"] == the_plan.audio_index)
    channels = min(track["channels"] or 2, caps.channels, 6)
    channels = 2 if channels not in (1, 2, 6) else channels
    return ["-c:a", "aac", "-ac", str(channels), "-b:a", "384k" if channels == 6 else "192k"]


def hls_command(
    ffmpeg: str,
    path: str,
    info: dict,
    the_plan: Plan,
    caps: Caps,
    start: float,
    hwaccel: str = "none",
    device: str = "/dev/dri/renderD128",
    throttle: bool = True,
) -> list:
    v = info["video"][0]
    pre, video = (["-noaccurate_seek"], ["-c:v", "copy"])
    if the_plan.video == "encode":
        pre, video = video_encode_args(v, the_plan.height, hwaccel, device)
    elif v["codec"] == "hevc":
        video += ["-tag:v", "hvc1"]  # Safari and many TVs only accept HEVC tagged hvc1 in MP4
    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "warning", "-y", *pre]
    if throttle:
        # Stay ahead of the viewer without filling the disk with a whole remuxed film at once.
        cmd += ["-readrate", "2", "-readrate_initial_burst", "60"]
    if start > 0:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", str(path), "-map", f"0:{v['index']}"]
    if the_plan.audio_index is not None:
        cmd += ["-map", f"0:{the_plan.audio_index}"]
    cmd += [
        *video,
        *audio_args(info, the_plan, caps),
        "-sn",
        "-dn",
        "-max_muxing_queue_size",
        "4096",
        "-avoid_negative_ts",
        "make_zero",
        "-f",
        "hls",
        "-hls_time",
        str(SEGMENT_SECONDS),
        "-hls_list_size",
        "0",
        "-hls_playlist_type",
        "event",
        "-hls_segment_type",
        "fmp4",
        "-hls_fmp4_init_filename",
        "init.mp4",
        "-hls_segment_filename",
        "seg%05d.m4s",
        "-hls_flags",
        "independent_segments+temp_file",
        "-start_number",
        "0",
        "index.m3u8",
    ]
    return cmd  # run it with cwd= the session folder: FFmpeg writes init.mp4 relative to it


def keyframe_before(ffprobe: str, path: str, start: float, info: dict) -> float:
    """Copied video can only start on a keyframe. Find it so the clock shown is exact."""
    if start <= 0:
        return 0.0
    try:
        result = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-read_intervals",
                f"{start:.3f}%+#1",
                "-show_entries",
                "packet=pts_time,flags",
                "-of",
                "csv=p=0",
                str(path),
            ],
            capture_output=True,
            timeout=20,
        )
        for line in result.stdout.decode().splitlines():
            pts, _, flags = line.partition(",")
            if "K" in flags and pts not in ("", "N/A"):
                found = float(pts) - info.get("start", 0)
                if 0 <= found <= start:
                    return found
    except (subprocess.SubprocessError, ValueError):
        pass
    return start


def supports_readrate_burst(ffmpeg: str) -> bool:
    """-readrate_initial_burst arrived in FFmpeg 6.1; older builds would refuse the command."""
    try:
        out = subprocess.run(
            [ffmpeg, "-hide_banner", "-h", "full"], capture_output=True, timeout=20
        )
        return b"readrate_initial_burst" in out.stdout
    except (OSError, subprocess.SubprocessError):
        return False


# ---- sessions --------------------------------------------------------------------------------


def no_logins(text: str) -> str:
    """Online streams are read from URLs that carry a login; never log or show it."""
    return re.sub(r"//[^/@\s]+@", "//", text)


@dataclass
class Session:
    id: str
    user_id: int
    client: str
    file_id: int
    item_id: int
    path: str
    plan: Plan
    start: float
    dir: Path
    caps: Caps
    info: dict
    hwaccel: str
    process: subprocess.Popen | None = None
    touched: float = field(default_factory=time.time)
    created: float = field(default_factory=time.time)
    error: str | None = None
    finished: bool = False

    def public(self) -> dict:
        return {
            "id": self.id,
            "mode": self.plan.mode,
            "start": self.start,
            "file_id": self.file_id,
            "item_id": self.item_id,
            "user_id": self.user_id,
            "reasons": self.plan.reasons,
            "hwaccel": self.hwaccel if self.plan.video == "encode" else None,
            "error": self.error,
            "finished": self.finished,
            "age": int(time.time() - self.created),
        }


class Sessions:
    def __init__(
        self,
        ffmpeg: str,
        ffprobe: str,
        runtime: Path,
        hwaccel: str = "none",
        max_transcodes: int = 2,
        device: str = "/dev/dri/renderD128",
    ):
        self.ffmpeg, self.ffprobe = ffmpeg, ffprobe
        self.root = Path(runtime) / "sessions"
        self.hwaccel, self.device = hwaccel, device
        self.max_transcodes = max_transcodes
        self.max_remux = max_transcodes * 4  # copying streams costs almost nothing
        self.items: dict[str, Session] = {}
        self.lock = threading.RLock()
        self.throttle = supports_readrate_burst(ffmpeg)
        shutil.rmtree(self.root, ignore_errors=True)  # leftovers from a previous run
        self.root.mkdir(parents=True, exist_ok=True)

    def start(
        self,
        *,
        user_id: int,
        client: str,
        file: dict,
        item_id: int,
        info: dict,
        the_plan: Plan,
        caps: Caps,
        start: float = 0.0,
    ) -> Session:
        with self.lock:
            for s in list(self.items.values()):
                if s.user_id == user_id and s.client == client:
                    self.stop(s.id)
            heavy = the_plan.mode == "transcode"
            running = [s for s in self.items.values() if (s.plan.mode == "transcode") == heavy]
            limit = self.max_transcodes if heavy else self.max_remux
            if len(running) >= limit:
                raise Busy(f"All {limit} {'transcode' if heavy else 'stream'} slots are in use")
            sid = secrets.token_hex(8)
            directory = self.root / sid
            directory.mkdir(parents=True)
            if the_plan.video == "copy":
                start = keyframe_before(self.ffprobe, file["path"], start, info)
            session = Session(
                sid,
                user_id,
                client,
                file["id"],
                item_id,
                file["path"],
                the_plan,
                start,
                directory,
                caps,
                info,
                self.hwaccel if the_plan.video == "encode" else "none",
            )
            self.items[sid] = session
            self._spawn(session)
            return session

    def _spawn(self, s: Session):
        cmd = hls_command(
            self.ffmpeg,
            s.path,
            s.info,
            s.plan,
            s.caps,
            s.start,
            s.hwaccel,
            self.device,
            self.throttle,
        )
        log.info("Session %s (%s): %s", s.id, s.plan.mode, no_logins(" ".join(cmd)))
        with open(s.dir / "ffmpeg.log", "ab") as logfile:  # the child keeps its own handle
            s.process = subprocess.Popen(
                cmd, cwd=s.dir, stdin=subprocess.DEVNULL, stdout=logfile, stderr=logfile
            )
        threading.Thread(target=self._watch, args=(s, s.process), daemon=True).start()

    def _watch(self, s: Session, process: subprocess.Popen):
        code = process.wait()
        if s.id not in self.items or process is not s.process:
            return  # stopped on purpose, or replaced by a software retry
        if code == 0:
            s.finished = True
            return
        tail = self.log_tail(s)
        segments = list(s.dir.glob("seg*.m4s"))
        if s.hwaccel != "none" and not segments:
            log.warning("Hardware %s transcode failed, retrying in software: %s", s.hwaccel, tail)
            s.hwaccel = "none"
            for leftover in s.dir.glob("*"):
                if leftover.name != "ffmpeg.log":
                    leftover.unlink(missing_ok=True)
            self._spawn(s)
            return
        s.error = tail or f"ffmpeg exited with code {code}"
        log.error("Session %s failed: %s", s.id, s.error)

    def log_tail(self, s: Session) -> str:
        try:
            text = (s.dir / "ffmpeg.log").read_text(errors="replace").strip()
        except OSError:
            return ""
        return no_logins("\n".join(text.splitlines()[-5:]))

    def get(self, sid: str) -> Session | None:
        session = self.items.get(sid)
        if session:
            session.touched = time.time()
        return session

    def stop(self, sid: str):
        with self.lock:
            session = self.items.pop(sid, None)
        if not session:
            return
        if session.process and session.process.poll() is None:
            session.process.kill()
            try:
                session.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        shutil.rmtree(session.dir, ignore_errors=True)

    def cleanup(self, idle: float = IDLE_SECONDS) -> int:
        cutoff = time.time() - idle
        stale = [s.id for s in list(self.items.values()) if s.touched < cutoff]
        for sid in stale:
            log.info("Stopping idle session %s", sid)
            self.stop(sid)
        return len(stale)

    def stop_all(self):
        for sid in list(self.items):
            self.stop(sid)

    def wait_for(self, s: Session, name: str, timeout: float = 30) -> Path | None:
        """Block until ffmpeg has written a playlist with a segment, or a named segment."""
        target = s.dir / name
        deadline = time.time() + timeout
        while time.time() < deadline:
            if s.error:
                return None
            if target.exists() and (name != "index.m3u8" or "#EXTINF" in _read(target)):
                return target
            if s.finished and not target.exists():
                return None
            time.sleep(0.2)
        return None


def _read(path: Path) -> str:
    try:  # FFmpeg replaces the playlist atomically; on Windows a read can race the rename
        return path.read_text(errors="ignore")
    except OSError:
        return ""


# ---- subtitles ---------------------------------------------------------------------------------


class Subtitles:
    """Text subtitles, embedded or sidecar, converted once to WebVTT and cached."""

    def __init__(self, ffmpeg: str, cache: Path):
        self.ffmpeg = ffmpeg
        self.cache = Path(cache) / "subtitles"
        self.locks: dict[str, threading.Lock] = {}
        self.guard = threading.Lock()

    def _lock(self, key: str) -> threading.Lock:
        with self.guard:
            return self.locks.setdefault(key, threading.Lock())

    def embedded(self, file: dict, stream_index: int) -> Path:
        key = f"{file['id']}-{stream_index}-{int(file['mtime'])}"
        return self._convert(key, ["-i", file["path"], "-map", f"0:{stream_index}"])

    def sidecar(self, sub: dict) -> Path:
        path = Path(sub["path"])
        stamp = int(path.stat().st_mtime)
        if sub["format"] == "vtt":
            return path
        key = f"x{sub['id']}-{stamp}"
        raw = path.read_bytes()[:200000]
        charenc = []
        try:
            raw.decode("utf-8")
        except UnicodeDecodeError:
            charenc = ["-sub_charenc", "CP1252"]  # the usual encoding of older .srt files
        return self._convert(key, [*charenc, "-i", str(path), "-map", "0:s:0"])

    def _convert(self, key: str, inputs: list) -> Path:
        target = self.cache / f"{key}.vtt"
        with self._lock(key):
            if target.exists():
                return target
            self.cache.mkdir(parents=True, exist_ok=True)
            partial = target.with_suffix(".part")
            result = subprocess.run(
                [
                    self.ffmpeg,
                    "-hide_banner",
                    "-nostdin",
                    "-v",
                    "error",
                    "-y",
                    *inputs,
                    "-c:s",
                    "webvtt",
                    "-f",
                    "webvtt",
                    str(partial),
                ],
                capture_output=True,
                timeout=900,
            )
            if result.returncode != 0 or not partial.exists():
                partial.unlink(missing_ok=True)
                raise RuntimeError(
                    result.stderr.decode(errors="replace")[-300:] or "conversion failed"
                )
            os.replace(partial, target)
            return target
