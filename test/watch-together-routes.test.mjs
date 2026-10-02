import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createWatchTogetherStore } from '../lib/watch-together.mjs';
import { mountWatchTogetherRoutes, createWatchTogetherLimiter } from '../lib/watch-together-routes.mjs';

const media = { kind: 'movie', id: 'tt1234567', title: 'A movie' };
const state = { position: 20, paused: true, rate: 1 };

async function fixture(t, options = {}) {
  const app = express();
  const requireAuth = (req, res, next) => {
    const id = req.get('X-Test-User');
    if (!id) return res.status(401).json({ error: 'auth required' });
    req.user = { id, name: `Viewer ${id}` };
    next();
  };
  const store = createWatchTogetherStore(options.storeOptions);
  mountWatchTogetherRoutes(app, { requireAuth, store, limiter: createWatchTogetherLimiter(options.limiterOptions) });
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}/api/watch-together`;
  async function request(path = '', { user = 'host', token, method = 'GET', body, rawBody, contentType = 'application/json' } = {}) {
    const headers = {};
    if (contentType !== null) headers['Content-Type'] = contentType;
    if (user !== null) headers['X-Test-User'] = user;
    if (token) headers['X-Watch-Member'] = token;
    const response = await fetch(base + path, { method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const result = await response.json();
    return { status: response.status, body: result, headers: response.headers };
  }
  return { request, store };
}

test('every room route requires authentication, including creation and code-based joining', async t => {
  const { request } = await fixture(t);
  for (const [path, method, body] of [
    ['', 'POST', { media, state }], ['/ABCDEFGH/join', 'POST'],
    ['/ABCDEFGH', 'GET'], ['/ABCDEFGH/state', 'POST', { state }], ['/ABCDEFGH/leave', 'POST'],
  ]) {
    const response = await request(path, { method, body, user: null });
    assert.equal(response.status, 401);
  }
});

test('authenticated devices join, observe host controls and leave through the HTTP contract', async t => {
  const { request } = await fixture(t);
  const created = await request('', { method: 'POST', body: { media, state } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const { code, hostId } = created.body.room;
  assert.equal(hostId, created.body.memberId);
  const joined = await request(`/${code.toLowerCase()}/join`, { method: 'POST', user: 'guest' });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.room.members.length, 2);
  const changedState = { position: 120, paused: false, rate: 1.5 };
  const updated = await request(`/${code}/state`, {
    method: 'POST', token: created.body.memberToken, body: { state: changedState },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.room.state.revision, 2);
  const observed = await request(`/${code}`, { user: 'guest', token: joined.body.memberToken });
  assert.equal(observed.status, 200);
  assert.equal(observed.body.room.state.position, 120);
  assert.equal(observed.body.room.state.paused, false);
  const left = await request(`/${code}/leave`, { method: 'POST', token: created.body.memberToken });
  assert.deepEqual(left.body, { ok: true });
  const transferred = await request(`/${code}`, { user: 'guest', token: joined.body.memberToken });
  assert.equal(transferred.body.room.hostId, joined.body.memberId);
  assert.equal(transferred.body.room.state.paused, true);
  assert.ok(transferred.body.room.state.position >= 120);
  assert.ok(!JSON.stringify(transferred.body.room).includes(joined.body.memberToken));
});

test('invite codes and public ids never substitute for member secrets, and tokens are account-bound', async t => {
  const { request } = await fixture(t);
  const created = await request('', { method: 'POST', body: { media, state } });
  const { code } = created.body.room;
  for (const options of [
    { user: 'guest' }, { user: 'host', token: code },
    { user: 'host', token: created.body.memberId }, { user: 'host', token: 'a'.repeat(64) },
    { user: 'guest', token: created.body.memberToken },
  ]) assert.equal((await request(`/${code}`, options)).status, 403);
  assert.equal((await request(`/${code}?memberToken=${created.body.memberToken}`)).status, 403);
  assert.equal((await request(`/${code}/state`, {
    method: 'POST', body: { state, memberToken: created.body.memberToken },
  })).status, 403);
  const joined = await request(`/${code}/join`, { method: 'POST', user: 'guest' });
  assert.equal((await request(`/${code}/state`, {
    method: 'POST', user: 'guest', token: joined.body.memberToken, body: { state: { ...state, position: 999 } },
  })).status, 403);
  assert.equal((await request(`/${code}/leave`, {
    method: 'POST', user: 'guest', token: created.body.memberToken,
  })).status, 403);
  assert.equal((await request(`/${code}`, { token: created.body.memberToken })).body.room.state.position, 20);
});

test('HTTP media and state validation reject URLs and invalid scalar data without changing the room', async t => {
  const { request, store } = await fixture(t);
  for (const body of [
    {}, { media: { ...media, id: 'https://example.com/video' }, state },
    { media: { ...media, url: 'https://example.com/video' }, state },
    { media, state: { ...state, rate: 0 } }, { media, state: { ...state, paused: 'false' } },
    { media: { kind: 'tv', id: 'tt123', title: 'Missing episode', season: 1 }, state },
    { media: { kind: 'tv', id: 'tt123', title: 'Missing season', episode: '1' }, state },
  ]) assert.equal((await request('', { method: 'POST', body })).status, 400);
  assert.equal(store.size, 0);
  const created = await request('', { method: 'POST', body: { media, state } });
  const { code } = created.body.room;
  assert.equal((await request(`/${code}/state`, {
    method: 'POST', token: created.body.memberToken,
    body: { media: { ...media, title: 'Changed' }, state: { ...state, position: -1 } },
  })).status, 400);
  assert.equal((await request(`/${code}`, { token: created.body.memberToken })).body.room.media.title, media.title);
  assert.equal((await request('/bad-code/join', { method: 'POST' })).status, 400);
  assert.equal((await request('/ABCDEFGH/join', { method: 'POST' })).status, 404);
});

test('room mutations reject form posts and return useful JSON errors for malformed or oversized bodies', async t => {
  const { request, store } = await fixture(t);
  const created = await request('', { method: 'POST', body: { media, state } });
  const { code } = created.body.room;
  for (const path of ['', `/${code}/join`, `/${code}/state`, `/${code}/leave`]) {
    const response = await request(path, { method: 'POST', contentType: 'application/x-www-form-urlencoded', rawBody: 'position=20' });
    assert.equal(response.status, 415);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await request(`/${code}/join`, { method: 'POST', contentType: null })).status, 415);
  const malformed = await request('', { method: 'POST', rawBody: '{"media":' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error, 'The watch room request contains invalid JSON.');
  const oversized = await request('', { method: 'POST', body: { padding: 'x'.repeat(5_000) } });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error, 'The watch room request is too large.');
  assert.equal(store.size, 1);
});

test('same-account devices remain independent and only the host device can update', async t => {
  const { request } = await fixture(t);
  const created = await request('', { method: 'POST', body: { media, state } });
  const { code } = created.body.room;
  const joined = await request(`/${code}/join`, { method: 'POST' });
  assert.notEqual(joined.body.memberId, created.body.memberId);
  assert.notEqual(joined.body.memberToken, created.body.memberToken);
  assert.equal((await request(`/${code}/state`, {
    method: 'POST', token: joined.body.memberToken, body: { state },
  })).status, 403);
  assert.equal((await request(`/${code}/leave`, { method: 'POST', token: joined.body.memberToken })).status, 200);
  assert.equal((await request(`/${code}`, { token: created.body.memberToken })).body.room.members.length, 1);
});

test('room mutation and invite attempts are throttled without interfering with ordinary polling', async t => {
  let time = 1_000;
  const { request } = await fixture(t, {
    limiterOptions: { now: () => time, windowMs: 1_000, membershipMax: 2, readMax: 3, stateMax: 2 },
  });
  const created = await request('', { method: 'POST', body: { media, state } });
  const { code } = created.body.room;
  assert.equal((await request('/ABCDEFGH/join', { method: 'POST' })).status, 404);
  const limited = await request('/ABCDEFGH/join', { method: 'POST' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '1');
  for (let i = 0; i < 3; i++) {
    assert.equal((await request(`/${code}`, { token: created.body.memberToken })).status, 200);
  }
  assert.equal((await request(`/${code}`, { token: created.body.memberToken })).status, 429);
  for (let i = 0; i < 2; i++) {
    assert.equal((await request(`/${code}/state`, { method: 'POST', token: created.body.memberToken, body: { state } })).status, 200);
  }
  assert.equal((await request(`/${code}/state`, { method: 'POST', token: created.body.memberToken, body: { state } })).status, 429);
  assert.equal((await request(`/${code}/join`, { method: 'POST', user: 'guest' })).status, 200);
  time = 2_000;
  assert.equal((await request(`/${code}`, { token: created.body.memberToken })).status, 200);
});

test('throttle tracking has a hard memory ceiling and expired entries free capacity', async t => {
  let time = 1_000;
  const { request } = await fixture(t, { limiterOptions: { now: () => time, windowMs: 1_000, maxEntries: 1 } });
  assert.equal((await request('/ABCDEFGH/join', { method: 'POST' })).status, 404);
  assert.equal((await request('/ABCDEFGH/join', { method: 'POST', user: 'guest' })).status, 429);
  time = 2_000;
  assert.equal((await request('/ABCDEFGH/join', { method: 'POST', user: 'guest' })).status, 404);
});
