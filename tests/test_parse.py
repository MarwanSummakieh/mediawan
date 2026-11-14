from pathlib import PurePosixPath as P

import pytest

from mediawan.parse import Parsed, Unplaced, clean, parse_path, subtitle_info, title_key


@pytest.mark.parametrize(
    "root, path, expected",
    [
        ("/m/Movies", "Heat (1995)/Heat.1995.1080p.BluRay.x264.mkv", ("movie", "Heat", 1995, 0, 0)),
        ("/m/Lib", "Heat.1995.1080p.mkv", ("movie", "Heat", 1995, 0, 0)),
        (
            "/m/Lib",
            "2001.A.Space.Odyssey.1968.2160p.mkv",
            ("movie", "2001 A Space Odyssey", 1968, 0, 0),
        ),
        (
            "/m/Lib",
            "Blade Runner 2049 (2017)/Blade.Runner.2049.2017.mkv",
            ("movie", "Blade Runner 2049", 2017, 0, 0),
        ),
        ("/m/Lib", "Charlotte's Web (1973).mkv", ("movie", "Charlotte's Web", 1973, 0, 0)),
        ("/m/Movies", "1917.mkv", ("movie", "1917", None, 0, 0)),
        ("/m/Lib", "Heat (1995)/heat-1080p-remux.mkv", ("movie", "Heat", 1995, 0, 0)),
        # A title may start with a release word; it must not be stripped to nothing.
        (
            "/media",
            "Movies/Remux Clip (2021)/Remux.Clip.2021.720p.mkv",
            ("movie", "Remux Clip", 2021, 0, 0),
        ),
        # Category folders under a single root give the hint and are never a title.
        ("/media", "Movies/Arrival/Arrival.mkv", ("movie", "Arrival", None, 0, 0)),
        (
            "/media",
            "TV/Sample Show/Season 01/Sample.Show.S01E01.mkv",
            ("show", "Sample Show", None, 1, 1),
        ),
        ("/media", "The Truman Show (1998)/Truman.mkv", ("movie", "The Truman Show", 1998, 0, 0)),
        (
            "/m/TV",
            "The Office/Season 02/The.Office.S02E03.720p.mkv",
            ("show", "The Office", None, 2, 3),
        ),
        ("/m/TV", "Show/Show 1x04.mkv", ("show", "Show", None, 1, 4)),
        ("/m/Lib", "Show.Name.S01E01-E02.mkv", ("show", "Show Name", None, 1, 1)),
        (
            "/m/Lib",
            "Agents.of.S.H.I.E.L.D.S01E01.mkv",
            ("show", "Agents of S.H.I.E.L.D", None, 1, 1),
        ),
        (
            "/m/Lib",
            "Mr. Robot/Season 1/Mr. Robot - S01E02 - eps1.1.mkv",
            ("show", "Mr. Robot", None, 1, 2),
        ),
        ("/m/Lib", "Sherlock/Specials/Sherlock.S00E01.mkv", ("show", "Sherlock", None, 0, 1)),
        (
            "/m/Lib",
            "Doctor Who (2005)/Season 1/Doctor.Who.S01E01.mkv",
            ("show", "Doctor Who", 2005, 1, 1),
        ),
        (
            "/m/Anime",
            "[SubsPlease] Frieren - 05 (1080p) [ABCD1234].mkv",
            ("show", "Frieren", None, 1, 5),
        ),
        ("/m/Anime", "Frieren/[Grp] Frieren - 12v2 [1080p].mkv", ("show", "Frieren", None, 1, 12)),
        ("/m/Anime", "One Piece/One Piece - 1071.mkv", ("show", "One Piece", None, 1, 1071)),
        ("/m/Lib", "Show/Season 2/Show - 05.mkv", ("show", "Show", None, 2, 5)),
        ("/m/Anime", "[Group] Mushishi 07 [720p].mkv", ("show", "Mushishi", None, 1, 7)),
    ],
)
def test_parse(root, path, expected):
    result = parse_path(P(root) / path, P(root))
    assert isinstance(result, Parsed), result
    assert (result.kind, result.name, result.year, result.season, result.episode) == expected


def test_absolute_flag_only_without_season_folder():
    assert parse_path(P("/a/Anime/Show - 05.mkv"), P("/a/Anime")).absolute
    assert not parse_path(P("/a/Lib/Show/Season 2/Show - 05.mkv"), P("/a/Lib")).absolute


@pytest.mark.parametrize(
    "path",
    [
        "Heat (1995)/Extras/Making of.mkv",
        "Heat (1995)/heat-sample.mkv",
        "Heat (1995)/sample-heat.mkv",
        "Heat (1995)/Sample.mkv",
        "Heat (1995)/heat.trailer.mkv",
        "Movie (2001)/Trailers/t.mp4",
        "notes.txt",
        "cover.jpg",
    ],
)
def test_ignored(path):
    assert parse_path(P("/m/Lib") / path, P("/m/Lib")) is None


def test_unplaced_files_go_to_review():
    result = parse_path(P("/m/Lib/random.mkv"), P("/m/Lib"))
    assert isinstance(result, Unplaced)
    assert isinstance(parse_path(P("/m/TV/clip.mp4"), P("/m/TV")), Unplaced)


def test_episode_dash_year_is_not_an_episode():
    result = parse_path(P("/m/Lib/Heat - 1995.mkv"), P("/m/Lib"))
    assert (result.kind, result.year) == ("movie", 1995)


def test_clean_and_keys():
    assert clean("The.Matrix.1080p.BluRay.x264") == "The Matrix"
    assert clean("Mr. Robot") == "Mr. Robot"
    assert title_key("movie", "Amélie", 2001) == title_key("movie", "amelie", 2001)
    assert title_key("show", "Law & Order", None) == "show:law and order:"


def test_sidecar_subtitles():
    video = P("/m/Heat (1995)/Heat.1995.mkv")
    assert subtitle_info(P("/m/Heat (1995)/Heat.1995.en.srt"), video) == {
        "lang": "en",
        "forced": 0,
        "format": "srt",
    }
    assert subtitle_info(P("/m/Heat (1995)/Heat.1995.eng.forced.ass"), video)["forced"] == 1
    assert subtitle_info(P("/m/Heat (1995)/Heat.1995.French.vtt"), video)["lang"] == "fr"
    assert subtitle_info(P("/m/Heat (1995)/Other.srt"), video) is None
    assert subtitle_info(P("/m/Heat (1995)/Subs/2_English.srt"), video)["lang"] == "en"
