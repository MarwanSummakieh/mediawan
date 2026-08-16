// Unit tests for the torrent-index pure logic: release-name parsing, quality
// detection, episode matching, ranking, and magnet building. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMovieName, parseQuality, releaseHasEpisode, rankReleases,
  rankReleasesVerbose, magnetFromHash,
} from "../lib/torrents.mjs";

// ---- parseMovieName: title/year out of a release string ----
test("parseMovieName: dotted name with year", () => {
  assert.deepEqual(parseMovieName("Inception.2010.1080p.BrRip.x264.YIFY.mp4"), { title: "Inception", year: 2010 });
});
test("parseMovieName: strips trailing paren from 'Title (Year)'", () => {
  assert.deepEqual(parseMovieName("Backrooms.(2026).1080p.WEB.mkv"), { title: "Backrooms", year: 2026 });
});
test("parseMovieName: no year → title trimmed at quality tag", () => {
  assert.equal(parseMovieName("Some Movie 1080p BluRay").title, "Some Movie");
});

// ---- parseQuality ----
test("parseQuality: resolutions and 4k", () => {
  assert.equal(parseQuality("Movie 2160p UHD"), 2160);
  assert.equal(parseQuality("Movie 1080p"), 1080);
  assert.equal(parseQuality("Movie 720p"), 720);
  assert.equal(parseQuality("Movie DVDRip"), 0);
});

// ---- releaseHasEpisode: match the wanted number, not years/resolution ----
test("releaseHasEpisode: matches '- 07' and 'E07' and 'S01E07'", () => {
  assert.ok(releaseHasEpisode("[SubsPlease] Frieren - 07 (1080p)", 7));
  assert.ok(releaseHasEpisode("Show E07 [1080p]", 7));
  assert.ok(releaseHasEpisode("Show S01E07 1080p", 7));
});
test("releaseHasEpisode: does not match year/resolution digits", () => {
  assert.equal(releaseHasEpisode("Movie 2010 1080p", 10), false);
  assert.equal(releaseHasEpisode("Show - 05 (1080p)", 10), false);
});
test("releaseHasEpisode: non-numeric ep → always true (can't filter)", () => {
  assert.ok(releaseHasEpisode("whatever", "movie"));
});

// ---- ranking (delegates to lib/quality.mjs; see test/quality.test.mjs) ----
test("rankReleases: orders best-first and tags quality", () => {
  const ranked = rankReleases([
    { name: "Movie 2010 1080p WEBRip x264", seeders: 5 },
    { name: "Movie 2010 2160p BluRay REMUX TrueHD 7.1", seeders: 40 },
    { name: "Movie 2010 1080p BluRay REMUX DTS-HD MA 5.1", seeders: 900 },
  ]);
  assert.equal(ranked[0].quality, 2160); // 4K REMUX leads despite the fewest seeders
  assert.equal(ranked[ranked.length - 1].quality, 1080);
  assert.match(ranked[ranked.length - 1].name, /WEBRip/);
});

test("rankReleases: the floor drops sub-1080p and junk", () => {
  const ranked = rankReleases([
    { name: "Movie 2010 480p", seeders: 5 },
    { name: "Movie 2010 1080p BluRay", seeders: 900 },
    { name: "Movie 2010 CAM", seeders: 2000 },
  ]);
  assert.equal(ranked.length, 1);
  assert.match(ranked[0].name, /1080p/);
});

test("rankReleases: a thin field degrades instead of returning nothing", () => {
  // Everything is below the floor — an unplayable screen would be worse than
  // the best of a bad lot, so the floor is dropped rather than the results.
  const ranked = rankReleases([
    { name: "Obscure Film 720p WEB-DL", seeders: 3 },
    { name: "Obscure Film 480p DVDRip", seeders: 1 },
  ]);
  assert.equal(ranked.length, 2);
  assert.match(ranked[0].name, /720p/);
});

test("rankReleasesVerbose: says what was dropped and whether the floor held", () => {
  const strong = rankReleasesVerbose([
    { name: "Movie 1080p WEB-DL DDP5.1", seeders: 100 },
    { name: "Movie 720p WEB-DL", seeders: 100 },
  ]);
  assert.equal(strong.floorApplied, true);
  assert.equal(strong.list.length, 1);
  assert.equal(strong.rejected.length, 1);

  const thin = rankReleasesVerbose([{ name: "Movie 720p WEB-DL", seeders: 100 }]);
  assert.equal(thin.floorApplied, false);
  assert.equal(thin.list.length, 1);
});

// ---- magnet building ----
test("magnetFromHash: btih + name + trackers", () => {
  const m = magnetFromHash("ABCDEF", "Some Movie");
  assert.match(m, /^magnet:\?xt=urn:btih:ABCDEF/);
  assert.match(m, /dn=Some%20Movie/);
  assert.match(m, /tr=udp/);
});

// ---------- Nyaa RSS parsing ----------
// Added when AnimeTosho's mirror went stale (nothing indexed after 2026-05-08),
// which had silently reduced the debrid tier to zero candidates for every
// currently-airing show. Nyaa has no JSON API, so its RSS is parsed directly.

test("parseNyaaSize: RSS size strings to bytes", async () => {
  const { parseNyaaSize } = await import("../lib/torrents.mjs");
  assert.equal(parseNyaaSize("297.3 MiB"), Math.round(297.3 * 1024 ** 2));
  assert.equal(parseNyaaSize("1.4 GiB"), Math.round(1.4 * 1024 ** 3));
  assert.equal(parseNyaaSize("818.9 MiB"), Math.round(818.9 * 1024 ** 2));
  // Unparseable → 0, which the ranker reads as "unknown" rather than "tiny".
  assert.equal(parseNyaaSize("who knows"), 0);
  assert.equal(parseNyaaSize(null), 0);
});

test("parseNyaaRss: extracts name, hash, seeders and size", async () => {
  const { parseNyaaRss } = await import("../lib/torrents.mjs");
  const xml = `<rss><channel>
    <item>
      <title>[ASW] Grand Blue S3 - 04 [1080p HEVC x265 10Bit][AAC]</title>
      <nyaa:seeders>129</nyaa:seeders>
      <nyaa:infoHash>6597456aaef7ee68f60e29a07b90ebc22f1ebdd6</nyaa:infoHash>
      <nyaa:size>297.3 MiB</nyaa:size>
    </item>
    <item>
      <title>Broken entry &amp; no hash</title>
      <nyaa:seeders>5</nyaa:seeders>
      <nyaa:infoHash>not-a-hash</nyaa:infoHash>
      <nyaa:size>1.0 GiB</nyaa:size>
    </item>
  </channel></rss>`;
  const rows = parseNyaaRss(xml);
  assert.equal(rows.length, 1, "entries without a valid infoHash are unusable");
  assert.equal(rows[0].name, "[ASW] Grand Blue S3 - 04 [1080p HEVC x265 10Bit][AAC]");
  assert.equal(rows[0].hash, "6597456aaef7ee68f60e29a07b90ebc22f1ebdd6");
  assert.equal(rows[0].seeders, 129);
  assert.equal(rows[0].indexer, "nyaa");
  assert.match(rows[0].magnet, /^magnet:\?xt=urn:btih:6597456a/);
});

test("parseNyaaRss: decodes HTML entities in titles", async () => {
  const { parseNyaaRss } = await import("../lib/torrents.mjs");
  const xml = `<rss><item>
    <title>Show S01E01 &amp; friends &quot;special&quot;</title>
    <nyaa:infoHash>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</nyaa:infoHash>
    <nyaa:size>500 MiB</nyaa:size></item></rss>`;
  assert.equal(parseNyaaRss(xml)[0].name, 'Show S01E01 & friends "special"');
});

test("parseNyaaRss: empty or junk input yields no candidates", async () => {
  const { parseNyaaRss } = await import("../lib/torrents.mjs");
  assert.deepEqual(parseNyaaRss(""), []);
  assert.deepEqual(parseNyaaRss("<html>404</html>"), []);
});

// ---------- SubsPlease plumbing ----------
//
// Its magnets carry base32 infohashes; everything here (hash de-dup, debrid
// cache checks) speaks hex. 32 base32 chars = the 160-bit infohash exactly.
test("base32ToHex: round-trips a known infohash", async () => {
  const { base32ToHex } = await import("../lib/torrents.mjs");
  // AAAAA… is all zero bits; the mixed string exercises the full alphabet.
  assert.equal(base32ToHex("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), "0".repeat(40));
  // 31 × "7" (11111) then "A" (00000): 155 one-bits, then five zeros.
  assert.equal(base32ToHex("7777777777777777777777777777777A"), "f".repeat(38) + "e0");
  assert.equal(base32ToHex("not-base32"), null);
  assert.equal(base32ToHex(""), null);
});

test("hexHashFromMagnet: hex passes through, base32 converts, junk is null", async () => {
  const { hexHashFromMagnet } = await import("../lib/torrents.mjs");
  const hex = "a".repeat(40);
  assert.equal(hexHashFromMagnet(`magnet:?xt=urn:btih:${hex.toUpperCase()}&dn=x`), hex);
  assert.equal(hexHashFromMagnet("magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), "0".repeat(40));
  assert.equal(hexHashFromMagnet("magnet:?xt=urn:btih:short"), null);
  assert.equal(hexHashFromMagnet(null), null);
});

test("parseSubsPleaseDate: the API's US-style date becomes a timestamp", async () => {
  const { parseSubsPleaseDate } = await import("../lib/torrents.mjs");
  assert.equal(parseSubsPleaseDate("07/31/26"), Date.UTC(2026, 6, 31));
  assert.equal(parseSubsPleaseDate("12/01/2025"), Date.UTC(2025, 11, 1));
  assert.equal(parseSubsPleaseDate("yesterday"), null);
  assert.equal(parseSubsPleaseDate(null), null);
});

// ---------- batch ranges ----------
//
// A complete-season pack names a SPAN, not each episode. Rejecting those made
// every batch invisible to the episode filter — and once a sequel floods an
// index's capped feed, a batch can be the only surviving copy of an older
// season (the Frieren S1 regression).
test("releaseHasEpisode: a batch range contains its episodes", () => {
  assert.ok(releaseHasEpisode("[Judas] Sousou no Frieren (Season 1) [01-28] (1080p)", 13));
  assert.ok(releaseHasEpisode("Show S01 E01~E24 batch", 5));
  assert.equal(releaseHasEpisode("[Judas] Sousou no Frieren [01-28]", 29), false);
  // A year is not a range, and neither is a resolution.
  assert.equal(releaseHasEpisode("Movie 2010-2019 collection 1080p", 15), false);
});
