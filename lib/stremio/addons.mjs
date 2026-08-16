// Stremio addon-protocol client — the borrowed stack. A Stremio "addon" is just
// a stateless HTTP server serving JSON at three GET endpoints, keyed by
// universal ids (IMDb tt… for films/series, kitsu:… for anime):
//   /catalog/<type>/<id>[/<extra>].json  → { metas: [...] }
//   /meta/<type>/<id>.json               → { meta: {...} }
//   /stream/<type>/<id>.json             → { streams: [...] }
// We consume the same two public addons the Stremio app ships with:
//   • Cinemeta  — catalogs + metadata (posters, seasons/episodes), NO API key
//   • Torrentio — indexer-scraping stream addon returning torrent infoHashes
// Crucially we take Torrentio's PLAIN torrent results (no debrid config in the
// URL) and resolve them through our own Real-Debrid client, so the RD token
// never leaves this server — unlike the usual Stremio setup that embeds the
// token in the Torrentio addon URL.
import { magnetFromHash } from "../torrents.mjs";
import { parseResolution as parseQuality, qualityScore, describe } from "../quality.mjs";

const AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0";
export const CINEMETA = process.env.CINEMETA_BASE || "https://v3-cinemeta.strem.io";
export const TORRENTIO = process.env.TORRENTIO_BASE || "https://torrentio.strem.fun";

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": AGENT }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

export async function catalog(base, type, catalogId, extra = "") {
  const j = await getJson(`${base}/catalog/${type}/${catalogId}${extra ? `/${extra}` : ""}.json`);
  return j?.metas || [];
}

export async function meta(base, type, id) {
  const j = await getJson(`${base}/meta/${type}/${encodeURIComponent(id)}.json`);
  return j?.meta || null;
}

export async function streams(base, type, id) {
  const j = await getJson(`${base}/stream/${type}/${encodeURIComponent(id)}.json`);
  return j?.streams || [];
}

// A Cinemeta catalog/meta entry → this app's card shape. releaseInfo is a year
// or a "2011-2019" range; imdbRating is a string like "8.8".
export function fromCinemeta(m) {
  return {
    id: m.id,
    title: m.name,
    year: Number(String(m.releaseInfo || m.year || "").slice(0, 4)) || null,
    poster: m.poster || null,
    backdrop: m.background || null,
    overview: m.description || "",
    rating: m.imdbRating ? Math.round(parseFloat(m.imdbRating) * 10) || null : null,
    // Cinemeta reports runtime as "148 min". The quality ranker needs it as a
    // number: size-over-runtime is what separates a real release from a smeared
    // re-encode, and without it that test is simply skipped.
    runtime: Number(String(m.runtime || "").match(/\d+/)?.[0]) || null,
  };
}

// The card shape plus everything a DETAIL page wants. Kept beside fromCinemeta
// because it is the same meta object read at more depth: catalogs return the
// short form, /meta returns these extra fields, and Movies and TV both want
// exactly this set — the film's people, its genres, how long it runs.
export function detailFromCinemeta(m) {
  const people = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String) : []);
  return {
    ...fromCinemeta(m),
    genres: m.genres || m.genre || [],
    cast: people(m.cast).slice(0, 8),
    director: people(m.director),
    writer: people(m.writer),
    country: m.country || null,
    // "1994-09-23" / full ISO — only the date part is ever displayed.
    released: (m.released || m.releaseInfo || "").slice(0, 10) || null,
    imdbId: m.imdb_id || (String(m.id || "").startsWith("tt") ? m.id : null),
  };
}

// ---- unified catalog filters (Movies and TV share this exact model) ----
// Cinemeta's manifest exposes three sortable catalogs per type, each paged by
// `skip` (~50 metas a page):
//   top        — Popular    (extra: genre=<Genre>)
//   imdbRating — Featured   (extra: genre=<Genre> — curated, NOT rating-sorted)
//   year       — New        (extra: genre=<YEAR> — the year IS the genre slot)
// Genre and year therefore can't be combined server-side; with both set we page
// the `year` catalog and filter locally (catalog metas carry a `genre` array).
export const CATALOG_GENRES = {
  movie: ["Action", "Adventure", "Animation", "Biography", "Comedy", "Crime",
    "Documentary", "Drama", "Family", "Fantasy", "History", "Horror", "Mystery",
    "Romance", "Sci-Fi", "Sport", "Thriller", "War", "Western"],
  series: ["Action", "Adventure", "Animation", "Biography", "Comedy", "Crime",
    "Documentary", "Drama", "Family", "Fantasy", "History", "Horror", "Mystery",
    "Romance", "Sci-Fi", "Sport", "Thriller", "War", "Western",
    "Reality-TV", "Talk-Show", "Game-Show"],
};
export const CATALOG_SORTS = [
  { id: "popular", label: "Popular" },
  { id: "featured", label: "Featured" },
  { id: "new", label: "New" },
];

// A page this full probably has a next page; anything shorter is the tail.
const PAGE_FULL = 40;

// One filtered+paged catalog request. `skip` is an opaque cursor the caller
// round-trips from the previous page's `nextSkip`. Returns card-shaped items.
export async function filteredCatalog(type, { genre = null, sort = "popular", year = null, skip = 0 } = {}) {
  // A year pins us to the `year` catalog whatever the sort says (see above).
  const useYear = year || sort === "new";
  const y = year || new Date().getFullYear();
  const catalogId = useYear ? "year" : sort === "featured" ? "imdbRating" : "top";
  const wantGenre = (m) => !genre || (m.genre || m.genres || []).includes(genre);
  const page = (cursor) => {
    const extra = [
      useYear ? `genre=${y}` : genre && `genre=${encodeURIComponent(genre)}`,
      cursor && `skip=${cursor}`,
    ].filter(Boolean).join("&");
    return catalog(CINEMETA, type, catalogId, extra);
  };
  // Local genre filtering can decimate a page, so keep paging (bounded) until
  // the batch is presentable — the cursor advances by RAW metas consumed.
  let metas = [], cursor = skip, full = true;
  for (let i = 0; i < 4 && full && metas.length < 20; i++) {
    const raw = await page(cursor);
    full = raw.length >= PAGE_FULL;
    cursor += raw.length;
    metas.push(...raw.filter(wantGenre));
    if (!useYear || !genre) break; // server did the filtering — one page is one batch
  }
  return { items: metas.map(fromCinemeta), hasMore: full, nextSkip: cursor };
}

// A Torrentio stream entry → this repo's release shape (rankReleases input).
// Torrentio packs everything into two display strings:
//   name:  "Torrentio\n1080p"
//   title: "Movie.Name.2010.1080p.WEBRip\n👤 89 💾 1.85 GB ⚙️ ThePirateBay"
// For season packs it also sets fileIdx — WHICH file inside the torrent is this
// episode — which we forward so RD selects the right file, not just the biggest.
// `indexer` is which INDEX found this release, as distinct from which debrid
// service ends up serving it. Movies and TV merge several indexers into one
// ranked list and then label every row by the debrid backend, so a Torrentio
// hit and an apibay hit both read "Real-Debrid" — which looks, correctly
// enough, like Torrentio isn't being used at all.
export function parseAddonStream(s, indexer = "torrentio") {
  if (!s?.infoHash) return null; // debrid/external entries have url instead — not used here
  const line = (s.title || "").split("\n")[0].trim() || s.behaviorHints?.filename || "";
  const seeders = Number((s.title || "").match(/👤\s*(\d+)/u)?.[1]) || 0;
  return {
    name: line,
    hash: s.infoHash,
    seeders,
    size: 0,
    magnet: magnetFromHash(s.infoHash, line),
    fileIdx: Number.isInteger(s.fileIdx) ? s.fileIdx : null,
    indexer,
  };
}

export const parseTorrentioStream = (s) => parseAddonStream(s, "torrentio");

// All torrent releases Torrentio knows for one id, in release shape.
export async function torrentioReleases(type, id) {
  const list = await streams(TORRENTIO, type, id);
  return list.map(parseTorrentioStream).filter(Boolean);
}

// ---- extra addons: redundancy without another container ----
//
// Torrentio is ONE hosted service. It scrapes a dozen indexers, which reads
// like redundancy but isn't — when strem.fun is down or rate-limiting, Movies
// and TV fall back to apibay alone, and apibay is one site too. So the source
// list becomes CONFIGURATION: any number of Stremio-protocol addons, each a
// base URL in STREMIO_ADDONS, queried beside Torrentio and merged.
//
// Configuration rather than code because these services churn — the same
// reasoning that keeps source churn out of this repo. A dead addon is a URL
// swap, not a release.
//
// Most of them (MediaFusion, Comet) bake per-user settings INTO the path, so
// the value is whatever their web UI hands you, config segment and all:
//   STREMIO_ADDONS=https://mediafusion.elfhosted.com/D-aB.../,https://comet.../
const ADDON_BASES = (process.env.STREMIO_ADDONS || "")
  .split(",")
  .map((s) => s.trim())
  // People paste what the addon's UI shows them, and what it shows them is the
  // MANIFEST url. Left as-is that produces /manifest.json/stream/movie/tt….json
  // and a 404 on every request — a "this addon is dead" that is really a typo.
  .map((s) => s.replace(/\/+$/, "").replace(/\/manifest\.json$/i, ""))
  .filter((s) => /^https?:\/\//i.test(s));

export const extraAddons = () => [...ADDON_BASES];

// A short, stable label per addon so the Servers panel can say which source a
// row came from. The host is the only part guaranteed to exist and not to be a
// wall of base64 config.
export function addonLabel(base) {
  try { return new URL(base).hostname.replace(/^www\./, ""); }
  catch { return "addon"; }
}

// Every configured extra addon, in parallel, merged. One addon being down,
// slow, or wrong must never affect the others — or Torrentio — so each is
// caught individually and contributes [] on failure.
export async function extraAddonReleases(type, id) {
  if (!ADDON_BASES.length) return [];
  const lists = await Promise.all(ADDON_BASES.map(async (base) => {
    try {
      const list = await streams(base, type, id);
      return list.map((s) => parseAddonStream(s, addonLabel(base))).filter(Boolean);
    } catch { return []; }
  }));
  return lists.flat();
}

// Order Torrentio releases for EPISODE playback.
//
// The old band order here was 1080p → 720p → rest → 2160p, putting 4K BELOW
// 480p because 4K files are huge and were least likely to be debrid-cached.
// With no cache oracle left to optimise against and transcoding done locally,
// that ordering only capped quality, so ranking is now the shared quality model.
//
// One thing is preserved deliberately: Torrentio's own order encodes which
// release actually contains the requested episode (its fileIdx work), and a
// pure re-rank once promoted a mega-pack whose index pointed at a spin-off. So
// Torrentio's position stays as the FINAL tiebreak, and quality scoring is
// coarse-grained on purpose — releases within ~8 points are treated as equal
// and left in Torrentio's order rather than reshuffled on noise.
const BUCKET = 8;
export function preferQuality(releases, { runtimeMin = null, mode = "sub", rdFilter = false } = {}) {
  return releases
    .map((r, i) => ({
      ...r,
      quality: r.quality ?? parseQuality(r.name),
      ...describe(r, { runtimeMin }),
      _i: i,
      _s: qualityScore(r, { runtimeMin, mode, rdFilter }),
    }))
    .sort((a, b) => Math.round(b._s / BUCKET) - Math.round(a._s / BUCKET) || a._i - b._i);
}
