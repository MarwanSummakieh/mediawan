import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { openLiveStream } from './fetch.mjs';
import { fail, id } from '../store.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export function rewriteManifest(text, base, resolve) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith('#'))
        return line.replace(
          /URI="([^"]+)"/g,
          (_m, uri) => `URI="${resolve(new URL(uri, base).href)}"`,
        );
      return line.trim() ? resolve(new URL(line.trim(), base).href) : line;
    })
    .join('\n');
}
export function isHlsManifest(prefix, contentType, url) {
  const signature = prefix
    .subarray(0, 64)
    .toString()
    .replace(/^\uFEFF/, '')
    .trimStart();
  return (
    /mpegurl/i.test(contentType) || /\.m3u8(?:\?|$)/i.test(url) || signature.startsWith('#EXTM3U')
  );
}
export function liveArgs(input) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-rw_timeout',
    '20000000',
    '-protocol_whitelist',
    'http,https,tcp,tls,crypto',
    '-fflags',
    '+genpts+discardcorrupt',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-sn',
    '-dn',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'zerolatency',
    '-vf',
    "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
    '-crf',
    '22',
    '-profile:v',
    'high',
    '-level:v',
    '4.1',
    '-r',
    '30',
    '-maxrate',
    '6M',
    '-bufsize',
    '12M',
    '-force_key_frames',
    'expr:gte(t,n_forced*2)',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ac',
    '2',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_list_size',
    '8',
    '-hls_delete_threshold',
    '2',
    '-hls_flags',
    'delete_segments+independent_segments+program_date_time+temp_file',
    '-hls_segment_filename',
    'segment-%09d.ts',
    'index.m3u8',
  ];
}
export function createLivePlayback(
  config,
  live,
  { openStream = openLiveStream, activeConversions = () => 0, userActive = () => true } = {},
) {
  const sessions = new Map();
  let operations = Promise.resolve(),
    starting = 0,
    closed = false;
  const serial = (fn) => {
    const p = operations.then(fn);
    operations = p.catch(() => {});
    return p;
  };
  async function stop(session) {
    if (!session || session.stopping) return;
    session.stopping = true;
    for (const abort of session.upstream) abort.abort();
    if (session.process && session.process.exitCode === null) {
      const exit = new Promise((r) => session.process.once('close', r));
      session.process.kill();
      await Promise.race([exit, pause(2000)]);
      if (session.process.exitCode === null) {
        session.process.kill('SIGKILL');
        await Promise.race([exit, pause(1000)]);
      }
    }
    sessions.delete(session.id);
    await fs.rm(session.directory, { recursive: true, force: true }).catch(() => {});
  }
  function resource(session, url) {
    // HLS demuxers validate segment extensions even when the media is proxied.
    // Retain only the media suffix; the provider path and credentials stay private.
    const extension =
      /\.(m3u8|ts|mpegts|aac|ac3|eac3|mp3|mp4|m4a|m4s|m4v|mov|cmfv|cmfa|fmp4|vtt|webvtt)$/i
        .exec(new URL(url).pathname)?.[0]
        .toLowerCase() || '';
    const key = createHash('sha256').update(url).digest('hex').slice(0, 32) + extension;
    session.resources.delete(key);
    session.resources.set(key, url);
    if (!session.rootResource) session.rootResource = key;
    // Keep the root source plus recent manifests, keys and segments.
    if (session.resources.size > 1500)
      for (const k of [...session.resources.keys()]
        .filter((k) => k !== session.rootResource)
        .slice(0, 500))
        session.resources.delete(k);
    return `http://127.0.0.1:${session.port}/internal/live/${session.id}/${key}?key=${session.secret}`;
  }
  function viewer(user, key, lease) {
    const session = sessions.get(key),
      v = session?.viewers.get(lease);
    if (!session || !v || v.userId !== user.id || session.failed || v.expires <= Date.now())
      fail(404, 'Live session ended. Open the channel again.');
    v.touched = Date.now();
    return session;
  }
  const timer = setInterval(() => {
    void serial(async () => {
      for (const s of sessions.values()) {
        for (const [key, v] of s.viewers)
          if (Date.now() - v.touched > 45000 || v.expires <= Date.now()) s.viewers.delete(key);
        if (s.ready) {
          try {
            if (Date.now() - (await fs.stat(path.join(s.directory, 'index.m3u8'))).mtimeMs > 45000)
              s.failed = true;
          } catch {
            s.failed = true;
          }
        }
        if (!s.viewers.size || s.failed) await stop(s);
      }
    }).catch(() => {});
  }, 10000);
  timer.unref();
  return {
    active: () => sessions.size + starting,
    start(user, channelId, port) {
      return serial(async () => {
        if (closed) fail(503, 'Server is stopping');
        await live.load();
        const channel = live.channel(channelId);
        if (!channel) fail(404, 'Channel not found');
        for (const s of [...sessions.values()]) if (s.failed || !s.viewers.size) await stop(s);
        let session = [...sessions.values()].find((s) => s.channelId === channelId);
        if (!session) {
          if (sessions.size >= live.status().maxConnections)
            fail(409, 'Another channel is playing. Stop it before opening a different channel.');
          if (sessions.size + activeConversions() >= 2)
            fail(409, 'The server is busy playing other videos. Try again when one has stopped.');
          const directory = path.join(config.runtime, 'live', id());
          starting++;
          try {
            await fs.mkdir(directory, { recursive: true });
          } catch (error) {
            starting--;
            throw error;
          }
          session = {
            id: id(),
            secret: id(),
            channelId,
            port,
            directory,
            viewers: new Map(),
            resources: new Map(),
            upstream: new Set(),
            failed: false,
          };
          sessions.set(session.id, session);
          starting--;
          try {
            const input = resource(session, channel.url);
            session.process = spawn(config.ffmpeg, liveArgs(input), {
              cwd: directory,
              stdio: ['ignore', 'ignore', 'pipe'],
              windowsHide: true,
            });
            session.process.stderr.on('data', () => {}); // Never log credential-bearing provider errors.
            session.process.on('error', () => {
              session.failed = true;
            });
            session.process.on('close', () => {
              session.failed = true;
            });
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline && !session.failed && !closed) {
              try {
                if (
                  /#EXTINF:/.test(await fs.readFile(path.join(directory, 'index.m3u8'), 'utf8'))
                ) {
                  session.ready = true;
                  break;
                }
              } catch {}
              await pause(150);
            }
            if (!session.ready)
              fail(
                503,
                'This channel could not start. Try another channel or check the provider and FFmpeg.',
              );
          } catch (e) {
            await stop(session);
            throw e;
          }
        }
        const lease = id();
        session.viewers.set(lease, { userId: user.id, touched: Date.now() });
        return {
          id: session.id,
          lease,
          url: `/api/live/sessions/${session.id}/index.m3u8?lease=${lease}`,
          channel: { id: channel.id, name: channel.name },
        };
      });
    },
    heartbeat(user, key, lease) {
      viewer(user, key, lease);
      return { ok: true };
    },
    cast(user, key, lease) {
      const s = viewer(user, key, lease);
      // One receiver grant per browser viewer; rotating it revokes an older URL.
      for (const [token, v] of s.viewers) if (v.ownerLease === lease) s.viewers.delete(token);
      const token = randomBytes(32).toString('hex');
      s.viewers.set(token, {
        userId: user.id,
        ownerLease: lease,
        touched: Date.now(),
        expires: Date.now() + 6 * 60 * 60 * 1000,
      });
      return { lease: token, url: `/cast/live/${s.id}/index.m3u8?token=${token}` };
    },
    release(user, key, lease) {
      return serial(async () => {
        const s = sessions.get(key);
        if (s?.viewers.get(lease)?.userId !== user.id) return;
        s.viewers.delete(lease);
        if (!s.viewers.size) await stop(s);
      });
    },
    async media(req, res, casting = false) {
      let s;
      const grant = casting ? req.query.token : req.query.lease;
      if (casting) {
        s = sessions.get(req.params.id);
        const v = s?.viewers.get(grant);
        if (!v?.ownerLease || v.expires <= Date.now() || !userActive(v.userId))
          fail(404, 'Live cast ended. Cast the channel again.');
        s = viewer({ id: v.userId }, req.params.id, grant);
        const sender = s.viewers.get(v.ownerLease);
        if (sender) sender.touched = Date.now();
      } else s = viewer(req.user, req.params.id, grant);
      const file = req.params.file;
      if (!/^(index\.m3u8|segment-\d{9}\.ts)$/.test(file)) fail(404, 'Playback resource not found');
      if (file === 'index.m3u8') {
        const text = await fs.readFile(path.join(s.directory, file), 'utf8');
        res
          .type('application/vnd.apple.mpegurl')
          .send(
            text.replace(/^(segment-\d{9}\.ts)$/gm, `$1?${casting ? 'token' : 'lease'}=${grant}`),
          );
      } else res.type('video/mp2t').sendFile(path.join(s.directory, file));
    },
    async source(req, res) {
      const s = sessions.get(req.params.id),
        url = s?.resources.get(req.params.asset);
      if (
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
        !url ||
        req.query.key !== s.secret
      )
        return res.status(404).end();
      // Keep an actively polled variant playlist in the bounded resource map.
      s.resources.delete(req.params.asset);
      s.resources.set(req.params.asset, url);
      const abort = new AbortController();
      s.upstream.add(abort);
      res.once('close', () => {
        abort.abort();
        s.upstream.delete(abort);
      });
      const timeout = setTimeout(() => abort.abort(), 30000);
      timeout.unref();
      try {
        const headers = req.headers.range ? { Range: req.headers.range } : {};
        const { response, url: finalUrl } = await openStream(url, {
          signal: abort.signal,
          headers,
        });
        const contentType = response.headers['content-type'] || '';
        const iterator = response[Symbol.asyncIterator](),
          prefix = [];
        let prefixBytes = 0,
          next;
        // Some providers serve HLS from .php endpoints with a plain-text MIME type.
        // Sniff the signature so their nested URLs still pass through validation.
        while (prefixBytes < 16 && !(next = await iterator.next()).done) {
          prefix.push(next.value);
          prefixBytes += next.value.length;
        }
        if (prefixBytes > 2 * 1024 * 1024) throw Error('Resource prefix too large');
        if (isHlsManifest(Buffer.concat(prefix), contentType, finalUrl)) {
          const chunks = [...prefix];
          let size = prefixBytes;
          for await (const chunk of iterator) {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) throw Error('Manifest too large');
            chunks.push(chunk);
          }
          const text = rewriteManifest(Buffer.concat(chunks).toString(), finalUrl, (u) =>
            resource(s, u),
          );
          res.type('application/vnd.apple.mpegurl').send(text);
        } else {
          clearTimeout(timeout);
          res.status(response.statusCode);
          for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges'])
            if (response.headers[h]) res.setHeader(h, response.headers[h]);
          const source = Readable.from(
            (async function* () {
              yield* prefix;
              yield* iterator;
            })(),
          );
          source.on('error', () => res.destroy());
          source.pipe(res);
        }
      } catch {
        if (!res.headersSent) res.status(502).end();
        else res.destroy();
      } finally {
        clearTimeout(timeout);
      }
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await serial(async () => {
        for (const s of [...sessions.values()]) await stop(s);
      });
    },
  };
}
