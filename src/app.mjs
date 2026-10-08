import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath, stat } from 'node:fs/promises';
import { createStore, fail, id } from './store.mjs';
import { setupAuth, hashPassword } from './auth.mjs';
import { createHistory } from './history.mjs';
import { createNavigation } from './navigation.mjs';
import { createQueues } from './queues.mjs';
import { createCatalog } from './catalog.mjs';
import { createDownloads } from './downloads.mjs';
import { createTorrentPolicy, assessRelease } from './torrent-policy.mjs';
import { createTorrentDownloads } from './torrent-downloads.mjs';
import { createMedia, probe } from './media.mjs';
import { createSeasonDownloads } from './season-downloads.mjs';

const publicPath = fileURLToPath(new URL('../public/', import.meta.url));
const wrap = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res))
    .catch(next);
export function createApplication(config, dependencies = {}) {
  const store = dependencies.store || createStore(config.database),
    app = express();
  const history = createHistory(store),
    navigation = createNavigation(store),
    queues = createQueues(store);
  const catalog = dependencies.catalog || createCatalog(store, config),
    downloads = dependencies.downloads || createDownloads(store, config),
    media = createMedia(store, config);
  const torrentPolicy = createTorrentPolicy(store);
  const torrents = dependencies.torrents || createTorrentDownloads(store, config, torrentPolicy);
  const seasons = createSeasonDownloads(store, config, catalog, downloads, torrents, torrentPolicy);
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers['sec-fetch-site'] === 'cross-site')
        return res.status(403).json({ error: 'Cross-site requests are not allowed' });
      if (req.headers.origin) {
        try {
          if (new URL(req.headers.origin).host !== req.get('host'))
            return res.status(403).json({ error: 'Origin does not match' });
        } catch {
          return res.status(403).json({ error: 'Invalid origin' });
        }
      }
      if (!req.is('application/json'))
        return res.status(415).json({ error: 'Use JSON for this action' });
    }
    next();
  });
  app.use(express.json({ limit: '128kb' }));
  app.get('/healthz', (req, res) =>
    res.json({ ok: true, version: '2.0.0', revision: process.env.APP_REVISION || 'local' }),
  );
  setupAuth(app, store, config);
  const admin = (req) => {
    if (req.user.role !== 'admin') fail(403, 'Administrator access required');
  };
  const titleFor = (req) => {
    const title = navigation.detail(req.user, req.params.id);
    if (!title) fail(404, 'Title not found');
    return title;
  };
  app.get(
    '/api/home',
    wrap((req, res) => res.json(navigation.home(req.user))),
  );
  app.get(
    '/api/library',
    wrap((req, res) => {
      const titles = navigation.list(req.user, req.query),
        offset = Math.max(0, Number(req.query.offset) || 0);
      res.json({ total: titles.length, items: titles.slice(offset, offset + 48), offset });
    }),
  );
  app.get(
    '/api/titles/:id',
    wrap(async (req, res) => {
      titleFor(req);
      await catalog.refresh?.(req.params.id);
      res.json(titleFor(req));
    }),
  );
  app.post(
    '/api/titles/:id/refresh',
    wrap(async (req, res) => {
      titleFor(req);
      await catalog.refresh?.(req.params.id, true);
      res.json(titleFor(req));
    }),
  );
  app.post(
    '/api/titles/:id/tags',
    wrap((req, res) => {
      titleFor(req);
      const { tag, active } = req.body;
      if (!['favorite', 'watchlist'].includes(tag) || typeof active !== 'boolean')
        fail(400, 'Invalid list action');
      if (active)
        store.run('INSERT OR IGNORE INTO tags VALUES(?,?,?)', req.user.id, req.params.id, tag);
      else
        store.run(
          'DELETE FROM tags WHERE user_id=? AND title_id=? AND tag=?',
          req.user.id,
          req.params.id,
          tag,
        );
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/titles/:id/dismiss',
    wrap((req, res) => {
      titleFor(req);
      history.dismiss(req.user, req.params.id, req.body.hidden);
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/watched',
    wrap((req, res) => res.json(history.watched(req.user, req.body.items, req.body.watched))),
  );
  app.post(
    '/api/watched/undo',
    wrap((req, res) => res.json(history.undo(req.user, req.body.token))),
  );
  app.post(
    '/api/playback',
    wrap((req, res) => {
      const { itemId, replay, queueId } = req.body;
      let mode = 'sequential';
      if (queueId) {
        const queue = queues.get(req.user, queueId);
        if (queue.items[queue.index] !== itemId) fail(409, 'Queue position changed');
        mode = queue.mode;
      }
      res.status(201).json(history.start(req.user, itemId, { replay: replay === true, mode }));
    }),
  );
  app.post(
    '/api/playback/:id/events',
    wrap((req, res) => res.json(history.event(req.user, req.params.id, req.body))),
  );
  app.get(
    '/api/queues',
    wrap((req, res) => res.json(queues.list(req.user))),
  );
  app.post(
    '/api/queues',
    wrap((req, res) => res.status(201).json(queues.create(req.user, req.body))),
  );
  app.get(
    '/api/queues/:id',
    wrap((req, res) => {
      const queue = queues.get(req.user, req.params.id);
      res.json({
        ...queue,
        entries: queue.items.map((key) => {
          const item = store.item(key);
          return item && store.canReadItem(req.user, key)
            ? {
                ...item,
                title: store.title(item.title_id).name,
                available: !!store.available(req.user, key),
              }
            : { id: key, name: 'Unavailable', available: false };
        }),
      });
    }),
  );
  app.patch(
    '/api/queues/:id',
    wrap((req, res) => res.json(queues.edit(req.user, req.params.id, req.body))),
  );
  app.post(
    '/api/queues/:id/fork',
    wrap((req, res) => res.status(201).json(queues.fork(req.user, req.params.id))),
  );
  app.get(
    '/api/preferences',
    wrap((req, res) => res.json(store.prefs(req.user.id))),
  );
  app.patch(
    '/api/preferences',
    wrap((req, res) => {
      const input = req.body;
      if (
        typeof input.autoplay !== 'boolean' ||
        !['off', 'preferred'].includes(input.subtitleMode) ||
        typeof input.audioLanguage !== 'string' ||
        input.audioLanguage.length > 20 ||
        typeof input.subtitleLanguage !== 'string' ||
        input.subtitleLanguage.length > 20
      )
        fail(400, 'Invalid preferences');
      const next = {
        autoplay: input.autoplay,
        subtitleMode: input.subtitleMode,
        audioLanguage: input.audioLanguage,
        subtitleLanguage: input.subtitleLanguage,
      };
      store.run(
        'INSERT INTO preferences VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json',
        req.user.id,
        JSON.stringify(next),
      );
      res.json(next);
    }),
  );
  app.get(
    '/api/collections',
    wrap((req, res) =>
      res.json(
        store
          .all('SELECT * FROM collections WHERE user_id=? ORDER BY name', req.user.id)
          .map(store.unpack),
      ),
    ),
  );
  app.post(
    '/api/collections',
    wrap((req, res) => {
      const name = String(req.body.name || '').trim();
      if (!name || name.length > 100) fail(400, 'Enter a collection name');
      const collection = { id: id(), user_id: req.user.id, name, items: [] };
      store.run(
        'INSERT INTO collections VALUES(?,?,?,?)',
        collection.id,
        req.user.id,
        name,
        JSON.stringify(collection),
      );
      res.status(201).json(collection);
    }),
  );
  app.patch(
    '/api/collections/:id',
    wrap((req, res) => {
      const old = store.unpack(
        store.one('SELECT * FROM collections WHERE id=? AND user_id=?', req.params.id, req.user.id),
      );
      if (!old) fail(404, 'Collection not found');
      const items = req.body.items;
      if (
        !Array.isArray(items) ||
        items.length > 1000 ||
        items.some((key) => !navigation.detail(req.user, key))
      )
        fail(400, 'Invalid collection titles');
      store.run(
        'UPDATE collections SET json=? WHERE id=?',
        JSON.stringify({ ...old, items: [...new Set(items)] }),
        old.id,
      );
      res.json({ ok: true });
    }),
  );
  app.delete(
    '/api/collections/:id',
    wrap((req, res) => {
      store.run('DELETE FROM collections WHERE id=? AND user_id=?', req.params.id, req.user.id);
      res.json({ ok: true });
    }),
  );
  app.get(
    '/api/discover',
    wrap(async (req, res) =>
      res.json({ items: await catalog.search(req.query.kind || 'movie', req.query.q || '') }),
    ),
  );
  app.post(
    '/api/discover',
    wrap(async (req, res) => res.json(await catalog.add(req.body.kind, req.body.externalId))),
  );
  app.get(
    '/api/items/:id/releases',
    wrap(async (req, res) => {
      if (!store.canReadItem(req.user, req.params.id)) fail(404, 'Media not found');
      const rules = torrentPolicy.get();
      const kind = store.title(store.item(req.params.id).title_id).kind;
      res.json({
        items: (await catalog.releases(req.params.id)).map((r) => ({
          ...r,
          ...assessRelease(r, kind, rules),
        })),
        rules,
        torrentConfigured: !!config.qbitUrl,
        debridConfigured: !!config.debridToken,
      });
    }),
  );
  app.post(
    '/api/items/:id/download',
    wrap(async (req, res) => {
      if (!store.canReadItem(req.user, req.params.id)) fail(404, 'Media not found');
      if (req.body.provider === 'torrent') {
        // Re-resolve source facts on the server. Client-supplied seeder/size claims cannot bypass rules.
        const release = (await catalog.releases(req.params.id)).find(
          (r) => r.hash === req.body.hash && r.fileIndex === req.body.fileIndex,
        );
        if (!release) fail(400, 'Release is no longer in the search results. Refresh the list.');
        const job = await torrents.enqueue(req.user, req.params.id, release);
        res.status(202).json({ id: job.id });
      } else if (!req.body.provider || req.body.provider === 'realdebrid') {
        res.status(202).json({ id: downloads.enqueue(req.user, req.params.id, req.body).id });
      } else fail(400, 'Unknown download provider');
    }),
  );
  app.get(
    '/api/downloads',
    wrap((req, res) => res.json(downloads.list(req.user))),
  );
  app.get(
    '/api/titles/:id/seasons/:season/downloads',
    wrap((req, res) =>
      res.json(seasons.options(req.user, req.params.id, Number(req.params.season))),
    ),
  );
  app.post(
    '/api/titles/:id/seasons/:season/downloads',
    wrap((req, res) =>
      res
        .status(202)
        .json(seasons.create(req.user, req.params.id, Number(req.params.season), req.body)),
    ),
  );
  app.get(
    '/api/season-downloads',
    wrap((req, res) => res.json(seasons.list(req.user))),
  );
  app.post(
    '/api/season-downloads/:id/stop',
    wrap((req, res) => res.json(seasons.stop(req.user, req.params.id))),
  );
  app.post(
    '/api/downloads/:id',
    wrap(async (req, res) => {
      const engine = store.job(req.params.id)?.provider === 'torrent' ? torrents : downloads;
      await engine.action(req.user, req.params.id, req.body.action);
      res.json({ ok: true });
    }),
  );
  app.use('/api/items/:id', (req, res, next) => {
    if (!['/media', '/file', '/convert'].includes(req.path) && !req.path.startsWith('/subtitles/'))
      return next();
    try {
      const release = store.retainItem(req.params.id);
      res.once('finish', release);
      res.once('close', release);
      next();
    } catch (error) {
      next(error);
    }
  });
  app.get(
    '/api/items/:id/media',
    wrap(async (req, res) => res.json(await media.info(req.user, req.params.id))),
  );
  app.get(
    '/api/items/:id/file',
    wrap((req, res) => res.sendFile(media.file(req.user, req.params.id))),
  );
  app.get(
    '/api/items/:id/subtitles/:index',
    wrap(async (req, res) =>
      res
        .type('text/vtt')
        .send(
          await media.subtitles(
            req.user,
            req.params.id,
            Number(req.params.index),
            Number(req.query.offset || 0),
          ),
        ),
    ),
  );
  app.post(
    '/api/items/:id/convert',
    wrap(async (req, res) => res.json(await media.start(req.user, req.params.id, req.body))),
  );
  app.get(
    '/api/media/sessions/:id/:file',
    wrap((req, res) => res.sendFile(media.segment(req.user, req.params.id, req.params.file))),
  );
  app.delete(
    '/api/media/sessions/:id',
    wrap(async (req, res) => {
      await media.stop(req.user, req.params.id);
      res.json({ ok: true });
    }),
  );
  app.get(
    '/api/admin',
    wrap((req, res) => {
      admin(req);
      res.json({
        debridConfigured: !!config.debridToken,
        torrentConfigured: !!config.qbitUrl,
        torrentRules: torrentPolicy.get(),
        users: store.all('SELECT id,email,name,role,active,can_download FROM users'),
        importRoots: config.importRoots,
      });
    }),
  );
  app.put(
    '/api/admin/torrent-rules',
    wrap((req, res) => {
      admin(req);
      res.json(torrentPolicy.set(req.body));
    }),
  );
  app.get(
    '/api/admin/torrent-health',
    wrap(async (req, res) => {
      admin(req);
      res.json(await torrents.health());
    }),
  );
  app.post(
    '/api/admin/users',
    wrap((req, res) => {
      admin(req);
      const { email, name, password, canDownload } = req.body;
      if (
        typeof email !== 'string' ||
        !email.includes('@') ||
        email.length > 254 ||
        typeof password !== 'string' ||
        password.length < 10 ||
        password.length > 256 ||
        typeof name !== 'string' ||
        !name.trim() ||
        name.length > 100
      )
        fail(400, 'Use a valid email, name and a password of at least 10 characters');
      store.run(
        'INSERT INTO users(email,name,pw_hash,can_download) VALUES(?,?,?,?)',
        email.toLowerCase(),
        name,
        hashPassword(password),
        canDownload === true ? 1 : 0,
      );
      res.json({ ok: true });
    }),
  );
  app.patch(
    '/api/admin/users/:id',
    wrap((req, res) => {
      admin(req);
      const user = store.one('SELECT * FROM users WHERE id=?', Number(req.params.id));
      if (!user || user.id === req.user.id) fail(400, 'Cannot change your own account here');
      if (typeof req.body.active !== 'boolean' || typeof req.body.canDownload !== 'boolean')
        fail(400, 'Invalid account settings');
      store.run(
        'UPDATE users SET active=?,can_download=? WHERE id=?',
        +req.body.active,
        +req.body.canDownload,
        user.id,
      );
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/admin/import',
    wrap(async (req, res) => {
      admin(req);
      const item = store.item(req.body.itemId);
      if (!item) fail(404, 'Choose a title and episode first');
      const file = await realpath(String(req.body.path || ''));
      const roots = await Promise.all(config.importRoots.map((root) => realpath(root)));
      if (!roots.some((root) => file.startsWith(root + path.sep)))
        fail(403, 'File must be inside a configured IMPORT_ROOTS folder');
      const stats = await stat(file);
      if (!stats.isFile()) fail(400, 'Choose a media file');
      const metadata = await probe(file, config);
      store.addAsset({
        item_id: item.id,
        path: file,
        bytes: stats.size,
        probe: metadata,
        imported: true,
      });
      res.json({ ok: true });
    }),
  );
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found' }));
  app.use(express.static(publicPath, { index: false, maxAge: 0 }));
  app.get('*', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    res.status(status).json({
      error:
        status === 500 ? 'The operation failed. Check the server configuration.' : error.message,
    });
    if (status === 500) console.error('Request failed:', error.code || error.name);
  });
  return {
    app,
    store,
    history,
    navigation,
    queues,
    downloads,
    media,
    seasons,
    start() {
      downloads.start();
      torrents.start();
      seasons.start();
    },
    async close() {
      await seasons.close();
      await downloads.close();
      await torrents.close();
      await media.close();
      store.close();
    },
  };
}
