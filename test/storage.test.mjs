import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  statSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.mjs';
import { configuration } from '../src/config.mjs';
import { createStorage, getStorage } from '../src/storage.mjs';
import { createHistory } from '../src/history.mjs';
import { createTorrentDownloads } from '../src/torrent-downloads.mjs';
import { createTorrentPolicy } from '../src/torrent-policy.mjs';

function fixture(t, { capacity = 400, reserve = 20, client } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediawan-storage-'));
  const store = createStore(':memory:');
  const config = {
    ...configuration({}),
    media: path.join(root, 'library'),
    torrentDir: path.join(root, 'torrents'),
    reserveBytes: reserve,
  };
  mkdirSync(config.media);
  mkdirSync(config.torrentDir);
  for (const user of [1, 2])
    store.run(
      'INSERT INTO users(id,email,name,pw_hash,role) VALUES(?,?,?,?,?)',
      user,
      `${user}@test`,
      'Test',
      'x',
      'admin',
    );
  const user = store.one('SELECT * FROM users WHERE id=1');
  const files = [];
  let sequence = 0;
  const title = (name, kind = 'movie') =>
    store.saveTitle({ kind, external_id: String(++sequence), name });
  const add = (
    name,
    {
      watched = [],
      added = sequence + 1,
      bytes = 100,
      imported = false,
      parent,
      episode = 0,
      torrent = false,
      legacy = false,
    } = {},
  ) => {
    const item = store.saveItem({ title_id: (parent || title(name)).id, episode });
    const job = store.saveJob({
      id: `job-${++sequence}`,
      user_id: 1,
      item_id: item.id,
      state: 'ready',
      provider: torrent ? 'torrent' : 'realdebrid',
      hash: String(sequence).padStart(40, '0'),
      total: bytes,
      bytes,
    });
    const destination = torrent
      ? path.join(config.torrentDir, job.id, 'file.mp4')
      : path.join(config.media, `${job.id}.mp4`);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, Buffer.alloc(bytes));
    files.push(destination);
    const asset = store.addAsset({
      item_id: item.id,
      path: destination,
      bytes,
      added_at: added,
      ...(imported ? { imported: true } : legacy ? {} : { managed: true, downloadJobId: job.id }),
    });
    for (let n = 0; n < watched.length; n++)
      store.run(
        'INSERT INTO history(user_id,item_id,played_at) VALUES(?,?,?)',
        n + 1,
        item.id,
        watched[n],
      );
    return { item, job, asset, titleId: item.title_id, path: destination };
  };
  const request = (bytes, parent) => {
    const item = store.saveItem({
      title_id: (parent || title('Incoming')).id,
      episode: parent ? 99 : 0,
    });
    const job = store.saveJob({
      id: `incoming-${++sequence}`,
      user_id: 1,
      item_id: item.id,
      state: 'queued',
      total: bytes,
      bytes: 0,
    });
    return { directory: config.media, bytes, job };
  };
  const storage = createStorage(store, config, {
    client,
    statfsImpl: async () => ({
      bsize: 1,
      bavail: capacity - files.reduce((sum, f) => sum + (existsSync(f) ? statSync(f).size : 0), 0),
    }),
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, config, user, title, add, request, storage };
}

test('space reclamation uses the latest watch by any user, keeps history, and stops once enough space exists', async (t) => {
  const f = fixture(t);
  const recent = f.add('Recent for another user', { watched: [1, 900] });
  const oldest = f.add('Old for everyone', { watched: [100, 200], legacy: true });
  const middle = f.add('Middle', { watched: [500] });
  await f.storage.ensure(f.request(150));
  assert(!existsSync(oldest.path));
  assert(existsSync(recent.path));
  assert(existsSync(middle.path));
  assert.equal(f.store.assets(oldest.item.id).length, 0);
  assert.equal(f.store.state(2, oldest.item.id).played_at, 200);
  assert.equal(f.store.job(oldest.job.id).state, 'evicted');
});

test('never-played titles go first in addition order; healthy free space removes nothing', async (t) => {
  const f = fixture(t);
  const watched = f.add('Watched', { watched: [1], added: 1 });
  const newer = f.add('Newer unwatched', { added: 30 });
  const older = f.add('Older unwatched', { added: 20 });
  await f.storage.ensure(f.request(10));
  assert(existsSync(older.path));
  await f.storage.ensure(f.request(150));
  assert(!existsSync(older.path));
  assert(existsSync(newer.path));
  assert(existsSync(watched.path));
});

test('series rank by the latest watched episode across users and remove their managed episodes together', async (t) => {
  const f = fixture(t, { capacity: 500 });
  const show = f.title('Old show', 'tv');
  const first = f.add('First', { parent: show, episode: 1, watched: [10] });
  const second = f.add('Second', { parent: show, episode: 2, watched: [20] });
  const recent = f.add('Recently watched', { watched: [100] });
  await f.storage.ensure(f.request(250));
  assert(!existsSync(first.path));
  assert(!existsSync(second.path));
  assert(existsSync(recent.path));
});

test('favorites of any user, active playback, imported files, and pending downloads are protected', async (t) => {
  const f = fixture(t, { capacity: 700 });
  const favorite = f.add('Favorite');
  f.store.run("INSERT INTO tags VALUES(2,?,'favorite')", favorite.titleId);
  const active = f.add('Active');
  createHistory(f.store).start(f.user, active.item.id);
  const imported = f.add('Imported', { imported: true });
  const downloading = f.add('Downloading');
  f.store.saveJob({
    id: 'pending',
    user_id: 1,
    item_id: downloading.item.id,
    state: 'paused',
    total: 0,
  });
  const eligible = f.add('Eligible', { watched: [1] });
  await f.storage.ensure(f.request(250));
  assert(!existsSync(eligible.path));
  for (const entry of [favorite, active, imported, downloading]) assert(existsSync(entry.path));
});

test('playback stop releases protection, stale sessions expire, and retained media protects conversions and readers', async (t) => {
  const f = fixture(t);
  const stopped = f.add('Stopped', { watched: [1] });
  const history = createHistory(f.store),
    session = history.start(f.user, stopped.item.id);
  history.event(f.user, session.id, { seq: 1, type: 'stop', position: 10, duration: 100 });
  const retained = f.add('Reader');
  const release = f.store.retainItem(retained.item.id);
  const stale = f.add('Stale');
  const oldSession = history.start(f.user, stale.item.id);
  f.store.run('UPDATE playback SET started=1,touched=1 WHERE id=?', oldSession.id);
  f.store.run('UPDATE history SET played_at=1 WHERE item_id=?', stale.item.id);
  const first = f.request(150);
  await f.storage.ensure(first);
  assert(!existsSync(stale.path));
  assert(existsSync(retained.path));
  release();
  release();
  f.store.saveJob({ ...first.job, state: 'cancelled' });
  const second = f.request(250);
  await f.storage.ensure(second);
  assert(!existsSync(retained.path));
  assert(existsSync(stopped.path));
  f.store.saveJob({ ...second.job, state: 'cancelled' });
  await f.storage.ensure(f.request(350));
  assert(!existsSync(stopped.path));
});

test('an impossible request preserves eligible media instead of deleting without enough reclaimable space', async (t) => {
  const f = fixture(t, { capacity: 200 });
  const entry = f.add('Keep');
  await assert.rejects(f.storage.ensure(f.request(500)), (error) => error.status === 507);
  assert(existsSync(entry.path));
});

test('shared reservations serialize simultaneous requests and account for both provider directories', async (t) => {
  const f = fixture(t, { capacity: 300 });
  assert.equal(getStorage(f.store, f.config), getStorage(f.store, f.config));
  const first = f.request(200),
    second = f.request(200);
  second.directory = f.config.torrentDir;
  const results = await Promise.allSettled([f.storage.ensure(first), f.storage.ensure(second)]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  f.store.saveJob({ ...first.job, state: 'failed' });
  await f.storage.ensure(second);
});

test('the incoming series and files outside configured roots are never removed', async (t) => {
  const f = fixture(t, { capacity: 300 });
  const show = f.title('Incoming show', 'tv'),
    existing = f.add('Episode', { parent: show, episode: 1 });
  const outside = path.join(f.root, 'outside.mp4');
  writeFileSync(outside, Buffer.alloc(100));
  f.store.addAsset({
    item_id: f.add('Outside owner', { imported: true }).item.id,
    path: outside,
    bytes: 100,
    managed: true,
  });
  await assert.rejects(f.storage.ensure(f.request(150, show)), (error) => error.status === 507);
  assert(existsSync(existing.path));
  assert(existsSync(outside));
});

test('symbolic directory escapes do not make external files eligible', async (t) => {
  const f = fixture(t, { capacity: 200 });
  const external = path.join(f.root, 'external');
  mkdirSync(external);
  const file = path.join(external, 'film.mp4');
  writeFileSync(file, Buffer.alloc(100));
  const link = path.join(f.config.media, 'linked');
  symlinkSync(external, link, 'junction');
  const item = f.store.saveItem({ title_id: f.title('Linked').id });
  f.store.addAsset({
    item_id: item.id,
    path: path.join(link, 'film.mp4'),
    bytes: 100,
    managed: true,
  });
  await assert.rejects(f.storage.ensure(f.request(190)), (error) => error.status === 507);
  assert(existsSync(file));
});

test('completed torrents are detached without recursive deletion and evicted jobs permit a fresh request', async (t) => {
  let info,
    removed = false;
  const calls = [];
  const client = {
    info: async () => (removed ? undefined : info),
    call: async (endpoint, data) => {
      calls.push([endpoint, data]);
      assert.throws(() => createHistory(f.store).start(f.user, entry.item.id), /not downloaded/);
      assert.throws(() => f.store.retainItem(entry.item.id), /being removed/);
      removed = true;
    },
  };
  const f = fixture(t, { capacity: 200, client });
  const entry = f.add('Torrent', { torrent: true });
  info = { category: 'mediawan', save_path: `${f.config.qbitSavePath}/${entry.job.id}` };
  await f.storage.ensure(f.request(150));
  assert(!existsSync(entry.path));
  assert.deepEqual(calls, [['torrents/delete', { hashes: entry.job.hash, deleteFiles: 'false' }]]);
  assert.equal(f.store.job(entry.job.id).state, 'evicted');
  const worker = createTorrentDownloads(
    f.store,
    { ...f.config, qbitUrl: 'http://fixture' },
    createTorrentPolicy(f.store),
    { client, storage: f.storage },
  );
  const next = await worker.enqueue(f.user, entry.item.id, {
    hash: entry.job.hash,
    label: 'Film 2160p WEB-DL [YTS.MX]',
    resolution: 2160,
    seeders: 10,
    sizeBytes: 100,
  });
  assert.notEqual(next.id, entry.job.id);
  assert.equal(next.state, 'queued');
  await worker.close();
});

test('unrelated torrent ownership prevents deletion', async (t) => {
  const client = {
    info: async () => ({ category: 'personal', save_path: '/other' }),
    call: async () => assert.fail('must not delete unrelated torrent'),
  };
  const f = fixture(t, { capacity: 200, client }),
    entry = f.add('Torrent', { torrent: true });
  await assert.rejects(f.storage.ensure(f.request(150)), (error) => error.status === 507);
  assert(existsSync(entry.path));
  assert.equal(f.store.job(entry.job.id).state, 'ready');
});
