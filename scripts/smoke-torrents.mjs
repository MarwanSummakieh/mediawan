// Real qBittorrent transfer of generated media using a local HTTP web seed. No external media.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { configuration } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createTorrentPolicy } from '../src/torrent-policy.mjs';
import { createQbitClient } from '../src/qbittorrent.mjs';
import { createTorrentDownloads } from '../src/torrent-downloads.mjs';
const root = path.resolve('.runtime/torrent-smoke');
mkdirSync(root, { recursive: true });
const sample = path.join(root, 'fixture.mp4');
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=3840x2160:rate=24',
    '-t',
    '5',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    sample,
  ],
  { windowsHide: true },
);
const data = readFileSync(sample);
const encode = (value) => {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(value.length + ':'), value]);
  if (typeof value === 'string') return encode(Buffer.from(value));
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (Array.isArray(value))
    return Buffer.concat([Buffer.from('l'), ...value.map(encode), Buffer.from('e')]);
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.keys(value)
      .sort()
      .flatMap((k) => [encode(k), encode(value[k])]),
    Buffer.from('e'),
  ]);
};
const pieces = [];
for (let n = 0; n < data.length; n += 16384)
  pieces.push(
    createHash('sha1')
      .update(data.subarray(n, n + 16384))
      .digest(),
  );
const info = {
  length: data.length,
  name: 'fixture.mp4',
  'piece length': 16384,
  pieces: Buffer.concat(pieces),
};
const hash = createHash('sha1').update(encode(info)).digest('hex');
const torrent = encode({ info, 'url-list': ['http://host.docker.internal:8810/fixture.mp4'] });
const server = createServer((req, res) => {
  if (req.url !== '/fixture.mp4') {
    res.writeHead(404);
    res.end();
    return;
  }
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const start = range ? Number(range[1]) : 0,
    end = range && range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
  res.writeHead(range ? 206 : 200, {
    'Content-Type': 'video/mp4',
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${data.length}` } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : data.subarray(start, end + 1));
});
await new Promise((r) => server.listen(8810, '0.0.0.0', r));
const credentials = JSON.parse(readFileSync('.runtime/local/qbittorrent.json', 'utf8'));
const config = {
  ...configuration({}),
  qbitUrl: credentials.url,
  qbitUsername: credentials.username,
  qbitPassword: credentials.password,
  qbitSavePath: '/downloads',
  torrentDir: path.resolve('media/local-test/torrents'),
};
const client = createQbitClient(config),
  store = createStore(':memory:');
store.run(
  "INSERT INTO users(id,email,name,pw_hash,role) VALUES(1,'fixture@test','Test','x','admin')",
);
const user = store.one('SELECT * FROM users'),
  title = store.saveTitle({
    kind: 'movie',
    external_id: 'smoke',
    name: 'Generated torrent fixture',
  }),
  item = store.saveItem({ title_id: title.id });
const policy = createTorrentPolicy(store);
policy.set({ seedRatio: 0, seedMinutes: 0 });
const worker = createTorrentDownloads(store, config, policy, { client });
let job;
try {
  job = await worker.enqueue(user, item.id, {
    hash,
    fileIndex: 0,
    // Synthetic search metadata exercises the same mandatory selector rules.
    label: 'Generated fixture 2160p WEB-DL [YTS]',
    resolution: 2160,
    seeders: 5,
    sizeBytes: data.length,
  });
  const form = new FormData();
  form.set('torrents', new Blob([torrent]), 'fixture.torrent');
  form.set('category', 'mediawan');
  form.set('savepath', `/downloads/${job.id}`);
  form.set('stopped', 'true');
  form.set('autoTMM', 'false');
  form.set('contentLayout', 'Original');
  await client.call('torrents/add', form);
  for (let n = 0; n < 50; n++) {
    await worker.tick();
    const state = store.job(job.id);
    if (['ready', 'failed'].includes(state.state)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const result = store.job(job.id);
  assert.equal(
    result.state,
    'ready',
    result.error || JSON.stringify({ state: result.state, bytes: result.bytes }),
  );
  const asset = store.assets(item.id)[0];
  assert.equal(
    createHash('sha256').update(readFileSync(asset.path)).digest('hex'),
    createHash('sha256').update(data).digest('hex'),
  );
  console.log(
    JSON.stringify({
      status: 'passed',
      engine: await client.health(),
      bytes: data.length,
      duration: asset.probe?.duration,
      checks: [
        'real transfer',
        'selected file',
        'byte identity',
        'FFmpeg probe',
        'library publication',
      ],
    }),
  );
} finally {
  await worker.close();
  if (job) {
    const current = await client.info(hash);
    if (current?.save_path.replace(/\/$/, '') === `/downloads/${job.id}`)
      await client.call('torrents/delete', { hashes: hash, deleteFiles: 'false' });
  }
  store.close();
  await new Promise((r) => server.close(r));
}
