import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
  createReadStream,
} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { configuration } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createMedia, keyframeBefore, probe, streamArgs, vttRelative } from '../src/media.mjs';

// A torrent stream reaches FFmpeg as an HTTP URL with range support; this serves a
// generated MKV the same way.
test('stream conversion copies video from an HTTP source, converts audio and writes subtitles', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediawan-stream-media-'));
  const config = { ...configuration({}), runtime: path.join(root, 'runtime') };
  const file = path.join(root, 'fixture.mkv');
  const subtitles = path.join(root, 'fixture.srt');
  writeFileSync(
    subtitles,
    '1\n00:00:01,000 --> 00:00:02,500\nFirst line.\n\n2\n00:00:09,000 --> 00:00:10,000\nLate line.\n',
  );
  execFileSync(
    config.ffmpeg,
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=s=320x180:r=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:sample_rate=48000',
      '-i',
      subtitles,
      '-t',
      '12',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-map',
      '2:s',
      '-c:v',
      'libx264',
      '-g',
      '48',
      '-keyint_min',
      '48',
      '-sc_threshold',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'eac3',
      '-ac',
      '6',
      '-c:s',
      'srt',
      '-metadata:s:s:0',
      'language=eng',
      file,
    ],
    { windowsHide: true },
  );
  const size = statSync(file).size;
  const server = http.createServer((req, res) => {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0,
      end = range && range[2] ? Number(range[2]) : size - 1;
    res.writeHead(range ? 206 : 200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    createReadStream(file, { start, end }).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/stream/fixture.mkv`;
  const store = createStore(':memory:');
  const media = createMedia(store, config);
  t.after(async () => {
    await media.close();
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const info = await probe(url, config);
  assert.equal(info.video, 'h264');
  assert.equal(info.audio[0].codec, 'eac3');
  assert.equal(info.subtitles[0].codec, 'subrip');
  const subtitleIndex = info.subtitles[0].index;
  assert.equal(await keyframeBefore(url, 5, config), 4);
  assert.equal(await keyframeBefore(url, 0, config), 0);

  const user = { id: 1, active: 1 };
  let touched = 0,
    progress = 0;
  const started = await media.startStream(user, {
    itemId: 'item',
    input: url,
    directory: path.join(root, 'runtime', 'streams', 'hls'),
    convert: { seek: 5, copy: true, codec: 'h264', subtitles: [subtitleIndex] },
    authorize: (viewer) => viewer.id === 1,
    onTouch: () => touched++,
    onProgress: (seconds) => (progress = seconds),
    cast: { codecs: 'avc1.640029,mp4a.40.2', resolution: '320x180', bandwidth: 500000 },
  });
  assert.equal(media.active(), 0, 'copy conversions do not take a transcode slot');
  const ready = await started.ready;
  assert.equal(ready.url, `/api/media/sessions/${started.key}/index.m3u8`);
  await new Promise((resolve) => started.session.process.once('exit', resolve));
  assert(progress > 0, 'progress is reported');
  const playlist = readFileSync(media.segment(user, started.key, 'index.m3u8'), 'utf8');
  assert.equal(touched, 1);
  const duration = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].reduce(
    (s, m) => s + Number(m[1]),
    0,
  );
  // Copying starts at the keyframe at 4 s, which is why the reported offset is 4, not 5.
  assert(Math.abs(duration - 8) < 0.3, `playlist covers ${duration} s`);
  const segment = media.segment(user, started.key, 'segment-000000.ts');
  const streams = JSON.parse(
    execFileSync(config.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', segment], {
      windowsHide: true,
    }),
  ).streams;
  assert.equal(streams.find((s) => s.codec_type === 'video').codec_name, 'h264');
  const audio = streams.find((s) => s.codec_type === 'audio');
  assert.equal(audio.codec_name, 'aac');
  assert.equal(audio.channels, 2);
  // Cues are written in source time and served on the playlist timeline (zero = 4 s).
  const raw = readFileSync(
    media.segment(user, started.key, `subtitle-${subtitleIndex}.vtt`),
    'utf8',
  );
  assert.match(raw, /00:09\.000 --> 00:10\.000\nLate line\./);
  const vtt = vttRelative(raw, 4);
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /00:00:05\.000 --> 00:00:06\.000\nLate line\./);
  assert(!/First line\./.test(vtt), 'cues before the start point are skipped');
  assert.throws(() => media.segment({ id: 2 }, started.key, 'index.m3u8'), /not found/);
  assert.throws(() => media.segment(user, started.key, '../fixture.mkv'), /not found/);

  // Chromecast receivers get a token URL and a codec-declaring master playlist.
  const cast = await media.cast(user, started.key);
  const token = new URL(cast.url, 'http://x').searchParams.get('token');
  const master = await media.castFile(started.key, 'master.m3u8', token);
  assert.match(master.body, /CODECS="avc1\.640029,mp4a\.40\.2",RESOLUTION=320x180/);
  const castPlaylist = await media.castFile(started.key, 'index.m3u8', token);
  assert.match(castPlaylist.body, new RegExp(`segment-000000\\.ts\\?token=${token}`));
  await assert.rejects(media.castFile(started.key, 'index.m3u8', 'wrong'), /Cast ended/);
  await assert.rejects(
    media.castFile(started.key, `subtitle-${subtitleIndex}.vtt`, token),
    /not found/,
  );

  // A device that cannot decode the source gets an H.264 transcode, in a transcode slot.
  const transcode = await media.startStream(user, {
    itemId: 'item',
    input: url,
    directory: path.join(root, 'runtime', 'streams', 'hls'),
    convert: { seek: 0, copy: false, maxHeight: 720 },
    authorize: () => true,
  });
  assert.equal(media.active(), 1);
  await transcode.ready;
  await started.stop();
  await transcode.stop();
  assert.equal(media.active(), 0);
});

test('stream arguments copy HEVC into fragmented MP4 and transcode with tone mapping when asked', () => {
  const hevc = streamArgs({
    input: 'http://x',
    directory: 'out',
    copy: true,
    codec: 'hevc',
    seek: 10,
  });
  assert.deepEqual(hevc.slice(hevc.indexOf('-ss'), hevc.indexOf('-ss') + 2), ['-ss', '10']);
  assert(hevc.includes('hvc1'));
  assert(hevc.includes('fmp4'));
  assert(hevc.some((a) => a.endsWith('.m4s')));
  const sdr = streamArgs({
    input: 'http://x',
    directory: 'out',
    copy: false,
    tonemap: true,
    audioChannels: 6,
  });
  assert.match(sdr[sdr.indexOf('-vf') + 1], /tonemap=hable/);
  assert.equal(sdr[sdr.indexOf('-ac') + 1], '6');
  assert(!sdr.includes('-ss'));
  assert.equal(sdr[sdr.indexOf('-hls_init_time') + 1], '1', 'short first segment');
});

// Review finding: after a seek, cues drifted (0.5 s early when copying, 2.5 s late when
// transcoding, for a seek to 13 s with a keyframe at 10 s). Each case below checks that
// the served cue for "second 13" (13.5 s in the source) lands where the video shows it.
test('embedded subtitles stay on the playlist timeline after a seek, copy and transcode', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediawan-subsync-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const config = configuration({});
  const cues = Array.from(
    { length: 30 },
    (_, n) =>
      `${n + 1}\n00:00:${String(n).padStart(2, '0')},500 --> 00:00:${String(n).padStart(2, '0')},900\nsecond ${n}\n`,
  ).join('\n');
  writeFileSync(path.join(root, 'cues.srt'), cues);
  const input = path.join(root, 'gop5.mkv');
  execFileSync(
    config.ffmpeg,
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=s=320x180:r=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:sample_rate=48000',
      '-i',
      path.join(root, 'cues.srt'),
      '-t',
      '30',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-map',
      '2:s',
      '-c:v',
      'libx264',
      '-g',
      '120',
      '-keyint_min',
      '120',
      '-sc_threshold',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'ac3',
      '-c:s',
      'srt',
      input,
    ],
    { windowsHide: true },
  );
  const { duration } = await probe(input, config);
  for (const [seek, copy] of [
    [13, true],
    [13, false],
    [22, true],
    [7, false],
  ]) {
    const directory = path.join(root, `out-${seek}-${copy}`);
    mkdirSync(directory);
    const args = streamArgs({ input, seek, directory, copy, codec: 'h264', subtitles: [2] });
    execFileSync(config.ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
    // Where the playlist really starts in the source: its end is the end of the file.
    const playlist = readFileSync(path.join(directory, 'index.m3u8'), 'utf8');
    const covered = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].reduce((s, m) => s + +m[1], 0);
    const zero = duration - covered;
    // The offset the server reports to the player (conversion.offset).
    const offset = copy ? await keyframeBefore(input, seek, config) : seek;
    // Summed segment durations fall a frame or two short of the end of the file.
    assert(Math.abs(offset - zero) < 0.15, `offset ${offset} vs playlist start ${zero}`);
    const served = vttRelative(
      readFileSync(path.join(directory, 'subtitle-2.vtt'), 'utf8'),
      offset,
    );
    const target = Math.ceil(seek);
    const cue = new RegExp(
      `(\\d\\d):(\\d\\d):(\\d\\d\\.\\d{3}) --> [^\\n]+\\nsecond ${target}\\n`,
    ).exec(served);
    assert(cue, `cue for second ${target} served (seek ${seek}, copy ${copy})`);
    const at = Number(cue[1]) * 3600 + Number(cue[2]) * 60 + Number(cue[3]);
    assert(
      Math.abs(at - (target + 0.5 - offset)) < 0.01,
      `seek ${seek} copy ${copy}: cue at ${at}, video shows it at ${target + 0.5 - offset}`,
    );
  }
});

test('vttRelative shifts, clips and drops cues and keeps cue settings', () => {
  const text =
    'WEBVTT\n\n00:01.000 --> 00:02.000\nGone\n\n00:09.500 --> 00:10.500 line:90%\nClipped\n\n01:00:00.250 --> 01:00:01.000\nLate\n';
  assert.equal(
    vttRelative(text, 10),
    'WEBVTT\n\n00:00:00.000 --> 00:00:00.500 line:90%\nClipped\n\n00:59:50.250 --> 00:59:51.000\nLate\n',
  );
  assert.equal(vttRelative('WEBVTT\n\n', 5), 'WEBVTT\n');
});

// A copied HEVC stream is packaged as fragmented MP4, whose header file (init.mp4) the
// playlist refers to. FFmpeg writes that file relative to its working directory, so it
// used to land in the server's folder and the player could never start the stream.
test('a copied HEVC stream keeps its init segment beside the playlist', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediawan-stream-hevc-'));
  const config = { ...configuration({}), runtime: path.join(root, 'runtime') };
  const file = path.join(root, 'fixture.mkv');
  execFileSync(
    config.ffmpeg,
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=s=320x180:r=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:sample_rate=48000',
      '-t',
      '6',
      '-c:v',
      'libx265',
      '-x265-params',
      'log-level=error:keyint=48:min-keyint=48',
      '-pix_fmt',
      'yuv420p10le',
      '-c:a',
      'eac3',
      '-ac',
      '6',
      file,
    ],
    { windowsHide: true },
  );
  const size = statSync(file).size;
  const server = http.createServer((req, res) => {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0,
      end = range && range[2] ? Number(range[2]) : size - 1;
    res.writeHead(range ? 206 : 200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    createReadStream(file, { start, end }).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/stream/fixture.mkv`;
  const store = createStore(':memory:');
  const media = createMedia(store, config);
  const stray = path.join(process.cwd(), 'init.mp4');
  rmSync(stray, { force: true });
  t.after(async () => {
    await media.close();
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const info = await probe(url, config);
  assert.equal(info.video, 'hevc');
  assert.equal(info.pixelFormat, 'yuv420p10le');
  const user = { id: 1, active: 1 };
  const started = await media.startStream(user, {
    itemId: 'item',
    input: url,
    directory: path.join(root, 'runtime', 'streams', 'hls'),
    convert: { seek: 0, copy: true, codec: 'hevc' },
    authorize: () => true,
  });
  await started.ready;
  await new Promise((resolve) => started.session.process.once('exit', resolve));
  const playlist = media.segment(user, started.key, 'index.m3u8');
  assert.match(readFileSync(playlist, 'utf8'), /#EXT-X-MAP:URI="init\.mp4"/);
  const init = media.segment(user, started.key, 'init.mp4');
  assert.equal(path.dirname(init), path.dirname(playlist));
  assert(statSync(init).size > 0, 'the init segment exists beside the playlist');
  assert.throws(() => statSync(stray), /ENOENT/, 'nothing is written to the server folder');
  const first = media.segment(user, started.key, 'segment-000000.m4s');
  assert(statSync(first).size > 0);
  await started.stop();
});
