// Isolated, synthetic library for interface acceptance. Never reads the user's .env or database.
import path from 'node:path';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { configuration } from '../src/config.mjs';
import { createApplication } from '../src/app.mjs';
import { probe } from '../src/media.mjs';
const root = path.resolve('.runtime/preview');
mkdirSync(root, { recursive: true });
const config = {
  ...configuration({}),
  database: path.join(root, 'preview.sqlite'),
  media: root,
  runtime: path.join(root, 'hls'),
  adminEmail: 'preview@mediawan.test',
  adminPassword: 'mediawan-preview-only',
  port: 8799,
  lanPort: 0,
  host: '127.0.0.1',
};
const file = path.join(root, 'sample.mp4');
if (!existsSync(file))
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x354638:s=640x360:r=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:sample_rate=44100',
      '-t',
      '120',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      file,
    ],
    { windowsHide: true },
  );
const application = createApplication(config);
const { store, history } = application,
  user = store.one('SELECT * FROM users');
const metadata = await probe(file, config);
if (!store.one('SELECT id FROM titles LIMIT 1')) {
  for (const [index, name] of [
    'The Quiet Coast',
    'Northern Light',
    'A Place Between',
    'Sunday in October',
    'The Long Way Home',
    'Small Hours',
  ].entries()) {
    const title = store.saveTitle({
      kind: index % 2 ? 'movie' : 'tv',
      external_id: `fixture-${index}`,
      name,
      year: String(2021 + (index % 5)),
      genres: ['Drama'],
      description:
        'A synthetic title used to verify library navigation, episode queues and local playback. The media is a generated test clip.',
    });
    for (let n = 1; n <= (title.kind === 'movie' ? 1 : 6); n++) {
      const item = store.saveItem({
        title_id: title.id,
        season: title.kind === 'movie' ? 0 : n > 3 ? 2 : 1,
        episode: title.kind === 'movie' ? 0 : n > 3 ? n - 3 : n,
        name:
          title.kind === 'movie'
            ? name
            : [
                'An arrival',
                'Low tide',
                'After the rain',
                'Turning point',
                'At first light',
                'A way home',
              ][n - 1],
      });
      const destination = path.join(root, `${index}-${n}.mp4`);
      copyFileSync(file, destination);
      store.addAsset({ item_id: item.id, path: destination, bytes: 1, probe: metadata });
      if ((index === 0 && n === 2) || index === 1) {
        const session = history.start(user, item.id);
        history.event(user, session.id, {
          seq: 1,
          type: 'pause',
          position: index === 1 ? 45 : 30,
          duration: 120,
        });
      }
      if (index === 2 && n === 1) {
        const session = history.start(user, item.id);
        history.event(user, session.id, { seq: 1, type: 'ended', position: 120, duration: 120 });
      }
    }
  }
}
application.app.listen(config.port, config.host, () =>
  console.log('Isolated preview: http://127.0.0.1:8799'),
);
