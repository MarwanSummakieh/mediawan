// Unit tests for the provider registry: tier ordering, cross-provider fallback,
// typed failures and the circuit breaker. No network. Run with: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getProvidersHealth, providers, resolveStreams, classifyError, resetProvidersHealth } from "../lib/providers/index.mjs";

// A mock provider whose match/resolve behavior we control, for exercising the
// cross-provider fallback without touching the network.
const mockProvider = (name, { match = true, streams = [], tier = "quality" } = {}) => ({
  name, label: name, tier,
  async match() { return match ? { id: name } : null; },
  async episodes() { return { sub: streams.map((_, i) => String(i + 1)), dub: [] }; },
  async resolve() { return streams; },
});
const meta = { anilistId: 1, romaji: "Test", title: "Test", episodes: 12, duration: 24 };

// Provider health (and its circuit breakers) is module-level state shared by
// every case in this file — without a reset, one test blocking a provider
// leaves its breaker open for the next one that reuses the name.
beforeEach(() => resetProvidersHealth());

// ---------- registry: shape + priority ----------

test("providers: every registered anime source is the quality tier", () => {
  assert.deepEqual(providers.map((p) => p.name), ["subsplease", "nyaa", "debrid", "torrentio"]);
  // The debrid-backed sources LEAD. They used to be lazy last resorts, behind
  // scrapers serving 1.5-3 Mbps re-encodes — which capped quality at exactly
  // the tier this app is meant to avoid.
  // Four of them, each with its own breaker: every one has been observed
  // failing alone (AnimeTosho stale since 2026-05-08, Torrentio's Kitsu index
  // missing whole shows), and a shared breaker let one take the others down.
  // SubsPlease is FIRST: first-party and live to the minute, and its untagged
  // release names are the ones Real-Debrid's takedown filter accepts.
  assert.equal(providers.find((p) => p.name === "subsplease").tier, "quality");
  assert.equal(providers.find((p) => p.name === "nyaa").tier, "quality");
  assert.equal(providers.find((p) => p.name === "debrid").tier, "quality");
  assert.equal(providers.find((p) => p.name === "torrentio").tier, "quality");
  // …and NOTHING is registered as floor. Anime's floor source was removed on
  // 2026-08-06 and nothing replaced it, so an anime play waits for the debrid
  // release. Asserted rather than left implicit: the tier machinery is still
  // live (Movies and TV use it via lib/providers/vidlink.mjs), so an empty
  // floor here is a deliberate state, not an accident of registration.
  assert.equal(providers.filter((p) => p.tier === "floor").length, 0);
});

// ---------- fetch-on-demand plumbing ----------
//
// When nothing serves, a quality provider can name the release worth FETCHING
// (fetchCandidate rides on the empty array, like `note`). The registry must
// carry it to the play route — and must prefer the first provider's answer,
// because the list is in preference order.
test("resolveStreams: fetchCandidate survives the empty-result path, first provider wins", async () => {
  const withFc = (name, fc) => ({
    name, label: name, tier: "quality",
    async match() { return { id: name }; },
    async resolve() { return Object.assign([], { fetchCandidate: fc }); },
  });
  const list = [
    withFc("a", { magnet: "magnet:a", name: "A" }),
    withFc("b", { magnet: "magnet:b", name: "B" }),
  ];
  const out = await resolveStreams(meta, "1", "sub", list);
  assert.equal(out.length, 0);
  assert.equal(out.fetchCandidate.name, "A");
});

test("resolveStreams: no fetchCandidate when a stream actually served", async () => {
  const list = [mockProvider("ok", { streams: [s("ok", "1080")] })];
  const out = await resolveStreams(meta, "1", "sub", list);
  assert.equal(out.length, 1);
  assert.equal(out.fetchCandidate, undefined);
});

test("getProvidersHealth: one entry per provider, starts unknown", () => {
  const h = getProvidersHealth();
  assert.equal(h.length, providers.length);
  for (const p of h) {
    assert.ok(typeof p.name === "string" && typeof p.label === "string");
    assert.ok(["unknown", "ok", "no-match", "no-sources", "error"].includes(p.status));
  }
});

// An unconfigured provider declines every title, which lands as "no-match" —
// a status that means "not in this index", explicitly NOT a fault. Reported as
// such, a box with no credentials at all looks perfectly healthy. `configured`
// is what lets the admin panel say "not set up" instead.
test("getProvidersHealth: reports whether each source is configured at all", () => {
  const h = getProvidersHealth();
  for (const p of h) assert.equal(typeof p.configured, "boolean");
  // Every real provider here needs credentials, so each must declare how to
  // tell — a provider that needs none simply omits `available`.
  for (const p of providers) {
    assert.equal(typeof p.available, "function", `${p.name} must report configuration state`);
    assert.equal(h.find((x) => x.name === p.name).configured, !!p.available());
  }
});

// ---------- cross-provider fallback: the core uptime guarantee ----------

const s = (provider, quality) => ({ provider, quality, url: `http://x/${provider}/${quality}`, type: "hls", referer: "", source: `${provider} ${quality}` });

test("resolveStreams: concatenates in priority order, primary first", async () => {
  const list = [
    mockProvider("primary", { streams: [s("primary", "1080")] }),
    mockProvider("fallback", { streams: [s("fallback", "720")] }),
  ];
  const out = await resolveStreams(meta, "1", "sub", list);
  assert.deepEqual(out.map((x) => x.provider), ["primary", "fallback"]);
});

test("resolveStreams: a dead primary still yields the fallback's streams", async () => {
  // primary matches but returns no sources (e.g. AllAnime mid-rotation)
  const list = [
    mockProvider("primary", { streams: [] }),
    mockProvider("fallback", { streams: [s("fallback", "720")] }),
  ];
  const out = await resolveStreams(meta, "1", "sub", list);
  assert.equal(out.length, 1);
  assert.equal(out[0].provider, "fallback"); // streaming stays up on the fallback
});

test("resolveStreams: a throwing provider doesn't sink the others", async () => {
  const boom = { name: "boom", label: "boom", async match() { throw new Error("down"); }, async resolve() { return []; } };
  const list = [boom, mockProvider("fallback", { streams: [s("fallback", "720")] })];
  const out = await resolveStreams(meta, "1", "sub", list);
  assert.deepEqual(out.map((x) => x.provider), ["fallback"]);
});

test("resolveStreams: empty when every provider strikes out", async () => {
  const list = [mockProvider("a", { streams: [] }), mockProvider("b", { match: false })];
  assert.equal((await resolveStreams(meta, "1", "sub", list)).length, 0);
});

test("resolveStreams: BOTH tiers are kept — quality first, floor behind it", async () => {
  // The old lazy branch did `out = streams`, REPLACING the eager results, so a
  // play could never see both tiers at once. The player walks streams[i+1] on
  // failure, so discarding a whole tier threw away the fallback ladder.
  const list = [
    mockProvider("rd", { streams: [s("rd", "1080")], tier: "quality" }),
    mockProvider("embed", { streams: [s("embed", "720")], tier: "floor" }),
  ];
  const out = await resolveStreams(meta, "1", "sub", list);
  assert.deepEqual(out.map((x) => x.provider), ["rd", "embed"]);
});

test("resolveStreams: quality streams compete on release score, not array order", async () => {
  // Measured live: the debrid provider's E-AC3 stereo web-dl was served over
  // Torrentio's REMUX with lossless 5.1, purely because `debrid` is listed
  // first. The better release must win regardless of provider position.
  const worse = { ...s("first", "1080"), score: 120 };
  const better = { ...s("second", "2160"), score: 260 };
  const list = [
    mockProvider("first", { streams: [worse], tier: "quality" }),
    mockProvider("second", { streams: [better], tier: "quality" }),
  ];
  const out = await resolveStreams(meta, "1", "sub", list);
  assert.deepEqual(out.map((x) => x.provider), ["second", "first"]);
});

test("resolveStreams: for a SEQUEL, a verified-identity source outranks a better-scoring guess", async () => {
  // A text-searched index returns whichever season its string match landed on.
  // Live failure: a dub request for "Shingeki no Kyojin Season 2" resolved to
  // "The Final Season Part 2". An id-mapped source cannot make that mistake, so
  // for sequels it leads even when the other source scored higher.
  const sequel = { ...meta, romaji: "Shingeki no Kyojin Season 2" };
  const guess = { ...s("guess", "1080"), score: 300, identityVerified: false };
  const known = { ...s("known", "1080"), score: 200, identityVerified: true };
  const list = [
    mockProvider("guess", { streams: [guess], tier: "quality" }),
    mockProvider("known", { streams: [known], tier: "quality" }),
  ];
  const out = await resolveStreams(sequel, "1", "sub", list);
  assert.deepEqual(out.map((x) => x.provider), ["known", "guess"]);
});

test("resolveStreams: for season 1, quality decides and both sources compete", async () => {
  // The text-searched index carries fansub and dual-audio releases the
  // id-mapped one often lacks; its inference is reliable when there is no
  // sequel to confuse it, so it must not be demoted here.
  const first = { ...meta, romaji: "Sousou no Frieren" };
  const guess = { ...s("guess", "2160"), score: 300, identityVerified: false };
  const known = { ...s("known", "1080"), score: 200, identityVerified: true };
  const list = [
    mockProvider("guess", { streams: [guess], tier: "quality" }),
    mockProvider("known", { streams: [known], tier: "quality" }),
  ];
  const out = await resolveStreams(first, "1", "sub", list);
  assert.deepEqual(out.map((x) => x.provider), ["guess", "known"]);
});

test("resolveStreams: unscored streams keep their relative order", async () => {
  const list = [
    mockProvider("a", { streams: [s("a", "1080")], tier: "quality" }),
    mockProvider("b", { streams: [s("b", "1080")], tier: "quality" }),
  ];
  const out = await resolveStreams(meta, "1", "sub", list);
  assert.deepEqual(out.map((x) => x.provider), ["a", "b"]);
});

test("resolveStreams: the floor tier carries the play when quality finds nothing", async () => {
  const list = [
    mockProvider("rd", { streams: [], tier: "quality" }),
    mockProvider("embed", { streams: [s("embed", "720")], tier: "floor" }),
  ];
  const out = await resolveStreams(meta, "1", "sub", list);
  assert.deepEqual(out.map((x) => x.provider), ["embed"]);
});

test("resolveStreams: a broken floor tier never fails the play", async () => {
  const boom = { name: "embed", label: "embed", tier: "floor",
    async match() { throw new Error("captcha"); }, async resolve() { return []; } };
  const list = [mockProvider("rd", { streams: [s("rd", "1080")], tier: "quality" }), boom];
  const out = await resolveStreams(meta, "1", "sub", list);
  assert.deepEqual(out.map((x) => x.provider), ["rd"]);
});

// ---------- typed failures + circuit breaker ----------

test("classifyError: a bot-gate is 'blocked', not a transient error", () => {
  // This is the distinction the old single-status model couldn't make: AllAnime's
  // NEED_CAPTCHA was retried forever as if it were a key rotation.
  assert.equal(classifyError(new Error("NEED_CAPTCHA")), "blocked");
  assert.equal(classifyError(new Error("Just a moment... cf-chl")), "blocked");
  assert.equal(classifyError(new Error("HTTP 429 Too Many Requests")), "rate-limited");
  assert.equal(classifyError(new Error("connect ETIMEDOUT")), "upstream-down");
  assert.equal(classifyError(new Error("something odd")), "error");
});

test("breaker: a repeatedly-failing provider stops being called", async () => {
  let calls = 0;
  const dead = { name: "dead", label: "dead", tier: "quality",
    async match() { calls++; throw new Error("NEED_CAPTCHA"); }, async resolve() { return []; } };
  const list = [dead, mockProvider("embed", { streams: [s("embed", "720")], tier: "floor" })];
  await resolveStreams(meta, "1", "sub", list);
  const after = calls;
  // Second play: the breaker is open, so the dead source costs nothing.
  const out = await resolveStreams(meta, "1", "sub", list);
  assert.equal(calls, after, "a blocked provider must not be retried on the next play");
  assert.deepEqual(out.map((x) => x.provider), ["embed"]);
});

// ---------- failure notes: why an episode wouldn't start ----------
// "This source is down" blamed the provider for a DMCA takedown and told the
// viewer nothing actionable. The tally distinguishes the three real cases.

test("withNote: nothing indexed reads differently from all-blocked", async () => {
  const { withNote } = await import("../lib/providers/debrid.mjs");
  assert.match(withNote([], {}, 0).note, /nothing indexed/);
  assert.equal(withNote([], { blocked: 4, uncached: 6, error: 0 }, 19).note,
    "4 blocked (takedown), 6 not cached, of 19 found");
  assert.match(withNote([], {}, 0, "3 release(s) found but none confirmed as this season").note,
    /none confirmed as this season/);
});

test("withNote: the note rides on the array without changing its length", async () => {
  const { withNote } = await import("../lib/providers/debrid.mjs");
  const out = withNote([], { blocked: 1 }, 2);
  assert.equal(out.length, 0, "callers that test streams.length are unaffected");
  assert.ok(Array.isArray(out));
});

// ---------- titleQueries: the forms a text index will actually match ----------
// AniList says "Season 2"; every release group writes "S2". Searching only the
// AniList form found zero results for an episode with three usable releases.

test("titleQueries: a sequel is also searched in the abbreviated form groups use", async () => {
  const { titleQueries } = await import("../lib/providers/torrent-source.mjs");
  const meta = { romaji: "Shingeki no Kyojin Season 2", title: "Attack on Titan Season 2", episodes: 12 };
  const qs = titleQueries(meta, meta.romaji);
  assert.equal(qs[0], "Shingeki no Kyojin Season 2", "the exact title stays first");
  assert.ok(qs.includes("Shingeki no Kyojin S2"), "…and the S2 form is tried");
  // The bare base titles come last; the season gate re-checks results anyway.
  assert.ok(qs.includes("Shingeki no Kyojin"));
  assert.ok(qs.some((q) => /^Attack on Titan/.test(q)), "the English form is searched too");
});

test("titleQueries: a first season adds no season abbreviation", async () => {
  const { titleQueries } = await import("../lib/providers/torrent-source.mjs");
  const meta = { romaji: "Sousou no Frieren", title: "Frieren: Beyond Journey's End", episodes: 28 };
  const qs = titleQueries(meta, meta.romaji);
  assert.equal(qs[0], "Sousou no Frieren");
  assert.ok(!qs.some((q) => /\bS1\b/.test(q)), "nobody labels a first season 'S1' in the title");
});

test("titleQueries: forms are deduplicated", async () => {
  const { titleQueries } = await import("../lib/providers/torrent-source.mjs");
  const meta = { romaji: "One Piece", title: "One Piece", episodes: 1000 };
  const qs = titleQueries(meta, "One Piece");
  assert.equal(new Set(qs).size, qs.length);
});

// ---------- split-cour numbering ----------
// AniList gives each cour its own entry numbered from 1; release groups number
// the run continuously. Bleach TYBW "The Calamity" episode 1 ships as "- 41".

test("courMarkers: the words that identify this cour, not the run", async () => {
  const { courMarkers } = await import("../lib/providers/torrent-source.mjs");
  const m = courMarkers({
    romaji: "BLEACH: Sennen Kessen-hen - Kashin-tan",
    title: "BLEACH: Thousand-Year Blood War - The Calamity",
  });
  assert.ok(m.includes("kashintan"));
  assert.ok(m.includes("calamity"), "a leading 'The' is not distinguishing");
  // A release naming a DIFFERENT cour must not satisfy them — this is the check
  // that stopped a "Bleach.S17.E01-E13" pack (cour one) playing as cour four.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  assert.equal(m.some((x) => norm("Bleach.S17.E01-E13.1080p.BluRay.Remux").includes(x)), false);
  assert.equal(m.some((x) => norm("[Doomdos] BLEACH: TYBW - The Calamity - 41").includes(x)), true);
});

test("courMarkers: a show with no cour subtitle has none", async () => {
  const { courMarkers } = await import("../lib/providers/torrent-source.mjs");
  assert.deepEqual(courMarkers({ romaji: "Sousou no Frieren", title: "Frieren: Beyond Journey's End" }), []);
});

test("titleQueries: a cour subtitle is also searched without it", async () => {
  const { titleQueries } = await import("../lib/providers/torrent-source.mjs");
  const meta = {
    romaji: "BLEACH: Sennen Kessen-hen - Kashin-tan",
    title: "BLEACH: Thousand-Year Blood War - The Calamity",
    episodes: 10,
  };
  const qs = titleQueries(meta, meta.romaji);
  // Groups publish under the RUN title plus an absolute number, never the cour
  // subtitle — searching only the full name found one stray release.
  assert.ok(qs.includes("BLEACH: Sennen Kessen-hen"));
  assert.ok(qs.includes("BLEACH: Thousand-Year Blood War"));
  assert.equal(qs[0], meta.romaji, "the exact name is still tried first");
});
