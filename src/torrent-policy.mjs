import { fail } from './store.mjs';

export const defaultRules = Object.freeze({
  minSeeders: 5,
  movieMaxGB: 100,
  episodeMaxGB: 15,
  resolutions: [720, 1080, 2160],
  rejectUnknown: true,
  metadataMinutes: 3,
  stallMinutes: 10,
  maxConcurrent: 2,
  uploadKBps: 1024,
  seedRatio: 1,
  seedMinutes: 60,
});

export function releaseFacts(stream) {
  const label = String(stream.title || stream.label || stream.name || '').slice(0, 600);
  const seed = /(?:👤\s*|seeders?\s*[:=]?\s*)(\d+)/i.exec(label);
  const size = /(?:💾\s*)?(\d+(?:\.\d+)?)\s*(GB|GiB|MB|MiB)\b/i.exec(label);
  const resolution = /\b(480|720|1080|2160)p\b/i.exec(`${stream.name || ''} ${label}`);
  return {
    label,
    seeders: seed ? Number(seed[1]) : null,
    sizeBytes: Number.isFinite(stream.behaviorHints?.videoSize)
      ? stream.behaviorHints.videoSize
      : size
        ? Math.round(Number(size[1]) * (/^g/i.test(size[2]) ? 1073741824 : 1048576))
        : null,
    resolution: resolution ? Number(resolution[1]) : /\b4k\b/i.test(label) ? 2160 : null,
  };
}
export function assessRelease(release, kind, rules) {
  const reasons = [];
  if (
    /(?:^|[\s._\[\]()-])(cam|hdcam|camrip|hdts|hdtc|ts|tsrip|telesync|telecine|tc|dvdscr|screener|predvd|hdcamrip)(?:$|[\s._\[\]()-])/i.test(
      release.label,
    )
  )
    reasons.push('CAM / screener release');
  if (/(?:\s-\s|[\[(])(?:sample|trailer|teaser|prologue)\b/i.test(release.label))
    reasons.push('Preview clip, not a full release');
  if (/\bNOT[\s._-]+THE[\s._-]+[^\r\n]*\b(?:FILM|MOVIE)\b/i.test(release.label))
    reasons.push('Release explicitly identifies a different film');
  if (release.seeders == null) {
    if (rules.rejectUnknown) reasons.push('Seeder count unknown');
  } else if (release.seeders < rules.minSeeders)
    reasons.push(`Fewer than ${rules.minSeeders} reported seeders`);
  if (release.resolution == null) {
    if (rules.rejectUnknown) reasons.push('Resolution unknown');
  } else if (!rules.resolutions.includes(release.resolution))
    reasons.push('Resolution outside your rules');
  if (release.sizeBytes == null) {
    if (rules.rejectUnknown) reasons.push('File size unknown');
  } else if (
    release.sizeBytes <= 0 ||
    release.sizeBytes > (kind === 'movie' ? rules.movieMaxGB : rules.episodeMaxGB) * 1073741824
  )
    reasons.push('Above your file-size limit');
  return { accepted: !reasons.length, reasons };
}
export function createTorrentPolicy(store) {
  const get = () => ({
    ...defaultRules,
    ...JSON.parse(store.one("SELECT json FROM settings WHERE key='torrentRules'")?.json || '{}'),
  });
  return {
    get,
    set(input) {
      const rules = { ...get(), ...input };
      const bounds = {
        minSeeders: [0, 10000],
        movieMaxGB: [0.1, 1000],
        episodeMaxGB: [0.1, 1000],
        metadataMinutes: [1, 30],
        stallMinutes: [1, 120],
        maxConcurrent: [1, 4],
        uploadKBps: [16, 102400],
        seedRatio: [0, 10],
        seedMinutes: [0, 1440],
      };
      if (Object.keys(input).some((k) => !(k in defaultRules))) fail(400, 'Unknown torrent rule');
      for (const [key, [min, max]] of Object.entries(bounds))
        if (
          typeof rules[key] !== 'number' ||
          !Number.isFinite(rules[key]) ||
          rules[key] < min ||
          rules[key] > max
        )
          fail(400, `Invalid ${key}`);
      if (
        ![
          rules.minSeeders,
          rules.maxConcurrent,
          rules.uploadKBps,
          rules.metadataMinutes,
          rules.stallMinutes,
          rules.seedMinutes,
        ].every(Number.isInteger)
      )
        fail(400, 'Counts and minutes must be whole numbers');
      if (
        typeof rules.rejectUnknown !== 'boolean' ||
        !Array.isArray(rules.resolutions) ||
        !rules.resolutions.length ||
        rules.resolutions.some((n) => ![480, 720, 1080, 2160].includes(n))
      )
        fail(400, 'Invalid quality rules');
      store.run(
        "INSERT INTO settings VALUES('torrentRules',?) ON CONFLICT(key) DO UPDATE SET json=excluded.json",
        JSON.stringify(rules),
      );
      return rules;
    },
  };
}
