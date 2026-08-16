// Provider registry — the multi-source layer that keeps playback up.
//
// Sources are TIERED by what they can actually deliver, which is the change
// that matters here:
//
//   quality — debrid-backed release files. The only tier that can serve REMUX,
//             4K, or lossless 5.1. Ranked purely on picture and sound by
//             lib/quality.mjs. This is the product.
//   floor   — embed aggregators. Those hosts store 1-2 GB per film because
//             bandwidth is their cost centre, so everything they serve is a
//             heavy re-encode. They exist for ONE reason: something plays
//             instantly while the quality release is being acquired. A floor
//             source must never be load-bearing.
//
// This replaces the old eager/lazy split, which had the tiers backwards: the
// scrapers (low bitrate) were primary and the debrid path (high bitrate) was a
// last resort that only surfaced when everything else failed. It also fixes the
// bug in that arrangement — the lazy branch did `out = streams`, REPLACING the
// eager results instead of merging, so a play could never see both tiers at
// once even though the player's fallback list is built to cross sources.
import { torrentioAnimeProvider } from "./torrentio.mjs";
import { debridAnimeProvider } from "./debrid.mjs";
import { nyaaAnimeProvider } from "./nyaa.mjs";
import { subsPleaseProvider } from "./subsplease.mjs";
import { wantedSeason } from "../match-release.mjs";
import { debridEnabled } from "../debrid/realdebrid.mjs";

// ANIME HAS NO FLOOR TIER.
//
// It had one — a Seanime sidecar, removed 2026-08-06 — and before that a
// scraper that went permanently bot-gated, and before that embed aggregators
// that never served a single stream. Nothing has replaced it, and the tier
// machinery below is deliberately left intact rather than ripped out: it is
// what Movies and TV use (../vidlink.mjs), and it is where an anime floor
// source would slot back in if one ever proves itself.
//
// What that costs, so it is not rediscovered as a bug: an anime play now waits
// for the debrid release. There is no instant-but-worse stream to cover the
// gap while a torrent is fetched, and a title none of the four quality sources
// can serve simply does not play.
//
// VidLink, which fills that role for Movies and TV, was measured against anime
// on 2026-08-05 and cannot do it: Frieren S1E1 plays, Frieren S2E1 (airing)
// returns nothing, and Dan Da Dan and Attack on Titan S2 return nothing at all.
// Current-season episodes are the entire point of this vertical.
//
// Order within a tier is only a tiebreak; quality-tier streams are re-ranked
// against each other by rankAcrossProviders below.
//
// FOUR quality sources, each with its own circuit breaker, because each fails
// independently and has been observed doing so: AnimeTosho went stale (nothing
// newer than 2026-05-08), Torrentio's Kitsu index has gaps (zero entries for
// Grand Blue Season 3), and Nyaa — the live index the other two derive from —
// carries what both were missing. SubsPlease leads: first-party and live to
// the minute, and its untagged release names are the ones Real-Debrid's
// takedown filter actually accepts (see ./subsplease.mjs).
export const providers = [
  subsPleaseProvider, nyaaAnimeProvider, debridAnimeProvider, torrentioAnimeProvider,
];

const byTier = (t) => providers.filter((p) => (p.tier || "quality") === t);
const quality = byTier("quality");
const floor = byTier("floor");

// ---------- health ----------
//
// Failure is TYPED now. The old model had one `status` string and one recovery
// story, which is how a permanent bot-gate (AllAnime's NEED_CAPTCHA) got
// treated as a transient key rotation and retried against a wall forever. These
// states are distinguishable because they call for different responses:
//
//   ok            — served streams
//   no-match      — provider has no entry for this title (normal, not a fault)
//   no-sources    — matched, but nothing playable for this episode
//   blocked       — bot-gate / IP block / captcha. Will NOT self-heal; back off hard.
//   rate-limited  — upstream is throttling us. Back off, then retry.
//   upstream-down — network/5xx. Transient; retry soon.
//   error         — anything unclassified.
const TERMINAL = new Set(["blocked"]); // won't fix itself, so stop paying for it

const health = new Map(
  providers.map((p) => [p.name, {
    name: p.name, label: p.label, tier: p.tier || "quality",
    status: "unknown",
    lastOkAt: null, lastError: null, matches: 0, resolves: 0,
    // circuit breaker
    failures: 0, openUntil: 0,
  }])
);

// Backoff for a provider that keeps failing. A dead source used to cost latency
// on EVERY resolve because nothing ever stopped calling it; now it's skipped
// until its window expires. Blocked sources get the long window — they need a
// change at the other end, not another attempt.
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const BLOCKED_BACKOFF_MS = 60 * 60_000;

// Health is created on demand rather than only for the statically-registered
// providers. resolveStreams accepts an injected list, and a provider that isn't
// tracked is a provider whose breaker never opens — which silently reintroduces
// exactly the "keep calling the dead source forever" behaviour this replaced.
function entry(name) {
  let h = health.get(name);
  if (!h) {
    h = { name, label: name, tier: "quality", status: "unknown", lastOkAt: null,
      lastError: null, matches: 0, resolves: 0, failures: 0, openUntil: 0 };
    health.set(name, h);
  }
  return h;
}

function mark(name, status, error = null) {
  const h = entry(name);
  h.status = status;
  if (status === "ok") {
    h.lastOkAt = Date.now(); h.lastError = null;
    h.failures = 0; h.openUntil = 0; // recovered — close the breaker
    return;
  }
  if (error) h.lastError = String(error);
  // "no-match"/"no-sources" are honest answers about a TITLE, not provider
  // faults, so they must not trip the breaker.
  if (status === "no-match" || status === "no-sources") return;
  h.failures++;
  h.openUntil = Date.now() + (TERMINAL.has(status)
    ? BLOCKED_BACKOFF_MS
    : Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (h.failures - 1)));
}

function bump(name, field) {
  entry(name)[field]++;
}

const isOpen = (name) => (health.get(name)?.openUntil || 0) > Date.now();

// Read an upstream failure and say what KIND it is, so the breaker and the
// admin panel both stop guessing. Bot-gates are the important case: they look
// like ordinary failures but never recover on their own.
export function classifyError(e) {
  const m = String(e?.message || e || "").toLowerCase();
  if (/captcha|challenge|just a moment|cf-chl|access denied|forbidden|\b403\b/.test(m)) return "blocked";
  if (/rate.?limit|too many requests|\b429\b/.test(m)) return "rate-limited";
  // Node's network errors arrive as ETIMEDOUT/ECONNRESET/ENOTFOUND — matching
  // on the bare words misses every one of them, since "etimedout" does not
  // contain "timeout".
  if (/e(timedout|conn\w*|notfound|host\w*|pipe)|timed?\s?out|timeout|abort|socket|network|fetch failed|\b5\d\d\b/.test(m))
    return "upstream-down";
  return "error";
}

// Clear all breakers and counters. Used by the admin "check now" probe and by
// tests, which share this module-level state across cases.
export function resetProvidersHealth() {
  for (const h of health.values()) {
    Object.assign(h, { status: "unknown", lastError: null, failures: 0, openUntil: 0, matches: 0, resolves: 0 });
  }
}

// A provider with no credentials configured declines every match, which the
// health model records as "no-match" — a status that means "this title isn't
// in that index", i.e. explicitly NOT a fault. So an instance with no
// Real-Debrid token reported its dead sources as working normally.
// `configured` separates the two: nothing to report, versus nothing set up.
// Providers that need no configuration simply omit `available`.
export function getProvidersHealth() {
  return providers.map((p) => {
    const h = health.get(p.name);
    return {
      ...h,
      configured: p.available ? !!p.available() : true,
      breakerOpen: isOpen(p.name),
      opensInMs: Math.max(0, h.openUntil - Date.now()),
    };
  });
}

// ---------- matching ----------

// Match `meta` against a provider list in parallel, skipping any whose breaker
// is open. `list` is injectable so the tier logic can be unit-tested with mocks.
export async function matchProviders(meta, list = providers) {
  const results = await Promise.all(list.map(async (p) => {
    if (isOpen(p.name)) return null;
    try {
      const show = await p.match(meta);
      if (show) bump(p.name, "matches");
      else mark(p.name, "no-match");
      return show ? { name: p.name, label: p.label, tier: p.tier || "quality", provider: p, show } : null;
    } catch (e) {
      mark(p.name, classifyError(e), e.message);
      return null;
    }
  }));
  return results.filter(Boolean);
}

// ---------- episode grid ----------
//
// The grid comes from METADATA now, not from a provider.
//
// It used to be built by unioning what the scrapers enumerated, which meant
// that when they broke the episode list came back EMPTY and the app looked
// broken rather than degraded — even when another source could have played
// every episode. AniList already knows how many episodes a show has, and it
// doesn't go down when a scraper does.
function episodeGrid(meta) {
  // For a currently-airing show, `episodes` is the TOTAL planned run; only the
  // ones before the next airing date actually exist yet.
  const total = Number(meta?.episodes) || 0;
  const airedSoFar = meta?.airing?.episode ? Number(meta.airing.episode) - 1 : null;
  const n = airedSoFar != null ? (total ? Math.min(total, airedSoFar) : airedSoFar) : total;
  if (!Number.isFinite(n) || n <= 0) return [];
  return Array.from({ length: n }, (_, i) => String(i + 1));
}

// Everything /api/title needs. `matched` reports which providers can serve the
// title at all (the client's "is this playable" gate); the grid no longer
// depends on any of them.
//
// Dub: nothing enumerates dub availability any more — that came from AllAnime's
// availableEpisodesDetail. `mode` is now a RANKING PREFERENCE handed to the
// providers, so the dub list is offered optimistically and a title with no
// dubbed release simply fails to resolve in that mode and falls back to sub.
export async function titleData(meta) {
  const matched = await matchProviders(meta);
  const sub = episodeGrid(meta);
  // The title page must never go dark because matching TRANSIENTLY failed.
  // The grid is metadata-driven for exactly that reason — yet when every
  // provider struck out (breakers open after an RD 429 burst, the id-mapping
  // service down), `matched` came back empty, /api/title reported the title
  // unplayable, and the client showed "No sub source matched" on EVERY title
  // until the backoff expired. The debrid provider's match is deterministic —
  // a token plus a title, no network — so it is synthesized here instead.
  // Playback re-matches on its own request and surfaces a real error for that
  // one play if the upstream is still down.
  const fallback = debridEnabled() && (meta?.romaji || meta?.title)
    ? { query: meta.romaji || meta.title, meta }
    : null;
  return {
    matched,
    primaryShow: matched.length ? matched[0].show : fallback,
    sub,
    dub: sub,
  };
}

// ---------- resolving ----------

// Resolve one tier, concatenating in ranked order and recording health.
async function resolveFrom(matched, ep, mode, { firstHit = false } = {}) {
  const out = [];
  for (const m of matched) {
    if (isOpen(m.name)) continue;
    try {
      const streams = await m.provider.resolve(m.show, ep, mode);
      bump(m.name, "resolves");
      if (streams.length) { mark(m.name, "ok"); out.push(...streams); }
      // `streams.note` explains an empty result ("4 blocked (takedown), 6 not
      // cached of 19 found") — see withNote in ./debrid.mjs. Recorded as the
      // provider's lastError so the player can tell the viewer what actually
      // happened instead of "this source is down".
      else {
        mark(m.name, "no-sources", streams.note || null);
        // A provider that found the release but couldn't serve it says which
        // one is worth FETCHING (see fetchCandidate in torrent-source.mjs).
        // First provider wins — the list is already in preference order.
        if (streams.fetchCandidate && !out.fetchCandidate)
          out.fetchCandidate = streams.fetchCandidate;
      }
      if (firstHit && out.length) break;
    } catch (e) {
      mark(m.name, classifyError(e), e.message);
    }
  }
  return out;
}

// Resolve one episode across every tier.
//
// Both tiers run CONCURRENTLY and both results are kept: quality streams lead,
// floor streams follow. The player walks `streams[i+1]` on failure, so this
// gives it a real ladder — best release first, something-that-definitely-plays
// last — instead of the old all-or-nothing swap.
//
// The floor tier is cheap and fast, so it is never the thing being waited on;
// the quality tier is what takes time, and its result is worth waiting for.
export async function resolveStreams(meta, ep, mode, list = null) {
  const useQuality = list ? list.filter((p) => (p.tier || "quality") === "quality") : quality;
  const useFloor = list ? list.filter((p) => p.tier === "floor") : floor;

  const [q, f] = await Promise.all([
    matchProviders(meta, useQuality).then((m) => resolveFrom(m, ep, mode)),
    // A floor failure must never fail the play — it's the safety net, not the act.
    matchProviders(meta, useFloor).then((m) => resolveFrom(m, ep, mode, { firstHit: true })).catch(() => []),
  ]);
  // Sequels are where provider identity matters (see rankAcrossProviders).
  const sequel = wantedSeason(meta) > 1;
  const out = [...rankAcrossProviders(q, { preferVerified: sequel }), ...f];
  // Nothing served, but a quality provider named a release worth fetching —
  // carried on the array (the same convention as `note`) so the play route can
  // start the download and answer 202 instead of 502.
  if (q.fetchCandidate) out.fetchCandidate = q.fetchCandidate;
  return out;
}

// Order quality-tier streams by RELEASE quality, not by which provider happens
// to be listed first.
//
// Providers each rank their own candidates, but nothing compared the winners to
// each other, so the array order in `providers` silently decided the outcome.
// Measured live on Frieren: the debrid provider's E-AC3 stereo web-dl was
// served over Torrentio's REMUX with lossless FLAC 5.1, purely because `debrid`
// comes first in the list. Each stream now carries the ranker's score, and they
// compete on it. Streams without a score keep their relative position.
// `preferVerified` puts sources that KNOW which season they returned ahead of
// sources that inferred it from a release name, before quality is considered.
//
// It applies only to sequels, because that is the only place the distinction
// bites. Anime seasons share a base title and differ by a suffix ("Season 2",
// "The Final Season", "Part 2"), so a text search for one sequel happily
// returns another — measured live, a dub request for Shingeki no Kyojin Season
// 2 came back with "The Final Season Part 2". An id-mapped source cannot make
// that mistake: it asked for one specific season's episode.
//
// For season 1 and for films the inference is reliable, so both sources compete
// on quality alone and the text-searched index keeps its value (it carries
// fansub and dual-audio releases the id-mapped one often lacks).
function rankAcrossProviders(streams, { preferVerified = false } = {}) {
  return streams
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      if (preferVerified) {
        const av = a.s.identityVerified ? 0 : 1;
        const bv = b.s.identityVerified ? 0 : 1;
        if (av !== bv) return av - bv;
      }
      const as = a.s.score, bs = b.s.score;
      if (as == null && bs == null) return a.i - b.i;
      if (as == null) return 1;
      if (bs == null) return -1;
      return bs - as || a.i - b.i;
    })
    .map((x) => x.s);
}

// Only the floor tier — what the Servers panel asks for when the ranked pick
// isn't working out and the user wants alternatives.
export async function resolveFloorStreams(meta, ep, mode, list = null) {
  const useFloor = (list || providers).filter((p) => p.tier === "floor");
  if (!useFloor.length) return [];
  return resolveFrom(await matchProviders(meta, useFloor), ep, mode);
}

// Only the quality tier — used by the upgrade-in-place path, which has already
// started playing something from the floor and wants the good release next.
export async function resolveQualityStreams(meta, ep, mode, list = null) {
  const useQuality = (list || providers).filter((p) => (p.tier || "quality") === "quality");
  if (!useQuality.length) return [];
  return resolveFrom(await matchProviders(meta, useQuality), ep, mode);
}

// ---------- probing ----------

// A stable, universally-available title for probing every provider (used by the
// admin panel). episodes:0 lets the matchers lean on their own heuristics.
//
// The id must be REAL. It used to be -1, on the theory that a negative number
// merely namespaced the probe's match cache — but every id-mapped provider
// declines a non-positive AniList id (they cannot look one up, and probes were
// exactly what that guard was written for). The result was a "check now" that
// silently skipped two of the three sources and reported them as "no match",
// which reads as "this title isn't indexed there" — a non-fault. A probe that
// cannot fail is worse than no probe.
//
// It also must not be One Piece, which was the obvious pick and the wrong one.
// A 1100-episode running series is pathological for the sources this probe is
// meant to test — half-episode numbering ("1061.5") and title lookups that
// return nothing have both made a healthy source report as broken when it was
// fine for every ordinary title. Frieren is the better canary — popular
// enough to exist everywhere,
// finite, and numbered 1..28 with no specials in the run.
const PROBE_META = { anilistId: 154587, romaji: "Sousou no Frieren", title: "Frieren: Beyond Journey's End", episodes: 0, duration: 24 };

// Probe every provider against a known-good title. Clears open breakers first —
// an admin asking "check now" is explicitly asking to retry the dead ones.
export async function probeProviders(meta = PROBE_META, ep = "1", mode = "sub") {
  resetProvidersHealth();
  await resolveStreams(meta, ep, mode);
  return getProvidersHealth();
}
