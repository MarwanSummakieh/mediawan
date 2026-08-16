// Regression test for the episode-list blackout: an open circuit breaker used
// to empty /api/title's provider match, and the client then showed "No sub
// source matched for this title" on EVERY title until the backoff expired —
// even though the episode grid is metadata-driven precisely so it survives a
// failing provider.
//
// The debrid token must exist BEFORE the module graph loads (realdebrid.mjs
// captures it at import), which is why this file sets env and then imports
// dynamically — and why it lives apart from providers.test.mjs, whose static
// imports load the same modules tokenless.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.REAL_DEBRID_TOKEN ||= "test-token";
const { titleData, resolveStreams, resetProvidersHealth } =
  await import("../lib/providers/index.mjs");

// No anilistId on purpose: the real torrentio provider bails on a missing id
// before its network lookup, so matching stays offline.
const meta = { romaji: "Test Show", title: "Test Show", episodes: 12, duration: 24 };

beforeEach(() => resetProvidersHealth());

test("titleData: grid and playability survive open breakers on every text-search source", async () => {
  // Trip the real registry's breakers the way production does: providers by
  // those names failing with a network-ish error. Both text-search indexes are
  // tripped because either one matching would keep `matched` non-empty and the
  // fallback under test would never be exercised. (Torrentio needs an AniList
  // id, which this meta deliberately omits, so it declines on its own.)
  const failing = ["debrid", "nyaa", "subsplease"].map((name) => ({
    name, label: name, tier: "quality",
    async match() { throw new Error("ECONNRESET while talking upstream"); },
    async resolve() { return []; },
  }));
  await resolveStreams(meta, "1", "sub", failing);

  const data = await titleData(meta);
  // The breakers really are open — nothing matched…
  assert.equal(data.matched.length, 0);
  // …and the title still plays: the deterministic debrid match is synthesized,
  // and the metadata grid is intact for both languages.
  assert.ok(data.primaryShow, "primaryShow must not go null on a transient failure");
  assert.equal(data.primaryShow.query, "Test Show");
  assert.equal(data.sub.length, 12);
  assert.equal(data.dub.length, 12);
});

test("titleData: a healthy match still wins over the synthesized fallback", async () => {
  const data = await titleData(meta);
  // With no breaker open the real debrid provider matches normally (its match
  // is token + title, no network), so the fallback never engages.
  assert.ok(data.matched.some((m) => m.name === "debrid"));
  assert.equal(data.primaryShow, data.matched[0].show);
});
