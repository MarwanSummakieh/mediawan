"""Generate small real video files with FFmpeg, for tests and for previewing the UI.

python -m mediawan.samples <folder>     builds a demo library under <folder>
"""

import shutil
import subprocess
import sys
from pathlib import Path

SRT = """1
00:00:01,000 --> 00:00:04,000
Hello from {name}

2
00:00:05,000 --> 00:00:08,000
<i>Second line</i>
"""


def ffmpeg(*args: str):
    subprocess.run(["ffmpeg", "-hide_banner", "-v", "error", "-y", *args], check=True, timeout=300)


def clip(path: Path, kind: str = "mp4", seconds: int = 12, label: str = "") -> Path:
    """kind: mp4 (H.264+AAC, direct play), mkv (H.264+AC-3 5.1+SRT, remux),
    legacy (MPEG-4 ASP+MP3 in AVI, transcode), hi10 (10-bit H.264+FLAC in MKV, transcode)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = (label or path.stem).replace(":", " ").replace("'", "")[:40]
    try:
        _encode(path, kind, seconds, text, overlay=bool(label))
    except subprocess.CalledProcessError:
        if not label:
            raise
        _encode(path, kind, seconds, text, overlay=False)  # FFmpeg built without fonts
    return path


def _encode(path: Path, kind: str, seconds: int, text: str, overlay: bool):
    video = f"testsrc2=size=640x360:rate=24:duration={seconds}"
    if overlay:
        video += (
            f",drawtext=text='{text}':fontsize=28:x=20:y=20:fontcolor=white:box=1:boxcolor=black"
        )
    src = [
        "-f",
        "lavfi",
        "-i",
        video,
        "-f",
        "lavfi",
        "-i",
        f"sine=frequency=440:duration={seconds}",
    ]
    if kind == "mp4":
        ffmpeg(
            *src,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "48",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            str(path),
        )
    elif kind == "mkv":
        srt = path.with_suffix(".embedded.srt.tmp")
        srt.write_text(SRT.format(name=text), encoding="utf-8")
        ffmpeg(
            *src,
            "-f",
            "srt",
            "-i",
            str(srt),
            "-map",
            "0",
            "-map",
            "1",
            "-map",
            "2",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "48",
            "-c:a",
            "ac3",
            "-ac",
            "6",
            "-c:s",
            "srt",
            "-metadata:s:a:0",
            "language=eng",
            "-metadata:s:s:0",
            "language=eng",
            str(path),
        )
        srt.unlink()
    elif kind == "legacy":
        ffmpeg(*src, "-c:v", "mpeg4", "-q:v", "5", "-c:a", "libmp3lame", str(path))
    elif kind == "hi10":
        ffmpeg(
            *src,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p10le",
            "-c:a",
            "flac",
            str(path),
        )
    else:
        raise ValueError(kind)


def demo_library(root: Path) -> list[Path]:
    """A small library that exercises every layout and playback path."""
    root = Path(root)
    made = []

    def add(rel: str, kind: str, seconds: int = 20):
        made.append(clip(root / rel, kind, seconds, Path(rel).stem))

    add("Movies/Big Buck Bunny (2008)/Big.Buck.Bunny.2008.1080p.mp4", "mp4", 60)
    add("Movies/Sintel (2010)/Sintel.2010.720p.BluRay.mkv", "mkv", 60)
    add("Movies/Night of the Living Dead (1968)/Night.of.the.Living.Dead.1968.avi", "legacy", 30)
    add("Movies/Tears of Steel (2012)/Tears.of.Steel.2012.10bit.mkv", "hi10", 30)
    (root / "Movies/Big Buck Bunny (2008)/Big.Buck.Bunny.2008.1080p.en.srt").write_text(
        SRT.format(name="a sidecar file"), encoding="utf-8"
    )
    for e in range(1, 4):
        add(f"TV/The Office/Season 01/The.Office.S01E0{e}.720p.mkv", "mkv", 30)
    for e in range(1, 3):
        add(f"TV/The Office/Season 02/The.Office.S02E0{e}.mp4", "mp4", 30)
    for e in range(1, 4):
        add(f"TV/Frieren/[SubsPlease] Frieren - {e:02d} (1080p).mkv", "mkv", 30)
    add("TV/random-clip.mp4", "mp4", 10)  # lands in the review list
    return made


if __name__ == "__main__":
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "media/demo")
    if not shutil.which("ffmpeg"):
        sys.exit("FFmpeg is not on PATH")
    for p in demo_library(target):
        print(p)
