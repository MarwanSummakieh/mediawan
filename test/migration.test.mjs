import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { migrateLegacy } from '../src/migrate.mjs';
import { createStore } from '../src/store.mjs';
test('migration is read-only, idempotent and preserves per-item state over legacy title state', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediawan-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'old.sqlite'),
    destination = path.join(root, 'new.sqlite'),
    old = new DatabaseSync(source);
  old.exec(
    "CREATE TABLE users(id INTEGER,email TEXT,name TEXT,pw_hash TEXT,role TEXT,active INTEGER); INSERT INTO users VALUES(1,'one@test','One','hash','member',1); CREATE TABLE library_records(type TEXT,json TEXT); CREATE TABLE progress(user_id INTEGER,kind TEXT,media_id TEXT,title TEXT,cover TEXT,season INTEGER,episode TEXT,seconds REAL,duration REAL,updated INTEGER); INSERT INTO progress VALUES(1,'tv','tt1','Series','',1,'1',90,100,200);",
  );
  const insert = old.prepare('INSERT INTO library_records VALUES(?,?)');
  for (const [type, value] of [
    ['title', { id: 'title', kind: 'tv', mediaId: 'tt1', title: 'Series' }],
    ['item', { id: 'episode', titleId: 'title', season: 1, episode: '1' }],
    [
      'state',
      { userId: 1, itemId: 'episode', seconds: 20, duration: 100, watched: false, updated: 100 },
    ],
  ])
    insert.run(type, JSON.stringify(value));
  old.close();
  assert.equal(migrateLegacy(source, destination).users, 1);
  assert.deepEqual(migrateLegacy(source, destination), { alreadyMigrated: true });
  const next = createStore(destination);
  assert.equal(next.state(1, 'episode').position, 20);
  assert.equal(next.one('SELECT can_download FROM users').can_download, 0);
  next.close();
  const original = new DatabaseSync(source, { readOnly: true });
  assert.equal(original.prepare('SELECT seconds FROM progress').get().seconds, 90);
  original.close();
});

test('older NAS caches link verified movies and numbered TV without guessing anime or deleting files', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediawan-cache-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'old.sqlite'),
    destination = path.join(root, 'new.sqlite');
  const old = new DatabaseSync(source);
  old.exec(`CREATE TABLE users(id INTEGER,email TEXT,name TEXT,pw_hash TEXT,role TEXT,active INTEGER);
    INSERT INTO users VALUES(1,'one@test','One','hash','member',1);
    CREATE TABLE progress(user_id INTEGER,kind TEXT,media_id TEXT,title TEXT,season INTEGER,episode TEXT,seconds REAL,duration REAL,updated INTEGER);
    INSERT INTO progress VALUES(1,'movie','tt1','Film',0,'',10,100,1);
    INSERT INTO progress VALUES(1,'tv','tt2','Series',1,'9',10,100,1);
    INSERT INTO progress VALUES(1,'anime','123','Anime',0,'9',10,100,1);
    CREATE TABLE cache_files(key TEXT,path TEXT,state TEXT,title TEXT,total INTEGER,created INTEGER);`);
  const insert = old.prepare('INSERT INTO cache_files VALUES(?,?,?,?,?,1)');
  for (const [key, label, size, state] of [
    ['film', 'Film', 5, 'complete'],
    ['episode', 'Series · S1 E2', 5, 'complete'],
    ['anime', 'Anime', 5, 'complete'],
    ['short', 'Film', 9, 'complete'],
    ['partial', 'Film', 5, 'partial'],
    ['unknown', 'Unknown', 5, 'complete'],
  ]) {
    const file = path.join(root, key + '.mkv');
    writeFileSync(file, 'video');
    insert.run(key, file, state, label, size);
  }
  insert.run('missing', path.join(root, 'missing.mkv'), 'complete', 'Film', 5);
  old.close();
  const result = migrateLegacy(source, destination);
  assert.equal(result.cacheAssets, 2);
  assert.equal(result.unmappedCache, 4);
  const next = createStore(destination);
  const assets = next.all('SELECT * FROM assets').map(next.unpack);
  assert.equal(assets.length, 2);
  assert(assets.every((asset) => asset.imported && asset.readers.includes(1)));
  const episode = next.item(assets.find((asset) => asset.path.endsWith('episode.mkv')).item_id);
  assert.equal(episode.episode, 2);
  assert.equal(next.state(1, episode.id).position, 0);
  assert.equal(next.all('SELECT * FROM history').length, 3);
  next.close();
  for (const key of ['film', 'episode', 'anime', 'short', 'partial', 'unknown'])
    assert.equal(readFileSync(path.join(root, key + '.mkv'), 'utf8'), 'video');
});
