#!/usr/bin/env node
// check-sources — is this box actually able to serve the quality you asked for?
//
// Run it ON THE NAS (`npm run check-sources`). Provider reachability is
// IP-sensitive and transcoding depends on hardware that only exists there.
//
// It answers four questions, in the order they can break:
//   1. Can ffmpeg use QuickSync here?      (silent fallback = stuttering remote video)
//   2. Is the source cache sane?
//   3. Which providers are serving, and when they aren't, WHY — typed, so a
//      permanent bot-gate reads differently from a transient outage.
//   4. For a known title: which release does the ranker actually pick, with its
//      resolution, source tier, bitrate and audio layout. That last line is the
//      point — it is the direct evidence that ranking honours the spec
//      (1080p minimum, 4K welcome, 5.1 preferred, no smeared re-encodes).
import { providers, matchProviders, getProvidersHealth } from "../lib/providers/index.mjs";
import { capabilities } from "../lib/transcode/probe.mjs";
import * as cacheStore from "../lib/cache/store.mjs";
import { rankReleasesVerbose, searchAnimeTorrents, searchMovies, indexFreshness } from "../lib/torrents.mjs";
import { config } from "../lib/config.mjs";

const pad = (s, n) => String(s).padEnd(n);
const GB = 1024 ** 3;

// Frieren: popular enough to be on every source, so a miss is the source's
// fault — and unlike One Piece it is finite and cleanly numbered. A long
// running series is the worst possible canary here: its half-episodes and
// arc-based numbering break streaming sources that handle ordinary shows fine,
// so it reports healthy sources as broken. See PROBE_META in lib/providers/index.mjs.
const meta = { anilistId: 154587, romaji: "Sousou no Frieren", title: "Frieren: Beyond Journey's End", episodes: 28, duration: 24 };
const EP = "1";

console.log(`\n  Mediawan · source check   (run this ON the NAS — reachability and QSV are both local)\n`);

// ---- 1. transcoding ----
console.log("  TRANSCODING");
const caps = await capabilities();
if (!config.transcode.enabled) {
  console.log("    ✗ disabled (TRANSCODE=false). Remote clients get raw release files they probably can't play.");
} else if (!caps.ffmpeg) {
  console.log(`    ✗ ffmpeg NOT FOUND (${caps.error})`);
  console.log("      Nothing can be remuxed or downscaled — this breaks remote playback entirely.");
} else if (!caps.qsv && config.transcode.hwaccel === "qsv") {
  console.log("    ⚠ ffmpeg present but NO QuickSync (h264_qsv missing).");
  console.log("      It will fall back to libx264. An N100 cannot sustain that in real time.");
  console.log("      Check /dev/dri is passed through and run `vainfo` inside the container.");
} else {
  console.log(`    ✓ ${caps.encoders.join(", ")}`);
  console.log(`      remote cap ${config.transcode.remoteMbps} Mbps · max ${config.transcode.maxSessions} concurrent sessions`);
}

// ---- 2. cache ----
await cacheStore.reconcile().catch(() => {});
const cs = cacheStore.stats();
console.log(`\n  SOURCE CACHE`);
console.log(`    ${(cs.usedBytes / GB).toFixed(1)} GB used of ${(cs.budgetBytes / 1024 ** 4).toFixed(1)} TB · ${cs.entries} entries (${cs.complete} complete, ${cs.partial} partial)`);
console.log(`    ${cs.dir}`);

// ---- 3. providers ----
console.log(`\n  PROVIDERS   (target: "${meta.title}" ep ${EP})`);
console.log(`    ${pad("SOURCE", 12)} ${pad("TIER", 9)} ${pad("MATCH", 7)} ${pad("STREAMS", 8)} NOTE`);
console.log(`    ${"-".repeat(74)}`);

let anyServing = false;
for (const p of providers) {
  const tier = p.tier || "quality";
  let match = "—", streams = "—", note = "";
  try {
    const [m] = await matchProviders(meta, [p]);
    match = m ? "yes" : "NO";
    if (!m) {
      note = "no match — provider has no entry for this title (or is unreachable)";
    } else {
      const s = await p.resolve(m.show, EP, "sub");
      streams = s.length;
      if (s.length) {
        anyServing = true;
        note = `✓ ${s[0].source || "serving"}`;
      } else {
        // Every provider explains an empty result on the array itself (see
        // withNote in lib/providers/debrid.mjs and note() in vidlink.mjs) —
        // "4 blocked (takedown), 6 not cached of 19 found", or which extension
        // said what. Printing "served nothing" and discarding that made this
        // check report the one thing it exists to diagnose as a shrug.
        note = s.note ? `nothing served — ${s.note}` : "matched but served nothing (no reason given)";
      }
    }
  } catch (e) {
    match = "err";
    note = e.message.slice(0, 60);
  }
  console.log(`    ${pad(p.label, 12)} ${pad(tier, 9)} ${pad(match, 7)} ${pad(streams, 8)} ${note}`);
}

// Typed health — the distinction that matters when something is wrong.
const unhealthy = getProvidersHealth().filter((h) => !["ok", "unknown"].includes(h.status));
if (unhealthy.length) {
  console.log(`\n    Diagnosis:`);
  for (const h of unhealthy) {
    const hint = {
      blocked: "bot-gated or IP-blocked. This does NOT self-heal — the source needs to change, not be retried.",
      "rate-limited": "throttled upstream; the breaker backs off and retries.",
      "upstream-down": "network/5xx — transient, retried automatically.",
      "no-match": "this title isn't in that provider's index. Normal, not a fault.",
      "no-sources": "matched the title but has nothing for this episode.",
      error: "unclassified failure.",
    }[h.status] || "";
    console.log(`      ${pad(h.label, 12)} ${pad(h.status, 14)} ${hint}`);
    if (h.lastError) console.log(`      ${" ".repeat(12)} ${" ".repeat(14)} last: ${h.lastError.slice(0, 90)}`);
    if (h.breakerOpen) console.log(`      ${" ".repeat(12)} ${" ".repeat(14)} breaker OPEN for ${Math.round(h.opensInMs / 1000)}s`);
  }
}

// ---- 4. the ranking, on real data ----
// The whole point of the rebuild: prove the ranker picks a release that meets
// the spec, and say what it threw away to get there.
console.log(`\n  RANKING   (what the quality tier would actually play)`);
// Prefer the anime indexer, but fall back to the movie one: an empty AnimeTosho
// result would otherwise hide whether ranking works at all, and ranking is the
// thing this check exists to prove.
let found = await searchAnimeTorrents(meta.romaji, EP).catch(() => []);
let target = { label: `"${meta.romaji}" ep ${EP}`, runtimeMin: meta.duration };
if (!found.length) {
  found = await searchMovies("inception 2010").catch(() => []);
  target = { label: `"Inception" (AnimeTosho returned nothing; falling back to the movie indexer)`, runtimeMin: 148 };
}
if (!found.length) {
  console.log(`    ✗ no releases from any indexer — they are unreachable from this box.`);
} else {
  console.log(`    target: ${target.label}`);
  const { list, rejected, floorApplied } = rankReleasesVerbose(found, { runtimeMin: target.runtimeMin });
  console.log(`    ${found.length} releases found · floor ${floorApplied ? "APPLIED" : "RELAXED (nothing met it)"} · ${rejected.length} rejected`);
  console.log(`\n    ${pad("#", 3)} ${pad("RES", 6)} ${pad("TIER", 8)} ${pad("BITRATE", 10)} ${pad("AUDIO", 20)} RELEASE`);
  console.log(`    ${"-".repeat(88)}`);
  for (const [i, r] of list.slice(0, 5).entries()) {
    console.log(`    ${pad(i === 0 ? "→" : i + 1, 3)} ${pad(r.resolution ? r.resolution + "p" : "?", 6)} ${pad(r.tier || "-", 8)} ` +
      `${pad(r.mbps ? r.mbps.toFixed(1) + " Mbps" : (r.pack ? "pack" : "?"), 10)} ${pad(r.audioLabel || "-", 20)} ${String(r.name).slice(0, 44)}`);
  }
  if (rejected.length) {
    console.log(`\n    Rejected (worst offenders first):`);
    for (const r of rejected.slice(0, 5)) console.log(`      ✗ ${pad(String(r.name).slice(0, 50), 52)} ${r.reason}`);
  }
  const top = list[0];
  if (top) {
    const meets = (top.resolution === 0 || top.resolution >= config.minResolution);
    const surround = (top.audio?.channels || 0) >= 6;
    console.log(`\n    Spec check: ${meets ? "✓" : "✗"} ${config.minResolution}p minimum` +
      ` · ${surround ? "✓ 5.1+" : "○ stereo/unknown"} audio` +
      ` · ${top.tier === "REMUX" || top.tier === "BluRay" ? "✓" : "○"} disc-grade source`);
  }
}

// ---- 5. index freshness ----
// A stale index answers instead of erroring, which is how AnimeTosho could die
// in May and be discovered in July. The searches above populated the ledger.
const fresh = indexFreshness();
if (fresh.length) {
  console.log(`\n  INDEX FRESHNESS   (newest release each index returned during this check)`);
  for (const f of fresh) {
    console.log(`    ${f.stale ? "⚠" : "✓"} ${pad(f.indexer, 12)} newest ${f.newestAt ? f.newestAt.slice(0, 10) : "unknown"}` +
      `${f.ageDays != null ? ` (${f.ageDays} days old)` : ""}${f.stale ? "  — STALE, this index has gone quiet" : ""}`);
  }
}

console.log(
  anyServing
    ? `\n  ✅ At least one provider is serving from this box.\n`
    : `\n  ✗ Nothing served from this box right now. Read the Diagnosis block above —\n    "blocked" means the source is gated and will not recover on its own.\n`
);
process.exit(anyServing ? 0 : 1);
