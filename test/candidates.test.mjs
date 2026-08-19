// Unit tests for the debrid candidate loop shared by the movie/TV players.
// The RD client is injected (`fromMagnet`) so nothing touches the network.
// The invariant under test: a cache MISS (fromMagnet → null) and an RD API
// FAILURE (fromMagnet throws, e.g. 429) must produce different errors — a
// transient API outage must never be reported as "no cached release".
import { test } from "node:test";
import assert from "node:assert/strict";
import { streamFirstCached , spreadByQuality } from "../lib/debrid/candidates.mjs";
import { accountFault as rdAccountFault } from "../lib/debrid/realdebrid.mjs";

const cand = (n, quality = 1080) => ({ magnet: `magnet:?xt=${n}`, quality });
const rd429 = () => Object.assign(new Error("RD /torrents/addMagnet → 429 too_many_requests"), { status: 429 });
// accountFault asks Real-Debrid's /user before it dares say "your subscription
// died", so tests inject that answer rather than reaching the network.
const withAccount = (account) => (e) => rdAccountFault(e, { probe: async () => {
  if (!account) throw new Error("RD /user → 401 bad_token");
  return account;
} });
const FREE = { type: "free", premium: 0 };
const PREMIUM = { type: "premium", premium: 7779575 };
const rd403 = () => Object.assign(new Error("RD /torrents/addMagnet → 403 permission_denied"), { status: 403, code: 9 });

test("streamFirstCached: first cached candidate streams, labeled with its quality", async () => {
  const r = await streamFirstCached([cand("a", 2160)], {
    fromMagnet: async () => ({ url: "http://x/v.m3u8", type: "hls" }),
  });
  assert.equal(r.stream.url, "http://x/v.m3u8");
  assert.equal(r.stream.quality, "2160");
  assert.equal(r.stream.source, "Real-Debrid · 2160p");
});

test("streamFirstCached: skips uncached (null) candidates and serves a later hit", async () => {
  let calls = 0;
  const r = await streamFirstCached([cand("a"), cand("b"), cand("c")], {
    fromMagnet: async () => (++calls < 3 ? null : { url: "http://x/c.mp4", type: "mp4" }),
  });
  assert.equal(calls, 3);
  assert.equal(r.stream.url, "http://x/c.mp4");
});

test("streamFirstCached: all misses → 'no cached release', no API-error noise", async () => {
  const r = await streamFirstCached([cand("a"), cand("b")], { fromMagnet: async () => null });
  assert.equal(r.error, "no cached release");
  // The detail names the service, how many were tried, and how big the field
  // was. "none cached" alone was misleading: a release is also skipped when its
  // files don't match the request, and the two read identically to a viewer.
  assert.equal(r.detail, "Real-Debrid: tried 2 of 2 releases, none cached or matching");
});

// ---------- the nothing-cached download fallback ----------
//
// Regression: the fallback read `ordered` — a variable scoped INSIDE the
// backend loop — after the loop, so the moment it was actually reached it threw
// a ReferenceError instead of starting the download. Every "none cached" play
// on movies/TV died on it. These tests exercise the path with a fake
// startDownload so it can never silently break again.
test("streamFirstCached: nothing cached + startDownload → starts fetching the best release", async () => {
  let started = null;
  const r = await streamFirstCached([cand("a", 2160), cand("b", 1080)], {
    fromMagnet: async () => null,
    startDownload: async (magnet) => { started = magnet; return { torrentId: "t1", filename: "a.mkv", bytes: 1 }; },
  });
  assert.equal(started, "magnet:?xt=a", "fetches the best-ranked candidate");
  assert.equal(r.downloading.torrentId, "t1");
  assert.equal(r.error, undefined);
});

test("streamFirstCached: download fallback skips blocked and dead releases", async () => {
  // a → refused for a takedown (backend reports it via onSkip); b → zero
  // seeders, can never complete; c → the one worth fetching.
  const cands = [
    { ...cand("a", 2160) },
    { ...cand("b", 1080), seeders: 0 },
    { ...cand("c", 1080), seeders: 3 },
  ];
  let started = null;
  const r = await streamFirstCached(cands, {
    fromMagnet: async (magnet, { onSkip } = {}) => {
      if (magnet === "magnet:?xt=a") onSkip?.("blocked");
      return null;
    },
    startDownload: async (magnet) => { started = magnet; return { torrentId: "t2" }; },
  });
  assert.equal(started, "magnet:?xt=c");
  assert.equal(r.downloading.torrentId, "t2");
});

test("streamFirstCached: no download attempt when every candidate is blocked or dead", async () => {
  let started = false;
  const r = await streamFirstCached([{ ...cand("a"), seeders: 0 }], {
    fromMagnet: async () => null,
    startDownload: async () => { started = true; return { torrentId: "t3" }; },
  });
  assert.equal(started, false, "fetching a dead torrent would hang forever");
  assert.equal(r.error, "no cached release");
});

test("spreadByQuality: keeps the best pick first but does not spend every attempt in one band", async () => {
  // Live case (House of the Dragon S01E01): the top six candidates were all
  // 2160p REMUX — the releases least likely to be debrid-cached — so twelve
  // attempts could miss entirely while a cached 1080p sat further down.
  const list = [
    ...Array.from({ length: 8 }, (_, i) => ({ name: `r${i} 2160p`, quality: 2160 })),
    ...Array.from({ length: 6 }, (_, i) => ({ name: `r${i} 1080p`, quality: 1080 })),
  ];
  const out = spreadByQuality(list);
  assert.equal(out[0].quality, 2160, "the best release must still be tried first");
  assert.equal(out[1].quality, 1080, "the second attempt must reach another band");
  const first12 = out.slice(0, 12);
  assert.ok(first12.filter((x) => x.quality === 1080).length >= 4,
    "a cache miss on 4K must fall through to 1080p within the attempt budget");
});

test("streamFirstCached: every candidate failing with an API error → debrid-error, not 'no cached release'", async () => {
  const r = await streamFirstCached([cand("a"), cand("b"), cand("c")], {
    fromMagnet: async () => { throw rd429(); },
  });
  assert.equal(r.error, "debrid-error"); // the live-testing regression: 429s were reported as uncached
  assert.match(r.detail, /RD \/torrents\/addMagnet → 429/);
  assert.match(r.detail, /all 3 releases failed the same way/);
});

test("streamFirstCached: mixed misses + API errors → 'no cached release' but the errors are visible", async () => {
  let calls = 0;
  const r = await streamFirstCached([cand("a"), cand("b"), cand("c")], {
    fromMagnet: async () => { if (++calls === 2) throw rd429(); return null; },
  });
  assert.equal(r.error, "no cached release"); // we DID get real cache answers for a and c
  assert.match(r.detail, /tried 3/);
  assert.match(r.detail, /1 API errors, last: RD \/torrents\/addMagnet → 429/);
});

test("streamFirstCached: API errors don't block a later cached candidate", async () => {
  let calls = 0;
  const r = await streamFirstCached([cand("a"), cand("b")], {
    fromMagnet: async () => { if (++calls === 1) throw rd429(); return { url: "http://x/b.m3u8", type: "hls" }; },
  });
  assert.equal(r.stream.url, "http://x/b.m3u8");
});

test("streamFirstCached: premium/parcel account errors surface immediately", async () => {
  let calls = 0;
  const r = await streamFirstCached([cand("a"), cand("b")], {
    fromMagnet: async () => { calls++; throw new Error("RD /torrents/addMagnet → 403 permission_denied (premium required)"); },
  });
  assert.equal(calls, 1); // no point trying more torrents on an account problem
  // Its own code, not the generic one: the caller answers 402 and tells the
  // viewer to renew, instead of sending them to pick a different release.
  assert.equal(r.error, "debrid-account");
  assert.match(r.detail, /premium required/);
});

// The failure that actually took the app down on 2026-08-19: Real-Debrid
// premium lapsed, and every addMagnet answered a bare "403 permission_denied".
// No "premium" in the text, so the prose test above could not see it — each of
// the hundred discovered releases was attempted and the last one got the blame.
test("streamFirstCached: a bare 403 permission_denied is an ACCOUNT fault, not a bad release", async () => {
  let calls = 0;
  const rd = mkBackend("rd", async () => { calls++; throw rd403(); }, { accountFault: withAccount(FREE) });
  const r = await streamFirstCached([cand("a"), cand("b"), cand("c")], { backends: [rd] });
  assert.equal(calls, 1);                      // stop at the first one — the rest cannot differ
  assert.equal(r.error, "debrid-account");      // NOT "no cached release": nothing was ever looked up
  assert.match(r.detail, /premium has lapsed/);
  assert.doesNotMatch(r.detail, /none cached/); // never blame the catalogue for an unpaid account
});

test("streamFirstCached: a dead token is named as a token problem", async () => {
  const rd = mkBackend("rd", async () => {
    throw Object.assign(new Error("RD /torrents/info → 401 bad_token"), { status: 401, code: 8 });
  }, { accountFault: withAccount(null) });
  const r = await streamFirstCached([cand("a")], { backends: [rd] });
  assert.match(r.detail, /token/i);
});

// An account fault on ONE service must not condemn the others — that is the
// whole point of the registry.
test("streamFirstCached: a lapsed account on one backend still falls through to the next", async () => {
  const rd = mkBackend("rd", async () => { throw rd403(); }, { accountFault: withAccount(FREE) });
  const pm = mkBackend("pm", async () => ({ url: "http://pm/x.mp4", type: "mp4" }));
  const r = await streamFirstCached([cand("a")], { backends: [rd, pm] });
  assert.equal(r.stream.url, "http://pm/x.mp4");
});

// Observed live on 2026-08-19, minutes after the subscription was renewed: a
// 403 permission_denied arrived while /user reported premium with 90 days left.
// Believing the error would have aborted the search after ONE release and told
// the viewer to renew something they had just paid for — strictly worse than
// the misfiling this whole change set out to fix. The account is the authority.
test("streamFirstCached: a 403 with premium ALIVE is an ordinary error, not a lapse", async () => {
  let calls = 0;
  const rd = mkBackend("rd", async () => { calls++; throw rd403(); }, { accountFault: withAccount(PREMIUM) });
  const r = await streamFirstCached([cand("a"), cand("b"), cand("c")], { backends: [rd] });
  assert.equal(calls, 3);                        // keep trying — the other releases may be fine
  assert.equal(r.error, "debrid-error");         // NOT debrid-account: nobody's subscription is dead
  assert.doesNotMatch(r.detail, /lapsed|renew/i);
});

// A REMOTE viewer never receives more than the tunnel cap, so movies.stream
// reorders the pool to put transcode-friendly 1080p ahead of 4K. spreadByQuality
// used to sort bands numerically and undo that on every play — the encoder was
// handed a 71.6 Mbps HDR remux and the first segment took 29 seconds.
test("spreadByQuality: keeps the caller's band order instead of forcing 4K first", async () => {
  const list = [
    { quality: 1080, name: "a" }, { quality: 1080, name: "b" },
    { quality: 2160, name: "c" }, { quality: 2160, name: "d" },
  ];
  const out = spreadByQuality(list).map((c) => c.name);
  assert.equal(out[0], "a");                    // the band the caller led with
  assert.deepEqual(out, ["a", "c", "b", "d"]);  // still interleaved, just not re-sorted
});

// The original reason spreadByQuality exists must survive: an ordinary ranked
// list leads with the best release, so the top pick is still tried first and
// the SECOND attempt still drops a band rather than burning on more 4K.
test("spreadByQuality: an ordinary ranked list still tries the best release first", async () => {
  const list = [
    { quality: 2160, name: "remux1" }, { quality: 2160, name: "remux2" },
    { quality: 1080, name: "web1" },
  ];
  const out = spreadByQuality(list).map((c) => c.name);
  assert.equal(out[0], "remux1");
  assert.equal(out[1], "web1");   // not remux2 — the whole point
});

// ---- multi-backend behaviour ----
// The point of the registry: Real-Debrid not having a release must no longer
// mean the film is unplayable. A second service gets asked.
const mkBackend = (name, fromMagnet, extra = {}) =>
  ({ name, label: name, enabled: () => true, fromMagnet, remove: async () => {}, ...extra });

test("multi-backend: a miss on the first service falls through to the second", async () => {
  const rd = mkBackend("rd", async () => null);                       // has nothing
  const pm = mkBackend("pm", async () => ({ url: "http://pm/x.m3u8", type: "hls" }));
  const r = await streamFirstCached([cand("a"), cand("b")], { backends: [rd, pm] });
  assert.equal(r.stream.url, "http://pm/x.m3u8");
  assert.equal(r.stream.backend, "pm");
  assert.equal(r.stream.source, "pm · 1080p"); // labelled with the service that served it
});

test("multi-backend: an outage on one service doesn't stop the next", async () => {
  const dead = mkBackend("dead", async () => { throw Object.assign(new Error("500 boom"), { status: 500 }); });
  const ok = mkBackend("ok", async () => ({ url: "http://ok/x.mp4", type: "mp4" }));
  const r = await streamFirstCached([cand("a")], { backends: [dead, ok] });
  assert.equal(r.stream.url, "http://ok/x.mp4");
});

test("multi-backend: an account problem skips that service rather than the whole play", async () => {
  const broke = mkBackend("broke", async () => { throw new Error("premium required"); });
  const ok = mkBackend("ok", async () => ({ url: "http://ok/x.mp4", type: "mp4" }));
  const r = await streamFirstCached([cand("a"), cand("b")], { backends: [broke, ok] });
  assert.equal(r.stream.url, "http://ok/x.mp4"); // previously this aborted everything
});

test("multi-backend: nothing anywhere reports every service's verdict", async () => {
  const a = mkBackend("a", async () => null);
  const b = mkBackend("b", async () => null);
  const r = await streamFirstCached([cand("x")], { backends: [a, b] });
  assert.equal(r.error, "no cached release");
  assert.match(r.detail, /a: tried 1/);
  assert.match(r.detail, /b: tried 1/);
});

test("multi-backend: every service erroring is an outage, not a missing film", async () => {
  const a = mkBackend("a", async () => { throw rd429(); });
  const b = mkBackend("b", async () => { throw rd429(); });
  const r = await streamFirstCached([cand("x")], { backends: [a, b] });
  assert.equal(r.error, "debrid-error"); // must not tell the user the film isn't cached
});

test("checkCached: one bulk answer promotes cached releases over ranked order", async () => {
  const tried = [];
  const backend = mkBackend("pm",
    async (magnet) => { tried.push(magnet); return { url: "http://pm/hit.m3u8", type: "hls" }; },
    { checkCached: async () => new Set(["b".repeat(40)]) });
  const first = { magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`, quality: 2160, name: "A.2160p" };
  const cachedOne = { magnet: `magnet:?xt=urn:btih:${"b".repeat(40)}`, quality: 1080, name: "B.1080p" };
  const r = await streamFirstCached([first, cachedOne], { backends: [backend] });
  assert.equal(tried.length, 1);              // the uncached top-ranked release was never attempted
  assert.match(tried[0], /btih:bbb/);
  assert.equal(r.stream.quality, "1080");
});

test("checkCached: a service that has none of them is skipped without attempts", async () => {
  let attempts = 0;
  const empty = mkBackend("pm", async () => { attempts++; return null; },
    { checkCached: async () => new Set() });
  const ok = mkBackend("rd", async () => ({ url: "http://rd/x.mp4", type: "mp4" }));
  const c = { magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`, quality: 1080 };
  const r = await streamFirstCached([c], { backends: [empty, ok] });
  assert.equal(attempts, 0);                  // no wasted round trips
  assert.equal(r.stream.url, "http://rd/x.mp4");
});

test("checkCached: a failed probe degrades to trying blind, never to skipping", async () => {
  const backend = mkBackend("pm", async () => ({ url: "http://pm/x.mp4", type: "mp4" }),
    { checkCached: async () => { throw new Error("probe down"); } });
  const c = { magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`, quality: 1080 };
  const r = await streamFirstCached([c], { backends: [backend] });
  assert.equal(r.stream.url, "http://pm/x.mp4");
});

// A transient network failure once surfaced to the user as "House of the
// Dragon … didn't start — Real-Debrid: fetch failed (all 1 attempt(s) failed
// with API errors)": an unreadable Node error, blaming a release that was
// never at fault.
test("a single hand-picked release reports the cause, not an attempt tally", async () => {
  const netDown = mkBackend("Real-Debrid", async () => {
    const e = new Error("network unreachable (ECONNRESET) — the service, not this release");
    e.network = true;
    throw e;
  });
  const r = await streamFirstCached([cand("a")], { backends: [netDown] });
  assert.equal(r.error, "debrid-error");           // an outage, not a missing film
  assert.equal(r.detail, "Real-Debrid: network unreachable (ECONNRESET) — the service, not this release");
  assert.doesNotMatch(r.detail, /attempt\(s\)/);   // the clumsy tally is gone
  assert.doesNotMatch(r.detail, /fetch failed/);   // and so is the opaque wording
});

test("several releases failing the same way still says so", async () => {
  const netDown = mkBackend("Real-Debrid", async () => { throw new Error("network unreachable (ETIMEDOUT)"); });
  const r = await streamFirstCached([cand("a"), cand("b"), cand("c")], { backends: [netDown] });
  assert.match(r.detail, /all 3 releases failed the same way/);
});

// Container no longer implies quality loss.
//
// These cases used to encode a hunt: an .mkv had to go through the debrid
// transcoder (which halves the bitrate), so a working transcoded stream was
// HELD while the list was searched for an .mp4 that would play untouched.
// Transcoding is local now and always receives the original bytes, so an .mkv
// remux is simply the best release rather than a compromise — and the release
// the ranker already put first is the one to take.
const mp4Cand = (n) => ({ magnet: `magnet:?xt=${n}`, quality: 1080, name: `Film.2014.1080p.BluRay.x264-${n}.mp4` });
const mkvCand = (n) => ({ magnet: `magnet:?xt=${n}`, quality: 1080, name: `Film.2014.1080p.BluRay.x264-${n}.mkv` });

test("the first cached release wins — no second-guessing by container", async () => {
  const tried = [];
  const backend = mkBackend("rd", async (magnet) => {
    tried.push(magnet);
    return { url: "http://x/release.mkv", type: "file", torrentId: "t-" + magnet.slice(-4) };
  });
  const r = await streamFirstCached([mkvCand("aaaa"), mp4Cand("good")], { backends: [backend] });
  assert.equal(r.stream.type, "file");
  assert.equal(tried.length, 1, "the ranked pick must not cost extra attempts");
});

test("a release file is returned as-is for the local pipeline", async () => {
  const backend = mkBackend("rd", async () => ({ url: "http://x/remux.mkv", type: "file", torrentId: "t1" }));
  const r = await streamFirstCached([mkvCand("a")], { backends: [backend] });
  assert.equal(r.stream.type, "file");
  assert.equal(r.stream.tier, "quality");
});

test("the degraded RD-HLS path still plays when that's all there is", async () => {
  // Only reachable with local transcoding switched off; better than nothing.
  const backend = mkBackend("rd", async () => ({ url: "http://x/remux.m3u8", type: "hls", torrentId: "t1" }));
  const r = await streamFirstCached([mkvCand("a")], { backends: [backend] });
  assert.equal(r.stream.type, "hls");
});

test("no debrid configured at all is reported as such", async () => {
  const r = await streamFirstCached([cand("a")], { backends: [] });
  assert.equal(r.error, "debrid-disabled");
});

test("streamFirstCached: caps attempts at max", async () => {
  let calls = 0;
  const r = await streamFirstCached(Array.from({ length: 10 }, (_, i) => cand(String(i))), {
    max: 6,
    fromMagnet: async () => { calls++; return null; },
  });
  assert.equal(calls, 6);
  assert.match(r.detail, /tried 6/);
});
