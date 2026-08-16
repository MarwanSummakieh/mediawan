// External soft subtitles (multi-language), from OpenSubtitles via the public
// Stremio addon — keyless.
//
// This is the third and last subtitle source, and the only one that always
// exists: a release file carries its own text tracks (extracted by the
// transcode session) and a streaming source ships its own VTTs beside the video
// (see providerSubs in lib/providers/vidlink.mjs). Both of those are timed for
// exactly what is playing; these are timed for SOME release, which is why the
// player offers them last and lets the viewer nudge them.
//
// Mapping chain, all cached:
//   AniList id ──ARM──▶ { imdb, anidb, tvdb-season }
//   anidb ──anime-lists XML──▶ episode offset within the IMDb/TVDB season
//     (e.g. "Final Season Part 2" ep 1 = season 4 ep 17)
//   imdb:season:episode ──Stremio OpenSubtitles addon──▶ per-language SRT urls
const ARM = "https://arm.haglund.dev/api/v2/ids";
const ANIME_LISTS =
  "https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list-full.xml";
const STREMIO = "https://opensubtitles-v3.strem.io/subtitles";

const DAY = 24 * 60 * 60 * 1000;

const LANG_NAMES = {
  eng: "English", ara: "Arabic", fre: "French", ger: "German", spa: "Spanish",
  spl: "Spanish (Latin America)", por: "Portuguese", pob: "Portuguese (Brazil)",
  ita: "Italian", rus: "Russian", tur: "Turkish", jpn: "Japanese", kor: "Korean",
  chi: "Chinese", zht: "Chinese (Traditional)", vie: "Vietnamese", ind: "Indonesian",
  tha: "Thai", pol: "Polish", dut: "Dutch", swe: "Swedish", nor: "Norwegian",
  dan: "Danish", fin: "Finnish", cze: "Czech", gre: "Greek", heb: "Hebrew",
  hin: "Hindi", ben: "Bengali", per: "Persian", alb: "Albanian", rum: "Romanian",
  hun: "Hungarian", ukr: "Ukrainian", bul: "Bulgarian", srp: "Serbian",
  hrv: "Croatian", may: "Malay", slv: "Slovenian", est: "Estonian",
};

const armCache = new Map(); // anilistId -> { at, ids }
let xmlCache = { at: 0, text: null };
const subsCache = new Map(); // `${anilistId}:${ep}` -> { at, tracks }

async function armIds(anilistId) {
  const hit = armCache.get(anilistId);
  if (hit && Date.now() - hit.at < 7 * DAY) return hit.ids;
  let ids = null;
  try {
    const r = await fetch(`${ARM}?source=anilist&id=${anilistId}`);
    if (r.ok) ids = await r.json();
  } catch {}
  armCache.set(anilistId, { at: Date.now(), ids });
  return ids;
}

// anime-lists knows how AniDB entries (≈ AniList entries) map into TVDB/IMDb
// seasons, including the episode offset for "Part 2"-style split seasons.
async function episodeMapping(anidb) {
  if (!xmlCache.text || Date.now() - xmlCache.at > 7 * DAY) {
    try {
      const r = await fetch(ANIME_LISTS);
      if (r.ok) xmlCache = { at: Date.now(), text: await r.text() };
    } catch {}
    if (!xmlCache.text) return null;
  }
  const m = xmlCache.text.match(new RegExp(`<anime anidbid="${anidb}"[^>]*>`));
  if (!m) return null;
  const attr = (name) => {
    const a = m[0].match(new RegExp(`${name}="([^"]*)"`));
    return a ? a[1] : null;
  };
  const season = attr("defaulttvdbseason");
  const offset = attr("episodeoffset");
  return {
    season: season != null && season !== "a" ? Number(season) : null,
    offset: offset != null ? Number(offset) : 0,
  };
}

// How many tracks to keep per language. Subtitle timing is RELEASE-specific: a
// file synced to a 23.976fps BluRay drifts steadily against a 25fps WEB-DL, and
// extended cuts diverge outright. The addon can't help us pick — it ignores the
// videoHash/videoSize/filename hints the Stremio protocol allows (verified: the
// response is byte-identical with and without them) and its tracks carry no
// release metadata to match on. So the choice has to reach the viewer: when the
// first English track runs out of sync, the next one usually doesn't. Keeping
// one per language, as this used to, threw that away — Interstellar offers four.
const PER_LANG = 4;

// Query one OpenSubtitles-addon URL → [{ id, lang, label, url }], English
// first. Empty array when nothing matched.
async function addonTracks(url) {
  const tracks = [];
  try {
    const r = await fetch(url);
    const subs = r.ok ? (await r.json())?.subtitles || [] : [];
    const count = new Map();
    for (const s of subs) {
      if (!s.url) continue;
      const n = (count.get(s.lang) || 0) + 1;
      if (n > PER_LANG) continue;
      count.set(s.lang, n);
      const base = LANG_NAMES[s.lang] || s.lang;
      tracks.push({
        id: String(s.id || `${s.lang}-${n}`),
        lang: s.lang,
        // the addon returns these roughly best-first, so #1 is the plain name
        label: n === 1 ? base : `${base} · ${n}`,
        variant: n,
        url: s.url,
      });
    }
    tracks.sort((a, b) =>
      (a.lang === "eng" ? -1 : b.lang === "eng" ? 1 : a.label.localeCompare(b.label)) ||
      a.variant - b.variant);
  } catch {}
  return tracks;
}

// Available subtitle tracks for one anime episode (AniList id → IMDb mapping).
export async function findSubtitles({ anilistId, ep, format }) {
  const key = `${anilistId}:${ep}`;
  const hit = subsCache.get(key);
  if (hit && Date.now() - hit.at < DAY) return hit.tracks;

  let tracks = [];
  const epNum = Number(ep);
  const ids = await armIds(anilistId);
  if (ids?.imdb && (format === "MOVIE" || Number.isInteger(epNum))) {
    let url;
    if (format === "MOVIE" || ids.media === "MOVIE") {
      url = `${STREMIO}/movie/${ids.imdb}.json`;
    } else {
      let season = ids["thetvdb-season"] ?? ids["themoviedb-season"] ?? 1;
      let offset = 0;
      if (ids.anidb) {
        const map = await episodeMapping(ids.anidb);
        if (map) {
          if (map.season != null) season = map.season;
          offset = map.offset;
        }
      }
      url = `${STREMIO}/series/${ids.imdb}:${season}:${epNum + offset}.json`;
    }
    tracks = await addonTracks(url);
  }
  subsCache.set(key, { at: Date.now(), tracks });
  return tracks;
}

// Movies/TV verticals: their catalog ids ARE IMDb ids, so the addon can be
// queried directly — none of the AniList→IMDb mapping above is needed.
export async function findSubtitlesByImdb(imdbId, season = null, ep = null) {
  const key = `imdb:${imdbId}:${season}:${ep}`;
  const hit = subsCache.get(key);
  if (hit && Date.now() - hit.at < DAY) return hit.tracks;
  const tracks = await addonTracks(season != null
    ? `${STREMIO}/series/${imdbId}:${season}:${ep}.json`
    : `${STREMIO}/movie/${imdbId}.json`);
  subsCache.set(key, { at: Date.now(), tracks });
  return tracks;
}

// Legacy single-byte encoding to try per subtitle language when the bytes are
// not valid UTF-8. OpenSubtitles hosts many Arabic/Cyrillic/etc. files in these
// old codepages; decoding them as UTF-8 (what response.text() does) is what
// turns Arabic into "Ø§Ù„..." gibberish.
const LEGACY_BY_LANG = {
  ara: "windows-1256", ar: "windows-1256", per: "windows-1256", fas: "windows-1256", urd: "windows-1256",
  rus: "windows-1251", bul: "windows-1251", ukr: "windows-1251", srp: "windows-1251", mkd: "windows-1251", bel: "windows-1251",
  ell: "windows-1253", gre: "windows-1253",
  heb: "windows-1255",
  tur: "windows-1254",
  tha: "windows-874",
  vie: "windows-1258",
};

// Decode raw subtitle bytes to a JS string, detecting the encoding instead of
// assuming UTF-8. Honors a BOM, keeps valid UTF-8 as-is, and otherwise falls
// back to the language's legacy codepage (default Windows-1252).
export function decodeSubtitle(arrayBuffer, lang) {
  const buf = Buffer.from(arrayBuffer);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString("utf8"); // UTF-8 BOM
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch {} // valid UTF-8 → keep
  const enc = LEGACY_BY_LANG[(lang || "").toLowerCase()] || "windows-1252";
  try { return new TextDecoder(enc).decode(buf); } catch { return new TextDecoder("windows-1252").decode(buf); }
}

// SRT (or already-VTT) text → WebVTT for the browser's <track> element.
export function srtToVtt(s) {
  s = s.replace(/^﻿/, "").replace(/\r/g, "");
  if (/^WEBVTT/.test(s)) return s;
  return "WEBVTT\n\n" + s.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
}
