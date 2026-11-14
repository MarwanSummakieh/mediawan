"""The torrent engine (torrentd.py): piece planning, file choice, the tunnel check, and a real
libtorrent round trip on loopback (a local seeder; no trackers, no DHT, no public swarm)."""

import http.client
import json
import threading
import time
from pathlib import Path

import pytest

from mediawan import torrentd as td


def test_head_and_tail_come_first_then_reader_windows_with_deadlines():
    span = td.Span(first=0, last=99, head_end=3, tail_start=96, playing=False, readers=[], window=8)
    priorities, urgent = td.plan_pieces(100, [span])
    assert priorities[:4] == [7] * 4 and priorities[96:] == [7] * 4
    assert set(priorities[4:96]) == {0}  # prepared: nothing else is fetched
    assert urgent == [0, 1, 2, 3, 96, 97, 98, 99]
    # A reader (a seek to piece 50): what it reads next comes first, then head and tail (which
    # FFprobe needs next), then the rest of its window.
    span.readers, span.playing = [50], True
    priorities, urgent = td.plan_pieces(100, [span])
    assert urgent[:2] == [50, 51]
    assert urgent[2:10] == [0, 1, 2, 3, 96, 97, 98, 99]
    assert urgent[10:] == list(range(52, 58))
    assert priorities[50:58] == [7] * 8
    assert priorities[60] == 4 and priorities[20] == 1  # ahead of the reader before behind it


def test_only_selected_files_are_fetched():
    a = td.Span(0, 9, 1, 9, True, [], 4)
    priorities, _ = td.plan_pieces(30, [a])
    assert all(p == 0 for p in priorities[10:])


def test_choose_file_prefers_the_listed_name_and_refuses_to_guess():
    files = [
        {"index": 0, "path": "Show/Show.S01E01.mkv", "size": 900},
        {"index": 1, "path": "Show/Show.S01E02.mkv", "size": 1000},
        {"index": 2, "path": "Show/sample.mkv", "size": 10},
    ]
    videos = files
    assert td.choose_file(videos, files, 0, "Show.S01E02.mkv")["index"] == 1  # the name wins over the index
    assert td.choose_file(videos, files, 1, "")["index"] == 1
    assert td.choose_file(videos, files, None, "")["index"] == 1  # nothing named: the largest
    # Named a file the torrent lacks, and the index disagrees with the name: refuse.
    assert td.choose_file(videos, files, 0, "Show.S01E05.mkv") is None
    assert td.choose_file(videos, files, None, "Other.mkv") is None


def test_tunnel_check(tmp_path):
    settings = td.Settings(require_vpn=True)
    up = lambda: ["tun0"]
    assert td.check_tunnel(settings, up, lambda n: "10.8.0.2")["ok"]
    assert not td.check_tunnel(settings, list, lambda n: None)["ok"]
    assert not td.check_tunnel(td.Settings(interface="wg0"), up, lambda n: "10.8.0.2")["ok"]
    off = td.check_tunnel(td.Settings(require_vpn=False), list, lambda n: None)
    assert off["ok"] and not off["required"]
    # sysfs: tunnel-like names whose IFF_UP flag is set
    for name, flags in (("tun0", "0x1091"), ("wg0", "0x1090"), ("eth0", "0x1003")):
        (tmp_path / name).mkdir()
        (tmp_path / name / "flags").write_text(flags)
    assert td.tunnel_interfaces(tmp_path) == ["tun0"]


def test_settings_from_env():
    s = td.Settings.from_env({"TORRENT_KEY": "k", "TRANSCODE_DIR": "/transcode", "TORRENT_CACHE_GB": "5",
                              "TORRENT_REQUIRE_VPN": "false", "TORRENT_DEV_ALLOW_HASHES": "AB" * 20})  # fmt: skip
    assert s.key == "k" and s.cache_bytes == 5 * td.GiB and not s.require_vpn
    assert s.directory.as_posix().endswith("/transcode/torrents")
    assert s.allow_hashes == {"ab" * 20}


# ---- a real round trip -------------------------------------------------------------------------

lt = pytest.importorskip("libtorrent")


def _get(port: int, path: str, headers=None, method="GET"):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    conn.request(method, path, headers=headers or {})
    response = conn.getresponse()
    body = response.read()
    conn.close()
    return response.status, dict(response.getheaders()), body


def _post(port: int, path: str, body: dict, key="k"):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    conn.request("POST", path, json.dumps(body), {"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    response = conn.getresponse()
    data = json.loads(response.read() or b"{}")
    conn.close()
    return response.status, data


@pytest.fixture
def local_swarm(tmp_path, monkeypatch):
    """A seeder session with one generated video file, and an engine with no way out: no
    trackers, no DHT, peers only by an explicit loopback connection."""
    monkeypatch.setattr(td, "OPEN_TRACKERS", [])
    seed_dir = tmp_path / "seed"
    (seed_dir / "Pack").mkdir(parents=True)
    payload = bytes((i * 7) % 251 for i in range(3 * 1024 * 1024 + 12345))
    (seed_dir / "Pack" / "Film.2026.1080p.WEB-DL.mkv").write_bytes(payload)
    (seed_dir / "Pack" / "notes.txt").write_text("hello")
    fs = lt.file_storage()
    lt.add_files(fs, str(seed_dir / "Pack"))
    ct = lt.create_torrent(fs, 32 * 1024)
    lt.set_piece_hashes(ct, str(seed_dir))
    info = lt.torrent_info(ct.generate())
    seeder = lt.session({"listen_interfaces": "127.0.0.1:0", "enable_dht": False, "enable_lsd": False,
                         "enable_upnp": False, "enable_natpmp": False})  # fmt: skip
    seeder.add_torrent({"ti": info, "save_path": str(seed_dir), "flags": lt.torrent_flags.seed_mode})
    settings = td.Settings(key="k", host="127.0.0.1", port=0, directory=tmp_path / "cache", require_vpn=False,
                           listen_port=0, dht=False, idle_seconds=60)  # fmt: skip
    engine = td.Engine(settings)
    engine.session.apply_settings({"listen_interfaces": "127.0.0.1:0"})
    server = td.serve(settings, engine)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield {"engine": engine, "port": port, "info": info, "payload": payload, "seeder": seeder}
    server.shutdown()
    engine.close()


def test_a_file_streams_over_http_with_ranges_while_it_downloads(local_swarm):
    s = local_swarm
    info_hash = str(s["info"].info_hash())
    port = s["port"]
    assert _get(port, "/health")[0] == 200
    assert _post(port, "/v1/torrents", {"hash": info_hash}, key="wrong")[0] == 401
    status, body = _post(port, "/v1/torrents", {"hash": info_hash, "trackers": []})
    assert status == 201 and not body["has_metadata"]
    torrent = s["engine"].torrents[info_hash]
    torrent.handle.connect_peer(("127.0.0.1", s["seeder"].listen_port()))
    deadline = time.time() + 30
    while not torrent.handle.status().has_metadata and time.time() < deadline:
        time.sleep(0.1)
    status, chosen = _post(port, f"/v1/torrents/{info_hash}/files", {"index": None, "name": "Film.2026.1080p.WEB-DL.mkv"})
    assert status == 200, chosen
    assert chosen["path"].endswith("Film.2026.1080p.WEB-DL.mkv") and chosen["size"] == len(s["payload"])
    # A range in the middle, not downloaded yet when asked for: served once its pieces arrive.
    status, headers, body = _get(port, chosen["url"], {"Range": "bytes=2000000-2099999"})
    assert status == 206 and body == s["payload"][2000000:2100000]
    assert headers["Content-Range"] == f"bytes 2000000-2099999/{len(s['payload'])}"
    status, _, body = _get(port, chosen["url"], {"Range": "bytes=-1000"})
    assert body == s["payload"][-1000:]
    status, _, body = _get(port, chosen["url"])
    assert status == 200 and body == s["payload"]
    assert _get(port, chosen["url"], {"Range": f"bytes={len(s['payload'])}-"})[0] == 416
    assert _get(port, "/file/" + "0" * 40 + "/x.mkv")[0] == 404
    # Leaving deletes the data.
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request("DELETE", f"/v1/torrents/{info_hash}", headers={"Authorization": "Bearer k"})
    assert conn.getresponse().status == 200
    assert _get(port, chosen["url"])[0] == 404
    deadline = time.time() + 15
    while torrent.directory.exists() and time.time() < deadline:
        time.sleep(0.2)
    assert not torrent.directory.exists()


def test_the_engine_refuses_without_a_tunnel_and_off_the_allow_list(tmp_path, monkeypatch):
    monkeypatch.setattr(td, "tunnel_interfaces", lambda root=Path("/sys/class/net"): [])
    engine = td.Engine(td.Settings(key="k", directory=tmp_path / "c", require_vpn=True, listen_port=0, dht=False))
    try:
        with pytest.raises(td.Refused) as refused:
            engine.add("ab" * 20, [])
        assert refused.value.reason == "vpn"
    finally:
        engine.close()
    engine = td.Engine(td.Settings(key="k", directory=tmp_path / "d", require_vpn=False, listen_port=0, dht=False,
                                   allow_hashes={"cd" * 20}))  # fmt: skip
    try:
        with pytest.raises(td.Refused) as refused:
            engine.add("ab" * 20, [])
        assert refused.value.reason == "not-allowed"
    finally:
        engine.close()


def test_a_resume_hint_is_fetched_after_head_and_tail_until_a_reader_arrives():
    span = td.Span(0, 99, 3, 99, False, [], 8, hints=[60])
    priorities, urgent = td.plan_pieces(100, [span])
    assert urgent == [0, 1, 2, 3, 99, 60, 61, 62, 63]
    assert set(priorities[64:99]) == {0}
