"""Torrent streaming in the web app (torrent.py and its routes), against a fake sidecar."""

import threading
import time

import pytest
from fastapi.testclient import TestClient

from mediawan.app import create_app
from mediawan.config import Config
from mediawan.db import Database
from mediawan.torrent import Timings, TorrentError, Torrents, episode_mismatch

from .conftest import needs_ffmpeg

GiB, MiB = 1073741824, 1048576


class FakeSidecar:
    """Swarms by info hash: when the file list arrives, which files there are, or a refusal."""

    enabled = True
    url = "http://fake"

    def __init__(self, swarms=None, refuse=None, file_url=None):
        self.swarms = swarms or {}
        self.refuse = refuse
        self.added, self.removed, self.modes = {}, [], []
        self.lock = threading.Lock()
        self._file_url = file_url

    def add(self, info_hash, trackers):
        if self.refuse:
            raise TorrentError(*self.refuse)
        with self.lock:
            self.added.setdefault(info_hash, time.time())
        return self.status(info_hash)

    def status(self, info_hash):
        swarm = self.swarms.get(info_hash, {})
        since = time.time() - self.added.get(info_hash, time.time())
        meta = swarm.get("metadata") is not None and since >= swarm["metadata"]
        return {"hash": info_hash, "peers": swarm.get("peers", 3) if meta or swarm.get("peers") else 0,
                "has_metadata": meta, "download_rate": 1000, "error": None,
                "selected": [{"index": 0, "ready_fraction": 1.0, "buffered_ahead": 5 * MiB, "downloaded": MiB,
                              "waiting": False}] if meta else []}  # fmt: skip

    def select(self, info_hash, index, name, mode):
        swarm = self.swarms[info_hash]
        path = swarm.get("path", name or "video.mkv")
        return {"index": 0, "path": path, "size": swarm.get("size", GiB), "url": f"/file/{info_hash}/{path}"}

    def mode(self, info_hash, index, mode):
        self.modes.append((info_hash, mode))

    def hint(self, info_hash, index, position):
        self.modes.append((info_hash, "hint", position))

    def remove(self, info_hash):
        with self.lock:
            self.removed.append(info_hash)
            self.added.pop(info_hash, None)

    def overview(self):
        return {"tunnel": {"ok": True, "message": "Torrents run through the tunnel (tun0)."}}

    def file_url(self, path):
        return self._file_url(path) if self._file_url else f"http://fake{path}"


def release(h, name, seeders=50, size=8 * GiB, resolution=1080, filename=None, file_index=None):
    return {"hash": h * 40, "file_index": file_index, "label": f"{name}\n👤 {seeders} 💾 1 GB", "name": "",
            "filename": filename if filename is not None else f"{name}.mkv", "seeders": seeders, "size": size,
            "resolution": resolution, "trackers": []}  # fmt: skip


FILM = {"kind": "movie", "id": "tt0000001", "name": "Film", "year": 2026, "runtime": "2h", "release_info": "2026",
        "poster": None, "background": None, "episodes": []}  # fmt: skip
SHOW = {"kind": "show", "id": "tt0000002", "name": "Show", "year": 2018, "runtime": "45 min", "release_info": "2018–",
        "poster": None, "background": None,
        "episodes": [{"season": 1, "episode": e, "name": f"E{e}"} for e in (1, 2, 3)]}  # fmt: skip


def make(tmp_path, listing, swarms=None, durations=None, refuse=None, **kw):
    db = Database(tmp_path / "db.sqlite")
    sidecar = FakeSidecar(swarms, refuse, kw.pop("file_url", None))
    torrents = Torrents(
        db, "ffprobe", "ffmpeg", tmp_path / "rt", sidecar=sidecar, background=False,
        timings=Timings(fallback=0.3, connect=3, poll=0.02),
        probe=lambda url: {"duration": (durations or {}).get(url.split("/")[4], 7200.0), "video": [{"codec": "h264"}],
                           "audio": [], "subtitles": []},
        **kw,
    )  # fmt: skip
    torrents._fetch = lambda title, season, episode: listing(title, season, episode)
    return torrents, sidecar, db


def until(test, limit=5.0):
    deadline = time.time() + limit
    while time.time() < deadline:
        if test():
            return True
        time.sleep(0.02)
    raise AssertionError("timed out")


def wait_done(torrents, stream):
    until(lambda: torrents.public(stream)["state"] in ("ready", "failed"))
    return torrents.public(stream)


def test_options_rank_each_quality_explain_the_missing_one_and_answer_from_memory(tmp_path):
    calls = []

    def listing(title, season, episode):
        calls.append(1)
        return [release("a", "Film.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRP"),
                release("b", "Film.2026.1080p.WEBRip.x264-GRP", seeders=900)]  # fmt: skip

    torrents, _, _ = make(tmp_path, listing)
    first = torrents.options(1, FILM, 0, 0)
    assert [(q["quality"], q["available"]) for q in first["qualities"]] == [(1080, True), (2160, False)]
    assert first["qualities"][0]["release"]["hash"] == "a" * 40  # the WEBRip never passes
    assert first["qualities"][0]["release"]["tags"] == ["1080p", "WEB-DL", "AMZN"]
    assert "No 4K release is listed" in first["qualities"][1]["reason"]
    assert first["default"] == 1080 and not first["cached"]
    assert torrents.options(1, FILM, 0, 0)["cached"] and len(calls) == 1


def test_a_film_defaults_to_4k_and_a_series_to_1080p_when_both_exist(tmp_path):
    both = lambda t, s, e: [release("a", f"{t['name']}.2026.1080p.NF.WEB-DL.DDP5.1.H.264-G", size=9 * GiB),
                            release("b", f"{t['name']}.2026.2160p.NF.WEB-DL.DDP5.1.HDR.H.265-G", size=20 * GiB,
                                    resolution=2160)]  # fmt: skip
    torrents, _, _ = make(tmp_path, both)
    assert torrents.options(1, FILM, 0, 0)["default"] == 2160
    assert torrents.options(1, SHOW, 1, 1)["default"] == 1080


def test_an_older_series_with_nothing_sound_at_1080p_is_offered_its_best_lower_quality(tmp_path):
    sitcom = {**SHOW, "id": "tt7", "name": "Sitcom", "year": 1993, "release_info": "1993–2004", "runtime": "22 min"}
    dvd = release("1", "Sitcom.S01E01.DVDRip.x264-GRP", seeders=60, size=280 * MiB, resolution=None)
    revival = release("2", "Sitcom 2026 S01E01 1080p DSNP WEB-DL DDP5 1 H 264-NTb", seeders=500, size=1100 * MiB)
    dub = release("3", "Sitcom.S01E01.1080p.WEB-DL.H265-FT [Lektor PL]", seeders=30, size=400 * MiB)
    sound = release("4", "Sitcom.S01E02.1080p.AMZN.WEB-DL.DDP2.0.H.264-NTb", seeders=25, size=1500 * MiB)
    listings = {1: [dvd, revival, dub], 2: [dvd, sound]}
    torrents, _sidecar, _ = make(tmp_path, lambda t, s, e: listings.get(e, []), swarms={dvd["hash"]: {"metadata": 0}},
                                durations={})  # fmt: skip
    options = torrents.options(1, sitcom, 1, 1)
    assert [(q["quality"], q["available"]) for q in options["qualities"]] == [(480, True), (2160, False)]
    assert options["default"] == 480 and options["qualities"][0]["release"]["hash"] == dvd["hash"]
    # The revival (another series) and the dub never win; with no quality asked for, SD plays.
    stream = torrents.open(1, sitcom, 1, 1, None, "tv")
    assert stream.quality == 480 and wait_done(torrents, stream)["release"]["hash"] == dvd["hash"]
    # A sound 1080p release keeps 1080p even when a DVD rip is better seeded.
    assert [q["quality"] for q in torrents.options(1, sitcom, 1, 2)["qualities"]] == [1080, 2160]


def test_a_slow_first_release_is_raced_and_the_fallback_is_reported(tmp_path):
    slow = release("a", "Film.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRP", seeders=400)
    quick = release("b", "Film.2026.1080p.NF.WEB-DL.DDP5.1.H.264-OTH", seeders=40)
    torrents, sidecar, _ = make(tmp_path, lambda *a: [slow, quick], swarms={slow["hash"]: {}, quick["hash"]: {"metadata": 0}})
    stream = torrents.open(1, FILM, 0, 0, 1080, "web", "play")
    status = wait_done(torrents, stream)
    assert status["state"] == "ready" and status["release"]["hash"] == quick["hash"]
    assert status["fallback"]["from"]["hash"] == slow["hash"]
    assert "No file list within" in status["fallback"]["reason"]
    assert [a["state"] for a in status["attempts"]] == ["abandoned", "won"]
    until(lambda: slow["hash"] in sidecar.removed)  # the losing swarm is left
    assert quick["hash"] not in sidecar.removed


def test_a_film_file_whose_length_is_wrong_is_rejected_for_good_and_the_next_release_plays(tmp_path):
    lookalike = release("a", "Film.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRP", seeders=400)
    real = release("b", "Film.2026.1080p.NF.WEB-DL.DDP5.1.H.264-OTH", seeders=40)
    swarms = {lookalike["hash"]: {"metadata": 0}, real["hash"]: {"metadata": 0}}
    torrents, _sidecar, _db = make(tmp_path, lambda *a: [lookalike, real], swarms,
                                 durations={lookalike["hash"]: 5400.0, real["hash"]: 7150.0})  # fmt: skip
    stream = torrents.open(1, FILM, 0, 0, 1080, "web")
    status = wait_done(torrents, stream)
    assert status["state"] == "ready" and status["release"]["hash"] == real["hash"]
    assert "different film with the same name" in status["fallback"]["reason"]
    assert "runs 90 min" in status["fallback"]["reason"]
    assert torrents.rejected(FILM["id"]) == {lookalike["hash"]: "It runs 90 min; the film runs 120 min."}
    # Never offered again for this title.
    assert torrents.options(1, FILM, 0, 0)["qualities"][0]["release"]["hash"] == real["hash"]


def test_when_every_release_is_a_different_film_the_stream_fails_plainly(tmp_path):
    a = release("a", "Film.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRP")
    torrents, _, _ = make(tmp_path, lambda *x: [a], {a["hash"]: {"metadata": 0}}, durations={a["hash"]: 1500.0})
    status = wait_done(torrents, torrents.open(1, FILM, 0, 0, 1080, "web"))
    assert status["state"] == "failed" and status["error"]["reason"] == "wrong-film"
    assert "different film with the same name" in status["error"]["message"]
    assert not torrents.options(1, FILM, 0, 0)["qualities"][0]["available"]


def test_a_film_labelled_with_another_year_is_never_offered(tmp_path):
    remake = release("a", "Film.1997.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRP", seeders=900)
    torrents, _, _ = make(tmp_path, lambda *x: [remake])
    option = torrents.options(1, FILM, 0, 0)["qualities"][0]
    assert not option["available"] and "Labelled 1997, not 2026" in option["reason"]


def test_a_season_pack_that_hands_over_the_wrong_episode_is_skipped(tmp_path):
    pack = release("a", "Show.S01.1080p.NF.WEB-DL.DDP5.1.H.264-GRP", filename="Show.S01E02.1080p.NF.WEB-DL.mkv",
                   size=3 * GiB, file_index=1)  # fmt: skip
    single = release("b", "Show.S01E02.1080p.AMZN.WEB-DL.DDP5.1.H.264-OTH", size=3 * GiB, seeders=20)
    swarms = {pack["hash"]: {"metadata": 0, "path": "Show.S01E03.1080p.NF.WEB-DL.mkv"},
              single["hash"]: {"metadata": 0, "path": "Show.S01E02.1080p.AMZN.WEB-DL.mkv"}}  # fmt: skip
    torrents, _, _ = make(tmp_path, lambda *x: [pack, single], swarms)
    status = wait_done(torrents, torrents.open(1, SHOW, 1, 2, 1080, "web"))
    assert status["state"] == "ready" and status["release"]["hash"] == single["hash"]
    assert "S01E03, not S01E02" in status["attempts"][0]["reason"]
    assert episode_mismatch("Show (2018) - S01E02 - Name.mkv", 1, 2) is None


def test_no_peers_for_any_release_ends_in_a_clear_failure(tmp_path):
    a, b = release("a", "Film.2026.1080p.NF.WEB-DL.H.264-A"), release("b", "Film.2026.1080p.NF.WEB-DL.H.264-B")
    torrents, sidecar, _ = make(tmp_path, lambda *x: [a, b], {a["hash"]: {}, b["hash"]: {}})
    torrents.timings.connect = 1.0
    status = wait_done(torrents, torrents.open(1, FILM, 0, 0, 1080, "web"))
    assert status["error"]["reason"] == "no-peers"
    assert "any of the 2 releases" in status["error"]["message"]
    until(lambda: set(sidecar.removed) >= {a["hash"], b["hash"]})


def test_the_sidecar_refusing_outside_the_tunnel_fails_with_the_vpn_reason(tmp_path):
    a = release("a", "Film.2026.1080p.NF.WEB-DL.H.264-A")
    torrents, _, _ = make(tmp_path, lambda *x: [a], refuse=("The VPN tunnel (tun*/wg*) is not up", 503, "vpn"))
    status = wait_done(torrents, torrents.open(1, FILM, 0, 0, 1080, "web"))
    assert status["error"]["reason"] == "vpn" and "VPN" in status["error"]["message"]


def test_a_season_lock_keeps_later_episodes_on_the_same_group(tmp_path):
    def listing(title, season, episode):
        return [release("a", f"Show.S01E0{episode}.1080p.NF.WEB-DL.DDP5.1.H.264-NTb", seeders=20, size=3 * GiB),
                release("b", f"Show.S01E0{episode}.1080p.AMZN.WEB-DL.DDP5.1.H.264-FLUX", seeders=400, size=3 * GiB)]

    swarms = {"a" * 40: {"metadata": 0}, "b" * 40: {"metadata": 0}}
    torrents, _, _ = make(tmp_path, listing, swarms)
    first = wait_done(torrents, torrents.open(1, SHOW, 1, 1, 1080, "web", pinned="a" * 40))
    assert first["release"]["hash"] == "a" * 40
    until(lambda: torrents.read_lock(SHOW, 1, 1080))
    assert torrents.read_lock(SHOW, 1, 1080)["group"] == "NTB"
    assert torrents.options(1, SHOW, 1, 2)["qualities"][0]["release"]["group"] == "NTB"
    assert torrents.options(1, SHOW, 1, 2)["qualities"][0]["season_lock"] == {"group": "NTB", "service": "NF"}


def test_streams_are_shared_per_player_and_closing_one_leaves_a_shared_torrent(tmp_path):
    a = release("a", "Film.2026.1080p.NF.WEB-DL.H.264-A")
    torrents, sidecar, _ = make(tmp_path, lambda *x: [a], {a["hash"]: {"metadata": 0}})
    prepared = torrents.open(1, FILM, 0, 0, 1080, "tv")
    assert torrents.open(1, FILM, 0, 0, 1080, "tv", "play") is prepared  # play claims the warm stream
    other = torrents.open(1, FILM, 0, 0, 1080, "phone", "play")
    assert other is not prepared
    wait_done(torrents, prepared), wait_done(torrents, other)
    torrents.close(prepared)
    time.sleep(0.1)
    assert a["hash"] not in sidecar.removed  # the phone still streams it
    torrents.close(other)
    until(lambda: a["hash"] in sidecar.removed)


# ---- the routes, with real FFmpeg reading a local file as if it came from the sidecar --------


@pytest.fixture
def server(tmp_path, clips):
    a = release("a", "Film.2026.1080p.NF.WEB-DL.DDP5.1.H.264-GRP")
    config = Config(database=tmp_path / "data" / "db.sqlite", runtime=tmp_path / "runtime",
                    admin_email="admin@example.test", admin_password="correct horse battery",
                    metadata_online=False, scan_interval=0, torrent_url="http://fake")  # fmt: skip
    db_holder = {}

    def factory():
        torrents, sidecar, _ = make(tmp_path, lambda *x: [a], {a["hash"]: {"metadata": 0}},
                                    file_url=lambda path: str(clips["mkv"]))  # fmt: skip
        torrents.probe = lambda url: __import__("mediawan.media", fromlist=["probe"]).probe("ffprobe", url)
        db_holder["sidecar"] = sidecar
        return torrents

    torrents = factory()
    app = create_app(config, background=False, torrents=torrents)
    with TestClient(app) as client:
        torrents.db = app.state.db  # share the app's database
        film = {**FILM, "runtime": None}
        app.state.usenet.cache.put(("title", "movie", FILM["id"]), film, 3600)
        client.post("/api/login", json={"email": "admin@example.test", "password": "correct horse battery"})
        yield client, app, db_holder["sidecar"]


@needs_ffmpeg
def test_prepare_play_progress_and_resume_through_the_api(server):
    client, _app, sidecar = server
    title = client.get(f"/api/usenet/title/movie/{FILM['id']}").json()
    assert title["sources"] == {"usenet": False, "torrent": True} and title["source"] is None
    options = client.get(f"/api/torrent/options/movie/{FILM['id']}").json()
    assert options["qualities"][0]["available"] and options["engine"]["ok"]
    status = client.post("/api/torrent/prepare", json={"kind": "movie", "id": FILM["id"], "quality": 1080,
                                                        "player": "web", "intent": "play"}).json()  # fmt: skip
    until(lambda: client.get(f"/api/torrent/streams/{status['id']}").json()["duration"], 20)
    caps = {"video": ["h264"], "audio": ["aac"]}
    played = client.post("/api/torrent/play", json={"stream": status["id"], "caps": caps, "client": "web"})
    assert played.status_code == 200, played.text
    info = played.json()
    assert info["mode"] == "remux" and info["torrent"]["label"] == "1080p"
    assert info["reasons"][0].startswith("Streamed over BitTorrent at 1080p")
    playlist = client.get(info["url"])
    assert playlist.status_code == 200 and "#EXTINF" in playlist.text
    body = {**info["torrent"], "position": 5.0, "duration": info["duration"], "session": info["session"]}
    assert client.post("/api/torrent/progress", json=body).status_code == 200
    title = client.get(f"/api/usenet/title/movie/{FILM['id']}").json()
    assert (title["source"], title["quality"], title["next"]["position"]) == ("torrent", 1080, 5.0)
    rail = next(r for r in client.get("/api/home").json()["rails"] if r["id"] == "usenet")
    assert rail["items"][0]["source"] == "torrent" and rail["items"][0]["quality"] == 1080
    # Resume: with no start given, play picks up where it stopped.
    again = client.post("/api/torrent/play", json={"stream": status["id"], "caps": caps, "client": "web"}).json()
    assert again["position"] == 5.0
    # Stopping releases the torrent; the stream is gone.
    assert client.delete(f"/api/torrent/streams/{status['id']}").json()["ok"]
    until(lambda: "a" * 40 in sidecar.removed)
    gone = client.get(f"/api/torrent/streams/{status['id']}")
    assert gone.status_code == 404 and gone.json()["reason"] == "gone"


@needs_ffmpeg
def test_play_before_ready_says_so(server):
    client, app, _ = server
    app.state.torrents.probe = lambda url: time.sleep(2) or {}
    status = client.post("/api/torrent/prepare", json={"kind": "movie", "id": FILM["id"], "player": "web"}).json()
    refused = client.post("/api/torrent/play", json={"stream": status["id"]})
    assert refused.status_code == 409 and refused.json()["reason"] == "not-ready"


@needs_ffmpeg
def test_an_embedded_subtitle_track_is_read_in_the_background_with_progress(tmp_path, clips):
    from mediawan import media
    from mediawan.torrent import SubtitleJobs

    info = media.probe("ffprobe", clips["mkv"])
    index = next(s["index"] for s in info["subtitles"] if s["text"])
    jobs = SubtitleJobs("ffmpeg", tmp_path / "subs")
    first = jobs.request(f"t-x-0-{index}", str(clips["mkv"]), index, info["duration"])
    assert first["status"] in ("working", "ready")
    path = jobs.wait(f"t-x-0-{index}", str(clips["mkv"]), index, info["duration"], limit=60)
    assert path.read_text("utf-8").startswith("WEBVTT")
    assert jobs.request(f"t-x-0-{index}", str(clips["mkv"]), index, 0)["status"] == "ready"


def test_a_prepared_stream_also_fetches_the_viewers_resume_point(tmp_path):
    a = release("a", "Film.2026.1080p.NF.WEB-DL.H.264-A")
    torrents, sidecar, db = make(tmp_path, lambda *x: [a], {a["hash"]: {"metadata": 0, "size": 1000}})
    db.run("INSERT INTO users(id, email, name, pw_hash) VALUES(1, 'a@b.c', 'A', 'x')")
    db.run("INSERT INTO usenet_history(user_id, imdb_id, season, episode, position, duration, played_at, source) "
           "VALUES(1, ?, 0, 0, 3600, 7200, 0, 'torrent')", FILM["id"])  # fmt: skip
    wait_done(torrents, torrents.open(1, FILM, 0, 0, 1080, "web"))
    assert (a["hash"], "hint", 495) in sidecar.modes  # 30 s before halfway = just before halfway into the file
