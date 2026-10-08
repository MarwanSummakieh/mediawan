import path from 'node:path';

const number = (value, fallback, min = 0) =>
  Number.isFinite(Number(value)) && value !== '' && Number(value) >= min ? Number(value) : fallback;
export function configuration(env = process.env) {
  return {
    port: number(env.PORT, 8787, 1),
    lanPort: number(env.LAN_PORT, 8788),
    host: env.HOST || '0.0.0.0',
    database: path.resolve(env.MEDIAWAN_DB || 'data/mediawan-v2.sqlite'),
    media: path.resolve(env.LIBRARY_DIR || 'media/library'),
    runtime: path.resolve(env.TRANSCODE_DIR || '.runtime'),
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
  };
}
