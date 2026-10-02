import express from 'express';
import { createWatchTogetherStore, WatchTogetherError } from './watch-together.mjs';

// Account throttles permit regular polling from several devices, while bounding
// invite guessing, room creation and rapid control requests independently.
// Entries expire lazily and the map has a hard ceiling, unlike an IP-only map.
export function createWatchTogetherLimiter({
  now = Date.now, windowMs = 60_000, maxEntries = 2_000,
  membershipMax = 20, readMax = 900, stateMax = 900,
} = {}) {
  const buckets = new Map();
  return (kind) => (req, res, next) => {
    const timestamp = now();
    const identity = String(req.user?.id ?? '');
    const key = `${kind}:${identity}`;
    let bucket = buckets.get(key);
    if (!bucket || timestamp - bucket.startedAt >= windowMs) {
      for (const [currentKey, current] of buckets) {
        if (timestamp - current.startedAt >= windowMs) buckets.delete(currentKey);
      }
      if (!buckets.has(key) && buckets.size >= maxEntries) {
        res.setHeader('Retry-After', Math.ceil(windowMs / 1_000));
        return res.status(429).json({ error: 'Watch rooms are busy. Try again shortly.' });
      }
      bucket = { startedAt: timestamp, count: 0 };
      buckets.set(key, bucket);
    }
    const limit = kind === 'membership' ? membershipMax : kind === 'state' ? stateMax : readMax;
    if (bucket.count >= limit) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.startedAt + windowMs - timestamp) / 1_000)));
      return res.status(429).json({ error: 'Too many watch room requests. Try again shortly.' });
    }
    bucket.count++;
    next();
  };
}

export function mountWatchTogetherRoutes(app, {
  requireAuth,
  store = createWatchTogetherStore(),
  limiter = createWatchTogetherLimiter(),
} = {}) {
  if (typeof requireAuth !== 'function') throw new TypeError('Watch rooms require authentication middleware.');
  const router = express.Router();
  router.use(requireAuth);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use((req, res, next) => {
    // All room mutations use JSON. Requiring its non-simple content type also
    // keeps create/join from being triggered by a cross-origin HTML form.
    if (req.method === 'POST' && req.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return res.status(415).json({ error: 'Watch room requests must use JSON.' });
    }
    next();
  });
  router.use(express.json({ limit: '4kb' }));
  const wrap = fn => (req, res, next) => {
    try { fn(req, res); }
    catch (error) {
      if (error instanceof WatchTogetherError) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  };
  const token = req => req.get('X-Watch-Member');
  router.post('/', limiter('membership'), wrap((req, res) => {
    res.status(201).json(store.create(req.user, req.body?.media, req.body?.state));
  }));
  router.post('/:code/join', limiter('membership'), wrap((req, res) => {
    res.json(store.join(req.params.code, req.user));
  }));
  router.get('/:code', limiter('read'), wrap((req, res) => {
    res.json(store.read(req.params.code, token(req), req.user));
  }));
  router.post('/:code/state', limiter('state'), wrap((req, res) => {
    res.json(store.update(req.params.code, token(req), req.user, req.body?.state, req.body?.media));
  }));
  router.post('/:code/leave', limiter('read'), wrap((req, res) => {
    res.json(store.leave(req.params.code, token(req), req.user));
  }));
  router.use((error, _req, res, next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'The watch room request contains invalid JSON.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'The watch room request is too large.' });
    next(error);
  });
  app.use('/api/watch-together', router);
  return store;
}
