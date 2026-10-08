import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { configuration } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createMedia, probe } from '../src/media.mjs';
test('real FFmpeg fixture probes and produces an authenticated HLS playlist', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediawan-media-'));
  const config = { ...configuration({}), runtime: path.join(root, 'transcode') };
  const file = path.join(root, 'fixture.mkv');
  execFileSync(
    config.ffmpeg,
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x354638:s=320x180:r=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:sample_rate=44100',
      '-t',
      '5',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      file,
    ],
    { windowsHide: true },
  );
  const metadata = await probe(file, config);
  assert(metadata.duration >= 5);
  const store = createStore(':memory:');
  const title = store.saveTitle({ kind: 'movie', external_id: 'fixture', name: 'Fixture' });
  const item = store.saveItem({ title_id: title.id });
  store.addAsset({
    item_id: item.id,
    path: file,
    bytes: readFileSync(file).length,
    probe: metadata,
  });
  const media = createMedia(store, config);
  t.after(async () => {
    await media.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const user = { id: 1, active: 1, role: 'admin' },
    session = await media.start(user, item.id, { seek: 1 });
  const playlist = media.segment(user, session.id, 'index.m3u8');
  assert(store.isTitleInUse(title.id));
  assert(existsSync(playlist));
  assert.match(readFileSync(playlist, 'utf8'), /#EXTM3U/);
  assert.throws(() => media.segment({ ...user, id: 2 }, session.id, 'index.m3u8'), /not found/);
  assert.throws(() => media.segment(user, session.id, '../secret'), /not found/);
  await media.stop(user, session.id);
  assert.equal(store.isTitleInUse(title.id), false);
});
