"""Subtitles in Arabic, Danish and Portuguese on every title, with a fake LibreTranslate."""

import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from mediawan import translate
from mediawan.app import create_app
from mediawan.config import Config
from mediawan.translate import Cue, Translator, parse_vtt, units, with_languages, write_vtt

from .conftest import needs_ffmpeg, place
from .test_online import ADMIN, Upstream

VTT = """WEBVTT

STYLE
::cue { color: yellow }

NOTE a comment

1
00:00:01.000 --> 00:00:02.500 align:start
<i>Hello</i> {\\an8}there

00:00:03,000 --> 00:00:04,000
- Who is it?
- Me.

00:00:05.000 --> 00:00:06.000
This sentence is
split over two lines
"""


class FakeLibreTranslate:
    def __init__(self, languages=("en", "ar", "da", "pt")):
        self.languages = languages
        self.calls = 0
        self.down = False
        self.poison = None  # a string the server chokes on

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("refused", request=request)
        if request.url.path == "/languages":
            return httpx.Response(200, json=[{"code": c, "name": c} for c in self.languages])
        body = json.loads(request.content)
        self.calls += 1
        if self.poison and self.poison in body["q"]:
            return httpx.Response(400, json={"error": "cannot translate that"})
        return httpx.Response(
            200, json={"translatedText": [f"[{body['target']}] {q}" for q in body["q"]]}
        )


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(translate.time, "sleep", lambda s: None)


def wait(job, seconds=10):
    deadline = time.time() + seconds
    while job.status in ("queued", "working") and time.time() < deadline:
        time.sleep(0.02)
    return job


def make(tmp_path, fake=None, url="http://lt.test"):
    fake = fake or FakeLibreTranslate()
    return Translator(
        url, tmp_path / "cache", client=httpx.Client(transport=httpx.MockTransport(fake))
    ), fake


def test_parse_and_write_vtt():
    cues = parse_vtt(VTT)
    assert [c.timing for c in cues] == [
        "00:00:01.000 --> 00:00:02.500 align:start",
        "00:00:03.000 --> 00:00:04.000",
        "00:00:05.000 --> 00:00:06.000",
    ]
    assert cues[0].lines == ["Hello there"]
    assert parse_vtt(write_vtt(cues)) == cues


def test_dialogue_is_translated_line_by_line_and_sentences_whole():
    cues = parse_vtt(VTT)
    assert units(cues[1]) == (["Who is it?", "Me."], True)
    assert units(cues[2]) == (["This sentence is split over two lines"], False)


def test_with_languages_fills_only_the_gaps_and_lists_them_first():
    subs = [
        {"key": "s1", "lang": "en", "title": "English", "available": True, "url": "/en"},
        {"key": "s2", "lang": "ar", "title": "Arabic", "available": True, "url": "/ar"},
        {
            "key": "s3",
            "lang": "da",
            "title": "Danish",
            "forced": True,
            "available": True,
            "url": "/f",
        },
        {"key": "s4", "lang": "fr", "title": "French", "available": True, "url": "/fr"},
    ]
    out, source = with_languages(
        subs, ["ar", "da", "pt"], lambda src, lang: f"/t/{src['key']}/{lang}"
    )
    assert source["key"] == "s1"  # English is translated from
    assert [(s["lang"], s.get("translated", False)) for s in out[:4]] == [
        ("ar", False), ("da", False), ("da", True), ("pt", True),
    ]  # fmt: skip
    assert out[2]["title"] == "Danish (translated)" and out[2]["url"] == "/t/s1/da"
    nothing, none = with_languages([], ["da"], lambda src, lang: "")
    assert none is None and nothing[0]["available"] is False


def test_signs_tracks_are_not_used_as_the_source():
    subs = [
        {
            "key": "a",
            "lang": "en",
            "title": "English Signs & Songs",
            "available": True,
            "url": "/a",
        },
        {"key": "b", "lang": "en", "title": "English", "available": True, "url": "/b"},
    ]
    assert translate.pick_source(subs)["key"] == "b"


def test_translation_is_made_once_and_cached(tmp_path):
    t, fake = make(tmp_path)
    job = wait(t.request("src", lambda: VTT, "en", "da"))
    assert job.status == "ready", job.error
    text = job.path.read_text(encoding="utf-8")
    assert "[da] Hello there" in text and "- [da] Who is it?\n- [da] Me." in text
    calls = fake.calls
    again, fake2 = make(tmp_path)  # a fresh process: the file on disk is enough
    assert again.request("src", lambda: VTT, "en", "da").status == "ready" and fake2.calls == 0
    assert fake.calls == calls


def test_failures_are_reported_and_retried_later(tmp_path, monkeypatch):
    fake = FakeLibreTranslate()
    fake.down = True
    t, _ = make(tmp_path, fake)
    job = wait(t.request("src", lambda: VTT, "en", "da"))
    assert job.status == "failed" and "unreachable" in job.error
    assert t.request("src", lambda: VTT, "en", "da") is job  # not hammered straight away
    fake.down = False
    monkeypatch.setattr(translate, "RETRY_FAILED_AFTER", 0)
    assert wait(t.request("src", lambda: VTT, "en", "da")).status == "ready"


def test_a_line_the_server_rejects_stays_in_the_original(tmp_path):
    fake = FakeLibreTranslate()
    fake.poison = "Me."
    t, _ = make(tmp_path, fake)
    job = wait(t.request("src", lambda: VTT, "en", "pt"))
    assert job.status == "ready", job.error
    text = job.path.read_text(encoding="utf-8")
    assert "- [pt] Who is it?\n- Me." in text and "[pt] Hello there" in text


def test_missing_model_and_missing_server_say_so(tmp_path):
    t, _ = make(tmp_path, FakeLibreTranslate(languages=("en", "ar")))
    job = wait(t.request("src", lambda: VTT, "en", "da"))
    assert job.status == "failed" and "LT_LOAD_ONLY" in job.error
    off = Translator("", tmp_path / "off")
    assert "TRANSLATE_URL" in off.request("src", lambda: VTT, "en", "da").error


def test_someone_waiting_jumps_the_queue(tmp_path):
    t, _ = make(tmp_path)
    gate = []
    blocker = t.request(
        "slow", lambda: (time.sleep(0.3), gate.append("slow"), VTT)[2], "en", "ar", urgent=False
    )
    while blocker.status == "queued":  # the worker is busy with it before the others arrive
        time.sleep(0.01)
    t.request("bg", lambda: (gate.append("bg"), VTT)[1], "en", "da", urgent=False)
    t.request("now", lambda: (gate.append("now"), VTT)[1], "en", "pt", urgent=True)
    for job in list(t.jobs.values()):
        wait(job)
    assert blocker.status == "ready" and gate == ["slow", "now", "bg"]


# ---- through the API ----------------------------------------------------------------------


def _server(tmp_path, transports, **extra):
    upstream_client, upstream_async, lt = transports
    config = Config(
        database=tmp_path / "data" / "db.sqlite",
        runtime=tmp_path / "runtime",
        admin_email=ADMIN["email"],
        admin_password=ADMIN["password"],
        metadata_online=False,
        scan_interval=0,
        translate_url="http://lt.test",
        **extra,
    )
    app = create_app(
        config,
        background=False,
        online_clients=(upstream_client, upstream_async),
        translate_client=httpx.Client(transport=httpx.MockTransport(lt)),
    )
    return app


def _fetch_translated(client, url):
    deadline = time.time() + 10
    while time.time() < deadline:
        response = client.get(url)
        if response.status_code != 202:
            return response
        assert {"status", "done", "total"} <= set(response.json())
        time.sleep(0.05)
    raise AssertionError("translation never finished")


def test_online_episode_always_offers_arabic_danish_portuguese(tmp_path):
    upstream = httpx.MockTransport(Upstream())  # its only subtitle track is English
    app = _server(
        tmp_path,
        (
            httpx.Client(transport=upstream),
            httpx.AsyncClient(transport=upstream),
            FakeLibreTranslate(),
        ),
    )
    with TestClient(app) as client:
        client.post("/api/login", json=ADMIN)
        play = client.post("/api/online/play", json={"anilist_id": 154587, "episode": 1}).json()
        subs = play["subtitles"]
        assert [s["lang"] for s in subs] == ["ar", "da", "pt", "en"]
        assert all(s["translated"] and s["available"] for s in subs[:3])
        assert not any("_src" in s for s in subs)
        danish = _fetch_translated(client, subs[1]["url"])
        assert danish.status_code == 200 and "[da] Hi" in danish.text
        assert client.get(subs[1]["url"].replace("/da.vtt", "/fr.vtt")).status_code == 404
        assert client.get("/api/subtitles/translated/bm9wZQ.AAAA/da.vtt").status_code == 404


@needs_ffmpeg
def test_library_file_gets_translated_from_its_own_subtitles(tmp_path, clips):
    movies = tmp_path / "lib" / "Movies"
    place(clips["mkv"], movies / "Heat (1995)" / "Heat.1995.mkv")  # has an English SRT track
    upstream = httpx.MockTransport(Upstream())
    app = _server(
        tmp_path,
        (
            httpx.Client(transport=upstream),
            httpx.AsyncClient(transport=upstream),
            FakeLibreTranslate(),
        ),
        library_roots=[movies],
    )
    with TestClient(app) as client:
        app.state.jobs.run_library()
        client.post("/api/login", json=ADMIN)
        title = client.get("/api/titles").json()["titles"][0]
        item = client.get(f"/api/titles/{title['id']}").json()["items"][0]
        play = client.post(
            "/api/play", json={"item_id": item["id"], "caps": {"audio": "aac,ac3"}}
        ).json()
        langs = [s["lang"] for s in play["subtitles"]]
        assert langs[:3] == ["ar", "da", "pt"]
        arabic = _fetch_translated(client, play["subtitles"][0]["url"])
        assert arabic.status_code == 200 and "[ar] " in arabic.text
        client.delete(f"/api/sessions/{play['session']}") if play.get("session") else None


def test_cue_round_trip_keeps_timing_settings():
    cue = Cue("00:01.000 --> 00:02.000 line:90%", ["Hi"])
    assert write_vtt([cue]).startswith("WEBVTT\n\n00:01.000 --> 00:02.000 line:90%\nHi\n")
