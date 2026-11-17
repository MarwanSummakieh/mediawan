"""Online anime against fake AniList, MegaPlay and CDN servers (no network)."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from mediawan import online
from mediawan.app import create_app
from mediawan.config import Config
from mediawan.db import Database

ADMIN = {"email": "admin@example.test", "password": "correct horse battery"}
SUB_HASH = "/anime/" + "a" * 32 + "/" + "b" * 32
DUB_HASH = "/anime/" + "a" * 32 + "/" + "c" * 32

MEDIA = {
    "id": 154587,
    "idMal": 52991,
    "format": "TV",
    "status": "RELEASING",
    "episodes": 28,
    "seasonYear": 2023,
    "averageScore": 90,
    "genres": ["Adventure"],
    "duration": 24,
    "title": {"romaji": "Sousou no Frieren", "english": "Frieren"},
    "coverImage": {"extraLarge": "https://img.test/cover.jpg", "large": None},
    "bannerImage": "https://img.test/banner.jpg",
    "nextAiringEpisode": {"episode": 4},
    "description": "An elf<br><br>and <i>friends</i> &amp; more",
    "streamingEpisodes": [
        {"title": "Episode 2 - Second", "thumbnail": "https://img.test/2.jpg"},
        {"title": "Episode 1 - The Journey's End", "thumbnail": "https://img.test/1.jpg"},
    ],
}

MASTER = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=1920x1080\nindex-f1.m3u8\n"
VARIANT = (
    "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\n"
    "https://seg.test/anime/x/seg-f1-00000.jpg\n#EXT-X-ENDLIST\n"
)


class Upstream:
    """One fake internet. `down` lists hosts that refuse connections."""

    def __init__(self):
        self.down: set[str] = set()
        self.ani_mapped = True
        self.seen: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        url, host = request.url, request.url.host
        if host in self.down:
            raise httpx.ConnectError("down", request=request)
        if host == "graphql.anilist.co":
            variables = json.loads(request.content)["variables"]
            if "q" in variables:
                return httpx.Response(200, json={"data": {"Page": {"media": [MEDIA]}}})
            if variables["id"] != MEDIA["id"]:
                return httpx.Response(404, json={"data": {"Media": None}})
            return httpx.Response(200, json={"data": {"Media": MEDIA}})
        if host == "megaplay.buzz":
            path = url.path
            if path.startswith("/stream/ani/") and not self.ani_mapped:
                return httpx.Response(404, text="<h1>404</h1>")
            if path.startswith(("/stream/ani/", "/stream/mal/")):
                lang = path.rsplit("/", 1)[-1]
                return httpx.Response(200, text=f'<div data-id="{100 if lang == "sub" else 200}">')
            if path == "/stream/getSources":
                assert request.headers.get("X-Requested-With") == "XMLHttpRequest"
                folder = SUB_HASH if url.params["id"] == "100" else DUB_HASH
                return httpx.Response(
                    200,
                    json={
                        "tracks": [
                            {"file": f"https://cdn-b.test{SUB_HASH}/subtitles/t0_CR_English_eng.vtt",
                             "label": "English", "kind": "captions", "default": True},
                            {"file": f"https://cdn-b.test{SUB_HASH}/preview/thumbs.vtt",
                             "kind": "thumbnails"},
                        ],
                        "intro": {"start": 60, "end": 150},
                        "outro": {"start": 0, "end": 0},
                        "image": f"https://cdn-a.test{folder}/preview/thumbnail.jpg",
                        "enc": "opaque",
                    },
                )  # fmt: skip
        if host.startswith("cdn-") or host == "seg.test":
            if request.headers.get("Referer") != "https://megaplay.buzz/":
                return httpx.Response(403, text="forbidden")
            if url.path.endswith("master.m3u8"):
                return httpx.Response(200, text=MASTER)
            if url.path.endswith("index-f1.m3u8"):
                return httpx.Response(200, text=VARIANT)
            if url.path.endswith(".vtt"):
                return httpx.Response(200, text="WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n")
            if url.path.endswith(".jpg"):
                return httpx.Response(200, content=b"\x47" + b"\x00" * 187)
        return httpx.Response(404)


@pytest.fixture
def upstream():
    return Upstream()


@pytest.fixture
def source(tmp_path, upstream):
    transport = httpx.MockTransport(upstream)
    return online.Online(
        Database(":memory:"),
        tmp_path / "online.key",
        client=httpx.Client(transport=transport),
        async_client=httpx.AsyncClient(transport=transport),
    )


@pytest.fixture
def server(tmp_path, upstream):
    transport = httpx.MockTransport(upstream)
    config = Config(
        database=tmp_path / "data" / "db.sqlite",
        runtime=tmp_path / "runtime",
        admin_email=ADMIN["email"],
        admin_password=ADMIN["password"],
        metadata_online=False,
        scan_interval=0,
    )
    app = create_app(
        config,
        background=False,
        online_clients=(httpx.Client(transport=transport), httpx.AsyncClient(transport=transport)),
    )
    with TestClient(app) as client:
        assert client.post("/api/login", json=ADMIN).status_code == 200
        yield client


def test_search_and_details(source):
    [found] = source.search("frieren")
    assert (found["name"], found["available"], found["total"]) == ("Frieren", 3, 28)
    details = source.anime(154587)
    assert details["description"] == "An elf\n\nand friends & more"
    assert [e["number"] for e in details["episodes"]] == [1, 2, 3]
    assert details["episodes"][0]["name"] == "The Journey's End"
    assert details["episodes"][2] == {"number": 3, "name": "", "thumbnail": None}


def test_available_episodes():
    assert online.available_episodes({"status": "FINISHED", "episodes": 12}) == 12
    assert online.available_episodes({"nextAiringEpisode": {"episode": 1}}) == 0
    assert online.available_episodes({"status": "NOT_YET_RELEASED", "episodes": 12}) == 0


def test_resolve_takes_the_stream_folder_from_image_not_subtitles(source):
    sub = source.resolve(154587, 52991, 1, "sub")
    dub = source.resolve(154587, 52991, 1, "dub")
    assert sub["master"] == f"https://cdn-a.test{SUB_HASH}/master.m3u8"
    assert dub["master"] == f"https://cdn-a.test{DUB_HASH}/master.m3u8"
    assert sub["intro"] == {"start": 60.0, "end": 150.0} and sub["outro"] is None
    assert [(t["label"], t["lang"]) for t in sub["subtitles"]] == [("English", "en")]


def test_resolve_falls_back_to_mal_and_other_hosts(source, upstream):
    upstream.ani_mapped = False
    upstream.down.add("cdn-a.test")
    found = source.resolve(154587, 52991, 2, "sub")
    assert found["master"] == f"https://cdn-b.test{SUB_HASH}/master.m3u8"
    assert any("/stream/mal/52991/2/sub" in str(r.url) for r in upstream.seen)
    with pytest.raises(online.OnlineError) as missing:
        source.resolve(154587, None, 3, "sub")  # no AniList mapping and no MAL id
    assert missing.value.status == 404


def test_signed_links(source):
    token = source.sign("https://cdn-a.test/x.m3u8")
    assert source.unsign(token) == "https://cdn-a.test/x.m3u8"
    body, mac = token.split(".")
    forged = source.sign("https://evil.test/")
    for bad in (body + "." + forged.split(".")[1], "nonsense", forged.split(".")[0] + "." + mac):
        with pytest.raises(online.OnlineError):
            source.unsign(bad)


def test_rewrite_sends_every_entry_through_the_proxy(source):
    text = source.rewrite(
        '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg-1.jpg\nhttps://o.test/v.m3u8\n',
        "https://cdn-a.test/anime/h/master.m3u8",
    )
    lines = text.splitlines()
    assert lines[1].startswith('#EXT-X-MAP:URI="/api/online/seg/')
    assert source.unsign(lines[3].rsplit("/", 1)[1]) == "https://cdn-a.test/anime/h/seg-1.jpg"
    assert lines[4].startswith("/api/online/hls/")


def test_next_episode():
    nxt = online.Online.next_episode
    assert nxt({}, 5) == {"episode": 1, "position": 0.0}
    assert nxt({}, 0) is None
    row = lambda ep, done, at, pos=0.0: {
        "episode": ep, "completed": done, "played_at": at, "position": pos
    }  # fmt: skip
    assert nxt({2: row(2, 0, 10, 300.0)}, 5) == {"episode": 2, "position": 300.0}
    assert nxt({2: row(2, 1, 10), 1: row(1, 1, 5)}, 5) == {"episode": 3, "position": 0.0}
    assert nxt({5: row(5, 1, 10)}, 5) == {"episode": 1, "position": 0.0}


def test_play_proxy_progress_and_home(server):
    search = server.get("/api/online/search", params={"q": "frieren"}).json()
    assert search["enabled"] and search["results"][0]["id"] == 154587

    play = server.post("/api/online/play", json={"anilist_id": 154587, "episode": 1}).json()
    assert play["mode"] == "online" and play["url"].startswith("/api/online/hls/")
    assert play["item"]["name"] == "The Journey's End" and play["next"]["episode"] == 2
    assert play["intro"] == {"start": 60.0, "end": 150.0}
    # No translator configured: the wanted languages are listed, but say why they cannot play
    wanted = [s for s in play["subtitles"] if s.get("translated")]
    assert [(s["lang"], s["available"], s["title"]) for s in wanted] == [
        ("ar", False, "Arabic (translation is off)"),
        ("da", False, "Danish (translation is off)"),
        ("pt", False, "Portuguese (translation is off)"),
    ]

    master = server.get(play["url"])
    assert master.status_code == 200 and "/api/online/hls/" in master.text
    variant_url = next(x for x in master.text.splitlines() if x.startswith("/api/"))
    variant = server.get(variant_url).text
    segment_url = next(x for x in variant.splitlines() if x.startswith("/api/"))
    segment = server.get(segment_url)
    assert segment.status_code == 200 and segment.headers["content-type"] == "video/mp2t"
    assert segment.content[:1] == b"\x47"
    own = next(s for s in play["subtitles"] if not s.get("translated"))
    subtitle = server.get(own["url"])
    assert subtitle.headers["content-type"].startswith("text/vtt") and "Hi" in subtitle.text
    assert server.get("/api/online/seg/aGk.AAAA").status_code == 404

    assert (
        server.post("/api/online/play", json={"anilist_id": 154587, "episode": 9}).status_code
        == 404
    )

    server.post(
        "/api/online/progress",
        json={"anilist_id": 154587, "episode": 1, "lang": "sub", "position": 600,
              "duration": 1440, "name": "Frieren", "available": 3},
    )  # fmt: skip
    rails = server.get("/api/home").json()["rails"]
    assert rails[0]["id"] == "online"
    card = rails[0]["items"][0]
    assert (card["anilist_id"], card["episode"], card["position"]) == (154587, 1, 600.0)
    details = server.get("/api/online/anime/154587").json()
    assert details["next"] == {"episode": 1, "position": 600.0}
    resume = server.post("/api/online/play", json={"anilist_id": 154587, "episode": 1}).json()
    assert resume["position"] == 600.0

    server.post(
        "/api/online/progress",
        json={"anilist_id": 154587, "episode": 1, "position": 1430, "duration": 1440,
              "name": "Frieren", "available": 3},
    )  # fmt: skip
    card = server.get("/api/home").json()["rails"][0]["items"][0]
    assert (card["episode"], card["position"]) == (2, 0.0)


def test_online_can_be_turned_off(tmp_path):
    config = Config(
        database=tmp_path / "db.sqlite",
        runtime=tmp_path / "rt",
        admin_email=ADMIN["email"],
        admin_password=ADMIN["password"],
        metadata_online=False,
        scan_interval=0,
        online_anime=False,
    )
    with TestClient(create_app(config, background=False)) as client:
        client.post("/api/login", json=ADMIN)
        assert client.get("/api/online/search", params={"q": "x"}).json() == {
            "enabled": False,
            "results": [],
        }
        assert client.get("/api/online/anime/1").status_code == 409

def test_a_cinemeta_title_that_is_anime_maps_to_its_anilist_entry(source):
    # English or romaji name, a year within one, and a series format: Frieren (TV, 2023).
    assert source.match("Frieren", 2023, "show") == 154587
    assert source.match("Sousou no Frieren", 2024, "show") == 154587
    # A film of the same name, another year (a live-action remake), or another name: not anime.
    assert source.match("Frieren", 2023, "movie") is None
    assert source.match("Frieren", 2031, "show") is None
    assert source.match("Frieren Live", 2023, "show") is None
