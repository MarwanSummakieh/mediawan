// Japanese is the floor: it must never be unreachable.
//
// Dub is the NARROW request — it needs a dual-audio release, or a source that
// publishes a separate dubbed track, and for a simulcast episode neither exists
// for weeks after air. The original Japanese audio is always what shipped
// first. So a dub request that resolves nothing must fall back to Japanese and
// play, rather than failing an episode that is demonstrably available.
//
// The asymmetry is the point and is asserted here: the reverse fallback would
// serve Japanese audio to someone who explicitly asked for English, which is
// the exact failure dub mode exists to prevent.
//
// This tests the resolution contract the route depends on (see the
// audioFallback block in server.mjs) without standing up Express.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.REAL_DEBRID_TOKEN ||= "test-token";
const { resolveStreams, resetProvidersHealth } = await import("../lib/providers/index.mjs");

const meta = { romaji: "Test Show", title: "Test Show", episodes: 12, duration: 24 };

// A source that only ever has the original audio — the normal state of a
// currently-airing show.
const japaneseOnly = (name = "jp-only") => ({
  name, label: name, tier: "quality",
  async match() { return { id: name }; },
  async episodes() { return { sub: ["1"], dub: [] }; },
  async resolve(_show, _ep, mode) {
    return mode === "dub" ? [] : [{ url: "https://cdn.example.net/jp.mkv", type: "file", quality: "1080", source: "Test · JP" }];
  },
});

beforeEach(() => resetProvidersHealth());

// The precondition: asking for dub really does come back empty. Without this
// the fallback test could pass for the wrong reason.
test("a dub request against a Japanese-only source resolves nothing", async () => {
  const out = await resolveStreams(meta, "1", "dub", [japaneseOnly()]);
  assert.equal(out.length, 0);
});

// The guarantee. This is what the route's fallback leans on: the SAME episode,
// same providers, asked for in Japanese, plays.
test("the same episode is available in Japanese — so the play must not fail", async () => {
  const list = [japaneseOnly()];
  const dub = await resolveStreams(meta, "1", "dub", list);
  assert.equal(dub.length, 0, "precondition: no dub");

  const jp = await resolveStreams(meta, "1", "sub", list);
  assert.ok(jp.length > 0, "Japanese must be reachable when the episode exists at all");
  assert.match(jp[0].source, /JP/);
});

// A source that has BOTH must not be dragged down to Japanese: the fallback is
// a last resort, not a preference. If dub resolves, dub is what plays.
test("a real dub is never replaced by the Japanese fallback", async () => {
  const bothLanguages = {
    name: "dual", label: "dual", tier: "quality",
    async match() { return { id: "dual" }; },
    async episodes() { return { sub: ["1"], dub: ["1"] }; },
    async resolve(_show, _ep, mode) {
      return [{ url: `https://cdn.example.net/${mode}.mkv`, type: "file", quality: "1080", source: `Test · ${mode}` }];
    },
  };
  const out = await resolveStreams(meta, "1", "dub", [bothLanguages]);
  assert.equal(out.length, 1);
  assert.match(out[0].source, /dub/, "a resolvable dub must win over any fallback");
});

// The direction that must NOT be automatic. A source with only an English dub
// and no Japanese leaves a sub request empty — and it has to STAY empty, so the
// route reports failure instead of quietly serving the wrong language.
test("a sub request is never silently satisfied with a dub", async () => {
  const dubOnly = {
    name: "dub-only", label: "dub-only", tier: "quality",
    async match() { return { id: "dub-only" }; },
    async episodes() { return { sub: [], dub: ["1"] }; },
    async resolve(_show, _ep, mode) {
      return mode === "dub" ? [{ url: "https://cdn.example.net/en.mkv", type: "file", quality: "1080", source: "Test · EN" }] : [];
    },
  };
  const out = await resolveStreams(meta, "1", "sub", [dubOnly]);
  assert.equal(out.length, 0, "sub must fail rather than serve English audio unasked");
});
