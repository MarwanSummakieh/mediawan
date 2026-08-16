// Unit tests for the quality model — the ranker that decides which release wins.
// Run with: npm test  (node --test, no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseResolution, parseSourceTier, parseVideoCodec, parseAudio, parseDub,
  bitrateMbps, meetsFloor, qualityScore, describe as describeRelease, rankByQuality,
} from "../lib/quality.mjs";

const GB = 1024 ** 3;
const rel = (name, sizeGb = 8, seeders = 100) => ({ name, size: sizeGb * GB, seeders });

// ---------- resolution ----------

test("parseResolution: standard tags", () => {
  assert.equal(parseResolution("Movie.2160p.BluRay"), 2160);
  assert.equal(parseResolution("Movie.1080p.WEB-DL"), 1080);
  assert.equal(parseResolution("Movie.720p.BRRip"), 720);
  assert.equal(parseResolution("Movie.4K.UHD"), 2160);
});

test("parseResolution: unstated is 0, not a low score", () => {
  assert.equal(parseResolution("Some Anime - 07 [SubsPlease]"), 0);
});

test("parseResolution: an explicit tag beats a UHD *source* tag", () => {
  // Seen in real apibay data: "Hybrid 1080p UHD BluRay" is a 1080p file cut
  // from a UHD disc. Reading UHD as the output resolution ranked ordinary
  // 1080p releases above their true peers by pretending they were 4K.
  assert.equal(parseResolution("Inception 2010 Hybrid 1080p UHD BluRay DD+5.1"), 1080);
  assert.equal(parseResolution("Movie.720p.BluRay.UHD.Source"), 720);
  // With no explicit tag, UHD/4K is still the best evidence available.
  assert.equal(parseResolution("Movie.UHD.BluRay.REMUX"), 2160);
  assert.equal(parseResolution("Movie 4K HDR"), 2160);
});

// ---------- source tier ----------

test("parseSourceTier: REMUX wins over the BluRay it contains", () => {
  assert.equal(parseSourceTier("Movie.2160p.UHD.BluRay.REMUX.HEVC"), "REMUX");
  assert.equal(parseSourceTier("Movie.1080p.BluRay.x264"), "BluRay");
  assert.equal(parseSourceTier("Movie.1080p.WEB-DL.DDP5.1"), "WEB-DL");
  assert.equal(parseSourceTier("Movie.1080p.WEBRip.x264"), "WEBRip");
});

test("parseVideoCodec", () => {
  assert.equal(parseVideoCodec("Movie.x265.HEVC"), "HEVC");
  assert.equal(parseVideoCodec("Movie.H.264.AVC"), "AVC");
  assert.equal(parseVideoCodec("Movie.AV1.1080p"), "AV1");
});

// ---------- audio: entirely new capability ----------

test("parseAudio: DDP5.1 has no word boundary before the channel count", () => {
  const a = parseAudio("Inception.2010.1080p.WEB-DL.DDP5.1.H.264-FLUX");
  assert.equal(a.codec, "E-AC3");
  assert.equal(a.channels, 6);
  assert.equal(a.lossless, false);
});

test("parseAudio: lossless formats detected with Atmos", () => {
  const a = parseAudio("Movie.2160p.REMUX.TrueHD.7.1.Atmos-FraMeSToR");
  assert.equal(a.codec, "TrueHD");
  assert.equal(a.channels, 8);
  assert.equal(a.lossless, true);
  assert.equal(a.atmos, true);
});

test("parseAudio: DTS-HD MA is lossless 5.1", () => {
  const a = parseAudio("Movie.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-EbP");
  assert.equal(a.codec, "DTS-HD MA");
  assert.equal(a.channels, 6);
  assert.equal(a.lossless, true);
});

test("parseAudio: disc formats imply surround when the count is unwritten", () => {
  assert.equal(parseAudio("Movie.1080p.BluRay.TrueHD-GROUP").channels, 6);
  assert.equal(parseAudio("Movie.1080p.BluRay.DTS-HD.MA-GROUP").channels, 6);
});

test("parseAudio: FLAC/PCM do NOT imply surround", () => {
  // Verified against a real release: "[PMR] Frieren (BD Remux 1080p AVC FLAC
  // AAC)" probes as flac 2ch. Anime BD remuxes ship stereo FLAC constantly, so
  // inferring 5.1 from losslessness alone scored stereo releases as surround.
  assert.equal(parseAudio("[PMR] Frieren (BD Remux 1080p AVC FLAC AAC)").channels, null);
  assert.equal(parseAudio("Movie.1080p.BluRay.LPCM").channels, null);
  // Still lossless — that part was never in doubt, and still earns its points.
  assert.equal(parseAudio("[PMR] Frieren (BD Remux 1080p AVC FLAC AAC)").lossless, true);
});

test("parseAudio: resolution digits must not read as channel counts", () => {
  // "2160p" would parse as 2.1 and "1080p" as 8.0 without digit lookarounds.
  assert.equal(parseAudio("Movie.2160p.HEVC").channels, null);
  assert.equal(parseAudio("Movie.1080p.x264").channels, null);
  assert.equal(parseAudio("Movie.H.264.1080p").channels, null);
});

test("parseAudio: stereo detected", () => {
  assert.equal(parseAudio("Show.S01E01.1080p.WEB.DD2.0.x264").channels, 2);
});

// ---------- dub / dual audio ----------

test("parseDub: recognises the dual-audio vocabulary", () => {
  assert.equal(parseDub("[Judas] Show - 01 (1080p) [Dual Audio]").dual, true);
  assert.equal(parseDub("Show.S01E01.1080p.BluRay.Dual-Audio.x264").dual, true);
  assert.equal(parseDub("[PMR] Frieren (BD Remux 1080p) [Dual Audio]").canDub, true);
  assert.equal(parseDub("Show 1080p Multi-Audio").dual, true);
});

test("parseDub: language pairs in either order, any separator", () => {
  // Seen live: "[JPN-ENG] Attack on Titan ..." was classified Japanese-only
  // because the pair regex only accepted "+", so a real dual-audio BluRay
  // never surfaced for a dub request.
  assert.equal(parseDub("[JPN-ENG] Attack on Titan Season 01 BluRay 1080p").dual, true);
  assert.equal(parseDub("Show 1080p JPN+ENG").dual, true);
  assert.equal(parseDub("Show 1080p ENG/JPN BluRay").dual, true);
  assert.equal(parseDub("Show 1080p [EN&JA]").dual, true);
});

test("parseDub: a lone language tag is not a pair", () => {
  assert.equal(parseDub("[JPN] Show - 01 (1080p)").dual, false);
  assert.equal(parseDub("Show.1080p.WEB-DL.DDP5.1.H.264-EbP").dual, false);
});

test("parseDub: dub-only vs sub-only vs unmarked", () => {
  const dubOnly = parseDub("Show.S01E01.1080p.WEB.English.Dub.x264");
  assert.equal(dubOnly.dubOnly, true);
  assert.equal(dubOnly.canDub, true);
  assert.equal(dubOnly.dual, false);

  const subOnly = parseDub("[SubsPlease] Show - 01 (1080p) [softsubs]");
  assert.equal(subOnly.canDub, false);
  assert.equal(subOnly.subOnly, true);

  const plain = parseDub("Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-FLUX");
  assert.equal(plain.canDub, false);
  assert.equal(plain.subOnly, false); // unmarked, not ruled out
});

test("ranking: a dub request puts dual-audio first, above a better sub-only release", () => {
  // The point of the weighting: a viewer who asked for dub would rather have a
  // 1080p dual-audio release than a 4K one they can't understand.
  const { list } = rankByQuality([
    rel("Show.S01E01.2160p.BluRay.REMUX.TrueHD.7.1-GROUP", 60, 500),
    rel("[Judas] Show - 01 (1080p) [Dual Audio]", 8, 50),
  ], { runtimeMin: 24, mode: "dub" });
  assert.match(list[0].name, /Dual Audio/);
});

test("ranking: the same field in sub mode prefers the better release", () => {
  const { list } = rankByQuality([
    rel("Show.S01E01.2160p.BluRay.REMUX.TrueHD.7.1-GROUP", 60, 500),
    rel("[Judas] Show - 01 (1080p) [Dual Audio]", 8, 50),
  ], { runtimeMin: 24, mode: "sub" });
  assert.match(list[0].name, /2160p/);
});

test("ranking: an explicitly sub-only release sinks on a dub request", () => {
  const { list } = rankByQuality([
    rel("[SubsPlease] Show - 01 (1080p) [softsubs]", 1.4, 900),
    rel("Show.S01E01.1080p.WEB.English.Dub.x264", 1.4, 5),
  ], { runtimeMin: 24, mode: "dub" });
  assert.match(list[0].name, /English\.Dub/);
});

test("ranking: dub-marked releases are penalised when sub was asked for", () => {
  assert.ok(qualityScore(rel("Show.1080p.WEB-DL.DDP5.1", 8), { runtimeMin: 24, mode: "sub" }) >
            qualityScore(rel("Show.1080p.WEB-DL.English.Dub.DDP5.1", 8), { runtimeMin: 24, mode: "sub" }));
});

// ---------- bitrate ----------

test("bitrateMbps: size over runtime", () => {
  // 8 GB over 120 min ≈ 9.5 Mbps
  const m = bitrateMbps(8 * GB, 120);
  assert.ok(m > 9 && m < 10, `got ${m}`);
});

test("bitrateMbps: unusable inputs return null, never a wrong number", () => {
  assert.equal(bitrateMbps(0, 120), null);
  assert.equal(bitrateMbps(8 * GB, 0), null);
  assert.equal(bitrateMbps(undefined, 120), null);
  assert.equal(bitrateMbps(8 * GB, null), null);
});

// ---------- the floor ----------

test("floor: YIFY-class re-encodes are rejected on bitrate", () => {
  const g = meetsFloor(rel("Inception.2010.1080p.BluRay.x264.YIFY", 1.6), { runtimeMin: 148 });
  assert.equal(g.ok, false);
  assert.match(g.reason, /Mbps below/);
});

test("floor: below 1080p is rejected", () => {
  const g = meetsFloor(rel("Movie.720p.BluRay.x264", 4), { runtimeMin: 120 });
  assert.equal(g.ok, false);
  assert.match(g.reason, /720p below/);
});

test("floor: cam/telesync rejected outright", () => {
  assert.equal(meetsFloor(rel("Movie.2024.HDCAM.x264", 2), { runtimeMin: 120 }).ok, false);
});

test("floor: a real WEB-DL passes", () => {
  assert.equal(meetsFloor(rel("Movie.1080p.WEB-DL.DDP5.1.H.264-FLUX", 8), { runtimeMin: 120 }).ok, true);
});

test("floor: unstated resolution passes the gate rather than being dropped", () => {
  // Anime releases routinely omit the tag; they're scored low, not refused.
  assert.equal(meetsFloor(rel("[SubsPlease] Show - 07", 1.4), { runtimeMin: 24 }).ok, true);
});

test("floor: pack sizes are not divided by one episode's runtime", () => {
  // 400 GB over 24 min would read as an absurd bitrate and pass/fail by accident.
  const g = meetsFloor(rel("Show.S01.Complete.1080p.WEB-DL", 400), { runtimeMin: 24 });
  assert.equal(g.ok, true);
  assert.equal(describeRelease(rel("Show.S01.Complete.1080p.WEB-DL", 400), { runtimeMin: 24 }).mbps, null);
});

test("floor: missing runtime disables the bitrate gate instead of guessing", () => {
  assert.equal(meetsFloor(rel("Movie.1080p.BluRay.x264.YIFY", 1.6), { runtimeMin: null }).ok, true);
});

// ---------- ranking ----------

test("ranking: 4K REMUX beats 1080p REMUX beats WEB-DL", () => {
  const { list } = rankByQuality([
    rel("Movie.1080p.WEB-DL.DDP5.1.H.264-FLUX", 8, 900),
    rel("Movie.2160p.UHD.BluRay.REMUX.HEVC.TrueHD.7.1.Atmos-FraMeSToR", 82, 40),
    rel("Movie.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-EbP", 30, 60),
  ], { runtimeMin: 148 });
  assert.equal(list.length, 3);
  assert.match(list[0].name, /2160p.*REMUX/);
  assert.match(list[1].name, /1080p.*REMUX/);
  assert.match(list[2].name, /WEB-DL/);
});

test("ranking: 2160p now outranks 1080p (the old model put it below 480p)", () => {
  assert.ok(qualityScore(rel("Movie.2160p.WEB-DL.DDP5.1", 25), { runtimeMin: 120 }) >
            qualityScore(rel("Movie.1080p.WEB-DL.DDP5.1", 8), { runtimeMin: 120 }));
});

test("ranking: seeders cannot buy a win over quality", () => {
  // The old model weighted seeders at log10*30, so this pairing inverted.
  const bad = rel("Movie.1080p.WEBRip.x264.YTS", 2.2, 50000);
  const good = rel("Movie.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-EbP", 30, 20);
  assert.ok(qualityScore(good, { runtimeMin: 120 }) > qualityScore(bad, { runtimeMin: 120 }));
});

test("ranking: 5.1 preferred over stereo, all else equal", () => {
  assert.ok(qualityScore(rel("Movie.1080p.WEB-DL.DDP5.1.H.264", 8), { runtimeMin: 120 }) >
            qualityScore(rel("Movie.1080p.WEB-DL.DD2.0.H.264", 8), { runtimeMin: 120 }));
});

test("ranking: compilation packs never lead", () => {
  const { list } = rankByQuality([
    rel("IMDB Top 250 Movies Collection 1080p", 400, 12000),
    rel("Movie.1080p.WEB-DL.DDP5.1.H.264-FLUX", 8, 100),
  ], { runtimeMin: 148 });
  assert.match(list[0].name, /WEB-DL/);
});

test("ranking: reports why rejected releases were dropped", () => {
  const { list, rejected } = rankByQuality([
    rel("Movie.1080p.BluRay.x264.YIFY", 1.6, 9000),
    rel("Movie.720p.WEB-DL.x264", 3, 500),
    rel("Movie.1080p.WEB-DL.DDP5.1.H.264-FLUX", 8, 100),
  ], { runtimeMin: 148 });
  assert.equal(list.length, 1);
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((r) => typeof r.reason === "string" && r.reason.length));
});

test("describe: surfaces the spec fields check-sources reports on", () => {
  const d = describeRelease(rel("Movie.2160p.UHD.BluRay.REMUX.HEVC.TrueHD.7.1.Atmos-FraMeSToR", 82), { runtimeMin: 148 });
  assert.equal(d.resolution, 2160);
  assert.equal(d.tier, "REMUX");
  assert.equal(d.videoCodec, "HEVC");
  assert.equal(d.audioLabel, "TrueHD 7.1 Atmos");
  assert.ok(d.mbps > 70);
});

// ---------- preferTranscodeFriendly: the transcode-bound reorder ----------
// A remote play tops out at 1080p behind the bitrate cap, and a 4K source
// costs the N100 a software 4K decode (plus tonemap) it cannot do in realtime.

test("preferTranscodeFriendly: ≤1080p sources lead, groups keep internal order", async () => {
  const { preferTranscodeFriendly } = await import("../lib/quality.mjs");
  const list = [
    { name: "a", quality: 2160 }, { name: "b", quality: 1080 },
    { name: "c", quality: 2160 }, { name: "d", quality: 720 },
  ];
  assert.deepEqual(preferTranscodeFriendly(list).map((c) => c.name), ["b", "d", "a", "c"]);
});

test("preferTranscodeFriendly: unknown resolution counts as transcode-friendly", async () => {
  const { preferTranscodeFriendly } = await import("../lib/quality.mjs");
  const list = [{ name: "a", quality: 2160 }, { name: "b", quality: 0 }];
  assert.deepEqual(preferTranscodeFriendly(list).map((c) => c.name), ["b", "a"]);
});

test("preferTranscodeFriendly: a 4K-only list is untouched — it must still play", async () => {
  const { preferTranscodeFriendly } = await import("../lib/quality.mjs");
  const list = [{ name: "a", quality: 2160 }, { name: "c", quality: 2160 }];
  assert.deepEqual(preferTranscodeFriendly(list).map((c) => c.name), ["a", "c"]);
});

// ---------- parseLanguages: which languages does the NAME claim? ----------
// The Servers panel lists 30-odd releases; without this, the only way to learn
// whether one spoke English was to play it. A claim, never a fact — ffprobe
// overrules it at delivery, and the panel labels the two differently.

test("parseLanguages: named languages in the technical tail", async () => {
  const { parseLanguages } = await import("../lib/quality.mjs");
  const l = parseLanguages("Some.Film.2021.1080p.BluRay.Hindi.English.DD5.1-GRP");
  assert.deepEqual(l.audio.sort(), ["eng", "hin"]);
  assert.equal(l.multi, true);
});

test("parseLanguages: a title's own words are NOT a language claim", async () => {
  const { parseLanguages, languageLabel } = await import("../lib/quality.mjs");
  // The whole reason parsing starts after the year: these would otherwise
  // report Italian / Hindi / French audio off the title alone.
  for (const name of [
    "The.Italian.Job.2003.1080p.BluRay.x264-AMIABLE",
    "Hindi.Medium.2017.1080p.WEBRip.x264",
    "The.French.Connection.1971.2160p.UHD.BluRay.x265",
  ]) {
    const l = parseLanguages(name);
    assert.deepEqual(l.audio, [], `${name} must claim nothing`);
    assert.equal(languageLabel(l), null);
  }
});

test("parseLanguages: MULTi means several, unnamed", async () => {
  const { parseLanguages, languageLabel } = await import("../lib/quality.mjs");
  const l = parseLanguages("Interstellar.2014.MULTi.1080p.BluRay.x264-VENUE");
  assert.equal(l.multi, true);
  assert.deepEqual(l.audio, []);
  assert.equal(languageLabel(l), "Multi-language");
});

test("parseLanguages: a bare dual marker names no language", async () => {
  const { parseLanguages, languageLabel } = await import("../lib/quality.mjs");
  const l = parseLanguages("[Judas] Attack on Titan S1 [1080p][HEVC][Dual Audio]");
  assert.equal(l.dual, true);
  assert.deepEqual(l.audio, [], "dual says there are two, not which two");
  assert.equal(languageLabel(l), "Dual Audio");
  // Live action uses the same marker without meaning Japanese — inferring the
  // anime pair made House of the Dragon claim a Japanese track.
  const hotd = parseLanguages("House.of.the.Dragon.S01E01.1080p.WEB-DL.DUAL.DDP5.1.H.264-NTb");
  assert.equal(hotd.audio.includes("jpn"), false);
  assert.equal(languageLabel(hotd), "Dual Audio");
});

test("parseLanguages: an explicit pair needs no inference", async () => {
  const { parseLanguages, languageLabel } = await import("../lib/quality.mjs");
  const l = parseLanguages("Anime.S01.1080p.BluRay.[JPN+ENG].x265");
  assert.deepEqual(l.audio.sort(), ["eng", "jpn"]);
  assert.equal(languageLabel(l), "English · Japanese");
});

test("parseLanguages: subtitle markers are not audio", async () => {
  const { parseLanguages } = await import("../lib/quality.mjs");
  // ESub = English SUBS on a film whose audio is Tamil.
  const a = parseLanguages("Movie.2023.1080p.WEB-DL.Tamil.ESub-GRP");
  assert.deepEqual(a.audio, ["tam"]);
  assert.deepEqual(a.subs, ["eng"]);
  // VOSTFR = French subs over the original audio, not French audio.
  const b = parseLanguages("Film.2019.VOSTFR.1080p.WEB-DL.x264");
  assert.deepEqual(b.audio, []);
  assert.deepEqual(b.subs, ["fre"]);
  // MSubs is several subtitle languages, unspecified — not English.
  const c = parseLanguages("Show.S01E01.1080p.WEB-DL.MSubs");
  assert.deepEqual(c.subs, []);
  assert.deepEqual(c.audio, []);
});

test("parseLanguages: French scene tags", async () => {
  const { parseLanguages, languageLabel } = await import("../lib/quality.mjs");
  for (const n of ["Film.2001.TRUEFRENCH.1080p.BluRay", "Film.2001.1080p.BluRay.VFF"]) {
    assert.deepEqual(parseLanguages(n).audio, ["fre"], n);
  }
  assert.equal(languageLabel(parseLanguages("Film.2001.TRUEFRENCH.1080p")), "French");
});

test("languageLabel: caps the list and counts the rest", async () => {
  const { languageLabel } = await import("../lib/quality.mjs");
  assert.equal(languageLabel({ audio: ["eng", "fre", "ger", "ita", "spa"] }), "English · French · German +2");
  assert.equal(languageLabel({ audio: [], dual: true }), "Dual Audio");
  assert.equal(languageLabel({ audio: [], multi: false, dual: false }), null);
  assert.equal(languageLabel(null), null);
});

test("describe: carries the language claim for the Servers panel", async () => {
  const { describe: d } = await import("../lib/quality.mjs");
  const r = d({ name: "Film.2020.MULTi.1080p.BluRay.x264", size: 8 * 1024 ** 3 }, { runtimeMin: 120 });
  assert.equal(r.langLabel, "Multi-language");
  assert.equal(r.subLabel, null);
});

// ---------- Real-Debrid's release-name filter ----------
//
// Measured 2026-07-31: RD refuses (451/infringing_file) essentially every
// release whose name carries CR/WEB-DL/WEBRip, and accepts the untagged ones.
// The ranker takes that as a PENALTY when the caller says RD will serve —
// tagged releases sink below untagged peers so the attempt budget stops being
// spent on guaranteed refusals — and as nothing at all otherwise.
test("qualityScore: rdFilter sinks RD-refused tags below untagged peers", async () => {
  const { qualityScore: score } = await import("../lib/quality.mjs");
  const tagged = rel("[Erai-raws] Show - 04 [1080p CR WEB-DL AVC AAC]", 1.4);
  const untagged = rel("[Judas] Show - 04 (1080p) [HEVC x265]", 1.4);
  // Without the flag the tagged release wins on its tier bonus…
  assert.ok(score(tagged, { runtimeMin: 24 }) > score(untagged, { runtimeMin: 24 }));
  // …with it, the untagged one leads, but the tagged one is NOT excluded.
  assert.ok(score(tagged, { runtimeMin: 24, rdFilter: true }) < score(untagged, { runtimeMin: 24, rdFilter: true }));
  assert.ok(score(tagged, { runtimeMin: 24, rdFilter: true }) > -100, "penalty, not a gate");
});

test("rankByQuality: rdFilter reorders, never drops", () => {
  const list = [
    rel("Show S01E04 1080p WEB-DL DDP5.1", 3),
    rel("[Group] Show - 04 (1080p)", 1.4),
  ];
  const { list: ranked } = rankByQuality(list, { runtimeMin: 24, rdFilter: true });
  assert.equal(ranked.length, 2, "the tagged release must stay available");
  assert.equal(ranked[0].name, "[Group] Show - 04 (1080p)");
});

// ---------- episode numbers must not read as channel layouts ----------
test("parseAudio: bare two-digit tokens are not channel counts", () => {
  // "- 51" is episode fifty-one, not 5.1 surround; "- 20" is not stereo.
  assert.equal(parseAudio("[SubsPlease] Bleach - 51 (1080p)").channels, null);
  assert.equal(parseAudio("[SubsPlease] Frieren - 20 (1080p)").channels, null);
  // The real forms keep working, welded or spaced, dotted or underscored.
  assert.equal(parseAudio("Show.DDP5.1.WEB-DL").channels, 6);
  assert.equal(parseAudio("Movie_2160p_TrueHD_7_1").channels, 8);
  assert.equal(parseAudio("Show AAC 2.0").channels, 2);
});

// ---------- the SubsPlease candidate shape: no size, no seeders ----------
//
// Its API publishes neither. Both must read as UNKNOWN: a missing size cannot
// fail the bitrate floor, and missing seeders cannot read as a dead torrent.
test("meetsFloor/looksFetchable: absent size and seeders are unknown, not zero", async () => {
  const { looksFetchable } = await import("../lib/quality.mjs");
  const c = { name: "[SubsPlease] Show - 04 (1080p) [ABCD1234].mkv", size: 0, magnet: "magnet:x" };
  assert.equal(meetsFloor(c, { runtimeMin: 24, minResolution: 1080 }).ok, true);
  assert.equal(looksFetchable(c), true);
  const { list } = rankByQuality([c], { runtimeMin: 24 });
  assert.equal(list.length, 1, "must survive ranking with no bitrate evidence");
});
