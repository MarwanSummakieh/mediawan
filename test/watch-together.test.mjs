import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWatchTogetherStore, normalizeWatchCode, validateWatchMedia, validateWatchState,
  WatchTogetherError, WATCH_MEMBER_TIMEOUT_MS,
} from '../lib/watch-together.mjs';

const host = { id: 1, name: 'Host' };
const guest = { id: 2, name: 'Guest' };
const media = { kind: 'anime', id: '16498', episode: '1', mode: 'sub', title: 'A shared episode' };
const paused = { position: 100, paused: true, rate: 1 };
const playing = { position: 100, paused: false, rate: 2 };
const status = expected => error => error instanceof WatchTogetherError && error.status === expected;

function fixture(options = {}) {
  let time = 0;
  return { store: createWatchTogetherStore({ ...options, now: () => time }), at: value => { time = value; } };
}

test('rooms have readable invites and independent account-bound device credentials', () => {
  const { store } = fixture();
  const created = store.create(host, media, paused);
  const joined = store.join(created.room.code.toLowerCase(), host);
  assert.match(created.room.code, /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/);
  assert.match(created.memberToken, /^[a-f0-9]{64}$/);
  assert.notEqual(created.memberToken, created.memberId);
  assert.notEqual(joined.memberToken, created.memberToken);
  assert.notEqual(joined.memberId, created.memberId);
  assert.equal(created.room.hostId, created.memberId);
  assert.equal(joined.room.members.length, 2);
  assert.deepEqual(Object.keys(joined.room.members[0]).sort(), ['id', 'name']);
  assert.ok(!JSON.stringify(joined.room).includes(created.memberToken));
  assert.ok(!Object.hasOwn(joined.room.members[0], 'userId'));
  assert.throws(() => store.read(created.room.code, created.memberId, host), status(403));
  assert.throws(() => store.read(created.room.code, '0'.repeat(64), host), status(403));
  assert.throws(() => store.read(created.room.code, created.memberToken, guest), status(403));
  assert.throws(() => store.update(created.room.code, joined.memberToken, host, paused), status(403));
});

test('only the joined host can change playback or media; updates anchor the shared clock', () => {
  const { store, at } = fixture();
  const created = store.create(host, media, paused);
  const joined = store.join(created.room.code, guest);
  const replacement = { kind: 'tv', id: 'tt1234567', season: 2, episode: '3', title: 'A shared series' };
  at(4_000);
  assert.throws(() => store.update(created.room.code, joined.memberToken, guest, playing, replacement), status(403));
  const changed = store.update(created.room.code, created.memberToken, host, playing, replacement).room;
  assert.deepEqual(changed.media, replacement);
  assert.deepEqual(changed.state, { ...playing, updatedAt: 4_000, revision: 2 });
  at(8_000);
  const observed = store.read(created.room.code, joined.memberToken, guest).room;
  assert.equal(observed.serverTime, 8_000);
  assert.equal(observed.state.position, 100);
  assert.equal(observed.state.updatedAt, 4_000);
});

test('snapshots and input values cannot mutate another participant’s room', () => {
  const { store } = fixture();
  const mediaInput = { ...media };
  const stateInput = { ...paused };
  const created = store.create(host, mediaInput, stateInput);
  const original = structuredClone(created.room);
  mediaInput.title = 'Changed input';
  stateInput.position = 900;
  created.room.media.id = '999';
  created.room.state.position = 500;
  created.room.members[0].name = 'Changed snapshot';
  created.room.members.push({ id: 'fake', name: 'Fake' });
  assert.deepEqual(store.read(original.code, created.memberToken, host).room, original);
});

test('host departure transfers to the oldest present device and freezes current playback', () => {
  const { store, at } = fixture();
  const created = store.create(host, media, playing);
  at(1_000);
  const first = store.join(created.room.code, guest);
  at(2_000);
  const second = store.join(created.room.code, { id: 3, name: 'Later' });
  at(15_000);
  assert.deepEqual(store.leave(created.room.code, created.memberToken, host), { ok: true });
  const room = store.read(created.room.code, first.memberToken, guest).room;
  assert.equal(room.hostId, first.memberId);
  assert.equal(room.members.length, 2);
  assert.deepEqual(room.state, { position: 130, paused: true, rate: 2, updatedAt: 15_000, revision: 2 });
  assert.throws(() => store.read(created.room.code, created.memberToken, host), status(403));
  store.update(created.room.code, first.memberToken, guest, { ...paused, position: 130 });
  store.leave(created.room.code, first.memberToken, guest);
  assert.equal(store.read(created.room.code, second.memberToken, { id: 3 }).room.hostId, second.memberId);
  store.leave(created.room.code, second.memberToken, { id: 3 });
  assert.equal(store.size, 0);
  assert.throws(() => store.join(created.room.code, guest), status(404));
});

test('a disconnected host expires after 30 seconds while active guests inherit a paused timeline', () => {
  const { store, at } = fixture();
  const created = store.create(host, media, playing);
  const joined = store.join(created.room.code, guest);
  at(WATCH_MEMBER_TIMEOUT_MS - 1);
  assert.equal(store.read(created.room.code, joined.memberToken, guest).room.hostId, created.memberId);
  at(WATCH_MEMBER_TIMEOUT_MS);
  const room = store.read(created.room.code, joined.memberToken, guest).room;
  assert.equal(room.hostId, joined.memberId);
  assert.deepEqual(room.state, { position: 160, paused: true, rate: 2, updatedAt: 30_000, revision: 2 });
  assert.throws(() => store.read(created.room.code, created.memberToken, host), status(403));
  at(31_000);
  assert.equal(store.read(created.room.code, joined.memberToken, guest).room.state.position, 160);
});

test('heartbeats keep devices present but cannot extend the maximum room age', () => {
  const { store, at } = fixture({ maxRoomAgeMs: 100_000 });
  const created = store.create(host, media, paused);
  for (const timestamp of [20_000, 40_000, 60_000, 80_000, 99_000]) {
    at(timestamp);
    assert.equal(store.read(created.room.code, created.memberToken, host).room.hostId, created.memberId);
  }
  at(100_000);
  assert.throws(() => store.read(created.room.code, created.memberToken, host), status(404));
  assert.equal(store.size, 0);
});

test('all inactive devices and empty rooms expire; expired tokens cannot revive them', () => {
  const { store, at } = fixture();
  const created = store.create(host, media, paused);
  store.join(created.room.code, guest);
  at(WATCH_MEMBER_TIMEOUT_MS);
  assert.throws(() => store.read(created.room.code, created.memberToken, host), status(404));
  assert.equal(store.size, 0);
});

test('room, participant and per-account bounds refuse insertion and recover when devices leave', () => {
  const { store } = fixture({ maxRooms: 2, maxMembersPerRoom: 2, maxMembershipsPerUser: 2 });
  const first = store.create(host, media, paused);
  const sameAccount = store.join(first.room.code, host);
  assert.throws(() => store.join(first.room.code, guest), status(409));
  assert.throws(() => store.create(host, media, paused), status(429));
  store.leave(first.room.code, sameAccount.memberToken, host);
  const second = store.create(host, media, paused);
  assert.throws(() => store.create(guest, media, paused), status(503));
  assert.equal(store.size, 2);
  store.leave(second.room.code, second.memberToken, host);
  assert.ok(store.create(guest, media, paused).room.code);
});

test('invalid updates do not partially change media, timeline or revision', () => {
  const { store } = fixture();
  const created = store.create(host, media, paused);
  const replacement = { kind: 'movie', id: 'm-123', title: 'Another title' };
  assert.throws(() => store.update(created.room.code, created.memberToken, host, { ...paused, rate: 9 }, replacement), status(400));
  assert.throws(() => store.update(created.room.code, created.memberToken, host, playing, { ...replacement, url: 'https://example.com/video' }), status(400));
  assert.deepEqual(store.read(created.room.code, created.memberToken, host).room, created.room);
});

test('media accepts safe catalog identifiers and bounded episode labels, never arbitrary URLs', () => {
  assert.deepEqual(validateWatchMedia({ ...media, episode: '12.5', mode: 'dub' }), { ...media, episode: '12.5', mode: 'dub' });
  assert.deepEqual(validateWatchMedia({ kind: 'movie', id: 'm-123', title: ' Film ' }), { kind: 'movie', id: 'm-123', title: 'Film' });
  assert.equal(validateWatchMedia({ ...media, episode: 'SP-1' }).episode, 'SP-1');
  for (const value of [
    null, [], { ...media, kind: 'live' }, { ...media, id: 16498 }, { ...media, id: 'tt123' },
    { ...media, id: 'https://example.com/video' }, { ...media, id: '1'.repeat(101) },
    { ...media, episode: '../secret' }, { ...media, episode: 1 }, { ...media, episode: '1'.repeat(41) },
    { ...media, season: -1 }, { ...media, season: 1.5 }, { ...media, season: 1001 },
    { ...media, mode: 'unknown' }, { ...media, title: ' ' }, { ...media, title: 'x'.repeat(241) },
    { ...media, title: 'bad\nname' }, { ...media, source: 'https://example.com' },
    { kind: 'anime', id: '16498', title: 'Missing episode' },
    { kind: 'tv', id: 'tt123', title: 'Missing episode', season: 1 },
    { kind: 'tv', id: 'tt123', title: 'Missing season', episode: '1' },
    { kind: 'tv', id: 'tt123', title: 'Invalid episode', season: 1, episode: 'SP-1' },
    { kind: 'tv', id: 'tt123', title: 'Invalid episode', season: 1, episode: '0' },
    { kind: 'movie', id: 'tt123', title: 'Film', episode: '1' },
    { kind: 'movie', id: 'tt123', title: 'Film', season: 1 },
    { kind: 'movie', id: 'tt123', title: 'Film', mode: 'sub' },
    { kind: 'tv', id: 'tt123', title: 'Series', season: 1, episode: '1', mode: 'sub' },
  ]) assert.throws(() => validateWatchMedia(value), status(400));
});

test('state and codes validate finite scalar values and readable normalization', () => {
  assert.deepEqual(validateWatchState(paused), paused);
  assert.equal(normalizeWatchCode(' abcd-efgh '), 'ABCDEFGH');
  for (const value of [
    null, [], {}, { ...paused, position: '100' }, { ...paused, position: -1 },
    { ...paused, position: Infinity }, { ...paused, position: NaN },
    { ...paused, position: 1e9 }, { ...paused, rate: 0 }, { ...paused, rate: 2.1 },
    { ...paused, rate: Infinity }, { ...paused, paused: 'false' }, { ...paused, revision: 1 },
  ]) assert.throws(() => validateWatchState(value), status(400));
  for (const code of [null, 12, '', 'ABCD', 'ABCDEFG0', 'ABCDEFG1', 'x'.repeat(41)]) {
    assert.throws(() => normalizeWatchCode(code), status(400));
  }
});
