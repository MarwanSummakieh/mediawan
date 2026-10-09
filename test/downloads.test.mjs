import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { configuration } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createDownloads } from '../src/downloads.mjs';
import { createStorage } from '../src/storage.mjs';

const release = { hash: 'a'.repeat(40), label: 'Fixture 2160p WEB-DL [OTHER]', resolution: 2160 };

test('provider legal blocks explain the failure and cannot be retried automatically or manually', async (t) => {
  const store = createStore(':memory:');
  store.run(
    "INSERT INTO users(id,email,name,pw_hash,role) VALUES(1,'test@test','Test','hash','admin')",
  );
  const user = store.one('SELECT * FROM users');
  const title = store.saveTitle({ kind: 'movie', external_id: 'tt1', name: 'Fixture' });
  const item = store.saveItem({ title_id: title.id });
  let calls = 0;
  const downloads = createDownloads(
    store,
    { ...configuration({}), debridToken: 'fixture-secret' },
    {
      fetchImpl: async () => {
        calls++;
        return Response.json({ error: 'infringing_file', error_code: 35 }, { status: 451 });
      },
    },
  );
  t.after(async () => {
    await downloads.close();
    store.close();
  });
  const job = downloads.enqueue(user, item.id, release);
  for (let n = 0; n < 30 && store.job(job.id).state !== 'failed'; n++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(store.job(job.id).state, 'failed');
  assert.equal(store.job(job.id).httpStatus, 451);
  assert.equal(store.job(job.id).providerCode, 35);
  assert.match(downloads.list(user)[0].error, /blocked this release as an infringing file/);
  assert.equal(downloads.list(user)[0].retryable, false);
  assert(!JSON.stringify(downloads.list(user)).includes('fixture-secret'));
  downloads.tick();
  assert.throws(() => downloads.action(user, job.id, 'retry'), /blocked this release/);
  assert.equal(calls, 1);
});
test('Real-Debrid reclaims old media, persists provider state and publishes only a complete verified file', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediawan-download-')),
    store = createStore(':memory:');
  store.run(
    "INSERT INTO users(id,email,name,pw_hash,role) VALUES(1,'test@test','Test','hash','admin')",
  );
  const user = store.one('SELECT * FROM users');
  const title = store.saveTitle({ kind: 'movie', external_id: 'tt1', name: 'Fixture' }),
    item = store.saveItem({ title_id: title.id });
  let selected = false,
    verified = false;
  const content = Buffer.from('test-video-content');
  const oldTitle = store.saveTitle({ kind: 'movie', external_id: 'old', name: 'Old film' });
  const oldItem = store.saveItem({ title_id: oldTitle.id });
  const oldPath = path.join(root, 'old.mp4');
  writeFileSync(oldPath, Buffer.alloc(100));
  store.addAsset({ item_id: oldItem.id, path: oldPath, bytes: 100, managed: true });
  store.run('INSERT INTO history(user_id,item_id,played_at) VALUES(1,?,1)', oldItem.id);
  const config = {
    ...configuration({}),
    media: root,
    torrentDir: path.join(root, 'torrents'),
    debridToken: 'fixture-token',
    reserveBytes: 0,
  };
  const storage = createStorage(store, config, {
    statfsImpl: async () => ({ bsize: 1, bavail: existsSync(oldPath) ? 0 : content.length }),
  });
  const fetchImpl = async (url, options) => {
    const value = String(url);
    if (value.endsWith('/addMagnet')) return Response.json({ id: 'provider-id' });
    if (value.includes('/info/'))
      return Response.json({
        status: selected ? 'downloaded' : 'waiting_files_selection',
        files: [{ id: 7, path: '/fixture.mp4', bytes: content.length, selected: +selected }],
        links: selected ? ['https://real-debrid.com/d/fixture'] : [],
      });
    if (value.includes('/selectFiles/')) {
      assert.equal(options.body.get('files'), '7');
      selected = true;
      return new Response(null, { status: 204 });
    }
    if (value.endsWith('/unrestrict/link'))
      return Response.json({
        download: 'https://download.real-debrid.com/fixture',
        filesize: content.length,
      });
    if (value === 'https://download.real-debrid.com/fixture')
      return new Response(content, { headers: { 'Content-Type': 'video/mp4' } });
    throw new Error('Unexpected request');
  };
  const downloads = createDownloads(store, config, {
    fetchImpl,
    storage,
    probeFile: async (file) => {
      assert.deepEqual(readFileSync(file), content);
      verified = true;
      return { duration: 10, video: 'h264', audio: [], subtitles: [] };
    },
  });
  t.after(async () => {
    await downloads.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  assert.throws(
    () => downloads.enqueue(user, item.id, { ...release, label: 'Fixture 2160p' }),
    /WEB-DL/,
  );
  assert.throws(() => downloads.enqueue(user, item.id, { ...release, resolution: 1080 }), /2160p/);
  const job = downloads.enqueue(user, item.id, release);
  assert.equal(downloads.enqueue(user, item.id, { ...release, hash: 'b'.repeat(40) }).id, job.id);
  for (let n = 0; n < 100; n++) {
    downloads.tick();
    if (store.job(job.id).state === 'ready') break;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.equal(store.job(job.id).state, 'ready', store.job(job.id).error);
  assert(!existsSync(oldPath));
  assert.equal(store.state(user.id, oldItem.id).played_at, 1);
  assert(verified);
  assert.equal(store.assets(item.id).length, 1);
  assert.deepEqual(readFileSync(store.assets(item.id)[0].path), content);
  assert.equal(store.job(job.id).torrentId, 'provider-id');
  assert.equal(downloads.list(user)[0].titleId, title.id);
});
