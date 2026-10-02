import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { validateWatchMedia } from '../lib/watch-together.mjs';

const source = await readFile(new URL('../public/watch-together.js', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ saved, path = '/', initialMedia = null, farSeek = false } = {}) {
  let now = 100_000, timerId = 0, responder;
  const timers = new Map(), elements = new Map(), requests = [], navigations = [], seeks = [], starts = [];
  class Element {
    constructor(id) {
      this.id = id; this.hidden = false; this.disabled = false; this.dataset = {}; this.value = '';
      this.textContent = ''; this.children = []; this.attributes = {}; this.events = new Map(); this.isConnected = true;
      const classes = new Set();
      this.classList = {
        contains: name => classes.has(name), add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        toggle: (name, value) => { const on = value === undefined ? !classes.has(name) : value; on ? classes.add(name) : classes.delete(name); return on; },
      };
    }
    addEventListener(type, callback) { if (!this.events.has(type)) this.events.set(type, []); this.events.get(type).push(callback); }
    emit(type, options = {}) { for (const fn of this.events.get(type) || []) fn({ target: this, preventDefault() {}, stopImmediatePropagation() {}, ...options }); }
    setAttribute(name, value) { this.attributes[name] = value; }
    appendChild(child) { this.children.push(child); }
    focus() { document.activeElement = this; }
    select() {}
    querySelectorAll() { return []; }
  }
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const speedButtons = [new Element('speed1'), new Element('speed2')];
  const forms = [new Element('playerJoin'), new Element('lobbyJoin')];
  forms.forEach(form => { form.elements = { code: { value: '' } }; });
  const document = {
    activeElement: get('initialFocus'), hidden: false, body: { style: {} }, documentElement: get('html'),
    getElementById: get, createElement: tag => new Element(tag),
    querySelectorAll: selector => selector === '#speedList button' ? speedButtons :
      selector === '[data-watch-join]' ? forms : selector === '[data-watch-join] button' ? [get('join1'), get('join2')] : [],
    addEventListener() {},
  };
  const video = new Element('video');
  video.paused = true; video.currentTime = 0; video.readyState = 3; video.ended = false;
  let rate = 1;
  Object.defineProperty(video, 'playbackRate', { get: () => rate, set(value) { rate = value; this.emit('ratechange'); } });
  video.pause = () => { if (!video.paused) { video.paused = true; video.emit('pause'); } };
  video.play = () => {
    if (video.rejectPlay) return Promise.reject(new Error('autoplay blocked'));
    video.paused = false; video.emit('play'); video.emit('playing'); return Promise.resolve();
  };
  const player = {
    el: get('player'), video, meta: { anilistId: 1, title: 'Anime' }, ep: '1', mode: 'sub',
    movieMode: false, _track: null, quality: {}, tShift: 0, _jumping: false, casting: false,
    curT() { return video.currentTime + this.tShift; }, durT() { return 1_000; },
    seekTo(time) { seeks.push(time); if (farSeek) this._jumping = true; else video.currentTime = time - this.tShift; },
    _resumeFor() { return 700; }, async _trackResume() { return 700; },
    play(ep, resume) {
      this.ep = String(ep); this.resumeAt = resume; this.quality = null; video.readyState = 0;
      starts.push({ kind: 'anime', ep, resume });
      const pending = this.nextResolution; this.nextResolution = null; return pending || Promise.resolve();
    },
    async launchStream(options) {
      this.movieMode = true; this._track = options.track; this.meta = { title: options.title, anilistId: null };
      this.quality = null; video.readyState = 0;
      await this.playStream({ seek: await this._trackResume(), resume: true });
    },
    playStream(options) {
      starts.push({ kind: this._track.kind, ...options });
      const pending = this.nextResolution; this.nextResolution = null; return pending || Promise.resolve();
    },
    _onStreamReady(at, wasPlaying) { video.currentTime = at; video.readyState = 3; this.quality = {}; if (wasPlaying) this._attemptPlay(); },
    _attemptPlay() { return video.play(); },
    togglePlay() { if (video.paused) this._attemptPlay(); else video.pause(); },
    nudge(delta) { this.seekTo(this.curT() + delta); }, next() { this.play(Number(this.ep) + 1, 0); },
    prev() { this.play(Number(this.ep) - 1, 0); }, switchMode(mode) { this.mode = mode; return this.play(this.ep, this.curT()); },
    playNextSeason() {}, showUpNext() { this.upNextShown = true; }, hideUpNext() { this.upNextShown = false; },
    toggleCast() { this.casting = !this.casting; },
    hide() { this._closing = true; video.pause(); this.el.classList.remove('show'); this.quality = null; this._track = null; this._closing = false; },
    _menuOpen() { return false; }, hideMenus() {}, buildSpeedMenu() {}, poke() {}, syncPlayIcon() {},
    toggleMenu(selector) { const menu = get(selector.slice(1)); const opening = menu.hidden; this.hideMenus(); menu.hidden = !opening; },
  };
  if (initialMedia) {
    player.el.classList.add('show');
    if (initialMedia.kind === 'anime') {
      player.meta = { anilistId: Number(initialMedia.id), title: initialMedia.title };
      player.ep = initialMedia.episode; player.mode = initialMedia.mode || 'sub';
    } else {
      player.movieMode = true; player._track = clone(initialMedia); player.meta = { title: initialMedia.title };
    }
  }
  get('watchMenu').hidden = true;
  const location = { origin: 'https://mediawan.test', pathname: '', search: '' };
  function setPath(value) { const url = new URL(value, location.origin); location.pathname = url.pathname; location.search = url.search; }
  setPath(path);
  const storage = new Map(saved ? [['mw.watchTogether', JSON.stringify(saved)]] : []);
  const sessionStorage = { getItem: name => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, value), removeItem: name => storage.delete(name) };
  const window = { Player: player, addEventListener() {}, nav(value) {
    navigations.push(value); setPath(value); window.WatchTogether.onRoute();
    let match;
    player.el.classList.add('show');
    if ((match = location.pathname.match(/^\/watch\/([^/]+)\/([^/]+)/))) {
      player.movieMode = false; player._track = null;
      player.meta = { anilistId: Number(match[1]), title: 'Anime' };
      player.mode = new URLSearchParams(location.search).get('mode') || 'sub';
      player.play(decodeURIComponent(match[2]), player._resumeFor(match[2]));
    } else if ((match = location.pathname.match(/^\/moviewatch\/([^/]+)/))) {
      player.launchStream({ track: { kind: 'movie', id: decodeURIComponent(match[1]) }, title: 'Movie' });
    } else if ((match = location.pathname.match(/^\/tvwatch\/([^/]+)\/([^/]+)\/([^/]+)/))) {
      player.launchStream({ track: { kind: 'tv', id: match[1], season: Number(match[2]), episode: Number(match[3]) }, title: 'Episode' });
    } else player.hide();
  } };
  const clock = { now: () => now };
  const credentials = (host = false, code = 'ABCDEFGH') => ({ room: room({ code }), memberId: host ? 'host' : 'viewer', memberToken: host ? 'host-token' : 'viewer-token' });
  function room({ code = 'ABCDEFGH', hostId = 'host', media = { kind: 'anime', id: '1', episode: '1', mode: 'sub', title: 'Anime' }, state = {} } = {}) {
    return { code, hostId, media, members: [{ id: 'host', name: 'Host' }, { id: 'viewer', name: 'Guest' }],
      state: { position: 20, paused: true, rate: 1, updatedAt: now, revision: 1, ...state }, serverTime: now };
  }
  responder = req => {
    if (req.path.endsWith('/leave')) return { ok: true };
    if (req.path.endsWith('/join')) return credentials();
    if (req.path === '') return { ...credentials(true), room: room({ media: req.body.media, state: req.body.state }) };
    if (req.path.endsWith('/state')) return { room: room({ media: req.body.media, state: req.body.state }) };
    return { room: room() };
  };
  const context = vm.createContext({
    window, document, sessionStorage, location, navigator: { clipboard: { writeText: async () => {} } },
    URLSearchParams, AbortController, Date: clock, console,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) {
      const req = { path: url.replace('/api/watch-together', ''), body: options.body ? JSON.parse(options.body) : undefined, token: options.headers['X-Watch-Member'], method: options.method };
      requests.push(req);
      const response = await responder(req);
      return { ok: !response.status || response.status < 400, status: response.status || 200, json: async () => clone(response.data ?? response) };
    },
  });
  vm.runInContext(source, context);
  return {
    watch: window.WatchTogether, player, video, get, requests, navigations, seeks, starts, storage, speedButtons,
    room, credentials, setResponder(fn) { responder = fn; },
    async join(code = 'ABCDEFGH') { forms[0].elements.code.value = code; forms[0].emit('submit'); await flush(); },
    async ready(at = 0, autoplay = true) { player._onStreamReady(at, autoplay); await flush(); },
    async advance(ms) {
      now += ms;
      const due = [...timers].filter(([, value]) => value.at <= now).sort((a, b) => a[1].at - b[1].at);
      for (const [id, value] of due) if (timers.delete(id)) value.callback();
      await flush();
    },
  };
}

test('installing room hooks preserves ordinary playback and saved resume behavior', async () => {
  const h = fixture({ initialMedia: { kind: 'anime', id: '1', episode: '1', title: 'Anime' } });
  await h.watch.init();
  assert.equal(h.player._resumeFor('1'), 700);
  assert.equal(await h.player._trackResume(), 700);
  h.player.togglePlay(); assert.equal(h.video.paused, false);
  h.player.nudge(10); assert.equal(h.player.curT(), 10);
  h.player.showUpNext(); assert.equal(h.player.upNextShown, true);
  h.player.toggleCast(); assert.equal(h.player.casting, true);
  assert.equal(h.requests.length, 0);
});

test('movie and TV room snapshots contain only valid catalog fields', async () => {
  for (const media of [
    { kind: 'movie', id: 'tt1234567', title: 'Movie', cover: 'https://example.test/poster' },
    { kind: 'tv', id: 'tt1234567', title: 'Show', season: 2, episode: 3, cover: 'https://example.test/poster' },
  ]) {
    const h = fixture({ initialMedia: media });
    await h.watch.init(); await h.get('watchCreate').onclick();
    const sent = h.requests[0].body.media;
    assert.doesNotThrow(() => validateWatchMedia(sent));
    assert.equal(sent.cover, undefined);
    if (media.kind === 'tv') assert.equal(sent.episode, '3');
    h.watch.leave();
  }
});

test('a guest resumes on the shared absolute transcode clock and cannot control the host', async () => {
  const h = fixture();
  h.setResponder(req => req.path.endsWith('/join') ? { ...h.credentials(), room: h.room({ state: { position: 150, paused: false, rate: 1.5 } }) } : { room: h.room() });
  await h.watch.init(); await h.join();
  assert.equal(h.starts[0].resume, 150);
  h.player.tShift = 100;
  await h.ready(0);
  assert.equal(h.player.curT(), 150);
  assert.equal(h.video.currentTime, 50);
  assert.equal(h.video.paused, false);
  assert.equal(h.video.playbackRate, 1.5);
  assert.equal(h.get('pPlay').disabled, true);
  const seekCount = h.seeks.length;
  h.player.togglePlay(); h.player.nudge(10); h.player.next(); h.player.showUpNext();
  assert.equal(h.seeks.length, seekCount);
  assert.equal(h.video.paused, false);
  assert.equal(h.player.upNextShown, undefined);
  h.watch.leave(); assert.equal(h.get('pPlay').disabled, false);
  h.player.togglePlay(); assert.equal(h.video.paused, true);
});

test('a guest with a sub-only fallback stays synchronized without repeated navigation', async () => {
  const h = fixture();
  const snapshot = () => h.room({ media: { kind: 'anime', id: '1', episode: '1', mode: 'dub', title: 'Anime' }, state: { position: 80 } });
  h.setResponder(req => req.path.endsWith('/join') ? { ...h.credentials(), room: snapshot() } : { room: snapshot() });
  await h.watch.init(); await h.join();
  h.player.mode = 'sub'; await h.ready();
  await h.advance(1_000); await h.advance(1_000);
  assert.equal(h.navigations.length, 1);
  assert.equal(h.player.curT(), 80);
  assert.equal(h.watch.guest(), true);
});

test('a restored host opens the server title and inherits a paused clock before publishing', async () => {
  const h = fixture({ saved: { code: 'ABCDEFGH', memberId: 'host', memberToken: 'host-token' } });
  const media = { kind: 'movie', id: 'tt1234567', title: 'Movie' };
  h.setResponder(req => req.path.endsWith('/state') ? { room: h.room({ media: req.body.media, state: req.body.state }) } :
    { room: h.room({ media, state: { position: 200, paused: false, rate: 1.25, updatedAt: 98_000 } }) });
  await h.watch.init(); await flush();
  assert.deepEqual(h.navigations, ['/moviewatch/tt1234567']);
  assert.equal(h.starts[0].seek, 202.5);
  await h.advance(1_000);
  assert.equal(h.requests.some(req => req.path.endsWith('/state')), false);
  await h.ready();
  assert.equal(h.player.curT(), 202.5);
  assert.equal(h.video.paused, true);
  assert.equal(h.video.playbackRate, 1.25);
  await h.advance(80);
  const sent = h.requests.find(req => req.path.endsWith('/state'));
  assert.equal(sent.body.state.position, 202.5);
  assert.equal(sent.body.state.paused, true);
  assert.equal(sent.token, 'host-token');
});

test('host transfer inherits the server clock instead of a stale guest position', async () => {
  const media = { kind: 'anime', id: '1', episode: '1', mode: 'sub', title: 'Anime' };
  const h = fixture({ initialMedia: media });
  let transferred = false;
  h.setResponder(req => {
    if (req.path.endsWith('/join')) return h.credentials();
    if (req.path.endsWith('/state')) return { room: h.room({ hostId: 'viewer', state: req.body.state }) };
    return { room: h.room({ hostId: transferred ? 'viewer' : 'host', state: { position: 123, rate: 1.5 } }) };
  });
  await h.watch.init(); await h.join();
  h.video.currentTime = 3; transferred = true;
  await h.advance(1_000);
  assert.equal(h.watch.guest(), false);
  assert.equal(h.player.curT(), 123);
  assert.equal(h.video.paused, true);
  await h.advance(80);
  assert.equal(h.requests.find(req => req.path.endsWith('/state')).body.state.position, 123);
});

test('leaving cancels pending room creation or joining and releases late memberships', async () => {
  for (const operation of ['create', 'join']) {
    const h = fixture({ initialMedia: { kind: 'anime', id: '1', episode: '1', title: 'Anime' } });
    const pending = deferred();
    h.setResponder(req => req.path.endsWith('/leave') ? { ok: true } : pending.promise);
    await h.watch.init();
    const work = operation === 'create' ? h.get('watchCreate').onclick() : h.join();
    await flush(); h.watch.leave();
    pending.resolve(h.credentials(operation === 'create'));
    await work; await flush();
    assert.equal(h.storage.has('mw.watchTogether'), false);
    assert.equal(h.get('pTogether').textContent, 'Watch together');
    assert.equal(h.requests.filter(req => req.path.endsWith('/leave')).length, 1);
    assert.equal(h.get('watchCreate').disabled, false);
  }
});

test('leaving during saved-session restore cannot resurrect that room', async () => {
  const h = fixture({ saved: { code: 'ABCDEFGH', memberId: 'host', memberToken: 'host-token' } });
  const pending = deferred(); h.setResponder(() => pending.promise);
  const init = h.watch.init();
  await flush(); h.watch.leave(); pending.resolve({ room: h.room() });
  await init;
  assert.equal(h.storage.has('mw.watchTogether'), false);
  assert.equal(h.navigations.length, 0);
});

test('host far seeks publish the requested absolute target while a transcode restart is pending', async () => {
  const h = fixture({ initialMedia: { kind: 'anime', id: '1', episode: '1', title: 'Anime' }, farSeek: true });
  h.video.currentTime = 30; h.video.paused = false;
  await h.watch.init(); await h.get('watchCreate').onclick();
  h.player.seekTo(600);
  assert.equal(h.player.curT(), 30);
  assert.equal(h.player._jumping, true);
  await h.advance(80);
  const sent = h.requests.find(req => req.path.endsWith('/state'));
  assert.equal(sent.body.state.position, 600);
  assert.equal(sent.body.state.paused, false);
});

test('a late poll from a previous room cannot replace or block the new room', async () => {
  const h = fixture(); const pending = deferred();
  h.setResponder(req => req.path.endsWith('/join') ? h.credentials(false, req.path.split('/')[1]) :
    req.path.endsWith('/leave') ? { ok: true } : pending.promise);
  await h.watch.init(); await h.join(); await h.ready();
  await h.advance(1_000);
  h.watch.leave();
  h.setResponder(req => req.path.endsWith('/join') ? h.credentials(false, 'JKLMNPQR') :
    req.path.endsWith('/leave') ? { ok: true } : { room: h.room({ code: 'JKLMNPQR', state: { position: 77 } }) });
  await h.join('JKLMNPQR');
  pending.resolve({ room: h.room({ state: { position: 999 } }) }); await flush();
  await h.advance(1_000);
  assert.equal(h.get('watchRoomCode').textContent, 'JKLMNPQR');
  assert.equal(h.player.curT(), 77);
  assert.equal(h.requests.at(-1).path, '/JKLMNPQR');
});

test('room episode changes wait for an active resolver before launching the latest episode', async () => {
  const h = fixture(); const pending = deferred();
  h.player.nextResolution = pending.promise;
  let ep = '1';
  h.setResponder(req => req.path.endsWith('/join') ? h.credentials() : {
    room: h.room({ media: { kind: 'anime', id: '1', episode: ep, mode: 'sub', title: 'Anime' } }),
  });
  await h.watch.init(); await h.join();
  ep = '2'; await h.advance(1_000);
  ep = '3'; await h.advance(1_000);
  assert.equal(h.navigations.length, 1);
  pending.resolve(); await flush();
  assert.deepEqual(h.navigations, ['/watch/1/1?mode=sub', '/watch/1/3?mode=sub']);
});

test('a mode change arriving during loading is followed after the earlier stream becomes ready', async () => {
  const h = fixture(); const pending = deferred();
  h.player.nextResolution = pending.promise;
  h.setResponder(req => req.path.endsWith('/join') ? h.credentials() : {
    room: h.room({ media: { kind: 'anime', id: '1', episode: '1', mode: 'dub', title: 'Anime' } }),
  });
  await h.watch.init(); await h.join(); await h.advance(1_000);
  await h.ready(); pending.resolve(); await flush();
  assert.deepEqual(h.navigations, ['/watch/1/1?mode=sub', '/watch/1/1?mode=dub']);
});

test('autoplay refusal offers an explicit start action without taking host control', async () => {
  const h = fixture();
  h.setResponder(req => req.path.endsWith('/join') ? { ...h.credentials(), room: h.room({ state: { paused: false } }) } : { room: h.room() });
  await h.watch.init(); await h.join(); h.video.rejectPlay = true; await h.ready();
  assert.equal(h.get('watchStart').hidden, false);
  assert.match(h.get('watchFeedback').textContent, /Start playback/);
  h.video.rejectPlay = false; h.get('watchStart').onclick(); await flush();
  assert.equal(h.video.paused, false);
  assert.equal(h.get('watchStart').hidden, true);
  assert.equal(h.get('pPlay').disabled, true);
});
