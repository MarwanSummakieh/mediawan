import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configuration } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import {
  createTorrentPolicy,
  assessRelease,
  releaseFacts,
  defaultRules,
  assessQuality,
} from '../src/torrent-policy.mjs';
import { createTorrentDownloads } from '../src/torrent-downloads.mjs';
import { createQbitClient } from '../src/qbittorrent.mjs';

const candidate = {
  hash: 'a'.repeat(40),
  fileIndex: 0,
  label: 'Fixture.2160p.WEB-DL [YTS.MX]',
  seeders: 12,
  resolution: 2160,
  sizeBytes: 100,
};
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediawan-torrents-')),
    store = createStore(':memory:');
  store.run(
    "INSERT INTO users(id,email,name,pw_hash,role) VALUES(1,'admin@test','Test','x','admin')",
  );
  const user = store.one('SELECT * FROM users'),
    title = store.saveTitle({ kind: 'movie', external_id: 'tt1', name: 'Fixture' }),
    item = store.saveItem({ title_id: title.id });
  const policy = createTorrentPolicy(store),
    calls = [];
  let info,
    progress = 0,
    clock = 1000000;
  const client = {
    info: async () => info,
    files: async () => [{ index: 0, name: 'fixture.mp4', size: 100, progress }],
    stop: async () => {
      calls.push('stop');
      info.state = 'stoppedDL';
    },
    start: async () => {
      calls.push('start');
      info.state = 'downloading';
    },
    call: async (endpoint, data) => {
      calls.push([endpoint, data]);
      if (endpoint === 'torrents/add') {
        assert.equal(data.stopCondition, 'MetadataReceived');
        info = {
          category: 'mediawan',
          save_path: data.savepath,
          state: 'stoppedDL',
          num_seeds: 4,
          num_leechs: 2,
          dlspeed: 10,
          availability: 1,
        };
      }
      return 'Ok.';
    },
  };
  const worker = createTorrentDownloads(
    store,
    {
      ...configuration({}),
      qbitUrl: 'http://fixture',
      qbitSavePath: '/downloads',
      torrentDir: root,
      reserveBytes: 0,
    },
    policy,
    {
      client,
      now: () => clock,
      probeFile: async () => ({ duration: 5, video: 'h264', audio: [], subtitles: [] }),
    },
  );
  t.after(async () => {
    await worker.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    store,
    user,
    item,
    title,
    policy,
    worker,
    calls,
    root,
    client,
    setInfo: (value) => {
      info = value;
    },
    advance: (ms) => {
      clock += ms;
    },
    complete: (job) => {
      progress = 1;
      mkdirSync(path.join(root, job.id), { recursive: true });
      writeFileSync(path.join(root, job.id, 'fixture.mp4'), Buffer.alloc(100));
    },
  };
}
test('torrent search rules accept healthy 4K and reject low seeds, unknown facts, oversized and camera releases', () => {
  const facts = releaseFacts({
    name: 'Torrentio 4k',
    title: 'Film.2160p.WEB-DL [YTS.MX]\n👤 18 💾 55.6 GB',
  });
  assert.equal(facts.seeders, 18);
  assert.equal(facts.resolution, 2160);
  assert(assessRelease(facts, 'movie', defaultRules).accepted);
  for (const patch of [
    { seeders: 0 },
    { seeders: null },
    { resolution: null },
    { sizeBytes: 101 * 1073741824 },
    { label: 'Film.1080p.HDCAM' },
    { label: 'Film 720p HQ PreDVD' },
    { label: 'Film - Prologue (2025) 4K' },
    { label: 'Film 2026 (NOT The Chris Nolan FILM) 1080p' },
  ])
    assert(!assessRelease({ ...facts, ...patch }, 'movie', defaultRules).accepted);
  assert(!assessRelease(facts, 'tv', defaultRules).accepted);
});
test('torrent settings are durable and validate bounded values', (t) => {
  const f = fixture(t);
  f.policy.set({ minSeeders: 12 });
  assert.equal(createTorrentPolicy(f.store).get().minSeeders, 12);
  assert.throws(() => f.policy.set({ minSeeders: -1 }), /Invalid/);
  assert.throws(() => f.policy.set({ maxConcurrent: 1.5 }), /whole/);
  assert.throws(() => f.policy.set({ resolutions: [] }), /Invalid/);
  assert.throws(() => f.policy.set({ resolutions: [720, 1080, 2160] }), /Invalid/);
  f.store.run(
    "UPDATE settings SET json=? WHERE key='torrentRules'",
    JSON.stringify({ resolutions: [720] }),
  );
  assert.deepEqual(f.policy.get().resolutions, [1080, 2160]);
});

test('mandatory YTS quality is exact for every media kind and cannot be relaxed by torrent settings', () => {
  const episode = { ...candidate, label: 'Show.1080p.WEB-DL [YTS.MX]', resolution: 1080 };
  const relaxed = {
    ...defaultRules,
    rejectUnknown: false,
    minSeeders: 0,
    resolutions: [480, 720, 1080, 2160],
  };
  assert(assessQuality(candidate, 'movie').accepted);
  for (const source of ['WEB-DL', 'WEB DL', 'WEB.DL', 'WEB_DL', 'WEBDL'])
    assert(assessQuality({ ...candidate, label: `Film 2160p ${source} [YTS]` }, 'movie').accepted);
  for (const kind of ['tv', 'anime']) {
    for (const source of ['WEB-DL', 'WEB DL', 'WEB.DL', 'WEB_DL', 'WEBDL'])
      assert(assessQuality({ ...episode, label: `Show 1080p ${source} [yts.mx]` }, kind).accepted);
    for (const patch of [
      { label: 'Show 1080p WEB-DL [OTHER]' },
      { label: 'Show 1080p WEB-DL [YTSFake]' },
      { label: 'Show 1080p BluRay [YTS]' },
      { label: 'Show 1080p WEBRip [YTS]' },
      { label: 'Show 1080p WEB-DL BluRay [YTS]' },
      { resolution: 2160 },
      { resolution: 720 },
      { resolution: null },
      { filename: 'Show.720p.WEB-DL.mp4' },
      { filename: 'Show.1080p.WEBRip.mp4' },
    ])
      assert(
        !assessRelease({ ...episode, ...patch }, kind, relaxed).accepted,
        JSON.stringify(patch),
      );
  }
  for (const patch of [
    { resolution: 1080 },
    { resolution: null },
    { label: 'Film 2160p OTHER' },
    { label: 'Film 2160p [YTS]' },
    { label: 'Film 2160p WEBRip [YTS]' },
    { label: 'Film 2160p BluRay [YTS]' },
    { label: 'Film 2160p WEB-DL BluRay [YTS]' },
    { filename: 'Film.1080p.mp4' },
    { filename: 'Film.2160p.WEBRip.mp4' },
    { filename: 'Film.2160p.BluRay.mp4' },
  ])
    assert(!assessRelease({ ...candidate, ...patch }, 'movie', relaxed).accepted);
  const providerName = releaseFacts({
    name: 'Torrentio 4K (YTS)',
    title: 'Film WEB-DL\n👤 20 💾 2 GB',
  });
  assert(assessQuality(providerName, 'movie').accepted);
  assert.equal(releaseFacts({ name: 'Torrentio 4K', title: 'Film 1080p [YTS]' }).resolution, 1080);
});

test('torrent metadata cannot downgrade the selected movie quality', async (t) => {
  const f = fixture(t);
  const job = await f.worker.enqueue(f.user, f.item.id, candidate);
  await f.worker.tick();
  f.client.files = async () => [{ index: 0, name: 'Film.1080p.mp4', size: 100, progress: 0 }];
  await f.worker.tick();
  assert.equal(f.store.job(job.id).state, 'failed');
  assert.match(f.store.job(job.id).error, /2160p|resolution/);
  assert(!f.calls.includes('start'));
});
test('torrent worker selects only the requested file, pauses, resumes and publishes verified local media', async (t) => {
  const f = fixture(t),
    job = await f.worker.enqueue(f.user, f.item.id, candidate);
  await f.worker.tick();
  await f.worker.tick();
  assert.equal(f.store.job(job.id).state, 'downloading');
  assert.deepEqual(
    f.calls.filter((c) => c[0] === 'torrents/filePrio').map((c) => c[1].priority),
    ['0', '1'],
  );
  await f.worker.action(f.user, job.id, 'pause');
  assert.equal(f.store.job(job.id).state, 'paused');
  await f.worker.action(f.user, job.id, 'resume');
  assert.equal(f.store.job(job.id).state, 'queued');
  await f.worker.tick();
  f.complete(job);
  await f.worker.tick();
  assert.equal(f.store.job(job.id).state, 'ready', f.store.job(job.id).error);
  assert.equal(f.store.assets(f.item.id).length, 1);
});

test('the same hash cannot be queued twice before qBittorrent receives the first job', async (t) => {
  const f = fixture(t);
  const other = f.store.saveItem({ title_id: f.title.id, season: 1, episode: 2 });
  await f.worker.enqueue(f.user, f.item.id, candidate);
  await assert.rejects(f.worker.enqueue(f.user, other.id, candidate), /queued for another episode/);
  assert.equal(f.store.all('SELECT * FROM jobs').length, 1);
});
test('stalled torrents stop without switching releases', async (t) => {
  const f = fixture(t),
    job = await f.worker.enqueue(f.user, f.item.id, candidate);
  await f.worker.tick();
  await f.worker.tick();
  f.advance(11 * 60000);
  await f.worker.tick();
  assert.equal(f.store.job(job.id).state, 'failed');
  assert.match(f.store.job(job.id).error, /stall timeout/);
  assert.equal(f.calls.filter((c) => c[0] === 'torrents/add').length, 1);
  assert(f.calls.includes('stop'));
});
test('metadata timeout and actual oversized files stop before downloading', async (t) => {
  const f = fixture(t),
    job = await f.worker.enqueue(f.user, f.item.id, candidate);
  await f.worker.tick();
  f.client.files = async () => [];
  await f.worker.action(f.user, job.id, 'pause');
  await f.worker.action(f.user, job.id, 'resume');
  await f.worker.tick();
  assert.equal(f.store.job(job.id).state, 'checking');
  assert.equal(f.calls.filter((c) => c === 'start').length, 1);
  f.advance(4 * 60000);
  await f.worker.tick();
  assert.equal(f.store.job(job.id).state, 'failed');
  assert.match(f.store.job(job.id).error, /metadata/);
  await f.worker.action(f.user, job.id, 'retry');
  f.client.files = async () => [
    { index: 0, name: 'fixture.mp4', size: 101 * 1073741824, progress: 0 },
  ];
  await f.worker.tick();
  assert.equal(f.store.job(job.id).state, 'failed');
  assert.match(f.store.job(job.id).error, /size limit/);
  assert.equal(f.calls.filter((c) => c === 'start').length, 1);
});
test('rules and item access cannot be bypassed at enqueue; unrelated torrents stay untouched', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.worker.enqueue(f.user, f.item.id, { ...candidate, seeders: 1 }),
    /seeders/,
  );
  await assert.rejects(
    f.worker.enqueue({ ...f.user, role: 'member', can_download: 0 }, f.item.id, candidate),
    /permission/,
  );
  const job = await f.worker.enqueue(f.user, f.item.id, candidate);
  f.setInfo({ category: 'personal', save_path: '/elsewhere', state: 'downloading' });
  await f.worker.tick();
  assert.equal(f.store.job(job.id).state, 'failed');
  assert.equal(f.calls.length, 0);
});
test('qBittorrent client accepts current 204 logins and renews expired sessions', async () => {
  let logins = 0,
    requests = 0;
  const client = createQbitClient(
    { qbitUrl: 'http://localhost:8801', qbitUsername: 'admin', qbitPassword: 'secret' },
    async (url, options) => {
      assert.equal(options.redirect, 'error');
      if (url.endsWith('/login')) {
        logins++;
        return new Response(null, {
          status: 204,
          headers: { 'set-cookie': `SID=${logins}; HttpOnly` },
        });
      }
      requests++;
      if (requests === 1) return new Response('', { status: 403 });
      assert.equal(options.headers.Cookie, 'SID=2');
      return new Response('v5.2.4');
    },
  );
  assert.equal((await client.health()).version, 'v5.2.4');
  assert.equal(logins, 2);
});
