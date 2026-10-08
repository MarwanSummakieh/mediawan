import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../src/app.mjs';
import { configuration } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';

test('torrent enqueue rechecks catalog facts and administrator rules instead of trusting browser claims', async (t) => {
  const store = createStore(':memory:');
  const title = store.saveTitle({ kind: 'movie', external_id: 'tt1', name: 'Fixture' }),
    item = store.saveItem({ title_id: title.id });
  const release = {
    hash: 'a'.repeat(40),
    fileIndex: 0,
    label: 'Fixture 2160p',
    seeders: 1,
    resolution: 2160,
    sizeBytes: 100,
  };
  const app = createApplication(
    {
      ...configuration({}),
      qbitUrl: 'http://not-contacted.invalid',
      adminEmail: 'admin@example.test',
      adminPassword: 'fixture-password',
    },
    { store, catalog: { releases: async () => [release] } },
  );
  const server = app.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await app.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.test', password: 'fixture-password' }),
  });
  const headers = {
    'Content-Type': 'application/json',
    Cookie: login.headers.get('set-cookie').split(';')[0],
  };
  const rules = await fetch(base + '/api/admin/torrent-rules', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ minSeeders: 8 }),
  });
  assert.equal(rules.status, 200);
  const list = await (await fetch(base + `/api/items/${item.id}/releases`, { headers })).json();
  assert.equal(list.items[0].accepted, false);
  const download = await fetch(base + `/api/items/${item.id}/download`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...release, provider: 'torrent', seeders: 999, accepted: true }),
  });
  assert.equal(download.status, 400);
  assert.match((await download.json()).error, /8 reported seeders/);
  assert.equal(store.all('SELECT * FROM jobs').length, 0);
});
test('authentication, CSRF, preferences, role checks and anonymous API denial', async (t) => {
  const store = createStore(':memory:');
  const application = createApplication(
    { ...configuration({}), adminEmail: 'admin@example.test', adminPassword: 'fixture-password' },
    { store },
  );
  const server = application.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await application.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/home')).status, 401);
  const response = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.test', password: 'fixture-password' }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/api/home', { headers })).status, 200);
  assert.equal(
    (
      await fetch(base + '/api/preferences', {
        method: 'PATCH',
        headers: { ...headers, Origin: 'https://evil.invalid' },
        body: '{}',
      })
    ).status,
    403,
  );
  const prefs = {
    autoplay: false,
    audioLanguage: 'dan',
    subtitleLanguage: 'eng',
    subtitleMode: 'preferred',
  };
  assert.equal(
    (
      await fetch(base + '/api/preferences', {
        method: 'PATCH',
        headers,
        body: JSON.stringify(prefs),
      })
    ).status,
    200,
  );
  assert.deepEqual(await (await fetch(base + '/api/preferences', { headers })).json(), prefs);
  assert.equal(
    (
      await fetch(base + '/api/queues', {
        method: 'POST',
        headers,
        body: JSON.stringify({ items: [], mode: 'shuffle' }),
      })
    ).status,
    400,
  );
  await fetch(base + '/api/logout', { method: 'POST', headers, body: '{}' });
  assert.equal((await fetch(base + '/api/home', { headers })).status, 401);
});
