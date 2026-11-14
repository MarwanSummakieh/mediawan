import os
import shutil
from pathlib import Path

import pytest

from mediawan.db import Database
from mediawan.scanner import Scanner


def touch(path: Path, data: bytes = b"x" * 64) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


@pytest.fixture
def library(tmp_path):
    movies, tv = tmp_path / "Movies", tmp_path / "TV"
    touch(movies / "Heat (1995)" / "Heat.1995.1080p.mkv")
    touch(
        movies / "Heat (1995)" / "Heat.1995.1080p.en.srt", b"1\n00:00:01,000 --> 00:00:02,000\nHi\n"
    )
    touch(movies / "Heat (1995)" / "Heat.1995.2160p.mkv", b"y" * 128)  # second copy, same item
    touch(movies / "Heat (1995)" / "Extras" / "Making of.mkv")
    touch(movies / "Alien.1979.mp4")
    touch(tv / "The Office" / "Season 01" / "The.Office.S01E01.mkv")
    touch(tv / "The Office" / "Season 01" / "The.Office.S01E02.mkv")
    touch(tv / "Frieren" / "[Sub] Frieren - 01 [1080p].mkv")
    touch(tv / "@eaDir" / "The.Office.S01E01.mkv")  # NAS thumbnail folder
    touch(tv / "loose clip.mp4")  # cannot be placed
    db = Database(":memory:")
    return tmp_path, db, Scanner(db, [movies, tv])


def test_scan_builds_titles_items_files(library):
    _, db, scanner = library
    stats = scanner.scan()
    assert stats["added"] == 6 and stats["errors"] == []
    titles = {(t["kind"], t["name"], t["year"]) for t in db.all("SELECT * FROM titles")}
    assert titles == {
        ("movie", "Heat", 1995),
        ("movie", "Alien", 1979),
        ("show", "The Office", None),
        ("show", "Frieren", None),
    }
    heat = db.one("SELECT id FROM titles WHERE name='Heat'")["id"]
    items = db.all("SELECT * FROM items WHERE title_id=?", heat)
    assert len(items) == 1
    assert db.one("SELECT COUNT(*) n FROM files WHERE item_id=?", items[0]["id"])["n"] == 2
    assert db.one("SELECT numbering FROM titles WHERE name='Frieren'")["numbering"] == "absolute"
    subs = db.all("SELECT * FROM subtitles")
    assert len(subs) == 1 and subs[0]["lang"] == "en"
    unmatched = db.all("SELECT * FROM unmatched")
    assert [Path(u["path"]).name for u in unmatched] == ["loose clip.mp4"]


def test_rescan_is_idempotent_and_tracks_changes(library):
    root, db, scanner = library
    scanner.scan()
    again = scanner.scan()
    assert again["added"] == 0 and again["updated"] == 0 and again["missing"] == 0
    # A file disappears, then comes back
    episode = root / "TV" / "The Office" / "Season 01" / "The.Office.S01E02.mkv"
    moved = episode.with_suffix(".bak")
    episode.rename(moved)
    assert scanner.scan()["missing"] == 1
    assert db.one("SELECT missing FROM files WHERE path LIKE '%S01E02.mkv'")["missing"] == 1
    moved.rename(episode)
    scanner.scan()
    assert db.one("SELECT missing FROM files WHERE path LIKE '%S01E02.mkv'")["missing"] == 0
    # A file is replaced with a new version: size changes, probe is cleared for re-probing
    db.run("UPDATE files SET probe='{}' WHERE path LIKE '%S01E01.mkv'")
    touch(root / "TV" / "The Office" / "Season 01" / "The.Office.S01E01.mkv", b"z" * 300)
    assert scanner.scan()["updated"] == 1
    assert db.one("SELECT probe FROM files WHERE path LIKE '%S01E01.mkv'")["probe"] is None


def test_unmounted_root_never_marks_everything_missing(library):
    root, db, scanner = library
    scanner.scan()
    shutil.rmtree(root / "Movies")
    (root / "Movies").mkdir()  # an empty mount point
    stats = scanner.scan()
    assert stats["missing"] == 0 and "unavailable" in stats["errors"][0]
    assert db.one("SELECT COUNT(*) n FROM files WHERE missing=1")["n"] == 0


def test_symlinks_cannot_escape_the_library(tmp_path):
    lib, outside = tmp_path / "lib", tmp_path / "outside"
    touch(lib / "Inside (2000)" / "Inside.2000.mkv")
    secret = touch(outside / "Secret (2001)" / "Secret.2001.mkv")
    try:
        os.symlink(secret, lib / "Linked.2001.mkv")
        os.symlink(outside, lib / "linked-folder", target_is_directory=True)
        os.symlink(lib / "Inside (2000)", lib / "Inside Again (2000)", target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("This system does not allow creating symlinks")
    db = Database(":memory:")
    stats = Scanner(db, [lib]).scan()
    assert stats["refused"] == 2
    paths = [r["path"] for r in db.all("SELECT path FROM files")]
    assert len(paths) == 1 and "Inside.2000.mkv" in paths[0]  # the in-library link is deduplicated


@pytest.mark.skipif(os.name != "nt", reason="Windows directory junctions")
def test_junctions_cannot_escape_the_library(tmp_path):
    import _winapi

    lib, outside = tmp_path / "lib", tmp_path / "outside"
    touch(lib / "Inside (2000)" / "Inside.2000.mkv")
    touch(outside / "Secret (2001)" / "Secret.2001.mkv")
    _winapi.CreateJunction(str(outside), str(lib / "linked-folder"))
    db = Database(":memory:")
    assert Scanner(db, [lib]).scan()["refused"] == 1
    assert db.one("SELECT COUNT(*) n FROM files")["n"] == 1


def test_admin_placement_survives_rescans(library):
    _root, db, scanner = library
    scanner.scan()
    row = db.one("SELECT * FROM unmatched")
    scanner.assign(row["path"], {"kind": "show", "name": "Loose Show", "season": 1, "episode": 3})
    assert db.one("SELECT COUNT(*) n FROM unmatched")["n"] == 0
    scanner.scan()
    title = db.one("SELECT * FROM titles WHERE name='Loose Show'")
    assert (
        title and db.one("SELECT episode FROM items WHERE title_id=?", title["id"])["episode"] == 3
    )
    # Moving a matched file to another title prunes the now-empty old title
    alien = db.one(
        "SELECT f.path FROM files f JOIN items i ON i.id=f.item_id "
        "JOIN titles t ON t.id=i.title_id WHERE t.name='Alien'"
    )["path"]
    scanner.assign(alien, {"kind": "movie", "name": "Aliens", "year": 1986})
    assert db.one("SELECT id FROM titles WHERE name='Alien'") is None
    scanner.scan()
    assert db.one("SELECT id FROM titles WHERE name='Aliens'")
    with pytest.raises(ValueError):
        scanner.assign(alien, {"kind": "show", "name": "No episode"})


def test_probe_pending_records_failures(library):
    _, db, scanner = library
    scanner.prober = lambda path: (_ for _ in ()).throw(RuntimeError("not a video"))
    stats = scanner.scan()
    assert stats["probed"] == 6
    assert "not a video" in db.one("SELECT probe FROM files LIMIT 1")["probe"]
