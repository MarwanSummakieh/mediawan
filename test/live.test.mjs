import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { parseM3u } from '../src/live/catalog.mjs';
import { parseXmltv, matchGuide, xmltvTime } from '../src/live/guide.mjs';
import { dailyEvents, validateEvent } from '../src/live/events.mjs';
import { privateIp, openLiveStream } from '../src/live/fetch.mjs';
import { rewriteManifest, liveArgs, isHlsManifest } from '../src/live/playback.mjs';
import { createLiveStore } from '../src/live/store.mjs';
import { createStore } from '../src/store.mjs';
import { createApplication } from '../src/app.mjs';
import { configuration } from '../src/config.mjs';
import { hashPassword } from '../src/auth.mjs';

const playlist =
  '#EXTM3U\n#EXTINF:-1 tvg-id="sport1" tvg-language="en" group-title="Sports",Sports One HD\nhttps://provider.example/live/private-user/private-secret/1.ts\n#EXTINF:-1 tvg-id="sport2" tvg-language="ar" group-title="Sports",Sports Two HD\nhttps://provider.example/live/private-user/private-secret/2.ts';
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
function guideXml(start = Date.now()) {
  return `<tv><channel id="sport1"><display-name>Sports One</display-name></channel><channel id="sport2"><display-name>Sports Two</display-name></channel>${['sport1', 'sport2'].map((c) => `<programme channel="${c}" start="${stamp(start)}" stop="${stamp(start + 7200000)}"><title>North FC vs Coast FC</title><category>Football</category><desc>Premier League</desc></programme>`).join('')}</tv>`;
}
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mediawan-live-'));
  const config = {
    ...configuration({}),
    database: path.join(root, 'test.sqlite'),
    liveDir: path.join(root, 'live-tv'),
    runtime: path.join(root, 'runtime'),
    adminEmail: 'admin@example.test',
    adminPassword: 'fixture-password',
  };
  const cleanup = () =>
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  return { root, config, cleanup };
}
async function listening(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return server;
}
async function login(base, email = 'admin@example.test') {
  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'fixture-password' }),
  });
  assert.equal(res.status, 200);
  return {
    Cookie: res.headers.get('set-cookie').split(';')[0],
    'Content-Type': 'application/json',
  };
}

test('daily schedule groups broadcasts and handles local midnight, DST, status and missing channels', () => {
  const channels = parseM3u(playlist).channels;
  const start = Date.parse('2026-10-24T22:30:00Z'),
    now = start + 3600000;
  const guide = parseXmltv(guideXml(start), { now });
  const matches = matchGuide(channels, guide);
  const args = { timezone: 'Europe/Copenhagen', now };
  assert.equal(dailyEvents(channels, matches, [], { ...args, date: '2026-10-24' }).length, 0);
  const result = dailyEvents(channels, matches, [], { ...args, date: '2026-10-25' });
  assert.equal(result.length, 1);
  assert.equal(result[0].channels.length, 2);
  assert.equal(result[0].sport, 'Football');
  assert.equal(result[0].status, 'live');
  assert.equal(
    dailyEvents(channels, matches, [], { ...args, now: start - 1, date: '2026-10-25' })[0].status,
    'upcoming',
  );
  assert.equal(
    dailyEvents(channels, matches, [], { ...args, now: start + 7200000, date: '2026-10-25' })[0]
      .status,
    'finished',
  );
  const manual = [
    {
      id: 'manual',
      title: 'Night race',
      sport: 'Motorsport',
      start: Date.parse('2026-10-25T22:30:00Z'),
      end: Date.parse('2026-10-26T01:30:00Z'),
      channelIds: ['removed-channel'],
    },
  ];
  assert.equal(dailyEvents(channels, new Map(), manual, { ...args, date: '2026-10-25' }).length, 1);
  assert.equal(
    dailyEvents(channels, new Map(), manual, { ...args, date: '2026-10-26' })[0].channels.length,
    0,
  );
  assert.throws(
    () => dailyEvents(channels, matches, [], { ...args, date: '2026-02-30' }),
    /valid date/,
  );
  assert.throws(
    () =>
      dailyEvents(channels, matches, [], { ...args, date: '2026-10-25', timezone: 'Invalid/Zone' }),
    /time zone/,
  );
  assert(!JSON.stringify(result).includes('private-secret'));
});

test('XMLTV parsing and daily schedule exclude placeholders, news, highlights and replays', () => {
  const channels = parseM3u(playlist).channels,
    now = Date.now();
  const guide = parseXmltv(guideXml(now), { now });
  for (const title of ['Sports One HD', 'Football highlights', 'Football replay', 'Sports news'])
    guide.programmes.push({
      ...guide.programmes[0],
      title,
      competitions: [],
      replay: /replay/i.test(title),
    });
  const events = dailyEvents(channels, matchGuide(channels, guide), [], {
    date: new Date(now).toISOString().slice(0, 10),
    timezone: 'UTC',
    now,
  });
  assert.equal(events.length, 1);
  assert.equal(xmltvTime('20261009020000 +0200'), Date.parse('2026-10-09T00:00:00Z'));
  assert.equal(xmltvTime('20260230020000 +0200'), null);
  assert.throws(
    () => parseXmltv('<!DOCTYPE tv [<!ENTITY secret SYSTEM "file:///secret">]><tv/>'),
    /entities/,
  );
  assert.throws(() => parseXmltv('<tv><programme></tv>'), /valid XMLTV/);
  assert.throws(
    () =>
      validateEvent(
        {
          title: 'Match',
          sport: 'Football',
          start: '2026-10-09T20:00Z',
          end: '2026-10-09T19:00Z',
          channelIds: [],
        },
        channels,
      ),
    /end time/,
  );
});

test('old private live-TV configuration loads, failed refresh retains schedule, manual events persist', async (t) => {
  const { config, cleanup } = fixture(),
    store = createStore(config.database),
    now = Date.now();
  mkdirSync(config.liveDir, { recursive: true });
  writeFileSync(
    path.join(config.liveDir, 'catalog.json'),
    JSON.stringify({
      ...parseM3u(playlist),
      maxConnections: 1,
      guideUrl: 'https://provider.example/guide?secret=private-secret',
      guideStatus: 'ready',
      guideUpdatedAt: new Date(now).toISOString(),
    }),
  );
  writeFileSync(
    path.join(config.liveDir, 'guide.json'),
    JSON.stringify(parseXmltv(guideXml(now), { now })),
  );
  const live = createLiveStore(store, config, {
    fetchResource: async () => {
      throw Error('offline');
    },
  });
  t.after(async () => {
    await live.close();
    store.close();
    cleanup();
  });
  const query = { date: new Date(now).toISOString().slice(0, 10), timezone: 'UTC' };
  assert.equal((await live.schedule(query)).events[0].channels.length, 2);
  assert.equal((await live.refresh()).guideStatus, 'stale');
  assert.deepEqual(
    (await Promise.all([live.refresh(), live.refresh()])).map((s) => s.guideStatus),
    ['stale', 'stale'],
  );
  assert.equal((await live.schedule(query)).events.length, 1);
  const value = {
    title: 'Added fixture',
    sport: 'Tennis',
    competition: 'Test cup',
    start: new Date(now).toISOString(),
    end: new Date(now + 3600000).toISOString(),
    channelIds: [(await live.channels())[0].id],
  };
  const event = await live.saveEvent(value);
  const reopened = createLiveStore(store, config);
  assert.equal(
    (await reopened.schedule(query)).events.find((e) => e.id === event.id).title,
    'Added fixture',
  );
  await reopened.saveEvent({ ...value, title: 'Updated fixture' }, event.id);
  assert.equal(
    (await live.schedule(query)).events.find((e) => e.id === event.id).title,
    'Updated fixture',
  );
  reopened.deleteEvent(event.id);
  assert.equal((await live.schedule(query)).events.length, 1);
  await reopened.close();
});

test('provider resources reject private addresses and manifest rewrite hides every upstream URI', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.1.1',
    '172.20.0.1',
    '100.64.0.1',
    '::1',
    '::ffff:7f00:1',
    'fc00::1',
  ])
    assert(privateIp(ip), ip);
  assert.equal(privateIp('8.8.8.8'), false);
  assert.equal(privateIp('2606:4700:4700::1111'), false);
  for (const url of ['http://127.0.0.1/secret', 'http://[::1]/secret', 'file:///secret'])
    await assert.rejects(openLiveStream(url));
  const manifest = rewriteManifest(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key?secret=hidden"\n#EXT-X-MAP:URI="init.mp4"\nsegment.ts?secret=hidden',
    'https://provider.example/path/index.m3u8',
    () => '/opaque-resource',
  );
  assert(!manifest.includes('hidden'));
  assert(!manifest.includes('provider.example'));
  assert.equal(
    isHlsManifest(
      Buffer.from('#EXTM3U\n#EXTINF:2'),
      'text/plain',
      'https://provider.example/stream.php',
    ),
    true,
  );
  assert.equal(
    isHlsManifest(Buffer.from([0x47, 0, 0, 0]), 'video/mp2t', 'https://provider.example/stream.ts'),
    false,
  );
  assert.equal((manifest.match(/opaque-resource/g) || []).length, 3);
  assert(liveArgs('http://loopback/source').includes('8'));
  assert(!liveArgs('http://loopback/source').includes('-hls_playlist_type'));
});

test('sports API requires login, restricts management, validates events and never returns provider secrets', async (t) => {
  const { config, cleanup } = fixture();
  const application = createApplication(config, {
      live: {
        fetchResource: async () => {
          throw Error('fixture offline');
        },
      },
    }),
    server = await listening(application.app),
    base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await application.close();
    cleanup();
  });
  assert.equal((await fetch(base + '/api/sports')).status, 401);
  const headers = await login(base);
  const res = await fetch(base + '/api/admin/live/import', {
    method: 'POST',
    headers,
    body: JSON.stringify({ playlist, guideUrl: '' }),
  });
  assert.equal(res.status, 200);
  // Disable discovered guide immediately; tests do not require a real provider.
  await fetch(base + '/api/admin/live', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ guideUrl: '' }),
  });
  const body = await (await fetch(base + '/api/live/channels', { headers })).text();
  assert(!body.includes('private-secret'));
  assert(!body.includes('provider.example'));
  const channelId = JSON.parse(body).items[0].id,
    now = Date.now();
  const event = {
    title: 'Example FC vs Sample FC',
    sport: 'Football',
    competition: 'Fixture cup',
    start: new Date(now).toISOString(),
    end: new Date(now + 7200000).toISOString(),
    channelIds: [channelId],
  };
  assert.equal(
    (
      await fetch(base + '/api/admin/sports/events', {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await fetch(base + '/api/admin/sports/events', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...event, channelIds: ['bogus'] }),
      })
    ).status,
    400,
  );
  assert.equal(
    (await fetch(base + '/api/sports?timezone=Bad/Zone&date=2026-10-09', { headers })).status,
    400,
  );
  const schedule = await (await fetch(base + '/api/sports', { headers })).json();
  assert.equal(schedule.events.length, 1);
  application.store.run(
    'INSERT INTO users(email,name,pw_hash,role) VALUES(?,?,?,?)',
    'viewer@example.test',
    'Viewer',
    hashPassword('fixture-password'),
    'member',
  );
  const viewerHeaders = await login(base, 'viewer@example.test');
  assert.equal((await fetch(base + '/api/sports', { headers: viewerHeaders })).status, 200);
  for (const [method, url, input] of [
    ['POST', '/api/admin/sports/events', event],
    ['PATCH', '/api/admin/live', { maxConnections: 4 }],
    ['POST', '/api/admin/live/import', { playlist }],
    ['DELETE', '/api/admin/sports/events/anything', {}],
  ]) {
    assert.equal(
      (await fetch(base + url, { method, headers: viewerHeaders, body: JSON.stringify(input) }))
        .status,
      403,
    );
  }
  assert.equal(
    (await fetch(base + '/api/live/sessions/unknown/index.m3u8?lease=unknown', { headers })).status,
    404,
  );
});

for (const sourceType of ['mpegts', 'hls-ts', 'hls-mp4'])
  test(
    `real live FFmpeg ${sourceType} playback shares one stream, enforces limits and authenticates media and cleanup`,
    { timeout: 45000 },
    async (t) => {
      const { root, config, cleanup } = fixture(),
        video = path.join(root, sourceType === 'mpegts' ? 'fixture.ts' : 'fixture.m3u8');
      execFileSync(
        config.ffmpeg,
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=0x354638:s=320x180:r=24',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=220:sample_rate=44100',
          '-t',
          '60',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-g',
          '48',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          ...(sourceType === 'mpegts'
            ? ['-f', 'mpegts']
            : [
                '-f',
                'hls',
                '-hls_time',
                '2',
                '-hls_list_size',
                '0',
                ...(sourceType === 'hls-mp4' ? ['-hls_segment_type', 'fmp4'] : []),
              ]),
          video,
        ],
        { windowsHide: true, cwd: root },
      );
      const bytes = readFileSync(video);
      const requested = [];
      const providerStarted = Date.now();
      const provider = await listening(
        http.createServer((req, res) => {
          requested.push(req.url);
          if (sourceType !== 'mpegts') {
            const file = new URL(req.url, 'http://fixture').pathname.slice(1);
            // A plain-text PHP endpoint and nested variant exercise manifest sniffing.
            if (file === 'stream.php') {
              res.writeHead(200, { 'Content-Type': 'text/plain' });
              res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nfixture.m3u8?secret=hidden\n');
            } else if (file === 'fixture.m3u8') {
              res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
              const available = 8 + Math.floor((Date.now() - providerStarted) / 500);
              res.end(
                bytes
                  .toString()
                  .replace('#EXT-X-ENDLIST', '')
                  .replace(/#EXTINF:[^\n]+\nfixture(\d+)\.(?:ts|m4s)\r?\n/g, (entry, index) =>
                    Number(index) < available ? entry : '',
                  ),
              );
            } else if (/^(fixture\d+\.(ts|m4s)|init\.mp4)$/.test(file)) {
              const content = readFileSync(path.join(root, file));
              res.setHeader('Content-Type', file.endsWith('.ts') ? 'video/mp2t' : 'video/mp4');
              res.setHeader('Content-Length', content.length);
              res.end(content);
            } else res.writeHead(404).end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'video/mp2t' });
          let offset = 0;
          const timer = setInterval(() => {
            const chunk = bytes.subarray(offset, offset + 188 * 35);
            offset += chunk.length;
            if (chunk.length) res.write(chunk);
            else {
              clearInterval(timer);
              res.end();
            }
          }, 40);
          res.on('close', () => clearInterval(timer));
        }),
      );
      const application = createApplication(config, {
        livePlayback: {
          openStream: async (url, { signal }) => {
            const resource =
              sourceType === 'mpegts'
                ? '/fixture'
                : url.includes('/live/')
                  ? '/stream.php'
                  : new URL(url).pathname + new URL(url).search;
            const response = await new Promise((resolve, reject) => {
              const req = http.get(
                `http://127.0.0.1:${provider.address().port}${resource}`,
                { signal },
                resolve,
              );
              req.on('error', reject);
            });
            return { response, url: `https://provider.example${resource}` };
          },
        },
      });
      const server = await listening(application.app),
        base = `http://127.0.0.1:${server.address().port}`;
      t.after(async () => {
        await application.close();
        await new Promise((r) => server.close(r));
        await new Promise((r) => provider.close(r));
        cleanup();
      });
      await application.live.importPlaylist(playlist);
      const headers = await login(base),
        channels = await application.live.channels();
      const start = async (channel) =>
        fetch(base + `/api/live/channels/${channel}/play`, { method: 'POST', headers, body: '{}' });
      const firstResponse = await start(channels[0].id);
      assert.equal(firstResponse.status, 200);
      const first = await firstResponse.json(),
        second = await (await start(channels[0].id)).json();
      if (sourceType !== 'mpegts') {
        assert(requested.includes('/stream.php'));
        assert(requested.includes('/fixture.m3u8?secret=hidden'));
        assert(requested.some((url) => /fixture\d+\.(ts|m4s)$/.test(url)));
        if (sourceType === 'hls-mp4') assert(requested.includes('/init.mp4'));
      }
      assert.equal(second.id, first.id);
      assert.notEqual(first.lease, second.lease);
      assert.equal(application.livePlayback.active(), 1);
      assert.equal((await start(channels[1].id)).status, 409);
      assert.equal((await fetch(base + first.url)).status, 401);
      const manifest = await (await fetch(base + first.url, { headers })).text();
      assert.match(manifest, /#EXTINF:/);
      assert(!manifest.includes('private-secret'));
      assert.match(manifest, /lease=/);
      const segment = manifest.split('\n').find((line) => /^segment-/.test(line));
      assert.equal(
        (await fetch(base + `/api/live/sessions/${first.id}/${segment}`, { headers })).status,
        200,
      );
      assert.equal(
        (await fetch(base + `/api/live/sessions/${first.id}/index.m3u8?lease=wrong`, { headers }))
          .status,
        404,
      );
      const castPath = `/api/live/sessions/${first.id}/cast`;
      assert.equal(
        (
          await fetch(base + castPath, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lease: first.lease }),
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await fetch(base + castPath, {
            method: 'POST',
            headers,
            body: JSON.stringify({ lease: 'wrong' }),
          })
        ).status,
        404,
      );
      const cast = await (
        await fetch(base + castPath, {
          method: 'POST',
          headers,
          body: JSON.stringify({ lease: first.lease }),
        })
      ).json();
      assert.match(cast.lease, /^[a-f0-9]{64}$/);
      const castResponse = await fetch(base + cast.url, {
        headers: { Origin: 'https://www.gstatic.com' },
      });
      assert.equal(castResponse.status, 200);
      assert.equal(castResponse.headers.get('access-control-allow-origin'), '*');
      assert.equal(castResponse.headers.get('cache-control'), 'no-store');
      const castManifest = await castResponse.text();
      assert.match(castManifest, /token=/);
      assert(!castManifest.includes('private-secret'));
      const castSegment = castManifest.split('\n').find((line) => /^segment-/.test(line));
      const segmentResponse = await fetch(base + `/cast/live/${first.id}/${castSegment}`, {
        headers: { Range: 'bytes=0-187' },
      });
      assert.equal(segmentResponse.status, 206);
      assert.equal((await segmentResponse.arrayBuffer()).byteLength, 188);
      assert.equal(
        (await fetch(base + `/cast/live/${first.id}/index.m3u8?token=${first.lease}`)).status,
        404,
      );
      assert.equal(
        (await fetch(base + `/cast/live/${first.id}/index.m3u8?token=wrong`)).status,
        404,
      );
      assert.equal(
        (await fetch(base + `/cast/live/${first.id}/catalog.json?token=${cast.lease}`)).status,
        404,
      );
      assert.equal(
        (
          await fetch(base + cast.url, {
            method: 'OPTIONS',
            headers: {
              Origin: 'https://www.gstatic.com',
              'Access-Control-Request-Headers': 'Range',
            },
          })
        ).status,
        204,
      );
      const rotated = await (
        await fetch(base + castPath, {
          method: 'POST',
          headers,
          body: JSON.stringify({ lease: first.lease }),
        })
      ).json();
      assert.equal((await fetch(base + cast.url)).status, 404);
      const originalNow = Date.now;
      let expired;
      try {
        Date.now = () => originalNow() + 6 * 60 * 60 * 1000 + 1;
        expired = application.livePlayback.media(
          { params: { id: first.id, file: 'index.m3u8' }, query: { token: rotated.lease } },
          {},
          true,
        );
      } finally {
        Date.now = originalNow;
      }
      await assert.rejects(expired, /Live cast ended/);
      application.store.run('UPDATE users SET active=0 WHERE email=?', 'admin@example.test');
      assert.equal((await fetch(base + rotated.url)).status, 404);
      application.store.run('UPDATE users SET active=1 WHERE email=?', 'admin@example.test');
      await fetch(base + `/api/live/sessions/${first.id}`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ lease: first.lease }),
      });
      assert.equal(application.livePlayback.active(), 1);
      await fetch(base + `/api/live/sessions/${second.id}`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ lease: second.lease }),
      });
      // The TV fetches independently after the sender tab closes.
      assert.equal(application.livePlayback.active(), 1);
      assert.equal((await fetch(base + rotated.url)).status, 200);
      await fetch(base + `/api/live/sessions/${first.id}`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ lease: rotated.lease }),
      });
      assert.equal(application.livePlayback.active(), 0);
      assert.equal((await fetch(base + rotated.url)).status, 404);
    },
  );
