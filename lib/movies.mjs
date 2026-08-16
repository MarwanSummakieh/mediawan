// Movies domain — a second content vertical alongside anime, on the borrowed
// Stremio stack:
//   • Cinemeta  → the catalog: popular/top movies with posters, ratings and
//     synopsis, keyed by IMDb ids. Keyless — no TMDB account needed anymore.
//   • Torrentio → release discovery: ranked torrent infoHashes per IMDb id,
//     drawn from many indexers (far wider than apibay alone).
//   • Real-Debrid → playback, exactly as before (streamFirstCached).
// apibay stays as the fallback on both axes: catalog when Cinemeta is down,
// release source when Torrentio is down or dry.
import { CINEMETA, catalog as addonCatalog, meta as addonMeta, torrentioReleases, extraAddonReleases, fromCinemeta, detailFromCinemeta, filteredCatalog } from "./stremio/addons.mjs";
import { topMovies, searchMovies as searchApibay, rankReleases, parseMovieName } from "./torrents.mjs";
import { anyDebridEnabled as debridEnabled } from "./debrid/backends.mjs";
import { streamFirstCached, streamPerBand } from "./debrid/candidates.mjs";
import { startDownload } from "./debrid/realdebrid.mjs";
import { describeReleases, findRelease, preferSignatures, mergeReleases } from "./servers.mjs";
import { preferTranscodeFriendly } from "./quality.mjs";
import { movieStreams, vidlinkEnabled } from "./providers/vidlink.mjs";

// Play the floor tier first and treat the debrid release as the upgrade.
const VIDLINK_PRIMARY = process.env.VIDLINK_PRIMARY === "true";

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const apibayId = (title, year) => `m-${slug(title)}${year ? "-" + year : ""}`;

// id -> card record. Cinemeta records are keyed by IMDb id ("tt…"); apibay
// fallback records ("m-…") also carry pre-ranked release candidates.
const catalog = new Map();
function remember(rec) {
  const existing = catalog.get(rec.id);
  catalog.set(rec.id, { ...rec, candidates: rec.candidates ?? existing?.candidates ?? null });
  return rec;
}

// ---- apibay (keyless fallback catalog: release names only, no art) ----
function fromApibayRows(rows) {
  const byId = new Map();
  for (const r of rows) {
    const { title, year } = parseMovieName(r.name);
    if (!title) continue;
    const id = apibayId(title, year);
    if (!byId.has(id)) byId.set(id, { id, title, year, releases: [] });
    byId.get(id).releases.push(r);
  }
  const out = [];
  for (const g of byId.values()) {
    const ranked = rankReleases(g.releases);
    remember({ id: g.id, title: g.title, year: g.year, candidates: ranked });
    out.push({ id: g.id, title: g.title, year: g.year, poster: null, overview: "", rating: null, quality: ranked[0].quality, seeders: ranked[0].seeders });
  }
  return out.sort((a, b) => b.seeders - a.seeders);
}

// ---- public API ----
// One cache entry per filter combination (each is its own Cinemeta page).
const browseCache = new Map(); // filter signature -> { at, data }
export async function browse(filters = {}) {
  const key = JSON.stringify([filters.genre, filters.sort, filters.year, filters.skip]);
  const hit = browseCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;
  const r = await filteredCatalog("movie", filters).catch(() => ({ items: [], hasMore: false, nextSkip: 0 }));
  let data = { ...r, items: r.items.map(remember).map(({ candidates, ...card }) => card) };
  // apibay fallback only covers the plain front page — it has no filter axes.
  const unfiltered = !filters.genre && !filters.year && !filters.skip && (filters.sort ?? "popular") === "popular";
  if (!data.items.length && unfiltered)
    data = { items: fromApibayRows(await topMovies()).slice(0, 48), hasMore: false, nextSkip: 0 };
  // Never cache an empty page — a transient Cinemeta failure would otherwise
  // pin "no results" on this filter combination for the whole TTL.
  if (data.items.length) {
    if (browseCache.size > 60) browseCache.delete(browseCache.keys().next().value);
    browseCache.set(key, { at: Date.now(), data });
  }
  return data;
}

export async function search(query) {
  const metas = await addonCatalog(CINEMETA, "movie", "top", `search=${encodeURIComponent(query)}`).catch(() => []);
  if (metas.length)
    return metas.map(fromCinemeta).map(remember).slice(0, 24).map(({ candidates, ...card }) => card);
  return fromApibayRows(await searchApibay(query)).slice(0, 24);
}

// Ranked release candidates for one record: Torrentio by IMDb id first, apibay
// title search as the fallback. Cached on the record after the first resolve.
// Both indexers, always, merged — not apibay-only-when-Torrentio-is-empty.
// They overlap on blockbusters but diverge sharply elsewhere: Torrentio had 77
// releases for Interstellar and ZERO for Coherence, where apibay had 32. Asking
// both costs one parallel request and is the difference between "no sources"
// and a working film. Ranking still decides the order.
async function candidatesFor(rec) {
  if (rec.candidates?.length) return rec.candidates;
  const q = rec.year ? `${rec.title} ${rec.year}` : rec.title;
  // Any addons configured in STREMIO_ADDONS join as further legs. Both sources
  // above are somebody else's uptime — Torrentio is one hosted service, apibay
  // one site — so an outage at either left this vertical on a single index.
  // Empty by default, in which case nothing here changes.
  const isImdb = rec.id.startsWith("tt");
  const [torrentio, apibay, extra] = await Promise.all([
    isImdb ? torrentioReleases("movie", rec.id).catch(() => []) : [],
    searchApibay(q).catch(() => []),
    isImdb ? extraAddonReleases("movie", rec.id).catch(() => []) : [],
  ]);
  // `runtime` is what lets the ranker apply its bitrate floor — the test that
  // actually distinguishes a 30 GB remux from a 1.6 GB re-encode both calling
  // themselves "1080p BluRay".
  const ranked = rankReleases(mergeReleases(torrentio, extra, apibay), { runtimeMin: rec.runtime ?? null });
  catalog.set(rec.id, { ...rec, candidates: ranked });
  return ranked;
}

// A "tt…" id is self-sufficient (survives restarts / deep links): recover the
// card from Cinemeta instead of demanding a fresh browse.
async function recordFor(id) {
  const rec = catalog.get(id);
  if (rec || !id.startsWith("tt")) return rec || null;
  const m = await addonMeta(CINEMETA, "movie", id).catch(() => null);
  return m ? remember(fromCinemeta(m)) : null;
}

// `server` pins one exact release (the user picked it in the Servers panel);
// `prefer` is their favourite release signatures, which only reorder the list.
// `local` says whether the viewer gets original bytes or a capped transcode —
// a transcoded play is better fed by a 1080p source than a 4K one (see
// preferTranscodeFriendly in lib/quality.mjs).
export async function stream(id, { server = null, prefer = "", local = true } = {}) {
  const rec = await recordFor(id);
  if (!rec) return { error: "unknown movie (browse/search first)" };

  // VIDLINK_PRIMARY inverts the tiers: play the free, instant stream FIRST and
  // treat the debrid release as the upgrade, rather than the other way round.
  //
  // It exists because the debrid tier's costs are real — a subscription, a
  // cache miss that turns into a swarm wait, and an outage that stops playback
  // entirely — and for a viewer who is happy with 1080p none of that buys
  // anything. An explicitly picked server always overrides this: choosing a
  // release in the Servers panel is a statement about THAT release.
  if (VIDLINK_PRIMARY && !server) {
    const first = await floorStream(rec);
    if (first) return { stream: first, title: rec.title, tier: "floor" };
  }
  // Without a debrid backend the floor tier is the only thing that can serve,
  // so this check comes AFTER it rather than short-circuiting the whole route.
  if (!debridEnabled()) {
    const only = await floorStream(rec);
    return only ? { stream: only, title: rec.title, tier: "floor" } : { error: "debrid-disabled" };
  }
  const candidates = await candidatesFor(rec);
  if (!candidates.length) return { error: "no release found", detail: "no torrent matched this title" };
  // A hand-picked server is tried ALONE: falling through to the next release
  // would silently ignore the choice the user just made.
  const picked = server ? findRelease(candidates, server) : null;
  if (server && !picked)
    return { error: "unknown server", detail: "that release is no longer listed — reopen the Servers panel" };
  // What was asked for, carried down to the file picker so a compilation pack
  // can't serve a different film (see lib/match-release.mjs).
  const want = { title: rec.title, year: rec.year };
  const pool = local ? candidates : preferTranscodeFriendly(candidates);
  const r = picked
    ? await streamFirstCached([picked], { max: 1, waitMs: 12000, want })
    : await streamFirstCached(preferSignatures(pool, prefer), { want, startDownload });
  if (r.stream) return { stream: r.stream, title: rec.title };

  // Nothing cached. Before this, that meant a spinner while Real-Debrid pulled
  // the release off the swarm — the whole "availability depends on peers"
  // problem, since peers are only on the critical path when nothing else can
  // serve. The floor tier serves. It is a ~1080p re-encode and is never
  // preferred over a release file, which is why it is only reached here.
  //
  // `downloading` is carried THROUGH: the play starts now on the floor stream
  // and the client keeps polling for the real release, exactly as the anime
  // side already works.
  const floor = await floorStream(rec);
  if (floor) return { ...r, stream: floor, title: rec.title, tier: "floor" };
  return r;
}

// One floor stream for this film, or null. Never throws: a floor failure must
// not turn a "still downloading" answer into an error.
async function floorStream(rec) {
  if (!vidlinkEnabled() || !String(rec.id || "").startsWith("tt")) return null;
  const streams = await movieStreams(rec.id).catch(() => []);
  return streams[0] || null;
}

// Every release the player may switch to, named for the Servers panel. Pure
// list work — no Real-Debrid calls, so opening the panel costs nothing.
export async function servers(id) {
  const rec = await recordFor(id);
  if (!rec) return { servers: [] };
  return { servers: describeReleases(await candidatesFor(rec)) };
}

// Cached alternatives in the OTHER quality bands (2160/1080/720) — called by
// the player after playback starts, to populate its Quality menu. The record
// is always warm here: stream() ran first and cached the ranked candidates.
// Results are memoized so replays don't re-spend Real-Debrid API quota.
const altsCache = new Map(); // `${id}:${have}` -> { at, data }
export async function altStreams(id, have) {
  if (!debridEnabled()) return { streams: [] };
  const key = `${id}:${have || ""}`;
  const hit = altsCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
  const rec = catalog.get(id);
  if (!rec) return { streams: [] };
  const data = { streams: await streamPerBand(await candidatesFor(rec), have, { want: { title: rec.title, year: rec.year } }) };
  if (altsCache.size > 60) altsCache.delete(altsCache.keys().next().value);
  altsCache.set(key, { at: Date.now(), data });
  return data;
}

export function movieMeta(id) {
  const rec = catalog.get(id);
  return rec ? { id: rec.id, title: rec.title, year: rec.year, poster: rec.poster, overview: rec.overview, rating: rec.rating } : null;
}

// Everything the detail page shows for one film. Films used to have no detail
// page at all — a card click went straight to the player, so the synopsis,
// cast, runtime and rating Cinemeta already returns were fetched and thrown
// away. This is the same shape TV's detail() returns, minus seasons, so one
// client view renders both.
//
// Cached because the page is re-entered constantly (play → back → play) and a
// deep link has to rebuild it from nothing.
const detailCache = new Map(); // id -> { at, data }
export async function detail(id) {
  const hit = detailCache.get(id);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;
  let data = null;
  if (id.startsWith("tt")) {
    const m = await addonMeta(CINEMETA, "movie", id).catch(() => null);
    if (m) { data = detailFromCinemeta(m); remember(fromCinemeta(m)); }
  }
  // apibay-only records ("m-…") have a title and a year and nothing else —
  // there is no metadata source for them. Serve what we have rather than 404:
  // the page still lists releases and plays, it just looks plainer.
  if (!data) {
    const rec = catalog.get(id);
    if (!rec) return null;
    data = { id: rec.id, title: rec.title, year: rec.year ?? null, poster: rec.poster ?? null,
      backdrop: null, overview: rec.overview || "", rating: rec.rating ?? null,
      runtime: rec.runtime ?? null, genres: [], cast: [], director: [], writer: [],
      country: null, released: null, imdbId: null };
  }
  if (detailCache.size > 80) detailCache.delete(detailCache.keys().next().value);
  detailCache.set(id, { at: Date.now(), data });
  return data;
}
