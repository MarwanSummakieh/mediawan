"""Library downloads of TV seasons and movies (downloads.py) against the fake torrent engine."""

import httpx
import pytest
from fastapi.testclient import TestClient

from mediawan.app import create_app
from mediawan.config import Config
from mediawan.downloads import DownloadError, Downloads, safe_name
from mediawan.parse import parse_path

from .test_torrent import FILM, SHOW, FakeSidecar, GiB, MiB, make, release

SIZE = 4096


class SavingSidecar(FakeSidecar):
    """The fake engine, plus what downloads need: a file that completes, and unselecting."""

    def __init__(self, *args, **kw):
        super().__init__(*args, **kw)
        self.unselected, self.downloading = [], set()

    def mode(self, info_hash, index, mode):
        super().mode(info_hash, index, mode)
        if mode == "download":
            self.downloading.add(info_hash)

    def status(self, info_hash):
        status = super().status(info_hash)
        for sel in status["selected"]:
            sel.update(downloaded=SIZE, complete=True)
        return status

    def remove(self, info_hash):  # like torrentd: a file being downloaded outlives the stream
        if info_hash not in self.downloading:
            super().remove(info_hash)

    def unselect(self, info_hash, index):
        self.unselected.append((info_hash, index))
        self.downloading.discard(info_hash)
        super().remove(info_hash)


def pack(title, season, episode):
    """One season pack: the same torrent for every episode, a file each."""
    name = f"{title['name']}.S{season:02d}E{episode:02d}.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb"
    return [release("p", name, seeders=80, size=3 * 1024 * MiB, file_index=episode - 1)]


def movie_releases(title, season, episode):
    """Both 1080p and 4K releases for a film."""
    return [
        release("f", f"{title['name']}.{title['year']}.2160p.AMZN.WEB-DL.DDP5.1.H.265-NTb",
                seeders=90, size=18 * GiB, resolution=2160),
        release("m", f"{title['name']}.{title['year']}.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb",
                seeders=70, size=8 * GiB, resolution=1080),
    ]  # fmt: skip


def setup(tmp_path, listing=pack, title=SHOW, root="TV", movie_root="Movies"):
    swarms = {
        h * 40: {"metadata": 0.02, "size": SIZE}
        for h in ("p", "d", "f", "m")
    }
    torrents, sidecar, db = make(tmp_path, listing, swarms)
    saving = SavingSidecar(sidecar.swarms)
    torrents.sidecar = saving
    db.run("INSERT INTO users(id, email, name, pw_hash, role) VALUES(1, 'a@test', 'A', 'x', 'admin')")
    copies = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b"v" * SIZE)))
    downloads = Downloads(
        db,
        torrents,
        tmp_path / root if root else None,
        title_of=lambda kind, imdb_id: title,
        poll=0.02,
        client=copies,
        background=False,
        movie_root=tmp_path / movie_root if movie_root else None,
    )
    return downloads, saving, db


def run_all(downloads, db):
    while True:
        job = db.one("SELECT * FROM downloads WHERE state='queued' ORDER BY season, episode LIMIT 1")
        if not job:
            return
        downloads.run_one(job)


def test_a_season_lands_in_the_library_one_file_per_episode(tmp_path):
    downloads, sidecar, db = setup(tmp_path)
    asked = downloads.request_season(1, SHOW, 1)
    assert (asked["queued"], asked["skipped"], asked["label"]) == (3, 0, "1080p")
    run_all(downloads, db)
    jobs = downloads.list()
    assert [j["state"] for j in jobs] == ["done"] * 3, [j["error"] for j in jobs]
    folder = tmp_path / "TV" / "Show (2018)" / "Season 01"
    assert sorted(p.name for p in folder.iterdir()) == [f"Show - S01E0{e}.mkv" for e in (1, 2, 3)]
    assert (folder / "Show - S01E02.mkv").read_bytes() == b"v" * SIZE
    assert ("p" * 40, "download") in sidecar.modes and len(sidecar.unselected) == 3
    assert jobs[0]["release"]["group"] == "NTB" and jobs[0]["release"]["trusted"] is True
    # The scanner reads it back as the right show and episode.
    parsed = parse_path(folder / "Show - S01E02.mkv", tmp_path / "TV")
    assert (parsed.season, parsed.episode) == (1, 2)
    # Asking again queues nothing: every episode is done.
    assert downloads.request_season(1, SHOW, 1)["queued"] == 0


def test_an_older_sitcom_downloads_at_its_lower_quality(tmp_path):
    sitcom = {**SHOW, "id": "tt7", "name": "Sitcom", "year": 1993, "release_info": "1993–2004", "runtime": "22 min",
              "episodes": [{"season": 1, "episode": e, "name": f"E{e}"} for e in (1, 2)]}  # fmt: skip

    def dvd(title, season, episode):
        name = f"Sitcom.S{season:02d}E{episode:02d}.DVDRip.x264-GRP"
        return [release("d", name, seeders=60, size=280 * MiB, resolution=None, file_index=episode - 1),
                # A revival of the same name, labelled with a year the series never ran: refused.
                release("r", f"Sitcom 2026 S{season:02d}E{episode:02d} 1080p DSNP WEB-DL DDP5 1 H 264-NTb",
                        seeders=500, size=1100 * MiB)]  # fmt: skip

    downloads, _, db = setup(tmp_path, dvd, sitcom)
    asked = downloads.request_season(1, sitcom, 1)
    assert (asked["queued"], asked["label"]) == (2, "SD")
    run_all(downloads, db)
    jobs = downloads.list()
    assert [j["state"] for j in jobs] == ["done", "done"], [j["error"] for j in jobs]
    assert all(j["quality"] == 480 for j in jobs)
    assert (tmp_path / "TV" / "Sitcom (1993)" / "Season 01" / "Sitcom - S01E01.mkv").exists()


def test_an_existing_show_folder_is_reused(tmp_path):
    downloads, _, db = setup(tmp_path)
    (tmp_path / "TV" / "Show").mkdir(parents=True)
    downloads.request_season(1, SHOW, 1)
    run_all(downloads, db)
    assert (tmp_path / "TV" / "Show" / "Season 01" / "Show - S01E01.mkv").exists()
    assert not (tmp_path / "TV" / "Show (2018)").exists()


def test_only_tv_shows_and_only_when_switched_on(tmp_path):
    downloads, _, _ = setup(tmp_path)
    with pytest.raises(DownloadError, match="Only TV shows"):
        downloads.request_season(1, FILM, 0)
    with pytest.raises(DownloadError, match="no aired episodes"):
        downloads.request_season(1, SHOW, 9)
    off, _, _ = setup(tmp_path / "off", root=None)
    with pytest.raises(DownloadError, match="DOWNLOAD_DIR"):
        off.request_season(1, SHOW, 1)


def test_cancel_retry_and_remove(tmp_path):
    downloads, _, db = setup(tmp_path)
    downloads.request_season(1, SHOW, 1)
    first = downloads.list()[-1]["id"]
    downloads.cancel(first)
    assert db.one("SELECT state FROM downloads WHERE id=?", first)["state"] == "cancelled"
    downloads.retry(first)
    assert db.one("SELECT state FROM downloads WHERE id=?", first)["state"] == "queued"
    run_all(downloads, db)
    downloads.cancel(first)  # a finished one is removed from the list; the file stays
    assert db.one("SELECT id FROM downloads WHERE id=?", first) is None
    assert (tmp_path / "TV" / "Show (2018)" / "Season 01" / "Show - S01E01.mkv").exists()


def test_names_are_safe_for_any_filesystem():
    assert safe_name('Marvel\'s Agents of S.H.I.E.L.D.: "Part" 2/3') == "Marvel's Agents of S.H.I.E.L.D. Part 2 3"
    assert safe_name("...") == "Untitled"


def test_a_movie_lands_in_the_library_at_default_and_chosen_quality(tmp_path):
    downloads, sidecar, db = setup(tmp_path, movie_releases, FILM)
    asked = downloads.request_movie(1, FILM)
    assert (asked["queued"], asked["skipped"], asked["quality"], asked["label"]) == (1, 0, 2160, "4K")
    run_all(downloads, db)
    jobs = downloads.list()
    assert len(jobs) == 1
    assert jobs[0]["state"] == "done", jobs[0]["error"]
    assert jobs[0]["kind"] == "movie"
    dest = tmp_path / "Movies" / "Film (2026)" / "Film (2026).mkv"
    assert dest.exists() and dest.read_bytes() == b"v" * SIZE
    assert ("f" * 40, "download") in sidecar.modes and len(sidecar.unselected) == 1
    parsed = parse_path(dest, tmp_path / "Movies")
    assert (parsed.kind, parsed.name, parsed.year) == ("movie", "Film", 2026)
    # Asking again queues nothing: already done.
    assert downloads.request_movie(1, FILM)["queued"] == 0

    # Explicit 1080p quality on another movie uses the 1080p release.
    other = {**FILM, "id": "tt0000009", "name": "Other Film", "year": 2024}
    downloads.title_of = lambda kind, imdb_id: other
    asked1080 = downloads.request_movie(1, other, quality=1080)
    assert (asked1080["queued"], asked1080["quality"], asked1080["label"]) == (1, 1080, "1080p")
    run_all(downloads, db)
    assert (tmp_path / "Movies" / "Other Film (2024)" / "Other Film (2024).mkv").exists()
    assert ("m" * 40, "download") in sidecar.modes


def test_movie_folder_reuse_respects_year_for_remakes(tmp_path):
    downloads, _, db = setup(tmp_path, movie_releases, FILM)
    # A remake with a different year must NOT be reused.
    (tmp_path / "Movies" / "Film (1990)").mkdir(parents=True)
    downloads.request_movie(1, FILM, quality=1080)
    run_all(downloads, db)
    assert (tmp_path / "Movies" / "Film (2026)" / "Film (2026).mkv").exists()
    assert not list((tmp_path / "Movies" / "Film (1990)").iterdir())

    # An existing folder without a year IS reused.
    other = {**FILM, "id": "tt0000010", "name": "Heat", "year": 1995}
    downloads.title_of = lambda kind, imdb_id: other
    (tmp_path / "Movies" / "Heat").mkdir(parents=True)
    downloads.request_movie(1, other, quality=1080)
    run_all(downloads, db)
    assert (tmp_path / "Movies" / "Heat" / "Heat (1995).mkv").exists()
    assert not (tmp_path / "Movies" / "Heat (1995)").exists()


def test_movie_downloads_check_config_kind_and_existing_library(tmp_path):
    downloads, _, db = setup(tmp_path, movie_releases, FILM)
    with pytest.raises(DownloadError, match="Only movies"):
        downloads.request_movie(1, SHOW)
    # Already in the library -> skipped without queueing.
    tid = db.run("INSERT INTO titles(kind, key, name, year, imdb_id, added_at) VALUES('movie','movie:film:2026','Film',2026,'tt0000001',1)")
    iid = db.run("INSERT INTO items(title_id, season, episode) VALUES(?,0,0)", tid)
    db.run("INSERT INTO files(item_id, path, root, size, mtime, added_at, missing) VALUES(?,'/m/film.mkv','/m',1,1,1,0)", iid)
    assert downloads.request_movie(1, FILM) == {"queued": 0, "skipped": 1, "quality": 0, "label": ""}

    # MOVIE_DOWNLOAD_DIR unset disables movie downloads without disabling TV shows.
    tv_only, _, _ = setup(tmp_path / "tv_only", movie_root=None)
    assert tv_only.enabled and tv_only.can_download("show") and not tv_only.can_download("movie")
    with pytest.raises(DownloadError, match="MOVIE_DOWNLOAD_DIR"):
        tv_only.request_movie(1, FILM)

    # DOWNLOAD_DIR unset disables TV shows without disabling movie downloads.
    movies_only, _, _ = setup(tmp_path / "movies_only", movie_releases, FILM, root=None)
    assert movies_only.enabled and movies_only.can_download("movie") and not movies_only.can_download("show")
    with pytest.raises(DownloadError, match="DOWNLOAD_DIR"):
        movies_only.request_season(1, SHOW, 1)


def test_movie_download_api_routes(tmp_path):
    torrents, sidecar, _ = make(
        tmp_path / "t",
        movie_releases,
        {h * 40: {"metadata": 0.02, "size": SIZE} for h in ("f", "m")},
    )
    torrents.sidecar = SavingSidecar(sidecar.swarms)
    cinemeta = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                json={"meta": {"id": FILM["id"], "type": "movie", "name": FILM["name"], "releaseInfo": "2026", "runtime": "120 min"}},
            )
        )
    )
    cfg = Config(
        database=tmp_path / "app.sqlite",
        runtime=tmp_path / "rt",
        admin_email="admin@test",
        admin_password="long-password-1",
        download_dir=tmp_path / "TV",
        movie_download_dir=tmp_path / "Movies",
        online_anime=False,
    )
    app = create_app(cfg, http_client=cinemeta, torrents=torrents, background=False)
    with TestClient(app) as client:
        torrents.db = app.state.db
        assert client.post("/api/login", json={"email": "admin@test", "password": "long-password-1"}).status_code == 200
        title_resp = client.get(f"/api/watch/title/movie/{FILM['id']}")
        assert title_resp.status_code == 200
        assert title_resp.json()["can_download"] is True

        resp = client.post("/api/downloads/movie", json={"kind": "movie", "id": FILM["id"], "quality": 1080})
        assert resp.status_code == 200
        assert resp.json() == {"queued": 1, "skipped": 0, "quality": 1080, "label": "1080p"}

        listing = client.get("/api/downloads").json()
        assert listing["enabled"] is True
        assert len(listing["jobs"]) == 1 and listing["jobs"][0]["kind"] == "movie"

        # Non-movie kind is rejected.
        bad = client.post("/api/downloads/movie", json={"kind": "show", "id": FILM["id"]})
        assert bad.status_code == 400
