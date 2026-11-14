import path from 'node:path';

const number = (value, fallback, min = 0) =>
  Number.isFinite(Number(value)) && value !== '' && Number(value) >= min ? Number(value) : fallback;
// NordLynx (NordVPN), WireGuard, OpenVPN, ProtonVPN, Mullvad and the tun/wg devices a
// Gluetun-style VPN container creates. `*` matches any characters.
const defaultVpnInterfaces = 'nordlynx,nordvpn*,wireguard*,openvpn*,proton*,mullvad*,wg*,tun*,tap*';
export function configuration(env = process.env) {
  return {
    port: number(env.PORT, 8787, 1),
    lanPort: number(env.LAN_PORT, 8788),
    host: env.HOST || '0.0.0.0',
    database: path.resolve(env.MEDIAWAN_DB || 'data/mediawan-v2.sqlite'),
    media: path.resolve(env.LIBRARY_DIR || 'media/library'),
    runtime: path.resolve(env.TRANSCODE_DIR || '.runtime'),
    liveDir: path.resolve(
      env.LIVE_TV_DIR ||
        path.join(
          path.dirname(path.resolve(env.MEDIAWAN_DB || 'data/mediawan-v2.sqlite')),
          'live-tv',
        ),
    ),
    adminEmail: env.ADMIN_EMAIL || '',
    adminPassword: env.ADMIN_PASSWORD || '',
    secureCookie: env.COOKIE_SECURE === 'true',
    trustProxy: number(env.TRUST_PROXY, 0),
    debridToken: env.REAL_DEBRID_TOKEN || '',
    qbitUrl: env.QBIT_URL || '',
    qbitUsername: env.QBIT_USERNAME || '',
    qbitPassword: env.QBIT_PASSWORD || '',
    qbitSavePath: env.QBIT_SAVE_PATH || '/downloads',
    torrentDir: path.resolve(env.TORRENT_DIR || 'media/torrents'),
    catalogUrl: env.CINEMETA_BASE || 'https://v3-cinemeta.strem.io',
    releaseUrl: env.TORRENTIO_BASE || 'https://torrentio.strem.fun',
    reserveBytes: number(env.CACHE_RESERVE_BYTES, 21474836480),
    concurrentDownloads: Math.max(1, Math.min(4, number(env.CACHE_MAX_DOWNLOADS, 2, 1))),
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: env.FFPROBE_PATH || 'ffprobe',
    importRoots: (env.IMPORT_ROOTS || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((p) => path.resolve(p)),
    // Stream now: watch a torrent while it downloads. See docs/streaming.md.
    streamVpn: env.STREAM_VPN === 'off' ? 'off' : 'required',
    streamVpnInterfaces: (env.STREAM_VPN_INTERFACES || defaultVpnInterfaces)
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    streamMaxSessions: Math.max(1, Math.min(10, number(env.STREAM_MAX_SESSIONS, 6, 1))),
    streamCacheBytes: number(env.STREAM_CACHE_BYTES, 107374182400, 1073741824),
    streamUploadKBps: number(env.STREAM_UPLOAD_KBPS, 1024),
    streamFallbackSeconds: Math.max(2, Math.min(60, number(env.STREAM_FALLBACK_SECONDS, 6, 1))),
    streamDht: env.STREAM_DHT !== 'false',
    streamTrackers: (env.STREAM_TRACKERS || '')
      .split(',')
      .map((url) => url.trim())
      .filter((url) => /^(?:udp|https?|wss?):\/\/\S{3,300}$/i.test(url)),
  };
}
