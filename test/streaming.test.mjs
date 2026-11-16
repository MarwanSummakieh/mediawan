import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configuration } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createHistory } from '../src/history.mjs';
import { createNavigation } from '../src/navigation.mjs';
import { createApplication } from '../src/app.mjs';
import { defaultRules } from '../src/torrent-policy.mjs';
import {
  createStreaming,
  createVpnGuard,
  capabilitiesFrom,
  conversionPlan,
  languageKey,
} from '../src/streaming.mjs';

const GiB = 1073741824,
  MiB = 1048576;
const hashes = { dead: 'd'.repeat(40), live: 'b'.repeat(40), other: 'c'.repeat(40) };
const listing = [
  // Ranked first (service and group), but its swarm never answers.
  {
    hash: hashes.dead,
    fileIndex: null,
    label: 'Show.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-NTb\n👤 90 💾 3.0 GB',
    filename: 'Show.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-NTb.mkv',
    seeders: 90,
    sizeBytes: 3 * GiB,
    resolution: 1080,
    trackers: ['udp://tracker.example:80/announce'],
  },
  {
    hash: hashes.live,
    fileIndex: null,
    label: 'Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRP\n👤 30 💾 3.0 GB',
    filename: 'Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRP.mkv',
    seeders: 30,
    sizeBytes: 3 * GiB,
    resolution: 1080,
    trackers: [],
  },
  // A 2160p label that is really a re-encoded web rip: rejected, which explains 2160p.
  // (A disc source would be accepted for an episode with no WEB-DL at that quality.)
  {
    hash: hashes.other,
    fileIndex: null,
    label: 'Show.S01E01.2160p.WEB-DL.H.265-X\n👤 50 💾 9.0 GB',
    filename: 'Show.S01E01.2160p.WEBRip.H.265-X.mkv',
    seeders: 50,
    sizeBytes: 9 * GiB,
    resolution: 2160,
    trackers: [],
  },
];
const info = {
  duration: 3000,
  video: 'h264',
  width: 1920,
  height: 1080,
  videoProfile: 'High',
  pixelFormat: 'yuv420p',
  hdr: false,
  dolbyVision: null,
  container: 'matroska,webm',
  bitRate: 8e6,
  audio: [
    { index: 1, codec: 'eac3', language: 'eng', title: '', channels: 6, default: true },
    { index: 2, codec: 'eac3', language: 'ara', title: '', channels: 6, default: false },
  ],
  subtitles: [
    { index: 3, codec: 'subrip', language: 'eng', title: '', forced: false },
    { index: 4, codec: 'hdmv_pgs_subtitle', language: 'ara', title: '', forced: false },
    { index: 5, codec: 'subrip', language: 'ara', title: '', forced: false },
  ],
  chapters: [{ start: 0, name: 'Intro' }],
};

class FakeTorrent extends EventEmitter {
  constructor(hash, spec) {
    super();
    Object.assign(this, {
      infoHash: hash,
      ready: false,
      destroyed: false,
      numPeers: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      pieceLength: MiB,
      pieces: [],
      files: [],
      selections: [],
      have: new Set(),
    });
    this.bitfield = { get: (i) => this.have.has(i) };
    if (spec?.metadataMs != null)
      this.timer = setTimeout(() => {
        this.numPeers = 4;
        this.emit('wire');
        const length = spec.length || 3 * GiB;
        this.files = [
          { name: 'sample.txt', length: 100, offset: 0 },
          { name: spec.name || 'Show.S01E01.mkv', length, offset: 100, downloaded: 0, progress: 0 },
        ];
        this.pieces = new Array(Math.ceil((length + 100) / MiB));
        this.ready = true;
        this.emit('ready');
      }, spec.metadataMs);
  }
  select(from, to, priority) {
    this.selections.push([from, to, priority]);
  }
  deselect() {
    this.selections = [];
  }
  critical() {}
  destroy(options, done) {
    clearTimeout(this.timer);
    this.destroyed = true;
    done?.();
  }
}

function fixture(t, overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediawan-stream-'));
  const config = {
    ...configuration({}),
    runtime: root,
    streamFallbackSeconds: 0.05,
    reserveBytes: 0,
    ...overrides.config,
  };
  const store = createStore(':memory:');
  store.run(
    "INSERT INTO users(id,email,name,pw_hash,role,can_download) VALUES(1,'a@test','A','x','member',1),(2,'b@test','B','x','member',0)",
  );
  const user = store.one('SELECT * FROM users WHERE id=1'),
    viewer = store.one('SELECT * FROM users WHERE id=2');
  const title = store.saveTitle({ kind: 'tv', external_id: 'tt1', name: 'Show' });
  const item = store.saveItem({ title_id: title.id, season: 1, episode: 1, runtimeSeconds: 3000 });
  const second = store.saveItem({ title_id: title.id, season: 1, episode: 2 });
  const swarms = { [hashes.live]: { metadataMs: 30 }, ...overrides.swarms };
  const added = [],
    conversions = [],
    state = { vpn: true, releasesCalls: 0, clients: 0, clientDestroyed: 0, free: 1000 * GiB };
  const client = {
    destroyed: false,
    add(magnet, options) {
      const hash = /btih:([a-f0-9]{40})/.exec(magnet)[1];
      const torrent = new FakeTorrent(hash, swarms[hash]);
      added.push({ hash, options, torrent });
      return torrent;
    },
    on() {},
    destroy(done) {
      client.destroyed = true;
      state.clientDestroyed++;
      done();
    },
  };
  const media = {
    async startStream(owner, options) {
      const conversion = { owner, options, stopped: false };
      conversions.push(conversion);
      return {
        key: `conversion-${conversions.length}`,
        ready: Promise.resolve({
          id: 'x',
          url: `/api/media/sessions/conversion-${conversions.length}/index.m3u8`,
        }),
        stop: async () => {
          conversion.stopped = true;
        },
        session: {},
      };
    },
    segment: () => {
      throw new Error('not used');
    },
  };
  overrides.wrapMedia?.(media);
  const streaming = createStreaming(store, config, {
    releases: async (itemId) => {
      state.releasesCalls++;
      if (typeof overrides.listing === 'function') return overrides.listing(itemId);
      return overrides.listing || listing;
    },
    rules: () => ({ ...defaultRules, ...overrides.rules }),
    media,
    probe: overrides.probe || (async () => info),
    keyframeBefore: async (input, seek) => Math.max(0, seek - 1.5),
    statfs: async () => {
      if (state.statfsDelay) await new Promise((r) => setTimeout(r, state.statfsDelay));
      return { bavail: state.free, bsize: 1 };
    },
    guard: () => ({
      required: true,
      ok: state.vpn,
      message: state.vpn ? 'VPN up' : 'Connect the VPN to stream.',
    }),
    createClient: async (options) => {
      state.clients++;
      state.clientOptions = options;
      client.destroyed = false;
      return client;
    },
    sourceServer: {
      add: async (file) => ({
        url: `http://127.0.0.1:1/${file.name}`,
        source: { readers: new Set() },
        remove() {},
      }),
      close() {},
    },
    timings: { tickMs: 3600000, guardMs: 0, diskMs: 3600000, ...overrides.timings },
  });
  t.after(async () => {
    await streaming.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return {
    streaming,
    store,
    user,
    viewer,
    item,
    second,
    title,
    added,
    conversions,
    state,
    config,
    root,
    client,
  };
}
const until = async (test, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('stream options rank both resolutions, explain the missing one and answer from memory', async (t) => {
  const { streaming, user, item, second, state } = fixture(t);
  const cold = await streaming.options(user, item.id);
  assert.equal(cold.cached, false);
  assert.equal(cold.defaultResolution, 1080);
  const [hd, uhd] = cold.resolutions;
  assert.equal(hd.available, true);
  assert.equal(hd.release.hash, hashes.dead);
  assert.equal(hd.release.service, 'NF');
  assert.equal(hd.release.group, 'NTB');
  assert.equal(hd.alternatives, 1);
  assert.equal(uhd.available, false);
  assert.match(
    uhd.reason,
    /2160p release passes the rules\. Best: Release source conflicts with the required WEB-DL source/,
  );
  const warm = await streaming.options(user, item.id);
  assert.equal(warm.cached, true);
  assert(warm.elapsedMs < 50);
  // The next episode's listing is fetched in the background for Next Up.
  await until(() => state.releasesCalls >= 2);
  assert.equal((await streaming.options(user, second.id)).cached, true);
  assert.equal(state.releasesCalls, 2);
});

test('prepare races the next release when the first is slow, reports the fallback and stays cheap', async (t) => {
  const { streaming, user, item, added, conversions, state } = fixture(t);
  const prepared = await streaming.prepare(user, item.id, {});
  assert.equal(prepared.state, 'finding-peers');
  assert.equal(prepared.intent, 'prepare');
  assert.equal(state.clientOptions.lsd, false);
  assert.equal(state.clientOptions.natUpnp, false);
  await until(() => streaming.status(user, prepared.id).state === 'ready');
  const ready = streaming.status(user, prepared.id);
  assert.equal(ready.release.hash, hashes.live);
  assert.equal(ready.fallback.from.hash, hashes.dead);
  assert.equal(ready.fallback.to.hash, hashes.live);
  assert.match(ready.fallback.reason, /No metadata within/);
  assert.deepEqual(
    ready.attempts.map((a) => [a.hash, a.state]),
    [
      [hashes.dead, 'abandoned'],
      [hashes.live, 'won'],
    ],
  );
  // Open trackers and the listing's own trackers are always announced.
  const dead = added.find((a) => a.hash === hashes.dead);
  assert(dead.options.announce.includes('udp://tracker.example:80/announce'));
  assert(dead.options.announce.includes('udp://tracker.opentrackr.org:1337/announce'));
  assert.equal(dead.options.deselect, true);
  assert.equal(dead.torrent.destroyed, true);
  // A prepared session fetches only the head and tail of the file, never the whole file.
  const live = added.find((a) => a.hash === hashes.live).torrent;
  assert(live.selections.length >= 2);
  assert(live.selections.every(([, , priority]) => priority === 3));
  assert.equal(ready.playback.preferredSubtitles.length, 0);
  assert.equal(conversions.length, 0);
});

test('play reuses the warm session, copies the video, resumes from history and records a lock', async (t) => {
  const { streaming, store, user, item, title, added, conversions } = fixture(t, {
    swarms: { [hashes.dead]: { metadataMs: 5 } },
  });
  store.run(
    'INSERT INTO history(user_id,item_id,position,duration,completed) VALUES(?,?,?,?,0)',
    user.id,
    item.id,
    600,
    3000,
  );
  store.run(
    'INSERT INTO preferences VALUES(?,?)',
    user.id,
    JSON.stringify({ audioLanguage: 'ar', subtitleLanguage: 'ara' }),
  );
  const prepared = await streaming.prepare(user, item.id, { resolution: 1080 });
  await until(() => streaming.status(user, prepared.id).state === 'ready');
  const started = await streaming.start(user, item.id, {
    resolution: 1080,
    capabilities: { video: ['h264', 'hevc'], maxHeight: 2160 },
  });
  assert.equal(started.id, prepared.id);
  await until(() => streaming.status(user, prepared.id).conversion?.state === 'ready');
  const playing = streaming.status(user, prepared.id);
  assert.equal(playing.state, 'ready');
  assert.equal(playing.fallback, null);
  assert.equal(playing.conversion.mode, 'copy');
  assert.equal(playing.conversion.requested, 600);
  assert.equal(playing.conversion.offset, 598.5, 'offset is the keyframe before the resume point');
  assert.equal(playing.conversion.audio, 2, 'preferred Arabic audio track');
  assert.deepEqual(playing.conversion.subtitles, [5, 3], 'text subtitles only, preferred first');
  assert.deepEqual(playing.playback.preferredSubtitles, [{ language: 'ara', embedded: true }]);
  assert.equal(conversions.length, 1);
  assert.equal(conversions[0].options.convert.copy, true);
  // Playing selects the whole file, plus a window at the resume point.
  const torrent = added.find((a) => a.hash === hashes.dead).torrent;
  assert(torrent.selections.some(([, , priority]) => priority === 0));
  assert(torrent.selections.some(([, , priority]) => priority === 2));
  const lock = JSON.parse(
    store.one('SELECT json FROM stream_locks WHERE title_id=?', title.id).json,
  );
  assert.deepEqual(lock, { hash: hashes.dead, group: 'NTB', service: 'NF' });

  // A device without HEVC/4K support restarts with a transcode at the same position.
  const restarted = await streaming.convert(user, prepared.id, {
    position: 900,
    capabilities: { video: ['h264'], maxHeight: 720 },
  });
  assert.equal(restarted.mode, 'transcode');
  assert.match(restarted.reason, /up to 720p/);
  assert.equal(restarted.offset, 900);
  assert.equal(conversions[0].stopped, true);
  assert.equal(conversions[1].options.convert.maxHeight, 720);
});

test('the VPN guard refuses streams, and losing the VPN stops all torrent traffic', async (t) => {
  const { streaming, user, item, state, added } = fixture(t);
  state.vpn = false;
  await assert.rejects(
    streaming.prepare(user, item.id, {}),
    (error) => error.reason === 'vpn' && error.status === 403,
  );
  assert.equal(state.clients, 0, 'no torrent client without a VPN');
  state.vpn = true;
  await new Promise((r) => setTimeout(r, 510));
  const prepared = await streaming.prepare(user, item.id, {});
  await until(() => streaming.status(user, prepared.id).state === 'ready');
  state.vpn = false;
  await streaming._internal.tick();
  const failed = streaming.status(user, prepared.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.reason, 'vpn');
  assert(added.every((a) => a.torrent.destroyed));
  assert.equal(state.clientDestroyed, 1);
  assert.equal(streaming._internal.entries.size, 0);
});

test('a VPN guard matches configured interface names with wildcards', () => {
  const config = { streamVpn: 'required', streamVpnInterfaces: ['nordlynx', 'tun*'] };
  const up = (name) => ({
    [name]: [{ address: '10.5.0.2', internal: false }],
    lo: [{ internal: true }],
  });
  assert.equal(createVpnGuard(config, () => up('NordLynx'))().interface, 'NordLynx');
  assert.equal(createVpnGuard(config, () => up('tun0'))().ok, true);
  assert.equal(createVpnGuard(config, () => up('Ethernet'))().ok, false);
  assert.equal(createVpnGuard(config, () => ({ tun0: [{ internal: true }] }))().ok, false);
  const off = createVpnGuard({ ...config, streamVpn: 'off' }, () => ({}))();
  assert.equal(off.ok, true);
  assert.equal(off.required, false);
});

test('idle prepared sessions expire, delete their cache and close the engine', async (t) => {
  const { streaming, user, item, added, root, state } = fixture(t, {
    timings: { preparedIdleMs: 20, engineIdleMs: 0 },
  });
  const prepared = await streaming.prepare(user, item.id, {});
  await until(() => streaming.status(user, prepared.id).state === 'ready');
  const cache = added.find((a) => a.hash === hashes.live).options.path;
  assert.match(path.basename(cache), new RegExp(`^${hashes.live}-`));
  assert(existsSync(cache));
  await new Promise((r) => setTimeout(r, 30));
  await streaming._internal.tick();
  assert.throws(() => streaming.status(user, prepared.id), /Stream not found/);
  assert(added.find((a) => a.hash === hashes.live).torrent.destroyed);
  assert(!existsSync(cache));
  await new Promise((r) => setTimeout(r, 5));
  await streaming._internal.tick();
  assert.equal(state.clientDestroyed, 1);
});

test('streams respect the free-space reserve and the stream cache size', async (t) => {
  const { streaming, user, item, state, config } = fixture(t, {
    config: { reserveBytes: 20 * GiB },
  });
  state.free = 25 * GiB; // a 3 GiB file needs 6 GiB with its HLS copy
  const prepared = await streaming.prepare(user, item.id, {});
  await until(() => streaming.status(user, prepared.id).state === 'failed');
  const failed = streaming.status(user, prepared.id);
  assert.equal(failed.error.reason, 'disk');
  assert.match(failed.message, /needs 6\.0 GB and 5\.0 GB is free after the 20\.0 GB reserve/);
  assert(config.streamCacheBytes >= GiB);
});

test('permissions, session caps and expired sessions give clear errors', async (t) => {
  const { streaming, user, viewer, item, second } = fixture(t, {
    config: { streamMaxSessions: 1 },
  });
  await assert.rejects(
    streaming.prepare(viewer, item.id, {}),
    (e) => e.status === 403 && e.reason === 'permission',
  );
  const first = await streaming.prepare(user, item.id, {});
  // A new prepare evicts an idle prepared session instead of failing.
  const next = await streaming.prepare(user, second.id, {});
  assert.throws(() => streaming.status(user, first.id), /Stream not found/);
  await streaming.start(user, second.id, {});
  await assert.rejects(
    streaming.prepare(user, item.id, {}),
    (e) => e.status === 409 && e.reason === 'limit',
  );
  assert.throws(() => streaming.status(viewer, next.id), /Stream not found/);
  await assert.rejects(
    streaming.prepare(user, item.id, { resolution: 2160 }),
    /2160p release passes/,
  );
});

test('every release failing ends in a clear no-peers error', async (t) => {
  const { streaming, user, item } = fixture(t, {
    swarms: { [hashes.live]: {} },
    timings: { connectTimeoutMs: 200 },
  });
  const prepared = await streaming.prepare(user, item.id, {});
  await until(() => streaming.status(user, prepared.id).state === 'failed');
  const failed = streaming.status(user, prepared.id);
  assert.equal(failed.error.reason, 'no-peers');
  assert.match(failed.message, /No peers answered for any of the 2 releases/);
});

test('resolution switches keep the position, and Next Up can be prepared ahead', async (t) => {
  const listing4k = [
    ...listing.slice(0, 2),
    {
      ...listing[1],
      hash: hashes.other,
      label: 'Show.S01E01.2160p.WEB-DL.DDP5.1.HDR.H.265-GRP\n👤 30 💾 9.0 GB',
      filename: 'Show.S01E01.2160p.WEB-DL.DDP5.1.HDR.H.265-GRP.mkv',
      resolution: 2160,
      sizeBytes: 9 * GiB,
    },
  ];
  const { streaming, user, item, second } = fixture(t, {
    listing: listing4k,
    swarms: { [hashes.dead]: { metadataMs: 5 }, [hashes.other]: { metadataMs: 5 } },
    timings: { replacedGraceMs: 10 },
  });
  const hd = await streaming.start(user, item.id, { resolution: 1080, position: 120 });
  await until(() => streaming.status(user, hd.id).conversion?.state === 'ready');
  const next = await streaming.prepareNext(user, hd.id);
  assert.equal(next.itemId, second.id);
  assert.equal(next.parentId, hd.id);
  const uhd = await streaming.switchResolution(user, hd.id, { resolution: 2160, position: 400 });
  assert.equal(uhd.replaces, hd.id);
  assert.equal(streaming.status(user, hd.id).replacedBy, uhd.id);
  await until(() => streaming.status(user, uhd.id).conversion?.state === 'ready');
  assert.equal(streaming.status(user, uhd.id).conversion.requested, 400);
  await new Promise((r) => setTimeout(r, 30));
  assert.throws(() => streaming.status(user, hd.id), /Stream not found/, 'old resolution retired');
});

test('streamed episodes record progress, resume and appear in Continue Watching', () => {
  const store = createStore(':memory:');
  store.run("INSERT INTO users(id,email,name,pw_hash) VALUES(1,'a@test','A','x')");
  const user = store.one('SELECT * FROM users');
  const title = store.saveTitle({ kind: 'tv', external_id: 'tt1', name: 'Show' });
  const item = store.saveItem({ title_id: title.id, season: 1, episode: 1 });
  let streaming = false;
  const history = createHistory(store, { streaming: () => streaming });
  assert.throws(() => history.start(user, item.id), /not downloaded/);
  streaming = true;
  const session = history.start(user, item.id);
  assert.equal(session.source, 'stream');
  history.event(user, session.id, { type: 'progress', seq: 1, position: 300, duration: 3000 });
  const home = createNavigation(store).home(user);
  assert.equal(home.continueWatching[0].resumable.id, item.id);
  assert.equal(history.start(user, item.id).position, 300);
  store.close();
});

test('capabilities and the conversion plan pick copy or transcode for each device', () => {
  assert.deepEqual(capabilitiesFrom(undefined), {
    video: ['h264'],
    maxHeight: 1080,
    audioChannels: 2,
    dolbyVision: false,
    forceTranscode: false,
  });
  assert.throws(() => capabilitiesFrom('hevc'), /Invalid playback capabilities/);
  const uhd = {
    ...info,
    video: 'hevc',
    width: 3840,
    height: 2160,
    pixelFormat: 'yuv420p10le',
    hdr: true,
  };
  const tv = capabilitiesFrom({ video: ['h264', 'hevc', 'hevc10'], maxHeight: 2160 });
  assert.deepEqual(
    (({ copy, segmentFormat, codecs }) => ({ copy, segmentFormat, codecs }))(
      conversionPlan(uhd, tv),
    ),
    { copy: true, segmentFormat: 'fmp4', codecs: 'hvc1.2.4.L153.B0,mp4a.40.2' },
  );
  const chromecast = conversionPlan(uhd, capabilitiesFrom({ video: ['h264'], maxHeight: 1080 }));
  assert.equal(chromecast.copy, false);
  assert.equal(chromecast.maxHeight, 1080);
  assert.equal(chromecast.width, 1920);
  assert.equal(chromecast.tonemap, true);
  assert.match(chromecast.reason, /10-bit HEVC.*up to 1080p/);
  assert.equal(
    conversionPlan({ ...info, pixelFormat: 'yuv420p10le' }, tv).copy,
    false,
    'Hi10P H.264',
  );
  assert.equal(conversionPlan({ ...uhd, dolbyVision: { profile: 5 } }, tv).copy, false);
  assert.equal(conversionPlan({ ...uhd, dolbyVision: { profile: 8 } }, tv).copy, true);
  assert.equal(languageKey('ar'), 'ara');
  assert.equal(languageKey('en-US'), 'eng');
});

test('stream routes require sign-in and the download permission and push live status', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediawan-stream-api-'));
  const store = createStore(':memory:');
  const title = store.saveTitle({ kind: 'movie', external_id: 'tt1', name: 'Film' }),
    item = store.saveItem({ title_id: title.id });
  const application = createApplication(
    {
      ...configuration({}),
      runtime: root,
      reserveBytes: 0,
      adminEmail: 'admin@example.test',
      adminPassword: 'fixture-password',
    },
    {
      store,
      streaming: {
        releases: async () => [
          { ...listing[1], label: 'Film.2023.1080p.WEB-DL.H.264-GRP\n👤 30', sizeBytes: 5 * GiB },
        ],
        guard: () => ({ required: true, ok: true, message: 'VPN up' }),
        createClient: async () => ({
          add: (magnet) =>
            new FakeTorrent(/btih:(\w+)/.exec(magnet)[1], { metadataMs: 20, length: 5 * GiB }),
          on() {},
          destroy: (done) => done(),
        }),
        probe: async () => info,
        statfs: async () => ({ bavail: 1000 * GiB, bsize: 1 }),
        sourceServer: {
          add: async () => ({
            url: 'http://127.0.0.1:1/x',
            source: { readers: new Set() },
            remove() {},
          }),
          close() {},
        },
      },
    },
  );
  const server = application.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await application.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/items/${item.id}/stream-options`)).status, 401);
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.test', password: 'fixture-password' }),
  });
  const headers = {
    'Content-Type': 'application/json',
    Cookie: login.headers.get('set-cookie').split(';')[0],
  };
  const options = await (
    await fetch(`${base}/api/items/${item.id}/stream-options`, { headers })
  ).json();
  assert.equal(options.canStream, true);
  assert.equal(options.guard.ok, true);
  const prepared = await fetch(`${base}/api/items/${item.id}/stream/prepare`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.equal(prepared.status, 202);
  const { id } = await prepared.json();
  const events = await fetch(`${base}/api/streams/${id}/events`, { headers });
  assert.match(events.headers.get('content-type'), /text\/event-stream/);
  const states = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of events.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (const match of buffer.matchAll(/data: (.+)\n\n/g)) states.push(JSON.parse(match[1]).state);
    buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
    if (states.includes('ready')) break;
  }
  assert.equal(states[0], 'finding-peers');
  assert(states.includes('probing'));
  const media = await (await fetch(`${base}/api/streams/${id}/media`, { headers })).json();
  assert.equal(media.duration, 3000);
  const guard = await (await fetch(`${base}/api/streams/guard`, { headers })).json();
  assert.equal(guard.ok, true);
  const bad = await fetch(`${base}/api/items/${item.id}/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ capabilities: 'all' }),
  });
  assert.equal(bad.status, 400);
  assert.equal(
    (await fetch(`${base}/api/streams/${id}`, { method: 'DELETE', headers, body: '{}' })).status,
    200,
  );
  const gone = await fetch(`${base}/api/streams/${id}`, { headers });
  assert.equal(gone.status, 404);
  assert.match((await gone.json()).error, /press play again/);
});

// ---- Regression tests from the independent review ---------------------------------------

test('each device gets its own conversion at its resume point; stopping one leaves the other', async (t) => {
  const { streaming, store, user, item, added, conversions } = fixture(t, {
    swarms: { [hashes.dead]: { metadataMs: 5 } },
  });
  const laptop = await streaming.start(user, item.id, {
    resolution: 1080,
    position: 100,
    player: 'laptop',
    capabilities: { video: ['h264', 'hevc'], maxHeight: 2160 },
  });
  await until(() => streaming.status(user, laptop.id).conversion?.state === 'ready');
  assert.equal(streaming.status(user, laptop.id).player, 'laptop');
  // The laptop watched to 900 s; then the TV presses Resume without a position.
  store.run(
    'INSERT INTO history(user_id,item_id,position,duration) VALUES(?,?,900,3000) ON CONFLICT(user_id,item_id) DO UPDATE SET position=900',
    user.id,
    item.id,
  );
  const tv = await streaming.start(user, item.id, {
    resolution: 1080,
    player: 'tv',
    capabilities: { video: ['h264'], maxHeight: 720 },
  });
  assert.notEqual(tv.id, laptop.id, 'a second device never takes over the first one');
  await until(() => streaming.status(user, tv.id).conversion?.state === 'ready');
  const tvStatus = streaming.status(user, tv.id);
  assert.equal(tvStatus.conversion.requested, 900, 'resumes at the saved position');
  assert.equal(tvStatus.conversion.mode, 'transcode', 'planned for the TV capabilities');
  assert.equal(streaming.status(user, laptop.id).conversion.mode, 'copy');
  assert.equal(added.filter((a) => a.hash === hashes.dead).length, 1, 'one shared torrent');
  // Progress reports cannot tell the devices apart, so they move neither playhead.
  streaming.observe(user, item.id, 1500);
  assert.equal(streaming.status(user, tv.id).buffer.position, 900);
  // Closing the TV leaves the laptop playing on the same torrent.
  await streaming.stop(user, tv.id).cleanup;
  assert.equal(streaming.status(user, laptop.id).state, 'ready');
  assert.equal(added.find((a) => a.hash === hashes.dead).torrent.destroyed, false);
  // The same player starting again gets a fresh conversion at the resume point.
  const before = conversions.length;
  const again = await streaming.start(user, item.id, { resolution: 1080, player: 'laptop' });
  assert.equal(again.id, laptop.id);
  await until(() => streaming.status(user, laptop.id).conversion?.state === 'ready');
  assert.equal(conversions.length, before + 1);
  assert.equal(streaming.status(user, laptop.id).conversion.requested, 900);
  // A start without a player id never reuses a session that is playing.
  const anonymous = await streaming.start(user, item.id, { resolution: 1080 });
  assert(![laptop.id, tv.id].includes(anonymous.id));
  await streaming.stop(user, anonymous.id).cleanup;
  // A prepared session is not playing anywhere, so any player may claim it.
  const prepared = await streaming.prepare(user, item.id, { resolution: 1080 });
  const claimed = await streaming.start(user, item.id, { resolution: 1080, player: 'phone' });
  assert.equal(claimed.id, prepared.id);
  assert.equal(claimed.player, 'phone');
  await assert.rejects(streaming.start(user, item.id, { player: 'bad id!' }), /Invalid player id/);
});

test('Try again recovers from a failed first conversion; compatibility playback forces a transcode', async (t) => {
  let failNext = true;
  const { streaming, user, item, conversions } = fixture(t, {
    wrapMedia(media) {
      const original = media.startStream;
      media.startStream = async (...args) => {
        if (failNext) {
          failNext = false;
          throw Object.assign(new Error('Both video conversion slots are busy.'), { status: 503 });
        }
        return original(...args);
      };
    },
  });
  const first = await streaming.start(user, item.id, { resolution: 1080, player: 'p' });
  await until(() => streaming.status(user, first.id).state === 'failed');
  assert.equal(streaming.status(user, first.id).error.reason, 'conversion');
  const again = await streaming.start(user, item.id, { resolution: 1080, player: 'p' });
  assert.equal(again.id, first.id);
  await until(() => streaming.status(user, first.id).conversion?.state === 'ready');
  assert.equal(conversions.length, 1);
  const safe = await streaming.convert(user, first.id, {
    position: 50,
    capabilities: { video: ['h264'], forceTranscode: true },
  });
  assert.equal(safe.mode, 'transcode');
  assert.match(safe.reason, /Compatibility playback requested/);
  assert.equal(conversions[1].options.convert.copy, false);
});

test('a VPN drop seen by any check stops torrents at once, and requests cannot postpone it', async (t) => {
  const { streaming, user, item, added, state } = fixture(t, { timings: { guardMs: 3600000 } });
  const prepared = await streaming.prepare(user, item.id, {});
  await until(() => streaming.status(user, prepared.id).state === 'ready');
  state.vpn = false;
  await new Promise((r) => setTimeout(r, 510)); // past the 500 ms request cache
  // A request that only reads the guard (title page, hover warm-up) triggers the shutdown.
  await streaming.options(user, item.id);
  await until(() => added.every((a) => a.torrent.destroyed), 500);
  assert.equal(streaming.status(user, prepared.id).error.reason, 'vpn');
  assert.equal(streaming._internal.entries.size, 0);
});

test('the periodic VPN check runs on its own timer, without requests or ticks', async (t) => {
  const { streaming, user, item, added, state } = fixture(t, { timings: { guardMs: 50 } });
  const prepared = await streaming.prepare(user, item.id, {});
  await until(() => streaming.status(user, prepared.id).state === 'ready');
  state.vpn = false;
  const dropped = Date.now();
  await until(() => added.every((a) => a.torrent.destroyed), 1000);
  assert(Date.now() - dropped < 1000);
});

test('going back to the original quality cancels the pending retirement', async (t) => {
  const listing4k = [
    ...listing.slice(0, 2),
    {
      ...listing[1],
      hash: hashes.other,
      label: 'Show.S01E01.2160p.WEB-DL.DDP5.1.HDR.H.265-GRP\n👤 30 💾 9.0 GB',
      filename: 'Show.S01E01.2160p.WEB-DL.DDP5.1.HDR.H.265-GRP.mkv',
      resolution: 2160,
      sizeBytes: 9 * GiB,
    },
  ];
  const { streaming, user, item } = fixture(t, {
    listing: listing4k,
    swarms: { [hashes.dead]: { metadataMs: 5 }, [hashes.other]: { metadataMs: 5 } },
    timings: { replacedGraceMs: 50 },
  });
  const hd = await streaming.start(user, item.id, { resolution: 1080, position: 120, player: 'p' });
  await until(() => streaming.status(user, hd.id).conversion?.state === 'ready');
  const uhd = await streaming.switchResolution(user, hd.id, { resolution: 2160, position: 130 });
  assert.equal(uhd.player, 'p');
  await until(() => streaming.status(user, uhd.id).conversion?.state === 'ready');
  // The viewer picks 1080p again: the front end stops the 4K session.
  await streaming.stop(user, uhd.id).cleanup;
  await new Promise((r) => setTimeout(r, 120));
  const kept = streaming.status(user, hd.id);
  assert.equal(kept.state, 'ready');
  assert.equal(kept.replacedBy, null);
  // Starting the old session again also cancels a pending switch.
  const again = await streaming.switchResolution(user, hd.id, { resolution: 2160 });
  await until(() => streaming.status(user, again.id).conversion?.state === 'ready');
  await streaming.start(user, item.id, { resolution: 1080, player: 'p' });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(streaming.status(user, hd.id).replacedBy, null);
});

test('failed sessions do not hold stream slots', async (t) => {
  const { streaming, user, item, second } = fixture(t, {
    swarms: { [hashes.live]: {} },
    timings: { connectTimeoutMs: 50 },
    config: { streamMaxSessions: 2 },
  });
  for (let n = 0; n < 5; n++) {
    const failed = await streaming.start(user, item.id, { resolution: 1080, player: `p${n}` });
    await until(() => streaming.status(user, failed.id).state === 'failed');
  }
  await assert.doesNotReject(streaming.prepare(user, second.id, {}));
  await assert.doesNotReject(streaming.start(user, item.id, { resolution: 1080, player: 'x' }));
});

test('stopping and replaying the same torrent never deletes the new instance data', async (t) => {
  const { streaming, user, item, added } = fixture(t, {
    swarms: { [hashes.dead]: { metadataMs: 5 } },
  });
  const a = await streaming.start(user, item.id, { resolution: 1080, player: 'p' });
  await until(() => streaming.status(user, a.id).conversion?.state === 'ready');
  const { cleanup } = streaming.stop(user, a.id);
  const b = await streaming.start(user, item.id, { resolution: 1080, player: 'p' });
  await until(() => streaming.status(user, b.id).conversion?.state === 'ready');
  const [oldDir, newDir] = added.filter((x) => x.hash === hashes.dead).map((x) => x.options.path);
  assert.notEqual(oldDir, newDir);
  writeFileSync(path.join(newDir, 'piece'), 'x');
  await cleanup;
  assert(!existsSync(oldDir));
  assert(existsSync(path.join(newDir, 'piece')));
  assert.equal(streaming.status(user, b.id).state, 'ready');
});

test('concurrent starts cannot together exceed the stream cache; a shared file counts once', async (t) => {
  const own = (hash) => [{ ...listing[1], hash }];
  const fx = fixture(t, {
    config: { streamCacheBytes: 10 * GiB }, // one 3 GiB file needs 6 GiB
    listing: (itemId) => own(itemId === fx.item.id ? hashes.live : hashes.other),
    swarms: { [hashes.other]: { metadataMs: 30 } },
  });
  const { streaming, user, item, second, state } = fx;
  state.statfsDelay = 30;
  // Playing sessions cannot be evicted, so only the lock stops both from passing.
  const [a, b] = await Promise.all([
    streaming.start(user, item.id, { resolution: 1080, player: 'p1' }),
    streaming.start(user, second.id, { resolution: 1080, player: 'p2' }),
  ]);
  await until(() =>
    [a, b].every((s) => ['ready', 'failed'].includes(streaming.status(user, s.id).state)),
  );
  const states = [a, b].map((s) => streaming.status(user, s.id));
  assert.equal(states.filter((s) => s.state === 'failed').length, 1);
  assert.equal(states.find((s) => s.state === 'failed').error.reason, 'disk');
  // Another device on the already reserved file needs no extra space.
  const winner = states.find((s) => s.state === 'ready');
  const other = await streaming.start(user, winner.itemId, { resolution: 1080, player: 'tv' });
  await until(() => streaming.status(user, other.id).conversion?.state === 'ready');
});

test('a movie file with the wrong runtime is rejected as a different film and the next release plays', async (t) => {
  const wrongHash = 'e'.repeat(40),
    rightHash = 'f'.repeat(40);
  const release = (hash, name, seeders, gigabytes) => ({
    hash,
    fileIndex: null,
    label: `${name}\n👤 ${seeders} 💾 ${gigabytes} GB`,
    filename: `${name}.mkv`,
    seeders,
    sizeBytes: gigabytes * GiB,
    resolution: 1080,
    trackers: [],
  });
  let probes = 0;
  const { streaming, store, user } = fixture(t, {
    // The lookalike is far better seeded, so it ranks first.
    listing: [
      release(wrongHash, 'Film 2026 1080p AMZN WEB-DL DDP5 1 H 264-GRP', 900, 4),
      release(rightHash, 'Film.2026.1080p.WEB-DL.DDP5.1.H.264-OTHER', 20, 4),
    ],
    swarms: {
      [wrongHash]: { metadataMs: 10, length: 4 * GiB },
      [rightHash]: { metadataMs: 10, length: 4 * GiB },
    },
    // First file probed is 86 minutes; the title runs 173.
    probe: async () => ({ ...info, duration: probes++ ? 10380 : 5166 }),
  });
  const title = store.saveTitle({
    kind: 'movie',
    external_id: 'tt9',
    name: 'Film',
    runtimeSeconds: 10380,
  });
  const item = store.saveItem({ title_id: title.id, season: 0, episode: 0 });
  const first = await streaming.options(user, item.id);
  assert.equal(first.resolutions[0].release.hash, wrongHash);
  const prepared = await streaming.prepare(user, item.id, { resolution: 1080 });
  await until(() => streaming.status(user, prepared.id).state === 'ready');
  const ready = streaming.status(user, prepared.id);
  assert.equal(ready.release.hash, rightHash);
  assert.match(ready.fallback.reason, /different film.*86 min.*173 min/);
  // The rejection is remembered: the wrong film is no longer offered for this title.
  const again = await streaming.options(user, item.id);
  assert.equal(again.resolutions[0].release.hash, rightHash);
  assert.equal(again.resolutions[0].alternatives, 0);
});

test('when every release is a different film the stream fails with a clear reason', async (t) => {
  const wrongHash = 'e'.repeat(40);
  const { streaming, store, user } = fixture(t, {
    listing: [
      {
        hash: wrongHash,
        fileIndex: null,
        label: 'Film 2026 1080p AMZN WEB-DL DDP5 1 H 264-GRP\n👤 900 💾 4 GB',
        filename: 'Film 2026 1080p AMZN WEB-DL DDP5 1 H 264-GRP.mkv',
        seeders: 900,
        sizeBytes: 4 * GiB,
        resolution: 1080,
        trackers: [],
      },
    ],
    swarms: { [wrongHash]: { metadataMs: 10, length: 4 * GiB } },
    probe: async () => ({ ...info, duration: 5166 }),
  });
  const title = store.saveTitle({
    kind: 'movie',
    external_id: 'tt9',
    name: 'Film',
    runtimeSeconds: 10380,
  });
  const item = store.saveItem({ title_id: title.id, season: 0, episode: 0 });
  const prepared = await streaming.prepare(user, item.id, { resolution: 1080 });
  await until(() => streaming.status(user, prepared.id).state === 'failed');
  const failed = streaming.status(user, prepared.id);
  assert.equal(failed.error.reason, 'wrong-film');
  assert.match(failed.error.message, /different film with the same name/);
  const after = await streaming.options(user, item.id);
  assert.equal(after.resolutions[0].available, false);
});

test('an older series with nothing sound at 1080p is offered its best lower quality beside 4K', async (t) => {
  const r = (hash, name, seeders, megabytes, resolution) => ({
    hash: hash.repeat(40),
    fileIndex: null,
    label: `${name}\n👤 ${seeders} 💾 ${megabytes} MB`,
    filename: `${name}.mkv`,
    seeders,
    sizeBytes: megabytes * MiB,
    resolution,
    trackers: [],
  });
  const dvd = r('1', 'Sitcom.S01E01.DVDRip.x264-GRP', 60, 280, null);
  const revival = r('2', 'Sitcom 2026 S01E01 1080p DSNP WEB-DL DDP5 1 H 264-NTb', 500, 1100, 1080);
  const dub = r('3', 'Sitcom.S01E01.1080p.WEB-DL.H265-FT [Lektor PL]', 30, 400, 1080);
  const { streaming, store, user } = fixture(t, {
    listing: (itemId) => listings[itemId],
    swarms: { [dvd.hash]: { metadataMs: 10, length: 280 * MiB } },
  });
  const title = store.saveTitle({
    kind: 'tv',
    external_id: 'tt7',
    name: 'Sitcom',
    year: '1993',
    releaseInfo: '1993-2004',
  });
  const item = store.saveItem({ title_id: title.id, season: 1, episode: 1, runtimeSeconds: 1320 });
  const hd = store.saveItem({ title_id: title.id, season: 1, episode: 2, runtimeSeconds: 1320 });
  const listings = {
    // The revival is another series; the only real 1080p release is a dub.
    [item.id]: [dvd, revival, dub],
    // A sound 1080p release keeps the 1080p card even when a DVD rip is better seeded.
    [hd.id]: [dvd, r('4', 'Sitcom.S01E02.1080p.AMZN.WEB-DL.DDP2.0.H.264-NTb', 25, 1500, 1080)],
  };
  const options = await streaming.options(user, item.id);
  assert.deepEqual(
    options.resolutions.map((o) => [o.resolution, o.available]),
    [
      [480, true],
      [2160, false],
    ],
  );
  assert.equal(options.defaultResolution, 480);
  assert.equal(options.resolutions[0].release.hash, dvd.hash);
  assert.equal(options.resolutions[0].release.source, 'poor');
  // With no resolution asked for, the stream starts at that quality.
  const prepared = await streaming.prepare(user, item.id, {});
  assert.equal(prepared.resolution, 480);
  await until(() => streaming.status(user, prepared.id).state === 'ready');
  assert.equal(streaming.status(user, prepared.id).release.hash, dvd.hash);
  assert.deepEqual(
    (await streaming.options(user, hd.id)).resolutions.map((o) => o.resolution),
    [1080, 2160],
  );
  await assert.rejects(streaming.prepare(user, item.id, { resolution: 360 }), /Choose 480, 720/);
});

// ---- Streaming filter: trusted groups and confirmed subtitles --------------------------
const filterHashes = { grp: '1'.repeat(40), ntb: '2'.repeat(40), flux: '3'.repeat(40) };
const filterRelease = (hash, name, seeders) => ({
  hash,
  fileIndex: null,
  label: `${name}\n👤 ${seeders} 💾 3.0 GB`,
  filename: `${name}.mkv`,
  seeders,
  sizeBytes: 3 * GiB,
  resolution: 1080,
  trackers: [],
});
const filterListing = [
  // Far better seeded, so it scores highest, but its group is not trusted.
  filterRelease(filterHashes.grp, 'Show.S01E01.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRP', 500),
  filterRelease(filterHashes.ntb, 'Show.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-NTb', 40),
  filterRelease(filterHashes.flux, 'Show.S01E01.1080p.AMZN.WEB-DL.DDP5.1.H.264-FLUX', 20),
];
const filterSwarms = {
  [filterHashes.grp]: { metadataMs: 10, name: 'grp.mkv' },
  [filterHashes.ntb]: { metadataMs: 10, name: 'ntb.mkv' },
  [filterHashes.flux]: { metadataMs: 10, name: 'flux.mkv' },
};
// Subtitle tracks per file: NTb has Arabic text, English only as an image and as forced.
const filterTracks = {
  'grp.mkv': [{ index: 3, codec: 'subrip', language: 'eng', forced: false }],
  'ntb.mkv': [
    { index: 3, codec: 'subrip', language: 'ara', forced: false },
    { index: 4, codec: 'hdmv_pgs_subtitle', language: 'eng', forced: false },
    { index: 5, codec: 'subrip', language: 'eng', forced: true },
  ],
  'flux.mkv': [{ index: 3, codec: 'subrip', language: 'eng', forced: false }],
};
const probeTracks =
  (tracks = filterTracks, probed = []) =>
  async (url) => {
    const name = url.split('/').pop();
    probed.push(name);
    return { ...info, subtitles: (tracks[name] || []).map((t) => ({ title: '', ...t })) };
  };

test('the streaming filter offers trusted releases first, and can be turned off', async (t) => {
  const on = fixture(t, { listing: filterListing, swarms: filterSwarms });
  const first = (await on.streaming.options(on.user, on.item.id)).resolutions[0];
  assert.equal(first.release.hash, filterHashes.ntb);
  assert.equal(first.release.trusted, true);
  assert.equal(first.release.subtitles, null);
  const off = fixture(t, {
    listing: filterListing,
    swarms: filterSwarms,
    rules: { trustedOnly: false, requireSubtitles: false },
  });
  const plain = (await off.streaming.options(off.user, off.item.id)).resolutions[0];
  assert.equal(plain.release.hash, filterHashes.grp);
  assert.equal(plain.release.trusted, null);
});

test('a file without subtitles in the viewer language is skipped for the next trusted one', async (t) => {
  const probed = [];
  const { streaming, user, item } = fixture(t, {
    listing: filterListing,
    swarms: filterSwarms,
    probe: probeTracks(filterTracks, probed),
  });
  const prepared = await streaming.prepare(user, item.id, { resolution: 1080 });
  await until(() => streaming.status(user, prepared.id).state === 'ready');
  const ready = streaming.status(user, prepared.id);
  assert.equal(ready.release.hash, filterHashes.flux);
  assert.equal(ready.release.subtitles, true);
  assert.equal(ready.fallback.kind, 'subtitles');
  assert.equal(ready.fallback.from.hash, filterHashes.ntb);
  assert.match(ready.fallback.reason, /no English subtitles/);
  assert.deepEqual(ready.warnings, []);
  assert.deepEqual(
    ready.attempts.map((a) => [a.hash, a.state]),
    [
      [filterHashes.ntb, 'no-subtitles'],
      [filterHashes.flux, 'won'],
    ],
  );
  // The untrusted release was never opened, and what was read is remembered: next time
  // the file known to lack subtitles comes after the one known to have them.
  assert.deepEqual(probed, ['ntb.mkv', 'flux.mkv']);
  const again = (await streaming.options(user, item.id)).resolutions[0];
  assert.equal(again.release.hash, filterHashes.flux);
  assert.equal(again.release.subtitles, true);
});

test('the preferred subtitle language decides which file has confirmed subtitles', async (t) => {
  const { streaming, store, user, item } = fixture(t, {
    listing: filterListing,
    swarms: filterSwarms,
    probe: probeTracks(),
  });
  store.run(
    'INSERT INTO preferences VALUES(?,?)',
    user.id,
    JSON.stringify({ subtitleLanguage: 'ar' }),
  );
  const prepared = await streaming.prepare(user, item.id, { resolution: 1080 });
  await until(() => streaming.status(user, prepared.id).state === 'ready');
  const ready = streaming.status(user, prepared.id);
  assert.equal(ready.release.hash, filterHashes.ntb);
  assert.equal(ready.fallback, null);
  assert.deepEqual(ready.warnings, []);
});

test('when no trusted file has the subtitles, the best one plays with a warning', async (t) => {
  const probed = [];
  const { streaming, user, item } = fixture(t, {
    listing: filterListing,
    swarms: filterSwarms,
    probe: probeTracks({}, probed),
  });
  const prepared = await streaming.prepare(user, item.id, { resolution: 1080 });
  await until(() => streaming.status(user, prepared.id).state === 'ready');
  const ready = streaming.status(user, prepared.id);
  // Both trusted files were read; the better of them is opened again and plays.
  assert.equal(ready.release.hash, filterHashes.ntb);
  assert.equal(ready.release.subtitles, false);
  assert.deepEqual(probed, ['ntb.mkv', 'flux.mkv', 'ntb.mkv']);
  assert.deepEqual(
    ready.attempts.map((a) => [a.hash, a.state]),
    [
      [filterHashes.ntb, 'no-subtitles'],
      [filterHashes.flux, 'no-subtitles'],
      [filterHashes.ntb, 'won'],
    ],
  );
  assert.equal(ready.warnings.length, 1);
  assert.match(ready.warnings[0], /No English subtitles in this file/);
});

test('with no trusted release listed, an untrusted one plays and says so', async (t) => {
  const { streaming, user, item } = fixture(t, {
    listing: [filterListing[0]],
    swarms: filterSwarms,
    probe: probeTracks(),
  });
  const option = (await streaming.options(user, item.id)).resolutions[0];
  assert.equal(option.release.trusted, false);
  const prepared = await streaming.prepare(user, item.id, { resolution: 1080 });
  await until(() => streaming.status(user, prepared.id).state === 'ready');
  const ready = streaming.status(user, prepared.id);
  assert.equal(ready.release.hash, filterHashes.grp);
  assert.deepEqual(ready.warnings, [
    'Not from a trusted release group (GRP): no trusted release of this quality is listed.',
  ]);
});
