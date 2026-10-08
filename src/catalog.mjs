import { fail } from './store.mjs';
import { catalogMetadata, populated, plainText, runtimeSeconds } from './metadata.mjs';
import { releaseFacts } from './torrent-policy.mjs';
const fetchJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) fail(502, 'The catalog is unavailable. Your local library still works.');
  return response.json();
};
export function createCatalog(store, config, dependencies = {}) {
  const request = dependencies.request || fetchJson;
  const pending = new Map(),
    retryAfter = new Map();
  const type = (kind) => (kind === 'movie' ? 'movie' : 'series');
  const normalize = catalogMetadata;
  const fields =
    'id title { english romaji } coverImage { large } description episodes duration averageScore format countryOfOrigin bannerImage studios(isMain:true) { nodes { name } } status startDate { year month day } nextAiringEpisode { episode } genres';
  const anime = (meta) => ({
    kind: 'anime',
    external_id: String(meta.id),
    name: meta.title.english || meta.title.romaji,
    poster: meta.coverImage?.large || '',
    description: String(meta.description || '').replace(/<[^>]*>/g, ''),
    year: meta.startDate?.year || '',
    genres: meta.genres || [],
    background: meta.bannerImage,
    runtimeSeconds: runtimeSeconds(meta.duration),
    runtimeSource: meta.duration ? 'AniList' : undefined,
    anilistRating: meta.averageScore,
    status: meta.status,
    format: meta.format,
    country: meta.countryOfOrigin,
    studios: meta.studios?.nodes?.map((s) => s.name),
  });
  async function anilist(query, variables) {
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) fail(502, 'Anime discovery is unavailable. Your saved library still works.');
    const result = await response.json();
    if (result.errors) fail(502, 'Anime catalog lookup failed');
    return result.data;
  }
  const api = {
    async refresh(titleId, force = false) {
      const title = store.title(titleId);
      if (!title) fail(404, 'Title not found');
      if (
        !force &&
        (title.metadataUpdatedAt > Date.now() - 86400000 || retryAfter.get(titleId) > Date.now())
      )
        return title;
      if (pending.has(titleId)) return pending.get(titleId);
      const task = api
        .add(title.kind, title.external_id)
        .catch((error) => {
          retryAfter.set(titleId, Date.now() + 300000);
          if (force) throw error;
          return title;
        })
        .finally(() => pending.delete(titleId));
      pending.set(titleId, task);
      return task;
    },
    async search(kind, q) {
      if (kind === 'all') {
        const results = await Promise.allSettled(
          ['movie', 'tv', 'anime'].map((type) => api.search(type, q)),
        );
        const catalogs = results
          .filter((result) => result.status === 'fulfilled')
          .map((result) => result.value);
        if (!catalogs.length) throw results[0].reason;
        // Mix catalogs so series and anime remain visible alongside movies.
        return Array.from(
          { length: Math.max(0, ...catalogs.map((items) => items.length)) },
          (_, index) => catalogs.flatMap((items) => (items[index] ? [items[index]] : [])),
        ).flat();
      }
      if (!['movie', 'tv', 'anime'].includes(kind)) fail(400, 'Unknown catalog');
      if (kind === 'anime') {
        const data = await anilist(
          `query($search:String){Page(perPage:36){media(type:ANIME,search:$search,sort:POPULARITY_DESC){${fields}}}}`,
          { search: q || undefined },
        );
        return data.Page.media.map(anime);
      }
      const extra = q ? `/search=${encodeURIComponent(String(q).slice(0, 200))}` : '';
      const response = await request(`${config.catalogUrl}/catalog/${type(kind)}/top${extra}.json`);
      return (response.metas || [])
        .filter((m) => kind !== 'anime' || (m.genres || []).some((g) => /anime|animation/i.test(g)))
        .slice(0, 60)
        .map((m) => normalize(m, kind));
    },
    async add(kind, externalId) {
      if (kind === 'anime' && /^\d+$/.test(externalId)) {
        const data = await anilist(`query($id:Int){Media(id:$id,type:ANIME){${fields}}}`, {
          id: Number(externalId),
        });
        if (!data.Media) fail(404, 'Anime not found');
        return store.transaction(() => {
          const title = store.saveTitle({
              ...populated(anime(data.Media)),
              metadataUpdatedAt: Date.now(),
            }),
            count = data.Media.nextAiringEpisode
              ? data.Media.nextAiringEpisode.episode - 1
              : data.Media.status === 'FINISHED'
                ? data.Media.episodes || 0
                : 0;
          for (let n = 1; n <= count; n++)
            store.saveItem({
              title_id: title.id,
              season: 0,
              episode: n,
              ...(!store.items(title.id).some((i) => i.episode === n)
                ? { name: `Episode ${n}` }
                : {}),
            });
          return title;
        });
      }
      if (!['movie', 'tv', 'anime'].includes(kind) || !/^tt\d+$/.test(externalId))
        fail(400, 'Invalid catalog identity');
      const { meta } = await request(`${config.catalogUrl}/meta/${type(kind)}/${externalId}.json`);
      if (!meta) fail(404, 'Title not found');
      let show,
        episodes = [];
      if (kind === 'tv') {
        try {
          show = await request(`https://api.tvmaze.com/lookup/shows?imdb=${externalId}`);
          if (Number.isInteger(show?.id))
            episodes = await request(`https://api.tvmaze.com/shows/${show.id}/episodes?specials=1`);
        } catch {
          /* Supplemental metadata must not prevent adding or playing a title. */
        }
      }
      return store.transaction(() => {
        const title = store.saveTitle({
          ...normalize(meta, kind),
          ...populated({
            status: show?.status,
            language: show?.language,
            network: show?.network?.name || show?.webChannel?.name,
            tvmazeId: show?.id,
            tvmazeRating: show?.rating?.average,
            runtimeSeconds: runtimeSeconds(show?.averageRuntime || show?.runtime),
            runtimeSource: show?.averageRuntime || show?.runtime ? 'TVmaze' : undefined,
          }),
          metadataUpdatedAt: Date.now(),
        });
        if (kind === 'movie')
          store.saveItem({
            title_id: title.id,
            name: title.name,
            season: 0,
            episode: 0,
            ...populated({
              runtimeSeconds: title.runtimeSeconds,
              runtimeSource: title.runtimeSource,
            }),
          });
        else {
          for (const video of meta.videos || []) {
            if (
              video.season == null ||
              video.episode == null ||
              !Number.isFinite(Number(video.season)) ||
              !Number.isFinite(Number(video.episode))
            )
              continue;
            store.saveItem({
              title_id: title.id,
              season: Number(video.season),
              episode: Number(video.episode),
              ...populated({
                name: video.name || video.title,
                released: video.released || video.firstAired,
                thumbnail: video.thumbnail,
                description: plainText(video.overview || video.description),
                runtimeSeconds: runtimeSeconds(video.runtime),
                runtimeSource: runtimeSeconds(video.runtime) ? 'Cinemeta' : undefined,
              }),
            });
          }
          // Unnumbered specials cannot be safely aligned with the release catalog.
          for (const episode of episodes) {
            if (!Number.isInteger(episode.season) || !Number.isInteger(episode.number)) continue;
            store.saveItem({
              title_id: title.id,
              season: episode.season,
              episode: episode.number,
              ...populated({
                name: episode.name,
                description: plainText(episode.summary),
                released: episode.airstamp || episode.airdate,
                thumbnail: episode.image?.medium,
                runtimeSeconds: runtimeSeconds(episode.runtime),
                runtimeSource: runtimeSeconds(episode.runtime) ? 'TVmaze' : undefined,
                tvmazeId: episode.id,
                tvmazeRating: episode.rating?.average,
              }),
            });
          }
        }
        return title;
      });
    },
    async releases(itemId) {
      const item = store.item(itemId);
      if (!item) fail(404, 'Episode not found');
      const title = store.title(item.title_id);
      let key;
      if (title.kind === 'anime' && /^\d+$/.test(title.external_id)) {
        const mapping = await request(
          `https://relations.yuna.moe/api/ids?source=anilist&id=${title.external_id}`,
        );
        if (!mapping.kitsu) fail(404, 'No release mapping is available for this anime');
        key = `kitsu:${mapping.kitsu}:${item.episode}`;
      } else {
        if (!/^tt\d+$/.test(title.external_id))
          fail(400, 'This imported title needs an IMDb identity before searching releases');
        key =
          title.kind === 'movie'
            ? title.external_id
            : `${title.external_id}:${item.season}:${item.episode}`;
      }
      const response = await request(
        `${config.releaseUrl}/stream/${type(title.kind)}/${encodeURIComponent(key)}.json`,
      );
      return (response.streams || [])
        .filter((s) => /^[a-f0-9]{40}$/i.test(s.infoHash || ''))
        .slice(0, 80)
        .map((s) => ({
          hash: s.infoHash.toLowerCase(),
          fileIndex: Number.isInteger(s.fileIdx) ? s.fileIdx : null,
          ...releaseFacts(s),
        }));
    },
  };
  return api;
}
