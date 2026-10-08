import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.mjs';
import { createCatalog } from '../src/catalog.mjs';
import { createNavigation } from '../src/navigation.mjs';
import { runtimeSeconds } from '../src/metadata.mjs';

test('runtime parsing normalizes catalog units without inventing missing durations', () => {
  for (const [value, seconds] of [
    [145, 8700],
    ['145 min', 8700],
    ['2h 25m', 8700],
    ['45 minutes', 2700],
    ['2 hours', 7200],
    ['0', undefined],
    ['N/A', undefined],
    ['90-120', undefined],
    [null, undefined],
  ])
    assert.equal(runtimeSeconds(value), seconds);
});

test('metadata refresh preserves identities and richer fields; TVmaze gives episode-specific runtimes', async (t) => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  let calls = 0,
    missing = false;
  const catalog = createCatalog(
    store,
    { catalogUrl: 'https://catalog.test' },
    {
      request: async (url) => {
        calls++;
        if (url.includes('lookup')) return { id: 12, runtime: 60, status: 'Ended' };
        if (url.includes('/episodes'))
          return [
            {
              id: 2,
              season: 1,
              number: 1,
              name: 'Pilot',
              runtime: 52,
              summary: '<p>Episode overview</p>',
            },
            { id: 3, season: 0, number: null, name: 'Unnumbered' },
          ];
        return {
          meta: {
            id: 'tt123',
            name: 'Series',
            cast: missing ? [] : ['Actor'],
            director: ['Director'],
            videos: [
              {
                season: 1,
                episode: 1,
                name: 'Pilot',
                thumbnail: missing ? '' : 'https://image.test/1.jpg',
              },
              { season: 1, episode: 2, name: 'Second' },
            ],
          },
        };
      },
    },
  );
  const title = await catalog.add('tv', 'tt123');
  const before = store.items(title.id);
  assert.equal(before.length, 2);
  assert.equal(before[0].runtimeSeconds, 3120);
  assert.equal(before[0].description, 'Episode overview');
  store.run('INSERT INTO history(user_id,item_id,position) VALUES(?,?,?)', 1, before[0].id, 12);
  missing = true;
  await catalog.refresh(title.id, true);
  assert.equal(store.items(title.id)[0].id, before[0].id);
  assert.equal(store.state(1, before[0].id).position, 12);
  assert.deepEqual(store.title(title.id).cast, ['Actor']);
  assert.equal(store.items(title.id)[0].thumbnail, 'https://image.test/1.jpg');
  const count = calls;
  await catalog.refresh(title.id);
  assert.equal(calls, count);
  const detail = createNavigation(store).detail({ id: 1, active: 1, role: 'member' }, title.id);
  assert.equal(detail.items[0].durationSeconds, 3120);
  assert.equal(detail.items[0].durationSource, 'TVmaze');
  assert.equal(detail.items[1].durationSeconds, 3600);
  assert.equal(detail.items[1].durationSource, 'estimate');
});

test('catalog outages retain saved metadata and back off; manual refresh reports errors', async (t) => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const title = store.saveTitle({
    kind: 'movie',
    external_id: 'tt1',
    name: 'Saved',
    runtimeSeconds: 5400,
  });
  let calls = 0;
  const catalog = createCatalog(
    store,
    {},
    {
      request: async () => {
        calls++;
        throw new Error('Offline');
      },
    },
  );
  assert.equal((await catalog.refresh(title.id)).runtimeSeconds, 5400);
  await catalog.refresh(title.id);
  assert.equal(calls, 1);
  await assert.rejects(catalog.refresh(title.id, true), /Offline/);
});

test('duration uses the playable local copy and never discloses a private copy', (t) => {
  const store = createStore(':memory:'),
    root = mkdtempSync(path.join(os.tmpdir(), 'mediawan-metadata-'));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const title = store.saveTitle({
    kind: 'movie',
    external_id: 'tt1',
    name: 'Movie',
    runtimeSeconds: 5400,
  });
  const item = store.saveItem({ title_id: title.id });
  const privatePath = path.join(root, 'private.mp4'),
    publicPath = path.join(root, 'public.mp4');
  writeFileSync(privatePath, 'x');
  writeFileSync(publicPath, 'x');
  store.addAsset({
    item_id: item.id,
    path: privatePath,
    bytes: 1,
    readers: [2],
    probe: { duration: 8888 },
    added_at: 1,
  });
  store.addAsset({
    item_id: item.id,
    path: publicPath,
    bytes: 1,
    probe: { duration: 5411.8, video: 'h264' },
    added_at: 2,
  });
  const detail = createNavigation(store).detail({ id: 1, active: 1, role: 'member' }, title.id);
  assert.equal(detail.items[0].durationSeconds, 5411.8);
  assert.equal(detail.items[0].durationSource, 'file');
  assert.equal(detail.items[0].fileInfo.video, 'h264');
  assert.equal(JSON.stringify(detail).includes(privatePath), false);
});
