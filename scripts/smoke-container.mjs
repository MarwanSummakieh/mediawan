// Pipe this file to Node inside the built image; it uses only ephemeral container data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const server = spawn(process.execPath, ['server.mjs'], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: '8787',
    LAN_PORT: '0',
    MEDIAWAN_DB: '/tmp/mediawan-smoke.sqlite',
    ADMIN_EMAIL: 'smoke@example.test',
    ADMIN_PASSWORD: 'container-fixture-only',
    REAL_DEBRID_TOKEN: '',
  },
});
const exited = once(server, 'exit');
const base = 'http://127.0.0.1:8787';
try {
  let health;
  for (let attempt = 0; attempt < 30; attempt++) {
    health = await fetch(base + '/healthz').catch(() => null);
    if (health?.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(health?.ok, 'server health');
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/app.bundle.js')).status, 200);
  assert.equal((await fetch(base + '/api/home')).status, 401);
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'smoke@example.test', password: 'container-fixture-only' }),
  });
  assert.equal(login.status, 200);
  const home = await fetch(base + '/api/home', {
    headers: { Cookie: login.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal(home.status, 200);
  assert.deepEqual((await home.json()).continueWatching, []);
  console.log('Container smoke passed: boot, static assets, authentication and library.');
} finally {
  server.kill('SIGTERM');
  await exited;
}
