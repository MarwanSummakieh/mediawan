"""Live sports: channel import, guide matching, the schedule, and shared live streams."""

import functools
import gzip
import http.server
import json
import shutil
import subprocess
import threading
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from mediawan import live, sports
from mediawan.app import create_app
from mediawan.config import Config

from .conftest import needs_ffmpeg

ADMIN = {"email": "admin@example.test", "password": "correct horse battery"}
SERVER = "http://iptv.example:8080"
USER, PASSWORD = "viewer1", "s3cretpass"
NOW = time.time()
KICKOFF = int(NOW // 3600 * 3600)  # this hour, so the match is on now


def xmltv_time(t: float) -> str:
    return time.strftime("%Y%m%d%H%M%S +0000", time.gmtime(t))


GUIDE = f"""<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="SkySpMainEvHD.uk"><display-name>SkySpMainEvHD</display-name></channel>
  <channel id="SkySp.PL.HD.uk"><display-name>SkySp PL HD</display-name></channel>
  <channel id="beIN_SPORTS1_DIGITAL_Mono_EN.bein"><display-name>beIN_SPORTS1_DIGITAL_Mono_EN</display-name></channel>
  <channel id="Sky.Sport.1.HD.de"><display-name>Sky Sport 1 HD</display-name></channel>
  <programme start="{xmltv_time(KICKOFF - 1800)}" stop="{xmltv_time(KICKOFF + 7200)}" channel="SkySp.PL.HD.uk">
    <title>Live Premier League</title><desc>Arsenal v Chelsea. Coverage from the Emirates.</desc>
  </programme>
  <programme start="{xmltv_time(KICKOFF - 600)}" stop="{xmltv_time(KICKOFF + 6600)}" channel="beIN_SPORTS1_DIGITAL_Mono_EN.bein">
    <title>Arsenal v Chelsea</title><desc>Premier League</desc>
  </programme>
  <programme start="{xmltv_time(KICKOFF)}" stop="{xmltv_time(KICKOFF + 3600)}" channel="SkySpMainEvHD.uk">
    <title>Live MotoGP</title><desc>The Grand Prix of Malaysia. Qualifying.</desc>
  </programme>
  <programme start="{xmltv_time(KICKOFF)}" stop="{xmltv_time(KICKOFF + 3600)}" channel="Sky.Sport.1.HD.de">
    <title>Live: Bundesliga Highlights</title><desc>Alle Tore.</desc>
  </programme>
</tv>
"""

STREAMS = [
    ("1", "UK: SKY SPORTS MAIN EVENT UHD", "10"),
    ("2", "UK: SKY SPORTS PREMIER LEAGUE HD", "10"),
    ("3", "4K BEIN SPORTS 1", "20"),
    ("4", "DE : Sky Sport 1 HD", "30"),
    ("5", "US: Sky Sports Main Event", "40"),  # same name, another country: not matched
    ("6", "Cartoon Network", "50"),  # not a sports category: skipped by default
]
CATEGORIES = {
    "10": "United Kingdom - SKY SPORTS",
    "20": "Arabic / MENA - BEIN SPORTS",
    "30": "DE| SPORT",
    "40": "US| SPORTS",
    "50": "KIDS",
}


def espn(day_events):
    return {"leagues": [{"name": "English Premier League"}], "events": day_events}


ESPN_MATCH = {
    "id": "740001",
    "name": "Chelsea at Arsenal",
    "date": time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime(KICKOFF)),
    "status": {"type": {"state": "in", "shortDetail": "23'"}},
    "competitions": [
        {
            "date": time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime(KICKOFF)),
            "competitors": [
                {"homeAway": "home", "score": "1",
                 "team": {"displayName": "Arsenal", "shortDisplayName": "Arsenal", "name": "Arsenal",
                          "logo": "https://a.espncdn.com/ars.png"}},
                {"homeAway": "away", "score": "0",
                 "team": {"displayName": "Chelsea", "shortDisplayName": "Chelsea", "name": "Chelsea",
                          "logo": "https://a.espncdn.com/che.png"}},
            ],
        }
    ],
}  # fmt: skip


class Provider:
    """An Xtream Codes provider, an XMLTV guide host and ESPN, on one mock transport."""

    def __init__(self):
        self.requests: list[str] = []
        self.stream_base = SERVER

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        self.requests.append(str(url))
        if url.path == "/player_api.php":
            if url.params.get("password") != PASSWORD:
                return httpx.Response(200, json={"user_info": {"auth": 0}})
            action = url.params.get("action")
            if action == "get_live_categories":
                return httpx.Response(
                    200,
                    json=[{"category_id": k, "category_name": v} for k, v in CATEGORIES.items()],
                )
            if action == "get_live_streams":
                return httpx.Response(
                    200,
                    json=[
                        {"stream_id": sid, "name": name, "category_id": cat, "stream_icon": ""}
                        for sid, name, cat in STREAMS
                    ],
                )
            return httpx.Response(
                200,
                json={"user_info": {"auth": 1, "status": "Active", "exp_date": "1794086219",
                                    "max_connections": "1", "active_cons": "0"}},
            )  # fmt: skip
        if url.path == "/xmltv.php":
            return httpx.Response(404, text="no guide")
        if url.host == "guides.example":
            return httpx.Response(200, content=gzip.compress(GUIDE.encode()))
        if url.host == "site.api.espn.com":
            day = url.params.get("dates")
            today = time.strftime("%Y%m%d", time.gmtime(KICKOFF))
            if "eng.1" in url.path and day == today:
                return httpx.Response(200, json=espn([ESPN_MATCH]))
            return httpx.Response(200, json=espn([]))
        return httpx.Response(404)


@pytest.fixture
def provider():
    return Provider()


@pytest.fixture
def catalog(tmp_path, provider):
    c = live.Catalog(
        tmp_path / "live", client=httpx.Client(transport=httpx.MockTransport(provider))
    )
    c.import_xtream(SERVER, USER, PASSWORD)
    return c


# ---- names, regions, languages --------------------------------------------------------------


@pytest.mark.parametrize(
    "guide, provider_name",
    [
        ("SkySpMainEvHD", "UK: SKY SPORTS MAIN EVENT UHD"),
        ("SkySp PL HD", "UK: SKY SPORTS PREMIER LEAGUE HD"),
        ("TNT Sport BoxOffice HD", "UK: TNT SPORTS BOX OFFICE"),
        ("beIN_SPORTS1_DIGITAL_Mono", "4K BEIN SPORTS  1"),
        ("logos-_beINSPORTS8", "BEIN SPORTS 8 HD"),
        ("beIN_SPORTS1_ENGLISH_Digital_Mono", "4K BEIN SPORTS 1 EN"),
        ("Sky Sport 1 HD", "DE : Sky Sport 1 4K"),
    ],
)
def test_guide_and_provider_names_meet(guide, provider_name):
    assert live.channel_key(guide) == live.channel_key(provider_name)


def test_different_channels_stay_apart():
    assert live.channel_key("Sky Sports 1") != live.channel_key("Sky Sports 10")
    assert live.channel_key("beIN Sports 1") != live.channel_key("beIN Sports MAX 1")


def test_regions_and_languages():
    assert live.region_of("UK: SKY SPORTS", "") == "United Kingdom"
    assert live.region_of("Sky Sport 1", "Germany - SPORT 4K") == "Germany"
    assert live.region_of("4K BEIN SPORTS 1", "") == "Arabic / MENA"
    assert live.language_of("4K BEIN SPORTS 1 EN", "", "Arabic / MENA") == "English"
    assert live.language_of("4K BEIN SPORTS 1 FR", "", "Arabic / MENA") == "French"
    assert live.language_of("4K BEIN SPORTS 1", "", "Arabic / MENA") == "Arabic"
    assert live.quality_of("SKY SPORTS UHD") == "4K"
    assert live.competition_ids("SKY SPORT BUNDESLIGA 8") == ["bundesliga"]


def test_sport_words_beat_competition_names():
    assert sports.sport_of("Basketball Champions League") == "Basketball"
    assert sports.sport_of("DFB-Pokal: Konferenz") == "Football"
    assert sports.sport_of("Live MotoGP") == "Motorsport"


# ---- importing ---------------------------------------------------------------------------


def test_m3u_import(tmp_path):
    text = (
        '#EXTM3U url-tvg="https://guide.example/epg.xml.gz"\n'
        '#EXTINF:-1 tvg-id="SkySp.PL.HD.uk" tvg-logo="http://logo.example/pl.png" '
        'group-title="UK| SPORTS",UK: Sky Sports Premier League, HD\n'
        "http://iptv.example/live/u/p/2.ts\n"
        '#EXTINF:-1 group-title="UK| SPORTS",Duplicate\n'
        "http://iptv.example/live/u/p/2.ts\n"
        "#EXTINF:-1,Not http\nrtmp://iptv.example/x\n"
    )
    catalog = live.Catalog(tmp_path)
    assert catalog.import_m3u(text) == 1
    c = catalog.channels[0]
    assert c["name"] == "UK: Sky Sports Premier League, HD"  # commas after the first stay
    assert c["epgId"] == "SkySp.PL.HD.uk" and c["region"] == "United Kingdom"
    assert catalog.data["guideUrl"] == "https://guide.example/epg.xml.gz"
    with pytest.raises(ValueError):
        catalog.import_m3u("<html>not a playlist</html>")


def test_xtream_import_keeps_sports_and_the_login_on_the_server(catalog, tmp_path):
    names = [c["name"] for c in catalog.channels]
    assert "Cartoon Network" not in names and len(names) == 5
    assert catalog.max_connections == 1
    assert catalog.account() == {"server": SERVER, "username": USER, "password": PASSWORD}
    assert catalog.channels[0]["url"] == f"{SERVER}/live/{USER}/{PASSWORD}/1.ts"
    status = catalog.status()
    assert status["active"] and status["expires"] == 1794086219
    shown = json.dumps(live.public(catalog.channels[0]))
    assert PASSWORD not in shown and USER not in shown
    # Saved for the next start, and readable as before
    again = live.Catalog(tmp_path / "live")
    assert len(again.channels) == 5 and again.account()["password"] == PASSWORD


def test_xtream_wrong_password(tmp_path, provider):
    catalog = live.Catalog(tmp_path, client=httpx.Client(transport=httpx.MockTransport(provider)))
    with pytest.raises(ValueError, match="refused"):
        catalog.import_xtream(SERVER, USER, "wrong")


def test_v2_catalog_is_read_and_its_account_recovered(tmp_path):
    (tmp_path / "catalog.json").write_text(
        json.dumps(
            {
                "name": "Curated Sports",
                "maxConnections": 1,
                "channels": [
                    {"id": "abc", "name": "UK: SKY SPORTS F1 HD", "group": "United Kingdom - SKY",
                     "url": f"{SERVER}/live/{USER}/{PASSWORD}/77.ts", "language": "English",
                     "languageSource": "region"},
                ],
            }
        )
    )  # fmt: skip
    catalog = live.Catalog(tmp_path)
    c = catalog.by_id["abc"]
    assert c["competitions"] == ["formula-1"] and c["quality"] == "HD"
    assert catalog.account()["username"] == USER


def test_search(catalog):
    found = catalog.search("sky sp main")
    assert [c["name"] for c in found["channels"]] == [
        "UK: SKY SPORTS MAIN EVENT UHD",
        "US: Sky Sports Main Event",
    ]
    assert catalog.search("bein", language="Arabic")["total"] == 1
    assert "url" not in found["channels"][0]


# ---- guide and schedule -------------------------------------------------------------------


@pytest.fixture
def guide(tmp_path, catalog, provider):
    g = sports.Guide(
        tmp_path / "live",
        catalog,
        ["https://guides.example/uk.xml.gz"],
        client=httpx.Client(transport=httpx.MockTransport(provider)),
    )
    g.refresh()
    return g


def test_guide_matches_channels_by_name_and_country(guide, catalog):
    by_name = {c["name"]: c["id"] for c in catalog.channels}
    programmes = guide.data["programmes"]
    assert by_name["UK: SKY SPORTS PREMIER LEAGUE HD"] in programmes
    assert by_name["4K BEIN SPORTS 1"] in programmes
    assert by_name["DE : Sky Sport 1 HD"] in programmes
    assert by_name["US: Sky Sports Main Event"] not in programmes  # a UK guide, a US channel
    now = guide.now(by_name["UK: SKY SPORTS PREMIER LEAGUE HD"], KICKOFF)
    assert now["title"] == "Live Premier League"


def test_failed_guides_never_reveal_the_provider_password(guide):
    failed = [s for s in guide.data["sources"] if not s["ok"]]
    assert failed and "xmltv.php" in failed[0]["url"]
    assert PASSWORD not in json.dumps(guide.data["sources"])


def test_schedule_puts_matches_on_the_channels_that_show_them(guide, catalog, provider):
    fixtures = sports.Fixtures(
        client=httpx.Client(transport=httpx.MockTransport(provider)),
        leagues=[("soccer/eng.1", "premier-league", 2)],
    )
    day = KICKOFF - KICKOFF % 86400
    events = sports.schedule(guide, fixtures, catalog, day, day + 86400, "English", now=NOW)
    match = next(e for e in events if e["source"] == "fixtures")
    assert match["title"] == "Arsenal v Chelsea" and match["state"] == "live"
    assert [t["score"] for t in match["teams"]] == ["1", "0"]
    confirmed = [c["name"] for c in match["channels"] if c["source"] == "guide"]
    assert set(confirmed) == {"UK: SKY SPORTS PREMIER LEAGUE HD", "4K BEIN SPORTS 1"}
    assert confirmed[0] == "UK: SKY SPORTS PREMIER LEAGUE HD"  # English first, as asked
    maybe = [c["name"] for c in match["channels"] if c["source"] == "competition"]
    assert "UK: SKY SPORTS PREMIER LEAGUE HD" not in maybe  # never listed twice
    # The guide's other live programme becomes an event of its own; highlights do not.
    motogp = next(e for e in events if e["source"] == "guide")
    assert motogp["title"] == "MotoGP" and motogp["sport"] == "Motorsport"
    assert [c["name"] for c in motogp["channels"]] == ["UK: SKY SPORTS MAIN EVENT UHD"]
    assert not any("Highlights" in e["title"] for e in events)
    # Cached fixtures survive the request (it used to edit them in place)
    again = sports.schedule(guide, fixtures, catalog, day, day + 86400, "", now=NOW)
    assert len(again) == len(events)


# ---- live streams -----------------------------------------------------------------------


@pytest.fixture(scope="module")
def broadcast(tmp_path_factory):
    """Two channels served over HTTP: progressive H.264 + MP2 (like most IPTV), and an
    interlaced one."""
    if not shutil.which("ffmpeg"):
        pytest.skip("FFmpeg is not installed")
    folder = tmp_path_factory.mktemp("broadcast")
    common = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
              "testsrc2=size=640x360:rate=25:duration=40", "-f", "lavfi", "-i",
              "sine=frequency=500:duration=40"]  # fmt: skip
    subprocess.run(
        [*common, "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-c:a", "mp2",
         "-f", "mpegts", str(folder / "1.ts")],
        check=True, timeout=120,
    )  # fmt: skip
    subprocess.run(
        [*common, "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-flags",
         "+ilme+ildct", "-top", "1", "-c:a", "aac", "-f", "mpegts", str(folder / "2.ts")],
        check=True, timeout=120,
    )  # fmt: skip
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(folder))
    handler.log_message = lambda *a: None
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


@pytest.fixture
def streams(tmp_path, broadcast):
    (tmp_path / "live").mkdir()
    channels = [
        live.describe("Plain Sports", "UK| SPORTS", f"{broadcast}/1.ts"),
        live.describe("Interlaced Sports", "UK| SPORTS", f"{broadcast}/2.ts"),
    ]
    catalog = live.Catalog(tmp_path / "live")
    catalog.replace(channels, "test")
    s = live.Streams(catalog, "ffmpeg", "ffprobe", tmp_path / "rt")
    yield s, channels
    s.stop_all()


@needs_ffmpeg
def test_one_stream_per_channel_shared_and_limited(streams):
    s, (plain, interlaced) = streams
    a = s.watch(plain["id"], "1:tv")
    assert a.video == "copy" and s.wait_ready(a, 30)
    assert "#EXTINF" in (a.dir / "index.m3u8").read_text()
    b = s.watch(plain["id"], "2:phone")  # someone else joins: same FFmpeg
    assert b is a and len(a.viewers) == 2
    with pytest.raises(live.Busy, match="1 channel at a time"):
        s.watch(interlaced["id"], "2:phone")  # the one provider connection is taken
    s.leave(a.id, "2:phone")
    s.leave(a.id, "1:tv")
    assert not s.items  # nobody left: stopped, connection freed
    assert not a.dir.exists()


@needs_ffmpeg
def test_switching_channel_frees_your_old_one(streams):
    s, (plain, interlaced) = streams
    s.catalog.set_max_connections(1)
    first = s.watch(plain["id"], "1:tv")
    second = s.watch(interlaced["id"], "1:tv")
    assert first.id not in s.items and second.id in s.items


@needs_ffmpeg
def test_interlaced_broadcasts_become_smooth_progressive_video(streams):
    s, (_, interlaced) = streams
    stream = s.watch(interlaced["id"], "1:web")
    assert stream.interlaced and stream.video == "encode"
    assert s.wait_ready(stream, 40)
    segment = min(stream.dir.glob("seg*.ts"))
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=field_order,avg_frame_rate", "-of", "csv=p=0", str(segment)],
        capture_output=True, text=True, check=True,
    ).stdout  # fmt: skip
    assert "progressive" in out and "50/1" in out  # one picture per field
    s.leave(stream.id, "1:web")
    tv = s.watch(interlaced["id"], "1:tv", deinterlaces=True)  # TVs do it themselves
    assert tv.video == "copy"


@needs_ffmpeg
def test_idle_viewers_are_dropped(streams):
    s, (plain, _) = streams
    stream = s.watch(plain["id"], "1:web")
    stream.viewers["1:web"] = time.time() - 120
    assert s.cleanup() == 1 and not s.items


# ---- the HTTP API -------------------------------------------------------------------------


@pytest.fixture
def server(tmp_path, provider):
    transport = httpx.MockTransport(provider)
    config = Config(
        database=tmp_path / "data" / "db.sqlite",
        runtime=tmp_path / "runtime",
        admin_email=ADMIN["email"],
        admin_password=ADMIN["password"],
        metadata_online=False,
        online_anime=False,
        scan_interval=0,
        live_guides=["https://guides.example/uk.xml.gz"],
    )
    app = create_app(
        config,
        background=False,
        live_clients=(httpx.Client(transport=transport), httpx.Client(transport=transport)),
    )
    with TestClient(app) as client:
        assert client.post("/api/login", json=ADMIN).status_code == 200
        yield client, app


def test_api_import_browse_and_schedule(server):
    client, app = server
    assert client.get("/api/live").json()["channels"] == 0
    r = client.post(
        "/api/admin/live/xtream", json={"server": SERVER, "username": USER, "password": PASSWORD}
    )
    assert r.json() == {"channels": 5}
    deadline = time.time() + 10  # importing refreshes the guides in the background
    while not app.state.guide.data["programmes"] and time.time() < deadline:
        time.sleep(0.05)
    status = client.get("/api/live").json()
    assert status["channels"] == 5 and status["max_connections"] == 1
    channels = client.get("/api/live/channels?q=premier").json()["channels"]
    assert channels[0]["now"]["title"] == "Live Premier League"
    day = KICKOFF - KICKOFF % 86400
    events = client.get(f"/api/live/schedule?start={day}&end={day + 86400}").json()["events"]
    assert any(e["title"] == "MotoGP" for e in events)
    admin = client.get("/api/admin/live").json()
    assert admin["account"]["active"] and admin["channels"] == 5
    # Nothing a browser receives carries the provider's login
    for body in (status, channels, events, admin):
        assert PASSWORD not in json.dumps(body)
    assert client.get(f"/api/live/schedule?start={day}&end={day + 10 * 86400}").status_code == 400


def test_api_members_cannot_import(server):
    client, _ = server
    client.post(
        "/api/admin/users",
        json={"email": "kid@example.test", "name": "Kid", "password": "another long pw"},
    )
    client.post("/api/logout")
    client.post("/api/login", json={"email": "kid@example.test", "password": "another long pw"})
    r = client.post(
        "/api/admin/live/xtream", json={"server": SERVER, "username": "x", "password": "y"}
    )
    assert r.status_code == 403


@needs_ffmpeg
def test_api_watch_plays_and_leaves(server, broadcast):
    client, app = server
    channels = [live.describe("Plain Sports", "UK| SPORTS", f"{broadcast}/1.ts")]
    app.state.live.replace(channels, "test")
    r = client.post("/api/live/watch", json={"channel_id": channels[0]["id"], "client": "t"})
    assert r.status_code == 200, r.text
    info = r.json()
    assert info["mode"] == "live" and info["live"]["channel"]["name"] == "Plain Sports"
    assert broadcast not in json.dumps(info)  # the channel's address stays on the server
    playlist = client.get(info["url"]).text
    segment = next(line for line in playlist.splitlines() if line.startswith("seg"))
    stream_id = info["live"]["stream"]
    assert client.get(f"/api/live/stream/{stream_id}/{segment}").status_code == 200
    assert client.get(f"/api/live/stream/{stream_id}/../catalog.json").status_code == 404
    assert (
        client.post(f"/api/live/streams/{stream_id}/ping", json={"client": "t"}).status_code == 200
    )
    client.delete(f"/api/live/streams/{stream_id}?client=t")
    assert not app.state.streams.items


def test_live_tv_can_be_turned_off(tmp_path):
    config = Config(
        database=tmp_path / "db.sqlite", runtime=tmp_path / "rt", metadata_online=False,
        admin_email=ADMIN["email"], admin_password=ADMIN["password"], live_tv=False,
    )  # fmt: skip
    with TestClient(create_app(config, background=False)) as client:
        client.post("/api/login", json=ADMIN)
        assert client.get("/api/live").json() == {"enabled": False}
        assert client.get("/api/live/channels").status_code == 404


def test_config_from_env(tmp_path):
    config = Config.from_env(
        {"LIVE_TV": "false", "LIVE_TV_DIR": str(tmp_path), "LIVE_GUIDES": "https://a, https://b"}
    )
    assert config.live_tv is False and config.live_dir == Path(tmp_path).resolve()
    assert config.live_guides == ["https://a", "https://b"]
    assert Config.from_env({}).live_guides is None
