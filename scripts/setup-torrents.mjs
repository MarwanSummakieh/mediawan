import path from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createQbitClient } from '../src/qbittorrent.mjs';

const root = path.resolve('.runtime/local'),
  credentials = path.join(root, 'qbittorrent.json');
const configDir = path.join(root, 'qbit-config'),
  downloads = path.resolve('media/local-test/torrents');
mkdirSync(configDir, { recursive: true });
mkdirSync(downloads, { recursive: true });
const name = 'mediawan-qbittorrent';
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
let existing;
try {
  existing = JSON.parse(docker('inspect', name))[0];
} catch {}
if (existing) {
  if (existing.Config.Labels?.['mediawan.local'] !== 'torrent-engine')
    throw Error('Container name is already in use by an unrelated service');
  if (!existing.State.Running) docker('start', name);
} else {
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'mediawan.local=torrent-engine',
    '--restart',
    'unless-stopped',
    '-e',
    'PUID=1000',
    '-e',
    'PGID=1000',
    '-e',
    'TZ=Europe/Copenhagen',
    '-e',
    'WEBUI_PORT=8801',
    '-p',
    '127.0.0.1:8801:8801',
    '--mount',
    `type=bind,source=${configDir},target=/config`,
    '--mount',
    `type=bind,source=${downloads},target=/downloads`,
    'lscr.io/linuxserver/qbittorrent@sha256:b522f9f4b769f8f36d49d22d5eb6a92e9aa18904c6a1830b1439df511ec21983',
  );
}
const url = 'http://127.0.0.1:8801';
for (let n = 0; n < 40; n++) {
  if (
    await fetch(url, { signal: AbortSignal.timeout(1000) })
      .then((r) => r.ok)
      .catch(() => false)
  )
    break;
  await new Promise((r) => setTimeout(r, 500));
}
if (!existsSync(credentials)) {
  const logs = docker('logs', name);
  const password = /temporary password[^\r\n]*:\s*(\S+)/i.exec(logs)?.[1];
  if (!password) throw Error('qBittorrent did not provide its initial login');
  const client = createQbitClient({ qbitUrl: url, qbitUsername: 'admin', qbitPassword: password });
  const permanent = randomBytes(32).toString('base64url');
  await client.call('app/setPreferences', {
    json: JSON.stringify({
      web_ui_username: 'admin',
      web_ui_password: permanent,
      bypass_local_auth: false,
      bypass_auth_subnet_whitelist_enabled: false,
      upnp: false,
      max_ratio_enabled: true,
      max_ratio: 1,
      max_seeding_time_enabled: true,
      max_seeding_time: 60,
      max_ratio_act: 0,
    }),
  });
  const check = createQbitClient({ qbitUrl: url, qbitUsername: 'admin', qbitPassword: permanent });
  await check.health();
  writeFileSync(
    credentials,
    JSON.stringify({ url, username: 'admin', password: permanent }, null, 2),
    { mode: 0o600 },
  );
}
const saved = JSON.parse(readFileSync(credentials, 'utf8'));
const status = await createQbitClient({
  qbitUrl: saved.url,
  qbitUsername: saved.username,
  qbitPassword: saved.password,
}).health();
console.log(
  `qBittorrent ${status.version} connected at ${url}. Credentials saved privately in .runtime/local/qbittorrent.json.`,
);
console.log(`Torrent download folder: ${downloads}`);
