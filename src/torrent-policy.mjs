import { fail } from './store.mjs';

export const defaultRules = Object.freeze({
  minSeeders: 5,
  movieMaxGB: 100,
  episodeMaxGB: 15,
  resolutions: [1080, 2160],
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
  const name = String(stream.name || '').slice(0, 200);
  const seed = /(?:👤\s*|seeders?\s*[:=]?\s*)(\d+)/i.exec(label);
  const size = /(?:💾\s*)?(\d+(?:\.\d+)?)\s*(GB|GiB|MB|MiB)\b/i.exec(label);
  const resolution = /(?:^|[^a-z0-9])(480|720|1080|2160)p(?:$|[^a-z0-9])/i.exec(`${label} ${name}`);
  return {
    label,
    name,
    seeders: seed ? Number(seed[1]) : null,
    sizeBytes: Number.isFinite(stream.behaviorHints?.videoSize)
      ? stream.behaviorHints.videoSize
      : size
        ? Math.round(Number(size[1]) * (/^g/i.test(size[2]) ? 1073741824 : 1048576))
        : null,
    resolution: resolution
      ? Number(resolution[1])
      : /\b4k\b/i.test(`${label} ${name}`)
        ? 2160
        : null,
  };
}
export const requiredResolution = (kind) => (kind === 'movie' ? 2160 : 1080);
export const qualityRule = (kind) =>
  kind === 'movie' ? 'YTS only · 2160p WEB-DL movies' : 'YTS only · 1080p WEB-DL episodes';

export function assessQuality(release, kind) {
  const label = `${release.label || ''} ${release.name || ''}`;
  const reasons = [];
  if (!/(?:^|[^a-z0-9])YTS(?:$|[^a-z0-9])/i.test(label)) reasons.push('YTS releases only');
  if (release.resolution !== requiredResolution(kind))
    reasons.push(
      `${requiredResolution(kind)}p required for ${kind === 'movie' ? 'movies' : 'anime and TV shows'}`,
    );
  const labelResolution = releaseFacts(release).resolution;
  if (labelResolution != null && labelResolution !== requiredResolution(kind))
    reasons.push('Release label does not match the required resolution');
  const filenameResolution = releaseFacts({ label: release.filename }).resolution;
  if (filenameResolution != null && filenameResolution !== requiredResolution(kind))
    reasons.push('Actual filename does not match the required resolution');
  if (!/(?:^|[^a-z0-9])WEB[ ._-]*DL(?:$|[^a-z0-9])/i.test(label))
    reasons.push('WEB-DL required for movies, anime and TV shows');
  if (
    /(?:^|[^a-z0-9])(?:WEB[ ._-]*RIP|BLU[ ._-]*RAY|BD[ ._-]*RIP|BR[ ._-]*RIP|HDTV|DVD[ ._-]*RIP)(?:$|[^a-z0-9])/i.test(
      `${label} ${release.filename || ''}`,
    )
  )
    reasons.push('Release source conflicts with the required WEB-DL source');
  return { accepted: !reasons.length, reasons };
}
export function assessRelease(release, kind, rules) {
  const reasons = [...assessQuality(release, kind).reasons];
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
    resolutions: [...defaultRules.resolutions],
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
        rules.resolutions.length !== 2 ||
        ![1080, 2160].every((n) => rules.resolutions.includes(n))
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
