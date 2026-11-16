"""Subtitles looked up online for releases without text tracks (subsource.py)."""

import httpx

from mediawan import subsource

SRT = "﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<font color=\"#fff\">Hello</font> {\\an8}there\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n- Hi\r\n- 42\r\n"

LISTING = {
    "subtitles": [
        {"id": "1", "url": "https://subs.example/1", "lang": "eng", "subtitleFileName": "Film.2020.CD1.srt"},
        {"id": "2", "url": "https://subs.example/2", "lang": "eng", "subtitleFileName": "Film.2020.WEB-DL.NTb.srt"},
        {"id": "3", "url": "https://subs.example/3", "lang": "eng", "subtitleFileName": "Film.2020.1080p.BluRay.x264-BTM.srt", "releaseGroup": "BTM"},
        {"id": "4", "url": "https://subs.example/4", "lang": "eng", "subtitleFileName": "Film.2020.BluRay.srt"},
        {"id": "5", "url": "https://subs.example/5", "lang": "pob", "subtitleFileName": "Film.2020.BluRay.srt"},
        {"id": "6", "url": "https://subs.example/6", "lang": "por", "subtitleFileName": "Film.2020.BluRay.srt"},
        {"id": "7", "url": "https://subs.example/7", "lang": "fre", "subtitleFileName": "Film.srt"},
        {"id": "8", "url": "http://subs.example/8", "lang": "dan", "subtitleFileName": "Film.srt"},
    ]
}


def source(tmp_path, calls=None, fail=False):
    def handler(request):
        if calls is not None:
            calls.append(str(request.url))
        if fail:
            return httpx.Response(503)
        if request.url.path.startswith("/subtitles/"):
            return httpx.Response(200, json=LISTING)
        return httpx.Response(200, content=SRT.encode())

    client = httpx.Client(transport=httpx.MockTransport(handler))
    return subsource.OnlineSubtitles(tmp_path / "subs", client=client)


def test_srt_becomes_webvtt():
    vtt = subsource.to_vtt(SRT)
    assert vtt.startswith("WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello there\n")
    assert "- Hi\n- 42\n" in vtt and "\n2\n00:00:03" not in vtt
    assert subsource.to_vtt("WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n").count("WEBVTT") == 1


def test_the_subtitle_made_for_the_release_comes_first(tmp_path):
    calls = []
    subs = source(tmp_path, calls)
    found = subs.find("movie", "tt1", 0, 0, "Film.2020.1080p.BluRay.DTS.x264-BTM", ["en", "pt", "da"])
    assert [f["url"][-1] for f in found] == ["3", "4", "6", "5"]  # no half films, no http
    subs.find("movie", "tt1", 0, 0, "Film.2020.WEB-DL", ["en"])
    assert len([c for c in calls if "/subtitles/movie/" in c]) == 1  # the listing is remembered
    assert calls[0].endswith("/subtitles/movie/tt1.json")


def test_episodes_are_asked_for_by_number_and_failures_offer_nothing(tmp_path):
    calls = []
    assert source(tmp_path, calls, fail=True).find("show", "tt2", 3, 4, "x", ["en"]) == []
    assert calls[0].endswith("/subtitles/series/tt2%3A3%3A4.json") or calls[0].endswith("/subtitles/series/tt2:3:4.json")
    assert source(tmp_path).find("movie", "not-an-id", 0, 0, "x", ["en"]) == []


def test_a_subtitle_is_downloaded_once(tmp_path):
    calls = []
    subs = source(tmp_path, calls)
    path = subs.fetch("https://subs.example/3")
    assert path.read_text("utf-8").startswith("WEBVTT")
    assert subs.fetch("https://subs.example/3") == path and len(calls) == 1


def test_entries_are_labelled_for_the_player():
    found = [{"lang": "en", "url": "https://a/1", "name": "a"}, {"lang": "en", "url": "https://a/2", "name": "b"}]
    out = subsource.entries(found, lambda url: "/x/" + url[-1])
    assert [(e["key"], e["title"], e["url"]) for e in out] == [
        ("o-en-1", "Online", "/x/1"),
        ("o-en-2", "Online, alternative 1", "/x/2"),
    ]
    assert all(e["available"] and e["online"] for e in out)


def test_a_file_without_text_subtitles_is_offered_online_ones(tmp_path, clips):
    import time

    from fastapi.testclient import TestClient

    from mediawan.app import create_app
    from mediawan.config import Config

    from .conftest import place
    from .test_translate import FakeLibreTranslate

    admin = {"email": "admin@example.com", "password": "correct horse battery"}
    movies = tmp_path / "lib" / "Movies"
    place(clips["mp4"], movies / "Film (2020)" / "Film.2020.1080p.BluRay.x264-BTM.mp4")

    config = Config(
        database=tmp_path / "data" / "db.sqlite",
        runtime=tmp_path / "runtime",
        admin_email=admin["email"],
        admin_password=admin["password"],
        metadata_online=False,
        scan_interval=0,
        translate_url="http://lt.test",
        library_roots=[movies],
    )
    app = create_app(
        config,
        background=False,
        translate_client=httpx.Client(transport=httpx.MockTransport(FakeLibreTranslate())),
    )
    with TestClient(app) as client:
        app.state.online_subs = source(tmp_path)
        app.state.jobs.run_library()
        app.state.db.run("UPDATE titles SET imdb_id='tt1'")
        client.post("/api/login", json=admin)
        title = client.get("/api/titles").json()["titles"][0]
        item = client.get(f"/api/titles/{title['id']}").json()["items"][0]
        play = client.post("/api/play", json={"item_id": item["id"], "caps": {"audio": "aac"}}).json()
        subs = play["subtitles"]
        assert not any("_remote" in s for s in subs)
        online = [s for s in subs if s.get("online")]
        assert [s["key"] for s in online] == ["o-pt-1", "o-pt-2", "o-en-1", "o-en-2"]
        english = client.get(online[2]["url"])
        assert english.status_code == 200 and english.text.startswith("WEBVTT")
        assert client.get("/api/subtitles/online/bm9wZQ.AAAA.vtt").status_code == 404
        danish = next(s for s in subs if s["lang"] == "da")  # translated from the online English
        assert danish["translated"] and danish["available"]
        deadline = time.time() + 10
        while (response := client.get(danish["url"])).status_code == 202 and time.time() < deadline:
            time.sleep(0.05)
        assert response.status_code == 200 and "[da] " in response.text
        if play.get("session"):
            client.delete(f"/api/sessions/{play['session']}")


def test_a_film_the_catalogue_lacks_english_for_is_looked_up_elsewhere(tmp_path):
    import io
    import zipfile

    page = (
        '<tr data-id="1"><td><span class="label">3</span></td><td><span class="sub-lang">English</span></td>'
        '<td><a href="/subtitles/film-english-1"><span class="text-muted">subtitle</span> Film.2020.BluRay.x264</a></td></tr>'
        '<tr data-id="2"><td><span class="label label-success">9</span></td><td><span class="sub-lang">Arabic</span></td>'
        '<td><a href="/subtitles/film-arabic-2"><span class="text-muted">subtitle</span> Film.2020.BluRay</a></td></tr>'
    )
    packed = io.BytesIO()
    with zipfile.ZipFile(packed, "w") as archive:
        archive.writestr("readme.txt", "x")
        archive.writestr("Film.srt", "1\n00:00:01,000 --> 00:00:02,000\nمرحبا\n".encode("cp1256"))
    seen = []

    def handler(request):
        seen.append(request)
        if request.url.host != "yifysubtitles.ch":
            return httpx.Response(200, json={"subtitles": [LISTING["subtitles"][5]]})  # Portuguese only
        if request.url.path.startswith("/movie-imdb/"):
            return httpx.Response(200, text=page)
        return httpx.Response(200, content=packed.getvalue())

    subs = subsource.OnlineSubtitles(
        tmp_path / "subs", client=httpx.Client(transport=httpx.MockTransport(handler))
    )
    found = subs.find("movie", "tt1", 0, 0, "Film.2020.BluRay", ["en", "ar", "pt"])
    assert [f["lang"] for f in found] == ["en", "ar", "pt"]
    assert found[2]["url"] == "https://subs.example/6"
    text = subs.fetch(found[1]["url"]).read_text("utf-8")
    assert text.startswith("WEBVTT") and "مرحبا" in text  # unzipped, read as Arabic
    assert seen[-1].headers["referer"] == "https://yifysubtitles.ch/subtitles/film-arabic-2"
    assert "#" not in str(seen[-1].url)
    assert subs.find("show", "tt1", 1, 1, "x", ["en"]) == []  # films only
