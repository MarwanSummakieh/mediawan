import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseM3u, providerIdentity, providerUrl } from './catalog.mjs';
import { parseXmltv, matchGuide } from './guide.mjs';
import { dailyEvents, validateEvent, SPORTS } from './events.mjs';
import { fetchLiveResource } from './fetch.mjs';
import { fail, id } from '../store.mjs';

export function createLiveStore(store, config, { fetchResource = fetchLiveResource } = {}) {
  const directory = config.liveDir || path.join(path.dirname(config.database), 'live-tv');
  let state = {
    channels: [],
    name: 'Live TV',
    maxConnections: 1,
    guideUrl: null,
    guideUpdatedAt: null,
    guideStatus: 'missing',
  };
  let guide = { channels: [], programmes: [] },
    matches = new Map(),
    loaded,
    refreshing,
    mutation = Promise.resolve();
  const serial = (fn) => {
    const task = mutation.then(fn);
    mutation = task.catch(() => {});
    return task;
  };
  const atomic = async (name, value) => {
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, name),
      temp = `${file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temp, file);
  };
  async function load() {
    if (!loaded)
      loaded = (async () => {
        try {
          state = {
            ...state,
            ...JSON.parse(await fs.readFile(path.join(directory, 'catalog.json'), 'utf8')),
          };
        } catch (e) {
          if (e.code !== 'ENOENT') throw Error('Live TV configuration could not be read');
        }
        try {
          guide = JSON.parse(await fs.readFile(path.join(directory, 'guide.json'), 'utf8'));
        } catch (e) {
          if (e.code !== 'ENOENT') state.guideStatus = 'unavailable';
        }
        matches = matchGuide(state.channels, guide);
      })().catch((e) => {
        loaded = null;
        throw e;
      });
    return loaded;
  }
  const manual = () =>
    JSON.parse(store.one("SELECT json FROM settings WHERE key='sports-events'")?.json || '[]');
  const saveManual = (events) =>
    store.run(
      "INSERT INTO settings VALUES('sports-events',?) ON CONFLICT(key) DO UPDATE SET json=excluded.json",
      JSON.stringify(events),
    );
  function status() {
    return {
      channels: state.channels.length,
      guideConfigured: !!state.guideUrl,
      guideStatus: refreshing ? 'refreshing' : state.guideStatus,
      guideUpdatedAt: state.guideUpdatedAt,
      maxConnections: Math.max(1, Math.min(4, Number(state.maxConnections) || 1)),
      sports: SPORTS,
    };
  }
  async function refresh() {
    await load();
    if (refreshing) {
      await refreshing;
      if (state.guideStatus === 'missing' && state.guideUrl) return refresh();
      return status();
    }
    if (!state.guideUrl) return status();
    const url = state.guideUrl,
      importedAt = state.importedAt;
    refreshing = (async () => {
      try {
        const { bytes } = await fetchResource(url);
        const xml =
          bytes[0] === 0x1f && bytes[1] === 0x8b
            ? gunzipSync(bytes, { maxOutputLength: 120 * 1024 * 1024 })
            : bytes;
        const next = parseXmltv(xml.toString('utf8'));
        await serial(async () => {
          if (state.guideUrl !== url || state.importedAt !== importedAt) return;
          await atomic('guide.json', next);
          guide = next;
          matches = matchGuide(state.channels, guide);
          state.guideStatus = 'ready';
          state.guideUpdatedAt = new Date().toISOString();
          await atomic('catalog.json', state);
        });
      } catch {
        await serial(async () => {
          if (state.guideUrl !== url || state.importedAt !== importedAt) return;
          state.guideStatus = state.guideUpdatedAt ? 'stale' : 'unavailable';
          await atomic('catalog.json', state);
        });
      }
    })();
    try {
      await refreshing;
    } finally {
      refreshing = null;
    }
    return status();
  }
  return {
    load,
    status,
    refresh,
    channel(key) {
      return state.channels.find((c) => c.id === key);
    },
    async schedule(query) {
      await load();
      const timezone = query.timezone || 'UTC',
        date = query.date || new Date().toISOString().slice(0, 10);
      const events = dailyEvents(state.channels, matches, manual(), { date, timezone });
      return { ...status(), date, timezone, events };
    },
    async channels() {
      await load();
      return state.channels.map(({ id, name, language, quality }) => ({
        id,
        name,
        language,
        quality,
      }));
    },
    async importPlaylist(text, options = {}) {
      await load();
      let parsed;
      try {
        parsed = parseM3u(text);
      } catch (e) {
        fail(400, e.message);
      }
      const identity = providerIdentity(parsed.channels);
      const guideUrl =
        options.guideUrl ||
        parsed.guideUrl ||
        (identity ? providerUrl(identity, '/xmltv.php') : null);
      if (guideUrl && !/^https?:\/\//i.test(guideUrl))
        fail(400, 'Guide URL must use HTTP or HTTPS');
      await serial(async () => {
        const next = {
          ...state,
          ...parsed,
          guideUrl,
          maxConnections: 1,
          importedAt: id(),
          guideStatus: 'missing',
          guideUpdatedAt: null,
        };
        // Retain corrected mappings when reimporting the same stream URLs.
        next.channels = parsed.channels.map((c) => {
          const old = state.channels.find((x) => x.id === c.id);
          return old ? { ...c, guideOverride: old.guideOverride } : c;
        });
        await atomic('catalog.json', next);
        state = next;
        guide = { channels: [], programmes: [] };
        matches = new Map();
        await atomic('guide.json', guide);
      });
      return status();
    },
    async settings(input) {
      await load();
      if (
        input.guideUrl !== undefined &&
        (typeof input.guideUrl !== 'string' ||
          input.guideUrl.length > 4096 ||
          (input.guideUrl && !/^https?:\/\//i.test(input.guideUrl)))
      )
        fail(400, 'Use an HTTP or HTTPS guide URL');
      if (
        input.maxConnections !== undefined &&
        (!Number.isInteger(input.maxConnections) ||
          input.maxConnections < 1 ||
          input.maxConnections > 4)
      )
        fail(400, 'Choose between one and four simultaneous channels');
      await serial(async () => {
        if (input.guideUrl !== undefined) {
          state.guideUrl = input.guideUrl || null;
          state.guideStatus = 'missing';
          state.importedAt = id();
        }
        if (input.maxConnections !== undefined) state.maxConnections = input.maxConnections;
        await atomic('catalog.json', state);
      });
      return status();
    },
    async saveEvent(input, key) {
      await load();
      const value = validateEvent(input, state.channels),
        events = manual();
      if (key && !events.some((e) => e.id === key)) fail(404, 'Event not found');
      if (!key && events.length >= 2000) fail(400, 'Remove older events before adding more');
      const event = { ...value, id: key || id() };
      saveManual([...events.filter((e) => e.id !== event.id), event]);
      return event;
    },
    deleteEvent(key) {
      saveManual(manual().filter((e) => e.id !== key));
    },
    start() {
      const timer = setInterval(() => {
        void refresh().catch(() => {});
      }, 4 * 3600000);
      timer.unref();
      this.timer = timer;
      void load()
        .then(() => {
          if (!state.guideUpdatedAt || Date.now() - Date.parse(state.guideUpdatedAt) > 4 * 3600000)
            return refresh();
        })
        .catch(() => {});
    },
    async close() {
      clearInterval(this.timer);
      if (refreshing) await refreshing;
      await mutation;
    },
  };
}
