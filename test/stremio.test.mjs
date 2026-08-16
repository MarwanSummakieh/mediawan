// Unit tests for the Stremio addon client's pure parts: mapping Cinemeta metas
// to card shape and Torrentio stream entries to the repo's release shape.
// No network. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromCinemeta, parseTorrentioStream, preferQuality } from "../lib/stremio/addons.mjs";

test("fromCinemeta: maps a catalog meta to the card shape", () => {
  const card = fromCinemeta({
    id: "tt0468569", name: "The Dark Knight", releaseInfo: "2008",
    poster: "https://img/p.jpg", background: "https://img/b.jpg",
    description: "Batman.", imdbRating: "9.0", runtime: "152 min",
  });
  assert.deepEqual(card, {
    id: "tt0468569", title: "The Dark Knight", year: 2008,
    poster: "https://img/p.jpg", backdrop: "https://img/b.jpg",
    overview: "Batman.", rating: 90, runtime: 152,
  });
});

test("fromCinemeta: runtime is parsed to minutes for the quality ranker", () => {
  // Without a runtime the bitrate floor can't be applied, so a 1.6 GB re-encode
  // and a 30 GB remux are indistinguishable by name alone.
  assert.equal(fromCinemeta({ id: "tt1", runtime: "148 min" }).runtime, 148);
  assert.equal(fromCinemeta({ id: "tt1" }).runtime, null);
  assert.equal(fromCinemeta({ id: "tt1", runtime: "" }).runtime, null);
});

test("fromCinemeta: tolerates a year range and missing fields", () => {
  const card = fromCinemeta({ id: "tt0944947", name: "Game of Thrones", releaseInfo: "2011-2019" });
  assert.equal(card.year, 2011);
  assert.equal(card.poster, null);
  assert.equal(card.rating, null);
});

test("parseTorrentioStream: release name, seeders and fileIdx from display strings", () => {
  const rel = parseTorrentioStream({
    name: "Torrentio\n1080p",
    title: "Show.S01E02.1080p.WEB.x264-GROUP\n👤 89 💾 1.4 GB ⚙️ EZTV",
    infoHash: "a".repeat(40),
    fileIdx: 3,
  });
  assert.equal(rel.name, "Show.S01E02.1080p.WEB.x264-GROUP");
  assert.equal(rel.seeders, 89);
  assert.equal(rel.fileIdx, 3);
  assert.match(rel.magnet, /^magnet:\?xt=urn:btih:a{40}/);
});

test("parseTorrentioStream: null for debrid/external entries without infoHash", () => {
  assert.equal(parseTorrentioStream({ url: "https://real-debrid.com/d/x" }), null);
});

test("parseTorrentioStream: missing seeders/fileIdx degrade to 0/null", () => {
  const rel = parseTorrentioStream({ title: "Some.Release.720p", infoHash: "b".repeat(40) });
  assert.equal(rel.seeders, 0);
  assert.equal(rel.fileIdx, null);
});

test("preferQuality: 2160p now leads (it used to be ranked below 480p)", () => {
  const r = (name) => ({ name, seeders: 0 });
  const out = preferQuality([
    r("Good.1080p.first"), r("Other.720p"), r("Pack.2160p.A"), r("NoQuality"),
  ]);
  assert.equal(out[0].name, "Pack.2160p.A");
  assert.equal(out[0].quality, 2160);
  // 720p and untagged releases sink below the 1080p entry.
  assert.ok(out.findIndex((x) => x.name === "Good.1080p.first") <
            out.findIndex((x) => x.name === "Other.720p"));
});

test("preferQuality: Torrentio's own order breaks ties within a quality bucket", () => {
  // Torrentio's ordering encodes which release actually holds the requested
  // episode, so comparable releases must NOT be reshuffled on scoring noise.
  const r = (name) => ({ name, seeders: 0 });
  const out = preferQuality([r("A.1080p.WEB-DL.DDP5.1"), r("B.1080p.WEB-DL.DDP5.1")]);
  assert.deepEqual(out.map((x) => x.name), ["A.1080p.WEB-DL.DDP5.1", "B.1080p.WEB-DL.DDP5.1"]);
});
