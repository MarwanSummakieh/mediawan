// Unit tests for the selectable-source layer behind the player's Servers panel.
// The two invariants that matter:
//   • a server id identifies a TORRENT (hash + file inside a pack), so it still
//     resolves after the ranked list behind it has been rebuilt;
//   • a favourite identifies a KIND of release (quality + source tag), so it
//     carries to the next episode instead of pinning one dead torrent.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  serverId, releaseGroup, serverLabel, releaseSignature,
  describeReleases, findRelease, preferSignatures, mergeReleases,
} from "../lib/servers.mjs";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);

test("serverId: infoHash, plus the file index when the episode sits in a pack", () => {
  assert.equal(serverId({ hash: HASH_A }), HASH_A);
  assert.equal(serverId({ hash: HASH_A, fileIdx: 3 }), `${HASH_A}:3`);
  assert.equal(serverId({ hash: HASH_A.toUpperCase() }), HASH_A); // case-insensitive
  // fileIdx 0 is a real index, not "absent"
  assert.equal(serverId({ hash: HASH_A, fileIdx: 0 }), `${HASH_A}:0`);
});

test("serverId: falls back to the magnet's btih when there's no hash field", () => {
  assert.equal(serverId({ magnet: `magnet:?xt=urn:btih:${HASH_B}&dn=x` }), HASH_B);
  assert.equal(serverId({ magnet: "magnet:?xt=nonsense" }), ""); // unusable → no id
  assert.equal(serverId(null), "");
});

test("releaseGroup: scene suffix, fansub prefix, or nothing", () => {
  assert.equal(releaseGroup("Inception.2010.1080p.BluRay.x264-SPARKS"), "SPARKS");
  assert.equal(releaseGroup("Movie.2019.2160p.WEB-DL-RARBG.mkv"), "RARBG");
  assert.equal(releaseGroup("[SubsPlease] Show - 07 (1080p) [A1B2C3].mkv"), "SubsPlease");
  assert.equal(releaseGroup("some.plain.release.1080p"), null);
});

test("serverLabel: the headline a row shows — quality band and source tag", () => {
  assert.equal(serverLabel({ quality: 2160, name: "Film.2014.2160p.BluRay.REMUX" }), "2160p REMUX");
  assert.equal(serverLabel({ name: "Film.2014.1080p.WEB-DL.x264" }), "1080p WEB-DL"); // quality parsed from the name
  assert.equal(serverLabel({ name: "[Judas] Show - 01" }), "Judas"); // no band/tag → the group carries it
});

test("releaseSignature: identical across titles, different across quality or source", () => {
  const a = releaseSignature({ name: "A.2010.1080p.WEB-DL.x264-FLUX", quality: 1080 });
  const b = releaseSignature({ name: "B.2021.1080p.WEB-DL.x265-EMBER", quality: 1080 });
  assert.equal(a, b); // the whole point: hearting one carries to the other
  assert.equal(a, "q1080|WEB-DL");
  assert.notEqual(a, releaseSignature({ name: "A.2010.1080p.BluRay", quality: 1080 }));
  assert.notEqual(a, releaseSignature({ name: "A.2010.720p.WEB-DL", quality: 720 }));
});

test("describeReleases: keeps ranked order, drops id-less and duplicate entries, caps the list", () => {
  const rows = describeReleases([
    { hash: HASH_A, name: "Film.2010.1080p.WEB-DL-FLUX", quality: 1080, seeders: 42 },
    { hash: HASH_A, name: "Film.2010.1080p.WEB-DL-FLUX", quality: 1080, seeders: 42 }, // dupe
    { name: "no hash, unplayable", quality: 720 },                                     // no id
    { hash: HASH_B, name: "Film.2010.2160p.BluRay.REMUX", quality: 2160, seeders: 7, fileIdx: 2 },
  ]);
  assert.deepEqual(rows.map((r) => r.id), [HASH_A, `${HASH_B}:2`]);
  assert.equal(rows[0].label, "1080p WEB-DL");
  assert.equal(rows[0].group, "FLUX");
  assert.equal(rows[0].seeders, 42);
  assert.equal(describeReleases(Array.from({ length: 50 },
    (_, i) => ({ hash: String(i).padStart(40, "0"), name: `R${i}.1080p` })), 5).length, 5);
});

test("mergeReleases: unions indexers, first-seen wins, order preserved", () => {
  const torrentio = [{ hash: HASH_A, name: "A.1080p" }, { hash: HASH_B, name: "B.1080p", fileIdx: 2 }];
  const apibay = [{ hash: HASH_B, name: "B duplicate", fileIdx: 2 }, { hash: "c".repeat(40), name: "C.720p" }];
  const out = mergeReleases(torrentio, apibay);
  assert.deepEqual(out.map((c) => c.name), ["A.1080p", "B.1080p", "C.720p"]);
  assert.equal(out[1].fileIdx, 2); // Torrentio's copy survives — it carries the episode's file index
});

test("mergeReleases: an empty indexer contributes nothing and breaks nothing", () => {
  const only = [{ hash: HASH_A, name: "A" }];
  assert.deepEqual(mergeReleases([], only).map((c) => c.name), ["A"]);
  assert.deepEqual(mergeReleases(only, undefined).map((c) => c.name), ["A"]);
  assert.deepEqual(mergeReleases([], []), []);
});

test("mergeReleases: hash-less releases dedupe by name rather than collapsing", () => {
  const out = mergeReleases([{ name: "No hash 1" }, { name: "No hash 2" }], [{ name: "No hash 1" }]);
  assert.equal(out.length, 2);
});

test("findRelease: round-trips the id the client was given", () => {
  const list = [{ hash: HASH_A }, { hash: HASH_B, fileIdx: 4 }];
  assert.equal(findRelease(list, `${HASH_B}:4`), list[1]);
  assert.equal(findRelease(list, HASH_B), null); // pack file index is part of the identity
  assert.equal(findRelease(list, ""), null);
});

test("preferSignatures: favourites float up, everything else keeps its ranked order", () => {
  const list = [
    { hash: HASH_A, name: "A.2160p.BluRay", quality: 2160 },
    { hash: HASH_B, name: "B.1080p.WEB-DL", quality: 1080 },
    { hash: "c".repeat(40), name: "C.1080p.WEB-DL", quality: 1080 },
    { hash: "d".repeat(40), name: "D.720p.HDTV", quality: 720 },
  ];
  const out = preferSignatures(list, "q1080|WEB-DL");
  assert.deepEqual(out.map((c) => c.name[0]), ["B", "C", "A", "D"]);
  // no favourites, or none that match, must not disturb the ranking
  assert.equal(preferSignatures(list, ""), list);
  assert.equal(preferSignatures(list, "q480|CAM"), list);
});

// ---------- dead releases are not offered ----------
// A zero-seeder torrent can only play if the debrid service already has it
// cached; otherwise every attempt burns a full timeout and fails. See
// looksFetchable in lib/quality.mjs.

test("looksFetchable: zero seeders is dead, unknown is not", async () => {
  const { looksFetchable } = await import("../lib/quality.mjs");
  assert.equal(looksFetchable({ seeders: 0 }), false);
  assert.equal(looksFetchable({ seeders: 3 }), true);
  // A cache hit needs no seeders at all.
  assert.equal(looksFetchable({ seeders: 0, cached: true }), true);
  // Absent data is not evidence of a dead torrent — some indexers omit it.
  assert.equal(looksFetchable({}), true);
  assert.equal(looksFetchable({ seeders: null }), true);
});

test("describeReleases: drops unfetchable releases", () => {
  const rows = describeReleases([
    { name: "Film.2020.1080p.WEB-DL.x264-A", hash: "a".repeat(40), seeders: 50 },
    { name: "Film.2020.2160p.REMUX-DEAD", hash: "b".repeat(40), seeders: 0 },
    { name: "Film.2020.1080p.BluRay-C", hash: "c".repeat(40), seeders: 7 },
  ]);
  assert.deepEqual(rows.map((r) => r.seeders), [50, 7]);
});

test("describeReleases: an all-dead list is kept — one may still be cached", () => {
  const rows = describeReleases([
    { name: "Old.Film.1974.1080p.BluRay-A", hash: "d".repeat(40), seeders: 0 },
    { name: "Old.Film.1974.720p.DVDRip-B", hash: "e".repeat(40), seeders: 0 },
  ]);
  assert.equal(rows.length, 2, "never leave the viewer with an empty panel");
});
