import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog } from '../src/catalog.mjs';
import { createStore } from '../src/store.mjs';
import { assessQuality } from '../src/torrent-policy.mjs';

test('release search retains matching quality beyond the first 80 provider results', async (t) => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const title = store.saveTitle({ kind: 'movie', external_id: 'tt123', name: 'Fixture' });
  const item = store.saveItem({ title_id: title.id });
  const catalog = createCatalog(
    store,
    { releaseUrl: 'https://releases.test' },
    {
      request: async () => ({
        streams: [
          ...Array.from({ length: 80 }, () => ({
            infoHash: 'b'.repeat(40),
            title: 'Fixture 720p OTHER',
          })),
          { infoHash: 'a'.repeat(40), name: 'Torrentio 4K (YTS)', title: 'Fixture 2160p WEB-DL' },
        ],
      }),
    },
  );
  const releases = await catalog.releases(item.id);
  assert.deepEqual(
    releases
      .filter((release) => assessQuality(release, 'movie').accepted)
      .map((release) => release.hash),
    ['a'.repeat(40)],
  );
});

test('unified search includes all media types and passes the search text to each catalog', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://graphql.anilist.co');
    assert.equal(JSON.parse(options.body).variables.search, 'Northern light');
    return {
      ok: true,
      json: async () => ({
        data: {
          Page: {
            media: [{ id: 123, title: { english: 'Anime' }, coverImage: {}, startDate: {} }],
          },
        },
      }),
    };
  });
  const catalog = createCatalog(
    null,
    { catalogUrl: 'https://catalog.test' },
    {
      request: async (url) => {
        requests.push(url);
        const movie = url.includes('/movie/');
        return {
          metas: [
            { id: movie ? 'tt1' : 'tt2', name: movie ? 'Movie' : 'Series' },
            ...(movie ? [{ id: 'tt3', name: 'Second movie' }] : []),
          ],
        };
      },
    },
  );
  const items = await catalog.search('all', 'Northern light');
  assert.deepEqual(
    items.map((item) => item.kind),
    ['movie', 'tv', 'anime', 'movie'],
  );
  assert(requests.every((url) => url.endsWith('/search=Northern%20light.json')));
});

test('unified search retains other results when one catalog is unavailable', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Anime unavailable');
  });
  const catalog = createCatalog(
    null,
    { catalogUrl: 'https://catalog.test' },
    {
      request: async (url) => {
        if (url.includes('/movie/')) throw new Error('Movies unavailable');
        return { metas: [{ id: 'tt2', name: 'Series' }] };
      },
    },
  );
  assert.deepEqual(
    (await catalog.search('all', 'Series')).map((item) => item.kind),
    ['tv'],
  );
});

test('unified search reports an outage when every catalog fails', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Anime unavailable');
  });
  const catalog = createCatalog(
    null,
    {},
    {
      request: async () => {
        throw new Error('Catalog unavailable');
      },
    },
  );
  await assert.rejects(catalog.search('all', 'Title'), /Catalog unavailable/);
});
