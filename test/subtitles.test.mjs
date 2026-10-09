import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.mjs';
import { configuration } from '../src/config.mjs';
import { createApplication } from '../src/app.mjs';
import { createSubtitles, decodeSubtitle } from '../src/subtitles.mjs';
import {
  subtitleStyle,
  subtitleDefaults,
  shiftSubtitleCues,
  srtToVtt,
} from '../public/subtitles.js';

const srt = '1\r\n00:00:10,000 --> 00:00:12,500\r\n<i>Hello</i>\r\n';
test('SRT and legacy subtitle encodings retain text and WebVTT formatting', () => {
  assert.match(srtToVtt(srt), /^WEBVTT\n\n1\n00:00:10\.000 --> 00:00:12\.500\n<i>Hello<\/i>/);
  assert.equal(
    srtToVtt('\uFEFFWEBVTT\n\n00:10.000 --> 00:12.500\nHi'),
    'WEBVTT\n\n00:10.000 --> 00:12.500\nHi',
  );
  assert.equal(decodeSubtitle(Buffer.from([0xc7, 0xe1]), 'ara'), 'ال');
  assert.equal(decodeSubtitle(Buffer.from([0xc7, 0xe1]), 'ar'), 'ال');
  const arabic = 'مرحباً بالعالم! الحلقة 12 — Mediawan';
  assert.equal(decodeSubtitle(Buffer.from(arabic), 'ara'), arabic);
  assert.match(srtToVtt(srt.replace('<i>Hello</i>', arabic)), /مرحباً بالعالم/);
  assert.equal(
    decodeSubtitle(
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Hello', 'utf16le')]),
      'eng',
    ),
    'Hello',
  );
});
test('subtitle style migrates the previous device settings and clamps invalid values', () => {
  assert.deepEqual(subtitleStyle(null), subtitleDefaults);
  assert.deepEqual(
    subtitleStyle({
      size: 'xl',
      color: 'grey',
      bg: 'navy',
      pos: 500,
      align: 'right',
      bgOpacity: -1,
    }),
    { size: 'xl', color: 'grey', bg: 'navy', pos: 80, align: 'right', bgOpacity: 0 },
  );
  assert.deepEqual(
    subtitleStyle({ size: 'invalid', color: '<script>', pos: 'bad' }),
    subtitleDefaults,
  );
});
test('timing nudges and conversion offsets use original cues without accumulating drift', () => {
  const cue = { startTime: 100, endTime: 103 },
    originals = new WeakMap();
  shiftSubtitleCues([cue], 0.5, 90, originals);
  assert.deepEqual(cue, { startTime: 10.5, endTime: 13.5 });
  shiftSubtitleCues([cue], -1, 90, originals);
  assert.deepEqual(cue, { startTime: 9, endTime: 12 });
  shiftSubtitleCues([cue], 0, 0, originals);
  assert.deepEqual(cue, { startTime: 100, endTime: 103 });
  const extracted = { startTime: 10, endTime: 13 };
  shiftSubtitleCues([extracted], 1);
  assert.equal(extracted.startTime, 11);
});
function fixture(t, titleInput = {}, closeStore = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediawan-subs-'));
  const store = createStore(':memory:');
  const title = store.saveTitle({
    kind: 'movie',
    external_id: 'tt0816692',
    name: 'Fixture',
    ...titleInput,
  });
  const item = store.saveItem({ title_id: title.id, season: 1, episode: 1 });
  const file = path.join(root, 'sample.mp4');
  writeFileSync(file, 'fixture');
  store.addAsset({ item_id: item.id, path: file, bytes: 7, readers: [1] });
  t.after(() => {
    if (closeStore) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, item, user: { id: 1, active: 1, role: 'viewer' } };
}
test('online subtitles offer release variants, proxy VTT and enforce access and download hosts', async (t) => {
  const { store, item, user } = fixture(t),
    urls = [];
  const service = createSubtitles(store, {
    fetch: async (url) => {
      urls.push(url);
      if (url.includes('/subtitles/movie/'))
        return Response.json({
          subtitles: [
            ...Array.from({ length: 6 }, (_, i) => ({
              id: i,
              lang: 'eng',
              url: `https://subs5.strem.io/en/download/${i}`,
            })),
            { lang: 'dan', url: 'https://dl.opensubtitles.org/danish.srt' },
            { lang: 'ara', url: 'https://subs5.strem.io/ar/download/1' },
            { lang: 'eng', url: 'http://127.0.0.1/private' },
          ],
        });
      return new Response(srt);
    },
  });
  const tracks = await service.list(user, item.id);
  assert.equal(tracks.length, 6);
  assert.equal(tracks.find((track) => track.language === 'ara').label, 'Arabic · العربية');
  assert.equal(tracks.filter((track) => track.language === 'eng').length, 4);
  assert(!tracks.some((track) => 'url' in track));
  assert.match(await service.file(user, item.id, tracks[0].id), /00:00:10\.000/);
  assert.equal(urls.filter((url) => url.includes('/subtitles/movie/')).length, 1);
  await assert.rejects(service.list({ ...user, id: 2 }, item.id), /unavailable/);
  await assert.rejects(service.file(user, item.id, 'missing'), /not found/);
});
test('subtitle downloads reject redirects to private hosts and expose provider errors', async (t) => {
  const { store, item, user } = fixture(t);
  const service = createSubtitles(store, {
    fetch: async (url) =>
      url.includes('/subtitles/movie/')
        ? Response.json({
            subtitles: [{ lang: 'eng', url: 'https://subs5.strem.io/en/download/1' }],
          })
        : new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }),
  });
  const [track] = await service.list(user, item.id);
  await assert.rejects(service.file(user, item.id, track.id), /unsupported download/);
  const unavailable = createSubtitles(store, {
    fetch: async () => new Response('', { status: 503 }),
  });
  await assert.rejects(unavailable.list(user, item.id), /provider is unavailable/);
});
test('anime subtitle lookup maps split-season episode offsets', async (t) => {
  const { store, item, user } = fixture(t, { kind: 'anime', external_id: '123' });
  const urls = [];
  const service = createSubtitles(store, {
    fetch: async (url) => {
      urls.push(url);
      if (url.includes('arm.haglund.dev'))
        return Response.json({ imdb: 'tt123', anidb: 42, 'thetvdb-season': 4 });
      if (url.includes('anime-list-full.xml'))
        return new Response('<anime anidbid="42" defaulttvdbseason="4" episodeoffset="16">');
      return Response.json({ subtitles: [] });
    },
  });
  assert.deepEqual(await service.list(user, item.id), []);
  assert(urls.includes('https://opensubtitles-v3.strem.io/subtitles/series/tt123:4:17.json'));
});
test('subtitle listing and VTT routes require authentication and use local item identity', async (t) => {
  const { store, item } = fixture(t, {}, false);
  const application = createApplication(
    { ...configuration({}), adminEmail: 'subs@example.test', adminPassword: 'fixture-password' },
    {
      store,
      subtitles: {
        fetch: async (url) =>
          url.includes('/subtitles/movie/')
            ? Response.json({
                subtitles: [{ lang: 'eng', url: 'https://subs5.strem.io/en/download/1' }],
              })
            : new Response(srt),
      },
    },
  );
  const server = application.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await application.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/items/${item.id}/subtitles`)).status, 401);
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'subs@example.test', password: 'fixture-password' }),
  });
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  const list = await fetch(`${base}/api/items/${item.id}/subtitles`, { headers });
  assert.equal(list.status, 200);
  const [track] = await list.json();
  const vtt = await fetch(`${base}/api/items/${item.id}/subtitles/online/${track.id}`, { headers });
  assert.equal(vtt.status, 200);
  assert.match(vtt.headers.get('content-type'), /text\/vtt/);
  assert.match(await vtt.text(), /^WEBVTT/);
});
