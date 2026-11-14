import json
import time

import httpx
import pytest

from mediawan.db import Database
from mediawan.metadata import Metadata, score

HEAT = {
    "id": "tt0113277",
    "type": "movie",
    "name": "Heat",
    "releaseInfo": "1995",
    "poster": "https://img.test/heat.jpg",
    "background": "https://img.test/heat-bg.jpg",
    "description": "A group of professional bank robbers…",
    "genres": ["Crime", "Drama"],
    "runtime": "170 min",
    "imdbRating": "8.3",
}
HEAT_1986 = {"id": "tt0093164", "type": "movie", "name": "Heat", "releaseInfo": "1986"}
FRIEREN = {
    "id": "tt22248376",
    "type": "series",
    "name": "Frieren: Beyond Journey's End",
    "releaseInfo": "2023-",
    "poster": "https://img.test/frieren.jpg",
    "videos": [
        {
            "season": 1,
            "episode": e,
            "name": f"S1 ep {e}",
            "released": "2023-09-29T00:00:00Z",
            "thumbnail": f"https://img.test/f{e}.jpg",
        }
        for e in (1, 2, 3)
    ]
    + [
        {"season": 2, "episode": 1, "name": "S2 premiere"},
        {"season": 0, "episode": 1, "name": "Special"},
    ],
}


def cinemeta(calls: list):
    def handler(request: httpx.Request):
        path = request.url.path
        calls.append(path)
        if "search=" in path:
            query = path.split("search=")[1].removesuffix(".json").lower()
            pool = [HEAT_1986, HEAT] if "heat" in query else [FRIEREN] if "frieren" in query else []
            return httpx.Response(200, json={"metas": pool})
        if path.endswith("/tt0113277.json"):
            return httpx.Response(200, json={"meta": HEAT})
        if path.endswith("/tt0093164.json"):
            return httpx.Response(200, json={"meta": {**HEAT_1986, "description": "Burt Reynolds"}})
        if path.endswith("/tt22248376.json"):
            return httpx.Response(200, json={"meta": FRIEREN})
        if path.endswith(".jpg"):
            return httpx.Response(
                200, content=b"\xff\xd8\xffjpeg", headers={"content-type": "image/jpeg"}
            )
        return httpx.Response(404)

    return handler


@pytest.fixture
def setup(tmp_path):
    db = Database(":memory:")
    now = int(time.time())
    db.run(
        "INSERT INTO titles(id, kind, key, name, year, added_at) VALUES(1,'movie','movie:heat:1995','Heat',1995,?)",
        now,
    )
    db.run(
        "INSERT INTO titles(id, kind, key, name, numbering, added_at) VALUES(2,'show','show:frieren:','Frieren','absolute',?)",
        now,
    )
    for e in (1, 2, 3, 4, 5):
        db.run("INSERT INTO items(title_id, season, episode) VALUES(2,1,?)", e)
    calls = []
    client = httpx.Client(transport=httpx.MockTransport(cinemeta(calls)))
    meta = Metadata(db, "https://cinemeta.test", True, tmp_path / "art", client=client)
    return db, meta, calls


def test_score_prefers_matching_year():
    assert score("Heat", 1995, HEAT) > score("Heat", 1995, HEAT_1986)
    assert score("Frieren", None, FRIEREN) < 0.85  # too different to auto-match


def test_refresh_matches_by_name_and_year(setup):
    db, meta, _ = setup
    assert meta.refresh_pending() == 2
    heat = db.one("SELECT * FROM titles WHERE id=1")
    assert heat["imdb_id"] == "tt0113277" and heat["matched"] == 1
    assert json.loads(heat["genres"]) == ["Crime", "Drama"] and heat["rating"] == "8.3"
    # "Frieren" vs "Frieren: Beyond Journey's End" is not confident enough to guess
    assert db.one("SELECT matched FROM titles WHERE id=2")["matched"] == -1
    assert meta.refresh_pending() == 0  # nothing stale yet


def test_admin_edits_stay_locked_across_refreshes(setup):
    db, meta, _ = setup
    meta.refresh(1)
    meta.edit(1, {"name": "Heat (Director's Definitive Edition)", "description": "My own words"})
    meta.refresh(1, force=True)
    heat = db.one("SELECT * FROM titles WHERE id=1")
    assert heat["name"] == "Heat (Director's Definitive Edition)"
    assert heat["description"] == "My own words"
    assert heat["poster"] == HEAT["poster"]  # unlocked fields still refresh
    meta.unlock(1, ["description"])
    meta.refresh(1)
    assert db.one("SELECT description FROM titles WHERE id=1")["description"] == HEAT["description"]


def test_admin_chooses_the_match_and_absolute_episodes_map(setup):
    db, meta, _ = setup
    meta.refresh(2)
    meta.edit(2, {"imdb_id": "tt22248376"})
    show = db.one("SELECT * FROM titles WHERE id=2")
    assert show["matched"] == 1 and show["name"] == FRIEREN["name"]
    names = [r["name"] for r in db.all("SELECT name FROM items WHERE title_id=2 ORDER BY episode")]
    # Absolute episode 4 is the first episode of season 2; specials are skipped; 5 is unknown
    assert names == ["S1 ep 1", "S1 ep 2", "S1 ep 3", "S2 premiere", None]
    assert db.one("SELECT aired FROM items WHERE episode=1")["aired"] == "2023-09-29"
    # The admin's match is locked: a forced refresh does not search again
    meta.refresh(2, force=True)
    assert db.one("SELECT imdb_id FROM titles WHERE id=2")["imdb_id"] == "tt22248376"
    with pytest.raises(ValueError):
        meta.edit(2, {"imdb_id": "not-an-id"})


def test_offline_mode_never_touches_the_network(setup, tmp_path):
    _db, meta, calls = setup
    meta.online = False
    assert meta.refresh_pending() == 0
    assert meta.refresh(1)["matched"] == 0
    assert meta.search("movie", "heat") == []
    assert meta.artwork("https://img.test/heat.jpg") is None
    assert calls == []


def test_artwork_is_cached(setup):
    _, meta, calls = setup
    first = meta.artwork("https://img.test/heat.jpg")
    assert first.read_bytes().startswith(b"\xff\xd8")
    meta.online = False
    assert meta.artwork("https://img.test/heat.jpg") == first  # served offline from cache
    assert calls.count("/heat.jpg") == 1


def test_network_failure_stops_the_batch_quietly(tmp_path):
    db = Database(":memory:")
    db.run("INSERT INTO titles(kind, key, name, added_at) VALUES('movie','movie:x:','X',0)")
    failing = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    meta = Metadata(db, "https://cinemeta.test", True, tmp_path, client=failing)
    assert meta.refresh_pending() == 0
    assert db.one("SELECT matched FROM titles")["matched"] == 0  # retried next run


def test_cast_and_crew_are_stored_and_shown_with_related_titles(setup):
    from mediawan.library import Library

    db, meta, _ = setup
    HEAT.update(cast=["Al Pacino", "Robert De Niro"], director=["Michael Mann"], writer=["Michael Mann"],
                country="United States", awards="15 nominations total", released="1995-12-15T00:00:00.000Z")
    try:
        meta.refresh(1)
    finally:
        for key in ("cast", "director", "writer", "country", "awards", "released"):
            HEAT.pop(key)
    now = int(time.time())
    db.run(
        "INSERT INTO titles(id, kind, key, name, genres, rating, added_at) "
        "VALUES(3,'movie','movie:thief:1981','Thief','[\"Crime\"]','7.4',?)",
        now,
    )
    for title_id in (1, 3):
        item = db.run("INSERT INTO items(title_id, season, episode) VALUES(?,0,0)", title_id)
        db.run(
            "INSERT INTO files(item_id, path, size, mtime, added_at) VALUES(?,?,1,0,?)",
            item, f"/m/{title_id}.mkv", now,
        )
    db.run("INSERT INTO users(id, email, name, pw_hash) VALUES(1,'a@b.c','A','x')")
    library = Library(db)
    heat = library.title(1, 1)
    assert heat["cast"] == ["Al Pacino", "Robert De Niro"] and heat["director"] == ["Michael Mann"]
    assert heat["country"] == "United States" and heat["released"] == "1995-12-15"
    assert "extra" not in heat
    assert [t["name"] for t in heat["related"]] == ["Thief"]  # shares the Crime genre
    assert library.title(1, 3)["cast"] == []  # never fetched: empty, not missing
    library.tag(1, 3, "watchlist", True)
    assert [t["id"] for t in library.titles(1, tag="watchlist")] == [3]


def test_titles_matched_before_cast_was_stored_are_fetched_again(setup):
    db, meta, _ = setup
    meta.refresh(1)
    assert json.loads(db.one("SELECT extra FROM titles WHERE id=1")["extra"])["v"] == 1
    db.run("UPDATE titles SET extra='{}' WHERE id=1")  # as after the upgrade
    assert meta.refresh_pending() == 2  # Heat again, and Frieren (never tried)
    assert meta.refresh_pending() == 0  # both done: no endless refetching
    assert db.one("SELECT extra FROM titles WHERE id=1")["extra"] != "{}"
