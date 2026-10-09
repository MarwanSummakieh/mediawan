import path from 'node:path';
import { stat, realpath } from 'node:fs/promises';
import { id, fail } from './store.mjs';
import { probe } from './media.mjs';
import { selectFile } from './downloads.mjs';
import { assessRelease, releaseFacts } from './torrent-policy.mjs';
import { createQbitClient } from './qbittorrent.mjs';
import { getStorage } from './storage.mjs';

export function createTorrentDownloads(
  store,
  config,
  policy,
  {
    client = createQbitClient(config),
    probeFile = probe,
    now = Date.now,
    storage = getStorage(store, config),
  } = {},
) {
  let timer,
    stopping = false,
    busy = false,
    chain = Promise.resolve();
  const serial = (fn) => {
    const task = chain.then(fn);
    chain = task.catch(() => {});
    return task;
  };
  const jobs = () =>
    store
      .all("SELECT * FROM jobs WHERE json_extract(json,'$.provider')='torrent' ORDER BY updated")
      .map(store.unpack);
  const allowed = (user) => user?.active && (user.role === 'admin' || user.can_download);
  const save = (job, patch) => store.saveJob({ ...job, ...patch });
  function owns(info, job) {
    const expected = `${config.qbitSavePath.replace(/\/$/, '')}/${job.id}`;
    if (
      info.category !== 'mediawan' ||
      info.save_path.replace(/\\/g, '/').replace(/\/$/, '') !== expected.replace(/\\/g, '/')
    )
      throw Object.assign(
        new Error('This torrent belongs to another download. It was left unchanged.'),
        { status: 409, ownership: true },
      );
  }
  async function freeSpace(bytes, job) {
    await storage.ensure({ directory: config.torrentDir, bytes, job });
  }
  async function step(job) {
    const user = store.one('SELECT * FROM users WHERE id=?', job.user_id);
    if (!allowed(user) || !store.canReadItem(user, job.item_id))
      fail(403, 'Download permission was revoked');
    let info = await client.info(job.hash);
    if (!info) {
      if (job.submitted) fail(409, 'Torrent was removed from qBittorrent. Retry to add it again.');
      // Persist before sending: reconciliation by hash prevents duplicate submissions after restart.
      job = save(job, { state: 'checking', started: now() });
      const result = await client.call('torrents/add', {
        urls: `magnet:?xt=urn:btih:${job.hash}`,
        category: 'mediawan',
        savepath: `${config.qbitSavePath.replace(/\/$/, '')}/${job.id}`,
        autoTMM: 'false',
        stopCondition: 'MetadataReceived',
        stopped: 'false',
        contentLayout: 'Original',
        upLimit: String(job.rules.uploadKBps * 1024),
        shareLimitAction: 'Stop',
        shareLimitsMode: 'MatchAny',
        ratioLimit: String(job.rules.seedRatio),
        seedingTimeLimit: String(job.rules.seedMinutes),
      });
      if (typeof result === 'string' && result.trim() !== 'Ok.')
        fail(502, 'qBittorrent rejected the magnet');
      save(job, { submitted: true, error: null });
      return;
    }
    owns(info, job);
    if (job.state === 'queued' && job.selectedFile != null) {
      await freeSpace(Math.max(0, job.total - (job.bytes || 0)), job);
      await client.call('torrents/setUploadLimit', {
        hashes: job.hash,
        limit: String(job.rules.uploadKBps * 1024),
      });
      await client.call('torrents/setShareLimits', {
        hashes: job.hash,
        ratioLimit: String(job.rules.seedRatio),
        seedingTimeLimit: String(job.rules.seedMinutes),
        inactiveSeedingTimeLimit: '-1',
        shareLimitAction: 'Stop',
        shareLimitsMode: 'MatchAny',
      });
      await client.start(job.hash);
      job = save(job, { state: 'downloading', lastProgress: now(), error: null });
      return;
    }
    const files = await client.files(job.hash);
    if (!files.length || /metaDL/i.test(info.state)) {
      if (job.state === 'queued' && ['stoppedDL', 'pausedDL'].includes(info.state))
        await client.start(job.hash);
      if (now() - (job.started || job.created) > job.rules.metadataMinutes * 60000)
        fail(408, 'No torrent metadata received before the timeout');
      save(job, {
        state: 'checking',
        seeders: info.num_seeds || 0,
        peers: info.num_leechs || 0,
        error: null,
      });
      return;
    }
    if (job.selectedFile == null) {
      await client.stop(job.hash);
      const file = selectFile(
        files.map((f) => ({ id: f.index, path: f.name, bytes: f.size })),
        store.item(job.item_id),
        job.fileIndex,
      );
      const kind = store.title(store.item(job.item_id).title_id).kind;
      const actual = assessRelease(
        {
          ...job.release,
          label: `${job.release.label}\n${file.path}`,
          filename: file.path,
          sizeBytes: file.bytes,
          resolution: releaseFacts({ label: file.path }).resolution ?? job.release.resolution,
        },
        kind,
        job.rules,
      );
      if (!actual.accepted) fail(400, `Actual file rejected: ${actual.reasons.join('; ')}`);
      const limit = (kind === 'movie' ? job.rules.movieMaxGB : job.rules.episodeMaxGB) * 1073741824;
      if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > limit)
        fail(400, 'Actual video file exceeds your size limit');
      if (
        !file.path ||
        file.path.split(/[\\/]/).some((p) => p === '..' || p.includes(':')) ||
        path.isAbsolute(file.path)
      )
        fail(400, 'Unsafe torrent file path');
      await freeSpace(file.bytes, job);
      await client.call('torrents/filePrio', {
        hash: job.hash,
        id: files.map((f) => f.index).join('|'),
        priority: '0',
      });
      await client.call('torrents/filePrio', {
        hash: job.hash,
        id: String(file.id),
        priority: '1',
      });
      await client.call('torrents/setShareLimits', {
        hashes: job.hash,
        ratioLimit: String(job.rules.seedRatio),
        seedingTimeLimit: String(job.rules.seedMinutes),
        inactiveSeedingTimeLimit: '-1',
        shareLimitAction: 'Stop',
        shareLimitsMode: 'MatchAny',
      });
      await client.start(job.hash);
      save(job, {
        state: 'downloading',
        selectedFile: file.id,
        filename: file.path,
        total: file.bytes,
        lastProgress: now(),
        error: null,
      });
      return;
    }
    const file = files.find((f) => f.index === job.selectedFile);
    if (!file) fail(409, 'Selected file is missing from the torrent');
    const bytes = Math.min(file.size, Math.floor(file.progress * file.size));
    job = save(job, {
      bytes,
      seeders: info.num_seeds || 0,
      peers: info.num_leechs || 0,
      speed: info.dlspeed || 0,
      availability: Number.isFinite(info.availability) ? info.availability : null,
      lastProgress: bytes > (job.bytes || 0) ? now() : job.lastProgress || now(),
      error: null,
    });
    if (file.progress >= 1 && !/checking|moving/i.test(info.state)) {
      save(job, { state: 'verifying' });
      const root = await realpath(path.join(config.torrentDir, job.id));
      const destination = await realpath(path.resolve(root, file.name));
      if (!destination.startsWith(root + path.sep))
        fail(400, 'Torrent file is outside its download folder');
      const details = await stat(destination);
      if (!details.isFile() || details.size !== file.size)
        fail(409, 'Local torrent file is incomplete');
      const metadata = await probeFile(destination, config);
      if (!allowed(store.one('SELECT * FROM users WHERE id=?', job.user_id)))
        fail(403, 'Download permission was revoked');
      store.transaction(() => {
        store.addAsset({
          item_id: job.item_id,
          path: destination,
          bytes: file.size,
          probe: metadata,
          managed: true,
          downloadJobId: job.id,
        });
        save(job, { state: 'ready', bytes: file.size, error: null });
      });
      return;
    }
    if (['error', 'missingFiles'].includes(info.state))
      fail(409, 'qBittorrent reported a storage error');
    if (now() - job.lastProgress > job.rules.stallMinutes * 60000)
      fail(
        408,
        'No download progress before the stall timeout. Torrent stopped; partial data retained.',
      );
    if (info.state === 'stoppedDL' || info.state === 'pausedDL') save(job, { state: 'paused' });
    else {
      await freeSpace(Math.max(0, file.size - bytes), job);
      save(job, { state: 'downloading' });
    }
  }
  async function tick() {
    if (busy || stopping || !config.qbitUrl) return;
    busy = true;
    try {
      await serial(async () => {
        const pending = jobs().filter((j) =>
          ['queued', 'checking', 'downloading', 'verifying'].includes(j.state),
        );
        const active = pending.filter((j) => j.state !== 'queued');
        const selected = [
          ...active,
          ...pending
            .filter((j) => j.state === 'queued')
            .slice(0, Math.max(0, policy.get().maxConcurrent - active.length)),
        ];
        for (const job of selected) {
          if (stopping) break;
          try {
            await step(job);
          } catch (error) {
            if (error.ownership) {
              save(store.job(job.id), { state: 'failed', error: error.message, retryable: false });
              continue;
            }
            if (
              error.status === 503 ||
              error.name === 'TypeError' ||
              error.name === 'TimeoutError'
            ) {
              save(store.job(job.id), {
                error: 'qBittorrent is unavailable; waiting to reconnect.',
              });
              continue;
            }
            const current = store.job(job.id);
            let stopPending = false;
            try {
              const info = await client.info(job.hash);
              if (info) {
                owns(info, current);
                await client.stop(job.hash);
              }
            } catch {
              stopPending = true;
            }
            save(current, {
              state: stopPending ? 'stopping' : 'failed',
              error: error.message,
              retryable: true,
            });
          }
        }
        for (const job of jobs().filter((j) => j.state === 'stopping')) {
          try {
            const info = await client.info(job.hash);
            if (info) {
              owns(info, job);
              await client.stop(job.hash);
            }
            save(job, { state: job.stopTarget || 'failed' });
          } catch {
            /* retry stopping when the engine reconnects */
          }
        }
      });
    } finally {
      busy = false;
    }
  }
  return {
    health: () => client.health(),
    tick,
    enqueue(user, itemId, release) {
      return serial(async () => {
        if (!config.qbitUrl) fail(503, 'qBittorrent is not configured');
        if (!allowed(user)) fail(403, 'Download permission required');
        if (!store.canReadItem(user, itemId)) fail(404, 'Media not found');
        if (store.available(user, itemId)) fail(409, 'This item is already downloaded');
        if (!/^[a-f0-9]{40}$/i.test(release.hash || '')) fail(400, 'Invalid torrent hash');
        const rules = policy.get();
        const verdict = assessRelease(
          release,
          store.title(store.item(itemId).title_id).kind,
          rules,
        );
        if (!verdict.accepted) fail(400, verdict.reasons.join('; '));
        const duplicate = store
          .all(
            "SELECT * FROM jobs WHERE item_id=? AND state NOT IN ('failed','cancelled','evicted')",
            itemId,
          )
          .map(store.unpack)[0];
        if (duplicate) return duplicate;
        if (
          store.one(
            "SELECT id FROM jobs WHERE json_extract(json,'$.provider')='torrent' AND lower(json_extract(json,'$.hash'))=? AND state NOT IN ('failed','cancelled','evicted')",
            release.hash.toLowerCase(),
          )
        )
          fail(
            409,
            'This torrent is already queued for another episode. Select a different release.',
          );
        if (await client.info(release.hash))
          fail(
            409,
            'This torrent is already in qBittorrent. Resume its existing job or select a different release.',
          );
        const job = store.saveJob({
          id: id(),
          user_id: user.id,
          item_id: itemId,
          provider: 'torrent',
          state: 'queued',
          created: now(),
          hash: release.hash.toLowerCase(),
          fileIndex: release.fileIndex ?? null,
          release,
          rules,
          total: release.sizeBytes || 0,
          bytes: 0,
        });
        return job;
      });
    },
    action(user, key, action) {
      return serial(async () => {
        const job = store.job(key);
        if (
          !job ||
          job.provider !== 'torrent' ||
          (user.role !== 'admin' && user.id !== job.user_id)
        )
          fail(404, 'Download not found');
        if (job.state === 'ready') fail(409, 'Download is already complete');
        if (!['pause', 'resume', 'retry', 'cancel'].includes(action))
          fail(400, 'Unknown download action');
        if (action === 'pause' || action === 'cancel') {
          const target = action === 'pause' ? 'paused' : 'cancelled';
          save(job, { state: 'stopping', stopTarget: target });
          const info = await client.info(job.hash);
          if (info) {
            owns(info, job);
            await client.stop(job.hash);
          }
          return save(job, { state: target, stopTarget: null });
        }
        if (!allowed(user)) fail(403, 'Download permission required');
        if (!['paused', 'failed', 'cancelled'].includes(job.state))
          fail(409, 'Download is already active');
        const rules = policy.get();
        const verdict = assessRelease(
          job.release,
          store.title(store.item(job.item_id).title_id).kind,
          rules,
        );
        if (!verdict.accepted) fail(400, verdict.reasons.join('; '));
        const info = await client.info(job.hash);
        if (info) owns(info, job);
        return save(job, {
          state: 'queued',
          submitted: !!info,
          selectedFile: info ? job.selectedFile : null,
          created: now(),
          started: now(),
          lastProgress: now(),
          error: null,
          stopTarget: null,
          rules,
        });
      });
    },
    start() {
      timer = setInterval(() => void tick(), 5000);
      timer.unref();
      void tick();
    },
    async close() {
      stopping = true;
      clearInterval(timer);
      await chain;
    },
  };
}
