import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { id, fail } from './store.mjs';
const execute = promisify(execFile);
// FFmpeg's default surround-to-stereo mix lowers the centre channel, which carries
// dialogue, so speech ends up quiet under music and effects. This keeps dialogue at full
// level and leaves the subwoofer channel out. Stereo sources pass through unchanged.
const STEREO_DOWNMIX =
  'aresample=ochl=stereo:center_mix_level=1.0:surround_mix_level=0.707:lfe_mix_level=0';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export const textSubtitleCodecs = ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text'];
export async function probe(file, config, { timeout = 30000 } = {}) {
  const { stdout } = await execute(
    config.ffprobe,
    ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', file],
    { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  );
  const data = JSON.parse(stdout),
    video = data.streams.find((s) => s.codec_type === 'video');
  if (!video || !(Number(data.format.duration) > 0))
    fail(400, 'File does not contain playable video');
  const dolbyVision = (video.side_data_list || []).find((d) => /DOVI/i.test(d.side_data_type));
  return {
    duration: Number(data.format.duration),
    video: video.codec_name,
    width: video.width,
    height: video.height,
    // Used to decide whether a client can play the video without conversion.
    videoProfile: video.profile || '',
    pixelFormat: video.pix_fmt || '',
    hdr: ['smpte2084', 'arib-std-b67'].includes(video.color_transfer),
    dolbyVision: dolbyVision
      ? {
          profile: dolbyVision.dv_profile ?? null,
          compatibility: dolbyVision.dv_bl_signal_compatibility_id ?? null,
        }
      : null,
    container: String(data.format.format_name || ''),
    bitRate: Number(data.format.bit_rate) || null,
    audio: data.streams
      .filter((s) => s.codec_type === 'audio')
      .map((s) => ({
        index: s.index,
        codec: s.codec_name,
        language: s.tags?.language || 'und',
        title: s.tags?.title || '',
        channels: s.channels,
        default: !!s.disposition?.default,
      })),
    subtitles: data.streams
      .filter((s) => s.codec_type === 'subtitle')
      .map((s) => ({
        index: s.index,
        codec: s.codec_name,
        language: s.tags?.language || 'und',
        title: s.tags?.title || '',
        forced: !!s.disposition?.forced,
      })),
    chapters: (data.chapters || []).map((c) => ({
      start: Number(c.start_time),
      name: c.tags?.title || 'Chapter',
    })),
  };
}

// Time of the keyframe a stream-copy conversion starting at `seek` begins with. Copying
// video cannot cut between keyframes, so the playlist's zero is this time, not `seek`.
export async function keyframeBefore(input, seek, config) {
  if (!(seek > 0)) return 0;
  const { stdout } = await execute(
    config.ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-read_intervals',
      `${seek}%+#1`,
      '-show_entries',
      'packet=pts_time,flags',
      '-of',
      'csv=p=0',
      input,
    ],
    { timeout: 60000, windowsHide: true },
  );
  const time = Number(/^([\d.]+),K/m.exec(stdout)?.[1]);
  return Number.isFinite(time) ? time : seek;
}

// Conversion for a torrent stream. The video is copied whenever the client can decode it,
// which starts in a fraction of the time of a transcode and keeps the original quality;
// audio is always converted to AAC because browsers cannot play E-AC3/TrueHD/DTS.
export function streamArgs({
  input,
  seek = 0,
  audio = null,
  directory,
  copy = true,
  codec = 'h264',
  maxHeight = 1080,
  tonemap = false,
  audioChannels = 2,
  subtitles = [],
}) {
  const fmp4 = copy && codec === 'hevc';
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  args.push('-progress', 'pipe:1', '-stats_period', '0.5');
  if (seek > 0) args.push('-ss', String(seek));
  args.push('-i', input, '-map', '0:v:0', '-map', audio != null ? `0:${audio}` : '0:a:0?');
  args.push('-sn', '-dn');
  if (copy) {
    args.push('-c:v', 'copy');
    if (fmp4) args.push('-tag:v', 'hvc1');
  } else {
    const filters = [];
    // HDR10/HLG sources turn grey and washed out without tone mapping to SDR.
    if (tonemap)
      filters.push(
        'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv',
      );
    filters.push(`scale=w=-2:h='min(${maxHeight},ih)'`, 'format=yuv420p');
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '21',
      '-profile:v',
      'high',
      '-level:v',
      maxHeight > 1080 ? '5.1' : '4.1',
      '-maxrate',
      maxHeight > 1080 ? '25M' : '10M',
      '-bufsize',
      maxHeight > 1080 ? '50M' : '20M',
      '-vf',
      filters.join(','),
      '-force_key_frames',
      'expr:gte(t,n_forced*2)',
    );
  }
  if (audioChannels === 2) args.push('-af', STEREO_DOWNMIX);
  args.push(
    '-c:a',
    'aac',
    '-ac',
    String(audioChannels),
    '-b:a',
    audioChannels > 2 ? '384k' : '256k',
  );
  args.push('-f', 'hls', '-hls_time', '4', '-hls_init_time', '1', '-hls_playlist_type', 'event');
  args.push('-hls_flags', 'independent_segments+temp_file');
  if (fmp4) args.push('-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4');
  args.push(
    '-hls_segment_filename',
    path.join(directory, `segment-%06d.${fmp4 ? 'm4s' : 'ts'}`),
    path.join(directory, 'index.m3u8'),
  );
  // Text subtitles are written as WebVTT by the same process, so they cost no extra reads
  // of a file that is still downloading. Each output shifts its own timestamps after an
  // input seek, so the cues cannot simply share the playlist's timeline. Instead they are
  // written in absolute source time (the seek is added back) and the server subtracts the
  // playlist's start when serving them (`vttRelative`).
  for (const index of subtitles)
    args.push(
      '-map',
      `0:${index}`,
      '-c:s',
      'webvtt',
      ...(seek > 0 ? ['-output_ts_offset', String(seek)] : []),
      '-flush_packets',
      '1',
      '-f',
      'webvtt',
      path.join(directory, `subtitle-${index}.vtt`),
    );
  return args;
}

// Moves WebVTT cues written in absolute source time onto a playlist whose position 0 is
// `offset` seconds into the source. Cues that end before the playlist starts are dropped;
// one that is showing at the start is clipped to 0.
const vttTime = /(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/;
const seconds = (match) =>
  Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
const stamp = (value) => {
  const ms = Math.round(Math.max(0, value) * 1000);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
};
export function vttRelative(text, offset) {
  const blocks = String(text)
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/);
  const out = ['WEBVTT'];
  for (const block of blocks.slice(/^WEBVTT/.test(blocks[0] || '') ? 1 : 0)) {
    const lines = block.replace(/\n+$/, '').split('\n');
    const at = lines.findIndex((line) => line.includes('-->'));
    if (at < 0) continue;
    const [left, right = ''] = lines[at].split('-->');
    const start = vttTime.exec(left),
      end = vttTime.exec(right);
    if (!start || !end) continue;
    const from = seconds(start) - offset,
      to = seconds(end) - offset;
    if (to <= 0) continue;
    const settings = right.slice(right.indexOf(end[0]) + end[0].length);
    lines[at] = `${stamp(from)} --> ${stamp(to)}${settings}`;
    out.push(lines.join('\n'));
  }
  return out.join('\n\n') + '\n';
}

const localFiles = /^index\.m3u8$|^segment-\d{6}\.ts$/;
const streamFiles = /^index\.m3u8$|^segment-\d{6}\.(?:ts|m4s)$|^init\.mp4$|^subtitle-\d+\.vtt$/;
export function createMedia(store, config) {
  const sessions = new Map();
  let starting = 0;
  // Local playback and live TV always transcode and share two slots. Stream conversions
  // that copy the video cost little CPU and have their own, larger budget.
  const heavy = () => [...sessions.values()].filter((s) => s.heavy).length;
  const light = () => sessions.size - heavy();
  async function dispose(key) {
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    session.process?.kill();
    session.onDispose?.();
    await rm(session.directory, { recursive: true, force: true }).catch(() => {});
    session.release();
  }
  function launch({
    userId,
    itemId,
    directory,
    args,
    release,
    isHeavy = true,
    authorize,
    files,
    progress,
    extra,
  }) {
    const key = id();
    // FFmpeg writes the fragmented-MP4 header (init.mp4) relative to its working
    // directory, not beside the playlist that refers to it. Running it inside the
    // session's own folder puts that file where the playlist expects it; elsewhere the
    // player could never start a copied HEVC stream. A relative FFmpeg path is resolved
    // first so the change of folder cannot break it.
    const ffmpeg = /[\\/]/.test(config.ffmpeg) ? path.resolve(config.ffmpeg) : config.ffmpeg;
    const child = spawn(ffmpeg, args, {
      cwd: directory,
      windowsHide: true,
      stdio: ['ignore', progress ? 'pipe' : 'ignore', 'pipe'],
    });
    const session = {
      userId,
      itemId,
      process: child,
      directory,
      touched: Date.now(),
      failed: false,
      release,
      heavy: isHeavy,
      authorize,
      files,
      ...extra,
    };
    sessions.set(key, session);
    child.stderr.on('data', (chunk) => {
      session.error = String(chunk).slice(-500);
    });
    child.on('error', () => {
      session.failed = true;
    });
    child.on('exit', (code) => {
      if (code !== 0 && sessions.get(key) === session) session.failed = true;
      session.exited = true;
      session.onExit?.(code);
    });
    if (progress) {
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer = (buffer + chunk).slice(-2048);
        const latest = [...buffer.matchAll(/out_time_us=(\d+)/g)].at(-1);
        if (latest) progress(Number(latest[1]) / 1e6);
      });
    }
    return { key, session };
  }
  const timer = setInterval(() => {
    for (const [key, s] of sessions) if (Date.now() - s.touched > 120000) void dispose(key);
  }, 30000);
  timer.unref();
  return {
    active: () => heavy() + starting,
    externalSessions: () => 0,
    async info(user, itemId) {
      const asset = store.available(user, itemId);
      if (!asset) fail(404, 'Local file is unavailable');
      const info = asset.probe || (await probe(asset.path, config));
      if (!asset.probe) store.addAsset({ ...asset, probe: info });
      return {
        itemId,
        ...info,
        direct: ['.mp4', '.webm', '.m4v'].includes(path.extname(asset.path).toLowerCase()),
      };
    },
    async start(user, itemId, { audio, seek = 0 } = {}) {
      const asset = store.available(user, itemId);
      if (!asset) fail(404, 'Local file is unavailable');
      const release = store.retainItem(itemId);
      let reserved = false;
      try {
        if (heavy() + starting + this.externalSessions() >= 2)
          fail(503, 'Both conversion slots are busy. Try direct play or wait.');
        starting++;
        reserved = true;
        const info = asset.probe || (await probe(asset.path, config));
        if (!Number.isFinite(seek) || seek < 0 || seek > info.duration)
          fail(400, 'Invalid seek position');
        if (audio != null && !info.audio.some((t) => t.index === audio))
          fail(400, 'Audio track not found');
        const directory = path.join(config.runtime, id());
        await mkdir(directory, { recursive: true });
        const args = [
          '-hide_banner',
          '-loglevel',
          'error',
          '-ss',
          String(seek),
          '-i',
          asset.path,
          '-map',
          '0:v:0',
          '-map',
          audio != null ? `0:${audio}` : '0:a:0?',
          '-sn',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '22',
          '-vf',
          'scale=w=min(1920\\,iw):h=-2',
          '-pix_fmt',
          'yuv420p',
          '-af',
          STEREO_DOWNMIX,
          '-c:a',
          'aac',
          '-ac',
          '2',
          '-b:a',
          '256k',
          '-force_key_frames',
          'expr:gte(t,n_forced*4)',
          '-f',
          'hls',
          '-hls_time',
          '4',
          '-hls_playlist_type',
          'event',
          '-hls_segment_filename',
          path.join(directory, 'segment-%06d.ts'),
          path.join(directory, 'index.m3u8'),
        ];
        const { key, session } = launch({
          userId: user.id,
          itemId,
          directory,
          args,
          release,
          authorize: (viewer) => !!store.available(viewer, itemId),
          files: localFiles,
        });
        starting--;
        reserved = false;
        for (let n = 0; n < 150; n++) {
          if (session.failed) {
            await dispose(key);
            fail(503, 'Video conversion failed. Check FFmpeg on the server.');
          }
          if (existsSync(path.join(directory, 'index.m3u8')))
            return { id: key, url: `/api/media/sessions/${key}/index.m3u8`, offset: seek };
          await pause(100);
        }
        await dispose(key);
        fail(503, 'Video conversion took too long to start');
      } catch (error) {
        release();
        throw error;
      } finally {
        if (reserved) starting--;
      }
    },
    // Starts a conversion of a torrent stream and returns at once; `ready` settles when
    // the first segment exists. The caller owns authorization and lifetime.
    async startStream(
      user,
      { itemId, input, directory: root, convert, authorize, onTouch, onProgress, onDispose, cast },
    ) {
      const transcode = !convert.copy;
      if (transcode && heavy() + starting + this.externalSessions() >= 2)
        fail(
          503,
          'Both video conversion slots are busy. Stop another video or choose a resolution this device can play without conversion.',
        );
      if (!transcode && light() >= 8) fail(503, 'Too many videos are playing at once.');
      const directory = path.join(root, id());
      await mkdir(directory, { recursive: true });
      const { key, session } = launch({
        userId: user.id,
        itemId,
        directory,
        args: streamArgs({ ...convert, input, directory }),
        release: () => {},
        isHeavy: transcode,
        authorize,
        files: streamFiles,
        progress: onProgress,
        extra: {
          onTouch,
          onDispose,
          cast,
          segmentFormat: convert.copy && convert.codec === 'hevc' ? 'fmp4' : 'ts',
        },
      });
      const ready = (async () => {
        const playlist = path.join(directory, 'index.m3u8');
        for (;;) {
          if (!sessions.has(key)) fail(410, 'Playback was stopped');
          if (session.failed) {
            await dispose(key);
            fail(503, 'Video conversion failed. Check FFmpeg on the server.');
          }
          if (existsSync(playlist))
            return { id: key, url: `/api/media/sessions/${key}/index.m3u8` };
          await pause(50);
        }
      })();
      ready.catch(() => {});
      return { key, ready, stop: () => dispose(key), session };
    },
    file(user, itemId) {
      const asset = store.available(user, itemId);
      if (!asset) fail(404, 'Local file is unavailable');
      return asset.path;
    },
    segment(user, key, name) {
      const session = sessions.get(key);
      if (
        !session ||
        session.userId !== user.id ||
        !session.authorize(user) ||
        !session.files.test(name)
      )
        fail(404, 'Playback resource not found');
      session.touched = Date.now();
      session.onTouch?.();
      return path.join(session.directory, name);
    },
    // Receiver URLs for Chromecast cannot carry the login cookie. Like live TV casting,
    // a random token scoped to one conversion grants read-only access to its files.
    async cast(user, key) {
      const session = sessions.get(key);
      if (!session || session.userId !== user.id || !session.authorize(user) || !session.cast)
        fail(404, 'Playback session not found');
      const deadline = Date.now() + 15000;
      let manifest = '';
      do {
        manifest = await readFile(path.join(session.directory, 'index.m3u8'), 'utf8').catch(
          () => '',
        );
        if ((manifest.match(/#EXTINF/g) || []).length >= 3 || /#EXT-X-ENDLIST/.test(manifest))
          break;
        if (session.failed || !sessions.has(key)) fail(503, 'Video conversion stopped');
        await pause(150);
      } while (Date.now() < deadline);
      session.castToken = randomBytes(32).toString('hex');
      session.touched = Date.now();
      return { url: `/cast/media/${key}/master.m3u8?token=${session.castToken}` };
    },
    async castFile(key, name, token) {
      const session = sessions.get(key);
      if (
        !session?.castToken ||
        token !== session.castToken ||
        !session.authorize({ id: session.userId, active: 1 })
      )
        fail(404, 'Cast ended. Cast the video again.');
      session.touched = Date.now();
      session.onTouch?.();
      if (name === 'master.m3u8')
        return {
          type: 'application/vnd.apple.mpegurl',
          body:
            `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n` +
            `#EXT-X-STREAM-INF:BANDWIDTH=${session.cast.bandwidth},CODECS="${session.cast.codecs}",RESOLUTION=${session.cast.resolution}\n` +
            `index.m3u8?token=${token}\n`,
        };
      if (!session.files.test(name) || name.startsWith('subtitle-'))
        fail(404, 'Playback resource not found');
      const file = path.join(session.directory, name);
      if (name !== 'index.m3u8') return { file };
      const text = await readFile(file, 'utf8');
      return {
        type: 'application/vnd.apple.mpegurl',
        body: text
          .replace(/^(segment-\d{6}\.(?:ts|m4s)|init\.mp4)$/gm, `$1?token=${token}`)
          .replace(/URI="init\.mp4"/, `URI="init.mp4?token=${token}"`),
      };
    },
    async subtitles(user, itemId, index, offset = 0) {
      const asset = store.available(user, itemId);
      if (!asset) fail(404, 'Local file is unavailable');
      const info = asset.probe || (await probe(asset.path, config));
      if (!Number.isFinite(offset) || offset < 0 || offset > info.duration)
        fail(400, 'Invalid subtitle offset');
      const track = info.subtitles.find((t) => t.index === index);
      if (!track || !textSubtitleCodecs.includes(track.codec))
        fail(400, 'This subtitle format is not supported by the browser');
      const { stdout } = await execute(
        config.ffmpeg,
        [
          '-v',
          'error',
          '-ss',
          String(offset),
          '-i',
          asset.path,
          '-map',
          `0:${index}`,
          '-f',
          'webvtt',
          'pipe:1',
        ],
        { timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      );
      return stdout;
    },
    async stop(user, key) {
      const session = sessions.get(key);
      if (session && session.userId === user.id) await dispose(key);
    },
    async close() {
      clearInterval(timer);
      await Promise.all([...sessions.keys()].map(dispose));
    },
  };
}
