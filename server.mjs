// Mediawan server: closed multi-user anime/film/TV streamer.
// One process serves the SPA, auth, the admin panel, cached AniList metadata,
// quality-first stream resolution, local transcoding and a thin media proxy.
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as db from "./lib/db.mjs";
import { config } from "./lib/config.mjs";
import { securityHeaders, makeRateLimiter, assertSafeUrl, signMediaToken, verifyMediaToken } from "./lib/security.mjs";
import { fetchRow, searchMeta, searchManyMeta, fetchByGenres, fetchRelations, fetchMalId, fetchCategory, fetchBrowse, fetchRandom, fetchAiring, fetchEpisodeMeta, fetchMeta } from "./lib/anilist.mjs";
import { titleData, resolveStreams, resolveFloorStreams, resolveQualityStreams, getProvidersHealth, probeProviders } from "./lib/providers/index.mjs";
import { anyDebridEnabled as debridEnabled } from "./lib/debrid/backends.mjs";
import * as movies from "./lib/movies.mjs";
import * as tv from "./lib/tv.mjs";
import { CATALOG_GENRES, CATALOG_SORTS } from "./lib/stremio/addons.mjs";
import { findSubtitles, findSubtitlesByImdb, srtToVtt, decodeSubtitle } from "./lib/subs.mjs";
import { toPlayable } from "./lib/playable.mjs";
import { preferTranscodeFriendly } from "./lib/quality.mjs";
import { indexFreshness } from "./lib/torrents.mjs";
import { deliver, upgradeStatus } from "./lib/delivery.mjs";
import { downloadStatus as debridProgress, startDownload as debridStartDownload } from "./lib/debrid/realdebrid.mjs";
import * as cacheStore from "./lib/cache/store.mjs";
import * as transcodeSessions from "./lib/transcode/session.mjs";
import { capabilities } from "./lib/transcode/probe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = config.port;
const SESSION_MAX_AGE = config.sessionMaxAgeDays * 24 * 60 * 60 * 1000;

app.disable("x-powered-by");
app.set("trust proxy", config.trustProxy); // Cloudflare Tunnel / reverse proxy
app.use(securityHeaders);
app.use(express.json({ limit: "64kb" })); // requests are tiny JSON; cap them
app.use((req, _res, next) => {
  req.cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => c.trim().split("=").map(decodeURIComponent)).filter((p) => p[0])
  );
  // Which socket did this arrive on? A request to the LAN listener came from
  // the local network — that is a property of the connection, not a header, so
  // nothing outside the LAN can claim it. See the listener setup at the bottom.
  //
  // Loopback counts as local on ANY port: a client on the box itself (dev on a
  // laptop, a browser on the NAS) has no uplink to protect, and without this it
  // was classified remote and handed the 6 Mbps tunnel encode of a file sitting
  // on its own disk. The tunnel path is unaffected — cloudflared runs as its
  // own container and connects from the compose network, never from loopback.
  const peer = req.socket.remoteAddress || "";
  const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  req.isLocalClient = loopback || (config.lanPort > 0 && req.socket.localPort === config.lanPort);
  next();
});

// wrap async route handlers so a rejection becomes a 500, never a crash
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function setSession(req, res, token) {
  const flags = ["HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${SESSION_MAX_AGE / 1000}`];
  // Secure follows the CONNECTION, not the environment. In production every
  // tunnel login arrives as HTTPS (X-Forwarded-Proto, trusted proxy) and keeps
  // the flag. A LAN login on the plain-http listener must not get it: the
  // browser discards a Secure cookie set over http, so login "succeeds" and
  // every request after it is a 401 — the sign-in screen never goes away.
  // That dead end is why .env.tvtest had to disable COOKIE_SECURE globally to
  // test the TV on the LAN. Cookies are scoped per-host, so the tunnel
  // domain's Secure cookie and a LAN host's non-Secure one never mix.
  if (config.cookieSecure && req.secure) flags.push("Secure");
  res.setHeader("Set-Cookie", `sid=${token}; ${flags.join("; ")}`);
}
function currentUser(req) {
  return db.getSessionUser(req.cookies.sid, SESSION_MAX_AGE);
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "auth required" });
  req.user = u;
  next();
}
function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "admin only" });
  next();
}
// Stream proxies only: a signed media token (Chromecast — no cookies) is as
// good as a session. The token is bound to the exact upstream `url` param.
function requireAuthOrMediaToken(req, res, next) {
  const u = currentUser(req);
  if (u) { req.user = u; return next(); }
  if (verifyMediaToken(req.query.url, req.query.t)) return next();
  res.status(401).json({ error: "auth required" });
}
// The Cast receiver fetches HLS via XHR from its own origin — needs CORS.
// Safe to be permissive here: these routes are token/cookie-gated anyway.
function mediaCors(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

// ---------- first-run bootstrap: seed the admin (you) ----------
function bootstrap() {
  db.pruneSessions(SESSION_MAX_AGE);
  if (db.listUsers().length > 0) return;
  const { email, password } = config.admin;
  db.createUser({ email, name: "Admin", password, role: "admin" });
  console.log(`  Seeded admin: ${email}${config.isProd ? "" : ` / ${password}`}`);
}
bootstrap();

// ---------- auth ----------
const loginLimiter = makeRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
app.post("/api/login", loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  // non-string values would throw inside toLowerCase()/scrypt — reject early
  if (typeof email !== "string" || typeof password !== "string")
    return res.status(400).json({ error: "email and password required" });
  const u = db.getUserByEmail(email);
  if (!u || !u.active || !db.verifyPassword(password, u.pw_hash))
    return res.status(401).json({ error: "invalid credentials" });
  setSession(req, res, db.createSession(u.id));
  res.json({ ok: true, user: { name: u.name, role: u.role } });
});

app.post("/api/logout", (req, res) => {
  db.destroySession(req.cookies.sid);
  res.setHeader("Set-Cookie", "sid=; HttpOnly; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "no session" });
  // serverFavs rides along on boot: the player needs them before its first
  // resolve (they reorder the release candidates) and they're a handful of rows.
  res.json({ name: u.name, email: u.email, role: u.role, serverFavs: db.serverFavs(u.id) });
});

// Invite redemption: friend sets their own password. NO open registration.
app.get("/api/invite/:token", (req, res) => {
  const inv = db.getInvite(req.params.token);
  if (!inv) return res.status(404).json({ error: "invalid or used invite" });
  res.json({ email: inv.email, name: inv.name });
});
app.post("/api/invite/:token", (req, res) => {
  const inv = db.getInvite(req.params.token);
  if (!inv) return res.status(404).json({ error: "invalid or used invite" });
  const { password } = req.body || {};
  if (typeof password !== "string" || password.length < config.minPasswordLength)
    return res.status(400).json({ error: `password must be at least ${config.minPasswordLength} characters` });
  if (db.getUserByEmail(inv.email)) return res.status(409).json({ error: "user already exists" });
  const u = db.createUser({ email: inv.email, name: inv.name, password, role: inv.role });
  db.useInvite(inv.token);
  setSession(req, res, db.createSession(u.id));
  res.json({ ok: true });
});

// ---------- admin panel ----------
app.use("/api/admin", requireAuth, requireAdmin);
app.get("/api/admin/users", (_req, res) => res.json({ users: db.listUsers(), invites: db.listInvites() }));
app.post("/api/admin/invite", (req, res) => {
  const { email, name, role } = req.body || {};
  if (typeof email !== "string" || !email || typeof name !== "string" || !name)
    return res.status(400).json({ error: "email and name required" });
  if (db.getUserByEmail(email)) return res.status(409).json({ error: "user exists" });
  const token = db.createInvite({ email, name, role: role === "admin" ? "admin" : "member" });
  res.json({ token, url: `/invite.html?token=${token}` });
});
app.post("/api/admin/user/:id/active", (req, res) => {
  const { active } = req.body || {};
  // strict: a missing/garbled body must not silently coerce into "disable"
  if (typeof active !== "boolean" && active !== 0 && active !== 1)
    return res.status(400).json({ error: "active must be a boolean" });
  const id = Number(req.params.id);
  db.setUserActive(id, active);
  if (!active) db.destroyUserSessions(id); // kick them now
  res.json({ ok: true });
});
app.delete("/api/admin/user/:id", (req, res) => {
  const id = Number(req.params.id);
  const target = db.getUserById(id);
  if (target?.role === "admin" && db.countAdmins() <= 1)
    return res.status(400).json({ error: "cannot delete the last admin" });
  db.destroyUserSessions(id);
  db.deleteUser(id);
  res.json({ ok: true });
});
// Streaming health for the admin panel. There is no crypto watchdog any more —
// the scrapers it existed to heal are gone — so this is now purely per-provider
// health. POST exercises every provider against a known-good title so the panel
// reflects real state rather than whatever traffic happens to have occurred.
// `indexes` is the freshness ledger: the newest release timestamp each torrent
// index has returned this process. A stale index doesn't error — it answers,
// with old results — which is how AnimeTosho could die on 2026-05-08 and go
// unnoticed until 2026-07-31. `stale: true` is the alarm that prevents a repeat.
app.get("/api/admin/sources", (_req, res) => res.json({ providers: getProvidersHealth(), indexes: indexFreshness() }));
// What the TVs have reported about themselves — see the tv-log route above.
app.get("/api/admin/tv-log", (_req, res) => res.json({ entries: [...TV_LOG].reverse() }));
app.post("/api/admin/sources", ah(async (_req, res) => {
  await probeProviders().catch(() => {});
  res.json({ providers: getProvidersHealth(), indexes: indexFreshness() });
}));

// ---------- browse (metadata; cached, refreshed in background) ----------
const ROWS = [
  { key: "trending", label: "Trending Now", sort: "TRENDING_DESC" },
  { key: "popular", label: "All-Time Popular", sort: "POPULARITY_DESC" },
  { key: "top", label: "Top Rated", sort: "SCORE_DESC" },
];
let rowCache = { at: 0, data: null };

async function getRows() {
  // Serve from memory; refresh at most every 30 min so the page never blocks.
  if (rowCache.data && Date.now() - rowCache.at < 30 * 60 * 1000) return rowCache.data;
  const data = {};
  // "Now Airing" — this season's currently-releasing shows, next-episode badges.
  try {
    const items = await fetchAiring();
    db.cacheMeta(items);
    data.airing = { label: "Now Airing", items };
  } catch (e) {
    data.airing = { label: "Now Airing", items: [], error: String(e.message) };
  }
  for (const r of ROWS) {
    try {
      const items = await fetchRow(r.sort);
      db.cacheMeta(items);
      data[r.key] = { label: r.label, items };
    } catch (e) {
      data[r.key] = { label: r.label, items: [], error: String(e.message) };
    }
  }
  rowCache = { at: Date.now(), data };
  return data;
}

// Genre-based recommendations. Cached per genre-set so repeat browses are free.
const genreCache = new Map();
async function fetchByGenresCached(genres) {
  const key = genres.slice().sort().join(",");
  const hit = genreCache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.items;
  const items = await fetchByGenres(genres);
  genreCache.set(key, { at: Date.now(), items });
  return items;
}

// "Because you watched X": take the user's most-recent watched titles, tally
// their genres, and pull popular same-genre shows they haven't seen.
async function getRecommendations(userId) {
  const watched = db.getWatchedTitles(userId);
  if (!watched.length) return null;
  const watchedIds = new Set(watched.map((w) => w.anilist_id));
  const genreCount = {};
  let seed = null;
  for (const w of watched) {
    const m = db.getCachedMeta(w.anilist_id);
    if (!m || !m.genres?.length) continue;
    if (!seed) seed = m; // most recent watched with usable genres
    for (const g of m.genres) genreCount[g] = (genreCount[g] || 0) + 1;
  }
  const topGenres = Object.entries(genreCount).sort((a, b) => b[1] - a[1]).slice(0, 2).map((e) => e[0]);
  if (!topGenres.length) return null;
  try {
    const pool = await fetchByGenresCached(topGenres);
    db.cacheMeta(pool);
    const items = pool.filter((m) => !watchedIds.has(m.anilistId)).slice(0, 18);
    if (!items.length) return null;
    return { label: `Because you watched ${seed.title}`, items };
  } catch {
    return null;
  }
}

// Continue Watching, shaped for the client and with its art repaired.
//
// The stored row is deliberately thin — the player writes whatever it knew at
// the time, and on a deep link ("/moviewatch/tt0816692" pasted, or the very
// first ping of a film resumed from this row) that is a title and nothing else.
// Rather than let a coverless grey card sit on the front page, the missing art
// is fetched ONCE from the vertical's own detail cache and written back, so the
// repair costs a network call the first time and nothing afterwards.
//
// Both detail() calls are already memoized for 30 minutes and are the same ones
// the detail sheet uses, so a title the user has actually been watching is
// almost always warm. Failures are swallowed: a missing poster is a cosmetic
// problem and must never fail the home page.
async function continueWatchingFor(userId) {
  const rows = db.getContinueWatching(userId);
  const gaps = rows.filter((r) => (!r.cover || !r.title) && (r.kind === "movie" || r.kind === "tv"));
  if (gaps.length) {
    await Promise.all(gaps.map(async (r) => {
      const d = await (r.kind === "movie" ? movies.detail(r.media_id) : tv.detail(r.media_id)).catch(() => null);
      if (!d?.poster && !d?.title) return;
      if (!r.cover && d.poster) r.cover = d.poster;
      if (!r.title && d.title) r.title = d.title;
      db.saveProgress({
        userId, kind: r.kind, mediaId: r.media_id, title: r.title, cover: r.cover,
        season: r.season, episode: r.episode, seconds: r.seconds, duration: r.duration,
      });
    })).catch(() => {});
  }
  return rows.map((r) => ({
    kind: r.kind,
    id: r.media_id,
    // Anime cards are addressed by number everywhere else in the client
    // (openTitle(123), the favourite/list Sets), so hand back the numeric form
    // rather than making every call site remember to coerce the string.
    anilistId: r.kind === "anime" ? Number(r.media_id) : null,
    title: r.title,
    cover: r.cover,
    season: r.season,
    episode: r.episode,
    seconds: r.seconds,
    duration: r.duration,
  }));
}

app.get("/api/browse", requireAuth, ah(async (req, res) => {
  const uid = req.user.id;
  const rows = await getRows();
  const continueWatching = await continueWatchingFor(uid);

  // personal rows
  const favorites = db.metasForIds(db.favoriteIds(uid));
  const watchlist = db.metasForIds(db.watchlistIds(uid));
  const collections = db.listCollections(uid).map((c) => ({
    id: c.id, name: c.name, items: db.metasForIds(db.collectionItemIds(c.id)),
  }));
  const recommendations = await getRecommendations(uid);

  // flags so cards can render active heart / in-list state
  const flags = { favorites: db.favoriteIds(uid), watchlist: db.watchlistIds(uid) };

  res.json({ rows, continueWatching, favorites, watchlist, collections, recommendations, flags });
}));

// Client-side failures from a TV, which has no console, no dlog and no Web
// Inspector to read them from. Authenticated and rate-limited so it can't be
// used as an open log-injection endpoint; the payload is truncated hard and
// newlines are stripped so a report can't forge extra log lines.
const tvLogLimiter = makeRateLimiter({ windowMs: 60 * 1000, max: 30 });
// The TV's beacons also go into a small ring buffer, readable at
// /api/admin/tv-log. stdout is the right place for these when you have a shell
// on the box, and the wrong place when you don't: a retail Samsung has no
// console, and the person holding the remote is usually not the person who can
// run `docker compose logs`. A black screen is the one failure where the report
// is the ONLY evidence there is, so it must be reachable from a browser.
const TV_LOG = []; // newest last, capped
app.post("/api/tv-log", requireAuth, tvLogLimiter, (req, res) => {
  const clean = (v, n) => String(v ?? "").replace(/[\r\n]+/g, " ").slice(0, n);
  const kind = clean(req.body?.kind, 20);
  const message = clean(req.body?.message, 400);
  const where = clean(req.body?.at || req.body?.tag, 80);
  // "caps" and "playing" are health signals, not faults — labelling them as
  // errors makes a working TV look broken in the log.
  const tag = ["caps", "playing"].includes(kind) ? "tv" : "tv-error";
  console.warn(`  [${tag}] ${kind}: ${message}${where ? `  (${where})` : ""}`);
  TV_LOG.push({ at: new Date().toISOString(), kind, message, where, user: req.user.email,
    ua: clean(req.headers["user-agent"], 160) });
  if (TV_LOG.length > 100) TV_LOG.shift();
  res.json({ ok: true });
});

// ---------- favorites / My List / collections ----------
app.post("/api/favorite/:anilistId", requireAuth, (req, res) => {
  const on = db.toggleFavorite(req.user.id, Number(req.params.anilistId));
  res.json({ favorite: on });
});
app.post("/api/watchlist/:anilistId", requireAuth, (req, res) => {
  const on = db.toggleWatchlist(req.user.id, Number(req.params.anilistId));
  res.json({ inList: on });
});
// Heart a playback source in the player's Servers panel. The key is a provider
// label or a release signature (see the server_favs table), never one torrent.
app.post("/api/server-favorite", requireAuth, (req, res) => {
  const key = (req.body?.key || "").toString().trim().slice(0, 60);
  if (!key) return res.status(400).json({ error: "key required" });
  res.json({ favorite: db.toggleServerFav(req.user.id, key) });
});
app.get("/api/collections", requireAuth, (req, res) => {
  const collections = db.listCollections(req.user.id).map((c) => ({
    id: c.id, name: c.name, items: db.metasForIds(db.collectionItemIds(c.id)),
  }));
  res.json({ collections });
});
app.post("/api/collections", requireAuth, (req, res) => {
  const name = (req.body?.name || "").toString().trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "name required" });
  res.json(db.createCollection(req.user.id, name));
});
app.delete("/api/collections/:id", requireAuth, (req, res) => {
  const ok = db.deleteCollection(req.user.id, Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});
app.post("/api/collections/:id/item/:anilistId", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!db.ownsCollection(req.user.id, id)) return res.status(404).json({ error: "not found" });
  db.addToCollection(id, Number(req.params.anilistId));
  res.json({ ok: true });
});
app.delete("/api/collections/:id/item/:anilistId", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!db.ownsCollection(req.user.id, id)) return res.status(404).json({ error: "not found" });
  db.removeFromCollection(id, Number(req.params.anilistId));
  res.json({ ok: true });
});

// Search runs against AniList, which is the catalogue — see searchManyMeta in
// lib/anilist.mjs for why the index must not be a source. We cache the metadata
// so the subsequent play flow is instant.
app.get("/api/search", requireAuth, ah(async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (q.length < 2) return res.json({ items: [] });
  // Straight to AniList: it is the catalogue now. No placeholder cards are
  // needed either — every hit has real artwork by construction, where the old
  // scraper-first path had to invent covers for titles AniList didn't return.
  const items = await searchManyMeta(q, 12).catch(() => []);
  if (items.length) db.cacheMeta(items);
  res.json({ items });
}));

// ---------- category browsing (by genre) ----------
// AniList's standard anime genres (Hentai excluded — the app is isAdult:false).
const GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror",
  "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological", "Romance",
  "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller",
];
app.get("/api/genres", requireAuth, (_req, res) => res.json({ genres: GENRES }));

const categoryCache = new Map(); // genre -> { at, items }
app.get("/api/category/:genre", requireAuth, ah(async (req, res) => {
  const genre = req.params.genre;
  if (!GENRES.includes(genre)) return res.status(404).json({ error: "unknown category" });
  const hit = categoryCache.get(genre);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return res.json({ genre, items: hit.items });
  const items = await fetchCategory(genre, { perPage: 30 });
  db.cacheMeta(items);
  categoryCache.set(genre, { at: Date.now(), items });
  res.json({ genre, items });
}));

// ---------- weekly airing schedule (grouped by day on the client) ----------
let scheduleCache = { at: 0, items: null };
app.get("/api/schedule", requireAuth, ah(async (_req, res) => {
  if (scheduleCache.items && Date.now() - scheduleCache.at < 30 * 60 * 1000)
    return res.json({ items: scheduleCache.items });
  const all = await fetchAiring(50);
  const items = all.filter((m) => m.airing?.at); // only those with a known next-air time
  db.cacheMeta(items);
  scheduleCache = { at: Date.now(), items };
  res.json({ items });
}));

// ---------- random pick ("surprise me") ----------
app.get("/api/random", requireAuth, ah(async (_req, res) => {
  const meta = await fetchRandom();
  if (!meta) return res.status(502).json({ error: "no pick" });
  db.cacheMeta([meta]);
  res.json({ item: meta });
}));

// ---------- play flow: metadata id -> provider match -> episodes -> stream ----------
// The episode grid comes from AniList metadata, not from a provider, so it
// stays populated even when every source is down — a broken source is a
// playback problem, not a blank screen. Stream resolution fans out across the
// tiers in lib/providers/: debrid-backed releases lead on quality, the embed
// floor guarantees something plays. Release ranking is lib/quality.mjs.

// ---------- franchise: seasons / movies / specials via AniList relations ----------
// AniList stores each season as its own entry, chained by PREQUEL/SEQUEL edges;
// movies, OVAs, and side stories hang off that chain. We walk the graph
// (bounded, cached) so the detail modal can show the whole series organized.
const relCache = new Map(); // anilistId -> { at, self, edges }
const franchiseCache = new Map(); // anilistId -> { at, data }
// Legacy placeholder ids: search used to invent these for scraper-only titles
// AniList didn't know. Nothing mints them any more — search is AniList-native —
// but rows carrying them may still sit in the cache, and AniList-only lookups
// (franchise, MAL id, subtitles) must keep skipping them.
const FAUX_ID_FLOOR = 900000000;

async function relationsFor(id) {
  const hit = relCache.get(id);
  if (hit && Date.now() - hit.at < 24 * 60 * 60 * 1000) return hit;
  const rel = await fetchRelations(id);
  const entry = { at: Date.now(), self: rel?.self || null, edges: rel?.edges || [] };
  relCache.set(id, entry);
  return entry;
}

const CHAIN_RELS = new Set(["PREQUEL", "SEQUEL", "PARENT"]); // edges we traverse through
const SEASON_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);
const SPECIAL_FORMATS = new Set(["SPECIAL", "OVA", "MUSIC"]);

async function buildFranchise(rootId) {
  const cached = franchiseCache.get(rootId);
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.data;

  const nodes = new Map(); // anilistId -> meta
  const chain = new Set([rootId]); // ids connected by season-chain edges
  const visited = new Set();
  let frontier = [rootId];
  let budget = 10; // cap AniList calls per cold build; caches make repeats free

  while (frontier.length && budget > 0) {
    const layer = frontier.filter((id) => !visited.has(id)).slice(0, budget);
    if (!layer.length) break;
    layer.forEach((id) => visited.add(id));
    budget -= layer.length;
    const results = await Promise.all(layer.map((id) => relationsFor(id).catch(() => null)));
    frontier = [];
    for (const r of results) {
      if (!r?.self) continue;
      nodes.set(r.self.anilistId, r.self);
      for (const { relation, node } of r.edges) {
        if (!nodes.has(node.anilistId)) nodes.set(node.anilistId, node);
        // Walk only along the season chain; side content is kept, not expanded.
        if (CHAIN_RELS.has(relation) && SEASON_FORMATS.has(node.format)) {
          chain.add(node.anilistId);
          if (!visited.has(node.anilistId)) frontier.push(node.anilistId);
        }
      }
    }
  }

  const all = [...nodes.values()].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
  const data = nodes.size > 1 ? {
    seasons: all.filter((m) => chain.has(m.anilistId) && SEASON_FORMATS.has(m.format)),
    movies: all.filter((m) => m.format === "MOVIE"),
    specials: all.filter((m) => SPECIAL_FORMATS.has(m.format)),
    related: all.filter((m) =>
      !chain.has(m.anilistId) && !SPECIAL_FORMATS.has(m.format) && m.format !== "MOVIE"),
  } : null;

  // Cache metas so clicking any related title in the modal can open it,
  // and share the built franchise across every member id.
  db.cacheMeta(all);
  for (const id of [rootId, ...nodes.keys()]) franchiseCache.set(id, { at: Date.now(), data });
  return data;
}

// Cached metadata, refreshed when it is too old to be trusted for THIS title.
//
// The episode grid is computed from `airing.episode` (episodeGrid in
// lib/providers/index.mjs), so for a currently-airing show a stale copy hides
// every episode released since it was cached — measured on the live database:
// 14 of 74 airing titles had a "next episode" date already in the past, some
// cached 10+ days earlier, and their grids were short by that many weeks.
//
// The browse rows refresh what they list every 30 minutes, but a title reached
// any other way (search, a franchise link, My List, Continue Watching) was
// cached once and never revisited.
//
// TTLs by what the title IS, not one global number: an airing show changes
// weekly and is cheap to re-ask, a finished one effectively never changes.
const AIRING_TTL_MS = 20 * 60 * 1000;
const FINISHED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function freshMeta(id) {
  const hit = db.getCachedMetaAge(id);
  if (!hit) return null;                       // unknown title — caller 404s
  if (id >= FAUX_ID_FLOOR) return hit.meta;    // legacy placeholder ids aren't on AniList
  const airing = !!hit.meta?.airing;
  // A show whose next episode was due in the PAST is stale by definition,
  // whatever the clock says: that episode exists and the grid is hiding it.
  const overdue = airing && hit.meta.airing.at && hit.meta.airing.at * 1000 < Date.now();
  const ttl = airing ? AIRING_TTL_MS : FINISHED_TTL_MS;
  if (!overdue && hit.ageMs < ttl) return hit.meta;
  // Refresh, but never fail the page over it — a network blip must not turn a
  // watchable title into a 404. The stale copy is worse than fresh, not useless.
  const fresh = await fetchMeta(id).catch(() => null);
  if (!fresh) return hit.meta;
  db.cacheMeta([fresh]);
  return fresh;
}

function titleUserState(userId, anilistId) {
  return {
    favorite: db.favoriteIds(userId).includes(anilistId),
    inList: db.watchlistIds(userId).includes(anilistId),
    collections: db.listCollections(userId).map((c) => ({
      id: c.id, name: c.name, has: db.collectionsContaining(userId, anilistId).includes(c.id),
    })),
  };
}

app.get("/api/title/:anilistId", requireAuth, ah(async (req, res) => {
  const id = Number(req.params.anilistId);
  // Refreshed when stale — an airing show's episode list depends on it.
  const meta = await freshMeta(id);
  if (!meta) return res.status(404).json({ error: "unknown title (browse first)" });
  const state = titleUserState(req.user.id, id);
  const [data, franchise] = await Promise.all([
    titleData(meta),
    id < FAUX_ID_FLOOR ? buildFranchise(id).catch(() => null) : null,
  ]);
  // Only an instance that genuinely cannot play anything (no debrid token)
  // reports unplayable. Transient matching failures still return the grid —
  // titleData synthesizes the deterministic debrid match, and playback finds
  // out for itself whether the upstream has recovered.
  if (!data.primaryShow) return res.json({ meta, episodes: [], dubEpisodes: [], playable: null, franchise, ...state });
  const progress = db.getProgressFor(req.user.id, "anime", id);
  res.json({
    meta,
    // The client's "this title can play" gate — the primary matched show.
    // `providers` names every source that matched.
    playable: data.primaryShow,
    providers: data.matched.map((m) => m.name),
    episodes: data.sub,
    dubEpisodes: data.dub,
    hasDub: data.dub.length > 0,
    progress,
    franchise,
    ...state,
  });
}));

app.get("/api/stream/:anilistId/:ep", requireAuth, ah(async (req, res) => {
  const meta = db.getCachedMeta(Number(req.params.anilistId));
  if (!meta) return res.status(404).json({ error: "unknown title" });
  let mode = req.query.mode === "dub" ? "dub" : "sub";
  // Resume support: start the transcode session AT the resume point instead of
  // at zero. Without this, "continue watching" at 32:00 waited for 32 minutes
  // of video to be encoded before the seek could land.
  const seekSec = Math.max(0, Math.floor(Number(req.query.seek) || 0));
  try {
    // Fan out across every provider. Quality-tier sources (debrid-backed) lead;
    // the floor tier is appended so something always plays. Streams come back
    // ranked best-first across ALL providers, not grouped by provider.
    let streams = await resolveStreams(meta, req.params.ep, mode);

    // JAPANESE IS THE FLOOR — it must never be unreachable.
    //
    // Dub is the narrow request: it needs a dual-audio release or a source that
    // publishes a separate dubbed track, and for a simulcast episode neither
    // exists for weeks. The original audio is always the thing that shipped
    // first. Failing the play in that situation was wrong twice over: the
    // episode WAS available, and the viewer was handed a "Switch to Sub" button
    // to press to get what we could simply have played.
    //
    // Only this direction is automatic. Falling back the other way would
    // silently serve Japanese audio to someone who asked for English — the
    // failure the dub mode exists to prevent — so a sub request that finds
    // nothing stays a failure.
    let audioFallback = null;
    if (!streams.length && mode === "dub") {
      const jp = await resolveStreams(meta, req.params.ep, "sub");
      if (jp.length) {
        streams = jp;
        mode = "sub"; // everything downstream — delivery, track selection, the response — follows
        audioFallback = "dub-unavailable";
      } else if (jp.fetchCandidate && !streams.fetchCandidate) {
        // Neither mode served, but the (wider) sub field knows what to fetch.
        streams.fetchCandidate = jp.fetchCandidate;
      }
    }
    if (!streams.length) {
      // Nothing cached anywhere — but a provider named the release to FETCH.
      // Same contract as movies/TV: start the Real-Debrid download and answer
      // 202 with a torrent to poll (/api/debrid/progress/:torrentId), so a
      // brand-new episode becomes a progress bar instead of a dead end.
      const fc = streams.fetchCandidate;
      if (fc?.magnet) {
        try {
          const d = await debridStartDownload(fc.magnet, { fileIdx: fc.fileIdx ?? null, want: fc.want || null });
          return res.status(202).json({
            streams: [],
            downloading: { ...d, release: fc.name || null, quality: fc.quality || null },
            mode, audioFallback,
          });
        } catch {} // fetch refused too — fall through to the honest error
      }
      return res.status(502).json({ error: "no playable sources" });
    }
    // A remote play is transcode-bound, and a transcode is better fed by a
    // 1080p source than a 4K one (see preferTranscodeFriendly). Floor streams
    // aren't release files and keep their place at the back.
    if (!req.isLocalClient) {
      const files = streams.filter((s) => s.type === "file");
      const rest = streams.filter((s) => s.type !== "file");
      streams = [...preferTranscodeFriendly(files), ...rest];
    }

    // A `file` stream is the original release — not directly playable. Deliver
    // ONLY THE BEST ONE through the local pipeline (cache → remux/encode).
    //
    // Delivering every file stream is what "resolve them all and let the player
    // choose" degrades into here, and it's ruinous: each one starts its own
    // multi-GB download and its own ffmpeg. Frieren resolves two quality
    // candidates, so a single play opened two encoders and hit the
    // maxSessions cap on the spot — after which nothing else could play at all.
    // The runner-up releases stay reachable through the Servers panel, which
    // delivers on demand.
    //
    // If the best release isn't ready yet, that is NOT an error: the floor
    // stream plays now and `upgrade` tells the client what to poll for.
    let upgrade = null;
    const delivered = [];
    let deliveredOne = false;
    for (const s of streams) {
      if (s.type !== "file") { delivered.push(s); continue; }
      if (deliveredOne) continue; // runner-up releases: listed on demand, not acquired now
      deliveredOne = true;
      const out = await deliver(s, { local: req.isLocalClient, title: meta.title, mode, seekSec })
        .catch((e) => ({ kind: "unavailable", error: e.message }));
      if (out.kind === "hls" || out.kind === "file") {
        delivered.push({
          ...s,
          url: out.playUrl,
          type: out.kind === "hls" ? "hls" : "mp4",
          localFile: true,
          delivery: out.plan?.mode,
          deliveryReason: out.plan?.reason,
          mbps: out.probe?.mbps ?? s.mbps ?? null,
          // The player's virtual timeline: the true runtime (an HLS session's
          // playlist only advertises what has been transcoded so far), and
          // where in that runtime this session starts.
          durationSec: out.probe?.durationSec || null,
          seekBase: out.kind === "hls" ? seekSec : 0,
          // Text subtitle tracks the session extracts as sub-<index>.vtt —
          // the release's own subs, listed in the CC menu beside the external
          // ones. Only sessions have them (extraction rides the transcode).
          embeddedSubs: out.kind === "hls" ? embeddedSubsOf(out.probe) : [],
          // Which language actually came out, and what else the file holds.
          // `languageOk:false` on a dub request means this release has no
          // English track — the client says so rather than playing Japanese
          // audio and leaving the viewer to wonder why.
          audioMode: out.plan?.audioMode,
          languageOk: out.plan?.languageOk !== false,
          audioTracks: out.plan?.audioTracks || [],
          audioIndex: out.plan?.audioIndex ?? null,
        });
      } else if (out.kind === "pending") {
        upgrade = { key: out.key, progress: out.progress, source: s.source, release: s.release || null };
      } else {
        // Local delivery unavailable (transcoder genuinely saturated). The
        // debrid link itself is still a valid stream, so hand that over rather
        // than failing the play — the browser plays it directly if it can, and
        // at worst the viewer tries another source from the Servers panel.
        // Returning 502 here while holding a working URL was how a busy
        // transcoder turned into "nothing works".
        delivered.push({ ...s, type: "mp4", deliveryReason: out.error || "local delivery unavailable" });
      }
    }
    if (!delivered.length && !upgrade) return res.status(502).json({ error: "no playable sources" });

    // Embed CDNs gate on Referer, which a browser can't set — those route
    // through /proxy. Locally-delivered streams are same-origin already.
    const playable = delivered.map((s) =>
      s.localFile ? { ...s, playUrl: s.url } : toPlayable(s, { local: req.isLocalClient }))
      // Floor-tier sources ship their subtitles as separate files rather than
      // burning them into the picture, so a sub-mode play shows NOTHING without
      // them. Same proxy as any other external track: same-origin for <track>,
      // and SRT→VTT on the way through.
      .map((s) => (s.providerSubs?.length ? { ...s, providerSubs: proxiedTracks(s.providerSubs) } : s));
    // Drop only exact-duplicate URLs — keep every distinct source so the
    // player's "source failed, trying next" fallback can cross providers.
    const seen = new Set();
    const qualities = playable.filter((s) => !seen.has(s.url) && seen.add(s.url));
    if (!qualities.length) return res.status(202).json({ streams: [], upgrade, mode, audioFallback });
    // `mode` is what we actually SERVED, which is not always what was asked —
    // the client re-syncs its toggle from it, and `audioFallback` is what lets
    // it say why rather than appearing to ignore the request.
    res.json({ streams: qualities, best: qualities[0], source: qualities[0].source, upgrade, mode, audioFallback });
  } catch (e) {
    res.status(502).json({ error: String(e.message) });
  }
}));

// Extra sources, on demand. A normal play returns the quality tier plus the
// floor tier; this asks the FLOOR providers for everything else they can serve,
// which is what the Servers panel wants when the ranked pick isn't working out
// (wrong audio track, a mirror that stalls). Memoised because embed resolution
// costs real round trips per host.
const moreCache = new Map(); // `${anilistId}:${ep}:${mode}` -> { at, streams }
app.get("/api/stream/:anilistId/:ep/more", requireAuth, ah(async (req, res) => {
  const meta = db.getCachedMeta(Number(req.params.anilistId));
  if (!meta) return res.status(404).json({ error: "unknown title" });
  const mode = req.query.mode === "dub" ? "dub" : "sub";
  const key = `${req.params.anilistId}:${req.params.ep}:${mode}`;
  const hit = moreCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return res.json({ streams: hit.streams });
  const found = await resolveFloorStreams(meta, req.params.ep, mode).catch(() => []);
  const streams = found.map((s) => {
    const p = toPlayable(s, { local: req.isLocalClient });
    return p.providerSubs?.length ? { ...p, providerSubs: proxiedTracks(p.providerSubs) } : p;
  });
  if (moreCache.size > 60) moreCache.delete(moreCache.keys().next().value);
  moreCache.set(key, { at: Date.now(), streams });
  res.json({ streams });
}));

// ---------- movies (Real-Debrid vertical) ----------
// toPlayable (lib/playable.mjs) hands RD streams to the client DIRECT with a
// proxied fallbackUrl; everything else stays proxied for the Referer.
// One filter model for Movies AND TV Shows: genre + sort + year + skip cursor,
// every value validated against what Cinemeta actually offers. The response
// carries the option lists so the client renders its filter bar from data.
const FILTER_YEARS = (() => {
  const now = new Date().getFullYear();
  return Array.from({ length: now - 1970 + 1 }, (_, i) => now - i);
})();
function catalogFilters(q, type) {
  const sort = CATALOG_SORTS.some((s) => s.id === q.sort) ? q.sort : "popular";
  return {
    genre: CATALOG_GENRES[type].includes(q.genre) ? q.genre : null,
    sort,
    year: FILTER_YEARS.includes(Number(q.year)) ? Number(q.year) : null,
    skip: Math.min(Math.max(parseInt(q.skip, 10) || 0, 0), 5000),
  };
}
const filterOptions = (type) =>
  ({ genres: CATALOG_GENRES[type], sorts: CATALOG_SORTS, years: FILTER_YEARS });

// ---------- anime as a CATALOG ----------
// The unified Browse page treats anime, films and shows identically: same
// filter vocabulary in, same envelope out. Anime's genre list is AniList's
// (GENRES above) rather than Cinemeta's, which is why the response carries its
// own option lists — the client renders the bar from whatever the active type
// returned, so the two vocabularies never have to be reconciled.
app.get("/api/anime", requireAuth, ah(async (req, res) => {
  const sort = CATALOG_SORTS.some((s) => s.id === req.query.sort) ? req.query.sort : "popular";
  const genre = GENRES.includes(req.query.genre) ? req.query.genre : null;
  const year = FILTER_YEARS.includes(Number(req.query.year)) ? Number(req.query.year) : null;
  const skip = Math.min(Math.max(parseInt(req.query.skip, 10) || 0, 0), 5000);
  const r = await fetchBrowse({ genre, sort, year, skip });
  db.cacheMeta(r.items);
  res.json({ enabled: true, ...r, filters: { genres: GENRES, sorts: CATALOG_SORTS, years: FILTER_YEARS } });
}));

app.get("/api/movies", requireAuth, ah(async (req, res) => {
  // enabled:false lets the client hide the Movies tab when no RD token is set.
  if (!debridEnabled()) return res.json({ enabled: false, items: [] });
  const r = await movies.browse(catalogFilters(req.query, "movie"));
  res.json({ enabled: true, ...r, filters: filterOptions("movie") });
}));
app.get("/api/movies/search", requireAuth, ah(async (req, res) => {
  if (!debridEnabled()) return res.json({ items: [] });
  const q = (req.query.q || "").toString().trim();
  if (q.length < 2) return res.json({ items: [] });
  res.json({ items: await movies.search(q) });
}));
// One film's detail page: synopsis, cast, runtime, rating, genres. Films used
// to open straight into the player, so all of this was fetched for the catalog
// card and then discarded.
app.get("/api/movie/:id", requireAuth, ah(async (req, res) => {
  const d = await movies.detail(req.params.id);
  if (!d) return res.status(404).json({ error: "unknown movie (browse or search first)" });
  res.json({ ...d, playable: debridEnabled() });
}));

// `server` pins one release from the Servers panel; `prefer` carries the user's
// favourite release signatures, which only reorder the ranked candidates.
const streamOpts = (q) => ({
  server: typeof q.server === "string" ? q.server.slice(0, 64) : null,
  prefer: typeof q.prefer === "string" ? q.prefer.slice(0, 200) : "",
});
// A play may pin one AUDIO TRACK — the language selector for films and TV,
// where "which track" is a real choice the file's own streams describe (anime
// expresses the same thing as sub/dub). Absent → the planner picks on merit.
const audioParam = (q) => {
  const n = Number(q.audio);
  return Number.isInteger(n) && n >= 0 ? n : null;
};
// One release file → one playable stream for THIS client.
//
// Movies and TV take the same path anime does: the debrid layer now hands back
// the original release file (type "file") rather than something RD already
// re-encoded, so it has to go through the local pipeline before a player can
// use it. Anything that isn't a release file (the degraded RD-HLS path, embed
// links) still goes out through the proxy exactly as before.
async function deliverOrProxy(stream, req, title = null, seekSec = 0, audioIndex = null) {
  if (stream?.type !== "file") return { stream: toPlayable(stream, { local: req.isLocalClient }) };
  const out = await deliver(stream, { local: req.isLocalClient, title, seekSec, audioIndex })
    .catch((e) => ({ kind: "unavailable", error: e.message }));
  if (out.kind === "pending") return { pending: true, upgrade: { key: out.key, progress: out.progress } };
  if (out.kind === "unavailable") {
    // Local delivery failed (transcoder busy, cache full). The raw debrid URL
    // still plays for anything the client can decode, so fall back to it rather
    // than failing the request outright.
    return { stream: toPlayable({ ...stream, type: "mp4" }, { local: req.isLocalClient }) };
  }
  return {
    stream: {
      ...stream,
      url: out.playUrl,
      playUrl: out.playUrl,
      type: out.kind === "hls" ? "hls" : "mp4",
      localFile: true,
      delivery: out.plan?.mode,
      deliveryReason: out.plan?.reason,
      mbps: out.probe?.mbps ?? null,
      // For the player's virtual timeline over a growing HLS session — the
      // true runtime, and where in it this session starts.
      durationSec: out.probe?.durationSec || null,
      seekBase: out.kind === "hls" ? seekSec : 0,
      // The file's own audio streams, and which one is playing. This is what
      // the player's language menu lists for films and TV — the anime route
      // has always returned it; these two never did, so the menu had nothing
      // to show and stayed hidden.
      audioTracks: out.plan?.audioTracks || [],
      audioIndex: out.plan?.audioIndex ?? null,
      embeddedSubs: out.kind === "hls" ? embeddedSubsOf(out.probe) : [], // see the anime route
    },
  };
}

// The probe's text subtitle streams, shaped for the client's CC menu.
function embeddedSubsOf(probe) {
  return transcodeSessions.textSubs(probe).map((s) => ({
    index: s.index, language: s.language || null, title: s.title || null,
  }));
}

app.get("/api/movie/:id/stream", requireAuth, ah(async (req, res) => {
  const r = await movies.stream(req.params.id, { ...streamOpts(req.query), local: req.isLocalClient });
  // Nothing was cached, so Real-Debrid is fetching the best release. Not an
  // error — a wait. 202 + a handle the client polls, which beats the dead end
  // this used to be now that RD is the only backend.
  if (r.downloading) {
    return res.status(202).json({ streams: [], downloading: r.downloading, title: r.title ?? null });
  }
  if (r.error) {
    const code = r.error === "debrid-disabled" ? 503 : 502;
    return res.status(code).json({ error: r.error, detail: r.detail });
  }
  const play = await deliverOrProxy(r.stream, req, r.title,
    Math.max(0, Math.floor(Number(req.query.seek) || 0)), audioParam(req.query));
  if (play.pending) return res.status(202).json({ streams: [], upgrade: play.upgrade, title: r.title });
  res.json({ streams: [play.stream], best: play.stream, source: r.stream.source, title: r.title });
}));
// Every release the player could switch to — no Real-Debrid calls, so opening
// the Servers panel is free and instant.
app.get("/api/movie/:id/servers", requireAuth, ah(async (req, res) => {
  res.json(await movies.servers(req.params.id));
}));
// Lazy second pass for the player's Quality menu: cached releases in the
// quality bands the initial stream didn't use (?have=<quality playing now>).
app.get("/api/movie/:id/alts", requireAuth, ah(async (req, res) => {
  const r = await movies.altStreams(req.params.id, req.query.have);
  res.json({ streams: (r.streams || []).map(toPlayable) });
}));

// ---------- TV Shows (Real-Debrid + TMDB seasons/episodes) ----------
app.get("/api/tv", requireAuth, ah(async (req, res) => {
  // enabled:false → the client shows a "catalog unreachable" prompt on the tab.
  if (!tv.tvEnabled()) return res.json({ enabled: false, items: [] });
  const r = await tv.browse(catalogFilters(req.query, "series"));
  res.json({ enabled: true, playable: tv.tvPlayable(), ...r, filters: filterOptions("series") });
}));
app.get("/api/tv/search", requireAuth, ah(async (req, res) => {
  if (!tv.tvEnabled()) return res.json({ items: [] });
  const q = (req.query.q || "").toString().trim();
  if (q.length < 2) return res.json({ items: [] });
  res.json({ items: await tv.search(q) });
}));
app.get("/api/tv/:id", requireAuth, ah(async (req, res) => {
  const d = await tv.detail(req.params.id);
  if (!d) return res.status(404).json({ error: "unknown show" });
  res.json(d);
}));
app.get("/api/tv/:id/season/:n", requireAuth, ah(async (req, res) => {
  res.json({ episodes: await tv.episodes(req.params.id, req.params.n) });
}));
app.get("/api/tvshow/:id/:season/:ep/alts", requireAuth, ah(async (req, res) => {
  const r = await tv.altStreams(req.params.id, req.params.season, req.params.ep, req.query.have);
  res.json({ streams: (r.streams || []).map(toPlayable) });
}));
app.get("/api/tvshow/:id/:season/:ep/servers", requireAuth, ah(async (req, res) => {
  res.json(await tv.servers(req.params.id, req.params.season, req.params.ep));
}));
app.get("/api/tvshow/:id/:season/:ep/stream", requireAuth, ah(async (req, res) => {
  const r = await tv.stream(req.params.id, req.params.season, req.params.ep, { ...streamOpts(req.query), local: req.isLocalClient });
  // Nothing was cached, so Real-Debrid is fetching the best release. Not an
  // error — a wait. 202 + a handle the client polls, which beats the dead end
  // this used to be now that RD is the only backend.
  if (r.downloading) {
    return res.status(202).json({ streams: [], downloading: r.downloading, title: r.title ?? null });
  }
  if (r.error) {
    const code = r.error === "debrid-disabled" ? 503 : 502;
    return res.status(code).json({ error: r.error, detail: r.detail });
  }
  const play = await deliverOrProxy(r.stream, req, r.title,
    Math.max(0, Math.floor(Number(req.query.seek) || 0)), audioParam(req.query));
  if (play.pending) return res.status(202).json({ streams: [], upgrade: play.upgrade, title: r.title });
  res.json({ streams: [play.stream], best: play.stream, source: r.stream.source, title: r.title });
}));

// ---------- skip intervals (AniSkip: community-timed OP/ED per episode) ----------
// Returns { op: {start,end}, ed: {start,end} } in seconds, or {} when nobody
// has timed this episode. Keyed by MyAnimeList id, which AniList provides.
const skipCache = new Map(); // `${malId}:${ep}` -> { at, data }

app.get("/api/skip/:anilistId/:ep", requireAuth, ah(async (req, res) => {
  const id = Number(req.params.anilistId);
  const epNum = Number(req.params.ep);
  const meta = db.getCachedMeta(id);
  if (!meta || !Number.isInteger(epNum) || epNum <= 0) return res.json({});
  // Metas cached before malId existed lack it — backfill once and re-cache.
  if (meta.malId === undefined && id < FAUX_ID_FLOOR) {
    try {
      meta.malId = await fetchMalId(id);
      db.cacheMeta([meta]);
    } catch { return res.json({}); }
  }
  if (!meta.malId) return res.json({});
  const key = `${meta.malId}:${epNum}`;
  const hit = skipCache.get(key);
  if (hit && Date.now() - hit.at < 24 * 60 * 60 * 1000) return res.json(hit.data);
  const data = {};
  try {
    const url = `https://api.aniskip.com/v2/skip-times/${meta.malId}/${epNum}?types[]=op&types[]=ed&episodeLength=0`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (r.ok) {
      const json = await r.json();
      for (const item of json?.results || []) {
        if ((item.skipType === "op" || item.skipType === "ed") && item.interval)
          data[item.skipType] = { start: item.interval.startTime, end: item.interval.endTime };
      }
    }
  } catch {} // AniSkip down → just no skip button this session
  skipCache.set(key, { at: Date.now(), data });
  res.json(data);
}));

// ---------- rich episode metadata (thumbnails / titles / air dates) ----------
// Titles + thumbnails from AniList streamingEpisodes (Crunchyroll art), air
// dates from Jikan (MyAnimeList) — both keyless. Keyed by episode number so
// the detail modal can decorate the metadata-driven episode grid.
const epMetaCache = new Map(); // anilistId -> { at, data }

async function jikanAirDates(malId, into) {
  for (let page = 1; page <= 3; page++) { // cap pages so One Piece can't stall us
    const r = await fetch(`https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`, {
      headers: { Accept: "application/json" },
    });
    if (!r.ok) break;
    const j = await r.json();
    for (const e of j.data || []) {
      const num = e.mal_id;
      const airDate = e.aired ? e.aired.slice(0, 10) : null;
      if (!into[num]) into[num] = { title: (e.title || "").trim(), thumbnail: null, airDate };
      else { into[num].airDate = airDate; if (!into[num].title) into[num].title = (e.title || "").trim(); }
    }
    if (!j.pagination?.has_next_page) break;
  }
}

app.get("/api/episodes/:anilistId", requireAuth, ah(async (req, res) => {
  const id = Number(req.params.anilistId);
  const meta = db.getCachedMeta(id);
  if (!meta || id >= FAUX_ID_FLOOR) return res.json({ episodes: {} });
  const hit = epMetaCache.get(id);
  if (hit && Date.now() - hit.at < 6 * 60 * 60 * 1000) return res.json({ episodes: hit.data });

  const data = {};
  try {
    const map = await fetchEpisodeMeta(id); // { num: { title, thumbnail } }
    for (const [num, v] of Object.entries(map)) data[num] = { ...v, airDate: null };
  } catch {}
  if (meta.malId === undefined) {
    try { meta.malId = await fetchMalId(id); db.cacheMeta([meta]); } catch {}
  }
  if (meta.malId) { try { await jikanAirDates(meta.malId, data); } catch {} }

  epMetaCache.set(id, { at: Date.now(), data });
  res.json({ episodes: data });
}));

// ---------- external subtitles (multi-language, via lib/subs.mjs) ----------
// Route each file through our proxy: same-origin for the <track> element and
// converted SRT→VTT on the way through. The language rides along so the proxy
// can pick the right legacy codepage when a file isn't UTF-8 (Arabic → 1256).
const proxiedTracks = (tracks) =>
  tracks.map((t) => ({ ...t, url: `/proxy/subs?url=${encodeURIComponent(t.url)}&lang=${encodeURIComponent(t.lang)}` }));

app.get("/api/subs/:anilistId/:ep", requireAuth, ah(async (req, res) => {
  const id = Number(req.params.anilistId);
  const meta = db.getCachedMeta(id);
  if (!meta || id >= FAUX_ID_FLOOR) return res.json({ tracks: [] });
  try {
    const tracks = await findSubtitles({ anilistId: id, ep: req.params.ep, format: meta.format });
    res.json({ tracks: proxiedTracks(tracks) });
  } catch {
    res.json({ tracks: [] });
  }
}));

// Movies and TV Shows: their Cinemeta catalog ids are IMDb ids, queried
// directly. apibay-fallback movie ids ("m-…") have no IMDb id → no tracks.
app.get("/api/movie/:id/subs", requireAuth, ah(async (req, res) => {
  if (!/^tt\d+$/.test(req.params.id)) return res.json({ tracks: [] });
  res.json({ tracks: proxiedTracks(await findSubtitlesByImdb(req.params.id)) });
}));
app.get("/api/tvshow/:id/:season/:ep/subs", requireAuth, ah(async (req, res) => {
  const { id, season, ep } = req.params;
  if (!/^tt\d+$/.test(id) || !/^\d+$/.test(season) || !/^\d+$/.test(ep))
    return res.json({ tracks: [] });
  res.json({ tracks: proxiedTracks(await findSubtitlesByImdb(id, Number(season), Number(ep))) });
}));

// Fetch a subtitle file and serve it as WebVTT (browsers only take VTT tracks).
// We decode the raw bytes ourselves (detecting the encoding) rather than trust
// response.text(), which always assumes UTF-8 and mangles legacy-encoded files.
app.get("/proxy/subs", requireAuth, async (req, res) => {
  const { url, lang } = req.query;
  if (!url) return res.status(400).end("missing url");
  try {
    await assertSafeUrl(url); // SSRF guard
    const upstream = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0" },
    });
    if (!upstream.ok) return res.status(502).end("subtitle fetch failed");
    const text = decodeSubtitle(await upstream.arrayBuffer(), lang);
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.end(srtToVtt(text));
  } catch (e) {
    res.status(502).end(String(e.message));
  }
});

// Store watch progress (called ~every 10s and on pause/close via sendBeacon).
//
// Accepts all three verticals. Anime still posts `anilistId` + `episode`; films
// and shows post `kind` + `id`, and TV adds `season`. The legacy anime shape is
// still read because a TV app updates on its own schedule — a Tizen build from
// before this change keeps posting `anilistId` and must keep working.
const PROGRESS_KINDS = new Set(["anime", "movie", "tv"]);
app.post("/api/progress", requireAuth, (req, res) => {
  const b = req.body || {};
  // sendBeacon bodies arrive unvalidated off the wire — sanity-check before SQL.
  // duration is NaN→null while metadata is loading, so non-finite means "unknown"
  // (stored as 0 — the progress column is NOT NULL and 0 already renders as no bar).
  const kind = PROGRESS_KINDS.has(b.kind) ? b.kind
    : Number.isFinite(b.anilistId) ? "anime" : null;
  const mediaId = kind === "anime" ? b.anilistId ?? b.id : b.id;
  if (!kind || mediaId == null || String(mediaId) === "")
    return res.status(400).json({ error: "missing fields" });

  // An episode number is required for the episodic kinds and meaningless for a
  // film. Number("")/Number(null) are 0, so gate on type before coercing.
  const epGiven =
    typeof b.episode === "number" || (typeof b.episode === "string" && b.episode.trim());
  if (kind !== "movie" && !(epGiven && Number.isFinite(Number(b.episode))))
    return res.status(400).json({ error: "missing fields" });

  const str = (v, n) => (typeof v === "string" && v.trim() ? v.slice(0, n) : null);
  db.saveProgress({
    userId: req.user.id,
    kind,
    mediaId,
    title: str(b.title, 300),
    cover: str(b.cover, 500),
    // AniList models each anime season as its own entry, so anime never carries
    // one; a film has none to carry.
    season: kind === "tv" && Number.isFinite(Number(b.season)) ? Number(b.season) : null,
    episode: kind === "movie" ? "" : b.episode,
    seconds: Number.isFinite(b.seconds) ? b.seconds : 0,
    duration: Number.isFinite(b.duration) ? b.duration : 0,
  });
  res.json({ ok: true });
});

// Where did I leave off in this one thing? The player asks on launch so it can
// resume, which is the only way a film or a TV episode reached by a DEEP LINK
// (including a click on the Continue Watching row) can know its resume point —
// there is no detail payload carrying it the way anime's /api/title has.
app.get("/api/progress/:kind/:id", requireAuth, (req, res) => {
  const { kind, id } = req.params;
  if (!PROGRESS_KINDS.has(kind)) return res.status(400).json({ error: "bad kind" });
  res.json(db.getProgressFor(req.user.id, kind, id) || null);
});

// ---------- local media delivery (cache + transcode) ----------
//
// These serve bytes that are already on the array. They're the LAN's fast path
// and the remote client's adapted path, and neither involves the debrid CDN
// once the file has landed.

// Signed-token auth for media, matching the /proxy/* pattern: the player is a
// plain <video>/hls.js and can't attach headers, so the URL carries the grant.
function requireMediaGrant(subject) {
  return (req, res, next) => {
    if (currentUser(req)) return next();
    if (verifyMediaToken(subject(req), req.query.t)) return next();
    res.status(401).end("auth required");
  };
}

app.options(["/media/hls/:id/:file", "/media/file/:key"], mediaCors);

// Seek-anywhere over a live session: restart the SAME file and plan at a new
// offset. The player calls this when a scrub lands outside the transcoded
// window (or before the session's start point) — a fresh ffmpeg at the target
// is seconds, where waiting for the encoder to reach it could be most of the
// film. Registered before the :file route, which would otherwise swallow
// "seek" as a segment name and wait for a file that will never exist.
// The old session's signed token authorizes the jump; the response carries a
// token for the new session. reseekSession retires the ancestor — same
// viewer, same timeline, one encoder.
app.get("/media/hls/:id/seek", mediaCors, requireMediaGrant((req) => req.params.id), ah(async (req, res) => {
  const to = Math.max(0, Math.floor(Number(req.query.to) || 0));
  const s = await transcodeSessions.reseekSession(req.params.id, to).catch(() => null);
  if (!s) return res.status(404).json({ error: "session expired" }); // caller re-requests the stream
  res.json({ playUrl: `/media/hls/${s.id}/index.m3u8?t=${signMediaToken(s.id)}`, seekBase: s.seekSec });
}));

// The live transcode/remux session's playlist and segments.
app.get("/media/hls/:id/:file", mediaCors, requireMediaGrant((req) => req.params.id), (req, res) => {
  // Touching on every read is what keeps the session alive; the reaper kills
  // anything not read recently, which is how a closed tab frees its encoder.
  const s = transcodeSessions.touch(req.params.id);
  if (!s) return res.status(404).end("no such session");
  const file = path.basename(req.params.file); // never let a segment name escape the dir
  const full = path.join(s.outDir, file);
  if (!full.startsWith(s.outDir)) return res.status(400).end("bad path");

  // ffmpeg writes the playlist incrementally; a request that arrives before the
  // first segment exists should wait briefly rather than 404 the player out of
  // the stream entirely.
  const send = (tries = 0) => {
    if (fs.existsSync(full)) {
      res.setHeader("Cache-Control", "no-store");
      if (file.endsWith(".m3u8")) res.type("application/vnd.apple.mpegurl");
      if (file.endsWith(".vtt")) res.type("text/vtt"); // embedded-subtitle sidecars
      return res.sendFile(full);
    }
    if (s.exited && s.exitCode) return res.status(502).end(`transcode failed: ${s.stderr.slice(-200)}`);
    if (tries > 40) return res.status(504).end("segment timeout");
    setTimeout(() => send(tries + 1), 250);
  };
  send();
});

// Direct playback of a cached file — LAN clients whose codecs need nothing done
// to them. Range-aware so seeking works without a transcoder in the path.
app.get("/media/file/:key", mediaCors, requireMediaGrant((req) => req.params.key), (req, res) => {
  const row = cacheStore.lookup(req.params.key);
  if (!row) return res.status(404).end("not cached");
  const size = fs.statSync(row.path).size;
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  res.setHeader("Accept-Ranges", "bytes");
  if (range) {
    const start = Number(range[1] || 0);
    const end = Math.min(Number(range[2] || size - 1), size - 1);
    res.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", end - start + 1);
    return fs.createReadStream(row.path, { start, end }).pipe(res);
  }
  res.setHeader("Content-Length", size);
  fs.createReadStream(row.path).pipe(res);
});

// ---------- upgrade-in-place ----------
//
// The floor tier is already playing. This starts (or reports on) acquisition of
// the ranked quality release, and hands back a play URL once the file has a
// head start. The client seeks into it at the current timestamp — instant start
// AND remux quality, instead of choosing between them.
app.post("/api/upgrade", requireAuth, ah(async (req, res) => {
  const { anilistId, ep, mode = "sub" } = req.body || {};
  const meta = db.getCachedMeta(Number(anilistId));
  if (!meta) return res.status(404).json({ error: "unknown title" });

  const streams = await resolveQualityStreams(meta, String(ep), mode === "dub" ? "dub" : "sub").catch(() => []);
  const file = streams.find((s) => s.type === "file");
  if (!file) return res.json({ available: false, reason: "no quality release found" });

  const out = await deliver(file, { local: req.isLocalClient, title: meta.title, mode: mode === "dub" ? "dub" : "sub" });
  if (out.kind === "pending") return res.json({ available: true, ready: false, key: out.key, progress: out.progress });
  if (out.kind === "unavailable") return res.json({ available: false, reason: out.error });
  res.json({
    available: true,
    ready: true,
    key: out.key,
    playUrl: out.playUrl,
    type: out.kind === "hls" ? "hls" : "mp4",
    source: file.source,
    release: file.release || null,
    mbps: out.probe?.mbps ?? null,
    durationSec: out.probe?.durationSec || null, // full runtime, for the player's virtual timeline
    audio: out.plan?.audioIndex != null
      ? out.probe?.audio?.find((a) => a.index === out.plan.audioIndex) ?? null
      : null,
    delivery: out.plan?.mode, reason: out.plan?.reason,
  });
}));

// Poll a release Real-Debrid is fetching for us (movies/TV).
//
// The counterpart to the 202 above. Once RD reports the file downloaded this
// unrestricts it and hands back a playable stream through the same local
// delivery path everything else uses.
app.get("/api/debrid/progress/:torrentId", requireAuth, ah(async (req, res) => {
  const st = await debridProgress(req.params.torrentId).catch((e) => ({ failed: e.message }));
  if (st.failed) return res.status(502).json({ error: st.failed });
  if (!st.ready) {
    return res.json({
      ready: false, status: st.status, progress: st.progress,
      speed: st.speed, seeders: st.seeders, filename: st.filename,
    });
  }
  const play = await deliverOrProxy(st.stream, req, st.filename);
  if (play.pending) return res.json({ ready: false, status: "preparing", progress: 100 });
  res.json({ ready: true, streams: [play.stream], best: play.stream, source: play.stream.source });
}));

// Poll an in-flight upgrade.
app.get("/api/upgrade/:key", requireAuth, (req, res) => {
  const st = upgradeStatus(req.params.key);
  if (!st) return res.status(404).json({ error: "unknown upgrade" });
  res.json(st);
});

// ---------- HLS proxy (only for providers that enforce Referer) ----------
// Rewrites .m3u8 manifests so segment URLs also route through us with the
// right Referer. Direct-CDN mp4s never touch this — keeps load off the tunnel.

// The headers an embed CDN checks. Referer and Origin come from the source
// itself (the provider reports what each host wants); the fallback Referer is only
// for streams that carried none. Origin is omitted rather than guessed — a
// wrong Origin is rejected where a missing one is often allowed.
const embedHeaders = (referer, origin) => ({
  Referer: referer || "https://youtu-chan.com",
  ...(origin ? { Origin: origin } : {}),
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0",
});

app.options(["/proxy/hls", "/proxy/mp4"], mediaCors);
app.get("/proxy/hls", mediaCors, requireAuthOrMediaToken, async (req, res) => {
  const { url, referer, origin } = req.query;
  if (!url) return res.status(400).end("missing url");
  const upstreamAbort = new AbortController();
  res.on("close", () => upstreamAbort.abort()); // canceled viewer stops the upstream fetch too
  try {
    await assertSafeUrl(url); // SSRF guard: reject internal/private targets
    const upstream = await fetch(url, {
      signal: upstreamAbort.signal,
      headers: embedHeaders(referer, origin),
    });
    if (!upstream.ok) return res.status(502).end(`upstream ${upstream.status}`);
    const ct = upstream.headers.get("content-type") || "";
    const isManifest = url.includes(".m3u8") || ct.includes("mpegurl");
    if (isManifest) {
      let body = await upstream.text();
      const base = url.slice(0, url.lastIndexOf("/") + 1);
      // each rewritten URL gets its own token so a cookie-less Chromecast
      // can fetch nested playlists, segments, keys, and init segments too
      const originQ = origin ? `&origin=${encodeURIComponent(origin)}` : "";
      const proxied = (u) => {
        const abs = u.startsWith("http") ? u : base + u;
        return `/proxy/hls?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(referer || "")}${originQ}&t=${signMediaToken(abs)}`;
      };
      body = body
        .split("\n")
        .map((line) => {
          if (!line) return line;
          // tag lines can carry URLs too: EXT-X-KEY (AES keys), EXT-X-MAP (fMP4
          // init segments), EXT-X-MEDIA (audio/subtitle renditions) — left
          // unrewritten they'd bypass the Referer and hit connect-src 'self'
          if (line.startsWith("#"))
            return line.replace(/URI="([^"]+)"/, (_, uri) => `URI="${proxied(uri)}"`);
          return proxied(line);
        })
        .join("\n");
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.end(body);
    }
    res.setHeader("Content-Type", ct || "video/mp2t");
    if (!upstream.body) return res.end();
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // respect backpressure so a fast provider can't balloon memory
      if (!res.write(Buffer.from(value))) await new Promise((r) => res.once("drain", r));
    }
    res.end();
  } catch (e) {
    if (upstreamAbort.signal.aborted) return; // viewer canceled — routine for video
    if (res.headersSent) return res.end();
    res.status(502).end(String(e.message));
  }
});

// MP4 proxy with Range support (seeking). Forwards the client's Range header
// upstream with the required Referer, and relays the 206 + Content-Range back.
// Browsers cancel video requests constantly (buffer-full, seeks, player close);
// the AbortController makes sure a canceled viewer also stops the upstream
// download instead of leaving it pulling the rest of the file through the box.
app.get("/proxy/mp4", mediaCors, requireAuthOrMediaToken, async (req, res) => {
  const { url, referer, origin } = req.query;
  if (!url) return res.status(400).end("missing url");
  const upstreamAbort = new AbortController();
  res.on("close", () => upstreamAbort.abort());
  try {
    await assertSafeUrl(url); // SSRF guard: reject internal/private targets
    const headers = embedHeaders(referer, origin);
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(url, { headers, signal: upstreamAbort.signal });
    res.status(upstream.status); // 200 or 206
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstream.headers.get("accept-ranges")) res.setHeader("Accept-Ranges", "bytes");
    if (!upstream.body) return res.end();
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // respect backpressure so a fast provider can't balloon memory
      if (!res.write(Buffer.from(value))) await new Promise((r) => res.once("drain", r));
    }
    res.end();
  } catch (e) {
    if (upstreamAbort.signal.aborted) return; // viewer canceled — routine for video
    if (res.headersSent) return res.end();
    res.status(502).end(String(e.message));
  }
});

// ---------- health check (for the supervisor / Docker healthcheck) ----------
// `providers` is per-source health, now with typed failure states so "blocked"
// (bot-gated / IP-blocked upstream) reads differently from "upstream-down"
// (transient) and "no-sources" (this title, not this provider). The process
// stays "ok:true" as long as ANY provider can serve — one source breaking is a
// quality downgrade, not downtime.
app.get("/healthz", (req, res) =>
  res.json({
    ok: true,
    uptime: process.uptime(),
    // Which delivery tier THIS request would get. Reported because the whole
    // LAN/remote split hinges on it and it is otherwise invisible — hitting
    // /healthz on both ports is the fastest way to confirm the wiring.
    local: req.isLocalClient,
    transcode: transcodeSessions.status(),
    cache: cacheStore.stats(),
    // lastError included: for a no-sources result it holds the per-candidate
    // tally ("4 blocked (takedown), 6 not cached of 19 found"), which is what
    // the player shows a viewer when an episode won't start.
    providers: getProvidersHealth().map((p) => ({ name: p.name, status: p.status, lastError: p.lastError })),
    // Newest release timestamp each torrent index has returned this process —
    // `stale: true` means it has gone quiet the way AnimeTosho did in May 2026.
    indexes: indexFreshness(),
  }));

// ---------- old-TV assets ----------
// Samsung's 2020 sets run Tizen 5.5 = Chromium 69, which predates optional
// chaining, nullish coalescing and the CSS `inset` shorthand — all of which the
// app uses. On those TVs app.js is a SYNTAX ERROR, so nothing boots and the
// screen is simply black. `npm run build:tv` writes Chromium-69 copies to
// public/tv-build; serve those to Tizen webviews and the untouched originals to
// every other browser. Missing build directory → everyone gets the originals,
// so a desktop-only checkout behaves exactly as before.
const TV_ASSETS = new Set(["/app.js", "/tv.js", "/config.js", "/styles.css", "/tv.css"]);
const TV_BUILD = path.join(__dirname, "public", "tv-build");
const hasTvBuild = fs.existsSync(TV_BUILD);
if (!hasTvBuild) console.warn("  [tv] public/tv-build missing — old Samsung TVs will fail to boot. Run: npm run build:tv");
let tvSeen = false;
app.use((req, res, next) => {
  if (!hasTvBuild || !TV_ASSETS.has(req.path)) return next();
  const ua = req.headers["user-agent"] || "";
  if (!/\bTizen\b/i.test(ua)) return next();
  // One line per process when a TV first shows up: the only easy confirmation
  // that a set actually reached us, since retail TVs give no logs or console.
  if (!tvSeen) { tvSeen = true; console.log(`  [tv] serving Chromium-69 assets to: ${ua.slice(0, 120)}`); }
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Vary", "User-Agent"); // never let a proxy hand this copy to a desktop
  res.sendFile(path.join(TV_BUILD, req.path));
});

// ---------- static SPA ----------
// App assets are unversioned, so they must revalidate on every load — otherwise
// Cloudflare's edge (and browsers) serve stale JS/CSS against fresh HTML after
// a deploy. ETag 304s keep revalidation cheap. Vendored libs never change.
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    res.setHeader(
      "Cache-Control",
      filePath.includes(`${path.sep}vendor${path.sep}`) ? "public, max-age=604800" : "no-cache"
    );
  },
}));

// Client-routed pages (deep links / reloads) get the SPA shell with a 200.
app.get([/^\/title\/\d+$/, /^\/watch\/\d+\/[^/]+$/, /^\/category\/[^/]+$/, "/schedule", "/browse", "/movies", /^\/movie\/[^/]+$/, /^\/moviewatch\/[^/]+$/, "/tv", /^\/tv\/[^/]+$/, /^\/tvwatch\/[^/]+\/[^/]+\/[^/]+$/], (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- 404 + error handler ----------
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "not found" });
  res.setHeader("Cache-Control", "no-cache");
  res.status(404).sendFile(path.join(__dirname, "public", "index.html")); // SPA fallback
});
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("[error]", err?.message || err);
  if (res.headersSent) return;
  res.status(500).json({ error: config.isProd ? "internal error" : String(err?.message || err) });
});

// Refresh trending/popular rows nightly so they don't go stale.
setInterval(() => { rowCache = { at: 0, data: null }; }, 6 * 60 * 60 * 1000).unref?.();
// Prune expired sessions periodically.
setInterval(() => db.pruneSessions(SESSION_MAX_AGE), 24 * 60 * 60 * 1000).unref?.();

const server = app.listen(PORT, () => {
  console.log(`\n  Mediawan running (${config.isProd ? "production" : "dev"}):  http://localhost:${PORT}`);
});

// ---------- the LAN listener ----------
//
// Same app, second socket — and the socket is the point. Behind cloudflared
// with `trust proxy` on, req.ip is the tunnel's, so it cannot distinguish a TV
// in the next room from someone on hotel wifi. A client that connected HERE is
// on the local network by construction, and that fact can't be forged from
// outside it. Everything downstream (lib/delivery.mjs) reads `req.isLocalClient`
// to decide between original-quality bytes and a bitrate-capped encode.
let lanServer = null;
if (config.lanPort) {
  lanServer = app.listen(config.lanPort, () => {
    console.log(`  LAN (full quality, no transcode):        http://0.0.0.0:${config.lanPort}`);
  });
  lanServer.on("error", (e) => console.warn(`  [lan] listener failed on ${config.lanPort}: ${e.message}`));
}

// Boot-time housekeeping for the source cache: the index and the array drift
// when the process dies mid-download, and the disk is the authority.
cacheStore.reconcile()
  .then(() => {
    const s = cacheStore.stats();
    console.log(`  Cache: ${(s.usedBytes / 1024 ** 3).toFixed(1)} GB of ${(s.budgetBytes / 1024 ** 4).toFixed(1)} TB, ${s.entries} entries → ${s.dir}`);
  })
  .catch((e) => console.warn(`  [cache] reconcile failed: ${e.message}`));

// Reap idle ffmpeg sessions. Not housekeeping — a leaked encoder holds a core
// forever, and on a 4-core N100 two leaks are most of the box.
transcodeSessions.startReaper();
// Sweep session dirs a killed predecessor left on disk. Session ids are
// deterministic, so a stale dir is exactly where the next play of that episode
// will write — and ffmpeg would APPEND to the dead playlist instead of
// starting one (see sweepSessionRoot).
transcodeSessions.sweepSessionRoot().catch(() => {});
capabilities().then((c) => {
  if (!config.transcode.enabled) return console.log("  Transcode: disabled (TRANSCODE=false)");
  if (!c.ffmpeg) return console.warn(`  [transcode] ffmpeg NOT FOUND (${c.error}) — remote clients cannot be served adapted streams`);
  if (!c.qsv && config.transcode.hwaccel === "qsv")
    console.warn("  [transcode] QuickSync unavailable — falling back to libx264. An N100 will NOT keep up in real time; check /dev/dri is passed through.");
  else console.log(`  Transcode: ${c.encoders.join(", ")} · remote cap ${config.transcode.remoteMbps} Mbps · max ${config.transcode.maxSessions} sessions`);
});
console.log("");

// ---------- resilience: never die on one bad request ----------
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
  // let the supervisor restart us on a truly fatal error
  shutdown("uncaughtException", 1);
});

let shuttingDown = false;
function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ${signal} received — shutting down gracefully…`);
  // Kill the encoders and remove their dirs NOW, not never: a session dir that
  // outlives its process is exactly the appended-playlist corruption the boot
  // sweep exists to clean up after.
  transcodeSessions.stopAll().catch(() => {});
  server.close(() => {
    db.closeDb();
    process.exit(code);
  });
  // hard-exit if connections don't drain in time
  setTimeout(() => process.exit(code), 8000).unref?.();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
