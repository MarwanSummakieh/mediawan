import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindLiveCast } from '../public/live-cast.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(t, overrides = {}) {
  const previous = globalThis.window;
  t.after(() => {
    globalThis.window = previous;
  });
  const events = new Map(),
    requests = [];
  let started = 0,
    resumed = 0,
    ended = 0,
    mediaInfo,
    controller;
  const receiver = {
    getCastDevice: () => ({ friendlyName: 'Living room Chromecast' }),
    getMediaSession: () => (mediaInfo ? { media: mediaInfo } : null),
    loadMedia: async ({ media }) => {
      mediaInfo = media;
    },
    endSession: () => {
      ended++;
    },
  };
  const context = {
    requestSession: async () => {},
    getCurrentSession: () => receiver,
    addEventListener: (name, callback) => events.set(name, callback),
    removeEventListener: (name) => events.delete(name),
  };
  globalThis.window = {
    cast: {
      framework: {
        SessionState: { SESSION_ENDED: 'ended' },
        CastContextEventType: { SESSION_STATE_CHANGED: 'session' },
        RemotePlayerEventType: { ANY_CHANGE: 'change' },
        RemotePlayer: class {
          isPaused = false;
        },
        RemotePlayerController: class {
          constructor(player) {
            this.player = player;
            controller = this;
          }
          addEventListener(name, callback) {
            this.callback = callback;
          }
          removeEventListener() {
            this.callback = null;
          }
          playOrPause() {
            this.player.isPaused = !this.player.isPaused;
            this.callback?.();
          }
        },
      },
    },
    chrome: {
      cast: {
        media: {
          MediaInfo: class {
            constructor(contentId, contentType) {
              Object.assign(this, { contentId, contentType });
            }
          },
          GenericMediaMetadata: class {},
          LoadRequest: class {
            constructor(media) {
              this.media = media;
            }
          },
          StreamType: { LIVE: 'LIVE' },
          HlsSegmentFormat: { TS: 'TS' },
          HlsVideoSegmentFormat: { MPEG2_TS: 'MPEG2_TS' },
        },
      },
    },
  };
  const button = {},
    stopButton = { hidden: true },
    pauseButton = { hidden: true },
    status = {};
  const casting = bindLiveCast({
    session: { id: 'stream', lease: 'browser-lease', channel: { name: 'Sports One' } },
    button,
    stopButton,
    pauseButton,
    status,
    origin: 'https://media.example',
    prepare: async () => context,
    request: async (...args) => {
      requests.push(args);
      return { lease: 'receiver-token', url: '/cast/live/stream/index.m3u8?token=receiver-token' };
    },
    onStart: () => {
      started++;
    },
    onStop: () => {
      resumed++;
    },
    ...overrides,
  });
  await tick();
  return {
    casting,
    button,
    stopButton,
    pauseButton,
    status,
    receiver,
    context,
    events,
    requests,
    state: () => ({ started, resumed, ended, mediaInfo, controller }),
  };
}

test('sports casting loads live TS HLS, transfers playback, controls the TV and revokes access on stop', async (t) => {
  const f = await fixture(t);
  assert.equal(f.button.disabled, false);
  await f.button.onclick();
  assert.equal(f.casting.active, true);
  const { mediaInfo } = f.state();
  assert.equal(
    mediaInfo.contentId,
    'https://media.example/cast/live/stream/index.m3u8?token=receiver-token',
  );
  assert.equal(mediaInfo.streamType, 'LIVE');
  assert.equal(mediaInfo.hlsVideoSegmentFormat, 'MPEG2_TS');
  assert.equal(mediaInfo.metadata.title, 'Sports One');
  assert.equal(f.state().started, 1);
  assert.equal(f.stopButton.hidden, false);
  f.pauseButton.onclick();
  assert.equal(f.pauseButton.textContent, 'Play on TV');
  assert.match(f.status.textContent, /Paused on Living room/);
  f.stopButton.onclick();
  await tick();
  assert.equal(f.casting.active, false);
  assert.equal(f.state().ended, 1);
  assert.equal(f.state().resumed, 1);
  assert.deepEqual(f.requests.at(-1), [
    '/api/live/sessions/stream',
    { lease: 'receiver-token' },
    'DELETE',
  ]);
  await f.casting.close();
  assert.equal(f.events.size, 0);
});

test('cancelling discovery keeps local playback and does not issue receiver access', async (t) => {
  const f = await fixture(t);
  f.context.requestSession = async () => {
    throw 'cancel';
  };
  await f.button.onclick();
  assert.equal(f.casting.active, false);
  assert.equal(f.state().started, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.status.textContent, 'Casting cancelled.');
  await f.casting.close();
});

test('failed receiver load revokes its grant and keeps browser playback', async (t) => {
  const f = await fixture(t);
  f.receiver.loadMedia = async () => {
    throw Error('receiver unavailable');
  };
  await f.button.onclick();
  assert.equal(f.casting.active, false);
  assert.equal(f.state().started, 0);
  assert.equal(f.requests.at(-1)[2], 'DELETE');
  assert.match(f.status.textContent, /Could not cast/);
  await f.casting.close();
});

test('disconnecting the TV resumes local playback without ending another receiver session', async (t) => {
  const f = await fixture(t);
  await f.button.onclick();
  f.events.get('session')({ sessionState: 'ended' });
  await tick();
  assert.equal(f.casting.active, false);
  assert.equal(f.state().resumed, 1);
  assert.equal(f.state().ended, 0);
  await f.casting.close();
});

test('closing the player during device discovery never starts a cast', async (t) => {
  const f = await fixture(t);
  let connect;
  f.context.requestSession = () =>
    new Promise((resolve) => {
      connect = resolve;
    });
  const loading = f.button.onclick();
  await f.casting.close();
  connect();
  await loading;
  assert.equal(f.requests.length, 0);
  assert.equal(f.state().started, 0);
});
