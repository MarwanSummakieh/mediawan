import shutil
from pathlib import Path

import pytest

from mediawan.samples import clip

needs_ffmpeg = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="FFmpeg is not installed"
)


@pytest.fixture(scope="session")
def clips(tmp_path_factory) -> dict[str, Path]:
    """One real file per playback path, generated once per test run."""
    if not shutil.which("ffmpeg"):
        pytest.skip("FFmpeg is not installed")
    folder = tmp_path_factory.mktemp("clips")
    return {
        "mp4": clip(folder / "direct.mp4", "mp4", 12),
        "mkv": clip(folder / "remux.mkv", "mkv", 12),
        "legacy": clip(folder / "legacy.avi", "legacy", 8),
        "hi10": clip(folder / "hi10.mkv", "hi10", 8),
    }


def place(src: Path, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dest)
    return dest
