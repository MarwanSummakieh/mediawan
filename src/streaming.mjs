// Stream now: play an episode or movie while its torrent downloads.
//
// One in-process WebTorrent client serves every stream session. A session belongs to a
// user and an item at one resolution. It chooses a release, finds peers (falling back to
// the next-ranked release when the first is slow), serves the video file to FFmpeg over a
// loopback-only HTTP server, and hands playback to the shared HLS path in media.mjs.
// Everything the interface asks for is answered from memory; the slow steps run in the
// background and are pushed to the client as status events. See docs/streaming.md.
import http from 'node:http';
import path from 'node:path';
import { networkInterfaces as osInterfaces } from 'node:os';
import { mkdir, rm, statfs as fsStatfs, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { id, fail, finite } from './store.mjs';
import {
  probe as ffprobe,
  keyframeBefore as ffKeyframe,
  textSubtitleCodecs,
  vttRelative,
} from './media.mjs';
import {
  assessStream,
  rankReleases,
  lockFrom,
  trustedGroup,
  STREAM_RESOLUTIONS,
} from './release-score.mjs';

// Trackerless discovery (DHT) does not bootstrap on every network, and many listings carry
// no tracker list, so every stream also announces to these open trackers.
export const openTrackers = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'http://tracker.opentrackr.org:1337/announce',
];
export const RESOLUTIONS = [1080, 2160];
// Offered in place of 1080p when a title has nothing at 1080p (older series mostly).
export const LOWER_RESOLUTIONS = [720, 480];
const VIDEO = /\.(?:mkv|mp4|m4v|webm|avi|ts|m2ts)$/i;
const MiB = 1048576;
const GB = (bytes) => `${(bytes / 1073741824).toFixed(1)} GB`;
const refuse = (status, reason, message) => {
  throw Object.assign(new Error(message), { status, reason });
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Timings, tuned for snappiness. A healthy swarm answers with metadata in 1-4 seconds.
export const defaultTimings = Object.freeze({
  optionsFreshMs: 5 * 60000, // release listings are re-fetched after this...
  optionsStaleMs: 60 * 60000, // ...but a stale listing is still answered at once meanwhile.
  connectTimeoutMs: 45000, // give up on every candidate after this
  preparedIdleMs: 60000, // a prepared session nobody touches costs nothing after this
  playingIdleMs: 120000, // same timeout as conversion sessions in media.mjs
  failedLingerMs: 30000,
  replacedGraceMs: 20000, // the old resolution keeps playing while the client swaps
  engineIdleMs: 60000, // the WebTorrent client closes its ports when nothing streams
  tickMs: 1000,
  guardMs: 500, // VPN re-check while torrents run (os.networkInterfaces is cheap)
  diskMs: 5000,
});

// The VPN guard. Interface names are configurable because a NAS running behind a VPN
// container sees tun0/wg0 rather than the desktop client's adapter name.
export function createVpnGuard(config, interfaces = osInterfaces) {
  const patterns = config.streamVpnInterfaces.map(
    (pattern) =>
      new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i'),
  );
  return () => {
    const checkedAt = Date.now();
    if (config.streamVpn === 'off')
      return {
        required: false,
        ok: true,
        interface: null,
        patterns: config.streamVpnInterfaces,
        checkedAt,
        message:
          'The VPN check is turned off (STREAM_VPN=off). Peers can see this server’s address.',
      };
    let list = {};
    try {
      list = interfaces();
    } catch {}
    const name = Object.keys(list).find(
      (key) =>
        patterns.some((p) => p.test(key)) && (list[key] || []).some((entry) => !entry.internal),
    );
    return {
      required: true,
      ok: !!name,
      interface: name || null,
      patterns: config.streamVpnInterfaces,
      checkedAt,
      message: name
        ? `Streaming through the VPN (${name}).`
        : 'Connect the VPN to stream. Without it, every peer can see this server’s address.',
    };
  };
}

// What the client can decode. Unknown or missing values fall back to what every device the
// app supports can play: H.264 up to 1080p with stereo AAC.
export function capabilitiesFrom(input) {
  if (input != null && (typeof input !== 'object' || Array.isArray(input)))
    fail(400, 'Invalid playback capabilities');
  const value = input || {};
  const video = Array.isArray(value.video)
    ? value.video.filter((v) => ['h264', 'hevc', 'hevc10'].includes(v))
    : [];
  return {
    video: video.length ? [...new Set(video)] : ['h264'],
    maxHeight: [720, 1080, 1440, 2160].includes(value.maxHeight) ? value.maxHeight : 1080,
    audioChannels: value.audioChannels === 6 ? 6 : 2,
    dolbyVision: value.dolbyVision === true,
    forceTranscode: value.forceTranscode === true,
  };
}

// Copy the video when the client can decode it; otherwise transcode to H.264 at most
// 1080p, which a software encoder sustains in real time.
export function conversionPlan(info, capabilities, { tonemap = true } = {}) {
  const tenBit = /1[02]le|p010|1[02]be/.test(info.pixelFormat || '');
  const reasons = [];
  if (info.video === 'h264') {
    if (!capabilities.video.includes('h264')) reasons.push('This device does not play H.264');
    if (tenBit) reasons.push('10-bit H.264 is not supported by browsers');
  } else if (info.video === 'hevc') {
    if (
      tenBit
        ? !capabilities.video.includes('hevc10')
        : !capabilities.video.some((v) => v.startsWith('hevc'))
    )
      reasons.push(`This device does not play ${tenBit ? '10-bit ' : ''}HEVC`);
  } else reasons.push(`${String(info.video).toUpperCase()} video needs conversion`);
  // "Compatibility playback": the client saw the copied video fail and asks for H.264.
  if (capabilities.forceTranscode) reasons.push('Compatibility playback requested');
  if (info.height > capabilities.maxHeight)
    reasons.push(`This device plays up to ${capabilities.maxHeight}p`);
  if (info.dolbyVision?.profile === 5 && !capabilities.dolbyVision)
    reasons.push('Dolby Vision profile 5 shows wrong colours without Dolby Vision support');
  const copy = !reasons.length;
  const maxHeight = copy ? info.height : Math.min(capabilities.maxHeight, 1080);
  const height = copy ? info.height : Math.min(info.height, maxHeight);
  const width = copy ? info.width : Math.round((info.width * height) / info.height / 2) * 2;
  return {
    copy,
    codec: copy ? info.video : 'h264',
    maxHeight,
    tonemap: !copy && info.hdr && tonemap,
    audioChannels: capabilities.audioChannels,
    mode: copy ? 'copy' : 'transcode',
    reason: copy ? null : reasons.join('; '),
    segmentFormat: copy && info.video === 'hevc' ? 'fmp4' : 'ts',
    width,
    height,
    codecs:
      (copy && info.video === 'hevc'
        ? tenBit
          ? 'hvc1.2.4.L153.B0'
          : 'hvc1.1.6.L150.B0'
        : maxHeight > 1080
          ? 'avc1.640033'
          : 'avc1.640029') + ',mp4a.40.2',
  };
}

const languageAliases = {
  ar: 'ara',
  en: 'eng',
  fr: 'fre',
  fra: 'fre',
  de: 'ger',
  deu: 'ger',
  es: 'spa',
  it: 'ita',
  pt: 'por',
  ru: 'rus',
  ja: 'jpn',
  ko: 'kor',
  zh: 'chi',
  zho: 'chi',
  nl: 'dut',
  nld: 'dut',
  tr: 'tur',
  da: 'dan',
  sv: 'swe',
  no: 'nor',
  nob: 'nor',
  fi: 'fin',
  he: 'heb',
  fa: 'per',
  fas: 'per',
  pl: 'pol',
};
export const languageKey = (code) => {
  const value = String(code || '')
    .toLowerCase()
    .split(/[-_]/)[0];
  return languageAliases[value] || value;
};
const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
export const languageName = (code) => {
  try {
    return languageNames.of(code);
  } catch {
    return code;
  }
};
// "English or Arabic"
const languageList = (codes) =>
  codes
    .map(languageName)
    .reduce((text, name, i, all) =>
      i === all.length - 1 ? `${text} or ${name}` : `${text}, ${name}`,
    );

// Languages of the full text-subtitle tracks in a probed file. Forced tracks only cover
// foreign dialogue and image tracks (PGS, VobSub) cannot be shown, so neither counts.
export const subtitleLanguages = (info) => [
  ...new Set(
    (info?.subtitles || [])
      .filter((t) => textSubtitleCodecs.includes(t.codec) && !t.forced && t.language)
      .map((t) => languageKey(t.language))
      .filter((code) => code && code !== 'und'),
  ),
];
const hasSubtitles = (languages, wanted) => languages.some((code) => wanted.includes(code));
// One file of a release: a season pack holds many episodes under one hash.
const fileKey = (release) => `${release.hash}:${release.fileIndex ?? ''}`;
// At most this many releases are opened only to look for subtitles before settling for
// the best one without them; each costs a few seconds of start-up.
const SUBTITLE_CHECKS = 3;

const releaseSummary = (entry) =>
  entry && {
    hash: entry.release.hash,
    fileIndex: entry.release.fileIndex,
    name: String(entry.release.label || '').split('\n')[0],
    filename: entry.release.filename || null,
    sizeBytes: entry.release.sizeBytes,
    seeders: entry.release.seeders,
    resolution: entry.release.resolution,
    service: entry.traits.service,
    group: entry.traits.group,
    source: entry.traits.source,
    hdr: entry.traits.hdr,
    dolbyVision: entry.traits.dolbyVision,
    dolbyVisionOnly: entry.traits.dolbyVisionOnly,
    hevc: entry.traits.hevc,
    seasonPack: entry.traits.seasonPack,
    // Null when the streaming filter is off.
    trusted: entry.trusted ?? null,
    // Embedded subtitles in the viewer's language: true or false once the file has been
    // read, null before.
    subtitles: entry.subtitles ?? null,
    score: entry.score,
    why: entry.parts.map((p) => `${p.points > 0 ? '+' : ''}${p.points} ${p.reason}`),
  };

// Loopback-only HTTP server that serves torrent files with range support. FFmpeg reads
// from it; each request reprioritises pieces at the requested offset at once.
function createSourceServer() {
  const sources = new Map();
  let server = null,
    listening = null;
  function handle(req, res) {
    const token = /^\/([a-f0-9]{48})\//.exec(req.url || '')?.[1];
    const source = token && sources.get(token);
    if (!source || source.file._destroyed || !['GET', 'HEAD'].includes(req.method)) {
      res.statusCode = 404;
      return res.end();
    }
    const { file } = source,
      size = file.length;
    let start = 0,
      end = size - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      if (range[1] === '') start = Math.max(0, size - Number(range[2]));
      else {
        start = Number(range[1]);
        if (range[2]) end = Math.min(end, Number(range[2]));
      }
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return res.end();
      }
    }
    res.writeHead(range ? 206 : 200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': file.type || 'application/octet-stream',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    const reader = { start, position: start, waitingSince: null };
    source.readers.add(reader);
    source.onRead?.(start);
    let iterator,
      remaining = end - start + 1;
    try {
      iterator = file[Symbol.asyncIterator]({ start, end });
    } catch {
      source.readers.delete(reader);
      return res.destroy();
    }
    // Ending the request deselects its pieces immediately, so a seek moves priority.
    res.once('close', () => {
      source.readers.delete(reader);
      iterator.return?.().catch(() => {});
    });
    (async () => {
      try {
        for (;;) {
          reader.waitingSince = Date.now();
          const { value, done } = await iterator.next();
          reader.waitingSince = null;
          if (done || res.destroyed) break;
          const chunk = value.length > remaining ? value.subarray(0, remaining) : value;
          remaining -= chunk.length;
          reader.position += chunk.length;
          if (!res.write(chunk) && remaining > 0)
            await new Promise((resolve) => {
              const done = () => {
                res.off('drain', done);
                res.off('close', done);
                resolve();
              };
              res.on('drain', done);
              res.on('close', done);
            });
          if (remaining <= 0) break;
        }
        if (!res.destroyed) res.end();
      } catch {
        res.destroy();
      } finally {
        reader.waitingSince = null;
        source.readers.delete(reader);
      }
    })();
  }
  return {
    async add(file, onRead) {
      if (!server) {
        server = http.createServer(handle);
        server.keepAliveTimeout = 5000;
        listening = new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
      }
      await listening;
      const token = randomBytes(24).toString('hex');
      const source = { file, readers: new Set(), onRead };
      sources.set(token, source);
      const name = encodeURIComponent(path.basename(file.name)).replace(/%20/g, '_');
      return {
        token,
        source,
        url: `http://127.0.0.1:${server.address().port}/${token}/${name}`,
        remove: () => sources.delete(token),
      };
    },
    close() {
      sources.clear();
      if (server) server.close();
      if (server) server.closeAllConnections?.();
      server = null;
    },
  };
}

export function createStreaming(store, config, dependencies = {}) {
  const timings = { ...defaultTimings, ...dependencies.timings };
  const now = dependencies.now || Date.now;
  const releases = dependencies.releases; // (itemId) => Promise<detailed release list>
  const rulesFor = dependencies.rules; // () => torrent rules
  const probe = dependencies.probe || ((input, options) => ffprobe(input, config, options));
  const keyframeBefore =
    dependencies.keyframeBefore || ((input, seek) => ffKeyframe(input, seek, config));
  const statfs = dependencies.statfs || fsStatfs;
  const guard = dependencies.guard || createVpnGuard(config, dependencies.networkInterfaces);
  const createClient =
    dependencies.createClient ||
    (async (options) => new (await import('webtorrent')).default(options));
  const media = dependencies.media;
  const warmSubtitles = dependencies.warmSubtitles || (() => {});
  const onlineSubtitles = dependencies.onlineSubtitles || (async () => []);
  const root = path.join(config.runtime, 'streams');
  const torrentRoot = path.join(root, 'torrents'),
    hlsRoot = path.join(root, 'hls');
  const sessions = new Map(),
    entries = new Map(),
    listings = new Map(),
    rankings = new WeakMap(),
    acquiring = new Map();
  const sourceServer = dependencies.sourceServer || createSourceServer();
  let client = null,
    clientStarting = null,
    clientIdleSince = null,
    closed = false,
    lastGuard = null,
    lastGuardAt = 0,
    lastDiskAt = 0,
    zscale = null;
  // Cached data from an earlier run is never trusted: delete it before the first stream.
  const cleaned = rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});

  const allowed = (user) => !!user?.active && (user.role === 'admin' || !!user.can_download);
  const permit = (user) => {
    if (!allowed(user))
      refuse(403, 'permission', 'Your account cannot stream or download. Ask an administrator.');
  };
  // Every check, from a request or from the periodic tick, acts on a failure: if torrent
  // traffic exists and the VPN is gone, everything is shut down at once. Requests may reuse
  // a result up to 500 ms old; the tick always checks afresh, so nothing can postpone it.
  const checkGuard = () => {
    lastGuard = guard();
    lastGuardAt = now();
    if (!lastGuard.ok && lastGuard.required && (client || clientStarting || entries.size))
      void vpnLost(lastGuard).catch((error) =>
        console.error('Stream shutdown failed:', error.code || error.name),
      );
    return lastGuard;
  };
  const guardState = () => (!lastGuard || now() - lastGuardAt >= 500 ? checkGuard() : lastGuard);
  const requireVpn = () => {
    const state = guardState();
    if (!state.ok) refuse(403, 'vpn', state.message);
    return state;
  };

  // ---- Release choice ---------------------------------------------------------------
  function context(user, itemId) {
    const item = store.item(itemId);
    if (!item || !store.canReadItem(user, itemId)) fail(404, 'Media not found');
    const title = store.title(item.title_id);
    return { item, title, kind: title.kind };
  }
  function listing(itemId, refresh = false) {
    let cached = listings.get(itemId);
    const age = cached?.at ? now() - cached.at : Infinity;
    const load = () => {
      if (cached?.pending) return cached.pending;
      const entry = cached || {};
      entry.pending = Promise.resolve()
        .then(() => releases(itemId))
        .then((value) => {
          Object.assign(entry, { value, at: now(), pending: null });
          if (listings.size > 500) listings.delete(listings.keys().next().value);
          return value;
        })
        .catch((error) => {
          entry.pending = null;
          if (!entry.value) listings.delete(itemId);
          throw error;
        });
      listings.set(itemId, entry);
      cached = entry;
      return entry.pending;
    };
    if (cached?.value && !refresh && age < timings.optionsStaleMs) {
      // Answer from memory; refresh in the background when the listing is getting old.
      if (age >= timings.optionsFreshMs) load().catch(() => {});
      return { value: cached.value, cached: true, ageMs: age };
    }
    return load().then((value) => ({ value, cached: false, ageMs: 0 }));
  }
  const lockKey = (title, item) => (title.kind === 'movie' ? null : [title.id, item.season]);
  function readLock(title, item, resolution) {
    const key = lockKey(title, item);
    if (!key) return null;
    const row = store.one(
      'SELECT json FROM stream_locks WHERE title_id=? AND season=? AND resolution=?',
      ...key,
      resolution,
    );
    return row ? JSON.parse(row.json) : null;
  }
  function writeLock(title, item, resolution, ranked) {
    const key = lockKey(title, item);
    if (!key || !ranked) return;
    store.run(
      'INSERT INTO stream_locks VALUES(?,?,?,?,?) ON CONFLICT(title_id,season,resolution) DO UPDATE SET json=excluded.json,updated=excluded.updated',
      ...key,
      resolution,
      now(),
      JSON.stringify(lockFrom(ranked)),
    );
  }
  // A different film can share a title and a year, and listings mix the two. A movie file
  // whose length is far from the catalog's runtime is that other film: it is rejected for
  // this title for good, so it is never offered or tried again.
  const rejectKey = (titleId) => `streamRejected:${titleId}`;
  function rejected(titleId) {
    const row = store.one('SELECT json FROM settings WHERE key=?', rejectKey(titleId));
    return row ? JSON.parse(row.json) : {};
  }
  function reject(titleId, hash, reason) {
    store.run(
      'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json',
      rejectKey(titleId),
      JSON.stringify({ ...rejected(titleId), [hash]: reason }),
    );
  }
  // Subtitle languages found in each file read for this title, so a file known to lack
  // the viewer's subtitles is tried last next time, without opening it again.
  const subtitleKey = (titleId) => `streamSubtitles:${titleId}`;
  function knownSubtitles(titleId) {
    const row = store.one('SELECT json FROM settings WHERE key=?', subtitleKey(titleId));
    return row ? JSON.parse(row.json) : {};
  }
  function rememberSubtitles(titleId, release, languages) {
    const known = knownSubtitles(titleId);
    const key = fileKey(release);
    if (JSON.stringify(known[key]) === JSON.stringify(languages)) return;
    store.run(
      'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json',
      subtitleKey(titleId),
      JSON.stringify({ ...known, [key]: languages }),
    );
  }
  function wrongFilm(session, info) {
    if (session.kind !== 'movie') return null;
    const title = store.title(session.titleId);
    const expected = title.runtimeSeconds;
    if (!(expected >= 1200) || !(info.duration > 0)) return null;
    const ratio = info.duration / expected;
    if (ratio >= 0.85 && ratio <= 1.3) return null;
    return `It runs ${Math.round(info.duration / 60)} min; ${title.name} runs ${Math.round(expected / 60)} min.`;
  }
  // "2001-2010" in the catalog: the last year a series ran. Open-ended while it airs.
  const endYearOf = (title) =>
    Number(/\d{4}\D+(\d{4})/.exec(String(title.releaseInfo || ''))?.[1]) || null;
  // With the streaming filter on, releases are tried in four bands, each in score order:
  // trusted, trusted known to lack the subtitles, untrusted, untrusted known to lack them.
  // Nothing is removed, so a stream still starts (with a warning) when no release passes.
  function filtered(ranked, rules, title, wanted) {
    if (!rules.trustedOnly && !rules.requireSubtitles) return ranked;
    const known = knownSubtitles(title.id);
    const marked = ranked.map((entry) => {
      const languages = known[fileKey(entry.release)];
      const group = trustedGroup(entry.release, rules.trustedGroups);
      return {
        ...entry,
        trusted: rules.trustedOnly ? !!group : null,
        trustedGroup: group,
        subtitles: languages ? hasSubtitles(languages, wanted) : null,
      };
    });
    const band = (entry) =>
      (rules.trustedOnly && !entry.trusted ? 2 : 0) +
      (rules.requireSubtitles && entry.subtitles === false ? 1 : 0);
    return marked
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => band(a.entry) - band(b.entry) || a.index - b.index)
      .map(({ entry }) => entry);
  }
  function rank(list, { item, title, kind }, resolution, wanted = ['eng']) {
    const rules = rulesFor();
    const wrong = rejected(title.id);
    const assess = (relaxed) =>
      list.map((release) => ({
        release,
        ...(wrong[release.hash]
          ? { accepted: false, reasons: ['A different film with the same name'] }
          : assessStream(release, kind, rules, resolution, {
              year: title.year,
              endYear: endYearOf(title),
              relaxed,
            })),
      }));
    // A series keeps to WEB-DL while one exists; only when none does are Blu-ray releases
    // of that episode accepted.
    let assessed = assess(false);
    if (kind !== 'movie' && !assessed.some((a) => a.accepted)) {
      const relaxed = assess(true);
      if (relaxed.some((a) => a.accepted)) assessed = relaxed;
    }
    const eligible = assessed.filter((a) => a.accepted).map((a) => a.release);
    const lock = readLock(title, item, resolution);
    const ranked = filtered(
      rankReleases(eligible, kind, lock, {
        runtimeSeconds: item.runtimeSeconds || title.runtimeSeconds,
        streaming: true,
      }),
      rules,
      title,
      wanted,
    );
    if (ranked.length) return { ranked, lock };
    // Explain the best near miss, so the interface can say why a resolution is missing.
    const atResolution = assessed.filter((a) => a.release.resolution === resolution);
    const best = atResolution.sort(
      (a, b) => (b.release.seeders || 0) - (a.release.seeders || 0),
    )[0];
    const reason = !list.length
      ? 'No releases are listed for this title yet'
      : !best
        ? `No ${resolution}p release is listed`
        : `No ${resolution}p release passes the rules. Best: ${best.reasons[0]}`;
    return { ranked, lock, reason };
  }
  async function choices(user, itemId, { refresh = false } = {}) {
    const ctx = context(user, itemId);
    const result = await listing(itemId, refresh);
    const wanted = wantedSubtitles(user.id);
    // Ranking is cheap but not free; repeat requests reuse it until the listing, the
    // rules, a season lock or what is known about subtitles change.
    const key = JSON.stringify([
      rulesFor(),
      wanted,
      knownSubtitles(ctx.title.id),
      STREAM_RESOLUTIONS.map((r) => readLock(ctx.title, ctx.item, r)),
      ctx.item.runtimeSeconds || ctx.title.runtimeSeconds,
      ctx.title.year,
      ctx.title.releaseInfo,
      rejected(ctx.title.id),
    ]);
    const memo = rankings.get(result.value);
    if (memo?.key === key)
      return { ctx, resolutions: memo.resolutions, cached: result.cached, ageMs: result.ageMs };
    const resolutions = {};
    for (const resolution of STREAM_RESOLUTIONS) {
      const { ranked, lock, reason } = rank(result.value, ctx, resolution, wanted);
      resolutions[resolution] = { resolution, ranked, lock, reason };
    }
    rankings.set(result.value, { key, resolutions });
    return { ctx, resolutions, cached: result.cached, ageMs: result.ageMs };
  }
  // The quality shown beside 4K: 1080p, or the best lower one when nothing exists at 1080p.
  // 1080p stays when it has a sound release. When its best is a poor one (a dub, a tiny
  // re-encode, a dying swarm) a lower quality replaces it, but only one that scores
  // clearly better: resolution is not given up on thin evidence.
  const SOUND_SCORE = 20,
    CLEAR_MARGIN = 10;
  const standardResolution = (resolutions) => {
    const top = (r) => resolutions[r].ranked[0]?.score ?? -Infinity;
    if (top(1080) >= SOUND_SCORE) return 1080;
    const lower = LOWER_RESOLUTIONS.reduce((best, r) => (top(r) > top(best) ? r : best));
    return top(lower) >= top(1080) + CLEAR_MARGIN ? lower : 1080;
  };
  const preferredResolution = (kind, resolutions, requested) => {
    if (requested != null) {
      if (!STREAM_RESOLUTIONS.includes(requested)) fail(400, 'Choose 480, 720, 1080 or 2160');
      return requested;
    }
    const standard = standardResolution(resolutions);
    const order = kind === 'movie' ? [2160, standard] : [standard, 2160];
    return order.find((r) => resolutions[r].ranked.length) || order[0];
  };
  function nextItem(item, title) {
    const ordered = store
      .items(title.id)
      .filter((i) => title.kind === 'movie' || i.season > 0 || title.kind === 'anime');
    const index = ordered.findIndex((i) => i.id === item.id);
    return index >= 0 ? ordered[index + 1] || null : null;
  }

  // ---- WebTorrent client and torrents -----------------------------------------------
  async function engine() {
    requireVpn();
    if (client) return client;
    if (!clientStarting)
      clientStarting = createClient({
        dht: config.streamDht,
        // Local discovery and router port mapping would leak past the VPN.
        lsd: false,
        natUpnp: false,
        natPmp: false,
        maxConns: 80,
        uploadLimit: config.streamUploadKBps > 0 ? config.streamUploadKBps * 1024 : -1,
      })
        .then((created) => {
          created.on('error', (error) => console.error('Stream engine error:', error.message));
          client = created;
          clientIdleSince = null;
          return created;
        })
        .finally(() => {
          clientStarting = null;
        });
    return clientStarting;
  }
  async function stopEngine() {
    const current = client;
    client = null;
    clientIdleSince = null;
    if (current && !current.destroyed)
      await new Promise((resolve) => {
        try {
          current.destroy(() => resolve());
        } catch {
          resolve();
        }
      });
  }
  // One entry per info hash, shared by every session on it. Concurrent requests for the
  // same hash share one pending creation.
  function acquire(candidate) {
    const hash = candidate.release.hash;
    const entry = entries.get(hash);
    if (entry) return Promise.resolve(entry);
    if (!acquiring.has(hash))
      acquiring.set(
        hash,
        createEntry(candidate).finally(() => acquiring.delete(hash)),
      );
    return acquiring.get(hash);
  }
  async function createEntry(candidate) {
    const hash = candidate.release.hash;
    let entry;
    const torrentClient = await engine();
    await cleaned;
    // Each torrent instance gets its own folder, so deleting a stopped instance's data can
    // never touch a newer instance of the same torrent.
    const directory = path.join(torrentRoot, `${hash}-${id().slice(0, 8)}`);
    await mkdir(directory, { recursive: true });
    const announce = [
      ...new Set([
        ...(candidate.release.trackers || []),
        ...config.streamTrackers,
        ...openTrackers,
      ]),
    ];
    // The engine was shut down (VPN lost) while this was waiting.
    if (client !== torrentClient || closed) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      refuse(403, 'vpn', guardState().message);
    }
    let markReady, markFailed;
    entry = {
      hash,
      directory,
      users: new Set(),
      created: now(),
      peersAt: null,
      readyAt: null,
      ready: new Promise((resolve, reject) => {
        markReady = resolve;
        markFailed = reject;
      }),
    };
    entry.ready.catch(() => {});
    entries.set(hash, entry);
    const torrent = torrentClient.add(`magnet:?xt=urn:btih:${hash}`, {
      path: directory,
      announce,
      deselect: true,
      destroyStoreOnDestroy: true,
    });
    entry.torrent = torrent;
    torrent.on('wire', () => {
      entry.peersAt ||= now();
      for (const session of entry.users) changed(session);
    });
    torrent.once('ready', () => {
      entry.readyAt = now();
      markReady(torrent);
    });
    torrent.on('error', (error) => {
      markFailed(Object.assign(new Error(`Torrent error: ${error.message}`), { status: 502 }));
    });
    return entry;
  }
  async function releaseEntry(entry, session) {
    if (!entry) return;
    entry.users.delete(session);
    if (entry.users.size) return reselect(entry);
    if (entries.get(entry.hash) !== entry) return;
    entries.delete(entry.hash);
    const torrent = entry.torrent;
    if (torrent && !torrent.destroyed)
      await new Promise((resolve) => torrent.destroy({ destroyStore: true }, () => resolve()));
    await rm(entry.directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    if (!entries.size) clientIdleSince = now();
  }
  const pieceOf = (torrent, byte) => Math.floor(byte / torrent.pieceLength);
  // Rebuilds the piece selection of a torrent from the sessions using it. Priorities:
  // the head and tail of the file (MKV keeps its index at the end) first, then a window
  // at the playhead after a seek, then the rest of the file in order while playing.
  function reselect(entry) {
    const torrent = entry.torrent;
    if (!torrent?.ready || torrent.destroyed || !torrent.pieces.length) return;
    torrent.deselect(0, torrent.pieces.length - 1);
    for (const session of entry.users) {
      const file = session.file;
      if (!file || session.entry !== entry) continue;
      const first = pieceOf(torrent, file.offset),
        last = pieceOf(torrent, file.offset + file.length - 1);
      if (session.intent === 'play') torrent.select(first, last, 0);
      if (session.window) torrent.select(session.window[0], session.window[1], 2);
      const head = pieceOf(torrent, file.offset + Math.min(file.length, 8 * MiB) - 1);
      const tail = pieceOf(torrent, file.offset + Math.max(0, file.length - 2 * MiB));
      torrent.select(first, head, 3);
      torrent.select(tail, last, 3);
      torrent.critical(first, Math.min(head, first + 1));
    }
  }
  function byteAt(session, seconds) {
    const duration = session.info?.duration;
    if (!(duration > 0)) return 0;
    return Math.floor(Math.max(0, Math.min(1, seconds / duration)) * session.file.length);
  }
  function setWindow(session, seconds) {
    const torrent = session.entry?.torrent;
    if (!torrent?.ready || !session.file || !(seconds > 0)) {
      session.window = null;
      return;
    }
    const file = session.file,
      byte = byteAt(session, seconds);
    const from = file.offset + Math.max(0, byte - 8 * MiB),
      to = file.offset + Math.min(file.length - 1, byte + 32 * MiB);
    session.window = [pieceOf(torrent, from), pieceOf(torrent, to)];
    reselect(session.entry);
  }

  // ---- Disk use -----------------------------------------------------------------------
  // A stream needs room for the torrent data and, when the video is copied, an HLS copy
  // of the same size. Streams never delete library files to make room.
  const needFor = (length) => length * 2;
  function used(session) {
    return session.file ? Math.min(session.need, (session.file.downloaded || 0) * 2) : 0;
  }
  // Checks and commits under one lock, so concurrent starts cannot both pass the check and
  // together exceed the limits. A file shared by several sessions (devices, resolution
  // labels of one torrent) is counted once. Failed and closed sessions hold nothing.
  let spaceLock = Promise.resolve();
  function ensureSpace(session, length, key) {
    const task = spaceLock.then(() => reserveSpace(session, length, key));
    spaceLock = task.catch(() => {});
    return task;
  }
  async function reserveSpace(session, length, key) {
    const need = needFor(length);
    const others = () => {
      const byFile = new Map();
      for (const s of sessions.values())
        if (s !== session && s.need && !s.closed && !s.error && s.needKey !== key) {
          const current = byFile.get(s.needKey);
          if (!current || used(s) > used(current)) byFile.set(s.needKey, s);
        }
      return [...byFile.values()];
    };
    const evictable = () =>
      [...sessions.values()].filter(
        (s) =>
          s !== session &&
          !s.closed &&
          s.need &&
          s.intent === 'prepare' &&
          s.id !== session.parentId &&
          s.needKey !== key,
      );
    for (;;) {
      if (session.closed) refuse(410, 'stopped', 'Stream stopped');
      const committed = others().reduce((sum, s) => sum + s.need, 0);
      const pending = others().reduce((sum, s) => sum + Math.max(0, s.need - used(s)), 0);
      let free = Infinity;
      try {
        await mkdir(root, { recursive: true });
        const disk = await statfs(root);
        free = disk.bavail * disk.bsize;
      } catch {}
      const available = free - config.reserveBytes - pending;
      const fits = committed + need <= config.streamCacheBytes && available >= need;
      if (fits) {
        session.need = need;
        session.needKey = key;
        return;
      }
      const victim = evictable().sort((a, b) => a.touched - b.touched)[0];
      if (victim) {
        await close(victim, 'Stopped to make room for another stream');
        continue;
      }
      if (committed + need > config.streamCacheBytes)
        refuse(
          507,
          'disk',
          `Streams are limited to ${GB(config.streamCacheBytes)} of disk. Stop another stream first.`,
        );
      refuse(
        507,
        'disk',
        `Not enough free space to stream this file: it needs ${GB(need)} and ${GB(Math.max(0, available))} is free after the ${GB(config.reserveBytes)} reserve.`,
      );
    }
  }

  // ---- Sessions -----------------------------------------------------------------------
  function changed(session) {
    if (session.notifyQueued || !session.listeners.size) return;
    session.notifyQueued = true;
    queueMicrotask(() => {
      session.notifyQueued = false;
      const snapshot = JSON.stringify(status(session));
      if (snapshot === session.lastSent) return;
      session.lastSent = snapshot;
      for (const listener of session.listeners) listener(snapshot);
    });
  }
  function touch(session) {
    session.touched = now();
    for (const child of sessions.values())
      if (child.parentId === session.id && !child.closed) child.touched = session.touched;
  }
  function owned(user, sessionId) {
    const session = sessions.get(sessionId);
    if (!session || session.userId !== user?.id || session.closed)
      fail(404, 'Stream not found. It may have expired; press play again.');
    return session;
  }
  // Failed sessions only linger to report their error; they hold no slot (their torrents
  // are already released). Each device has its own session, so a user may have several.
  const perUserLimit = 4;
  async function makeRoom(user) {
    const live = () => [...sessions.values()].filter((s) => !s.closed && !s.error);
    const evict = (pool) =>
      pool.filter((s) => s.intent === 'prepare').sort((a, b) => a.touched - b.touched)[0];
    while (live().filter((s) => s.userId === user.id).length >= perUserLimit) {
      const victim = evict(live().filter((s) => s.userId === user.id));
      if (!victim)
        refuse(409, 'limit', `You are already streaming ${perUserLimit} videos. Stop one first.`);
      await close(victim, 'Stopped to make room for another stream');
    }
    while (live().length >= config.streamMaxSessions) {
      const victim = evict(live());
      if (!victim)
        refuse(
          409,
          'limit',
          `The server is already streaming ${live().length} videos. Stop one first.`,
        );
      await close(victim, 'Stopped to make room for another stream');
    }
  }
  async function create(user, ctx, resolution, ranked, intent) {
    await makeRoom(user);
    const session = {
      id: id(),
      userId: user.id,
      user,
      itemId: ctx.item.id,
      titleId: ctx.title.id,
      kind: ctx.kind,
      season: ctx.item.season,
      resolution,
      intent,
      ranked,
      candidates: ranked.slice(0, 4),
      // The streaming filter as it was when the session began, and the subtitle languages
      // that satisfy it for this viewer.
      filter: (({ trustedOnly, requireSubtitles }) => ({ trustedOnly, requireSubtitles }))(
        rulesFor(),
      ),
      wanted: wantedSubtitles(user.id),
      subtitles: null,
      attempts: [],
      created: now(),
      touched: now(),
      listeners: new Set(),
      timings: { created: now() },
      conversion: null,
      generation: 0,
      position: null,
      capabilities: capabilitiesFrom(),
      player: null,
    };
    sessions.set(session.id, session);
    warmSubtitles(user, ctx.item.id);
    session.run = run(session).catch((error) => {
      if (session.closed) return;
      session.error = {
        reason: error.reason || 'failed',
        message: error.status
          ? error.message
          : 'The video could not be read. Try the other resolution or try again.',
      };
      if (!error.status) console.error('Stream failed:', error.code || error.name);
      session.failedAt = now();
      void dropAttempts(session);
      changed(session);
    });
    return session;
  }
  async function dropAttempts(session, keep = null) {
    for (const attempt of session.attempts)
      if (attempt !== keep && attempt.entry && !attempt.dropped) {
        attempt.dropped = true;
        await releaseEntry(attempt.entry, session);
      }
  }
  function beginAttempt(session, candidate) {
    const attempt = { candidate, state: 'trying', started: now(), reason: null };
    session.attempts.push(attempt);
    attempt.ready = acquire(candidate).then(async (entry) => {
      if (session.closed || attempt.dropped) {
        await releaseEntry(entry, session);
        throw Object.assign(new Error('Stopped'), { stale: true });
      }
      attempt.entry = entry;
      entry.users.add(session);
      return entry.ready;
    });
    attempt.ready.catch(() => {});
    changed(session);
    return attempt;
  }
  async function abandon(session, attempt, state, reason) {
    attempt.state = state;
    attempt.reason ||= reason;
    if (attempt.entry && !attempt.dropped) {
      attempt.dropped = true;
      await releaseEntry(attempt.entry, session);
    } else attempt.dropped = true;
  }
  // Starts the top candidate; if it has no metadata after the fallback wait, races it
  // against the next one; then replaces the slowest with the next until one answers.
  async function connect(session) {
    const waitMs = config.streamFallbackSeconds * 1000;
    const deadline = now() + timings.connectTimeoutMs;
    const pending = [];
    let next = 0,
      lastError = null;
    const startNext = () => {
      if (next >= session.candidates.length) return false;
      pending.push(beginAttempt(session, session.candidates[next++]));
      return true;
    };
    startNext();
    while (!session.closed) {
      let timer;
      const outcome = await Promise.race([
        ...pending.map((attempt) =>
          attempt.ready.then(
            (torrent) => ({ attempt, torrent }),
            (error) => ({ attempt, error }),
          ),
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), Math.max(0, Math.min(waitMs, deadline - now())));
        }),
      ]);
      clearTimeout(timer);
      if (session.closed) break;
      if (outcome?.torrent) {
        const attempt = outcome.attempt;
        try {
          await chooseFile(session, attempt, outcome.torrent);
          attempt.state = 'won';
          for (const other of pending)
            if (other !== attempt)
              await abandon(session, other, 'abandoned', 'Another release answered first');
          return attempt;
        } catch (error) {
          if (error.reason === 'vpn') throw error;
          lastError = error;
          pending.splice(pending.indexOf(attempt), 1);
          await abandon(session, attempt, 'failed', error.message);
          // Another release of the same quality will not fit either; say so at once.
          if (error.reason === 'disk') {
            for (const other of pending)
              await abandon(session, other, 'abandoned', 'Not enough disk space');
            throw error;
          }
        }
      } else if (outcome?.error) {
        if (outcome.error.reason === 'vpn') throw outcome.error;
        if (!outcome.error.stale) lastError = outcome.error;
        pending.splice(pending.indexOf(outcome.attempt), 1);
        await abandon(session, outcome.attempt, 'failed', outcome.error.message);
      } else if (now() >= deadline) {
        break;
      } else {
        // Slow: race the next candidate, keeping at most two swarms open at once.
        if (pending.length >= 2) {
          const slowest = pending.shift();
          await abandon(
            session,
            slowest,
            'abandoned',
            `No metadata within ${config.streamFallbackSeconds * 2} s`,
          );
        }
        for (const attempt of pending)
          attempt.reason ||= `No metadata within ${config.streamFallbackSeconds} s`;
        if (!startNext() && !pending.length) break;
        changed(session);
        continue;
      }
      if (!pending.length && !startNext()) break;
      changed(session);
    }
    if (session.closed) refuse(410, 'stopped', 'Stream stopped');
    for (const attempt of pending) await abandon(session, attempt, 'abandoned', 'Timed out');
    const tried = session.attempts.length;
    if (lastError?.reason === 'disk') throw lastError;
    if (lastError && session.attempts.every((a) => a.state === 'failed'))
      refuse(502, 'no-release', `None of the releases could be streamed. ${lastError.message}`);
    refuse(
      504,
      'no-peers',
      `No peers answered for ${tried === 1 ? 'the only release' : `any of the ${tried} releases`} tried. Try again later or download it instead.`,
    );
  }
  async function chooseFile(session, attempt, torrent) {
    const files = torrent.files;
    const index = attempt.candidate.release.fileIndex;
    const file =
      (index != null && files[index] && VIDEO.test(files[index].name) && files[index]) ||
      files.filter((f) => VIDEO.test(f.name)).sort((a, b) => b.length - a.length)[0];
    if (!file) fail(422, 'The torrent contains no video file');
    await ensureSpace(session, file.length, `${attempt.entry.hash}:${file.path}`);
    session.entry = attempt.entry;
    session.file = file;
    session.chosen = attempt;
    // A torrent shared with an earlier session was ready before this one existed.
    session.timings.metadata = Math.max(session.created, attempt.entry.readyAt || now());
    session.timings.peers = Math.max(
      session.created,
      attempt.entry.peersAt || session.timings.metadata,
    );
    const winner = attempt.candidate;
    const first = session.candidates[0];
    if (winner !== first)
      session.fallback = {
        from: releaseSummary(first),
        to: releaseSummary(winner),
        reason:
          session.attempts.find((a) => a.candidate === first)?.reason ||
          'The first choice did not answer',
        at: now(),
      };
    reselect(session.entry);
    const served = await sourceServer.add(file, (start) => {
      session.lastRead = start;
      changed(session);
    });
    session.source = served;
  }
  // Releases still worth opening for subtitles after `current` turned out to have none:
  // not failed, not a different film, not already read or known to lack them, and (with
  // trusted releases preferred) in the same trust band as `current`.
  function subtitleCandidates(session, current, checked) {
    const failed = new Set(
      session.attempts.filter((a) => a.state === 'failed').map((a) => a.candidate),
    );
    const wrong = rejected(session.titleId);
    const known = knownSubtitles(session.titleId);
    return session.ranked
      .filter((c) => {
        if (failed.has(c) || checked.includes(c) || wrong[c.release.hash]) return false;
        if (session.filter.trustedOnly && !!c.trusted !== !!current.trusted) return false;
        const languages = known[fileKey(c.release)];
        return !languages || hasSubtitles(languages, session.wanted);
      })
      .slice(0, 4);
  }
  async function run(session) {
    let info,
      wrong = null;
    // Releases read and found to lack the viewer's subtitles, best first; once the search
    // is over, the first of them to connect is accepted without the check.
    const bare = [];
    let settled = false;
    for (;;) {
      await connect(session);
      if (session.closed) return;
      changed(session);
      // Sessions on the same file (another resolution label, another user, a season pack)
      // share one probe of it.
      const probes = (session.entry.probes ||= new Map());
      if (!probes.has(session.file.path)) {
        const pending = probe(session.source.url, { timeout: 120000 });
        probes.set(session.file.path, pending);
        pending.catch(() => probes.delete(session.file.path));
      }
      info = await probes.get(session.file.path);
      if (session.closed) return;
      const mismatch = wrongFilm(session, info);
      if (!mismatch) {
        const current = session.chosen.candidate;
        const languages = subtitleLanguages(info);
        rememberSubtitles(session.titleId, current.release, languages);
        session.subtitles = hasSubtitles(languages, session.wanted);
        if (session.subtitles || !session.filter.requireSubtitles || settled) break;
        // No subtitles in the viewer's language: look at the next releases, then settle
        // for the best one read.
        bare.push(current);
        const next =
          bare.length < SUBTITLE_CHECKS ? subtitleCandidates(session, current, bare) : [];
        if (!next.length && bare[0] === current) break;
        const attempt = session.chosen;
        session.source?.remove();
        session.source = session.entry = session.file = session.chosen = session.fallback = null;
        await abandon(
          session,
          attempt,
          'no-subtitles',
          `No ${languageList(session.wanted)} subtitles in this file`,
        );
        if (next.length) session.candidates = next;
        else {
          session.candidates = [...bare];
          settled = true;
        }
        changed(session);
        continue;
      }
      // Drop the wrong film and try the next release that has not failed.
      const bad = session.chosen;
      reject(session.titleId, bad.candidate.release.hash, mismatch);
      wrong ||= { candidate: bad.candidate, reason: mismatch };
      session.source?.remove();
      session.source = session.entry = session.file = session.chosen = session.fallback = null;
      await abandon(session, bad, 'failed', `A different film with the same name. ${mismatch}`);
      const failed = new Set(
        session.attempts.filter((a) => a.state === 'failed').map((a) => a.candidate),
      );
      const known = rejected(session.titleId);
      session.candidates = session.ranked
        .filter((c) => !failed.has(c) && !known[c.release.hash] && !bare.includes(c))
        .slice(0, 4);
      // Only releases without subtitles are left: settle for the best of them.
      if (!session.candidates.length && bare.length) {
        session.candidates = [...bare];
        settled = true;
      }
      if (!session.candidates.length)
        refuse(
          404,
          'wrong-film',
          `Every ${session.resolution}p release listed for this title turned out to be a different film with the same name. ${wrong.reason}`,
        );
      changed(session);
    }
    if (wrong)
      session.fallback = {
        from: releaseSummary(wrong.candidate),
        to: releaseSummary(session.chosen.candidate),
        reason: `The first choice was a different film with the same name. ${wrong.reason}`,
        at: now(),
      };
    else if (bare.length && session.subtitles)
      session.fallback = {
        from: releaseSummary(bare[0]),
        to: releaseSummary(session.chosen.candidate),
        kind: 'subtitles',
        reason: `The first choice has no ${languageList(session.wanted)} subtitles.`,
        at: now(),
      };
    session.info = info;
    session.timings.probed = now();
    const ctx = { item: store.item(session.itemId), title: store.title(session.titleId) };
    const lock = readLock(ctx.title, ctx.item, session.resolution);
    // The first stream of a season sets its lock; a fallback means the locked choice is
    // dead, so the release that worked becomes the new lock.
    if (!lock || session.fallback)
      writeLock(ctx.title, ctx.item, session.resolution, session.chosen.candidate);
    changed(session);
    if (session.intent === 'play' && !session.conversion)
      await convert(session, {}).catch(() => {});
  }

  // ---- Conversion ---------------------------------------------------------------------
  function hasZscale() {
    zscale ||= new Promise((resolve) =>
      execFile(
        config.ffmpeg,
        ['-hide_banner', '-filters'],
        { windowsHide: true, timeout: 10000 },
        (error, stdout) => resolve(!error && /\bzscale\b/.test(stdout)),
      ),
    );
    return zscale;
  }
  function chooseAudio(session, requested) {
    const tracks = session.info.audio;
    if (requested != null) {
      if (!tracks.some((t) => t.index === requested)) fail(400, 'Audio track not found');
      return requested;
    }
    const preferred = languageKey(store.prefs(session.userId).audioLanguage);
    const match = preferred ? tracks.find((t) => languageKey(t.language) === preferred) : null;
    return (match || tracks.find((t) => t.default) || tracks[0])?.index ?? null;
  }
  const preferredLanguages = (userId) =>
    String(store.prefs(userId).subtitleLanguage || '')
      .split(',')
      .map(languageKey)
      .filter(Boolean);
  // The subtitle languages the streaming filter looks for: the preferred ones, else English.
  const wantedSubtitles = (userId) => {
    const preferred = preferredLanguages(userId);
    return preferred.length ? preferred : ['eng'];
  };
  function subtitleTracks(session) {
    const preferred = preferredLanguages(session.userId);
    return session.info.subtitles
      .filter((t) => textSubtitleCodecs.includes(t.codec))
      .sort(
        (a, b) =>
          (preferred.includes(languageKey(a.language)) ? 0 : 1) -
            (preferred.includes(languageKey(b.language)) ? 0 : 1) || a.index - b.index,
      )
      .slice(0, 8)
      .map((t) => t.index);
  }
  async function convert(session, { audio, position, capabilities } = {}) {
    if (!session.info)
      refuse(409, 'not-ready', 'The stream is still starting. Try again in a moment.');
    if (capabilities !== undefined) session.capabilities = capabilitiesFrom(capabilities);
    const info = session.info;
    const seek = Math.max(
      0,
      Math.min(position ?? session.position ?? session.resume ?? 0, Math.max(0, info.duration - 1)),
    );
    const track = chooseAudio(session, audio ?? session.audio);
    session.audio = track;
    const plan = conversionPlan(info, session.capabilities, {
      tonemap: info.hdr ? await hasZscale() : false,
    });
    const generation = ++session.generation;
    const previous = session.conversion;
    session.position = seek;
    session.positionAt = now();
    setWindow(session, seek);
    const conversion = {
      generation,
      state: 'starting',
      mode: plan.mode,
      reason: plan.reason,
      segmentFormat: plan.segmentFormat,
      requested: seek,
      offset: null,
      url: null,
      key: null,
      audio: track,
      subtitles: subtitleTracks(session),
      converted: 0,
      started: now(),
    };
    session.conversion = conversion;
    session.timings.playRequested = now();
    changed(session);
    if (previous?.stop) await previous.stop().catch(() => {});
    try {
      const started = await media.startStream(session.user, {
        itemId: session.itemId,
        input: session.source.url,
        directory: hlsRoot,
        convert: {
          seek,
          audio: track,
          copy: plan.copy,
          codec: plan.codec,
          maxHeight: plan.maxHeight,
          tonemap: plan.tonemap,
          audioChannels: plan.audioChannels,
          subtitles: conversion.subtitles,
        },
        authorize: (viewer) =>
          viewer?.id === session.userId && !session.closed && sessions.get(session.id) === session,
        onTouch: () => touch(session),
        onProgress: (seconds) => {
          conversion.converted = seconds;
        },
        // The conversion idled out (nobody fetched segments for two minutes). The client
        // restarts it with /convert at the current position.
        onDispose: () => {
          if (session.generation !== generation || session.closed) return;
          conversion.state = 'stopped';
          conversion.url = null;
          changed(session);
        },
        cast: {
          codecs: plan.codecs,
          resolution: `${plan.width}x${plan.height}`,
          bandwidth: Math.round(
            plan.copy ? info.bitRate || 8e6 : plan.maxHeight > 1080 ? 25e6 : 10e6,
          ),
        },
      });
      conversion.key = started.key;
      conversion.stop = started.stop;
      conversion.session = started.session;
      if (session.closed || session.generation !== generation) {
        await started.stop();
        return conversion;
      }
      const [ready, offset] = await Promise.all([
        started.ready,
        plan.copy ? keyframeBefore(session.source.url, seek).catch(() => seek) : seek,
      ]);
      if (session.generation !== generation) return conversion;
      Object.assign(conversion, { state: 'ready', url: ready.url, offset, ready: now() });
      session.timings.playlist = now();
      if (session.replaces) retire(session.replaces);
      changed(session);
      return conversion;
    } catch (error) {
      if (session.generation === generation) {
        conversion.state = 'failed';
        conversion.error =
          error.status && error.status < 500 ? error.message : 'Video conversion failed';
        changed(session);
      }
      throw error;
    }
  }
  // Cancels a pending resolution switch away from `session`.
  function keepPlaying(session) {
    clearTimeout(session.retiring);
    session.retiring = null;
    const replacement = session.replacedBy && sessions.get(session.replacedBy);
    if (replacement?.replaces === session.id) replacement.replaces = null;
    session.replacedBy = null;
    changed(session);
  }
  function retire(oldId) {
    const old = sessions.get(oldId);
    if (!old || old.closed || old.retiring) return;
    old.retiring = setTimeout(
      () => void close(old, 'Replaced by another resolution'),
      timings.replacedGraceMs,
    );
    old.retiring.unref?.();
  }
  async function waitFor(session, test, ms) {
    const deadline = now() + ms;
    while (!test() && !session.closed && !session.error && now() < deadline) await pause(50);
  }

  // ---- Status -------------------------------------------------------------------------
  function bufferState(session) {
    const torrent = session.entry?.torrent;
    const file = session.file;
    const position = session.position ?? session.resume ?? 0;
    const conversion = session.conversion;
    const transcodedEnd =
      conversion?.state === 'ready'
        ? (conversion.offset ?? conversion.requested) + conversion.converted
        : null;
    const waiting = [...(session.source?.source.readers || [])].some(
      (r) => r.waitingSince && now() - r.waitingSince > 400,
    );
    if (!torrent?.ready || !file || torrent.destroyed)
      return {
        position,
        aheadBytes: 0,
        aheadSeconds: 0,
        convertedAheadSeconds: null,
        waitingForData: false,
      };
    const start = file.offset + byteAt(session, position);
    const end = file.offset + file.length;
    let piece = pieceOf(torrent, start),
      limit = Math.min(pieceOf(torrent, end - 1), piece + 4000);
    while (piece <= limit && torrent.bitfield.get(piece)) piece++;
    const aheadBytes = Math.max(0, Math.min(end, piece * torrent.pieceLength) - start);
    const rate = session.info?.duration > 0 ? file.length / session.info.duration : null;
    return {
      position,
      aheadBytes,
      aheadSeconds: rate ? Math.round((aheadBytes / rate) * 10) / 10 : null,
      convertedAheadSeconds:
        transcodedEnd == null
          ? null
          : Math.max(0, Math.round((transcodedEnd - position) * 10) / 10),
      waitingForData: waiting,
    };
  }
  function stateOf(session, buffer) {
    if (session.error) return 'failed';
    if (session.closed) return 'stopped';
    if (!session.chosen)
      return session.attempts.some((a) => a.entry?.peersAt) ? 'fetching-metadata' : 'finding-peers';
    if (!session.info) return 'probing';
    if (session.intent !== 'play') return 'ready';
    const conversion = session.conversion;
    if (!conversion || conversion.state === 'starting') return 'starting';
    if (conversion.state === 'failed') return 'failed';
    if (buffer.waitingForData && (buffer.convertedAheadSeconds ?? 0) < 6) return 'buffering';
    return 'ready';
  }
  const messages = {
    'finding-peers': 'Finding peers…',
    'fetching-metadata': 'Connected to peers, fetching the file list…',
    probing: 'Reading the video…',
    ready: 'Ready',
    starting: 'Starting playback…',
    buffering: 'Buffering…',
    stopped: 'Stopped',
  };
  // What the streaming filter could not satisfy for the release being played.
  function warnings(session, chosen) {
    const list = [];
    if (!chosen) return list;
    if (session.filter.trustedOnly && !chosen.trusted) {
      const group = chosen.traits.group ? ` (${chosen.traits.group})` : '';
      list.push(
        session.ranked.some((c) => c.trusted)
          ? `Not from a trusted release group${group}: the trusted releases did not answer.`
          : `Not from a trusted release group${group}: no trusted release of this quality is listed.`,
      );
    }
    if (session.filter.requireSubtitles && session.info && !session.subtitles)
      list.push(
        `No ${languageList(session.wanted)} subtitles in this file. Online subtitles may still have them.`,
      );
    return list;
  }
  function status(session) {
    const torrent = session.entry?.torrent;
    const buffer = bufferState(session);
    const state = stateOf(session, buffer);
    const attempting = session.attempts.filter(
      (a) => a.state === 'trying' && a.entry?.torrent && !a.entry.torrent.destroyed,
    );
    const peers =
      torrent && !torrent.destroyed
        ? torrent.numPeers
        : attempting.reduce((n, a) => n + (a.entry.torrent.numPeers || 0), 0);
    const chosen = session.chosen?.candidate || session.candidates[0];
    const conversion = session.conversion;
    const since = (time) => (time ? time - session.timings.created : null);
    return {
      id: session.id,
      itemId: session.itemId,
      titleId: session.titleId,
      resolution: session.resolution,
      intent: session.intent,
      player: session.player || null,
      state,
      message:
        state === 'failed'
          ? session.error?.message || conversion?.error || 'Streaming failed'
          : messages[state],
      error:
        session.error ||
        (conversion?.state === 'failed'
          ? { reason: 'conversion', message: conversion.error }
          : null),
      release: chosen && {
        ...releaseSummary(chosen),
        subtitles: session.info ? session.subtitles : (chosen.subtitles ?? null),
      },
      fallback: session.fallback || null,
      warnings: warnings(session, chosen),
      attempts: session.attempts.map((a) => ({
        name: String(a.candidate.release.label || '').split('\n')[0],
        hash: a.candidate.release.hash,
        state: a.state,
        reason: a.reason,
        peers: a.entry?.torrent && !a.entry.torrent.destroyed ? a.entry.torrent.numPeers : 0,
      })),
      peers,
      downloadSpeed: torrent && !torrent.destroyed ? Math.round(torrent.downloadSpeed) : 0,
      uploadSpeed: torrent && !torrent.destroyed ? Math.round(torrent.uploadSpeed) : 0,
      file: session.file
        ? {
            name: session.file.name,
            size: session.file.length,
            downloaded: torrent && !torrent.destroyed ? session.file.downloaded : 0,
            progress:
              torrent && !torrent.destroyed ? Math.round(session.file.progress * 1000) / 1000 : 0,
          }
        : null,
      buffer,
      resumePosition: session.resume ?? 0,
      playback: session.info ? playbackInfo(session) : null,
      conversion: conversion
        ? {
            id: conversion.key,
            state: conversion.state,
            url: conversion.url,
            offset: conversion.offset,
            requested: conversion.requested,
            mode: conversion.mode,
            reason: conversion.reason,
            segmentFormat: conversion.segmentFormat,
            audio: conversion.audio,
            subtitles: conversion.subtitles,
            convertedSeconds: Math.round(conversion.converted * 10) / 10,
            error: conversion.error || null,
          }
        : null,
      replaces: session.replaces || null,
      replacedBy: session.replacedBy || null,
      parentId: session.parentId || null,
      timings: {
        peersMs: since(session.timings.peers),
        metadataMs: since(session.timings.metadata),
        probedMs: since(session.timings.probed),
        playRequestedMs: since(session.timings.playRequested),
        playlistMs: since(session.timings.playlist),
        playToPlaylistMs:
          session.timings.playlist && session.timings.playRequested
            ? session.timings.playlist - session.timings.playRequested
            : null,
      },
      expiresInMs: Math.max(
        0,
        session.touched +
          (session.intent === 'play' ? timings.playingIdleMs : timings.preparedIdleMs) -
          now(),
      ),
    };
  }
  function playbackInfo(session) {
    const info = session.info;
    const preferred = preferredLanguages(session.userId);
    const plan = conversionPlan(info, session.capabilities);
    return {
      itemId: session.itemId,
      ...info,
      direct:
        /mp4|mov/.test(info.container) &&
        info.video === 'h264' &&
        plan.copy &&
        info.audio.length > 0 &&
        info.audio.every((t) => t.codec === 'aac'),
      plan: { mode: plan.mode, reason: plan.reason, segmentFormat: plan.segmentFormat },
      preferredSubtitles: preferred.map((language) => ({
        language,
        embedded: info.subtitles.some(
          (t) => languageKey(t.language) === language && textSubtitleCodecs.includes(t.codec),
        ),
      })),
    };
  }

  // ---- Lifetime ---------------------------------------------------------------------------
  async function close(session, reason = 'Stopped') {
    if (session.closed) return;
    session.closed = true;
    session.closedReason = reason;
    clearTimeout(session.retiring);
    const final = JSON.stringify({ ...status(session), state: 'stopped', message: reason });
    for (const listener of session.listeners) listener(final, true);
    session.listeners.clear();
    sessions.delete(session.id);
    // A replacement that is stopped (the viewer went back to the original quality) must
    // not retire the session it was replacing.
    const replaced = session.replaces && sessions.get(session.replaces);
    if (replaced?.replacedBy === session.id) keepPlaying(replaced);
    session.source?.remove();
    if (session.conversion?.stop) await session.conversion.stop().catch(() => {});
    await dropAttempts(session);
    if (session.entry && !session.chosen?.dropped) {
      session.chosen.dropped = true;
      await releaseEntry(session.entry, session);
    }
    for (const child of sessions.values()) if (child.parentId === session.id) child.parentId = null;
  }
  // Several checks can see the failure at once; they share one shutdown.
  let shuttingDown = null;
  function vpnLost(state) {
    shuttingDown ||= shutDown(state).finally(() => {
      shuttingDown = null;
    });
    return shuttingDown;
  }
  async function shutDown(state) {
    // Stop every swarm first, synchronously, before any slower cleanup.
    for (const entry of entries.values())
      if (entry.torrent && !entry.torrent.destroyed) entry.torrent.destroy({ destroyStore: true });
    const engineStopped = stopEngine();
    for (const session of [...sessions.values()]) {
      if (session.error?.reason === 'vpn') continue;
      session.error = {
        reason: 'vpn',
        message: `The VPN disconnected, so streaming stopped to keep this server’s address private. ${state.message}`,
      };
      session.failedAt = now();
      changed(session);
      session.source?.remove();
      if (session.conversion?.stop) await session.conversion.stop().catch(() => {});
      await dropAttempts(session);
      if (session.entry) await releaseEntry(session.entry, session);
      session.entry = null;
    }
    for (const entry of [...entries.values()]) {
      entries.delete(entry.hash);
      if (entry.torrent && !entry.torrent.destroyed)
        await new Promise((resolve) =>
          entry.torrent.destroy({ destroyStore: true }, () => resolve()),
        );
      await rm(entry.directory, { recursive: true, force: true }).catch(() => {});
    }
    await engineStopped;
  }
  // A fresh check on its own timer while any torrent traffic exists; checks made by
  // requests never delay it.
  const guardTimer = setInterval(
    () => {
      if (!closed && (client || clientStarting || entries.size)) checkGuard();
    },
    Math.max(50, timings.guardMs),
  );
  guardTimer.unref();
  async function tick() {
    if (closed) return;
    if (client || entries.size) {
      checkGuard();
      if (shuttingDown) await shuttingDown;
    }
    if (client && now() - lastDiskAt >= timings.diskMs && entries.size) {
      lastDiskAt = now();
      try {
        const disk = await statfs(root);
        if (disk.bavail * disk.bsize < config.reserveBytes / 2)
          for (const session of [...sessions.values()]) {
            session.error = {
              reason: 'disk',
              message:
                'The disk is almost full, so streaming stopped. Free some space and try again.',
            };
            changed(session);
            await close(session, session.error.message);
          }
      } catch {}
    }
    for (const session of [...sessions.values()]) {
      if (session.listeners.size) touch(session);
      const idle = session.intent === 'play' ? timings.playingIdleMs : timings.preparedIdleMs;
      if (session.error && now() - session.failedAt > timings.failedLingerMs)
        await close(session, session.error.message);
      else if (!session.parentId && now() - session.touched > idle)
        await close(session, 'Expired after being idle');
      else if (session.parentId && !sessions.has(session.parentId)) session.parentId = null;
      else changed(session);
    }
    if (
      client &&
      !entries.size &&
      clientIdleSince &&
      now() - clientIdleSince > timings.engineIdleMs
    )
      await stopEngine();
  }
  const ticker = setInterval(
    () => void tick().catch((error) => console.error('Stream tick failed:', error.message)),
    timings.tickMs,
  );
  ticker.unref();

  // Sessions belong to one player instance (a browser tab, the TV app, a cast sender),
  // identified by the client-chosen `player` id. Torrents are shared between sessions, so
  // a second device on the same item starts from a warm swarm, but each device has its
  // own conversion, position, capabilities and lifetime: stopping one never stops another.
  // A prepared session is not playing anywhere yet, so any player may claim it.
  const playerFrom = (value) => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value))
      fail(400, 'Invalid player id');
    return value;
  };
  const live = (s) => !s.closed && !s.error;
  function find(user, itemId, resolution, player) {
    const pool = [...sessions.values()].filter(
      (s) => s.userId === user.id && s.itemId === itemId && s.resolution === resolution && live(s),
    );
    return (
      (player && pool.find((s) => s.player === player)) ||
      pool.find((s) => s.intent === 'prepare' && (!s.player || s.player === player)) ||
      pool.find((s) => s.intent === 'prepare') ||
      null
    );
  }
  const anySession = (user, itemId, resolution) =>
    [...sessions.values()].find(
      (s) => s.userId === user.id && s.itemId === itemId && s.resolution === resolution && live(s),
    );
  function resumeFor(user, itemId) {
    const prior = store.state(user.id, itemId);
    return prior.completed ? 0 : prior.position || 0;
  }
  async function open(user, itemId, { resolution, intent, after, player }) {
    permit(user);
    requireVpn();
    const { ctx, resolutions } = await choices(user, itemId);
    const chosen = preferredResolution(ctx.kind, resolutions, resolution);
    const option = resolutions[chosen];
    if (!option.ranked.length) refuse(404, 'unavailable', option.reason);
    let session = find(user, itemId, chosen, player);
    if (!session) {
      session = await create(user, ctx, chosen, option.ranked, intent);
      session.player = player;
    }
    if (after) {
      const parent = owned(user, after);
      if (parent.id !== session.id) session.parentId = parent.id;
    }
    touch(session);
    return session;
  }

  return {
    guard: () => guardState(),
    // Loading WebTorrent takes a few hundred milliseconds of CPU; do it at server start so
    // the first prepare is not blocked. Loading opens no sockets.
    warm: () =>
      dependencies.createClient ? Promise.resolve() : import('webtorrent').catch(() => {}),
    has: (user, itemId) =>
      [...sessions.values()].some((s) => s.userId === user?.id && s.itemId === itemId && !s.closed),
    async options(user, itemId, { refresh = false } = {}) {
      const started = now();
      const { ctx, resolutions, cached, ageMs } = await choices(user, itemId, { refresh });
      const result = {
        itemId,
        kind: ctx.kind,
        defaultResolution: preferredResolution(ctx.kind, resolutions),
        resolutions: [standardResolution(resolutions), 2160].map((resolution) => {
          const { ranked, lock, reason } = resolutions[resolution];
          const session = anySession(user, itemId, resolution);
          return ranked.length
            ? {
                resolution,
                available: true,
                release: releaseSummary(ranked[0]),
                alternatives: ranked.length - 1,
                seasonLock: lock
                  ? {
                      group: lock.group,
                      service: lock.service,
                      seasonPack: lock.hash === ranked[0].release.hash,
                    }
                  : null,
                session: session ? { id: session.id, state: status(session).state } : null,
              }
            : { resolution, available: false, reason };
        }),
        canStream: allowed(user),
        guard: guardState(),
        cached,
        listingAgeSeconds: Math.round(ageMs / 1000),
        elapsedMs: now() - started,
      };
      // Next Up should be instant too: fetch the next episode's listing in the background.
      const following = nextItem(ctx.item, ctx.title);
      if (following && !listings.has(following.id))
        Promise.resolve(listing(following.id)).catch(() => {});
      return result;
    },
    async prepare(user, itemId, { resolution, after, player } = {}) {
      const session = await open(user, itemId, {
        resolution,
        intent: 'prepare',
        after,
        player: playerFrom(player),
      });
      return status(session);
    },
    // Every start yields a new conversion for the calling device: at `position`, or at the
    // saved resume point when none is sent, with the caller's capabilities. This is also
    // how "Try again" recovers from a failed conversion.
    async start(
      user,
      itemId,
      { resolution, capabilities, audio, position, wait = false, player } = {},
    ) {
      if (position != null && !finite(position, 0, 604800)) fail(400, 'Invalid position');
      if (audio != null && !Number.isInteger(audio)) fail(400, 'Invalid audio track');
      const caps = capabilitiesFrom(capabilities);
      const owner = playerFrom(player);
      const session = await open(user, itemId, { resolution, intent: 'play', player: owner });
      if (session.replacedBy) keepPlaying(session);
      session.intent = 'play';
      session.player = owner;
      session.parentId = null;
      session.capabilities = caps;
      session.resume = position ?? resumeFor(user, itemId);
      session.position = null;
      if (audio != null) session.audio = audio;
      reselect(session.entry || { torrent: null });
      // Before the probe, run() converts at `resume` as soon as the file can be read.
      if (session.info) convert(session, { position: session.resume, audio }).catch(() => {});
      changed(session);
      if (wait)
        await waitFor(
          session,
          () => session.conversion?.state === 'ready' || session.conversion?.state === 'failed',
          60000,
        );
      return status(session);
    },
    status(user, sessionId, { position } = {}) {
      const session = owned(user, sessionId);
      if (position != null && finite(position, 0, 604800)) {
        session.position = position;
        session.positionAt = now();
      }
      touch(session);
      return status(session);
    },
    list(user) {
      return [...sessions.values()].filter((s) => s.userId === user.id).map(status);
    },
    events(user, sessionId, res) {
      const session = owned(user, sessionId);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 1000\n\n');
      const send = (snapshot, end = false) => {
        res.write(`event: status\ndata: ${snapshot}\n\n`);
        if (end) res.end();
      };
      session.lastSent = JSON.stringify(status(session));
      send(session.lastSent);
      session.listeners.add(send);
      touch(session);
      const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
      res.on('close', () => {
        clearInterval(keepAlive);
        session.listeners.delete(send);
      });
    },
    heartbeat(user, sessionId, { position } = {}) {
      if (!finite(position, 0, 604800)) fail(400, 'Invalid position');
      return this.status(user, sessionId, { position });
    },
    // Progress events from /api/playback keep the user's streams of that item alive. They
    // do not say which device sent them, so they move the playhead only when exactly one
    // device is playing the item (heartbeats are per session and always precise).
    observe(user, itemId, position) {
      const playing = [...sessions.values()].filter(
        (s) => s.userId === user.id && s.itemId === itemId && s.intent === 'play' && live(s),
      );
      for (const session of playing) touch(session);
      if (playing.length === 1 && finite(position, 0, 604800)) {
        playing[0].position = position;
        playing[0].positionAt = now();
      }
    },
    async info(user, sessionId) {
      const session = owned(user, sessionId);
      touch(session);
      await waitFor(session, () => session.info, 30000);
      if (!session.info)
        refuse(
          409,
          'not-ready',
          session.error?.message || 'The stream is still starting. Try again in a moment.',
        );
      return playbackInfo(session);
    },
    async convert(user, sessionId, { audio, position, capabilities } = {}) {
      const session = owned(user, sessionId);
      if (position != null && !finite(position, 0, 604800)) fail(400, 'Invalid position');
      if (audio != null && !Number.isInteger(audio)) fail(400, 'Invalid audio track');
      session.intent = 'play';
      session.parentId = null;
      if (session.replacedBy) keepPlaying(session);
      touch(session);
      reselect(session.entry || { torrent: null });
      await waitFor(session, () => session.info, 30000);
      const conversion = await convert(session, { audio, position, capabilities });
      await waitFor(
        session,
        () => conversion.state !== 'starting' || session.generation !== conversion.generation,
        60000,
      );
      if (conversion.state === 'failed') fail(503, conversion.error);
      return { ...status(session).conversion, sessionId: session.id };
    },
    async switchResolution(user, sessionId, { resolution, position, capabilities } = {}) {
      const old = owned(user, sessionId);
      if (!STREAM_RESOLUTIONS.includes(resolution)) fail(400, 'Choose 480, 720, 1080 or 2160');
      if (resolution === old.resolution) return status(old);
      const current = position ?? old.position ?? old.resume ?? 0;
      const next = await this.start(user, old.itemId, {
        resolution,
        position: current,
        capabilities: capabilities ?? old.capabilities,
        audio: undefined,
        player: old.player,
      });
      const session = sessions.get(next.id);
      session.replaces = old.id;
      old.replacedBy = session.id;
      changed(old);
      return status(session);
    },
    async prepareNext(user, sessionId) {
      const session = owned(user, sessionId);
      const item = store.item(session.itemId),
        title = store.title(session.titleId);
      const following = nextItem(item, title);
      if (!following) fail(404, 'This is the last episode');
      return this.prepare(user, following.id, {
        resolution: session.resolution,
        after: session.id,
        player: session.player,
      });
    },
    async subtitles(user, sessionId) {
      const session = owned(user, sessionId);
      await waitFor(session, () => session.info, 20000);
      const info = session.info;
      const extracted = session.conversion?.subtitles || [];
      let online = null,
        onlineError = null;
      try {
        online = await onlineSubtitles(user, session.itemId);
      } catch (error) {
        onlineError = error.message;
      }
      const preferred = preferredLanguages(session.userId);
      return {
        embedded: (info?.subtitles || []).map((track) => ({
          ...track,
          text: textSubtitleCodecs.includes(track.codec),
          available: extracted.includes(track.index),
          url: extracted.includes(track.index)
            ? `/api/streams/${session.id}/subtitles/embedded/${track.index}`
            : null,
        })),
        online:
          online &&
          online.map((track) => ({
            ...track,
            url: `/api/items/${session.itemId}/subtitles/online/${encodeURIComponent(track.id)}`,
          })),
        onlineError,
        preferred: preferred.map((language) => ({
          language,
          embedded: (info?.subtitles || []).some(
            (t) => languageKey(t.language) === language && textSubtitleCodecs.includes(t.codec),
          ),
          online: online ? online.some((t) => languageKey(t.language) === language) : null,
        })),
      };
    },
    async subtitleFile(user, sessionId, index) {
      const session = owned(user, sessionId);
      const conversion = session.conversion;
      if (!conversion?.key || !conversion.subtitles.includes(index))
        fail(
          404,
          'This subtitle track is not available for the current playback. Start playback first.',
        );
      if (conversion.offset == null)
        refuse(409, 'not-ready', 'Playback is still starting. Load subtitles once it plays.');
      touch(session);
      const file = media.segment(user, conversion.key, `subtitle-${index}.vtt`);
      const text = await readFile(file, 'utf8').catch(() => 'WEBVTT\n\n');
      // FFmpeg writes cues in source time; the player needs the playlist's timeline.
      return {
        text: vttRelative(text, conversion.offset),
        offset: conversion.offset,
        until: conversion.offset + conversion.converted,
        complete: !!conversion.session?.exited && !conversion.session?.failed,
      };
    },
    direct(user, sessionId) {
      const session = owned(user, sessionId);
      if (!session.info || !playbackInfo(session).direct)
        fail(409, 'This stream needs conversion. Use the playlist instead.');
      touch(session);
      return session.source.url;
    },
    async cast(user, sessionId) {
      const session = owned(user, sessionId);
      if (session.conversion?.state !== 'ready')
        refuse(409, 'not-ready', 'Start playback before casting.');
      touch(session);
      return media.cast(user, session.conversion.key);
    },
    // Answers at once; deleting the cached files continues in the background. The session
    // is gone from every route immediately. `cleanup` lets tests wait for the deletion.
    stop(user, sessionId) {
      const session = sessions.get(sessionId);
      if (!session || session.userId !== user.id) return { cleanup: Promise.resolve() };
      const cleanup = close(session, 'Stopped').catch((error) =>
        console.error('Stream cleanup failed:', error.code || error.name),
      );
      return { cleanup };
    },
    // For tests and diagnostics.
    _internal: { sessions, entries, listings, tick, engine: () => client },
    async close() {
      closed = true;
      clearInterval(ticker);
      clearInterval(guardTimer);
      for (const session of [...sessions.values()]) await close(session, 'Server is stopping');
      for (const entry of [...entries.values()]) await releaseEntry(entry, null);
      await stopEngine();
      sourceServer.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    },
  };
}

// Release listings come from the catalog with file names and trackers for streaming.
export const catalogReleases = (catalog) => (itemId) =>
  catalog.releases(itemId, { detailed: true });
