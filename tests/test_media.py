import subprocess
import time

import pytest

from mediawan import media
from mediawan.media import Caps, plan

from .conftest import needs_ffmpeg


def info(
    video="h264",
    audio="aac",
    container="mov,mp4,m4a,3gp,3g2,mj2",
    height=1080,
    depth=8,
    pix="yuv420p",
    channels=2,
    extra_audio=None,
):
    tracks = [
        {
            "index": 1,
            "codec": audio,
            "channels": channels,
            "lang": "en",
            "title": None,
            "default": True,
        }
    ]
    tracks += extra_audio or []
    return {
        "container": container,
        "duration": 600.0,
        "start": 0.0,
        "bitrate": 0,
        "video": [
            {
                "index": 0,
                "codec": video,
                "profile": "High",
                "pix_fmt": pix,
                "width": height * 16 // 9,
                "height": height,
                "bit_depth": depth,
                "hdr": False,
                "fps": 24.0,
                "lang": None,
                "title": None,
                "default": True,
            }
        ],
        "audio": tracks,
        "subtitles": [],
    }


MKV = "matroska,webm"


def test_mp4_h264_aac_plays_directly():
    p = plan(info(), Caps(), "/x/film.mp4")
    assert (p.mode, p.video, p.audio) == ("direct", "copy", "copy")


def test_decision_is_by_codec_not_extension():
    # An MP4 named .mkv still plays directly; an MKV named .mp4 is still repackaged.
    assert plan(info(), Caps(), "/x/film.mkv").mode == "direct"
    assert plan(info(container=MKV), Caps(), "/x/film.mp4").mode == "remux"


def test_mkv_is_remuxed_with_video_copied_and_audio_only_converted_when_needed():
    p = plan(info(container=MKV, audio="aac"), Caps(), "/x/a.mkv")
    assert (p.mode, p.video, p.audio) == ("remux", "copy", "copy")
    p = plan(info(container=MKV, audio="dts", channels=6), Caps(), "/x/a.mkv")
    assert (p.mode, p.video, p.audio) == ("remux", "copy", "aac")
    # A device that decodes E-AC-3 gets it untouched
    p = plan(
        info(container=MKV, audio="eac3", channels=6), Caps.parse({"audio": "eac3"}), "/x/a.mkv"
    )
    assert p.audio == "copy"


def test_unsupported_audio_in_mp4_remuxes_instead_of_transcoding():
    p = plan(info(audio="ac3", channels=6), Caps(), "/x/a.mp4")
    assert (p.mode, p.video, p.audio) == ("remux", "copy", "aac")


def test_hevc_copies_when_the_device_supports_it():
    assert (
        plan(
            info(video="hevc", container=MKV, depth=10, pix="yuv420p10le"),
            Caps.parse({"video": "hevc"}),
            "/x/a.mkv",
        ).video
        == "copy"
    )
    p = plan(info(video="hevc", container=MKV), Caps(), "/x/a.mkv")
    assert (p.mode, p.video, p.height) == ("transcode", "encode", 1080)


def test_transcode_only_for_undecodable_video():
    assert plan(info(video="mpeg4", container="avi"), Caps(), "/x/a.avi").mode == "transcode"
    assert (
        plan(info(depth=10, pix="yuv420p10le", container=MKV), Caps(), "/x/a.mkv").mode
        == "transcode"
    )
    p = plan(info(height=2160, container=MKV), Caps.parse({"max_height": 1080}), "/x/a.mkv")
    assert (p.mode, p.height) == ("transcode", 1080)


def test_choosing_another_audio_track_remuxes():
    alt = [
        {"index": 2, "codec": "aac", "channels": 2, "lang": "ja", "title": None, "default": False}
    ]
    i = info(extra_audio=alt)
    assert plan(i, Caps(), "/x/a.mp4", language="ja").mode == "remux"
    assert plan(i, Caps(), "/x/a.mp4", audio_index=2).audio_index == 2
    assert plan(i, Caps(), "/x/a.mp4", language="en").mode == "direct"


def test_audio_the_device_cannot_stream_in_hls_is_converted():
    # Chromium: plays an MP3 file directly, but not MP3 inside fMP4 through MediaSource.
    chromium = Caps.parse({"audio": "mp3", "hls_audio": "aac"})
    legacy = info(video="mpeg4", container="avi", audio="mp3")
    assert plan(legacy, chromium, "/x/a.avi").audio == "aac"
    assert plan(legacy, Caps.parse({"hls_audio": "aac,mp3"}), "/x/a.avi").audio == "copy"
    assert (
        plan(legacy, Caps(), "/x/a.avi").audio == "copy"
    )  # clients that do not say keep old behaviour
    # Direct play still uses the wider list, and escalating to HLS converts the audio.
    direct = plan(info(audio="mp3"), chromium, "/x/a.mp4")
    assert (direct.mode, direct.audio) == ("direct", "copy")
    assert media.escalate(direct, info(audio="mp3"), chromium, "remux").audio == "aac"


def test_escalation_only_steps_up():
    i = info()
    direct = plan(i, Caps(), "/x/a.mp4")
    assert media.escalate(direct, i, Caps(), "remux").mode == "remux"
    assert media.escalate(direct, i, Caps(), "transcode").video == "encode"
    remux = plan(info(container=MKV), Caps(), "/x/a.mkv")
    assert media.escalate(remux, i, Caps(), "direct") is remux


def test_choose_file_prefers_least_work_then_resolution():
    import json

    files = [
        {
            "id": 1,
            "path": "/a.avi",
            "missing": 0,
            "probe": json.dumps(info(video="mpeg4", container="avi")),
        },
        {
            "id": 2,
            "path": "/b.mkv",
            "missing": 0,
            "probe": json.dumps(info(container=MKV, height=720)),
        },
        {
            "id": 3,
            "path": "/c.mkv",
            "missing": 0,
            "probe": json.dumps(info(container=MKV, height=1080)),
        },
        {"id": 4, "path": "/d.mp4", "missing": 1, "probe": json.dumps(info())},
    ]
    assert media.choose_file(files, Caps())["id"] == 3


def test_hardware_commands():
    i = info(video="hevc", container=MKV, height=2160, depth=10, pix="yuv420p10le")
    p = plan(i, Caps(), "/x/a.mkv")
    qsv = media.hls_command("ffmpeg", "/x/a.mkv", i, p, Caps(), 0, hwaccel="qsv")
    joined = " ".join(qsv)
    assert (
        "-hwaccel qsv" in joined
        and "h264_qsv" in joined
        and "vpp_qsv=format=nv12:w=1920:h=1080" in joined
    )
    vaapi = " ".join(media.hls_command("ffmpeg", "/x/a.mkv", i, p, Caps(), 0, hwaccel="vaapi"))
    assert "h264_vaapi" in vaapi and "scale_vaapi=format=nv12:w=1920:h=1080" in vaapi
    # MPEG-4 ASP cannot be GPU-decoded: decode in software, upload, still encode on the GPU
    legacy = info(video="mpeg4", container="avi", height=480)
    lp = plan(legacy, Caps(), "/x/a.avi")
    cmd = " ".join(media.hls_command("ffmpeg", "/x/a.avi", legacy, lp, Caps(), 0, hwaccel="qsv"))
    assert "-hwaccel qsv" not in cmd and "hwupload" in cmd and "h264_qsv" in cmd
    # Remux never touches the GPU and copies HEVC with the tag browsers need
    remux = plan(i, Caps.parse({"video": "hevc"}), "/x/a.mkv")
    cmd = media.hls_command("ffmpeg", "/x/a.mkv", i, remux, Caps(), 30, hwaccel="qsv")
    assert cmd[cmd.index("-c:v") + 1] == "copy" and "hvc1" in cmd and "-noaccurate_seek" in cmd
    assert "qsv" not in " ".join(cmd)


# ---- real FFmpeg ----------------------------------------------------------------------------


def _wait_finished(session, seconds=60):
    deadline = time.time() + seconds
    while time.time() < deadline and not session.finished and not session.error:
        time.sleep(0.2)
    assert session.finished, session.error


def _segment_video(session):
    """Probe init + first segment together: an init segment alone carries no frames."""
    joined = session.dir.parent / f"{session.id}-joined.mp4"
    first = min(session.dir.glob("seg*.m4s"))
    joined.write_bytes((session.dir / "init.mp4").read_bytes() + first.read_bytes())
    return media.probe("ffprobe", joined)


@needs_ffmpeg
def test_probe_real_files(clips):
    mkv = media.probe("ffprobe", clips["mkv"])
    assert mkv["container"].startswith("matroska")
    assert (
        mkv["video"][0]["codec"] == "h264" and mkv["video"][0]["profile"] == "Constrained Baseline"
    )
    assert mkv["audio"][0]["codec"] == "ac3" and mkv["audio"][0]["channels"] == 6
    assert mkv["subtitles"][0]["text"] and mkv["subtitles"][0]["lang"] == "en"
    assert 11 < mkv["duration"] < 13
    assert plan(media.probe("ffprobe", clips["mp4"]), Caps(), str(clips["mp4"])).mode == "direct"
    assert plan(mkv, Caps(), str(clips["mkv"])).mode == "remux"
    assert (
        plan(media.probe("ffprobe", clips["legacy"]), Caps(), str(clips["legacy"])).mode
        == "transcode"
    )
    assert (
        plan(media.probe("ffprobe", clips["hi10"]), Caps(), str(clips["hi10"])).mode == "transcode"
    )


@needs_ffmpeg
def test_real_remux_copies_video_and_converts_only_audio(clips, tmp_path):
    source = media.probe("ffprobe", clips["mkv"])
    sessions = media.Sessions("ffmpeg", "ffprobe", tmp_path)
    p = plan(source, Caps(), str(clips["mkv"]))
    s = sessions.start(
        user_id=1,
        client="t",
        file={"id": 1, "path": str(clips["mkv"])},
        item_id=1,
        info=source,
        the_plan=p,
        caps=Caps(),
        start=5.0,
    )
    assert s.start == 4.0  # the clip has a keyframe every 2 s; copied video starts on one
    assert sessions.wait_for(s, "index.m3u8")
    _wait_finished(s)
    out = _segment_video(s)
    # Same codec AND same encoder profile: the H.264 stream was copied, not re-encoded
    # (a re-encode would come out as High profile).
    assert out["video"][0]["codec"] == "h264"
    assert out["video"][0]["profile"] == "Constrained Baseline"
    assert out["audio"][0]["codec"] == "aac" and out["audio"][0]["channels"] == 6
    playlist = (s.dir / "index.m3u8").read_text()
    assert "#EXT-X-ENDLIST" in playlist and playlist.count("#EXTINF") >= 2

    # Copied packets are bit-identical: compare the video packet sizes of source and output
    def sizes(path, interval):
        out = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-read_intervals",
                interval,
                "-show_entries",
                "packet=size",
                "-of",
                "csv=p=0",
                str(path),
            ],
            capture_output=True,
            text=True,
        ).stdout.split()
        return out

    first_segment = min(s.dir.glob("seg*.m4s"))
    joined = tmp_path / "joined.mp4"
    joined.write_bytes((s.dir / "init.mp4").read_bytes() + first_segment.read_bytes())
    produced = sizes(joined, "%+#10")
    original = sizes(clips["mkv"], "4%+#10")
    assert produced == original
    sessions.stop_all()
    assert not s.dir.exists()


@needs_ffmpeg
@pytest.mark.parametrize("name, audio", [("legacy", "mp3"), ("hi10", "aac")])
def test_real_software_transcode(clips, tmp_path, name, audio):
    """Video is re-encoded; audio is still copied when the browser plays it (MP3), and only
    converted when it cannot (FLAC is not in the default capabilities)."""
    source = media.probe("ffprobe", clips[name])
    sessions = media.Sessions("ffmpeg", "ffprobe", tmp_path)
    p = plan(source, Caps(), str(clips[name]))
    s = sessions.start(
        user_id=1,
        client="t",
        file={"id": 1, "path": str(clips[name])},
        item_id=1,
        info=source,
        the_plan=p,
        caps=Caps(),
        start=2.5,
    )
    assert s.start == 2.5  # re-encoded video seeks exactly
    _wait_finished(s)
    out = _segment_video(s)
    assert out["video"][0]["codec"] == "h264" and out["video"][0]["bit_depth"] == 8
    assert out["video"][0]["profile"] == "High" and out["audio"][0]["codec"] == audio
    sessions.stop_all()


@needs_ffmpeg
def test_failed_hardware_transcode_falls_back_to_software(clips, tmp_path):
    source = media.probe("ffprobe", clips["legacy"])
    sessions = media.Sessions(
        "ffmpeg", "ffprobe", tmp_path, hwaccel="vaapi", device="/nonexistent/renderD128"
    )
    p = plan(source, Caps(), str(clips["legacy"]))
    s = sessions.start(
        user_id=1,
        client="t",
        file={"id": 1, "path": str(clips["legacy"])},
        item_id=1,
        info=source,
        the_plan=p,
        caps=Caps(),
    )
    _wait_finished(s)
    assert s.hwaccel == "none"
    sessions.stop_all()


@needs_ffmpeg
def test_session_limits_and_replacement(clips, tmp_path):
    source = media.probe("ffprobe", clips["legacy"])
    sessions = media.Sessions("ffmpeg", "ffprobe", tmp_path, max_transcodes=1)
    p = plan(source, Caps(), str(clips["legacy"]))
    kwargs = {
        "file": {"id": 1, "path": str(clips["legacy"])},
        "item_id": 1,
        "info": source,
        "the_plan": p,
        "caps": Caps(),
    }
    first = sessions.start(user_id=1, client="tv", **kwargs)
    with pytest.raises(media.Busy):
        sessions.start(user_id=2, client="phone", **kwargs)
    second = sessions.start(user_id=1, client="tv", **kwargs)  # same device replaces its stream
    assert first.id not in sessions.items and second.id in sessions.items
    second.touched -= 1000
    assert sessions.cleanup() == 1 and not sessions.items


@needs_ffmpeg
def test_subtitles_to_vtt(clips, tmp_path):
    subs = media.Subtitles("ffmpeg", tmp_path)
    embedded = subs.embedded({"id": 7, "path": str(clips["mkv"]), "mtime": 1.0}, 2)
    text = embedded.read_text(encoding="utf-8")
    assert text.startswith("WEBVTT") and "00:01.000 --> 00:04.000" in text
    # A Windows-1252 .srt with accents converts with the right characters
    srt = tmp_path / "film.fr.srt"
    srt.write_bytes("1\r\n00:00:01,000 --> 00:00:02,500\r\nCafé déjà vu\r\n".encode("cp1252"))
    vtt = subs.sidecar({"id": 3, "path": str(srt), "format": "srt"}).read_text(encoding="utf-8")
    assert "Café déjà vu" in vtt
    # ASS is converted too; WebVTT sidecars are served as they are
    ass = tmp_path / "film.en.ass"
    ass.write_text(
        "[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize\n"
        "Style: Default,Arial,20\n\n[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
        "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}Hello{\\i0}\n",
        encoding="utf-8",
    )
    assert "Hello" in subs.sidecar({"id": 4, "path": str(ass), "format": "ass"}).read_text(
        encoding="utf-8"
    )
    vtt_file = tmp_path / "film.vtt"
    vtt_file.write_text("WEBVTT\n", encoding="utf-8")
    assert subs.sidecar({"id": 5, "path": str(vtt_file), "format": "vtt"}) == vtt_file
