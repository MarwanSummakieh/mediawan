#!/usr/bin/env node
// why — the per-candidate verdict table for one episode.
//
//   npm run why -- <anilistId>:<ep> [--mode dub] [--dry] [--tries N]
//   npm run why -- 178533:4              # Grand Blue S3 ep 4: why won't it play?
//
// Turns "it stopped working" into one command: for every index this app
// searches, print every release it found and the exact verdict each one got —
// dropped by the identity gate, dropped by the quality floor, carrying a tag
// Real-Debrid's takedown filter refuses, or actually attempted against
// Real-Debrid (cached / uncached / blocked). The same code paths the player
// uses answer here, so what this prints is what a play would do.
//
// --dry skips the Real-Debrid attempts (no API calls, no torrents added);
// --tries caps how many ranked candidates are attempted per index (default 6).
// Diagnostic torrents are always deleted on the way out.
import { fetchMeta } from "../lib/anilist.mjs";
import { gatherCandidates } from "../lib/providers/torrent-source.mjs";
import { searchSubsPlease, searchNyaaTorrents, searchAnimeTorrents, indexFreshness } from "../lib/torrents.mjs";
import { torrentioReleases, preferQuality } from "../lib/stremio/addons.mjs";
import { meetsFloor, RD_FILTERED_TAGS } from "../lib/quality.mjs";
import { titleRelevant, seasonMatches, wantedSeason, isMultiSeason, titleForms } from "../lib/match-release.mjs";
import { debridEnabled, streamFromMagnet, remove, skipReason } from "../lib/debrid/realdebrid.mjs";
import { config } from "../lib/config.mjs";

const args = process.argv.slice(2);
const target = args.find((a) => /^\d+:\d+$/.test(a));
if (!target) {
  console.error("\n  usage: npm run why -- <anilistId>:<ep> [--mode dub] [--dry] [--tries N]\n");
  process.exit(2);
}
const [anilistId, ep] = target.split(":");
const mode = args.includes("--mode") ? (args[args.indexOf("--mode") + 1] || "sub") : "sub";
const dry = args.includes("--dry") || !debridEnabled();
const tries = args.includes("--tries") ? Number(args[args.indexOf("--tries") + 1]) || 6 : 6;

const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
const short = (s, n = 58) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

const meta = await fetchMeta(Number(anilistId));
if (!meta) {
  console.error(`\n  ✗ AniList has no entry ${anilistId}\n`);
  process.exit(1);
}
const show = { query: meta.romaji || meta.title, meta };
const wantSeason = wantedSeason(meta);

console.log(`\n  why · "${meta.title}" (${meta.romaji}) — episode ${ep}, ${mode}`);
console.log(`  season ${wantSeason} · runtime ${meta.duration ?? "?"} min · floor ${config.minResolution}p` +
  (dry ? " · DRY (no Real-Debrid attempts)" : ` · attempting top ${tries} per index via Real-Debrid`));

// What a play would do to a candidate that reached the attempt loop.
async function attempt(c, epUsed) {
  let skipped = null;
  try {
    const s = await streamFromMagnet(c.magnet, {
      waitMs: 8000, metaTries: 6, fileIdx: c.fileIdx ?? null,
      onSkip: (r) => { skipped = r; },
      want: {
        titles: titleForms(meta),
        episode: epUsed,
        season: isMultiSeason(c.name) ? wantSeason : undefined,
      },
    });
    if (s) {
      remove(s.torrentId).catch(() => {}); // diagnostic only — don't keep it
      return "CACHED ✓ plays";
    }
    return skipped === "blocked" ? "BLOCKED (takedown)" : "uncached";
  } catch (e) {
    return skipReason(e) === "blocked" ? "BLOCKED (takedown)" : `error: ${short(e.message, 32)}`;
  }
}

// One index's verdict table. `found` is everything the search returned;
// `cands` the ranked survivors, best first (the play's attempt order).
async function report(label, { found, cands, epUsed }) {
  console.log(`\n  ${label.toUpperCase()}   (${found.length} found · ${cands.length} ranked · searched as ep ${epUsed ?? ep})`);
  if (!found.length) return;
  console.log(`    ${pad("#", 4)} ${pad("SCORE", 6)} ${pad("RES", 5)} ${pad("TIER", 7)} ${pad("MBPS", 5)} ${pad("SEED", 5)} ${pad("VERDICT", 26)} RELEASE`);
  console.log(`    ${"-".repeat(112)}`);
  const rank = new Map(cands.map((c, i) => [c.hash || c.magnet || c.name, i]));
  // Ranked candidates first, in attempt order; the gated-out remainder after.
  const rows = [...cands, ...found.filter((c) => !rank.has(c.hash || c.magnet || c.name))];
  for (const c of rows) {
    const i = rank.get(c.hash || c.magnet || c.name);
    let verdict;
    if (i == null) {
      // Why did the gates drop it? Same order the resolver applies them.
      if (!titleRelevant(c.name, meta)) verdict = "dropped: title mismatch";
      else if (!seasonMatches(c.name, wantSeason)) verdict = "dropped: wrong season";
      else {
        const gate = meetsFloor(c, { runtimeMin: meta.duration, minResolution: config.minResolution });
        verdict = gate.ok ? "dropped: identity unconfirmed" : `sub-floor: ${gate.reason}`;
      }
    } else if (!dry && i < tries) {
      verdict = await attempt(c, epUsed);
    } else {
      verdict = i < 10 ? "would attempt" : "ranked below attempt budget";
    }
    if (RD_FILTERED_TAGS.test(c.name)) verdict += " [rd-filter tag]";
    // The verdict is the point of this table — pad it, never truncate it.
    console.log(`    ${pad(i != null ? i + 1 : "—", 4)} ${pad(c._s != null ? Math.round(c._s) : "—", 6)} ` +
      `${pad(c.quality ? `${c.quality}p` : "?", 5)} ${pad(c.tier || "—", 7)} ` +
      `${pad(c.mbps != null ? c.mbps.toFixed(1) : "—", 5)} ${pad(c.seeders ?? "—", 5)} ` +
      `${String(verdict).padEnd(26)} ${short(c.name)}`);
  }
}

// ---- the three text-searched indexes: the resolver's own gather step ----
for (const [label, search] of [
  ["SubsPlease", searchSubsPlease],
  ["Nyaa", searchNyaaTorrents],
  ["AnimeTosho", searchAnimeTorrents],
]) {
  try {
    await report(label, await gatherCandidates({ search, show, ep, mode }));
  } catch (e) {
    console.log(`\n  ${label.toUpperCase()}   ✗ ${short(e.message, 80)}`);
  }
}

// ---- Torrentio: id-mapped, so its gather step is the Kitsu translation ----
try {
  const r = await fetch(`${process.env.RELATIONS_BASE || "https://relations.yuna.moe"}/api/ids?source=anilist&id=${anilistId}`,
    { signal: AbortSignal.timeout(8000) });
  const kitsu = r.ok ? (await r.json())?.kitsu ?? null : null;
  if (!kitsu) {
    console.log(`\n  TORRENTIO   ✗ no AniList→Kitsu mapping — this title is invisible to Torrentio`);
  } else {
    let releases = await torrentioReleases("series", `kitsu:${kitsu}:${Number(ep)}`).catch(() => []);
    if (!releases.length) releases = await torrentioReleases("anime", `kitsu:${kitsu}:${Number(ep)}`).catch(() => []);
    const ranked = preferQuality(releases, { runtimeMin: meta.duration, mode, rdFilter: true });
    const inSeason = ranked.filter((c) => seasonMatches(c.name, wantSeason));
    await report(`Torrentio (kitsu:${kitsu})`, {
      found: ranked,
      cands: inSeason.length ? inSeason : ranked,
      epUsed: ep,
    });
  }
} catch (e) {
  console.log(`\n  TORRENTIO   ✗ ${short(e.message, 80)}`);
}

// ---- index freshness: is anyone quietly dead? ----
const fresh = indexFreshness();
if (fresh.length) {
  console.log(`\n  INDEX FRESHNESS   (newest release each index returned during this run)`);
  for (const f of fresh) {
    console.log(`    ${pad(f.indexer, 12)} newest ${f.newestAt ? f.newestAt.slice(0, 10) : "unknown"}` +
      `${f.ageDays != null ? ` (${f.ageDays} days old)` : ""}${f.stale ? "  ⚠ STALE — this index has gone quiet" : ""}`);
  }
}
console.log("");
