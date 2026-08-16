// VidLink — the floor tier for Movies and TV.
//
// What matters here is not the happy path (their API is simple) but the
// boundary: this source runs a third-party WebAssembly binary, so "disabled"
// must mean genuinely inert, and every failure must degrade to "the debrid
// tier's answer, unchanged" rather than breaking a play.
//
// No network and no WASM: the token module is stubbed, so nothing here fetches
// or executes anything. Run with: npm test
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.VIDLINK = "true";

// The sandbox is injected rather than mocked: the real one downloads 2.4 MB of
// Go/WASM and runs it, which a unit test must never do.
const tokenFn = async (id) => `token-for-${id}`;

const { movieStreams, episodeStreams, vidlinkEnabled } =
  await import("../lib/providers/vidlink.mjs");

const realFetch = globalThis.fetch;
let calls = [];

// A trimmed copy of a real response (Antz, verified live).
const payload = (over = {}) => ({
  sourceId: "mbVault",
  stream: {
    id: "primary", type: "file", deliveryType: "file", TTL: 3600,
    qualities: {
      360: q(360), 480: q(480), 720: q(720), 1080: q(1080),
    },
    captions: [
      { id: "1", url: "https://cacdn.example/en.srt", language: "English", type: "srt" },
      { id: "2", url: "https://cacdn.example/fr.srt", language: "Français", type: "srt" },
    ],
    ...over,
  },
});
const q = (n) => ({
  type: "mp4",
  url: `https://bcdnxw.example/${n}.mp4?sign=abc&t=1`,
  headers: { referer: "https://filmboom.top/", origin: "https://filmboom.top" },
  requiresProxy: true,
});

function stub(body, { status = 200 } = {}) {
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers || {} });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  };
}

beforeEach(() => { calls = []; process.env.VIDLINK = "true"; });
afterEach(() => { globalThis.fetch = realFetch; });

// ---- shape ----

test("qualities become streams, best first, with the proxy headers attached", async () => {
  stub(payload());
  const out = await movieStreams("tt0120587", { tokenFn });
  assert.deepEqual(out.map((s) => s.quality), ["1080", "720", "480", "360"]);
  const [best] = out;
  assert.equal(best.type, "mp4", "they serve progressive MP4 — calling it hls breaks the play");
  assert.equal(best.referer, "https://filmboom.top/");
  assert.equal(best.origin, "https://filmboom.top");
  assert.equal(best.tier, "floor", "must never outrank a release file");
  assert.equal(best.provider, "vidlink");
});

test("the row names the upstream vault, which differs in quality", async () => {
  stub(payload());
  const [s] = await movieStreams("tt0120587", { tokenFn });
  assert.match(s.source, /VidLink \(mbVault\)/);
  assert.match(s.source, /1080p/);
});

test("captions ride along as soft subtitle tracks", async () => {
  stub(payload());
  const [s] = await movieStreams("tt0120587", { tokenFn });
  assert.deepEqual(s.providerSubs.map((t) => t.lang), ["English", "Français"]);
  assert.equal(s.providerSubs[0].format, "srt");
});

// ---- the no-ads lock ----
//
// Server-side extraction removes every ad on their page by construction. The
// only remaining way an ad reaches the viewer is server-side insertion, and
// that needs a PLAYLIST to splice into — a progressive MP4 is one static file
// with nowhere to put one. So HLS is refused by default.

test("an HLS-only response yields nothing, and says why", async () => {
  stub(payload({ qualities: { 1080: { ...q(1080), type: "hls", url: "https://x.example/a.m3u8" } } }));
  const out = await movieStreams("tt0120587", { tokenFn });
  assert.equal(out.length, 0, "a playlist can carry ad breaks; an MP4 cannot");
  assert.match(out.note, /ad breaks/);
});

test("a mixed response keeps the MP4 and drops the playlist", async () => {
  stub(payload({ qualities: {
    1080: { ...q(1080), type: "hls", url: "https://x.example/a.m3u8" },
    720: q(720),
  } }));
  const out = await movieStreams("tt0120587", { tokenFn });
  assert.deepEqual(out.map((s) => s.quality), ["720"]);
});

test("a .m3u8 url is caught even when the payload calls it mp4", async () => {
  stub(payload({ qualities: { 1080: { ...q(1080), type: "mp4", url: "https://x.example/a.m3u8" } } }));
  const out = await movieStreams("tt0120587", { tokenFn });
  assert.equal(out.length, 0, "the extension decides, not their label");
});

test("VIDLINK_ALLOW_HLS still refuses a playlist carrying splice markers", async () => {
  process.env.VIDLINK_ALLOW_HLS = "true";
  const fresh = await import("../lib/providers/vidlink.mjs?allow-hls");
  const spliced = "#EXTM3U\n#EXT-X-CUE-OUT:30.0\n#EXTINF:6,\nad0.ts\n#EXT-X-CUE-IN\n#EXTINF:6,\nseg0.ts\n";
  globalThis.fetch = async (url) => new Response(
    String(url).endsWith(".m3u8") ? spliced : JSON.stringify(payload({
      qualities: { 1080: { ...q(1080), type: "hls", url: "https://x.example/a.m3u8" } } })),
    { status: 200, headers: { "content-type": "application/json" } });
  try {
    const out = await fresh.movieStreams("tt0120587", { tokenFn });
    assert.equal(out.length, 0, "CUE-OUT is an ad break — refuse it");
  } finally { delete process.env.VIDLINK_ALLOW_HLS; }
});

test("VIDLINK_ALLOW_HLS accepts a playlist with no splice markers", async () => {
  process.env.VIDLINK_ALLOW_HLS = "true";
  const fresh = await import("../lib/providers/vidlink.mjs?allow-hls-clean");
  const clean = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.ts\n#EXTINF:6,\nseg1.ts\n#EXT-X-ENDLIST\n";
  globalThis.fetch = async (url) => new Response(
    String(url).endsWith(".m3u8") ? clean : JSON.stringify(payload({
      qualities: { 1080: { ...q(1080), type: "hls", url: "https://x.example/a.m3u8" } } })),
    { status: 200, headers: { "content-type": "application/json" } });
  try {
    const out = await fresh.movieStreams("tt0120587", { tokenFn });
    assert.equal(out.length, 1);
    assert.equal(out[0].type, "hls");
  } finally { delete process.env.VIDLINK_ALLOW_HLS; }
});

test("an unreadable playlist fails CLOSED — unproven is not clean", async () => {
  process.env.VIDLINK_ALLOW_HLS = "true";
  const fresh = await import("../lib/providers/vidlink.mjs?allow-hls-down");
  globalThis.fetch = async (url) => String(url).endsWith(".m3u8")
    ? new Response("", { status: 503 })
    : new Response(JSON.stringify(payload({
        qualities: { 1080: { ...q(1080), type: "hls", url: "https://x.example/a.m3u8" } } })),
        { status: 200, headers: { "content-type": "application/json" } });
  try {
    const out = await fresh.movieStreams("tt0120587", { tokenFn });
    assert.equal(out.length, 0, "a floor stream is optional; an ad is not acceptable");
  } finally { delete process.env.VIDLINK_ALLOW_HLS; }
});

// ---- the request ----

test("movies are keyed by IMDb id and send the capability header", async () => {
  stub(payload());
  await movieStreams("tt0120587", { tokenFn });
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, "/api/b/movie/token-for-tt0120587");
  assert.equal(u.searchParams.get("multiLang"), "0");
  assert.equal(calls[0].headers["X-Playback-Environment"], "standard",
    "the API answers differently without it");
});

test("TV is keyed by TMDB series id — an IMDb id there is a 500 upstream", async () => {
  stub(payload());
  await episodeStreams("1396", 1, 1, { tokenFn });
  assert.equal(new URL(calls[0].url).pathname, "/api/b/tv/token-for-1396/1/1");
});

test("an IMDb id passed to the TV path is refused before any request", async () => {
  stub(payload());
  const out = await episodeStreams("tt0903747", 1, 1, { tokenFn });
  assert.equal(out.length, 0);
  assert.match(out.note, /TMDB series id/);
  assert.equal(calls.length, 0, "no point spending a request on a known-bad id");
});

// ---- failure modes ----

test("a title they don't have is a note, not an error", async () => {
  // They answer 200 with a near-empty body rather than 404.
  stub("null");
  const out = await movieStreams("tt0000001", { tokenFn });
  assert.equal(out.length, 0);
  assert.match(out.note, /no copy/);
});

test("a rejected token throws so the caller's .catch() falls back", async () => {
  stub("", { status: 403 });
  await assert.rejects(() => movieStreams("tt0120587", { tokenFn }), /rejected the token/);
});

test("an upstream 5xx throws rather than reporting an empty catalogue", async () => {
  stub("", { status: 502 });
  await assert.rejects(() => movieStreams("tt0120587", { tokenFn }), /502/);
});

test("a payload with no qualities is a note, not a crash", async () => {
  stub({ sourceId: "mbVault", stream: { id: "primary", captions: [] } });
  const out = await movieStreams("tt0120587", { tokenFn });
  assert.equal(out.length, 0);
  assert.match(out.note, /no playable quality/);
});

// ---- the important one: disabled must be genuinely inert ----

test("disabled returns [] and never touches the network", async () => {
  process.env.VIDLINK = "false";
  globalThis.fetch = async () => { throw new Error("must not be called"); };
  assert.equal(vidlinkEnabled(), false);
  const m = await movieStreams("tt0120587", { tokenFn });
  const e = await episodeStreams("1396", 1, 1, { tokenFn });
  assert.deepEqual([...m], []);
  assert.deepEqual([...e], []);
  assert.match(m.note, /not enabled/);
});
