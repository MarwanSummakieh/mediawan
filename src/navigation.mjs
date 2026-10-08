import { existsSync } from 'node:fs';
export function createNavigation(store) {
  function snapshot(user) {
    const titles = new Map(
      store
        .all('SELECT * FROM titles')
        .map(store.unpack)
        .map((t) => [t.id, t]),
    );
    const items = new Map(),
      assets = new Map(),
      tags = new Map();
    for (const item of store.all('SELECT * FROM items ORDER BY season,episode').map(store.unpack)) {
      if (!items.has(item.title_id)) items.set(item.title_id, []);
      items.get(item.title_id).push(item);
    }
    for (const asset of store
      .all('SELECT * FROM assets ORDER BY added_at DESC,id DESC')
      .map(store.unpack)) {
      if (!assets.has(asset.item_id)) assets.set(asset.item_id, []);
      assets
        .get(asset.item_id)
        .push({ ...asset, readable: store.canRead(user, asset), exists: existsSync(asset.path) });
    }
    for (const tag of store.all('SELECT * FROM tags WHERE user_id=?', user.id)) {
      if (!tags.has(tag.title_id)) tags.set(tag.title_id, []);
      tags.get(tag.title_id).push(tag.tag);
    }
    return {
      titles,
      items,
      assets,
      tags,
      states: new Map(
        store
          .all(
            'SELECT history.*,playback.mode FROM history LEFT JOIN playback ON playback.id=history.session_id WHERE history.user_id=?',
            user.id,
          )
          .map((s) => [s.item_id, s]),
      ),
      series: new Map(
        store
          .all('SELECT * FROM series_state WHERE user_id=?', user.id)
          .map((s) => [s.title_id, s]),
      ),
    };
  }
  function detail(user, titleId, cache = snapshot(user)) {
    const title = cache.titles.get(titleId);
    if (!title) return null;
    const allItems = cache.items.get(titleId) || [];
    const items = allItems
      .filter(
        (i) =>
          !(cache.assets.get(i.id) || []).length ||
          (cache.assets.get(i.id) || []).some((a) => a.readable),
      )
      .map((i) => {
        const asset = (cache.assets.get(i.id) || []).find((a) => a.readable && a.exists);
        const measured = asset?.probe?.duration;
        const durationSeconds =
          measured > 0 ? measured : i.runtimeSeconds || title.runtimeSeconds || null;
        return {
          durationSeconds,
          durationSource:
            measured > 0
              ? 'file'
              : i.runtimeSeconds
                ? i.runtimeSource || 'Catalog'
                : title.runtimeSeconds
                  ? title.kind === 'movie'
                    ? title.runtimeSource || 'Catalog'
                    : 'estimate'
                  : null,
          fileInfo: asset?.probe
            ? {
                bytes: asset.bytes,
                video: asset.probe.video,
                width: asset.probe.width,
                height: asset.probe.height,
                audio: asset.probe.audio,
                subtitles: asset.probe.subtitles,
              }
            : null,
          ...i,
          state: cache.states.get(i.id) || {
            position: 0,
            duration: 0,
            completed: 0,
            ever_watched: 0,
            played_at: 0,
          },
          available: (cache.assets.get(i.id) || []).some((a) => a.readable && a.exists),
        };
      });
    if (!items.length && allItems.length) return null;
    const tags = cache.tags.get(titleId) || [];
    const series = cache.series.get(titleId);
    const resumable =
      !series?.hidden &&
      items
        .filter((i) => i.available && i.state.position >= 10 && !i.state.completed)
        .sort((a, b) => b.state.played_at - a.state.played_at)[0];
    const ordered = items.filter(
      (i) => title.kind === 'movie' || i.season > 0 || title.kind === 'anime',
    );
    const cursor = ordered.findIndex((i) => i.id === series?.cursor);
    const next = ordered.slice(Math.max(0, cursor)).find((i) => !i.state.completed);
    const assets = items.flatMap((i) => (cache.assets.get(i.id) || []).filter((a) => a.readable));
    return {
      ...title,
      items,
      tags,
      resumable: resumable || null,
      next: next || null,
      started: items.some((i) => i.state.played_at > 0),
      readyCount: items.filter((i) => i.available).length,
      addedAt: Math.max(0, ...assets.map((a) => a.added_at)),
      lastPlayed: Math.max(0, ...items.map((i) => i.state.played_at)),
      watched: items.length > 0 && items.every((i) => i.state.completed),
      hidden: !!series?.hidden,
      primary: resumable || next || ordered.find((i) => i.available) || null,
    };
  }
  function list(user, filter = {}) {
    const cache = snapshot(user);
    let titles = [...cache.titles.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => detail(user, t.id, cache))
      .filter(Boolean);
    if (filter.scope !== 'all') titles = titles.filter((t) => t.addedAt > 0);
    if (filter.q)
      titles = titles.filter((t) => t.name.toLowerCase().includes(String(filter.q).toLowerCase()));
    if (filter.kind) titles = titles.filter((t) => t.kind === filter.kind);
    if (filter.tag) titles = titles.filter((t) => t.tags.includes(filter.tag));
    if (filter.genre) titles = titles.filter((t) => (t.genres || []).includes(filter.genre));
    if (filter.status === 'watched') titles = titles.filter((t) => t.watched);
    if (filter.status === 'unwatched') titles = titles.filter((t) => !t.watched);
    if (filter.status === 'progress') titles = titles.filter((t) => t.resumable);
    if (filter.status === 'ready') titles = titles.filter((t) => t.readyCount);
    const sorters = {
      added: (a, b) => b.addedAt - a.addedAt,
      played: (a, b) => b.lastPlayed - a.lastPlayed,
      year: (a, b) => (Number(b.year) || 0) - (Number(a.year) || 0),
    };
    if (sorters[filter.sort]) titles.sort(sorters[filter.sort]);
    return titles;
  }
  return {
    detail,
    list,
    home(user) {
      const all = list(user, { scope: 'all' });
      return {
        continueWatching: all
          .filter((t) => t.resumable)
          .sort((a, b) => b.resumable.state.played_at - a.resumable.state.played_at)
          .slice(0, 18),
        nextUp: all
          .filter((t) => t.kind !== 'movie' && t.started && !t.resumable && t.next && !t.hidden)
          .sort((a, b) => b.lastPlayed - a.lastPlayed)
          .slice(0, 18),
        recentlyAdded: all
          .filter((t) => t.addedAt)
          .sort((a, b) => b.addedAt - a.addedAt)
          .slice(0, 18),
        watchlist: all.filter((t) => t.tags.includes('watchlist')).slice(0, 18),
      };
    },
  };
}
