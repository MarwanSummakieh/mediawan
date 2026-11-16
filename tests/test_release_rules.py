"""The torrent release rules, ported with v2's own test cases (test/release-score.test.mjs)."""

from mediawan import release_rules as rr

GiB = rr.GiB
MiB = rr.MiB


def release(name, **extra):
    r = {
        "hash": (extra.pop("hash", "a") * 40)[:40],
        "file_index": None,
        "label": f"{name}\n👤 40 💾 4.0 GB",
        "name": "",
        "filename": f"{name}.mkv",
        "seeders": 40,
        "size": 4 * GiB,
        "resolution": 2160 if "2160p" in name else 1080,
    }
    r.update(extra)
    return r


def accepted(r, kind="movie", resolution=1080, **options):
    return rr.assess_stream(r, kind, resolution, **options)[0]


def reasons(r, kind="movie", resolution=1080, **options):
    return " | ".join(rr.assess_stream(r, kind, resolution, **options)[1])


def test_parse_torrentio_reads_seeders_size_resolution_trackers_and_file():
    data = {
        "streams": [
            {
                "name": "Torrentio\n4k HDR",
                "title": "Film 2026 2160p WEB-DL\n👤 199 💾 6.91 GB ⚙️ YTS",
                "infoHash": "C3DA9A3DC2CE14D0D4FC0E87D1B2023502F8DCD6",
                "fileIdx": 2,
                "behaviorHints": {"filename": "Film.2026.2160p.WEB-DL.mkv"},
                "sources": ["tracker:udp://tracker.example:1337/announce", "dht:abc", "tracker:bad"],
            },
            {"name": "x", "title": "no hash"},
        ]
    }
    [r] = rr.parse_torrentio(data)
    assert r["hash"] == "c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6"
    assert (r["seeders"], r["resolution"], r["file_index"]) == (199, 2160, 2)
    assert r["size"] == round(6.91 * GiB)
    assert r["trackers"] == ["udp://tracker.example:1337/announce"]
    assert rr.label_resolution("Torrentio\n4k DV") == 2160


def test_a_web_dl_label_does_not_hide_a_disc_rip_remux_or_capture_in_the_file_name():
    for name in [
        "Show.S01E01.1080p.BDMux.x264",
        "Show.S01E01.1080p.BluRay.x264",
        "Show.S01E01.1080p.WEBRip.x264",
        "Show.S01E01.1080p.REMUX",
        "Show.S01E01.1080p.HDRip",
    ]:
        conflict = rr.source_conflict({"label": "Show S01E01 1080p WEB-DL", "filename": f"{name}.mkv"})
        assert conflict and "not WEB-DL" in conflict, name
    assert "Release is BDMux" in rr.source_conflict({"label": "Show S01E01 1080p WEB-DL BDMux"})
    assert (
        rr.source_conflict(
            {
                "label": "Show.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-NTb\n👤 50 💾 3 GB ⚙️ ThePirateBay",
                "filename": "Show.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-NTb.mkv",
            }
        )
        is None
    )
    assert rr.source_conflict({"label": "Movie 2160p WEB-DL HDR DV"}) is None


def test_stream_assessment_keeps_every_rule_except_a_fixed_resolution():
    tv4k = release("Show.S01E01.2160p.AMZN.WEB-DL.DDP5.1.HDR.H.265-FLUX", size=9 * GiB)
    assert accepted(tv4k, "show", 2160)
    assert not accepted(tv4k, "show", 1080)
    movie1080 = release("Movie.2023.1080p.NF.WEB-DL.DDP5.1.H.264-FLUX", size=8 * GiB)
    assert accepted(movie1080, "movie", 1080)
    assert "Fewer than 5" in reasons({**movie1080, "seeders": 2})
    huge = {**release("Show.S01E01.1080p.WEB-DL.H.264-X"), "size": 40 * GiB}
    assert "file-size limit" in reasons(huge, "show")
    assert "CAM" in reasons(release("Movie.2023.1080p.WEB-DL.HDCAM"))
    mux = release("Show.S01E01.1080p.WEB-DL.H.264-X", filename="Show.S01E01.1080p.BDMux.mkv")
    assert "BDMux release, not WEB-DL" in reasons(mux, "show")


def test_traits_read_group_service_hdr_dolby_vision_dubs_and_season_packs():
    t = rr.traits(
        release(
            "Show.S01E01.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX",
            file_index=3,
            label="Show S01 2160p ATVP WEB-DL DV HDR H.265-FLUX\n"
            "Show.S01E01.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv\n👤 9 💾 8 GB",
        )
    )
    assert (t["group"], t["service"]) == ("FLUX", "ATVP")
    assert t["hdr"] and t["dolby_vision"] and not t["dolby_vision_only"] and t["hevc"]
    assert t["season_pack"]
    assert rr.traits(release("Шоу Show.S01E01.1080p.WEB-DL.H.264-X"))["foreign_dub"]
    assert rr.traits(release("Show.S01E01.1080p.WEB-DL.H.264.with ASL-X"))["sign_language"]


def test_ranking_prefers_untouched_service_web_dls_and_penalises_reencodes_dubs_upscales_dv_only():
    best = release("Show.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-NTb", hash="b")
    reencode = release("Show.S01E01.1080p.WEB-DL.x265.10bit-PSA", hash="c", size=0.6 * GiB, seeders=900)
    dub = release("Шоу.S01E01.1080p.WEB-DL.H.264-RUS", hash="d", seeders=300)
    upscale = release("Show.S01E01.1080p.WEB-DL.AI.Upscale.H.264-X", hash="e", seeders=300)
    ranked = rr.rank([reencode, dub, upscale, best], "show", streaming=False)
    assert ranked[0]["release"] is best
    why = [reason for _, reason in rr.score(reencode, "show", streaming=False)["parts"]]
    assert "Re-encoded video" in why and "Too small for an untouched WEB-DL" in why
    dv_only = release("Movie.2160p.WEB-DL.DV.H.265-X", size=20 * GiB)
    hdr = release("Movie.2160p.WEB-DL.HDR.H.265-X", size=20 * GiB, hash="f")
    assert rr.rank([dv_only, hdr], "movie")[0]["release"] is hdr


def test_other_language_and_sign_language_versions_rank_lower():
    plain = release("Film.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRP", hash="b", size=8 * GiB)
    french = release("Film.2026.FRENCH.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRP", hash="c", size=8 * GiB)
    asl = release("Film.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264.with ASL-GRP", hash="d", size=8 * GiB)
    order = [e["release"]["hash"][0] for e in rr.rank([asl, french, plain], "movie")]
    assert order == ["b", "c", "d"]


def test_the_size_floor_follows_the_runtime_when_it_is_known():
    anime = release("Anime.S01E01.1080p.CR.WEB-DL.AAC2.0.H.264-SubsPlease", size=1.4 * GiB)
    why = lambda **kw: [r for _, r in rr.score(anime, "show", **kw)["parts"]]
    assert "Too small for an untouched WEB-DL" in why()
    assert "Full-bitrate size" in why(runtime=1440)


def test_a_season_lock_keeps_later_episodes_on_the_same_pack_or_group_and_service():
    ntb = release("Show.S01E02.1080p.NF.WEB-DL.DDP5.1.H.264-NTb", hash="b", seeders=20)
    flux = release("Show.S01E02.1080p.AMZN.WEB-DL.DDP5.1.H.264-FLUX", hash="c", seeders=400)
    assert rr.rank([ntb, flux], "show", streaming=False)[0]["release"] is flux
    lock = {"hash": "z" * 40, "group": "NTB", "service": "NF"}
    assert rr.rank([ntb, flux], "show", lock, streaming=False)[0]["release"] is ntb
    pack = {**ntb, "hash": "p" * 40}
    top = rr.rank([pack, flux], "show", {"hash": pack["hash"], "group": None, "service": None})[0]
    assert top["release"] is pack
    assert rr.lock_from(top) == {"hash": pack["hash"], "group": "NTB", "service": "NF"}
    assert rr.lock_from(None) is None


def test_streaming_weighs_swarm_health_but_quality_still_outweighs_it():
    small = release("Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRP", hash="b", seeders=6)
    healthy = release("Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-OTH", hash="c", seeders=200)
    gap = lambda streaming: (
        rr.score(healthy, "show", streaming=streaming)["score"]
        - rr.score(small, "show", streaming=streaming)["score"]
    )
    assert gap(True) > gap(False) + 15
    assert (-15, "Small swarm, slow start likely") in rr.score(small, "show")["parts"]
    service = release("Show.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-NTb", hash="d", seeders=12)
    reencode = release("Show.S01E01.1080p.WEB-DL.x265-PSA", hash="e", seeders=2000, size=GiB)
    assert rr.rank([reencode, service], "show")[0]["release"] is service


def test_films_may_stream_from_a_disc_source_series_stay_web_dl_and_poor_sources_stay_out():
    def movie(name):
        return {"hash": "a" * 40, "label": f"{name}\n👤 400 💾 12 GB", "filename": f"{name}.mkv",
                "seeders": 400, "size": 12 * GiB, "resolution": 1080}  # fmt: skip

    assert rr.source_of(movie("Film.2026.1080p.BluRay.DDP5.1.x264-GRP")) == "disc"
    assert rr.source_of(movie("Film.2026.1080p.UHD.BDRemux.HEVC-GRP")) == "remux"
    assert rr.source_of(movie("Film.2026.1080p.AMZN.WEB-DL.H.264-GRP")) == "web-dl"
    assert rr.source_of(movie("Film.2026.1080p.WEBRip.x264-GRP")) == "poor"
    assert accepted(movie("Film.2026.1080p.BluRay.DDP5.1.x264-GRP"))
    assert accepted(movie("Film.2026.1080p.UHD.BDRemux.HEVC-GRP"))
    assert accepted(movie("Film.2026.1080p.AMZN.WEB-DL.H.264-GRP"))
    assert not accepted(movie("Film.2026.1080p.WEBRip.x264-GRP"))
    assert not accepted(movie("Film.2026.1080p.BluRay.HDTV.x264-GRP"))
    assert not accepted(movie("Film.2026.1080p.BluRay.HDCAM-GRP"))
    assert not accepted(movie("Show.S01E01.1080p.BluRay.x264-GRP"), "show")


def test_a_film_labelled_with_another_year_is_a_different_film():
    r = lambda name: {"label": f"{name}\n👤 400 💾 12 GB", "filename": ""}
    assert rr.year_mismatch(r("The Odyssey 2026 1080p BluRay x264-GRP"), "2026") is None
    assert (
        rr.year_mismatch(r("The Odyssey 1997 1080p WEB-DL x264-GRP"), "2026")
        == "Labelled 1997, not 2026: a different film"
    )
    assert rr.year_mismatch(r("The Odyssey 2025 2160p WEB-DL"), "2026") is None
    assert rr.year_mismatch(r("The Odyssey 1080p BluRay x264-GRP"), "2026") is None
    assert rr.year_mismatch(r("2001 A Space Odyssey 1968 2160p UHD BluRay"), "1968") is None
    assert rr.year_mismatch(r("The Odyssey 2026 2160p"), "") is None
    odyssey = {**r("The Odyssey 1997 1080p AMZN WEB-DL H.264-GRP"), "seeders": 400,
               "size": 9 * GiB, "resolution": 1080}  # fmt: skip
    assert not accepted(odyssey, year=2026)
    assert "a different film" in reasons(odyssey, year=2026)


def test_a_revival_or_remake_labelled_outside_the_years_a_series_ran_is_a_different_series():
    r = lambda name: {"label": f"{name}\n👤 40 💾 1 GB", "filename": ""}
    ran = {"series": True, "end_year": 2010}
    assert rr.year_mismatch(r("Scrubs S01E01 1080p DSNP WEB-DL"), "2001", **ran) is None
    assert rr.year_mismatch(r("Scrubs 2001 S01E01 DVDRip"), "2001", **ran) is None
    assert rr.year_mismatch(r("Scrubs 2005 S05E01 720p HDTV"), "2001", **ran) is None
    assert "2026: a different series" in rr.year_mismatch(
        r("Scrubs 2026 S01E01 My Return 1080p DSNP WEB-DL"), "2001", **ran
    )
    assert rr.year_mismatch(r("Show 2026 S09E01 1080p WEB-DL"), "2018", series=True) is None
    assert "1987" in rr.year_mismatch(r("Show 1987 S01E01 DVDRip"), "2018", series=True)
    assert rr.year_mismatch(r("Show S01E01 1920x1080 WEB-DL"), "2001", **ran) is None


def test_for_a_film_a_full_size_disc_encode_outranks_an_undersized_web_dl():
    def r(name, seeders, gigabytes, h):
        return {"hash": h, "label": f"{name}\n👤 {seeders} 💾 {gigabytes} GB", "filename": f"{name}.mkv",
                "seeders": seeders, "size": gigabytes * GiB, "resolution": 1080}  # fmt: skip

    ranked = rr.rank(
        [
            r("Film 2026 1080p AMZN WEB-DL DDP5 1 H 264-Small", 2295, 4.35, "a"),
            r("Film.2026.BluRay.1080p.DDP.5.1.x264-Full", 489, 12.8, "b"),
            r("Film.2026.iTA-ENG.Bluray.1080p.x264-Dub", 489, 12.8, "c"),
            r("Film.2026.1080p.UHD.BluRay.REMUX.HEVC-Huge", 489, 60, "d"),
        ],
        "movie",
        runtime=173 * 60,
    )
    assert [e["release"]["hash"] for e in ranked] == ["b", "c", "d", "a"]


def test_720p_and_sd_accept_any_real_source_and_sd_is_read_from_the_label():
    def r(name, resolution=None):
        return {"hash": "a" * 40, "label": f"{name}\n👤 40 💾 300 MB", "filename": f"{name}.mkv",
                "seeders": 40, "size": 300 * MiB, "resolution": resolution}  # fmt: skip

    assert rr.stream_resolution(r("Show.S01E01.DVDRip.XviD-GRP")) == 480
    assert rr.stream_resolution(r("Show S01E01 (360p re-dvdrip)")) == 480
    assert rr.stream_resolution(r("Show.S01E01.720p.HDTV.x264-GRP", 720)) == 720
    assert rr.stream_resolution(r("Show.S01E01.x264-GRP")) is None
    assert accepted(r("Show.S01E01.DVDRip.XviD-GRP"), "show", 480)
    assert accepted(r("Show.S01E01.720p.HDTV.x264-GRP", 720), "show", 720)
    assert accepted(r("Show.S01E01.720p.BluRay.x264-GRP", 720), "show", 720)
    assert not accepted(r("Show.S01E01.720p.HDCAM.x264-GRP", 720), "show", 720)
    assert not accepted(r("Show.S01E01.1080p.HDTV.x264-GRP", 1080), "show", 1080)
    assert not accepted(r("Show.S01E01.DVDRip.XviD-GRP"), "show", 720)
    assert not accepted(r("Show.S01E01.x264-GRP"), "show", 480)


def test_an_episode_keeps_to_web_dl_at_1080p_and_accepts_blu_ray_only_when_relaxed():
    disc = {"hash": "a" * 40, "label": "Show.S02E01.1080p.BluRay.x264-GRP\n👤 40 💾 3 GB",
            "filename": "Show.S02E01.1080p.BluRay.x264-GRP.mkv", "seeders": 40, "size": 3 * GiB,
            "resolution": 1080}  # fmt: skip
    assert not accepted(disc, "show")
    assert accepted(disc, "show", relaxed=True)
    rip = {**disc, "label": disc["label"].replace("BluRay", "WEBRip"), "filename": ""}
    assert not accepted(rip, "show", relaxed=True)


def test_runtime_end_year_and_wrong_film():
    assert rr.runtime_seconds("2h 28min") == 8880
    assert rr.runtime_seconds("148 min") == 8880
    assert rr.runtime_seconds("1h") == 3600
    assert rr.runtime_seconds("90") == 5400
    assert rr.runtime_seconds("") is None and rr.runtime_seconds(None) is None
    assert rr.end_year("2001–2010") == 2010 and rr.end_year("2018–") is None
    assert rr.wrong_film(7200, 7000) is None
    assert "runs 40 min" in rr.wrong_film(2400, 7200)
    assert rr.wrong_film(900, 900) is None  # too short to judge (Sintel runs 15 min)


def test_trusted_releases_are_recognised_by_their_group_at_the_end_or_in_brackets():
    named = lambda name: {"label": f"{name}\n👤 50", "filename": f"{name}.mkv"}
    assert rr.trusted_group(named("Show.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-NTb")) == "NTb"
    assert rr.trusted_group(named("Show.S01E01.1080p.WEB-DL.H.264-ntb")) == "ntb"
    assert rr.trusted_group(named("[Erai-raws] Show - 01 [1080p][Multiple Subtitle]")) == "Erai-raws"
    assert rr.trusted_group(named("[SubsPlease] Show - 01 (1080p) [ABCD1234]")) == "SubsPlease"
    assert rr.trusted_group(named("Show.S01E01.1080p.WEB-DL.H.264-GRP")) is None
    assert rr.trusted_group(named("Show S01E01 1080p WEB-DL")) is None
    assert rr.trusted_group(named("Show.S01E01.1080p.WEB-DL.H.264-NTb"), ()) is None


def test_only_full_text_subtitle_tracks_with_a_language_count():
    info = {"subtitles": [
        {"lang": "ar", "text": True, "forced": False},
        {"lang": "en", "text": False, "forced": False},  # PGS
        {"lang": "en", "text": True, "forced": True},  # forced: foreign dialogue only
        {"lang": None, "text": True, "forced": False},  # untagged
        {"lang": "ar", "text": True, "forced": False},
    ]}  # fmt: skip
    assert rr.subtitle_languages(info) == ["ar"]
