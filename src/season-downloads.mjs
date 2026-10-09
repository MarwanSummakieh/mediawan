import { id, fail } from './store.mjs';
import { assessRelease, requiredResolution } from './torrent-policy.mjs';

const pendingStates = ['queued', 'finding'];
const unfinished = "state NOT IN ('failed','cancelled','ready','evicted')";
export function createSeasonDownloads(store, config, catalog, downloads, torrents, policy) {
  let timer,
    task,
    closing = false;
  const get = (key) => store.unpack(store.one('SELECT * FROM season_downloads WHERE id=?', key));
  const save = (batch) => {
    store.run(
      'INSERT INTO season_downloads VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated=excluded.updated,json=excluded.json',
      batch.id,
      batch.user_id,
      batch.title_id,
      batch.season,
      batch.state,
      Date.now(),
      JSON.stringify(batch),
    );
    return get(batch.id);
  };
  const allowed = (user) => user?.active && (user.role === 'admin' || user.can_download);
  function itemsFor(user, titleId, season) {
    if (!allowed(user)) fail(403, 'An administrator must enable your downloads');
    const title = store.title(titleId);
    if (!title || title.kind === 'movie') fail(404, 'Series not found');
    if (!Number.isSafeInteger(season) || season < 0) fail(400, 'Invalid season');
    const items = store
      .items(titleId)
      .filter((item) => item.season === season && store.canReadItem(user, item.id));
    if (!items.length) fail(404, 'Season not found');
    return items;
  }
  function existing(user, item) {
    if (store.available(user, item.id)) return 'downloaded';
    if (store.one(`SELECT id FROM jobs WHERE item_id=? AND ${unfinished}`, item.id))
      return 'already_queued';
    const releaseDate = Date.parse(item.released);
    if (Number.isFinite(releaseDate) && releaseDate > Date.now()) return 'unreleased';
    return 'pending';
  }
  function options(user, titleId, season) {
    const items = itemsFor(user, titleId, season).map((item) => ({
      id: item.id,
      episode: item.episode,
      state: existing(user, item),
    }));
    return {
      items,
      torrentConfigured: !!config.qbitUrl,
      debridConfigured: !!config.debridToken,
      resolutions: [requiredResolution(store.title(titleId).kind)],
      active:
        store.unpack(
          store.one(
            "SELECT * FROM season_downloads WHERE user_id=? AND title_id=? AND season=? AND state IN ('queued','finding')",
            user.id,
            titleId,
            season,
          ),
        )?.id || null,
    };
  }
  function create(user, titleId, season, input) {
    const preview = options(user, titleId, season);
    if (preview.active) return get(preview.active);
    if (!['torrent', 'realdebrid'].includes(input.provider))
      fail(400, 'Choose a download provider');
    if (input.provider === 'torrent' ? !config.qbitUrl : !config.debridToken)
      fail(503, 'The selected download provider is not configured');
    if (!preview.resolutions.includes(input.resolution)) fail(400, 'Choose an allowed quality');
    if (!preview.items.some((item) => item.state === 'pending'))
      fail(409, 'No episodes need downloading');
    return save({
      id: id(),
      user_id: user.id,
      title_id: titleId,
      season,
      state: 'queued',
      provider: input.provider,
      resolution: input.resolution,
      created: Date.now(),
      items: preview.items,
    });
  }
  async function step(batch) {
    const entry = batch.items.find((item) => item.state === 'pending');
    if (!entry) return save({ ...batch, state: 'finished' });
    const user = store.one('SELECT * FROM users WHERE id=?', batch.user_id);
    if (!allowed(user))
      return save({ ...batch, state: 'stopped', error: 'Download permission was revoked' });
    const item = store.item(entry.id);
    const update = (patch) => {
      const current = get(batch.id);
      if (!current || !pendingStates.includes(current.state)) return;
      const items = current.items.map((row) => (row.id === entry.id ? { ...row, ...patch } : row));
      save({
        ...current,
        items,
        state: items.some((row) => row.state === 'pending') ? 'finding' : 'finished',
      });
    };
    if (!item || !store.canReadItem(user, item.id))
      return update({ state: 'unavailable', error: 'Episode is no longer accessible' });
    const state = existing(user, item);
    if (state !== 'pending') return update({ state });
    save({ ...batch, state: 'finding' });
    try {
      const releases = await catalog.releases(item.id);
      const rules = policy.get();
      const candidates = releases
        .filter(
          (release) =>
            release.resolution === batch.resolution &&
            /^[a-f0-9]{40}$/i.test(release.hash || '') &&
            assessRelease(
              release,
              store.title(item.title_id).kind,
              batch.provider === 'torrent'
                ? rules
                : { ...rules, minSeeders: 0, rejectUnknown: false },
            ).accepted,
        )
        .sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
      if (closing || !pendingStates.includes(get(batch.id)?.state)) return;
      const currentUser = store.one('SELECT * FROM users WHERE id=?', batch.user_id);
      if (!allowed(currentUser) || !store.canReadItem(currentUser, item.id))
        return update({ state: 'unavailable', error: 'Download permission was revoked' });
      const latestState = existing(currentUser, item);
      if (latestState !== 'pending') return update({ state: latestState });
      let lastError;
      for (const release of candidates) {
        // qBittorrent owns one job per hash. Do not repurpose a running pack or
        // silently select a different file from an existing user's torrent.
        if (
          batch.provider === 'torrent' &&
          store.one(
            "SELECT id FROM jobs WHERE json_extract(json,'$.provider')='torrent' AND lower(json_extract(json,'$.hash'))=? AND state NOT IN ('failed','cancelled','evicted')",
            release.hash.toLowerCase(),
          )
        ) {
          lastError =
            'Matching torrents are already managed for another episode. Choose a separate episode release or use Real-Debrid.';
          continue;
        }
        try {
          if (closing || !pendingStates.includes(get(batch.id)?.state)) return;
          const job = await (batch.provider === 'torrent' ? torrents : downloads).enqueue(
            currentUser,
            item.id,
            release,
          );
          update({ state: 'queued', jobId: job.id });
          return;
        } catch (error) {
          if (error.status !== 409) throw error;
          lastError = error.message;
        }
      }
      update({
        state: 'unavailable',
        error: lastError || `No ${batch.resolution}p release meets the download rules`,
      });
    } catch (error) {
      update({
        state: 'unavailable',
        error: String(error.message)
          .replace(/https?:\/\/\S+/g, '[provider]')
          .slice(0, 300),
      });
    }
  }
  function tick() {
    if (task || closing) return task || Promise.resolve();
    const batch = store.unpack(
      store.one(
        "SELECT * FROM season_downloads WHERE state IN ('queued','finding') ORDER BY updated LIMIT 1",
      ),
    );
    if (!batch) return Promise.resolve();
    task = step(batch).finally(() => {
      task = null;
    });
    return task;
  }
  const list = (user) =>
    store
      .all(
        'SELECT * FROM season_downloads WHERE user_id=? OR ? ORDER BY updated DESC LIMIT 50',
        user.id,
        +(user.role === 'admin'),
      )
      .map(store.unpack)
      .map((batch) => ({ ...batch, name: store.title(batch.title_id)?.name || 'Series' }));
  return {
    options,
    create,
    list,
    tick,
    stop(user, key) {
      const batch = get(key);
      if (!batch || (batch.user_id !== user.id && user.role !== 'admin'))
        fail(404, 'Season download not found');
      if (!pendingStates.includes(batch.state)) fail(409, 'Season queueing has already finished');
      return save({ ...batch, state: 'stopped' });
    },
    start() {
      timer = setInterval(() => {
        void tick().catch(() => {});
      }, 1000);
      timer.unref();
      void tick().catch(() => {});
    },
    async close() {
      closing = true;
      clearInterval(timer);
      await task;
    },
  };
}
