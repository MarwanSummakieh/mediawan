import path from 'node:path';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { id, fail } from './store.mjs';
import { probe } from './media.mjs';
import { getStorage } from './storage.mjs';

function providerError(status, data) {
  const code = Number.isInteger(data.error_code) ? data.error_code : null;
  const reason = {
    8: 'The Real-Debrid token is invalid or expired. Update it on the server.',
    9: 'Real-Debrid denied this request. Check your account permissions.',
    21: 'Real-Debrid has too many active downloads. Wait for one to finish.',
    22: 'Real-Debrid does not allow this IP address.',
    23: 'The Real-Debrid traffic allowance is exhausted.',
    24: 'This file is unavailable on Real-Debrid.',
    28: 'Real-Debrid does not allow this file.',
    29: 'This torrent exceeds the Real-Debrid size limit.',
    30: 'Real-Debrid rejected an invalid torrent.',
    34: 'Real-Debrid rate limit; retrying shortly.',
    35: 'Real-Debrid blocked this release as an infringing file. It cannot be downloaded through Real-Debrid.',
    36: 'The Real-Debrid fair usage limit has been reached.',
    37: 'This Real-Debrid API endpoint is disabled.',
  }[code];
  const message =
    reason ||
    (status === 451
      ? 'Real-Debrid blocked this release for legal reasons. It cannot be downloaded through Real-Debrid.'
      : status === 429
        ? 'Real-Debrid rate limit; retrying shortly.'
        : `Real-Debrid request failed (HTTP ${status}${code == null ? '' : `, code ${code}`}).`);
  return Object.assign(new Error(message), {
    status,
    providerCode: code,
    retryable: status !== 451 && ![28, 29, 30, 35, 37].includes(code),
  });
}

export function selectFile(files, item, fileIndex) {
  const video = files.filter(
    (f) =>
      /\.(mkv|mp4|avi|webm|m4v|mov)$/i.test(f.path) &&
      !/(?:^|[\/\\._ -])sample(?:[\/\\._ -]|$)/i.test(f.path),
  );
  if (fileIndex != null) {
    const file = files[fileIndex];
    if (file && video.includes(file)) {
      const numbered = /s(\d+)e(\d+)/i.exec(file.path);
      if (
        item.episode &&
        numbered &&
        (Number(numbered[2]) !== item.episode ||
          (item.season > 0 && Number(numbered[1]) !== item.season))
      )
        fail(400, 'The selected release points to a different episode');
      return file;
    }
    fail(400, 'Selected release file was not found');
  }
  if (item.episode) {
    const token = new RegExp(
      `(?:s0*${item.season}e0*${item.episode}(?!\\d)|0*${item.season}x0*${item.episode}(?!\\d))`,
      'i',
    );
    const matches = video.filter((f) => token.test(f.path));
    if (matches.length === 1) return matches[0];
    if (video.length === 1) return video[0];
    fail(400, 'Choose a release with an exact episode file; this pack is ambiguous');
  }
  if (!video.length) fail(400, 'No video file was found');
  return video.sort((a, b) => b.bytes - a.bytes)[0];
}
export function createDownloads(
  store,
  config,
  { fetchImpl = fetch, probeFile = probe, storage = getStorage(store, config) } = {},
) {
  const active = new Map();
  let timer,
    closing = false,
    nextCall = 0;
  const userFor = (job) => store.one('SELECT * FROM users WHERE id=? AND active=1', job.user_id);
  const allowed = (user) => user && (user.role === 'admin' || user.can_download);
  async function rd(endpoint, form, signal) {
    if (!config.debridToken) fail(503, 'Configure REAL_DEBRID_TOKEN on the server');
    const wait = Math.max(0, nextCall - Date.now());
    nextCall = Math.max(nextCall, Date.now()) + 350;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const response = await fetchImpl(`https://api.real-debrid.com/rest/1.0${endpoint}`, {
      method: form ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${config.debridToken}` },
      body: form ? new URLSearchParams(form) : undefined,
      signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
    });
    if (response.status === 204 || response.status === 202) return {};
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error_code) throw providerError(response.status, data);
    return data;
  }
  async function step(job, signal) {
    if (!allowed(userFor(job))) fail(403, 'Download permission was revoked');
    const update = (patch) => {
      signal.throwIfAborted();
      if (store.job(job.id)?.state === 'cancelled') throw new Error('Download cancelled');
      job = store.saveJob({ ...job, ...patch });
      return job;
    };
    if (job.created && Date.now() - job.created > 6 * 60 * 60 * 1000)
      fail(408, 'Provider transfer timed out. Retry to continue checking it.');
    if (!job.torrentId) {
      const data = await rd(
        '/torrents/addMagnet',
        { magnet: `magnet:?xt=urn:btih:${job.hash}` },
        signal,
      );
      update({ torrentId: String(data.id), state: 'preparing' });
      return;
    }
    const info = await rd(`/torrents/info/${encodeURIComponent(job.torrentId)}`, null, signal);
    if (['error', 'magnet_error', 'virus', 'dead'].includes(info.status))
      fail(502, 'Real-Debrid could not acquire this release. Choose another.');
    if (info.status === 'waiting_files_selection') {
      const file = selectFile(info.files, store.item(job.item_id), job.fileIndex);
      await rd(
        `/torrents/selectFiles/${encodeURIComponent(job.torrentId)}`,
        { files: String(file.id) },
        signal,
      );
      update({
        fileId: file.id,
        filename: path.basename(file.path),
        total: file.bytes,
        state: 'preparing',
      });
      return;
    }
    if (info.status !== 'downloaded') {
      update({ state: 'preparing', providerProgress: info.progress || 0 });
      return;
    }
    const file = job.fileId
      ? info.files.find((f) => f.id === job.fileId)
      : selectFile(info.files, store.item(job.item_id), job.fileIndex);
    const selected = info.files.filter((f) => f.selected),
      linkIndex = selected.findIndex((f) => f.id === file?.id);
    if (linkIndex < 0 || !info.links[linkIndex])
      fail(502, 'The selected episode is not in this completed transfer');
    const resolved = await rd('/unrestrict/link', { link: info.links[linkIndex] }, signal);
    const url = new URL(resolved.download);
    if (url.protocol !== 'https:' || !/(^|\.)real-debrid\.com$/i.test(url.hostname))
      fail(502, 'Real-Debrid returned an unsupported download host');
    const total = Number(resolved.filesize || file.bytes);
    if (!Number.isSafeInteger(total) || total <= 0)
      fail(502, 'The provider did not return a valid file size');
    await mkdir(config.media, { recursive: true });
    update({ total, bytes: 0 });
    await storage.ensure({ directory: config.media, bytes: total, job, signal });
    update({ state: 'downloading', total, bytes: 0, filename: path.basename(file.path) });
    const staging = path.join(config.media, `${job.id}.part`),
      destination = path.join(config.media, `${job.id}${path.extname(file.path).toLowerCase()}`);
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]),
        redirect: 'error',
      });
      if (!response.ok || /text\/|mpegurl/i.test(response.headers.get('content-type') || ''))
        fail(502, 'The original file could not be downloaded');
      let bytes = 0,
        last = 0;
      await pipeline(
        Readable.fromWeb(response.body),
        async function* (chunks) {
          for await (const chunk of chunks) {
            bytes += chunk.length;
            if (bytes > total) fail(502, 'Downloaded file is larger than expected');
            if (Date.now() - last > 1000) {
              last = Date.now();
              update({ bytes });
            }
            yield chunk;
          }
        },
        createWriteStream(staging),
        { signal },
      );
      if (bytes !== total) fail(502, 'Download was incomplete');
      update({ state: 'verifying', bytes });
      const metadata = await probeFile(staging, config);
      signal.throwIfAborted();
      if (!allowed(userFor(job))) fail(403, 'Download permission was revoked');
      await rename(staging, destination);
      store.transaction(() => {
        store.addAsset({
          item_id: job.item_id,
          path: destination,
          bytes,
          probe: metadata,
          managed: true,
          downloadJobId: job.id,
        });
        update({ state: 'ready', bytes, error: null });
      });
    } finally {
      await rm(staging, { force: true }).catch(() => {});
    }
  }
  function tick() {
    if (closing) return;
    for (const job of store
      .all(
        "SELECT * FROM jobs WHERE state IN ('queued','preparing') AND COALESCE(json_extract(json,'$.provider'),'realdebrid')='realdebrid' ORDER BY updated",
      )
      .map(store.unpack)) {
      if (active.size >= config.concurrentDownloads) break;
      if (active.has(job.id) || (job.nextAttempt || 0) > Date.now()) continue;
      const abort = new AbortController();
      const task = step(job, abort.signal)
        .catch((error) => {
          const current = store.job(job.id);
          if (current.state === 'cancelled') return;
          if (closing) {
            store.saveJob({ ...current, state: 'queued' });
            return;
          }
          const retries = (current.retries || 0) + 1,
            retry =
              error.retryable !== false &&
              (error.status === 429 || error.status >= 500 || error.name === 'TypeError') &&
              error.status !== 507 &&
              retries <= 4;
          store.saveJob({
            ...current,
            state: retry ? 'queued' : 'failed',
            retries,
            error: error.message.replace(/https?:\/\/\S+/g, '[provider]'),
            httpStatus: error.status || null,
            providerCode: error.providerCode ?? null,
            retryable: error.retryable !== false,
            nextAttempt: Date.now() + Math.min(120000, 10000 * 2 ** retries),
          });
        })
        .finally(() => active.delete(job.id));
      active.set(job.id, { abort, task });
    }
  }
  return {
    enqueue(user, itemId, release) {
      if (!allowed(user)) fail(403, 'An administrator must enable your downloads');
      if (!store.canReadItem(user, itemId)) fail(404, 'Media not found');
      if (!/^[a-f0-9]{40}$/i.test(release.hash || '')) fail(400, 'Select a valid release');
      if (
        release.fileIndex != null &&
        (!Number.isSafeInteger(release.fileIndex) || release.fileIndex < 0)
      )
        fail(400, 'Invalid file selection');
      if (store.available(user, itemId)) fail(409, 'This item is already downloaded');
      const existing = store
        .all(
          "SELECT * FROM jobs WHERE item_id=? AND state NOT IN ('failed','cancelled','ready','evicted')",
          itemId,
        )
        .map(store.unpack)[0];
      if (existing) return existing;
      const job = store.saveJob({
        id: id(),
        user_id: user.id,
        item_id: itemId,
        state: 'queued',
        created: Date.now(),
        hash: release.hash.toLowerCase(),
        fileIndex: release.fileIndex ?? null,
        bytes: 0,
        total: 0,
      });
      tick();
      return job;
    },
    list(user) {
      return store
        .all('SELECT * FROM jobs ORDER BY updated DESC LIMIT 200')
        .map(store.unpack)
        .filter((j) => user.role === 'admin' || j.user_id === user.id)
        .map((j) => ({
          id: j.id,
          itemId: j.item_id,
          titleId: store.item(j.item_id).title_id,
          name: store.title(store.item(j.item_id).title_id).name,
          episode: store.item(j.item_id).episode,
          state: j.state,
          bytes: j.bytes || 0,
          total: j.total || 0,
          error: j.error || null,
          retryable: j.retryable !== false,
          provider: j.provider || 'realdebrid',
          seeders: j.seeders ?? null,
          peers: j.peers ?? null,
          speed: j.speed || 0,
          availability: j.availability ?? null,
          providerProgress: j.providerProgress || 0,
        }));
    },
    action(user, key, action) {
      const job = store.job(key);
      if (!job || (user.role !== 'admin' && job.user_id !== user.id))
        fail(404, 'Download not found');
      if (job.state === 'ready') fail(409, 'Download is already complete');
      if (action === 'cancel') {
        active.get(key)?.abort.abort();
        return store.saveJob({ ...job, state: 'cancelled' });
      }
      if (action === 'retry' && !active.has(key)) {
        if (!allowed(user)) fail(403, 'Download permission required');
        if (job.retryable === false) fail(409, job.error || 'This release cannot be retried');
        const result = store.saveJob({
          ...job,
          state: 'queued',
          created: Date.now(),
          error: null,
          httpStatus: null,
          providerCode: null,
          retries: 0,
          nextAttempt: 0,
        });
        tick();
        return result;
      }
      fail(409, 'Wait for the current operation to stop');
    },
    start() {
      store.run(
        "UPDATE jobs SET state='queued' WHERE state IN ('downloading','verifying') AND COALESCE(json_extract(json,'$.provider'),'realdebrid')='realdebrid'",
      );
      timer = setInterval(tick, 5000);
      timer.unref();
      tick();
    },
    async close() {
      closing = true;
      clearInterval(timer);
      for (const op of active.values()) op.abort.abort();
      await Promise.all([...active.values()].map((op) => op.task));
    },
    tick,
  };
}
