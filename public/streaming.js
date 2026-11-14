// Stream now: view logic shared by the stream sheet, the title page and the player.
// Everything here is free of DOM access so it can be tested in Node. The server contract
// is docs/streaming.md.

export const RESOLUTIONS = [1080, 2160];
// The server offers 720p or SD in place of 1080p when a title has nothing at 1080p.
const KNOWN_RESOLUTIONS = [480, 720, 1080, 2160];
// Prepared sessions fetch the head (8 MiB) and the tail (2 MiB) before they are playable.
const HEAD_TAIL_BYTES = 10 * 1024 * 1024;

export const resolutionLabel = (resolution) => {
  const value = Number(resolution);
  return value >= 2160 ? '4K' : value >= 1080 ? '1080p' : value >= 720 ? '720p' : 'SD';
};

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1e9) return `${(value / 1e9).toFixed(value >= 1e10 ? 0 : 1)} GB`;
  if (value >= 1e6) return `${Math.round(value / 1e6)} MB`;
  return `${Math.max(0, Math.round(value / 1e3))} KB`;
}

export function formatSpeed(bytesPerSecond) {
  const value = Number(bytesPerSecond) || 0;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB/s`;
  return `${Math.round(value / 1e3)} KB/s`;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// The key was renamed once: earlier failures were caused by a server bug (a missing init
// segment), not by the device, so what was remembered then is ignored.
const FAILED_CODECS = 'mediawan.stream.failedCodecs.2';
function failedCodecs(env) {
  try {
    const list = JSON.parse((env && env.localStorage.getItem(FAILED_CODECS)) || '[]');
    return Array.isArray(list) ? list.filter((c) => c === 'hevc' || c === 'hevc10') : [];
  } catch {
    return [];
  }
}
// The codec name the capability list uses for a probed file. H.264 is never forgotten:
// it is the format the server converts to.
export function codecKey(info) {
  if (!info || info.video !== 'hevc') return null;
  return /10/.test(String(info.pixelFormat || '')) || info.hdr ? 'hevc10' : 'hevc';
}
export function rememberDecodeFailure(env, info) {
  const codec = codecKey(info);
  if (!codec) return false;
  try {
    // A device that cannot decode 8-bit HEVC cannot decode 10-bit either.
    const list = new Set([...failedCodecs(env), codec, ...(codec === 'hevc' ? ['hevc10'] : [])]);
    env.localStorage.setItem(FAILED_CODECS, JSON.stringify([...list]));
  } catch {}
  return true;
}

// What the browser can decode through Media Source Extensions (which hls.js uses).
// `env` is `window` in the browser; tests pass a stand-in.
export function detectCapabilities(env) {
  const source = env && env.MediaSource;
  const mse = (type) => {
    try {
      return !!source && !!source.isTypeSupported && source.isTypeSupported(type);
    } catch {
      return false;
    }
  };
  const video = [
    mse('video/mp4; codecs="avc1.640028"') && 'h264',
    mse('video/mp4; codecs="hvc1.1.6.L150.B0"') && 'hevc',
    mse('video/mp4; codecs="hvc1.2.4.L153.B0"') && 'hevc10',
  ].filter(Boolean);
  // A browser can claim a codec and then fail to decode it (no hardware decoder, a build
  // without the codec). Codecs that failed here before are left out, so the server
  // converts them from the first press instead of failing first.
  for (const failed of failedCodecs(env)) {
    const at = video.indexOf(failed);
    if (at >= 0) video.splice(at, 1);
  }
  // Without MSE (native HLS, e.g. Safari) every supported device still plays H.264.
  if (!video.includes('h264')) video.unshift('h264');
  let uhd = null;
  try {
    // Samsung Tizen: the app canvas is often 1920×1080 even on a UHD panel.
    const info = env && env.webapis && env.webapis.productinfo;
    if (info && typeof info.isUdPanelSupported === 'function') uhd = !!info.isUdPanelSupported();
  } catch {}
  if (uhd == null) {
    const screen = (env && env.screen) || {};
    const ratio = Number(env && env.devicePixelRatio) || 1;
    uhd = Math.max(Number(screen.width) || 0, Number(screen.height) || 0) * ratio >= 3000;
  }
  return {
    video,
    maxHeight: uhd ? 2160 : 1080,
    audioChannels: surroundOutput(env) ? 6 : 2,
    dolbyVision: false,
  };
}

// 5.1 AAC only helps when the audio output itself has six or more channels (an HDMI
// receiver or soundbar). On stereo speakers the browser would downmix it itself, which is
// worse for dialogue than the server's centre-preserving stereo downmix, so 2 is the default.
function surroundOutput(env) {
  const Context = env && (env.AudioContext || env.webkitAudioContext);
  if (!Context) return false;
  let context = null;
  try {
    context = new Context();
    return Number(context.destination && context.destination.maxChannelCount) >= 6;
  } catch {
    return false;
  } finally {
    try {
      if (context && context.close) context.close().catch(() => {});
    } catch {}
  }
}

// The video codec a release needs from the device to be copied rather than converted.
export function requiredCodec(release) {
  if (!release || !release.hevc) return 'h264';
  return release.hdr || release.dolbyVision ? 'hevc10' : 'hevc';
}

// How one entry of `stream-options.resolutions` would play on this device:
// `selectable` false hides it from the choice (with `note` saying why); `warning` is an
// honest cost (server conversion) shown beside an option that still works.
export function streamPlan(option, capabilities) {
  const caps = capabilities || { video: ['h264'], maxHeight: 1080 };
  const label = resolutionLabel(option && option.resolution);
  if (!option || !option.available)
    return {
      selectable: false,
      note: unavailableNote(option && option.reason, label),
      warning: '',
    };
  const release = option.release || {};
  const uhd = option.resolution >= 2160;
  if (uhd && caps.maxHeight < 2160)
    return {
      selectable: false,
      note: 'This screen shows up to 1080p, so 4K would only take longer to load.',
      warning: '',
    };
  const codec = requiredCodec(release);
  const decodes = (caps.video || ['h264']).includes(codec);
  const dolbyOnly = release.dolbyVisionOnly && !caps.dolbyVision;
  if (uhd && (!decodes || dolbyOnly))
    return {
      selectable: false,
      note: dolbyOnly
        ? 'This 4K copy is Dolby Vision only, which this device cannot show correctly.'
        : `This device cannot decode this 4K video (${codec === 'hevc10' ? 'HEVC 10-bit' : 'HEVC'}).`,
      warning: '',
    };
  if (!decodes || dolbyOnly)
    return {
      selectable: true,
      note: '',
      warning: `The server converts this for your device: it starts a little slower${release.hdr ? ' and HDR shows as SDR' : ''}.`,
    };
  return { selectable: true, note: '', warning: '' };
}

function unavailableNote(reason, label) {
  const text = String(reason || '');
  const best = text.match(/Best:\s*(.+)$/);
  if (best)
    return `No ${label} release meets your rules right now (closest: ${lowerFirst(best[1])}).`;
  return text.replace(/\b2160p\b/g, '4K') || `No ${label} release is available.`;
}
const lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1);

// Short facts for an option card: "4.4 GB · HMAX · HDR".
export function releaseFacts(release) {
  if (!release) return [];
  const facts = [formatBytes(release.sizeBytes)];
  if (release.service) facts.push(release.service);
  if (release.source === 'disc') facts.push('Blu-ray');
  if (release.source === 'remux') facts.push('Blu-ray remux');
  if (release.dolbyVision) facts.push(release.hdr ? 'Dolby Vision · HDR' : 'Dolby Vision');
  else if (release.hdr) facts.push('HDR');
  return facts;
}

// A secondary line: codec, group, seeders, season pack.
export function releaseDetail(release) {
  if (!release) return '';
  const parts = [release.hevc ? 'HEVC' : 'H.264'];
  if (release.group) parts.push(release.group);
  if (release.seeders != null) parts.push(plural(release.seeders, 'seeder'));
  if (release.seasonPack) parts.push('season pack');
  return parts.join(' · ');
}

// The resolution to preselect: the viewer's last choice when it can play here, then the
// server's default, then anything that works.
export function chooseResolution(options, remembered, capabilities) {
  const list = (options && options.resolutions) || [];
  const works = (resolution) => {
    const option = list.find((o) => o.resolution === resolution);
    return !!option && streamPlan(option, capabilities).selectable;
  };
  // A remembered 1080p means the standard quality, whichever one this title offers.
  const standard = list.find((o) => o.resolution < 2160);
  for (const candidate of [
    Number(remembered) === 1080 && standard ? standard.resolution : Number(remembered),
    options && options.defaultResolution,
    ...list.map((o) => o.resolution),
  ])
    if (works(candidate)) return candidate;
  return null;
}

const resolutionKey = (userId) => `mw:stream-resolution:${userId || 'anonymous'}`;
export function rememberedResolution(userId, storage) {
  try {
    const value = Number(storage && storage.getItem(resolutionKey(userId)));
    return RESOLUTIONS.includes(value) ? value : null;
  } catch {
    return null;
  }
}
export function rememberResolution(userId, resolution, storage) {
  try {
    // 720p and SD stand in for 1080p on titles that have nothing better, so choosing
    // one is remembered as the standard quality, not as a wish for less.
    if (KNOWN_RESOLUTIONS.includes(Number(resolution)))
      storage.setItem(resolutionKey(userId), String(Number(resolution) >= 2160 ? 2160 : 1080));
  } catch {}
}

// Start-up and buffering progress for a status from the events stream.
// stage: sources → connecting → buffering → playing (or failed / stopped).
export function startupView(status, { elapsedMs = 0 } = {}) {
  if (!status) return { stage: 'sources', title: 'Finding sources', detail: '', progress: null };
  const peers = Number(status.peers) || 0;
  const speed = status.downloadSpeed ? formatSpeed(status.downloadSpeed) : '';
  const live = [plural(peers, 'peer'), speed].filter(Boolean).join(' · ');
  const state = status.state;
  if (state === 'failed')
    return { stage: 'failed', title: status.message, detail: '', progress: null };
  if (state === 'stopped')
    return { stage: 'stopped', title: status.message || 'Stopped', detail: '', progress: null };
  if (status.conversion && status.conversion.state === 'ready' && state !== 'buffering')
    return { stage: 'playing', title: 'Playing', detail: live, progress: 1 };
  if (state === 'finding-peers') {
    const trying = (status.attempts || []).filter((a) => a.state === 'trying').length;
    const slow = elapsedMs >= 10000;
    return {
      stage: 'sources',
      title: 'Finding sources',
      detail: slow
        ? `Still looking${trying > 1 ? ` across ${trying} releases` : ''}. Quiet releases can take up to 45 seconds.`
        : trying > 1
          ? `Trying ${trying} releases`
          : 'Looking for people sharing this release',
      progress: null,
    };
  }
  if (state === 'fetching-metadata')
    return {
      stage: 'connecting',
      title: 'Connecting',
      detail: `${live} · getting the file list`,
      progress: null,
    };
  if (state === 'probing') {
    const file = status.file;
    const target = file ? Math.min(file.size || HEAD_TAIL_BYTES, HEAD_TAIL_BYTES) : HEAD_TAIL_BYTES;
    const done = file ? Math.min(target, file.downloaded || 0) : 0;
    // The start and end of the file are in; FFprobe is reading them (or last pieces land).
    const reading = done >= target * 0.98;
    return {
      stage: 'buffering',
      title: 'Buffering',
      detail: reading
        ? `Reading the video · ${live}`
        : `${formatBytes(done)} of ${formatBytes(target)} · ${live}`,
      progress: Math.min(0.95, (done / target) * 0.95),
    };
  }
  if (state === 'buffering') {
    const ahead = Number(status.buffer && status.buffer.convertedAheadSeconds) || 0;
    return {
      stage: 'buffering',
      title: 'Buffering',
      detail: live,
      progress: Math.min(1, ahead / 6),
    };
  }
  // ready (warm) or starting: FFmpeg is producing the first segment.
  return { stage: 'buffering', title: 'Starting playback', detail: live, progress: 0.97 };
}

// "The first choice had no peers, switched to HMAX · FLUX."
export function fallbackNote(status) {
  const fallback = status && status.fallback;
  if (!fallback || !fallback.to) return '';
  const to = fallback.to;
  const name = [to.service, to.group].filter(Boolean).join(' · ') || formatBytes(to.sizeBytes);
  return `The first choice was slow to answer, so this plays a different copy (${name}).`;
}

// A plain-words explanation and the next steps for a failure. `context`:
// { resolution, other: { resolution, available }, canDownload, guardMessage,
//   ownOthers (this player's other sessions), compatible (already transcoding) }.
// Action ids: retry, compatibility, other-resolution, download, stop-others, close.
export function failureView(reason, message, context = {}) {
  const other = context.other && context.other.available ? context.other.resolution : null;
  const switchTo = other
    ? [{ id: 'other-resolution', label: `Try ${resolutionLabel(other)}`, resolution: other }]
    : [];
  const download =
    context.canDownload === false ? [] : [{ id: 'download', label: 'Download instead' }];
  const retry = [{ id: 'retry', label: 'Try again' }];
  switch (reason) {
    case 'vpn':
      return {
        title: 'Connect the VPN to stream',
        body:
          context.guardMessage ||
          message ||
          'Streaming waits for the VPN so peers never see this server’s address.',
        actions: [{ id: 'retry', label: 'Check again' }, ...download],
      };
    case 'unavailable':
      return {
        title: `No ${resolutionLabel(context.resolution)} release right now`,
        body: unavailableNote(message, resolutionLabel(context.resolution)),
        actions: [...switchTo, ...download],
      };
    // Every release at this quality was checked and is another film with the same name.
    case 'wrong-film':
      return {
        title: 'Only a different film is available',
        body:
          message || 'The releases listed at this quality are a different film with the same name.',
        actions: [...switchTo, ...download],
      };
    case 'no-peers':
    case 'no-release':
      return {
        title: 'Nobody is sharing this right now',
        body: 'None of the releases answered in time. This often changes within a few minutes.',
        actions: [...retry, ...switchTo, ...download],
      };
    case 'disk':
      return {
        title: 'Not enough free space to stream',
        body: message || 'The server needs more free disk space for this stream.',
        actions: [
          ...(other && other < (context.resolution || 0)
            ? [
                {
                  id: 'other-resolution',
                  label: `Try ${resolutionLabel(other)} (smaller)`,
                  resolution: other,
                },
              ]
            : []),
          ...retry,
        ],
      };
    // Only this player's own sessions may be stopped from here; other devices keep playing.
    case 'limit':
      return context.ownOthers
        ? {
            title: 'Too many streams at once',
            body: 'This device still holds other streams. Stop them to start this one; your other devices keep playing.',
            actions: [{ id: 'stop-others', label: 'Stop the others on this device' }, ...retry],
          }
        : {
            title: 'Too many streams at once',
            body: 'Your other devices are using all of this account’s streams. Stop playback on one of them, then try again.',
            actions: [...retry, ...download],
          };
    // The video did not play here (decoder or player error). Converting it on the server
    // for this device is the next step, unless that is what just failed.
    case 'playback':
      return {
        title: 'This video did not play on this device',
        body: context.compatible
          ? 'Even the converted version did not play. Try again, or download it instead.'
          : 'Compatibility playback converts it on the server for this device. It starts a little slower.',
        actions: [
          ...(context.compatible
            ? []
            : [{ id: 'compatibility', label: 'Use compatibility playback' }]),
          ...retry,
          ...switchTo,
          ...download,
        ],
      };
    case 'stopped':
      return {
        title: 'The stream stopped',
        body: message && message !== 'Stopped' ? message : 'The server closed this stream.',
        actions: [{ id: 'retry', label: 'Resume' }, ...switchTo, ...download],
      };
    case 'permission':
      return {
        title: 'This account cannot stream',
        body: 'Ask an administrator to allow downloads for your account.',
        actions: [{ id: 'close', label: 'Back' }],
      };
    default:
      return {
        title: 'Playback could not start',
        body: message || 'Something went wrong while starting the stream.',
        actions: [...retry, ...switchTo, ...download],
      };
  }
}

// The machine-readable cause of a failed status or a refused request.
export function failureReason(statusOrError) {
  if (!statusOrError) return 'failed';
  if (statusOrError.error && typeof statusOrError.error === 'object')
    return statusOrError.error.reason || 'failed';
  return statusOrError.reason || 'failed';
}
