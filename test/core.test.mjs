import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.mjs';
import { createHistory } from '../src/history.mjs';
import { createNavigation } from '../src/navigation.mjs';
import { createQueues } from '../src/queues.mjs';
import { selectFile } from '../src/downloads.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediawan-v2-')),
    store = createStore(path.join(root, 'db.sqlite'));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const user = { id: 1, active: 1, role: 'member' },
    other = { id: 2, active: 1, role: 'member' };
  const title = store.saveTitle({ kind: 'tv', external_id: 'tt100', name: 'Fixture series' });
  const items = [];
  for (let n = 1; n <= 5; n++) {
    const item = store.saveItem({
      title_id: title.id,
      season: n > 3 ? 2 : 1,
      episode: n > 3 ? n - 3 : n,
      name: `Episode ${n}`,
    });
    const file = path.join(root, `${n}.mp4`);
    writeFileSync(file, 'fixture');
    store.addAsset({ item_id: item.id, path: file, bytes: 7 });
    items.push(item);
  }
  return {
    root,
    store,
    user,
    other,
    title,
    items,
    history: createHistory(store),
    navigation: createNavigation(store),
    queues: createQueues(store, () => 0.3),
  };
}
test('progress resumes, completes, advances across seasons and remains private', (t) => {
  const f = fixture(t),
    s = f.history.start(f.user, f.items[2].id);
  f.history.event(f.user, s.id, { seq: 1, type: 'pause', position: 30, duration: 100 });
  assert.equal(f.navigation.home(f.user).continueWatching[0].resumable.id, f.items[2].id);
  assert.equal(f.navigation.home(f.other).continueWatching.length, 0);
  f.history.event(f.user, s.id, { seq: 2, type: 'ended', position: 100, duration: 100 });
  assert.equal(f.navigation.home(f.user).continueWatching.length, 0);
  assert.equal(f.navigation.home(f.user).nextUp[0].next.id, f.items[3].id);
});
test('late events cannot overwrite a newer session; intentional backward seeks work', (t) => {
  const f = fixture(t),
    first = f.history.start(f.user, f.items[0].id);
  f.history.event(f.user, first.id, { seq: 1, type: 'progress', position: 70, duration: 100 });
  const second = f.history.start(f.user, f.items[0].id);
  f.history.event(f.user, second.id, { seq: 2, type: 'seek', position: 20, duration: 100 });
  f.history.event(f.user, first.id, { seq: 4, type: 'progress', position: 90, duration: 100 });
  f.history.event(f.user, second.id, { seq: 1, type: 'progress', position: 80, duration: 100 });
  assert.equal(f.store.state(1, f.items[0].id).position, 20);
});
test('dismissal survives heartbeats; explicit replay restores resume while retaining history', (t) => {
  const f = fixture(t),
    s = f.history.start(f.user, f.items[0].id);
  f.history.event(f.user, s.id, { seq: 1, type: 'pause', position: 50, duration: 100 });
  f.history.dismiss(f.user, f.title.id, true);
  f.history.event(f.user, s.id, { seq: 2, type: 'pause', position: 51, duration: 100 });
  assert.equal(f.navigation.home(f.user).continueWatching.length, 0);
  f.history.watched(f.user, [f.items[0].id], true);
  const replay = f.history.start(f.user, f.items[0].id, { replay: true });
  assert.equal(replay.position, 0);
  f.history.event(f.user, replay.id, { seq: 1, type: 'pause', position: 20, duration: 100 });
  assert.equal(f.store.state(1, f.items[0].id).ever_watched, 1);
  assert.equal(f.navigation.home(f.user).continueWatching.length, 1);
});
test('unknown duration does not mark playback completed', (t) => {
  const f = fixture(t),
    s = f.history.start(f.user, f.items[0].id);
  f.history.event(f.user, s.id, { seq: 1, type: 'ended', position: 50, duration: 0 });
  assert.equal(f.store.state(1, f.items[0].id).completed, 0);
});
test('missing next episode is presented rather than silently skipped', (t) => {
  const f = fixture(t);
  rmSync(f.store.assets(f.items[1].id)[0].path);
  const s = f.history.start(f.user, f.items[0].id);
  f.history.event(f.user, s.id, { seq: 1, type: 'ended', position: 100, duration: 100 });
  const next = f.navigation.home(f.user).nextUp[0].next;
  assert.equal(next.id, f.items[1].id);
  assert.equal(next.available, false);
});
test('shuffle has no repetitions, persists, excludes unavailable files and preserves sequential cursor', (t) => {
  const f = fixture(t);
  f.history.start(f.user, f.items[0].id);
  rmSync(f.store.assets(f.items[2].id)[0].path);
  const q = f.queues.create(f.user, { titleId: f.title.id, mode: 'shuffle' });
  assert.equal(new Set(q.items).size, 4);
  assert(!q.items.includes(f.items[2].id));
  const s = f.history.start(f.user, q.items[0], { mode: 'shuffle' });
  f.history.event(f.user, s.id, { seq: 1, type: 'ended', position: 100, duration: 100 });
  assert.equal(
    f.store.one('SELECT cursor FROM series_state WHERE user_id=1').cursor,
    f.items[0].id,
  );
  assert.deepEqual(createQueues(f.store).get(f.user, q.id).items, q.items);
  assert.throws(() => f.queues.get(f.other, q.id), /not found/);
  assert.throws(() => f.queues.edit(f.user, q.id, { revision: 0, index: 1 }), /changed/);
});
test('private assets do not appear or play for other users', (t) => {
  const f = fixture(t);
  for (const a of f.items.flatMap((i) => f.store.assets(i.id)))
    f.store.addAsset({ ...a, readers: [1] });
  assert.equal(f.navigation.home(f.other).recentlyAdded.length, 0);
  assert.throws(() => f.history.start(f.other, f.items[0].id), /not downloaded/);
  assert.throws(
    () => f.queues.create(f.other, { titleId: f.title.id, mode: 'shuffle' }),
    /No eligible/,
  );
});
test('a resumed queue can advance independently in a second viewing session', (t) => {
  const f = fixture(t);
  const original = f.queues.create(f.user, { titleId: f.title.id, mode: 'shuffle' });
  const copy = f.queues.fork(f.user, original.id);
  assert.notEqual(copy.id, original.id);
  assert.deepEqual(copy.items, original.items);
  f.queues.edit(f.user, copy.id, { revision: copy.revision, index: 1 });
  assert.equal(f.queues.get(f.user, original.id).index, 0);
  assert.equal(f.queues.get(f.user, copy.id).index, 1);
  assert.throws(() => f.queues.fork(f.other, original.id), /not found/);
});
test('watched undo restores progress but cannot override subsequent playback', (t) => {
  const f = fixture(t);
  const session = f.history.start(f.user, f.items[0].id);
  f.history.event(f.user, session.id, { seq: 1, type: 'pause', position: 30, duration: 100 });
  const first = f.history.watched(f.user, [f.items[0].id], true);
  assert.throws(() => f.history.undo(f.other, first.undoToken), /expired/);
  f.history.undo(f.user, first.undoToken);
  assert.equal(f.store.state(f.user.id, f.items[0].id).position, 30);
  assert.equal(f.store.state(f.user.id, f.items[0].id).completed, 0);
  const second = f.history.watched(f.user, [f.items[0].id], true);
  f.history.start(f.user, f.items[0].id, { replay: true });
  assert.throws(() => f.history.undo(f.user, second.undoToken), /Playback has started/);
});
test('bulk watched cannot modify an unauthorized item or another user', (t) => {
  const f = fixture(t);
  f.history.watched(
    f.user,
    f.items.map((i) => i.id),
    true,
  );
  assert(f.navigation.detail(f.user, f.title.id).watched);
  assert(!f.navigation.detail(f.other, f.title.id).watched);
  assert.throws(() => f.history.watched(f.user, ['missing'], true), /unavailable/);
});
test('release file selection resolves exact episodes and rejects ambiguous packs', () => {
  const files = [
    { id: 1, path: '/Show.S01E01.mkv', bytes: 100 },
    { id: 2, path: '/Show.S01E02.mkv', bytes: 200 },
  ];
  assert.equal(selectFile(files, { season: 1, episode: 2 }, null).id, 2);
  assert.equal(selectFile(files, { season: 1, episode: 1 }, 0).id, 1);
  assert.throws(() => selectFile(files, { season: 3, episode: 4 }, null), /ambiguous/);
  assert.throws(() => selectFile(files, { season: 1, episode: 1 }, 99), /not found/);
});
