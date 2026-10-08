import path from 'node:path';
import { mkdir, stat, lstat, statfs, realpath, unlink } from 'node:fs/promises';
import { fail } from './store.mjs';
import { createQbitClient } from './qbittorrent.mjs';

const shared = new WeakMap();
const terminal = new Set(['ready', 'evicted', 'failed', 'cancelled']);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return (
    relative &&
    !relative.startsWith('..' + path.sep) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
};

// Both download engines must share the lock and reservations for a store.
export function getStorage(store, config) {
  if (!shared.has(store)) shared.set(store, createStorage(store, config));
  return shared.get(store);
}

export function createStorage(
  store,
  config,
  { client = createQbitClient(config), statfsImpl = statfs, now = Date.now } = {},
) {
  let chain = Promise.resolve();
  const reservations = new Map();
  const jobs = () => store.all('SELECT * FROM jobs').map(store.unpack);
  const rootFor = (job) => (job.provider === 'torrent' ? config.torrentDir : config.media);
  const titleFor = (itemId) => store.item(itemId)?.title_id;

  function protectedTitle(titleId, incoming) {
    return (
      titleId === titleFor(incoming.item_id) ||
      store.isTitleInUse(titleId) ||
      !!store.one(
        `SELECT 1 FROM tags WHERE title_id=? AND tag='favorite'
       UNION ALL SELECT 1 FROM jobs j JOIN items i ON i.id=j.item_id
         WHERE i.title_id=? AND j.state NOT IN ('ready','evicted','failed','cancelled')
       UNION ALL SELECT 1 FROM playback p JOIN items i ON i.id=p.item_id
         JOIN history h ON h.user_id=p.user_id AND h.item_id=p.item_id AND h.session_id=p.id
         WHERE i.title_id=? AND p.stopped=0 AND MAX(p.touched,p.started)>? LIMIT 1`,
        titleId,
        titleId,
        titleId,
        now() - 120000,
      )
    );
  }

  async function ownedAsset(asset, device) {
    if (!asset || asset.imported === true) return null;
    const owners = jobs().filter((j) => j.item_id === asset.item_id && j.state === 'ready');
    for (const root of [config.media, config.torrentDir].filter(Boolean)) {
      const absoluteRoot = path.resolve(root),
        absoluteFile = path.resolve(asset.path);
      if (!inside(absoluteRoot, absoluteFile)) continue;
      try {
        const canonicalRoot = await realpath(absoluteRoot);
        const canonicalFile = await realpath(absoluteFile);
        const details = await lstat(absoluteFile);
        if (
          !inside(canonicalRoot, canonicalFile) ||
          !details.isFile() ||
          details.nlink !== 1 ||
          details.dev !== device
        )
          continue;
        const owner = owners.find((j) =>
          j.provider === 'torrent'
            ? inside(path.resolve(config.torrentDir, j.id), absoluteFile)
            : absoluteFile === path.resolve(config.media, `${j.id}${path.extname(absoluteFile)}`),
        );
        // Older v2 downloads have no managed flag; require their completed job and exact path.
        if (!owner && asset.managed !== true && asset.imported !== false) continue;
        if (owner?.provider === 'torrent') {
          const jobRoot = await realpath(path.resolve(config.torrentDir, owner.id));
          if (!inside(jobRoot, canonicalFile)) continue;
        } else if (inside(path.resolve(config.torrentDir), absoluteFile) && !owner) {
          // Never unlink a file that might still be controlled by a torrent engine.
          continue;
        }
        return { ...asset, bytes: details.size, owner };
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      }
    }
    return null;
  }

  async function candidates(device, incoming, skipped) {
    const ranked = store.all(
      `SELECT t.id, COALESCE((SELECT MAX(h.played_at) FROM history h
         JOIN items hi ON hi.id=h.item_id WHERE hi.title_id=t.id),0) AS last_played,
         MIN(a.added_at) AS added
       FROM titles t JOIN items i ON i.title_id=t.id JOIN assets a ON a.item_id=i.id
       GROUP BY t.id ORDER BY last_played ASC, added ASC, t.id ASC`,
    );
    const result = [];
    for (const title of ranked) {
      if (skipped.has(title.id) || protectedTitle(title.id, incoming)) continue;
      const assets = [];
      for (const row of store.all(
        'SELECT a.* FROM assets a JOIN items i ON i.id=a.item_id WHERE i.title_id=?',
        title.id,
      )) {
        const asset = await ownedAsset(store.unpack(row), device);
        if (asset) assets.push(asset);
      }
      if (assets.length) result.push({ ...title, assets });
    }
    return result;
  }

  async function detach(owner) {
    if (owner?.provider !== 'torrent') return;
    const info = await client.info(owner.hash);
    if (!info) return;
    const expected = `${config.qbitSavePath.replace(/\/$/, '')}/${owner.id}`.replace(/\\/g, '/');
    if (
      info.category !== 'mediawan' ||
      info.save_path.replace(/\\/g, '/').replace(/\/$/, '') !== expected
    )
      fail(409, 'Torrent ownership changed; its files were left untouched');
    // Detach without recursive deletion; only verified library files are unlinked below.
    await client.call('torrents/delete', { hashes: owner.hash, deleteFiles: 'false' });
    for (let n = 0; n < 20; n++) {
      if (!(await client.info(owner.hash))) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    fail(503, 'Waiting for qBittorrent to release its files');
  }

  async function ensure({ directory, bytes, job, signal }) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) fail(400, 'Invalid storage requirement');
    await mkdir(directory, { recursive: true });
    const device = (await stat(directory)).dev;
    const checkRequest = () => {
      signal?.throwIfAborted();
      const current = store.job(job.id);
      if (!current || terminal.has(current.state) || current.state === 'paused')
        fail(409, 'Download is no longer active');
    };
    async function headroom() {
      const disk = await statfsImpl(directory);
      let reserved = 0;
      for (const other of jobs()) {
        if (other.id === job.id || terminal.has(other.state) || other.state === 'paused') continue;
        const reservation = reservations.get(other.id);
        if (
          !reservation &&
          !['checking', 'preparing', 'downloading', 'verifying', 'stopping'].includes(other.state)
        )
          continue;
        let otherDevice = reservation?.device;
        if (otherDevice == null) {
          try {
            otherDevice = (await stat(rootFor(other))).dev;
          } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
          }
        }
        if (otherDevice === device)
          reserved += Math.max(0, (reservation?.total ?? other.total ?? 0) - (other.bytes || 0));
      }
      return disk.bavail * disk.bsize - config.reserveBytes - reserved;
    }
    checkRequest();
    const skipped = new Set();
    while ((await headroom()) < bytes) {
      checkRequest();
      const eligible = await candidates(device, job, skipped);
      const available = await headroom();
      if (available >= bytes) break;
      // Avoid deleting a library when even all eligible files cannot satisfy this request.
      if (
        available + eligible.flatMap((t) => t.assets).reduce((sum, a) => sum + a.bytes, 0) <
        bytes
      )
        fail(507, 'Not enough free storage; protected or imported media cannot be removed');
      const title = eligible[0];
      if (!title) fail(507, 'Not enough free storage to download this file');
      checkRequest();
      if (protectedTitle(title.id, job)) continue;
      store.evictingTitles.add(title.id);
      try {
        for (const asset of title.assets) {
          checkRequest();
          if (protectedTitle(title.id, job)) break;
          await detach(asset.owner);
          const verified = await ownedAsset(store.asset(asset.id), device);
          if (!verified || protectedTitle(title.id, job)) continue;
          checkRequest();
          await unlink(verified.path);
          store.transaction(() => {
            store.run('DELETE FROM assets WHERE id=?', verified.id);
            if (verified.owner)
              store.saveJob({
                ...store.job(verified.owner.id),
                state: 'evicted',
                removedAt: now(),
                retryable: false,
                error: null,
              });
          });
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        // Locked files or an unavailable torrent engine must not cause unrelated files to be deleted blindly.
        skipped.add(title.id);
      } finally {
        store.evictingTitles.delete(title.id);
      }
    }
    checkRequest();
    for (const key of reservations.keys())
      if (terminal.has(store.job(key)?.state)) reservations.delete(key);
    reservations.set(job.id, { device, total: bytes + (job.bytes || 0) });
  }

  return {
    ensure(input) {
      const task = chain.then(() => ensure(input));
      chain = task.catch(() => {});
      return task;
    },
  };
}
