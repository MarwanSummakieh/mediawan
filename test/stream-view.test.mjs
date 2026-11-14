import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectCapabilities,
  rememberDecodeFailure,
  codecKey,
  requiredCodec,
  streamPlan,
  releaseFacts,
  releaseDetail,
  chooseResolution,
  rememberedResolution,
  rememberResolution,
  startupView,
  failureView,
  failureReason,
  fallbackNote,
  formatBytes,
  formatSpeed,
  resolutionLabel,
} from '../public/streaming.js';

const mse = (supported) => ({ isTypeSupported: (type) => supported.some((s) => type.includes(s)) });
const release = (fields = {}) => ({
  hash: 'h',
  name: 'Show S01E01 1080p HMAX WEB-DL DDP5 1 H 264-FLUX',
  sizeBytes: 4402341478,
  seeders: 11,
  service: 'HMAX',
  group: 'FLUX',
  hdr: false,
  dolbyVision: false,
  dolbyVisionOnly: false,
  hevc: false,
  seasonPack: false,
  ...fields,
});
const option = (resolution, fields = {}) => ({
  resolution,
  available: true,
  release: release({ resolution, ...fields }),
});
const uhd = { video: ['h264', 'hevc', 'hevc10'], maxHeight: 2160 };
const fullHd = { video: ['h264'], maxHeight: 1080 };

test('device capabilities follow MSE support and the panel, not the app canvas', () => {
  assert.deepEqual(
    detectCapabilities({
      MediaSource: mse(['avc1', 'hvc1.1', 'hvc1.2']),
      screen: { width: 1920, height: 1080 },
      devicePixelRatio: 2,
    }),
    { video: ['h264', 'hevc', 'hevc10'], maxHeight: 2160, audioChannels: 2, dolbyVision: false },
  );
  // Tizen: a 1920×1080 canvas on a UHD panel.
  const tizen = detectCapabilities({
    MediaSource: mse(['avc1', 'hvc1.1']),
    screen: { width: 1920, height: 1080 },
    devicePixelRatio: 1,
    webapis: { productinfo: { isUdPanelSupported: () => true } },
  });
  assert.equal(tizen.maxHeight, 2160);
  assert.deepEqual(tizen.video, ['h264', 'hevc']);
  // No MSE (native HLS) and a throwing check still mean H.264 at 1080p.
  assert.deepEqual(detectCapabilities({ screen: { width: 1280, height: 720 } }).video, ['h264']);
  const broken = detectCapabilities({
    MediaSource: {
      isTypeSupported: () => {
        throw new Error('nope');
      },
    },
    webapis: {
      productinfo: {
        isUdPanelSupported: () => {
          throw new Error('denied');
        },
      },
    },
    screen: { width: 1920, height: 1080 },
  });
  assert.deepEqual(broken, {
    video: ['h264'],
    maxHeight: 1080,
    audioChannels: 2,
    dolbyVision: false,
  });
});

test('5.1 audio is requested only when the audio output has six channels', () => {
  const output = (channels, closed = []) =>
    class {
      constructor() {
        this.destination = { maxChannelCount: channels };
      }
      close() {
        closed.push(channels);
        return Promise.resolve();
      }
    };
  const closed = [];
  const screen = { width: 1920, height: 1080 };
  assert.equal(detectCapabilities({ screen, AudioContext: output(2, closed) }).audioChannels, 2);
  assert.equal(detectCapabilities({ screen, AudioContext: output(8, closed) }).audioChannels, 6);
  assert.deepEqual(closed, [2, 8]);
  const refused = class {
    constructor() {
      throw new Error('not allowed');
    }
  };
  assert.equal(detectCapabilities({ screen, webkitAudioContext: refused }).audioChannels, 2);
  assert.equal(detectCapabilities({ screen }).audioChannels, 2);
});

test('4K is not offered where the device cannot play it, and conversions are explained', () => {
  assert.equal(requiredCodec(release()), 'h264');
  assert.equal(requiredCodec(release({ hevc: true })), 'hevc');
  assert.equal(requiredCodec(release({ hevc: true, hdr: true })), 'hevc10');
  const hdr4k = option(2160, { hevc: true, hdr: true });
  assert.deepEqual(streamPlan(hdr4k, uhd), { selectable: true, note: '', warning: '' });
  const screen = streamPlan(hdr4k, { ...uhd, maxHeight: 1080 });
  assert.equal(screen.selectable, false);
  assert.match(screen.note, /up to 1080p/);
  const decoder = streamPlan(hdr4k, { video: ['h264', 'hevc'], maxHeight: 2160 });
  assert.equal(decoder.selectable, false);
  assert.match(decoder.note, /HEVC 10-bit/);
  const dolby = streamPlan(
    option(2160, { hevc: true, dolbyVision: true, dolbyVisionOnly: true }),
    uhd,
  );
  assert.equal(dolby.selectable, false);
  assert.match(dolby.note, /Dolby Vision only/);
  // A 1080p HEVC HDR copy on an H.264-only device still plays, converted on the server.
  const converted = streamPlan(option(1080, { hevc: true, hdr: true }), fullHd);
  assert.equal(converted.selectable, true);
  assert.match(converted.warning, /converts this.*HDR shows as SDR/);
  const missing = streamPlan(
    {
      resolution: 2160,
      available: false,
      reason: 'No 2160p release passes the rules. Best: Fewer than 5 reported seeders',
    },
    uhd,
  );
  assert.equal(missing.selectable, false);
  assert.equal(
    missing.note,
    'No 4K release meets your rules right now (closest: fewer than 5 reported seeders).',
  );
});

test('option cards read as size, service and HDR; details as codec, group and seeders', () => {
  assert.deepEqual(releaseFacts(release()), ['4.4 GB', 'HMAX']);
  assert.deepEqual(releaseFacts(release({ hdr: true, sizeBytes: 15.2e9, service: '' })), [
    '15 GB',
    'HDR',
  ]);
  assert.deepEqual(releaseFacts(release({ hdr: true, dolbyVision: true })), [
    '4.4 GB',
    'HMAX',
    'Dolby Vision · HDR',
  ]);
  assert.equal(releaseDetail(release()), 'H.264 · FLUX · 11 seeders');
  assert.equal(
    releaseDetail(release({ hevc: true, seeders: 1, seasonPack: true })),
    'HEVC · FLUX · 1 seeder · season pack',
  );
  assert.deepEqual(releaseFacts(null), []);
  assert.equal(formatBytes(129241752), '129 MB');
  assert.equal(formatBytes(850), '1 KB');
  assert.equal(formatSpeed(2649402), '2.6 MB/s');
  assert.equal(formatSpeed(8737), '9 KB/s');
  assert.equal(resolutionLabel(2160), '4K');
  assert.equal(resolutionLabel(1080), '1080p');
});

test('the remembered resolution is the default only while this device can play it', () => {
  const options = { defaultResolution: 2160, resolutions: [option(1080), option(2160)] };
  assert.equal(chooseResolution(options, null, uhd), 2160);
  assert.equal(chooseResolution(options, 1080, uhd), 1080);
  assert.equal(chooseResolution(options, 2160, fullHd), 1080);
  const only4k = {
    defaultResolution: 2160,
    resolutions: [{ resolution: 1080, available: false, reason: 'x' }, option(2160)],
  };
  assert.equal(chooseResolution(only4k, 1080, uhd), 2160);
  assert.equal(chooseResolution(only4k, null, fullHd), null);
  const values = new Map();
  const storage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
  assert.equal(rememberedResolution(7, storage), null);
  rememberResolution(7, 2160, storage);
  rememberResolution(7, 360, storage);
  assert.equal(rememberedResolution(7, storage), 2160);
  // 720p and SD stand in for 1080p, so choosing one is remembered as the standard quality
  // and picks whichever standard quality the next title offers.
  rememberResolution(7, 720, storage);
  assert.equal(rememberedResolution(7, storage), 1080);
  const sitcom = { defaultResolution: 480, resolutions: [option(480), option(2160)] };
  assert.equal(chooseResolution(sitcom, 1080, uhd), 480);
  assert.equal(chooseResolution(sitcom, 2160, uhd), 2160);
  assert.equal(chooseResolution(sitcom, null, fullHd), 480);
  rememberResolution(7, 2160, storage);
  assert.equal(rememberedResolution(8, storage), null);
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(rememberedResolution(7, blocked), null);
  assert.doesNotThrow(() => rememberResolution(7, 1080, blocked));
});

test('start-up progress is live and honest at every stage', () => {
  assert.equal(startupView(null).stage, 'sources');
  const finding = startupView({
    state: 'finding-peers',
    peers: 0,
    attempts: [{ state: 'trying' }, { state: 'trying' }],
  });
  assert.deepEqual(
    [finding.stage, finding.title, finding.detail, finding.progress],
    ['sources', 'Finding sources', 'Trying 2 releases', null],
  );
  // Never silent for long: after 10 s the copy says it is still looking and for how long.
  assert.match(
    startupView({ state: 'finding-peers', attempts: [] }, { elapsedMs: 12000 }).detail,
    /Still looking.*45 seconds/,
  );
  const connecting = startupView({ state: 'fetching-metadata', peers: 1, downloadSpeed: 0 });
  assert.equal(connecting.stage, 'connecting');
  assert.equal(connecting.detail, '1 peer · getting the file list');
  const probing = startupView({
    state: 'probing',
    peers: 5,
    downloadSpeed: 2649402,
    file: { size: 129241752, downloaded: 5242880 },
  });
  assert.equal(probing.stage, 'buffering');
  assert.equal(probing.detail, '5 MB of 10 MB · 5 peers · 2.6 MB/s');
  assert.ok(Math.abs(probing.progress - 0.475) < 1e-9);
  // A small file needs only itself.
  assert.equal(
    startupView({ state: 'probing', file: { size: 4e6, downloaded: 4e6 } }).progress,
    0.95,
  );
  // Once head and tail are in, it says what it is doing instead of "10 MB of 10 MB".
  assert.equal(
    startupView({
      state: 'probing',
      peers: 3,
      file: { size: 129241752, downloaded: 10485760 },
    }).detail,
    'Reading the video · 3 peers',
  );
  assert.equal(startupView({ state: 'starting', peers: 3 }).title, 'Starting playback');
  assert.equal(
    startupView({ state: 'ready', conversion: { state: 'ready', url: '/x' } }).stage,
    'playing',
  );
  const buffering = startupView({
    state: 'buffering',
    peers: 2,
    conversion: { state: 'ready' },
    buffer: { convertedAheadSeconds: 3 },
  });
  assert.deepEqual([buffering.stage, buffering.progress], ['buffering', 0.5]);
  assert.equal(startupView({ state: 'failed', message: 'No peers' }).stage, 'failed');
});

test('failures say what happened and always offer a next step', () => {
  const vpn = failureView('vpn', 'Connect the VPN to stream.', { canDownload: true });
  assert.equal(vpn.title, 'Connect the VPN to stream');
  assert.deepEqual(
    vpn.actions.map((a) => a.id),
    ['retry', 'download'],
  );
  const unavailable = failureView(
    'unavailable',
    'No 2160p release passes the rules. Best: Fewer than 5 reported seeders',
    { resolution: 2160, other: { resolution: 1080, available: true } },
  );
  assert.equal(unavailable.title, 'No 4K release right now');
  assert.deepEqual(unavailable.actions[0], {
    id: 'other-resolution',
    label: 'Try 1080p',
    resolution: 1080,
  });
  const peers = failureView('no-peers', '', {
    resolution: 1080,
    other: { resolution: 2160, available: false },
  });
  assert.deepEqual(
    peers.actions.map((a) => a.id),
    ['retry', 'download'],
  );
  const disk = failureView('disk', 'Not enough free space.', {
    resolution: 2160,
    other: { resolution: 1080, available: true },
  });
  assert.equal(disk.actions[0].label, 'Try 1080p (smaller)');
  assert.equal(
    failureView('disk', '', { resolution: 1080, other: { resolution: 2160, available: true } })
      .actions[0].id,
    'retry',
  );
  // Only this device's own sessions may be stopped; other devices keep playing.
  const limitHere = failureView('limit', '', { ownOthers: 2 });
  assert.equal(limitHere.actions[0].id, 'stop-others');
  assert.match(limitHere.body, /other devices keep playing/);
  const limitElsewhere = failureView('limit', '', { ownOthers: 0 });
  assert.ok(!limitElsewhere.actions.some((a) => a.id === 'stop-others'));
  assert.match(limitElsewhere.body, /other devices/);
  // A decode/player error offers compatibility playback, unless that is what failed.
  const playback = failureView('playback', 'x', { other: { resolution: 2160, available: true } });
  assert.deepEqual(
    playback.actions.map((a) => a.id),
    ['compatibility', 'retry', 'other-resolution', 'download'],
  );
  assert.ok(
    !failureView('playback', 'x', { compatible: true }).actions.some(
      (a) => a.id === 'compatibility',
    ),
  );
  assert.deepEqual(
    failureView('permission').actions.map((a) => a.id),
    ['close'],
  );
  assert.deepEqual(
    failureView('conversion', 'Both transcode slots are busy', { canDownload: false }).actions.map(
      (a) => a.id,
    ),
    ['retry'],
  );
  assert.equal(failureView('stopped', 'Stopped').body, 'The server closed this stream.');
  for (const reason of ['vpn', 'unavailable', 'no-peers', 'disk', 'limit', 'permission', 'x'])
    assert.ok(failureView(reason, 'm', { resolution: 1080 }).actions.length, reason);
  assert.equal(failureReason({ state: 'failed', error: { reason: 'no-peers' } }), 'no-peers');
  assert.equal(failureReason(Object.assign(new Error('x'), { reason: 'vpn' })), 'vpn');
  assert.equal(failureReason(new Error('x')), 'failed');
});

test('a fallback release is mentioned briefly', () => {
  assert.equal(fallbackNote({ fallback: null }), '');
  assert.equal(
    fallbackNote({ fallback: { to: release({ service: 'AMZN', group: 'NTb' }) } }),
    'The first choice was slow to answer, so this plays a different copy (AMZN · NTb).',
  );
});

test('a codec that failed to decode on this device is remembered and no longer claimed', () => {
  const saved = new Map();
  const env = {
    MediaSource: mse(['avc1', 'hvc1']),
    screen: { width: 1920, height: 1080 },
    localStorage: {
      getItem: (key) => (saved.has(key) ? saved.get(key) : null),
      setItem: (key, value) => saved.set(key, value),
    },
  };
  assert.deepEqual(detectCapabilities(env).video, ['h264', 'hevc', 'hevc10']);
  const file = { video: 'hevc', pixelFormat: 'yuv420p10le' };
  assert.equal(codecKey(file), 'hevc10');
  assert.equal(rememberDecodeFailure(env, file), true);
  // 8-bit HEVC was not what failed, so it is still offered.
  assert.deepEqual(detectCapabilities(env).video, ['h264', 'hevc']);
  // A device that fails 8-bit HEVC cannot decode 10-bit either.
  assert.equal(rememberDecodeFailure(env, { video: 'hevc', pixelFormat: 'yuv420p' }), true);
  assert.deepEqual(detectCapabilities(env).video, ['h264']);
  // H.264 is what the server converts to; a failure there is never remembered.
  assert.equal(rememberDecodeFailure(env, { video: 'h264', pixelFormat: 'yuv420p' }), false);
  assert.deepEqual(detectCapabilities(env).video, ['h264']);
  // Unreadable storage must not break detection.
  const broken = { ...env, localStorage: { getItem: () => '{not json' } };
  assert.deepEqual(detectCapabilities(broken).video, ['h264', 'hevc', 'hevc10']);
});
