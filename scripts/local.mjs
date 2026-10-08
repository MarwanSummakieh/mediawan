// Real downloads on this PC, isolated from both the synthetic preview and production data.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { configuration } from '../src/config.mjs';
import { createApplication } from '../src/app.mjs';

const saved = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
const environment = { ...saved, ...process.env };
const qbit = existsSync('.runtime/local/qbittorrent.json')
  ? JSON.parse(readFileSync('.runtime/local/qbittorrent.json', 'utf8'))
  : {};
const config = {
  ...configuration({
    ADMIN_EMAIL: environment.ADMIN_EMAIL,
    ADMIN_PASSWORD: environment.ADMIN_PASSWORD,
    REAL_DEBRID_TOKEN: environment.REAL_DEBRID_TOKEN,
    FFMPEG_PATH: environment.FFMPEG_PATH,
    FFPROBE_PATH: environment.FFPROBE_PATH,
  }),
  host: '127.0.0.1',
  port: 8800,
  lanPort: 0,
  database: path.resolve('.runtime/local/mediawan.sqlite'),
  media: path.resolve('media/local-test'),
  runtime: path.resolve('.runtime/local/hls'),
  qbitUrl: environment.QBIT_URL || qbit.url || '',
  qbitUsername: environment.QBIT_USERNAME || qbit.username || '',
  qbitPassword: environment.QBIT_PASSWORD || qbit.password || '',
  qbitSavePath: '/downloads',
  torrentDir: path.resolve('media/local-test/torrents'),
};
const application = createApplication(config);
const server = application.app.listen(config.port, config.host, () => {
  application.start();
  console.log('Local Mediawan: http://127.0.0.1:8800');
  console.log(`Downloaded files: ${config.media}`);
  console.log(`Real-Debrid: ${config.debridToken ? 'configured' : 'missing REAL_DEBRID_TOKEN'}`);
  console.log(`Direct torrents: ${config.qbitUrl ? 'configured' : 'not configured'}`);
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await application.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
