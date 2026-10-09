import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.mjs';
import { configuration } from '../src/config.mjs';
import { createTorrentPolicy } from '../src/torrent-policy.mjs';
import { createSeasonDownloads } from '../src/season-downloads.mjs';
import { createApplication } from '../src/app.mjs';

function fixture(t, count = 3) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediawan-season-'));
  const database = path.join(root, 'test.sqlite');
  const store = createStore(database);
  store.run(
    "INSERT INTO users(id,email,name,pw_hash,role,can_download) VALUES(1,'admin@test','Admin','x','admin',1),(2,'viewer@test','Viewer','x','member',0)",
  );
  const user = store.one('SELECT * FROM users WHERE id=1');
  const title = store.saveTitle({ kind: 'tv', external_id: 'tt123', name: 'Fixture' });
  const items = Array.from({ length: count }, (_, index) =>
    store.saveItem({ title_id: title.id, season: 1, episode: index + 1 }),
  );
  const config = {
    ...configuration({}),
    debridToken: 'not-contacted',
    qbitUrl: 'http://not-contacted.invalid',
  };
  const calls = [];
  let jobCount = 0;
  const engine = {
    enqueue(who, itemId, release) {
      calls.push({ who, itemId, release });
      return store.saveJob({
        id: 'job-' + ++jobCount,
        user_id: who.id,
        provider: 'torrent',
        item_id: itemId,
        state: 'queued',
        hash: release.hash,
        bytes: 0,
      });
    },
    close: async () => {},
  };
  const release = (hash = 'a', extra = {}) => ({
    hash: hash.repeat(40),
    label: 'Fixture 1080p WEB-DL [YTS.MX]',
    resolution: 1080,
    sizeBytes: 100,
    seeders: 10,
    ...extra,
  });
  const catalog = { releases: async () => [release()] };
  const policy = createTorrentPolicy(store);
  const service = createSeasonDownloads(store, config, catalog, engine, engine, policy);
  t.after(async () => {
    await service.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    database,
    store,
    user,
    title,
    items,
    config,
    calls,
    engine,
    release,
    catalog,
    policy,
    service,
  };
}

test('season downloads skip existing media, queued episodes and future releases without crossing seasons', async (t) => {
  const f = fixture(t, 5);
  const file = path.join(f.root, 'existing.mp4');
  writeFileSync(file, 'video');
  f.store.addAsset({ item_id: f.items[0].id, path: file, bytes: 5, readers: [1] });
  f.engine.enqueue(f.user, f.items[1].id, f.release());
  f.calls.length = 0;
  f.store.saveItem({ ...f.items[2], released: '2099-01-01' });
  f.store.saveItem({ title_id: f.title.id, season: 2, episode: 1 });
  const batch = f.service.create(f.user, f.title.id, 1, {
    provider: 'realdebrid',
    resolution: 1080,
  });
  assert.deepEqual(
    batch.items.map((i) => i.state),
    ['downloaded', 'already_queued', 'unreleased', 'pending', 'pending'],
  );
  // Repeated clicks reuse the durable batch rather than queueing twice.
  assert.equal(
    f.service.create(f.user, f.title.id, 1, { provider: 'realdebrid', resolution: 1080 }).id,
    batch.id,
  );
  await f.service.tick();
  await f.service.tick();
  assert.deepEqual(
    f.calls.map((call) => call.itemId),
    [f.items[3].id, f.items[4].id],
  );
  assert.equal(f.service.list(f.user)[0].state, 'finished');
});

test('season resolution is durable across worker recreation and selects the chosen quality only', async (t) => {
  const f = fixture(t, 2);
  f.catalog.releases = async () => [
    f.release('b', { resolution: 2160, seeders: 100 }),
    f.release('a'),
  ];
  f.service.create(f.user, f.title.id, 1, { provider: 'realdebrid', resolution: 1080 });
  await f.service.tick();
  await f.service.close();
  const reloaded = createStore(f.database);
  const next = createSeasonDownloads(
    reloaded,
    f.config,
    f.catalog,
    f.engine,
    f.engine,
    createTorrentPolicy(reloaded),
  );
  try {
    await next.tick();
    assert.equal(next.list(f.user)[0].state, 'finished');
    assert.equal(f.calls.length, 2);
    assert(f.calls.every((call) => call.release.resolution === 1080));
  } finally {
    await next.close();
    reloaded.close();
  }
});

test('season quality is locked and never falls back to a popular release from another source', async (t) => {
  for (const provider of ['torrent', 'realdebrid']) {
    const f = fixture(t, 2);
    assert.deepEqual(f.service.options(f.user, f.title.id, 1).resolutions, [1080]);
    assert.throws(
      () => f.service.create(f.user, f.title.id, 1, { provider, resolution: 2160 }),
      /allowed quality/,
    );
    f.catalog.releases = async (itemId) => [
      f.release('b', { label: 'Show 1080p WEB-DL OTHER', seeders: 9999 }),
      f.release('c', { label: 'Show 1080p WEBRip [YTS]', seeders: 9999 }),
      f.release('d', { resolution: 720, seeders: 9999 }),
      ...(itemId === f.items[0].id ? [f.release()] : []),
    ];
    f.service.create(f.user, f.title.id, 1, { provider, resolution: 1080 });
    await f.service.tick();
    await f.service.tick();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].release.hash, 'a'.repeat(40));
    assert.equal(f.service.list(f.user)[0].items[1].state, 'unavailable');
  }
});

test('season downloads exclude private episodes and scope batch status to its owner', async (t) => {
  const f = fixture(t);
  f.store.run('UPDATE users SET can_download=1 WHERE id=2');
  const member = f.store.one('SELECT * FROM users WHERE id=2');
  const file = path.join(f.root, 'private.mp4');
  writeFileSync(file, 'video');
  f.store.addAsset({ item_id: f.items[0].id, path: file, bytes: 5, readers: [1] });
  const batch = f.service.create(member, f.title.id, 1, {
    provider: 'realdebrid',
    resolution: 1080,
  });
  assert.deepEqual(
    batch.items.map((item) => item.id),
    f.items.slice(1).map((item) => item.id),
  );
  f.store.run(
    "INSERT INTO users(id,email,name,pw_hash,role,can_download) VALUES(3,'other@test','Other','x','member',1)",
  );
  const other = f.store.one('SELECT * FROM users WHERE id=3');
  assert.deepEqual(f.service.list(other), []);
  assert.throws(() => f.service.stop(other, batch.id), /not found/);
});

test('direct season downloads enforce source rules and avoid sharing torrent hashes across episodes', async (t) => {
  const f = fixture(t);
  f.catalog.releases = async (itemId) =>
    itemId === f.items[1].id
      ? [f.release('a', { seeders: 20 }), f.release('b'), f.release('c', { seeders: 1 })]
      : [f.release('a')];
  f.service.create(f.user, f.title.id, 1, { provider: 'torrent', resolution: 1080 });
  await f.service.tick();
  await f.service.tick();
  await f.service.tick();
  assert.deepEqual(
    f.calls.map((call) => call.release.hash),
    ['a'.repeat(40), 'b'.repeat(40)],
  );
  const batch = f.service.list(f.user)[0];
  assert.equal(batch.state, 'finished');
  assert.equal(batch.items[2].state, 'unavailable');
  assert.match(batch.items[2].error, /another episode/);
});

test('unavailable episodes are reported and source failures do not prevent the rest of a season', async (t) => {
  const f = fixture(t);
  f.catalog.releases = async (key) => {
    if (key === f.items[0].id) throw new Error('Catalog failed');
    return key === f.items[1].id ? [f.release('b', { resolution: 720 })] : [f.release()];
  };
  f.service.create(f.user, f.title.id, 1, { provider: 'realdebrid', resolution: 1080 });
  await f.service.tick();
  await f.service.tick();
  await f.service.tick();
  assert.deepEqual(
    f.service.list(f.user)[0].items.map((i) => i.state),
    ['unavailable', 'unavailable', 'queued'],
  );
  assert.equal(f.calls.length, 1);
});

test('stopping or revoking permissions during a lookup prevents acquisition', async (t) => {
  const f = fixture(t);
  let releaseLookup;
  f.catalog.releases = () =>
    new Promise((resolve) => {
      releaseLookup = resolve;
    });
  const batch = f.service.create(f.user, f.title.id, 1, {
    provider: 'realdebrid',
    resolution: 1080,
  });
  const running = f.service.tick();
  f.service.stop(f.user, batch.id);
  releaseLookup([f.release()]);
  await running;
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.list(f.user)[0].state, 'stopped');
  f.service.create(f.user, f.title.id, 1, { provider: 'realdebrid', resolution: 1080 });
  const next = f.service.tick();
  f.store.run("UPDATE users SET role='member',can_download=0 WHERE id=1");
  releaseLookup([f.release()]);
  await next;
  assert.equal(f.calls.length, 0);
});

test('season API enforces authentication, permissions and server-selected season membership', async (t) => {
  const f = fixture(t);
  const app = createApplication(
    { ...f.config, adminEmail: '', adminPassword: '' },
    { store: f.store, catalog: f.catalog, downloads: f.engine, torrents: f.engine },
  );
  const server = app.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.seasons.close();
    await app.media.close();
  });
  // Use short-lived fixture sessions; password login has its own integration coverage.
  const { createHash } = await import('node:crypto');
  for (const [token, uid] of [
    ['admin', 1],
    ['viewer', 2],
  ])
    f.store.run(
      'INSERT INTO logins VALUES(?,?,?)',
      createHash('sha256').update(token).digest('hex'),
      uid,
      Date.now() + 60000,
    );
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = base + `/api/titles/${f.title.id}/seasons/1/downloads`;
  const send = (token, body = { provider: 'realdebrid', resolution: 1080 }) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `mediawan=${token}` },
      body: JSON.stringify(body),
    });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await send('viewer')).status, 403);
  assert.equal((await send('admin', { provider: 'forged', resolution: 1080 })).status, 400);
  assert.equal((await send('admin', { provider: 'realdebrid', resolution: 999 })).status, 400);
  const other = f.store.saveItem({ title_id: f.title.id, season: 2, episode: 1 });
  const response = await send('admin', {
    provider: 'realdebrid',
    resolution: 1080,
    items: [other.id],
  });
  assert.equal(response.status, 202);
  const batch = await response.json();
  assert.deepEqual(
    batch.items.map((i) => i.id),
    f.items.map((i) => i.id),
  );
  assert.equal(
    (
      await fetch(base + `/api/season-downloads/${batch.id}/stop`, {
        method: 'POST',
        headers: { Cookie: 'mediawan=viewer', 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    404,
  );
  await app.seasons.tick();
  assert.equal(f.calls.length, 1);
});
