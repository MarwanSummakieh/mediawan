import time

import pytest
from fastapi.testclient import TestClient

from mediawan.app import create_app
from mediawan.config import Config

from .conftest import needs_ffmpeg, place

ADMIN = {"email": "admin@example.test", "password": "correct horse battery"}


@pytest.fixture
def server(tmp_path, clips):
    movies, tv = tmp_path / "lib" / "Movies", tmp_path / "lib" / "TV"
    place(clips["mp4"], movies / "Heat (1995)" / "Heat.1995.1080p.mp4")
    (movies / "Heat (1995)" / "Heat.1995.1080p.en.srt").write_text(
        "1\n00:00:01,000 --> 00:00:02,000\nSidecar line\n", encoding="utf-8"
    )
    place(clips["legacy"], movies / "Alien (1979)" / "Alien.1979.avi")
    for e in (1, 2, 3):
        place(clips["mkv"], tv / "The Office" / "Season 01" / f"The.Office.S01E0{e}.mkv")
    place(clips["mp4"], tv / "loose clip.mp4")
    config = Config(
        database=tmp_path / "data" / "db.sqlite",
        runtime=tmp_path / "runtime",
        library_roots=[movies, tv],
        admin_email=ADMIN["email"],
        admin_password=ADMIN["password"],
        metadata_online=False,
        scan_interval=0,
    )
    app = create_app(config, background=False)
    with TestClient(app) as client:
        app.state.jobs.run_library()
        yield client, app


def login(client, creds=ADMIN):
    r = client.post("/api/login", json=creds)
    assert r.status_code == 200, r.text
    return r.json()


def title_id(client, name):
    return next(t["id"] for t in client.get("/api/titles").json()["titles"] if t["name"] == name)


@needs_ffmpeg
def test_auth_and_roles(server):
    client, _app = server
    assert client.get("/api/home").status_code == 401
    assert client.get("/healthz").json()["ok"]
    assert client.get("/api/status").json()["setup"] is False
    assert (
        client.post("/api/login", json={**ADMIN, "password": "wrong password"}).status_code == 401
    )
    login(client)
    assert (
        client.post(
            "/api/admin/users",
            json={"email": "kid@example.test", "name": "Kid", "password": "another long pw"},
        ).status_code
        == 200
    )
    client.post("/api/logout")
    login(client, {"email": "kid@example.test", "password": "another long pw"})
    assert client.get("/api/admin/overview").status_code == 403
    heat = title_id(client, "Heat")
    files = client.get(f"/api/titles/{heat}").json()["items"][0]["files"]
    assert "name" not in files[0]  # members never see server paths


@needs_ffmpeg
def test_first_run_setup(tmp_path):
    config = Config(database=tmp_path / "db.sqlite", runtime=tmp_path / "rt", metadata_online=False)
    with TestClient(create_app(config, background=False)) as client:
        assert client.get("/api/status").json()["setup"] is True
        r = client.post("/api/setup", json={"email": "me@example.test", "password": "0123456789"})
        assert r.status_code == 200 and r.json()["role"] == "admin"
        assert client.get("/api/me").status_code == 200
        assert (
            client.post(
                "/api/setup", json={"email": "x@example.test", "password": "0123456789"}
            ).status_code
            == 409
        )


@needs_ffmpeg
def test_library_browsing_and_review(server):
    client, _app = server
    login(client)
    titles = client.get("/api/titles").json()["titles"]
    assert sorted(t["name"] for t in titles) == ["Alien", "Heat", "The Office"]
    assert [t["name"] for t in client.get("/api/titles?kind=show").json()["titles"]] == [
        "The Office"
    ]
    assert client.get("/api/titles?q=offi").json()["titles"][0]["name"] == "The Office"
    rails = {r["id"] for r in client.get("/api/home").json()["rails"]}
    assert {"movies", "shows"} <= rails
    office = client.get(f"/api/titles/{title_id(client, 'The Office')}").json()
    assert [i["label"] for i in office["items"]] == ["S01E01", "S01E02", "S01E03"]
    assert office["items"][0]["files"][0]["audio"][0]["codec"] == "ac3"  # probed during the scan
    review = client.get("/api/admin/review").json()
    assert [f["path"].endswith("loose clip.mp4") for f in review["files"]] == [True]
    r = client.post(
        f"/api/admin/review/{review['files'][0]['id']}/assign",
        json={"kind": "movie", "name": "Loose Clip", "year": 2020},
    )
    assert r.status_code == 200
    assert "Loose Clip" in [t["name"] for t in client.get("/api/titles").json()["titles"]]
    assert client.get("/api/admin/review").json()["files"] == []
    # Admin edits are locked
    heat = title_id(client, "Heat")
    edited = client.patch(
        f"/api/admin/titles/{heat}", json={"description": "Mine", "genres": "Crime, Drama"}
    ).json()
    assert edited["locked_fields"] == ["description", "genres"] and edited["genres"] == [
        "Crime",
        "Drama",
    ]
    assert client.get("/api/titles?genre=Crime").json()["titles"][0]["name"] == "Heat"
    assert client.post(f"/api/admin/titles/{heat}/refresh").status_code == 409  # offline
    overview = client.get("/api/admin/overview").json()
    assert overview["counts"]["movies"] == 3 and overview["scan"]["last"]["added"] == 5


@needs_ffmpeg
def test_direct_play_with_ranges_and_subtitles(server):
    client, _ = server
    login(client)
    heat = client.get(f"/api/titles/{title_id(client, 'Heat')}").json()
    play = client.post("/api/play", json={"item_id": heat["items"][0]["id"], "client": "a"}).json()
    assert play["mode"] == "direct" and play["session"] is None
    r = client.get(play["url"], headers={"Range": "bytes=0-99"})
    assert (
        r.status_code == 206 and len(r.content) == 100 and r.headers["content-type"] == "video/mp4"
    )
    sidecar = next(s for s in play["subtitles"] if s["external"])
    vtt = client.get(sidecar["url"])
    assert vtt.status_code == 200 and "Sidecar line" in vtt.text


@needs_ffmpeg
def test_remux_stream_resume_and_next_up(server):
    client, app = server
    login(client)
    office = client.get(f"/api/titles/{title_id(client, 'The Office')}").json()
    first, second = office["items"][0]["id"], office["items"][1]["id"]
    play = client.post("/api/play", json={"item_id": first, "client": "tv", "start": 6}).json()
    assert play["mode"] == "remux" and play["start"] == 6.0  # keyframes every 2 s
    assert any("copied without re-encoding" in r for r in play["reasons"])
    assert play["next"]["item_id"] == second
    playlist = client.get(play["url"])
    assert playlist.status_code == 200 and "#EXTINF" in playlist.text
    assert client.get(play["url"].replace("index.m3u8", "init.mp4")).status_code == 200
    assert client.get(play["url"].replace("index.m3u8", "seg00000.m4s")).status_code == 200
    assert client.get(play["url"].replace("index.m3u8", "../../etc")).status_code == 404
    embedded = next(s for s in play["subtitles"] if not s["external"] and not s.get("translated"))
    assert "Hello from" in client.get(embedded["url"]).text
    # Another user cannot read this stream
    client.post(
        "/api/admin/users", json={"email": "b@example.test", "name": "B", "password": "0123456789"}
    )
    other = TestClient(app)
    login(other, {"email": "b@example.test", "password": "0123456789"})
    assert other.get(play["url"]).status_code == 404
    # Progress → Continue Watching, then finishing → Next Up
    client.post(
        "/api/progress",
        json={"item_id": first, "position": 600, "duration": 1300, "session": play["session"]},
    )
    home = {r["id"]: r for r in client.get("/api/home").json()["rails"]}
    assert home["continue"]["items"][0]["item_id"] == first
    again = client.post("/api/play", json={"item_id": first, "client": "tv"}).json()
    assert again["position"] == pytest.approx(min(600, again["duration"] - 5))
    client.post("/api/progress", json={"item_id": first, "position": 1250, "duration": 1300})
    home = {r["id"]: r for r in client.get("/api/home").json()["rails"]}
    assert "continue" not in home and home["next"]["items"][0]["item_id"] == second
    assert client.get(f"/api/titles/{office['id']}").json()["next"]["item_id"] == second
    client.delete(f"/api/sessions/{again['session']}")
    assert not app.state.sessions.items


@needs_ffmpeg
def test_transcode_and_escalation(server):
    client, app = server
    login(client)
    alien = client.get(f"/api/titles/{title_id(client, 'Alien')}").json()["items"][0]["id"]
    play = client.post("/api/play", json={"item_id": alien, "client": "x"}).json()
    assert play["mode"] == "transcode" and play["hwaccel"] == "none"
    assert "#EXTINF" in client.get(play["url"]).text
    heat = client.get(f"/api/titles/{title_id(client, 'Heat')}").json()["items"][0]["id"]
    escalated = client.post(
        "/api/play", json={"item_id": heat, "client": "x", "escalate": "remux"}
    ).json()
    assert escalated["mode"] == "remux"
    assert play["session"] not in app.state.sessions.items  # the device's old stream stopped
    caps = {"video": "h264,hevc", "audio": "aac,ac3,eac3"}
    office = client.get(f"/api/titles/{title_id(client, 'The Office')}").json()["items"][0]["id"]
    ac3 = client.post("/api/play", json={"item_id": office, "client": "x", "caps": caps}).json()
    assert ac3["mode"] == "remux" and not any("AAC" in r for r in ac3["reasons"])


@needs_ffmpeg
def test_tags_collections_queues_preferences(server):
    client, _ = server
    login(client)
    heat, office = title_id(client, "Heat"), title_id(client, "The Office")
    assert client.put(f"/api/titles/{heat}/tags/favorite").status_code == 200
    client.put(f"/api/titles/{office}/tags/watchlist")
    assert client.put(f"/api/titles/{heat}/tags/bogus").status_code == 400
    home = {r["id"]: r for r in client.get("/api/home").json()["rails"]}
    assert (
        home["favorites"]["items"][0]["id"] == heat
        and home["watchlist"]["items"][0]["id"] == office
    )
    col = client.post("/api/collections", json={"name": "Weekend", "titles": [heat]}).json()
    client.patch(f"/api/collections/{col['id']}", json={"add": office})
    assert client.get(f"/api/collections/{col['id']}").json()["titles"] == [heat, office]
    assert any(r["name"] == "Weekend" for r in client.get("/api/home").json()["rails"])
    q = client.post(
        "/api/queues", json={"name": "All", "mode": "sequential", "collection": col["id"]}
    ).json()
    assert len(q["items"]) == 4 and q["current"] == q["items"][0]
    stepped = client.post(f"/api/queues/{q['id']}/step", json={"step": 1}).json()
    assert stepped["current"] == q["items"][1]
    shuffled = client.post("/api/queues", json={"mode": "shuffle", "titles": [office]}).json()
    assert sorted(shuffled["items"]) == sorted(q["items"][1:])
    prefs = client.put(
        "/api/preferences", json={"audio_language": "ja", "autoplay_next": False, "nonsense": 1}
    ).json()
    assert (
        prefs["audio_language"] == "ja"
        and prefs["autoplay_next"] is False
        and "nonsense" not in prefs
    )
    assert client.put("/api/preferences", json={"subtitle_mode": "loud"}).status_code == 400
    styled = client.put(
        "/api/preferences", json={"subtitle_color": "yellow", "subtitle_background": "solid"}
    ).json()
    assert styled["subtitle_color"] == "yellow" and styled["subtitle_background"] == "solid"
    assert client.put("/api/preferences", json={"subtitle_color": "plaid"}).status_code == 400
    client.post(f"/api/titles/{office}/watched", json={"watched": True})
    assert client.get(f"/api/titles/{office}").json()["items"][2]["completed"] is True
    assert next(t for t in client.get("/api/titles").json()["titles"] if t["id"] == office)[
        "watched"
    ]


@needs_ffmpeg
def test_missing_files_hide_titles(server, tmp_path):
    client, app = server
    login(client)
    for path in (tmp_path / "lib" / "Movies" / "Alien (1979)").iterdir():
        path.unlink()
    app.state.scanner.scan()
    names = [t["name"] for t in client.get("/api/titles").json()["titles"]]
    assert "Alien" not in names
    assert client.get("/api/admin/review").json()["missing"][0]["title"] == "Alien"


@needs_ffmpeg
def test_artwork_routes(server):
    client, app = server
    login(client)
    office = client.get(f"/api/titles/{title_id(client, 'The Office')}").json()
    item = office["items"][0]["id"]
    db = app.state.db
    db.run("UPDATE titles SET poster='https://img.test/p.jpg' WHERE id=?", office["id"])
    db.run("UPDATE items SET thumbnail='https://img.test/t.jpg' WHERE id=?", item)
    art = app.state.metadata.art_dir
    art.mkdir(parents=True, exist_ok=True)
    import hashlib

    for url in ("https://img.test/p.jpg", "https://img.test/t.jpg"):
        (art / (hashlib.sha1(url.encode()).hexdigest() + ".img")).write_bytes(b"\x89PNG....")
    assert client.get(f"/api/art/{office['id']}/poster").headers["content-type"] == "image/png"
    assert client.get(f"/api/art/item/{item}").status_code == 200
    assert client.get(f"/api/art/{office['id']}/background").status_code == 404  # none, offline
    assert client.get(f"/api/titles/{office['id']}").json()["items"][0]["thumbnail"] == (
        f"/api/art/item/{item}"
    )


def test_static_ui_is_served(tmp_path):
    config = Config(database=tmp_path / "db.sqlite", runtime=tmp_path / "rt", metadata_online=False)
    with TestClient(create_app(config, background=False)) as client:
        assert "MEDIAWAN" in client.get("/").text
        assert client.get("/static/app.js").status_code == 200
        assert client.get("/static/vendor/hls.min.js").status_code == 200


def test_background_jobs_scan_on_startup(tmp_path):
    lib = tmp_path / "Movies"
    (lib / "Heat (1995)").mkdir(parents=True)
    (lib / "Heat (1995)" / "Heat.1995.mkv").write_bytes(b"not really a video")
    config = Config(
        database=tmp_path / "db.sqlite",
        runtime=tmp_path / "rt",
        library_roots=[lib],
        metadata_online=False,
        ffprobe="ffprobe-missing",
    )
    with TestClient(create_app(config)) as client:
        deadline = time.time() + 10
        while time.time() < deadline and not client.app.state.scanner.last:
            time.sleep(0.05)
        assert client.app.state.scanner.last["added"] == 1
