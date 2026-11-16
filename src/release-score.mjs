// Ranks releases that already pass the hard rules in torrent-policy.mjs, so the same
// kind of file is chosen every time: an untouched WEB-DL from a known service, playable
// without conversion, and the same release group for the rest of a season.
import { assessRelease } from './torrent-policy.mjs';

const SERVICES = ['HMAX', 'MAX', 'AMZN', 'NF', 'DSNP', 'ATVP', 'HULU', 'PCOK', 'PMTP', 'CR'];
const token = (word) => new RegExp(`(?:^|[^a-z0-9])${word}(?:$|[^a-z0-9])`, 'i');
// Below these sizes per episode a "WEB-DL" label is almost always a re-encode.
const minEpisodeBytes = { 1080: 2.5 * 1073741824, 2160: 5 * 1073741824 };
const minMovieBytes = { 1080: 4 * 1073741824, 2160: 10 * 1073741824 };
// When the runtime is known the floor follows it, so 24-minute anime episodes are not
// judged against an hour-long drama. Bits per second of an untouched service file.
const minBitrate = { 1080: 4.5e6, 2160: 9e6 };

// The torrent label can say WEB-DL while the file inside is a disc rip, a re-mux or a
// capture. torrent-policy.mjs catches WEBRip/BluRay/HDTV in the label; this also reads
// the actual filename and the tokens that policy does not know (BDMux, Remux, HDRip...).
const conflictingSource =
  /(?:^|[^a-z0-9])(?:BD[ ._-]?(?:Mux|Remux|Rip|25|50)|Blu[ ._-]?Ray|BR[ ._-]?(?:Rip|Mux)|UHD[ ._-]?BD|REMUX|WEB[ ._-]?(?:Rip|Mux|Cap)|HD[ ._-]?Rip|HDTV(?:Rip)?|PDTV|SAT[ ._-]?Rip|DSR(?:ip)?|TV[ ._-]?Rip|DVD(?:[ ._-]?(?:Rip|Mux|R|5|9|Scr))?)(?:$|[^a-z0-9])/i;
const clean = (hit) => hit[0].replace(/^[^a-z0-9]|[^a-z0-9]$/gi, '');

export function sourceConflict(release) {
  const filename = String(release.filename || '');
  const hit = conflictingSource.exec(filename);
  if (hit) return `File is a ${clean(hit)} release, not WEB-DL`;
  const label = conflictingSource.exec(String(release.label || ''));
  if (label) return `Release is ${clean(label)}, not WEB-DL`;
  return null;
}

// A film often has no genuine WEB-DL while its Blu-ray releases are plentiful, and a disc
// encode is not lower quality. Movies may therefore stream from a disc source; captures
// and re-encoded web rips stay out. Series keep WEB-DL so a season stays consistent.
const boundary = (pattern) => new RegExp(`(?:^|[^a-z0-9])(?:${pattern})(?:$|[^a-z0-9])`, 'i');
const remuxSource = boundary(
  '(?:BD[ ._-]?)?REMUX|BD[ ._-]?Mux|UNTOUCHED|BD[ ._-]?(?:25|50|66|100)',
);
const discSource = boundary(
  '(?:UHD[ ._-]?)?BD[ ._-]?Rip|Blu[ ._-]?Ray|BR[ ._-]?(?:Rip|Mux)|UHD[ ._-]?BD',
);
const poorSource = boundary(
  'WEB[ ._-]?(?:Rip|Cap)|WEB[ ._-]?DL[ ._-]?Rip|HD[ ._-]?Rip|HDTV(?:Rip)?|PDTV|SAT[ ._-]?Rip|DSR(?:ip)?|TV[ ._-]?Rip|DCP[ ._-]?Rip|DVD(?:[ ._-]?(?:Rip|Mux|R|5|9|Scr))?',
);
export function sourceOf(release) {
  const text = `${release.label || ''} ${release.filename || ''}`;
  if (poorSource.test(text)) return 'poor';
  if (remuxSource.test(text)) return 'remux';
  if (discSource.test(text)) return 'disc';
  return /(?:^|[^a-z0-9])WEB[ ._-]*DL(?:$|[^a-z0-9])/i.test(text) ? 'web-dl' : null;
}

// A different film or series can share the name: a remake, a revival, a lookalike. One
// labelled with a year outside this title's own is not this title. A film must match its
// year; a series must fall within the years it ran (`endYear`, when the catalog has it).
export function yearMismatch(release, year, { series = false, endYear = null } = {}) {
  const expected = Number(year);
  if (!(expected > 1900)) return null;
  const text = `${String(release.label || '').split('\n')[0]} ${release.filename || ''}`;
  // Not a year: a pixel size such as 1920x1080.
  const years = [...text.matchAll(/(?:^|[^0-9x])((?:19|20)\d{2})(?=$|[^0-9px])/gi)].map((m) =>
    Number(m[1]),
  );
  const last = !series ? expected : Number(endYear) >= expected ? Number(endYear) : Infinity;
  if (!years.length || years.some((y) => y >= expected - 1 && y <= last + 1)) return null;
  return series
    ? `Labelled ${years[0]}: a different series with the same name`
    : `Labelled ${years[0]}, not ${expected}: a different film`;
}

// Older series, sitcoms above all, were never released at 1080p by a streaming service:
// what exists is a Blu-ray or DVD set, a broadcast capture, or a small re-encode, often
// with no resolution on the label at all. Streaming therefore has two lower qualities,
// 720p and SD, and reads SD from the label when no resolution is given.
export const STREAM_RESOLUTIONS = [480, 720, 1080, 2160];
const sdMarker = boundary(
  '(?:360|480|540|576)[pi]|threesixtyp|SD(?:TV)?|DVD(?:[ ._-]?(?:Rip|Mux|R|5|9|Remux))?|XviD|DivX',
);
export function streamResolution(release) {
  if (STREAM_RESOLUTIONS.includes(release.resolution)) return release.resolution;
  if (release.resolution != null) return null;
  return sdMarker.test(`${release.label || ''} ${release.filename || ''}`) ? 480 : null;
}

// Streaming keeps every hard rule of the download policy except the fixed resolution per
// kind. Which sources it accepts depends on what is being asked for:
//   movies at 1080p and 4K: WEB-DL and Blu-ray;
//   series at 1080p and 4K: WEB-DL, so a season stays consistent, and Blu-ray only when
//     `relaxed` (no WEB-DL of that episode exists);
//   720p and SD: any source that is not a cinema capture, since nothing better exists.
// It also rejects another year's film, and a series labelled outside the years it ran.
export function assessStream(
  release,
  kind,
  rules,
  resolution,
  { year, endYear, relaxed = false } = {},
) {
  const lower = resolution < 1080;
  const effective = streamResolution(release);
  let { reasons } = assessRelease(
    { ...release, resolution: effective ?? release.resolution },
    kind,
    { ...rules, resolutions: STREAM_RESOLUTIONS },
    resolution,
  );
  const source = sourceOf(release);
  const disc = source === 'disc' || source === 'remux';
  if (lower || (disc && (kind === 'movie' || relaxed)))
    reasons = reasons.filter((r) => !/^WEB-DL required|^Release source conflicts/.test(r));
  else {
    const conflict = sourceConflict(release);
    if (conflict) reasons.push(conflict);
  }
  const wrongYear = yearMismatch(release, year, { series: kind !== 'movie', endYear });
  if (wrongYear) reasons.push(wrongYear);
  return { accepted: !reasons.length, reasons };
}

export function releaseTraits(release) {
  const label = String(release.label || '');
  const lines = label.split('\n');
  const filename = String(release.filename || '');
  const name = filename || lines[0] || '';
  const text = `${label} ${filename}`;
  const group = /-([A-Za-z0-9]{2,20})(?:\[[^\]]*\])?(?:\.(?:mkv|mp4))?$/.exec(name.trim());
  const dolbyVision = /(?:^|[^a-z0-9])(?:DV|DoVi|Dolby[ ._]?Vision)(?:$|[^a-z0-9])/i.test(text);
  const hdr = /(?:^|[^a-z0-9])HDR(?:10(?:\+|Plus)?)?(?:$|[^a-z0-9])/i.test(text);
  return {
    group: group ? group[1].toUpperCase() : null,
    service: SERVICES.find((s) => token(s).test(text)) || null,
    dolbyVision,
    hdr,
    dolbyVisionOnly: dolbyVision && !hdr,
    hevc: /(?:x265|HEVC|H[ .]?265)/i.test(text),
    mp4: /\.mp4$/i.test(filename),
    lossyStereo: token('AAC').test(text) && !/(?:DDP|DD\+?|EAC3|Atmos|TrueHD)/i.test(text),
    // A title in another script usually means a dub is the default audio track.
    foreignDub: /[Ѐ-ӿ]/.test(lines[0]) || /\b(?:Dub|MVO|Lektor|Dual Audio)\b/i.test(text),
    // Flags other than the English ones on the listing line mean extra dubbed tracks.
    multiAudio:
      /\bMULTi\b|Multi Audio/i.test(text) ||
      (text.match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu) || []).some((f) => f !== '🇬🇧' && f !== '🇺🇸'),
    // Named for another market: the default audio or burnt-in text is often not English.
    otherLanguage:
      /(?:^|[^a-z0-9])(?:iTA|TRUEFRENCH|FRENCH|VFF|VFQ|VF2|VOSTFR|GERMAN|LATINO|LAT|CASTELLANO|SPANISH|POLISH|PL|HINDI|NLsubs)(?:$|[^a-z0-9])/i.test(
        name,
      ),
    // Services deliver 1080p as H.264; a 1080p HEVC file labelled WEB-DL is a re-encode.
    reencoded1080: release.resolution === 1080 && /(?:x265|HEVC|H[ .]?265|10bit)/i.test(text),
    signLanguage: /\bwith ASL\b/i.test(text),
    upscaled: /\b(?:Ai[ ._-]?(?:Upscale|Enhanced)|RIFE|60fps)\b/i.test(text),
    subtitleHint: /Multi[ ._]?Subs?|\bESubs?\b|\bSubs?\b/i.test(text),
    seasonPack: release.fileIndex != null && lines.length > 2,
    source: sourceOf(release),
  };
}

// Trust comes from the release group: the "-GROUP" at the end of a scene-style name, or
// the "[Group]" at the start of an anime release. Returns the matching group or null.
const groupKey = (name) =>
  String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
export function trustedGroup(release, groups) {
  const wanted = new Set((groups || []).map(groupKey).filter(Boolean));
  if (!wanted.size) return null;
  const names = [release.filename, String(release.label || '').split('\n')[0]]
    .map((n) => String(n || '').trim())
    .filter(Boolean);
  for (const name of names) {
    const trailing = /-([A-Za-z0-9]{2,20})(?:\[[^\]]*\])?(?:\.(?:mkv|mp4))?$/.exec(name);
    const leading = /^\[([^\]]{2,30})\]/.exec(name);
    for (const hit of [trailing, leading]) if (hit && wanted.has(groupKey(hit[1]))) return hit[1];
  }
  return null;
}

function sizeFloor(release, kind, runtimeSeconds) {
  if (runtimeSeconds > 0 && minBitrate[release.resolution])
    return (runtimeSeconds * minBitrate[release.resolution]) / 8;
  return (kind === 'movie' ? minMovieBytes : minEpisodeBytes)[release.resolution];
}

// `streaming` weighs the swarm more: a stream needs pieces in order and on time, so a
// healthy swarm shortens the start and prevents stalls.
export function scoreRelease(
  release,
  kind,
  lock = null,
  { runtimeSeconds, streaming = false } = {},
) {
  const traits = releaseTraits(release);
  const parts = [];
  const add = (points, reason) => parts.push({ points, reason });
  const floor = sizeFloor(release, kind, runtimeSeconds);
  const disc = traits.source === 'disc' || traits.source === 'remux';
  if (traits.source === 'web-dl' && streaming && kind === 'movie') add(10, 'WEB-DL source');
  if (traits.source === 'disc') add(5, 'Blu-ray source');
  if (traits.source === 'remux') add(-20, 'Remux: a very large file');
  if (traits.source === 'poor') add(-10, 'Broadcast capture or re-encode');
  if (!traits.source) add(-5, 'Source not stated');
  if (floor && release.sizeBytes != null)
    add(
      release.sizeBytes >= floor ? 20 : -40,
      release.sizeBytes >= floor
        ? 'Full-bitrate size'
        : disc
          ? 'Too small for this running time'
          : 'Too small for an untouched WEB-DL',
    );
  if (traits.service) add(15, `Source service ${traits.service}`);
  if (traits.group) add(5, `Release group ${traits.group}`);
  if (release.seeders != null)
    add(
      Math.min(
        streaming ? 30 : 20,
        Math.round(Math.log2(release.seeders + 1) * (streaming ? 4 : 3)),
      ),
      `${release.seeders} seeders`,
    );
  if (streaming && release.seeders != null && release.seeders < 8)
    add(-15, 'Small swarm, slow start likely');
  if (traits.dolbyVisionOnly) add(-30, 'Dolby Vision only, wrong colours on other screens');
  if (traits.mp4) add(-10, 'MP4 container, limited subtitle tracks');
  if (traits.lossyStereo) add(-15, 'Re-encoded audio');
  if (traits.foreignDub) add(-25, 'Dubbed audio is likely the default track');
  else if (traits.otherLanguage) add(-15, 'Made for another language');
  else if (traits.multiAudio) add(-5, 'Several audio tracks');
  if (traits.reencoded1080 && !disc) add(-20, 'Re-encoded video');
  if (traits.signLanguage) add(-60, 'Sign-language overlay version');
  if (traits.upscaled) add(-50, 'Upscaled or frame-interpolated');
  if (traits.subtitleHint) add(5, 'Label mentions subtitles');
  if (traits.seasonPack) add(5, 'Season pack');
  if (lock) {
    if (lock.hash && lock.hash === release.hash) add(40, 'Same season pack as earlier episodes');
    else if (lock.group && lock.group === traits.group && lock.service === traits.service)
      add(30, 'Same group and service as earlier episodes');
  }
  return { score: parts.reduce((sum, part) => sum + part.points, 0), parts, traits };
}

export function rankReleases(releases, kind, lock = null, options = {}) {
  return releases
    .map((release) => ({ release, ...scoreRelease(release, kind, lock, options) }))
    .sort((a, b) => b.score - a.score || (b.release.seeders || 0) - (a.release.seeders || 0));
}

export const lockFrom = (ranked) =>
  ranked
    ? { hash: ranked.release.hash, group: ranked.traits.group, service: ranked.traits.service }
    : null;
