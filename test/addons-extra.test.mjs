// Extra Stremio addons — indexer redundancy expressed as CONFIGURATION.
//
// Torrentio scrapes a dozen indexers, which reads like redundancy but isn't:
// it is one hosted service, and when it is down Movies and TV fall back to
// apibay, which is one site. STREMIO_ADDONS adds arbitrarily many more legs
// without new scraping code, so the failure mode being pinned here is the
// operational one — a dead or misconfigured addon must cost nothing.
//
// No network: fetch is stubbed. Run with: npm test
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Read at import time, so the environment has to be set before the import.
// Deliberately messy: a trailing slash, a pasted manifest URL, a blank entry
// and a junk entry — all four are things people actually paste.
process.env.STREMIO_ADDONS = [
  "https://mediafusion.elfhosted.com/D-aBc123/",
  "https://comet.example.org/cfg/manifest.json",
  "",
  "not-a-url",
].join(",");

const { extraAddonReleases, extraAddons, addonLabel, parseAddonStream } =
  await import("../lib/stremio/addons.mjs");

const realFetch = globalThis.fetch;
let calls = [];

const stream = (hash, title = "Inception 2010 1080p BluRay") => ({
  name: "Addon\n1080p",
  title: `${title}\n👤 42 💾 8.1 GB ⚙️ SomeIndexer`,
  infoHash: hash,
});

// route: hostname -> streams array | Error
function stub(routes) {
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u.href);
    const hit = routes[u.hostname];
    if (hit instanceof Error) throw hit;
    return new Response(JSON.stringify({ streams: hit ?? [] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
}

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

test("parses the addon list, dropping blanks and non-URLs", () => {
  assert.deepEqual(extraAddons(), [
    "https://mediafusion.elfhosted.com/D-aBc123",
    "https://comet.example.org/cfg",
  ]);
});

test("a pasted manifest URL is repaired rather than 404ing forever", () => {
  // What an addon's UI shows you is the manifest; left alone it would build
  // /manifest.json/stream/movie/tt….json and fail every single request.
  assert.ok(!extraAddons().some((b) => /manifest\.json/.test(b)));
});

test("labels rows by host so the Servers panel can name the source", () => {
  assert.equal(addonLabel("https://mediafusion.elfhosted.com/D-aBc123"), "mediafusion.elfhosted.com");
  assert.equal(addonLabel("https://www.comet.example.org/x"), "comet.example.org");
  assert.equal(addonLabel("garbage"), "addon");
});

test("queries every configured addon and merges the results", async () => {
  stub({
    "mediafusion.elfhosted.com": [stream("a".repeat(40))],
    "comet.example.org": [stream("b".repeat(40))],
  });
  const out = await extraAddonReleases("movie", "tt1375666");
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.indexer).sort(),
    ["comet.example.org", "mediafusion.elfhosted.com"]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.endsWith("/stream/movie/tt1375666.json")));
});

test("one addon failing does not affect the other", async () => {
  stub({
    "mediafusion.elfhosted.com": new Error("ETIMEDOUT"),
    "comet.example.org": [stream("b".repeat(40))],
  });
  const out = await extraAddonReleases("movie", "tt1375666");
  assert.equal(out.length, 1, "the healthy addon still contributes");
  assert.equal(out[0].indexer, "comet.example.org");
});

test("every addon failing yields [] rather than throwing at the caller", async () => {
  stub({
    "mediafusion.elfhosted.com": new Error("down"),
    "comet.example.org": new Error("down"),
  });
  assert.deepEqual(await extraAddonReleases("movie", "tt1375666"), []);
});

test("debrid/external entries without an infoHash are skipped", async () => {
  // Configured addons commonly return already-resolved debrid links; there is
  // no magnet in those and the whole pipeline downstream takes a magnet.
  stub({
    "mediafusion.elfhosted.com": [{ title: "x", url: "https://real-debrid.com/d/x" }, stream("c".repeat(40))],
    "comet.example.org": [],
  });
  const out = await extraAddonReleases("movie", "tt1375666");
  assert.equal(out.length, 1);
  assert.equal(out[0].hash, "c".repeat(40));
});

test("release rows carry a magnet and the addon's own label", async () => {
  stub({ "mediafusion.elfhosted.com": [stream("d".repeat(40))], "comet.example.org": [] });
  const [r] = await extraAddonReleases("movie", "tt1375666");
  assert.match(r.magnet, /^magnet:\?xt=urn:btih:d{40}/);
  assert.match(r.magnet, /tr=/);
  assert.equal(r.seeders, 42);
  assert.equal(r.indexer, "mediafusion.elfhosted.com");
});

test("parseAddonStream still defaults to the torrentio label", () => {
  // torrentioReleases leans on the default; changing it would silently relabel
  // every Torrentio row in the Servers panel.
  assert.equal(parseAddonStream(stream("e".repeat(40))).indexer, "torrentio");
});

// ---- the important one: unconfigured must change nothing ----
test("with no STREMIO_ADDONS set it returns [] without touching the network", async () => {
  const saved = process.env.STREMIO_ADDONS;
  delete process.env.STREMIO_ADDONS;
  try {
    const fresh = await import("../lib/stremio/addons.mjs?no-addons");
    globalThis.fetch = async () => { throw new Error("must not be called"); };
    assert.deepEqual(fresh.extraAddons(), []);
    assert.deepEqual(await fresh.extraAddonReleases("movie", "tt1375666"), []);
  } finally {
    process.env.STREMIO_ADDONS = saved;
  }
});
