// Dry run of the streaming selection flow. It only reads release listings and subtitle
// listings; it never contacts a torrent swarm.
//   node scripts/stream-flow.mjs [imdbId] [season] [firstEpisode-lastEpisode] [resolution]
import { releaseFacts, defaultRules } from '../src/torrent-policy.mjs';
import { rankReleases, lockFrom, assessStream } from '../src/release-score.mjs';

const [imdb = 'tt11198330', seasonArg = '1', range = '1-3', resolutionArg = '1080'] =
  process.argv.slice(2);
const season = Number(seasonArg);
const [first, last = first] = range.split('-').map(Number);
const resolution = Number(resolutionArg);
const languages = (process.env.SUBTITLE_LANGUAGES || 'eng,ara').split(',');
const releaseBase = process.env.TORRENTIO_BASE || 'https://torrentio.strem.fun';
const subtitleBase = 'https://opensubtitles-v3.strem.io/subtitles';
if (!/^tt\d+$/.test(imdb) || ![season, first, last, resolution].every(Number.isInteger)) {
  console.error('Usage: node scripts/stream-flow.mjs [imdbId] [season] [first-last] [1080|2160]');
  process.exit(1);
}

const json = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return response.json();
};
const gb = (bytes) => (bytes == null ? '?' : (bytes / 1073741824).toFixed(1) + ' GB');
// Downloads pin episodes to 1080p; streaming, like this dry run, allows either resolution.
const passes = (release) => assessStream(release, 'tv', defaultRules, resolution).accepted;

let lock = null;
let failed = 0;
console.log(
  `${imdb} season ${season}, episodes ${first}-${last}, ${resolution}p WEB-DL, subtitles ${languages.join('+')}\n`,
);
for (let episode = first; episode <= last; episode++) {
  const tag = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  const key = encodeURIComponent(`${imdb}:${season}:${episode}`);
  const [streams, subtitles] = await Promise.all([
    json(`${releaseBase}/stream/series/${key}.json`),
    json(`${subtitleBase}/series/${key}.json`).catch((error) => ({ error: error.message })),
  ]);
  const releases = (streams.streams || [])
    .filter((s) => /^[a-f0-9]{40}$/i.test(s.infoHash || ''))
    .map((s) => ({
      hash: s.infoHash.toLowerCase(),
      fileIndex: Number.isInteger(s.fileIdx) ? s.fileIdx : null,
      filename: s.behaviorHints?.filename || '',
      ...releaseFacts(s),
    }));
  const ranked = rankReleases(releases.filter(passes), 'tv', lock);
  console.log(`${tag}: ${releases.length} listed, ${ranked.length} pass the rules`);
  if (!ranked.length) {
    failed++;
    console.log('  no acceptable release\n');
    continue;
  }
  ranked.slice(0, 3).forEach((entry, index) => {
    const name = (entry.release.filename || entry.release.label.split('\n')[0]).slice(0, 90);
    console.log(
      `  ${index ? ' ' : '>'} ${String(entry.score).padStart(3)}  ${gb(entry.release.sizeBytes).padStart(8)}  ${String(entry.release.seeders).padStart(4)} seeds  ${name}`,
    );
  });
  const pick = ranked[0];
  console.log(
    `    why: ${pick.parts.map((p) => `${p.points > 0 ? '+' : ''}${p.points} ${p.reason}`).join('; ')}`,
  );
  if (subtitles.error) console.log(`    subtitles: lookup failed (${subtitles.error})`);
  else {
    const counts = languages.map(
      (l) => `${l} ${(subtitles.subtitles || []).filter((s) => s.lang === l).length}`,
    );
    console.log(`    online subtitles: ${counts.join(', ')}`);
  }
  console.log('');
  lock ||= lockFrom(pick);
}
process.exit(failed ? 2 : 0);
