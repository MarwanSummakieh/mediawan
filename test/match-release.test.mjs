// Unit tests for "is this file actually the thing that was asked for".
// The bug being locked down: a compilation pack (66 unrelated films, huge
// seeder count, ranks well) used to resolve to its LARGEST video, so asking
// for one film played a different one entirely.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickVideoFile, titleMatches, fileHasEpisode, isCompilation, normalize, playbackQuality, isHdr, seasonOf, seasonMatches, baseTitle, titleRelevant, releaseIsRelevant, isMultiSeason, titleForms, wantedSeason } from "../lib/match-release.mjs";

// ---------- season identity ----------
// Identity is a GATE, never a score. A dual-audio Season 1 pack once outscored
// the correct Season 2 release on a dub request — its "episode 01" file would
// have played as season 2's premiere.

test("seasonOf: prose and compact spellings", () => {
  assert.equal(seasonOf("Shingeki no Kyojin Season 2"), 2);
  assert.equal(seasonOf("Attack on Titan (2013) S02 (1080p)"), 2);
  assert.equal(seasonOf("Show 2nd Season 1080p"), 2);
  assert.equal(seasonOf("Show.S03E05.1080p.WEB"), 3); // an episode ref still names its season
});

test("seasonOf: null when the name says nothing", () => {
  assert.equal(seasonOf("[SubsPlease] Frieren - 07 (1080p)"), null);
  assert.equal(seasonOf("Movie 2160p BluRay"), null);
  assert.equal(seasonOf("Show 1080p x265"), null); // resolution is not a season
});

// A Roman numeral is how AniList and half the release groups spell a sequel.
// The live failure: "Youjo Senki II" read as season 1, which inverted the gate
// — every release that correctly said "S2" was thrown out as the wrong season,
// leaving only the CR-tagged "II" releases that Real-Debrid 451s.
test("seasonOf: Roman-numeral sequels", () => {
  assert.equal(seasonOf("Youjo Senki II"), 2);
  assert.equal(seasonOf("[Erai-raws] Youjo Senki II - 04 [1080p CR WEB-DL AVC AAC]"), 2);
  assert.equal(seasonOf("Overlord IV"), 4);
  assert.equal(seasonOf("Youjo.Senki.II.04.1080p.WEB"), 2); // dotted release names too
});

test("seasonOf: Roman numerals that are not seasons", () => {
  // A DIVISION of a season, not the season: this is season 4 part 2.
  assert.equal(seasonOf("[LX] Shingeki no Kyojin - The Final Season Part II - 01 [BD]"), null);
  // A numbered SUBTITLE — the numeral introduces the words after it.
  assert.equal(seasonOf("Fate/stay night Movie: Heaven's Feel - II. Lost Butterfly"), null);
  // One letter alone is a stylisation far more often than a season.
  assert.equal(seasonOf("Senki Zesshou Symphogear XV"), null);
  assert.equal(seasonOf("[Group] Show V - 03 (1080p)"), null);
  // "I" is season 1, which is the default anyway.
  assert.equal(seasonOf("Show I"), null);
});

test("seasonOf: an explicit season outranks a Roman numeral", () => {
  assert.equal(seasonOf("Show II S03E01 1080p"), 3);
});

test("seasonMatches: a stated season is decisive", () => {
  assert.equal(seasonMatches("Attack on Titan (2013) S02 1080p", 2), true);
  assert.equal(seasonMatches("Attack on Titan Season 3 1080p", 2), false);
});

test("seasonMatches: 'COMPLETE' does not override a stated season", () => {
  // The live failure: a complete SEASON ONE pack, not a complete series.
  assert.equal(seasonMatches("[JPN-ENG] Attack on Titan : Season 01 S01 [2013] COMPLETE", 2), false);
});

test("seasonMatches: an explicit range is checked for containment", () => {
  assert.equal(seasonMatches("Attack on Titan S01-S04 Complete", 2), true);
  assert.equal(seasonMatches("Attack on Titan S03-S04 Complete", 2), false);
});

test("seasonMatches: an unstated season is fine for season 1 / unknown", () => {
  // Single-cour releases almost never carry a season tag.
  assert.equal(seasonMatches("[SubsPlease] Frieren - 07 (1080p)", 1), true);
  assert.equal(seasonMatches("anything", undefined), true);
});

// ---------- title identity ----------

test("baseTitle: strips the season suffix that AniList bakes into the name", () => {
  // Without this, "season" becomes a required token and no release matches.
  assert.equal(baseTitle("Shingeki no Kyojin Season 2"), "Shingeki no Kyojin");
  assert.equal(baseTitle("Attack on Titan Season 2"), "Attack on Titan");
  assert.equal(baseTitle("Shingeki no Kyojin: The Final Season"), "Shingeki no Kyojin");
  assert.equal(baseTitle("Show 2nd Season"), "Show");
  assert.equal(baseTitle("Sousou no Frieren"), "Sousou no Frieren"); // nothing to strip
});

test("baseTitle: strips a trailing Roman-numeral season, but only trailing", () => {
  // Kept "II" as a required token, so "[SubsPlease] Youjo Senki S2 - 04" —
  // 2506 seeders, untagged, exactly the release RD accepts — was dropped as a
  // title mismatch.
  assert.equal(baseTitle("Youjo Senki II"), "Youjo Senki");
  assert.equal(baseTitle("Overlord IV"), "Overlord");
  assert.equal(baseTitle("Mob Psycho 100 II"), "Mob Psycho 100"); // the digits are the title
  // Not trailing: the numeral belongs to the name, not to a season.
  assert.equal(baseTitle("Fate/stay night Movie: Heaven's Feel - II. Lost Butterfly"),
    "Fate/stay night Movie: Heaven's Feel - II. Lost Butterfly");
});

test("wantedSeason: reads whichever of the two names states a season", () => {
  // AniList marks this one with a numeral in romaji and the word in English;
  // reading only romaji (which `||` did) saw neither before Roman numerals
  // were understood, and defaulted to season 1.
  const tanya = { romaji: "Youjo Senki II", title: "Saga of Tanya the Evil Season 2" };
  assert.equal(wantedSeason(tanya), 2);
  // English states it, romaji is silent.
  assert.equal(wantedSeason({ romaji: "Shingeki no Kyojin", title: "Attack on Titan Season 2" }), 2);
  assert.equal(wantedSeason({ romaji: "Sousou no Frieren", title: "Frieren" }), 1);
});

test("Tanya S2 ep4: the releases that actually play are no longer gated out", () => {
  const tanya = { romaji: "Youjo Senki II", title: "Saga of Tanya the Evil Season 2" };
  // The untagged SubsPlease release RD serves — was "dropped: title mismatch".
  assert.equal(releaseIsRelevant("[SubsPlease] Youjo Senki S2 - 04 (1080p) [6F9D19E3].mkv", tanya), true);
  // Was "dropped: wrong season".
  assert.equal(releaseIsRelevant("[Judas] Youjo Senki (Saga of Tanya the Evil) - S02E04 [1080p]", tanya), true);
  assert.equal(releaseIsRelevant("[ToonsHub] Saga of Tanya the Evil S02E04 1080p AMZN WEB-DL", tanya), true);
  // The "II"-named ones still pass — they were all this used to have.
  assert.equal(releaseIsRelevant("[Erai-raws] Youjo Senki II - 04 [1080p CR WEB-DL AVC AAC]", tanya), true);
  // Season one must still be refused.
  assert.equal(releaseIsRelevant("[SubsPlease] Youjo Senki - 04 (1080p)", tanya), false);
  assert.equal(releaseIsRelevant("[Judas] Youjo Senki S01E04 [1080p]", tanya), false);
});

test("titleRelevant: matches against romaji OR English", () => {
  const meta = { romaji: "Shingeki no Kyojin Season 2", title: "Attack on Titan Season 2" };
  // Releases use one name or the other; testing a single form rejects half.
  assert.equal(titleRelevant("[NewbSubs] Shingeki no Kyojin S2 26 (1080p)", meta), true);
  assert.equal(titleRelevant("Attack on Titan S02E01 1080p REMUX", meta), true);
  assert.equal(titleRelevant("[SubsPlease] Jujutsu Kaisen - 01 (1080p)", meta), false);
});

test("releaseIsRelevant: needs the right show AND the right season", () => {
  const meta = { romaji: "Shingeki no Kyojin Season 2", title: "Attack on Titan Season 2" };
  assert.equal(releaseIsRelevant("Attack on Titan S02E01 1080p REMUX", meta), true);
  assert.equal(releaseIsRelevant("[NewbSubs] Shingeki no Kyojin S2 26 (1080p)", meta), true);
  // right show, wrong season
  assert.equal(releaseIsRelevant("[JPN-ENG] Attack on Titan Season 01 S01 COMPLETE", meta), false);
  // right show, season unstated — a sequel demands confirmation
  assert.equal(releaseIsRelevant("[LX] Shingeki no Kyojin - The Final Season Part 2 - 01", meta), false);
  // wrong show entirely
  assert.equal(releaseIsRelevant("Demon Slayer S02E01 1080p", meta), false);
});

// ---------- multi-season packs and absolute numbering ----------

test("isMultiSeason: spots packs that number files absolutely", () => {
  // Live failure: a dub request for S02E01 landed on this pack and took file
  // "01" — season ONE's premiere. S02E01 is absolute episode 26 here.
  assert.equal(isMultiSeason("[NewbSubs] Attack on Titan~Shingeki no Kyojin Series S1-S4 01-75 + OVA"), true);
  assert.equal(isMultiSeason("Breaking Bad S01 - S05 COMPLETE 1080p BluRay REMUX"), true);
  assert.equal(isMultiSeason("Attack on Titan Complete Series 1080p"), true);
});

test("isMultiSeason: a single-season release is not one", () => {
  // These number files from 1, so episode-only matching is correct for them.
  assert.equal(isMultiSeason("Attack on Titan S02E01 1080p REMUX"), false);
  assert.equal(isMultiSeason("[SubsPlease] Frieren - 07 (1080p)"), false);
  assert.equal(isMultiSeason("Attack on Titan Season 01 S01 COMPLETE"), false);
});

test("pickVideoFile: a season-qualified want refuses absolute numbering", () => {
  // The pack holds 01-75; asking for season 2 episode 1 must NOT match "01".
  const files = [
    { id: 1, path: "AoT/01.mkv", bytes: 1e9 },
    { id: 26, path: "AoT/26.mkv", bytes: 1e9 },
  ];
  assert.equal(pickVideoFile(files, { title: "Attack on Titan", season: 2, episode: 1 }), null);
  // With S02E01 naming it resolves correctly.
  const named = [
    { id: 1, path: "AoT/Attack on Titan S01E01.mkv", bytes: 1e9 },
    { id: 26, path: "AoT/Attack on Titan S02E01.mkv", bytes: 1e9 },
  ];
  assert.equal(pickVideoFile(named, { title: "Attack on Titan", season: 2, episode: 1 })?.id, 26);
});

// ---------- file selection inside a pack ----------
// The live bug: `want.title` was the raw romaji, and pickVideoFile requires
// every token of it in the FILENAME. A romaji-named release whose files are
// named in English matched nothing, so every candidate was skipped. Single-file
// torrents survived on the videos.length === 1 shortcut — which is why some
// titles played and others silently didn't.

const pack = (n, fmt) => Array.from({ length: n }, (_, i) => ({ id: i + 1, path: fmt(i + 1), bytes: 1e9 }));
const AOT = { romaji: "Shingeki no Kyojin Season 2", title: "Attack on Titan Season 2" };

test("titleForms: both names, season suffix stripped", () => {
  assert.deepEqual(titleForms(AOT), ["Shingeki no Kyojin", "Attack on Titan"]);
});

test("pickVideoFile: a romaji request matches English-named files", () => {
  const files = pack(12, (i) => `Attack on Titan S02E${String(i).padStart(2, "0")}.mkv`);
  assert.match(pickVideoFile(files, { titles: titleForms(AOT), episode: "1" }).path, /S02E01/);
});

test("pickVideoFile: episode-only filenames resolve inside a confirmed pack", () => {
  const files = pack(12, (i) => `[Judas] ${String(i).padStart(2, "0")} [1080p].mkv`);
  assert.match(pickVideoFile(files, { titles: titleForms(AOT), episode: "3" }).path, /\] 03 /);
});

test("pickVideoFile: the episode discriminates, not file size", () => {
  // Title matches every file in a pack, so title-alone degrades to "biggest
  // video" — the original bug. Years, resolutions and CRC tags must not pose
  // as episode numbers either.
  const files = [
    { id: 1, path: "Show (2013) 1080p [A1B2C3D4].mkv", bytes: 9e9 },
    { id: 2, path: "Show - 07 [1080p].mkv", bytes: 1e9 },
  ];
  assert.match(pickVideoFile(files, { titles: ["Show"], episode: "7" }).path, /- 07/);
  assert.equal(pickVideoFile(files, { titles: ["Show"], episode: "13" }), null);
});

test("pickVideoFile: a film with no episode still matches on title", () => {
  const files = [{ id: 1, path: "Inception 2010 1080p REMUX.mkv", bytes: 3e10 }];
  assert.match(pickVideoFile(files, { titles: ["Inception"] }).path, /Inception/);
});

test("seasonMatches: season 2+ requires positive confirmation", () => {
  // Anime sequels share a base title and diverge only in a suffix, so an
  // untagged release is more likely a different entry than the one requested.
  // Live failure: a Season 2 dub request resolved to "The Final Season Part 2".
  assert.equal(seasonMatches("[LX] Shingeki no Kyojin - The Final Season Part 2 - 01 [BD]", 2), false);
  assert.equal(seasonMatches("[SubsPlease] AoT - 01 (1080p)", 2), false);
  assert.equal(seasonMatches("Attack on Titan (2013) S02 1080p", 2), true);
});

const f = (path, bytes, id) => ({ path, bytes, id });

// The real pack from the live probe, trimmed.
const GREAT_FILMS = [
  f("/American Gangster (2007) 1080p Surround.mp4", 9_000_000_000, 1),
  f("/A Beautiful Mind (2001) 1080p Surround.mp4", 7_000_000_000, 2),
  f("/Michael Jacksons This Is It (2009) 1080p Surround.mp4", 5_000_000_000, 60),
  f("/Alexander (2004) 1080p Surround.mp4", 8_000_000_000, 3),
];

test("the actual bug: a pack no longer serves its biggest film for any request", () => {
  const got = pickVideoFile(GREAT_FILMS, { title: "Michael Jackson's This Is It", year: 2009 });
  assert.match(got.path, /This Is It/);           // not American Gangster, the largest
});

test("a pack that doesn't contain the request is REFUSED, not guessed at", () => {
  assert.equal(pickVideoFile(GREAT_FILMS, { title: "Masters of the Universe", year: 1987 }), null);
});

test("a wrong fileIdx is overruled by the filename", () => {
  // hint points at American Gangster while the request is for This Is It
  const got = pickVideoFile(GREAT_FILMS, { title: "Michael Jackson's This Is It", fileIdx: 0 });
  assert.match(got.path, /This Is It/);
});

test("a correct fileIdx is honoured", () => {
  const got = pickVideoFile(GREAT_FILMS, { title: "Michael Jackson's This Is It", fileIdx: 59 });
  assert.match(got.path, /This Is It/);
});

test("a single-video torrent is accepted even with a generic filename", () => {
  const one = [f("/Masters.of.the.Universe.1987/movie.mkv", 4_000_000_000, 1)];
  assert.equal(pickVideoFile(one, { title: "Masters of the Universe" }).path, one[0].path);
});

test("samples and extras are never chosen", () => {
  const withSample = [
    f("/Masters of the Universe (1987)/sample.mkv", 50_000_000, 1),
    f("/Masters of the Universe (1987)/Masters of the Universe 1987 1080p.mkv", 6_000_000_000, 2),
  ];
  assert.match(pickVideoFile(withSample, { title: "Masters of the Universe" }).path, /1080p/);
});

test("season packs resolve to the requested episode, not the biggest one", () => {
  const season = [
    f("/Show/Show.S01E01.1080p.mkv", 3_000_000_000, 1),
    f("/Show/Show.S01E02.1080p.mkv", 9_000_000_000, 2), // largest
    f("/Show/Show.S01E03.1080p.mkv", 3_000_000_000, 3),
  ];
  assert.match(pickVideoFile(season, { season: 1, episode: 3 }).path, /S01E03/);
  assert.equal(pickVideoFile(season, { season: 2, episode: 1 }), null); // not in this pack
});

test("titleMatches: containment, tolerant of noise and a translated title", () => {
  assert.ok(titleMatches("Masters.of.the.Universe.1987.1080p.BluRay.x265-KC", "Masters of the Universe"));
  assert.ok(titleMatches("Повелители вселенной / Masters of the Universe (1987)", "Masters of the Universe"));
  assert.ok(titleMatches("Michael Jacksons This Is It 2009", "Michael Jackson's This Is It")); // apostrophe
  assert.equal(titleMatches("American Gangster (2007)", "Masters of the Universe"), false);
  assert.equal(titleMatches("Masters of the Universe Revelation S01E01", "Masters of the Universe Revolution"), false);
});

test("fileHasEpisode: common numbering styles, and no false positives", () => {
  assert.ok(fileHasEpisode("Show.S01E05.mkv", 1, 5));
  assert.ok(fileHasEpisode("Show 1x05 720p.mkv", 1, 5));
  assert.ok(fileHasEpisode("Show.s1e5.mkv", 1, 5));
  assert.equal(fileHasEpisode("Show.S01E15.mkv", 1, 5), false);
  assert.equal(fileHasEpisode("Show.S02E05.mkv", 1, 5), false);
});

test("isCompilation flags the release names that cause this", () => {
  assert.ok(isCompilation("Great Films 5 - Mp4 x264 AC3 1080p"));
  assert.ok(isCompilation("IMDB Top 250 - 2024 Edition - 1080p BluRay"));
  assert.ok(isCompilation("The Godfather Trilogy 1080p"));
  assert.equal(isCompilation("Masters.of.the.Universe.1987.1080p.BluRay"), false);
});

// Measured on a real file: the source ran at 4.2 Mbit/s and Real-Debrid's
// transcode of it came back at 2.4 — so "does this avoid the transcoder" is a
// genuine quality signal, not a cosmetic label.
test("playbackQuality: MP4/H.264 reaches the viewer untouched", () => {
  assert.equal(playbackQuality("Interstellar (2014) 1080p Surround.mp4"), "original");
  assert.equal(playbackQuality("Amazing Films 8 - Mp4 x264 AC3 1080p"), "original");
});

test("playbackQuality: mkv and HEVC must be re-encoded on the way", () => {
  assert.equal(playbackQuality("Movie.2014.1080p.BluRay.x264-GROUP.mkv"), "converted");
  assert.equal(playbackQuality("Movie.2014.2160p.x265-GROUP.mp4"), "converted"); // HEVC beats the mp4 hint
  assert.equal(playbackQuality("Movie.2014.1080p.HEVC.mkv"), "converted");
});

test("playbackQuality: says nothing when the name gives nothing away", () => {
  assert.equal(playbackQuality("Movie.2014.1080p.BluRay-GROUP"), null);
  assert.equal(playbackQuality(""), null);
});

test("isHdr: spots the wide-colour releases that transcode badly", () => {
  assert.ok(isHdr("House of the Dragon s01-s02 1080p DV/HDR10 web-dl"));
  assert.ok(isHdr("Movie.2014.2160p.UHD.BluRay.x265.HDR.DV"));
  assert.ok(isHdr("Movie 2160p HLG"));
  assert.equal(isHdr("Movie.2014.1080p.BluRay.x264-GROUP"), false);
  // "dv" must be a whole word, not a fragment of another one
  assert.equal(isHdr("Advent.2014.1080p.BluRay"), false);
});

test("normalize: punctuation and accents collapse so titles compare cleanly", () => {
  assert.equal(normalize("Michael Jackson's  THIS-IS_IT!"), "michael jacksons this is it");
  assert.equal(normalize("Amélie"), "amelie");
});

test("no video files at all yields null rather than a crash", () => {
  assert.equal(pickVideoFile([f("/readme.txt", 100, 1)], { title: "Anything" }), null);
  assert.equal(pickVideoFile([], { title: "Anything" }), null);
  assert.equal(pickVideoFile(null, {}), null);
});
