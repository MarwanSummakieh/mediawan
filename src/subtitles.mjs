import { fail } from './store.mjs';
import { srtToVtt, decodeSubtitle } from '../public/subtitles.js';
export { decodeSubtitle } from '../public/subtitles.js';

const ADDON = 'https://opensubtitles-v3.strem.io/subtitles';
const LIMIT = 2 * 1024 * 1024;
const languageNames = {
  eng: 'English',
  ara: 'Arabic · العربية',
  ar: 'Arabic · العربية',
  dan: 'Danish',
  fre: 'French',
  ger: 'German',
  spa: 'Spanish',
  spl: 'Spanish (Latin America)',
  por: 'Portuguese',
  pob: 'Portuguese (Brazil)',
  ita: 'Italian',
  rus: 'Russian',
  tur: 'Turkish',
  jpn: 'Japanese',
  kor: 'Korean',
  chi: 'Chinese',
  zht: 'Chinese (Traditional)',
  pol: 'Polish',
  dut: 'Dutch',
  swe: 'Swedish',
  nor: 'Norwegian',
  fin: 'Finnish',
  heb: 'Hebrew',
  per: 'Persian',
};
function subtitleUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443') &&
      (/(^|\.)opensubtitles\.(org|com)$/.test(url.hostname) ||
        /^subs\d*\.strem\.io$/.test(url.hostname))
    )
      return url.href;
  } catch {}
  fail(502, 'The subtitle provider returned an unsupported download address');
}
export function createSubtitles(store, { fetch: request = fetch } = {}) {
  const cache = new Map();
  async function read(url, download = false, limit = LIMIT) {
    for (let redirects = 0; redirects < 4; redirects++) {
      const response = await request(url, {
        signal: AbortSignal.timeout(15000),
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!download || !location) fail(502, 'The subtitle provider is unavailable');
        url = subtitleUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        fail(502, 'The subtitle provider is unavailable. Try again or open a subtitle file.');
      }
      let length = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > limit) fail(502, 'The subtitle response is too large');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }
    fail(502, 'The subtitle provider redirected too many times');
  }
  const json = async (url) => JSON.parse((await read(url)).toString('utf8'));
  function context(user, itemId) {
    if (!store.available(user, itemId)) fail(404, 'Local file is unavailable');
    const item = store.item(itemId);
    return { item, title: store.title(item.title_id) };
  }
  async function tracks(user, itemId) {
    const { item, title } = context(user, itemId);
    const hit = cache.get(itemId);
    if (hit && Date.now() - hit.at < 3600000) return hit.tracks;
    let imdb = title.external_id,
      season = item.season,
      episode = item.episode;
    let movie = title.kind === 'movie' || title.format === 'MOVIE';
    if (title.kind === 'anime' && /^\d+$/.test(imdb)) {
      const ids = await json(`https://arm.haglund.dev/api/v2/ids?source=anilist&id=${imdb}`);
      imdb = ids?.imdb;
      movie ||= ids?.media === 'MOVIE';
      season = ids?.['thetvdb-season'] ?? ids?.['themoviedb-season'] ?? season ?? 1;
      // Split anime seasons can start at episode 13 or 17 in the IMDb season.
      if (!movie && /^\d+$/.test(String(ids?.anidb))) {
        const xml = (
          await read(
            'https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list-full.xml',
            false,
            8 * LIMIT,
          )
        ).toString('utf8');
        const tag = xml.match(new RegExp(`<anime anidbid="${ids.anidb}"[^>]*>`))?.[0];
        const mapped = tag?.match(/defaulttvdbseason="(\d+)"/)?.[1];
        if (mapped != null) season = Number(mapped);
        episode += Number(tag?.match(/episodeoffset="(-?\d+)"/)?.[1] || 0);
      }
    }
    if (!/^tt\d+$/.test(imdb || '')) return [];
    const identity = movie ? imdb : `${imdb}:${season}:${episode}`;
    const data = await json(`${ADDON}/${movie ? 'movie' : 'series'}/${identity}.json`);
    const counts = new Map(),
      result = [];
    for (const entry of data.subtitles || []) {
      if (!entry.url || typeof entry.lang !== 'string') continue;
      let url;
      try {
        url = subtitleUrl(entry.url);
      } catch {
        continue;
      }
      const variant = (counts.get(entry.lang) || 0) + 1;
      if (variant > 4) continue;
      counts.set(entry.lang, variant);
      result.push({
        id: String(result.length),
        language: entry.lang,
        label: `${languageNames[entry.lang] || entry.lang}${variant > 1 ? ` · ${variant}` : ''}`,
        url,
      });
    }
    result.sort(
      (a, b) =>
        (a.language === 'eng' ? 0 : 1) - (b.language === 'eng' ? 0 : 1) ||
        a.label.localeCompare(b.label),
    );
    if (cache.size >= 200) cache.delete(cache.keys().next().value);
    cache.set(itemId, { at: Date.now(), tracks: result });
    return result;
  }
  return {
    async list(user, itemId) {
      return (await tracks(user, itemId)).map(({ url, ...track }) => track);
    },
    async file(user, itemId, trackId) {
      const track = (await tracks(user, itemId)).find((t) => t.id === trackId);
      if (!track) fail(404, 'Subtitle track not found');
      const text = decodeSubtitle(await read(track.url, true), track.language);
      const vtt = srtToVtt(text);
      if (!/(?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s*-->/.test(vtt))
        fail(502, 'This subtitle file has no readable cues');
      return vtt;
    },
  };
}
