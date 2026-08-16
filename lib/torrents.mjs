// Torrent indexers — turn a title (and, for anime, an episode) into ranked
// magnet candidates to hand to Real-Debrid. Two keyless sources that respond
// from anywhere (no Cloudflare wall, unlike the streaming scrapers):
//   • apibay  — The Pirate Bay's JSON API: movies (+ a "top 100" browse list).
//   • AnimeTosho — anime releases (mirrors Nyaa), already used elsewhere.
// We never torrent anything ourselves; these just supply the magnet + metadata.
import { rankByQuality, rankIgnoringFloor } from "./quality.mjs";
import { config } from "./config.mjs";

const AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0";

const APIBAY = process.env.APIBAY_BASE || "https://apibay.org";
const TOSHO = "https://feed.animetosho.org";
// A dead hash apibay returns for "no results".
const NULL_HASH = "0000000000000000000000000000000000000000";
// Public trackers appended to hash-only sources so RD resolves the magnet fast.
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
];

export function magnetFromHash(hash, name = "") {
  const tr = TRACKERS.map((t) => `tr=${encodeURIComponent(t)}`).join("&");
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}&${tr}`;
}

// ---- index freshness ----
//
// A stale index doesn't error — it ANSWERS, with old results, which is why
// AnimeTosho could stop ingesting on 2026-05-08 and nobody noticed until
// 2026-07-31. Every search records the newest release timestamp its index
// returned; /healthz and the admin panel surface the age, so the next quiet
// death becomes a visible warning within days instead of an accidental
// discovery months later.
//
// Honesty note: this only measures what queries actually saw. An index nobody
// has searched reports nothing, and a query for an old show legitimately
// returns old releases — which is why the newest-ever-seen timestamp is kept,
// not the latest query's.
const STALE_AFTER_MS = 7 * 86400e3; // a weekly airing cadence, with slack
// One query about an old show legitimately returns only old releases, so a
// single observation must not cry wolf — the alarm needs a few distinct
// queries to all have come back old before it means anything.
const STALE_MIN_QUERIES = 3;
const freshness = new Map(); // indexer -> { newestAt, checkedAt, queries, warned }

const isStale = (f, now = Date.now()) =>
  f.newestAt != null && f.queries >= STALE_MIN_QUERIES && now - f.newestAt > STALE_AFTER_MS;

function noteFreshness(indexer, timestampsMs) {
  const newest = Math.max(0, ...timestampsMs.filter((t) => Number.isFinite(t) && t > 0));
  const f = freshness.get(indexer) || { newestAt: null, checkedAt: 0, queries: 0, warned: false };
  f.checkedAt = Date.now();
  f.queries++;
  if (newest > (f.newestAt || 0)) f.newestAt = newest;
  freshness.set(indexer, f);
  if (isStale(f) && !f.warned) {
    f.warned = true; // once per process — the health endpoints carry it from here
    console.warn(`  [torrents] index "${indexer}" looks STALE — newest release it has returned is ${Math.round((Date.now() - f.newestAt) / 86400e3)} days old`);
  }
}

export function indexFreshness() {
  const now = Date.now();
  return [...freshness.entries()].map(([indexer, f]) => {
    const ageDays = f.newestAt ? (now - f.newestAt) / 86400e3 : null;
    return {
      indexer,
      newestAt: f.newestAt ? new Date(f.newestAt).toISOString() : null,
      ageDays: ageDays != null ? Math.round(ageDays * 10) / 10 : null,
      stale: isStale(f, now),
      queries: f.queries,
      checkedAt: new Date(f.checkedAt).toISOString(),
    };
  });
}

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": AGENT }, signal: AbortSignal.timeout(12000) });
  const ct = r.headers.get("content-type") || "";
  if (!r.ok || !ct.includes("json")) return null;
  return r.json();
}

// ---- release-name parsing / ranking (pure, unit-tested) ----
// Parse "Inception.2010.1080p.BrRip.x264.YIFY.mp4" → { title:"Inception", year:2010 }.
export function parseMovieName(name) {
  const cleaned = name.replace(/[._]/g, " ");
  const ym = cleaned.match(/\b(19|20)\d{2}\b/);
  const year = ym ? Number(ym[0]) : null;
  let title = ym
    ? cleaned.slice(0, ym.index)
    : cleaned.replace(/\b(1080p|720p|2160p|480p|4k|bluray|brrip|webrip|web-?dl|hdrip|x264|x265|hevc).*$/i, "");
  // strip a trailing "(" / "[" / "-" left when the year sat inside brackets
  title = title.replace(/\s+/g, " ").replace(/[\s([\-]+$/, "").trim();
  return { title, year };
}

// Ranking lives in lib/quality.mjs now — one model for every vertical, scoring
// picture and sound rather than how likely a release was to be debrid-cached.
// These aliases keep the older names meaningful at call sites that only want
// the parse, not the score.
export { parseResolution as parseQuality, parseSourceTier as parseSource } from "./quality.mjs";

// Rank candidates best-first, dropping anything below the quality floor.
//
// `runtimeMin` is what unlocks the bitrate test — the only thing that reliably
// separates a real 1080p release from a smeared re-encode wearing the same tag
// — so callers should pass it whenever the metadata has it.
//
// The floor is deliberately soft-failing: if applying it leaves NOTHING, the
// unfiltered ranking is returned instead. A thin field for an obscure title
// should degrade to "the best of a bad lot", never to an unplayable screen.
export function rankReleases(list, { runtimeMin = null, minResolution = config.minResolution, mode = "sub", rdFilter = false } = {}) {
  const { list: kept } = rankByQuality(list, { runtimeMin, minResolution, mode, rdFilter });
  return kept.length ? kept : rankIgnoringFloor(list, { runtimeMin, mode, rdFilter });
}

// Same, but tells you what was dropped and why — for check-sources and the
// admin panel, where "no sources" needs to be distinguishable from "sources
// existed, all of them were junk".
export function rankReleasesVerbose(list, { runtimeMin = null, minResolution = config.minResolution, mode = "sub" } = {}) {
  const { list: kept, rejected } = rankByQuality(list, { runtimeMin, minResolution, mode });
  return kept.length
    ? { list: kept, rejected, floorApplied: true }
    : { list: rankIgnoringFloor(list, { runtimeMin, mode }), rejected, floorApplied: false };
}

// Does this release name plausibly contain the wanted episode number?
// Matches "- 07", "E07", "EP07", "S01E07", "07v2" but not years like "2010".
export function releaseHasEpisode(name, ep) {
  const n = Number(ep);
  if (!Number.isFinite(n)) return true;
  const re = new RegExp(`(?:\\bE|\\bEP|S\\d{1,2}E|[-_\\s])0*${n}(?:v\\d)?(?:[\\s._\\-\\)\\]]|$)`, "i");
  // guard: avoid matching the number inside a 4-digit year/resolution
  const stripped = String(name || "").replace(/\b(19|20)\d{2}\b/g, "").replace(/\d{3,4}p/gi, "");
  if (re.test(stripped)) return true;
  // Batch releases name a RANGE ("01-28", "E01~E24") rather than each episode;
  // the wanted number is in the batch when it falls inside. Without this, every
  // complete-season pack failed the episode filter for any mid-season episode —
  // which, once an index's front page is flooded by a sequel, can be the ONLY
  // copy of an older season still findable (see searchNyaaTorrents).
  for (const m of stripped.matchAll(/(?:^|[\s._\-[(])(?:E|EP)?0*(\d{1,3})\s*[-~]\s*(?:E|EP)?0*(\d{1,3})(?=[\s._\-\)\]]|$)/gi)) {
    const lo = Number(m[1]), hi = Number(m[2]);
    if (lo < hi && n >= lo && n <= hi) return true;
  }
  return false;
}

// ---- movies (apibay) ----
// Categories: 201 = Movies, 207 = HD Movies. Restricting to 207 alone hid every
// release an uploader filed under the generic category — including most 4K,
// which apibay has no separate category for — so a title could read as
// "nothing indexed" while apibay held a dozen copies of it.
export async function searchMovies(query) {
  const j = await getJson(`${APIBAY}/q.php?q=${encodeURIComponent(query)}&cat=201,207`);
  const rows = (j || []).filter((x) => x.info_hash && x.info_hash !== NULL_HASH);
  return rows.map((x) => ({
    name: x.name,
    hash: x.info_hash,
    seeders: Number(x.seeders) || 0,
    size: Number(x.size) || 0,
    magnet: magnetFromHash(x.info_hash, x.name),
    indexer: "apibay",
  }));
}

// The site's precompiled "top 100" HD-movie list — a keyless browse feed.
export async function topMovies() {
  const j = await getJson(`${APIBAY}/precompiled/data_top100_207.json`);
  return (j || [])
    .filter((x) => x.info_hash && x.info_hash !== NULL_HASH)
    .map((x) => ({
      name: x.name,
      hash: x.info_hash,
      seeders: Number(x.seeders) || 0,
      size: Number(x.size) || 0,
      magnet: magnetFromHash(x.info_hash, x.name),
      indexer: "apibay",
    }));
}

// ---- TV episodes (apibay) ----
// A "Show S01E05" query is specific enough that apibay returns the right
// episode across its TV categories. 205 = TV shows, 208 = HD TV: same reason as
// the movie categories above, an uploader's filing choice must not decide
// whether an episode is findable.
export async function searchTvTorrents(query) {
  const j = await getJson(`${APIBAY}/q.php?q=${encodeURIComponent(query)}&cat=205,208`);
  const rows = (j || []).filter((x) => x.info_hash && x.info_hash !== NULL_HASH);
  return rows.map((x) => ({
    name: x.name,
    hash: x.info_hash,
    seeders: Number(x.seeders) || 0,
    size: Number(x.size) || 0,
    magnet: magnetFromHash(x.info_hash, x.name),
    indexer: "apibay",
  }));
}

// ---- anime (AnimeTosho) ----
export async function searchAnimeTorrents(query, ep) {
  const j = await getJson(`${TOSHO}/json?q=${encodeURIComponent(query)}`);
  let rows = (j || []).filter((x) => x.info_hash && x.magnet_uri);
  noteFreshness("animetosho", rows.map((x) => Number(x.timestamp) * 1000));
  if (ep != null) rows = rows.filter((x) => releaseHasEpisode(x.torrent_name || x.title || "", ep));
  return rows.map((x) => ({
    name: x.torrent_name || x.title,
    hash: x.info_hash,
    seeders: Number(x.seeders) || 0,
    size: Number(x.total_size) || 0,
    magnet: x.magnet_uri || magnetFromHash(x.info_hash, x.torrent_name),
    indexer: "animetosho",
  }));
}

// ---- SubsPlease (first-party, live to the minute) ----
//
// The simulcast group itself, not an aggregator: a new episode appears here
// minutes after it airs, with none of the lag that killed the mirrors (AnimeTosho
// went three months stale) and none of the ingest gaps (Torrentio's Kitsu index
// had zero entries for Grand Blue Season 3). Just as important, its names are
// UNTAGGED — "[SubsPlease] Show - 01 (1080p)" carries none of the CR/WEB-DL
// markers Real-Debrid's takedown filter keys on — so these releases actually
// play where the tagged equivalents draw a 451.
//
// The API returns no seeders and no size. Both stay ABSENT rather than zero:
// looksFetchable reads a missing seeder count as "unknown, try it" (zero would
// read as dead and drop the whole catalogue), and a missing size skips the
// bitrate floor instead of failing it.
const SUBSPLEASE = process.env.SUBSPLEASE_BASE || "https://subsplease.org/api";

// SubsPlease magnets carry base32 infohashes; Real-Debrid and everything in
// this codebase that de-dups or cache-checks by hash speaks hex. RFC 4648
// alphabet, 32 chars × 5 bits = the 160-bit infohash exactly.
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32ToHex(s) {
  const up = String(s || "").toUpperCase();
  if (!/^[A-Z2-7]{32}$/.test(up)) return null;
  let bits = 0n;
  for (const ch of up) bits = (bits << 5n) | BigInt(B32_ALPHABET.indexOf(ch));
  return bits.toString(16).padStart(40, "0");
}

// A magnet's infohash as 40-char hex, whatever base the magnet used.
export function hexHashFromMagnet(magnet) {
  const m = String(magnet || "").match(/btih:([A-Za-z0-9]{32,40})/);
  if (!m) return null;
  return /^[A-Fa-f0-9]{40}$/.test(m[1]) ? m[1].toLowerCase() : base32ToHex(m[1]);
}

// "07/31/26" (the API's short US-style date, its `time` field) → ms. The
// `release_date` field is RFC 2822 and Date.parse reads it directly; this
// handles the short form when that's all an entry carries.
export function parseSubsPleaseDate(s) {
  const m = String(s || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const t = Date.UTC(year, Number(m[1]) - 1, Number(m[2]));
  return Number.isFinite(t) ? t : null;
}

const subsPleaseTimestamp = (item) => {
  const rfc = Date.parse(item?.release_date || "");
  return Number.isFinite(rfc) ? rfc : parseSubsPleaseDate(item?.time);
};

export async function searchSubsPlease(query, ep) {
  // NOT getJson: the API answers with Content-Type: text/html (verified live
  // 2026-07-31), so a content-type gate reads a perfectly good response as
  // nothing at all. Parse the body and let that be the judge.
  let j = null;
  try {
    const r = await fetch(`${SUBSPLEASE}/?f=search&tz=UTC&s=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": AGENT }, signal: AbortSignal.timeout(12000) });
    if (r.ok) j = JSON.parse(await r.text());
  } catch { return []; }
  // Results are an OBJECT keyed by release; "no results" is an empty ARRAY.
  const items = j && !Array.isArray(j) ? Object.values(j) : [];
  noteFreshness("subsplease", items.map(subsPleaseTimestamp));
  const out = [];
  for (const item of items) {
    for (const d of item?.downloads || []) {
      const raw = String(d?.magnet || "");
      const hash = hexHashFromMagnet(raw);
      if (!hash) continue;
      // Prefer the magnet's own display name (the real release name); synthesize
      // the group's exact convention when it's missing so the resolution and
      // episode parsers still have something true to read.
      const dn = raw.match(/[?&]dn=([^&]*)/);
      const name = (dn && decodeURIComponent(dn[1].replace(/\+/g, " ")).trim()) ||
        `[SubsPlease] ${item.show || query} - ${item.episode || ""} (${d.res || "?"}p)`.replace(/\s+/g, " ");
      // The magnet's `xl` (exact length) is the one piece of size data the API
      // does publish — it feeds the bitrate floor the same as any indexer size.
      const xl = raw.match(/[?&]xl=(\d+)/);
      out.push({
        name,
        hash,
        size: xl ? Number(xl[1]) : 0, // 0 = unknown — no bitrate evidence
        magnet: magnetFromHash(hash, name),
        indexer: "subsplease",
        // seeders deliberately ABSENT (not 0): see looksFetchable.
      });
    }
  }
  return ep != null ? out.filter((x) => releaseHasEpisode(x.name, ep)) : out;
}

// ---- Nyaa (the source AnimeTosho mirrors) ----
//
// Added because the mirror went STALE: measured 2026-07-31, the newest entry
// feed.animetosho.org would return for any query was 2026-05-08, so every show
// that started airing after early May resolved to zero candidates and the whole
// debrid tier looked broken. Nyaa itself was fine the entire time — Grand Blue
// Season 3 episode 4 had eleven releases there and none on AnimeTosho.
//
// Nyaa publishes no JSON API, but its RSS carries exactly what a candidate
// needs: name, infoHash, seeders and size. Category 1_2 is
// "Anime - English-translated", which is the fansub field this app wants;
// `f=0` keeps unfiltered results (trusted-only would drop most weekly groups).
const NYAA = process.env.NYAA_BASE || "https://nyaa.si";

// "818.9 MiB" / "1.4 GiB" → bytes. Sizes gate the quality ranker's bitrate
// floor, so a size that fails to parse would make a real release look like a
// re-encode; unparseable input yields 0, which the ranker treats as unknown.
export function parseNyaaSize(s) {
  const m = String(s || "").match(/([\d.]+)\s*([KMGT]?)i?B/i);
  if (!m) return 0;
  const mult = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2].toUpperCase()] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

// Minimal, tolerant RSS field extraction — no XML dependency for four fields.
export function parseNyaaRss(xml) {
  const out = [];
  for (const block of String(xml || "").split("<item>").slice(1)) {
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
      return m ? m[1].trim() : "";
    };
    const name = pick("title")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const hash = pick("nyaa:infoHash").toLowerCase();
    if (!name || !/^[a-f0-9]{40}$/.test(hash)) continue;
    const published = Date.parse(pick("pubDate"));
    out.push({
      name,
      hash,
      seeders: Number(pick("nyaa:seeders")) || 0,
      size: parseNyaaSize(pick("nyaa:size")),
      magnet: magnetFromHash(hash, name),
      indexer: "nyaa",
      publishedAt: Number.isFinite(published) ? published : null,
    });
  }
  return out;
}

async function fetchNyaaPage(query, page = 1) {
  let xml = "";
  try {
    const r = await fetch(`${NYAA}/?page=rss&q=${encodeURIComponent(query)}&c=1_2&f=0${page > 1 ? `&p=${page}` : ""}`,
      { headers: { "User-Agent": AGENT }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return [];
    xml = await r.text();
  } catch { return []; }
  const rows = parseNyaaRss(xml);
  noteFreshness("nyaa", rows.map((x) => x.publishedAt));
  return rows;
}

export async function searchNyaaTorrents(query, ep) {
  const rows = await fetchNyaaPage(query);
  const hits = ep != null ? rows.filter((x) => releaseHasEpisode(x.name, ep)) : rows;
  if (ep == null || hits.length) return hits;
  // Reach-back. The RSS feed is newest-first and CAPPED (~75 entries), so while
  // a sequel is airing its weekly flood owns the whole window and an older
  // season's episodes fall off the end entirely — measured with Frieren S2
  // airing, a search for "Sousou no Frieren" no longer surfaced anything from
  // S1. Only on a miss (so current-season lookups pay nothing), reach further
  // three cheap ways in parallel: qualify the QUERY with the episode number
  // (matches "Show - 07"-style names directly), ask for complete batches
  // (releaseHasEpisode understands "01-28" ranges), and read page two.
  const pad = String(Number(ep)).padStart(2, "0");
  const deeper = await Promise.all([
    fetchNyaaPage(`${query} ${pad}`),
    fetchNyaaPage(`${query} batch`),
    fetchNyaaPage(query, 2),
  ]);
  const seen = new Set(rows.map((x) => x.hash));
  const extra = [];
  for (const x of deeper.flat()) {
    if (seen.has(x.hash)) continue;
    seen.add(x.hash);
    if (releaseHasEpisode(x.name, ep)) extra.push(x);
  }
  return extra;
}
