// TV Shows domain — the third content vertical, on the borrowed Stremio stack.
// TV needs a real season/episode structure, which torrent names don't give
// cleanly; Cinemeta's series meta carries the full episode list (a `videos`
// array with season/episode/thumbnail per entry), so the old TMDB_API_KEY
// requirement is gone. Streams come from Torrentio by "tt<id>:<season>:<ep>"
// (which also handles season packs via fileIdx), played through Real-Debrid,
// with the old apibay "<show> SxxEyy" search as the fallback release source.
import { CINEMETA, catalog as addonCatalog, meta as addonMeta, torrentioReleases, extraAddonReleases, preferQuality, fromCinemeta, detailFromCinemeta, filteredCatalog } from "./stremio/addons.mjs";
import { searchTvTorrents, rankReleases } from "./torrents.mjs";
import { anyDebridEnabled as debridEnabled } from "./debrid/backends.mjs";
import { streamFirstCached, streamPerBand } from "./debrid/candidates.mjs";
import { startDownload } from "./debrid/realdebrid.mjs";
import { describeReleases, findRelease, preferSignatures, mergeReleases } from "./servers.mjs";
import { preferTranscodeFriendly } from "./quality.mjs";
import { episodeStreams, vidlinkEnabled } from "./providers/vidlink.mjs";

// Play the floor tier first and treat the debrid release as the upgrade.
const VIDLINK_PRIMARY = process.env.VIDLINK_PRIMARY === "true";

// The catalog side is keyless now, so TV is always on; playback still needs RD.
export const tvEnabled = () => true;
export const tvPlayable = () => debridEnabled();

const pad = (n) => String(n).padStart(2, "0");

// Cinemeta series meta cache: one fetch serves detail(), episodes() AND the
// show-name lookup at stream time. imdbId -> { at, meta }.
const metaCache = new Map();
async function seriesMeta(id) {
  const hit = metaCache.get(id);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.meta;
  const m = await addonMeta(CINEMETA, "series", id).catch(() => null);
  if (m) metaCache.set(id, { at: Date.now(), meta: m });
  return m;
}
// Cinemeta reports runtime as "42 min"; the quality ranker needs the number so
// it can apply its bitrate floor (see lib/quality.mjs).
const runtimeOf = (m) => Number(String(m?.runtime || "").match(/\d+/)?.[0]) || null;

// Broadcast episodes only (season 0 = specials); tolerate either field name.
const realEpisodes = (m) =>
  (m?.videos || []).filter((v) => (v.season ?? 0) > 0).map((v) => ({ ...v, episode: v.episode ?? v.number }));

// One cache entry per filter combination (each is its own Cinemeta page).
const browseCache = new Map(); // filter signature -> { at, data }
export async function browse(filters = {}) {
  const key = JSON.stringify([filters.genre, filters.sort, filters.year, filters.skip]);
  const hit = browseCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;
  const data = await filteredCatalog("series", filters).catch(() => ({ items: [], hasMore: false, nextSkip: 0 }));
  // Never cache an empty page — a transient Cinemeta failure would otherwise
  // pin "no results" on this filter combination for the whole TTL.
  if (data.items.length) {
    if (browseCache.size > 60) browseCache.delete(browseCache.keys().next().value);
    browseCache.set(key, { at: Date.now(), data });
  }
  return data;
}

export async function search(query) {
  const metas = await addonCatalog(CINEMETA, "series", "top", `search=${encodeURIComponent(query)}`).catch(() => []);
  return metas.map(fromCinemeta).slice(0, 24);
}

// Full show: metadata + season list (each with its episode count). Same shape
// as movies.detail() plus `seasons`, so both render through one client view.
export async function detail(id) {
  const m = await seriesMeta(id);
  if (!m) return null;
  const counts = new Map();
  for (const v of realEpisodes(m)) counts.set(v.season, (counts.get(v.season) || 0) + 1);
  return {
    ...detailFromCinemeta(m),
    seasons: [...counts.keys()].sort((a, b) => a - b)
      .map((s) => ({ season: s, name: `Season ${s}`, episodes: counts.get(s) })),
  };
}

// Episodes of one season (numbers + titles + stills).
export async function episodes(id, season) {
  const m = await seriesMeta(id);
  return realEpisodes(m)
    .filter((v) => v.season === Number(season))
    .sort((a, b) => a.episode - b.episode)
    .map((v) => ({
      ep: v.episode,
      title: v.name || v.title || `Episode ${v.episode}`,
      still: v.thumbnail || null,
      overview: v.overview || "",
      airDate: (v.released || v.firstAired || "").slice(0, 10) || null,
    }));
}

// Ranked releases for one episode, cached briefly: stream() and altStreams()
// run seconds apart for the same episode and must not hit Torrentio twice.
// preferQuality (not rankReleases) on the Torrentio path: Torrentio's order
// encodes which release holds the right episode — a seeder re-rank can promote
// a wrong-file pack.
const releaseCache = new Map(); // `${id}:${season}:${ep}` -> { at, ranked }
async function rankedFor(id, season, ep, name, runtimeMin = null) {
  const key = `${id}:${Number(season)}:${Number(ep)}`;
  const hit = releaseCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.ranked;
  // Both indexers, merged (see movies.candidatesFor). Torrentio keeps its own
  // order — it encodes which release holds the right episode — and the apibay
  // hits, which carry no fileIdx, rank behind it.
  // STREMIO_ADDONS legs ride with Torrentio: they speak the same protocol and
  // carry fileIdx too, so they keep the addon ordering that encodes WHICH file
  // in a season pack is this episode. See candidatesFor in lib/movies.mjs.
  const [tor, bay, extra] = await Promise.all([
    torrentioReleases("series", key).catch(() => []),
    searchTvTorrents(`${name} S${pad(season)}E${pad(ep)}`).catch(() => []),
    extraAddonReleases("series", key).catch(() => []),
  ]);
  const ranked = mergeReleases(
    preferQuality(tor, { runtimeMin }),
    preferQuality(extra, { runtimeMin }),
    rankReleases(bay, { runtimeMin }),
  );
  if (releaseCache.size > 40) releaseCache.delete(releaseCache.keys().next().value);
  releaseCache.set(key, { at: Date.now(), ranked });
  return ranked;
}

// Resolve one episode to a stream: Torrentio by exact id first (indexer-wide,
// season-pack aware), apibay "<show> SxxEyy" search as fallback, then hand the
// ranked releases to Real-Debrid until one is cached.
// `server` pins one exact release the user chose in the Servers panel;
// `prefer` is their favourite release signatures, which only reorder the list.
// `local` gates the 1080p-first reorder for transcoded plays — see
// preferTranscodeFriendly in lib/quality.mjs; a 4K HDR source fed to a capped
// remote encode is why an episode can lag from its first minute to its last.
export async function stream(id, season, ep, { server = null, prefer = "", local = true } = {}) {
  const m = await seriesMeta(id);
  const name = m?.name;
  if (!name) return { error: "unknown show (browse first)" };
  const epTitle = `${name} · S${season} E${ep}`;
  // See the same block in lib/movies.mjs — the floor tier leads when asked to,
  // and a hand-picked server always wins over it.
  const floorFirst = async () => (vidlinkEnabled() && m?.moviedb_id
    ? (await episodeStreams(m.moviedb_id, season, ep).catch(() => []))[0]
    : null);
  if (VIDLINK_PRIMARY && !server) {
    const first = await floorFirst();
    if (first) return { stream: first, title: epTitle, tier: "floor" };
  }
  if (!debridEnabled()) {
    const only = await floorFirst();
    return only ? { stream: only, title: epTitle, tier: "floor" } : { error: "debrid-disabled" };
  }
  const ranked = await rankedFor(id, season, ep, name, runtimeOf(m));
  if (!ranked.length) return { error: "no release found", detail: `no torrent matched ${name} S${pad(season)}E${pad(ep)}` };
  // A hand-picked server is tried ALONE — falling through would quietly
  // override the user's choice with the ranked default again.
  const picked = server ? findRelease(ranked, server) : null;
  if (server && !picked)
    return { error: "unknown server", detail: "that release is no longer listed — reopen the Servers panel" };
  // Season packs are the episodic version of the same trap: without this the
  // biggest file in the pack plays, whichever episode that happens to be.
  const want = { title: name, season: Number(season), episode: Number(ep) };
  const pool = local ? ranked : preferTranscodeFriendly(ranked);
  const r = picked
    ? await streamFirstCached([picked], { max: 1, waitMs: 12000, want })
    : await streamFirstCached(preferSignatures(pool, prefer), { want, startDownload });
  if (r.stream) return { stream: r.stream, title: epTitle };

  // Nothing cached — play the floor tier now and let the client keep polling
  // for the release. See the same block in lib/movies.mjs for the reasoning.
  const floor = await floorFirst();
  if (floor) return { ...r, stream: floor, title: epTitle, tier: "floor" };
  return r;
}

// Every release this episode could play from, for the Servers panel. Pure list
// work off the cached Torrentio/apibay results — no Real-Debrid calls.
export async function servers(id, season, ep) {
  const m = await seriesMeta(id);
  if (!m?.name) return { servers: [] };
  return { servers: describeReleases(await rankedFor(id, season, ep, m.name, runtimeOf(m))) };
}

// Cached alternatives in the OTHER quality bands, for the player's Quality
// menu (see movies.mjs altStreams — same contract, memoized the same way).
const altsCache = new Map(); // `${id}:${season}:${ep}:${have}` -> { at, data }
export async function altStreams(id, season, ep, have) {
  if (!debridEnabled()) return { streams: [] };
  const key = `${id}:${season}:${ep}:${have || ""}`;
  const hit = altsCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
  const m = await seriesMeta(id);
  const name = m?.name;
  if (!name) return { streams: [] };
  const data = { streams: await streamPerBand(await rankedFor(id, season, ep, name, runtimeOf(m)), have,
    { want: { title: name, season: Number(season), episode: Number(ep) } }) };
  if (altsCache.size > 60) altsCache.delete(altsCache.keys().next().value);
  altsCache.set(key, { at: Date.now(), data });
  return data;
}
