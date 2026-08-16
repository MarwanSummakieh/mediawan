// VidLink — the FLOOR tier for Movies and TV.
//
// Movies and TV never had a floor tier; anime had one until 2026-08-06 and now
// has none either (see ./index.mjs). Their only path to playback was: discover
// releases, hope Real-Debrid has one cached, and if not, wait while RD pulls it
// off the swarm.
// That wait is the "availability is bad and it depends on peers" complaint —
// the peers are only on the critical path because nothing else can serve.
//
// This is the something-else. It answers in about a second with a direct MP4,
// needs no index, no seeders and no debrid call, and it is never allowed to
// outrank a release file (see tier below).
//
// ---- what this actually is ----
//
// The aggregator sites people mean by "it just works" — CineHD and its many
// mirrors — host nothing. CineHD is a WordPress site behind five ad networks
// whose player config names three upstreams, and VidLink is the only one of
// them that can be read server-side: vsembed's downstream 403s without a
// browser, and 2embed's chain and vidsrc both end at a Cloudflare Turnstile
// challenge, which is not something this app is going to try to defeat.
//
// Reading it server-side is the entire point: the ads live in their PAGE, and
// we never load their page. We ask their API and get back CDN URLs.
//
// ---- the cost, stated plainly ----
//
// VidLink's API is authorised by a token from a Go/WASM binary they compile.
// There is no id-only endpoint. So this source means running their code, which
// is why it is OFF unless VIDLINK=true, why the binary runs in a stripped
// sandbox on a worker thread, and why its digest is pinned so a silent swap
// fails closed instead of executing. See ./vidlink/worker.mjs and ./token.mjs.
//
// ---- and why it is floor tier ----
//
// The best it serves is a ~1080p MP4 re-encode with baked CDN signatures and a
// one-hour TTL. That is worth having when the alternative is a spinner, and
// worth nothing when a REMUX is available. It ranks below every release file,
// always.
import { token } from "./vidlink/token.mjs";

const BASE = (process.env.VIDLINK_BASE || "https://vidlink.pro").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.VIDLINK_TIMEOUT_MS) || 12_000;
const AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Off by default. Turning it on is a decision about running third-party code,
// not a performance tweak, so it is never implied by anything else.
export const vidlinkEnabled = () => process.env.VIDLINK === "true";

// Their capability header. "standard" is the value their own player sends for
// a browser without exotic codec support, and it is required — the API answers
// differently without it.
const PLAYBACK_ENV = process.env.VIDLINK_PLAYBACK_ENV || "standard";

// Ask the API for one title. `kind` is "movie" or "tv"; TV takes season and
// episode. Returns the raw payload or null when they simply have nothing.
//
// The two verticals are keyed DIFFERENTLY and this is not negotiable at our
// end: /api/b/movie accepts an IMDb id directly, while /api/b/tv only accepts
// the TMDB series id — an IMDb id there answers 500. Cinemeta already returns
// that id as `moviedb_id` on series metadata, so this costs no API key and
// does not reintroduce the TMDB_API_KEY requirement lib/tv.mjs removed.
async function api(kind, id, { season = null, episode = null, tokenFn = token } = {}) {
  const t = await tokenFn(id);
  const path = kind === "tv"
    ? `/api/b/tv/${t}/${Number(season)}/${Number(episode)}`
    : `/api/b/movie/${t}`;
  const r = await fetch(`${BASE}${path}?multiLang=0`, {
    headers: {
      "X-Playback-Environment": PLAYBACK_ENV,
      "User-Agent": AGENT,
      Referer: `${BASE}/`,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (r.status === 403) throw new Error("403 forbidden — VidLink rejected the token");
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  // A title they don't have answers 200 with a near-empty body rather than 404.
  const text = await r.text();
  if (text.length < 32) return null;
  return JSON.parse(text);
}

// ---- the no-ads lock ----
//
// Extracting server-side already removes every ad on their PAGE — Adcash and
// PopAds live in JavaScript we never load. What that does NOT rule out is an ad
// inside the media, and there is exactly one mechanism for that: server-side ad
// insertion, which needs a PLAYLIST to splice segments into. A progressive MP4
// is one static file with a fixed byte range; there is nowhere to insert.
//
// So the default is: MP4 only. HLS is refused outright rather than trusted.
//
// Verified against a live extraction (Antz, 1080p) by decoding frames: t=0 is
// black, t=4-12s is the Universal ident, t=30s the DreamWorks ident, t=60s the
// opening credits, and the file runs 83.4 min against an 83 min runtime — the
// idents account for the difference. No pre-roll. That is a sample, though, and
// this rule is what makes it a guarantee rather than a spot check.
//
// VIDLINK_ALLOW_HLS=true opts back in, and even then every playlist is scanned
// and dropped if it carries splice markers.
const ALLOW_HLS = process.env.VIDLINK_ALLOW_HLS === "true";

// The markers an HLS ad break is expressed with. SCTE-35 is the broadcast
// standard; the CUE-OUT/CUE-IN pair is how most stitchers write it; a bare
// DISCONTINUITY is how the crude ones do.
const AD_MARKERS = /#EXT-X-(?:CUE-OUT|SCTE35|ASSET|AD-|DISCONTINUITY\b)|SCTE35|CUE-OUT/i;

// Fetch an HLS playlist and refuse it if anything looks spliced. Network
// failure is treated as "not proven clean" — the lock fails CLOSED, because a
// floor stream is optional and an ad is not acceptable.
async function hlsIsClean(s) {
  try {
    const r = await fetch(s.url, {
      headers: { Referer: s.referer || `${BASE}/`, Origin: s.origin || undefined, "User-Agent": AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return false;
    return !AD_MARKERS.test(await r.text());
  } catch { return false; }
}

// Apply the lock to a resolved stream list.
async function vetted(streams) {
  const mp4 = streams.filter((s) => s.type !== "hls");
  if (!ALLOW_HLS) return mp4;
  const hls = streams.filter((s) => s.type === "hls");
  const checked = await Promise.all(hls.map(async (s) => (await hlsIsClean(s)) ? s : null));
  // MP4 first regardless: it cannot be spliced at all.
  return [...mp4, ...checked.filter(Boolean)];
}

// Their qualities map → this app's stream list, best first.
//
// Every URL is CDN-signed and gated on a Referer/Origin pair that a browser
// cannot set on a media element, so these carry `referer`/`origin` and are
// routed through /proxy/* like every other header-gated stream (see
// lib/playable.mjs).
function toStreams(payload, label) {
  const s = payload?.stream;
  const qualities = s?.qualities;
  if (!qualities || typeof qualities !== "object") return [];
  const subs = toTracks(s.captions);
  return Object.entries(qualities)
    .map(([q, v]) => ({ q: Number(q) || 0, v }))
    .filter(({ v }) => v && typeof v.url === "string")
    .sort((a, b) => b.q - a.q)
    .map(({ q, v }) => ({
      url: v.url,
      // They serve progressive MP4, not HLS — `type` drives which proxy the
      // player is handed, so calling it hls would break the play outright.
      type: v.type === "hls" || /\.m3u8(\?|$)/i.test(v.url) ? "hls" : "mp4",
      referer: v.headers?.referer || v.headers?.Referer || "",
      origin: v.headers?.origin || v.headers?.Origin || "",
      // Bare resolution: the player appends the "p" itself.
      quality: q ? String(q) : "auto",
      provider: "vidlink",
      tier: "floor",
      // Named for the Servers panel. The upstream vault id is included because
      // VidLink fronts several and they differ in quality and completeness —
      // "which one am I watching" is a real question when one of them is bad.
      source: `${label}${q ? ` · ${q}p` : ""}`,
      providerSubs: subs,
    }));
}

// Soft subtitle tracks. These sources ship no hardsubs, so without these a
// foreign-language film plays with no text at all.
function toTracks(captions) {
  if (!Array.isArray(captions)) return [];
  return captions
    .filter((c) => c?.url && c?.language)
    .map((c) => ({
      url: c.url,
      lang: String(c.language).slice(0, 35),
      label: `${c.language} · VidLink`,
      // srt and vtt both appear; server.mjs converts on the way out.
      format: c.type === "vtt" ? "vtt" : "srt",
    }));
}

// Empty result plus a human reason, riding ON the array — the convention the
// other providers use (see withNote in ./debrid.mjs), so the registry records
// it as lastError and the admin panel can explain itself.
const note = (list, text) => Object.assign(list, { note: text });

// ---- the two entry points Movies and TV call ----

// `tokenFn` is injectable so the unit tests can exercise this without
// downloading and executing 2.4 MB of third-party WebAssembly.
export async function movieStreams(imdbId, { tokenFn = token } = {}) {
  if (!vidlinkEnabled()) return note([], "VIDLINK is not enabled");
  if (!/^tt\d+$/.test(String(imdbId || ""))) return note([], `not an IMDb id: "${imdbId}"`);
  const payload = await api("movie", imdbId, { tokenFn });
  if (!payload) return note([], "VidLink has no copy of this film");
  const all = toStreams(payload, sourceLabel(payload));
  const out = await vetted(all);
  if (out.length) return out;
  return note([], all.length
    ? "every VidLink stream was a playlist that could carry ad breaks — refused"
    : "VidLink returned no playable quality");
}

// `tmdbId` is Cinemeta's `moviedb_id` for the SERIES — see api() above for why
// this one is not an IMDb id.
export async function episodeStreams(tmdbId, season, episode, { tokenFn = token } = {}) {
  if (!vidlinkEnabled()) return note([], "VIDLINK is not enabled");
  if (!/^\d+$/.test(String(tmdbId || "")))
    return note([], `TV needs a TMDB series id, got "${tmdbId}"`);
  if (!Number.isFinite(Number(season)) || !Number.isFinite(Number(episode)))
    return note([], `unusable season/episode "${season}/${episode}"`);
  const payload = await api("tv", tmdbId, { season, episode, tokenFn });
  if (!payload) return note([], "VidLink has no copy of this episode");
  const all = toStreams(payload, sourceLabel(payload));
  const out = await vetted(all);
  if (out.length) return out;
  return note([], all.length
    ? "every VidLink stream was a playlist that could carry ad breaks — refused"
    : "VidLink returned no playable quality");
}

const sourceLabel = (payload) =>
  payload?.sourceId ? `VidLink (${payload.sourceId})` : "VidLink";
