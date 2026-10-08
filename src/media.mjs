import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { id, fail } from './store.mjs';
const execute = promisify(execFile);
export async function probe(file, config) {
  const { stdout } = await execute(
    config.ffprobe,
    ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', file],
    { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  );
  const data = JSON.parse(stdout),
    video = data.streams.find((s) => s.codec_type === 'video');
  if (!video || !(Number(data.format.duration) > 0))
    fail(400, 'File does not contain playable video');
  return {
    duration: Number(data.format.duration),
    video: video.codec_name,
    width: video.width,
    height: video.height,
    audio: data.streams
      .filter((s) => s.codec_type === 'audio')
      .map((s) => ({
        index: s.index,
        codec: s.codec_name,
        language: s.tags?.language || 'und',
        title: s.tags?.title || '',
        channels: s.channels,
      })),
    subtitles: data.streams
      .filter((s) => s.codec_type === 'subtitle')
      .map((s) => ({
        index: s.index,
        codec: s.codec_name,
        language: s.tags?.language || 'und',
        title: s.tags?.title || '',
      })),
    chapters: (data.chapters || []).map((c) => ({
      start: Number(c.start_time),
      name: c.tags?.title || 'Chapter',
    })),
  };
}
export function createMedia(store, config) {
  const sessions = new Map();
  async function dispose(key) {
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    session.process?.kill();
    await rm(session.directory, { recursive: true, force: true }).catch(() => {});
    session.release();
  }
  const timer = setInterval(() => {
    for (const [key, s] of sessions) if (Date.now() - s.touched > 120000) void dispose(key);
  }, 30000);
  timer.unref();
  return {
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
      try {
        if (sessions.size >= 2)
          fail(503, 'Both conversion slots are busy. Try direct play or wait.');
        const info = asset.probe || (await probe(asset.path, config));
        if (!Number.isFinite(seek) || seek < 0 || seek > info.duration)
          fail(400, 'Invalid seek position');
        if (audio != null && !info.audio.some((t) => t.index === audio))
          fail(400, 'Audio track not found');
        const key = id(),
          directory = path.join(config.runtime, key);
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
          '-c:a',
          'aac',
          '-ac',
          '2',
          '-b:a',
          '192k',
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
        const child = spawn(config.ffmpeg, args, {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        const session = {
          userId: user.id,
          itemId,
          process: child,
          directory,
          touched: Date.now(),
          failed: false,
          release,
        };
        sessions.set(key, session);
        child.stderr.on('data', () => {});
        child.on('error', () => {
          session.failed = true;
        });
        child.on('exit', (code) => {
          if (code !== 0) session.failed = true;
        });
        for (let n = 0; n < 150; n++) {
          if (session.failed) {
            await dispose(key);
            fail(503, 'Video conversion failed. Check FFmpeg on the server.');
          }
          if (existsSync(path.join(directory, 'index.m3u8')))
            return { id: key, url: `/api/media/sessions/${key}/index.m3u8`, offset: seek };
          await new Promise((r) => setTimeout(r, 100));
        }
        await dispose(key);
        fail(503, 'Video conversion took too long to start');
      } catch (error) {
        release();
        throw error;
      }
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
        !store.available(user, session.itemId) ||
        !/^index\.m3u8$|^segment-\d{6}\.ts$/.test(name)
      )
        fail(404, 'Playback resource not found');
      session.touched = Date.now();
      return path.join(session.directory, name);
    },
    async subtitles(user, itemId, index, offset = 0) {
      const asset = store.available(user, itemId);
      if (!asset) fail(404, 'Local file is unavailable');
      const info = asset.probe || (await probe(asset.path, config));
      if (!Number.isFinite(offset) || offset < 0 || offset > info.duration)
        fail(400, 'Invalid subtitle offset');
      const track = info.subtitles.find((t) => t.index === index);
      if (!track || !['subrip', 'ass', 'ssa', 'webvtt', 'mov_text'].includes(track.codec))
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
