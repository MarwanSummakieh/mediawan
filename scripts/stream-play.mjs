// Streams one torrent file to a local player while it downloads, fetching the pieces
// the player asks for first so seeking works.
//   node scripts/stream-play.mjs [imdbId] [season] [episode] [1080|2160]
//   node scripts/stream-play.mjs --magnet "<magnet uri>"
// Refuses to start without a VPN network interface unless --no-vpn-check is given.
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import WebTorrent from 'webtorrent';
import { releaseFacts, defaultRules } from '../src/torrent-policy.mjs';
import { rankReleases, assessStream } from '../src/release-score.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? null : args.splice(at, name === '--magnet' ? 2 : 1)[1] || true;
};
const magnetArg = flag('--magnet');
const skipVpnCheck = flag('--no-vpn-check');
const [imdb = 'tt11198330', season = '1', episode = '1', resolutionArg = '1080'] = args;
const cacheDir = resolve(process.env.STREAM_CACHE_DIR || '.runtime/stream-cache');
const gb = (bytes) => (bytes / 1073741824).toFixed(2) + ' GB';

const vpn = Object.keys(networkInterfaces()).find((name) =>
  /nordlynx|nordvpn|wireguard|openvpn|^wg\d|^tun\d|^tap\d/i.test(name),
);
if (!vpn && !skipVpnCheck) {
  console.error(
    'No VPN network interface found. Connect the VPN first; your address is visible to every peer otherwise.\n' +
      'Pass --no-vpn-check only for content you are free to share.',
  );
  process.exit(1);
}
console.log(vpn ? `VPN interface: ${vpn}` : 'VPN check skipped');

async function chooseRelease() {
  const key = encodeURIComponent(`${imdb}:${season}:${episode}`);
  const base = process.env.TORRENTIO_BASE || 'https://torrentio.strem.fun';
  const response = await fetch(`${base}/stream/series/${key}.json`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Release lookup failed (HTTP ${response.status})`);
  const resolution = Number(resolutionArg);
  const releases = ((await response.json()).streams || [])
    .filter((s) => /^[a-f0-9]{40}$/i.test(s.infoHash || ''))
    .map((s) => ({
      hash: s.infoHash.toLowerCase(),
      fileIndex: Number.isInteger(s.fileIdx) ? s.fileIdx : null,
      filename: s.behaviorHints?.filename || '',
      trackers: (s.sources || []).filter((x) => x.startsWith('tracker:')).map((x) => x.slice(8)),
      ...releaseFacts(s),
    }))
    .filter((release) => assessStream(release, 'tv', defaultRules, resolution).accepted);
  const pick = rankReleases(releases, 'tv')[0];
  if (!pick) throw new Error('No release passes the rules');
  const { release } = pick;
  console.log(`Release: ${release.filename || release.label.split('\n')[0]}`);
  console.log(`         score ${pick.score}, ${release.seeders} seeders, ${gb(release.sizeBytes)}`);
  return {
    magnet: `magnet:?xt=urn:btih:${release.hash}`,
    trackers: release.trackers,
    fileIndex: release.fileIndex,
  };
}

// Many listings carry no tracker list, and trackerless discovery alone is slow or fails,
// so every stream also announces to these open trackers.
const openTrackers = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'http://tracker.opentrackr.org:1337/announce',
];
const target = magnetArg
  ? { magnet: magnetArg, trackers: [], fileIndex: null }
  : await chooseRelease();
const client = new WebTorrent();
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  await new Promise((done) => client.destroy(done));
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
}
process.on('SIGINT', () => close(0));
client.on('error', (error) => {
  console.error(`Torrent error: ${error.message}`);
  close(1);
});

console.log('Finding peers...');
const metadataTimer = setTimeout(() => {
  console.error('No peers answered within 3 minutes.');
  close(2);
}, 180000);
const announce = [...new Set([...target.trackers, ...openTrackers])];
const searching = setInterval(
  () => console.log(`  still searching, ${pending.numPeers} peers connected`),
  5000,
);
const pending = client.add(target.magnet, { path: cacheDir, announce }, (torrent) => {
  clearTimeout(metadataTimer);
  clearInterval(searching);
  const video = /\.(mkv|mp4|m4v|webm|avi)$/i;
  const file =
    (target.fileIndex != null && torrent.files[target.fileIndex]) ||
    torrent.files.filter((f) => video.test(f.name)).sort((a, b) => b.length - a.length)[0];
  if (!file) {
    console.error('The torrent contains no video file.');
    return close(2);
  }
  torrent.deselect(0, torrent.pieces.length - 1, false);
  for (const other of torrent.files) other.deselect();
  file.select();
  const instance = client.createServer();
  instance.server.listen(Number(process.env.STREAM_PORT || 0), '127.0.0.1', () => {
    const url = `http://127.0.0.1:${instance.server.address().port}${file.streamURL}`;
    console.log(`Playing: ${file.name} (${gb(file.length)})`);
    console.log(`Stream:  ${url}`);
    const player = [
      process.env.STREAM_PLAYER,
      'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
      'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
      'C:\\Program Files\\mpv\\mpv.exe',
    ].find((path) => path && existsSync(path));
    if (player) spawn(player, [url], { detached: true, stdio: 'ignore' }).unref();
    else
      console.log('No player found. Open the stream address in VLC (Media > Open Network Stream).');
    console.log('Press Ctrl+C to stop and delete the temporary files.\n');
    setInterval(() => {
      const speed = (torrent.downloadSpeed / 1048576).toFixed(1);
      console.log(
        `  ${(file.progress * 100).toFixed(1)}% buffered, ${speed} MB/s, ${torrent.numPeers} peers`,
      );
    }, 5000).unref();
  });
});
