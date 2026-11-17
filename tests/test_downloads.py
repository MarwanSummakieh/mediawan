"""Season downloads of TV shows (downloads.py) against the fake torrent engine."""

import httpx
import pytest

from mediawan.downloads import DownloadError, Downloads, safe_name
from mediawan.parse import parse_path

from .test_torrent import FILM, SHOW, FakeSidecar, MiB, make, release

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


def setup(tmp_path, listing=pack, title=SHOW, root="TV"):
    torrents, sidecar, db = make(tmp_path, listing, {"p" * 40: {"metadata": 0.02, "size": SIZE}, "d" * 40: {"metadata": 0.02, "size": SIZE}})
    saving = SavingSidecar(sidecar.swarms)
    torrents.sidecar = saving
    db.run("INSERT INTO users(id, email, name, pw_hash, role) VALUES(1, 'a@test', 'A', 'x', 'admin')")
    copies = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b"v" * SIZE)))
    downloads = Downloads(db, torrents, tmp_path / root if root else None, title_of=lambda imdb_id: title,
                          poll=0.02, client=copies, background=False)  # fmt: skip
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
