// Stream now in the library: release choice, warm-up and the stream sheet.
// The player integration lives in player.js; contract in docs/streaming.md.
import { $, esc, api, modal, episodeLabel, icon } from './core.js';
import { clockTime } from './playback-time.js';
import {
  RESOLUTIONS,
  detectCapabilities,
  rememberDecodeFailure,
  streamPlan,
  releaseFacts,
  releaseDetail,
  resolutionLabel,
  chooseResolution,
  rememberedResolution,
  rememberResolution,
  startupView,
  failureView,
  failureReason,
} from './streaming.js';

// Sessions belong to a player instance (docs/streaming.md, Devices and players): one id
// per page load or TV app launch, sent with prepare and start.
const playerKey = (() => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  try {
    const bytes = new Uint8Array(12);
    window.crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length; i++) id += chars[bytes[i] % chars.length];
  } catch {
    id = (Math.random().toString(36) + Math.random().toString(36)).replace(/[^a-z0-9]/g, '');
  }
  return `web-${id.slice(0, 16)}`;
})();
export const playerId = () => playerKey;

let user = null,
  capabilities = null;
export function configureStreaming(account) {
  user = account;
  capabilities = detectCapabilities(window);
}
export const canStream = () => !!user?.canDownload;
export const deviceCapabilities = () => capabilities || (capabilities = detectCapabilities(window));
// The original video of this file failed to decode here: remember it for this device
// and detect again, so every later stream is planned without that codec.
export function decodeFailed(info) {
  if (rememberDecodeFailure(window, info)) capabilities = detectCapabilities(window);
}
const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
export const preferredResolution = (options) =>
  chooseResolution(options, rememberedResolution(user?.id, storage()), deviceCapabilities());
export const lastResolution = () => rememberedResolution(user?.id, storage());
export const saveResolution = (resolution) => rememberResolution(user?.id, resolution, storage());

// Options are fresh for a minute: the server answers warm requests in a few ms, but the
// sheet should render its cards in the same frame when the title page already asked.
// Older answers are still shown (and replaced) while a refresh is under way.
const optionsCache = new Map();
export function streamOptions(itemId, { refresh = false } = {}) {
  const hit = optionsCache.get(itemId);
  if (!refresh && hit && Date.now() - hit.at < 60000) return hit.promise;
  const entry = { at: Date.now(), data: hit?.data || null, promise: null };
  entry.promise = api(`/api/items/${itemId}/stream-options${refresh ? '?refresh=1' : ''}`).then(
    (data) => (entry.data = data),
  );
  entry.promise.catch(() => optionsCache.get(itemId) === entry && optionsCache.delete(itemId));
  optionsCache.set(itemId, entry);
  return entry.promise;
}
export const cachedOptions = (itemId) => optionsCache.get(itemId)?.data || null;

// A prepared session expires 60 s after it was last touched; asking again within 40 s is
// answered from this cache, after that the request also keeps the session alive.
const prepared = new Map();
export function prepareStream(itemId, resolution) {
  const key = `${itemId}:${resolution}`,
    hit = prepared.get(key);
  if (hit && Date.now() - hit.at < 40000) return hit.promise;
  const entry = {
    at: Date.now(),
    promise: api(`/api/items/${itemId}/stream/prepare`, { resolution, player: playerKey }),
  };
  entry.promise.catch(() => prepared.get(key) === entry && prepared.delete(key));
  prepared.set(key, entry);
  return entry.promise;
}
const forgetPrepared = (itemId) => {
  for (const key of [...prepared.keys()]) if (key.startsWith(`${itemId}:`)) prepared.delete(key);
};
// The player calls this when it stops a stream: the cache no longer describes a live
// session, and the page behind should not prepare the item again by itself right away.
const stoppedAt = new Map();
export function streamStopped(itemId) {
  if (!itemId) return;
  forgetPrepared(itemId);
  stoppedAt.set(itemId, Date.now());
}
const recentlyStopped = (itemId) => Date.now() - (stoppedAt.get(itemId) || 0) < 30000;

// Give the backend its head start: options, then a prepared session at the resolution
// the viewer would get. Silent: errors are shown when the viewer actually presses play.
export async function warmStream(itemId, resolution) {
  if (!canStream() || !itemId) return null;
  try {
    const options = await streamOptions(itemId);
    if (!options.canStream || !options.guard?.ok) return null;
    const chosen = resolution || preferredResolution(options);
    return chosen ? await prepareStream(itemId, chosen) : null;
  } catch {
    return null;
  }
}

// Warm on focus (remote/keyboard) or on a deliberate hover (the pointer resting half a
// second) of anything marked `data-warm="<itemId>"`. Passing over cancels it.
export function bindWarmUp(root) {
  let timer = null,
    target = null;
  const schedule = (element, delay) => {
    const warm = element?.closest?.('[data-warm]');
    if (warm === target) return;
    clearTimeout(timer);
    target = warm;
    if (warm) timer = setTimeout(() => void warmStream(warm.dataset.warm), delay);
  };
  root.addEventListener('focusin', (event) => schedule(event.target, 250));
  root.addEventListener('mouseover', (event) => schedule(event.target, 500));
  root.addEventListener('mouseleave', () => schedule(null, 0));
  root.addEventListener('focusout', () => schedule(null, 0));
}

const checkIcon =
  '<svg class="stream-option-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
// Two option cards (1080p and 4K) describing what would be streamed.
export function optionCards(options, selected) {
  if (!options)
    return RESOLUTIONS.map(
      (resolution) =>
        `<div class="stream-option loading" aria-hidden="true"><span class="stream-option-head"><strong>${resolutionLabel(resolution)}</strong></span><span class="stream-option-facts">Checking releases…</span><span class="stream-option-detail">&nbsp;</span></div>`,
    ).join('');
  return options.resolutions
    .map((option) => {
      const resolution = option.resolution;
      const plan = streamPlan(option, deviceCapabilities());
      const pressed = plan.selectable && resolution === selected;
      const facts = plan.selectable ? releaseFacts(option.release).join(' · ') : 'Not available';
      const detail = plan.note || plan.warning || releaseDetail(option.release);
      const label = `${resolutionLabel(resolution)}: ${facts}. ${detail}`;
      return `<button type="button" class="stream-option${plan.warning ? ' warns' : ''}" data-stream-resolution="${resolution}" aria-pressed="${pressed}" aria-label="${esc(label)}" ${plan.selectable ? '' : 'disabled'}><span class="stream-option-head"><strong>${resolutionLabel(resolution)}</strong>${checkIcon}</span><span class="stream-option-facts">${esc(facts)}</span><span class="stream-option-detail">${esc(detail)}</span></button>`;
    })
    .join('');
}

// Live readiness of a prepared session under the cards ("Ready, starts instantly").
function readinessText(status) {
  if (!status) return '';
  if (status.state === 'failed') {
    const view = failureView(failureReason(status), status.error?.message || status.message, {
      resolution: status.resolution,
    });
    return `${view.title}. You can still try, or pick the other quality.`;
  }
  if (status.state === 'ready' || status.conversion) return 'Ready: starts instantly';
  const view = startupView(status);
  if (view.stage === 'buffering' && view.progress != null)
    return `Getting ready: buffering ${Math.round((view.progress / 0.95) * 100)}%`;
  if (view.stage === 'connecting') return `Getting ready: connected to ${status.peers || 0} peers`;
  return 'Getting ready: finding sources';
}

// Follows one prepared session; replaced whenever the selection changes. It shows only
// what the live event stream says: a cached prepare answer may describe a session that
// has since been stopped, so it is never shown as "Ready" by itself.
function readinessWatcher(element, onGone, onStatus = () => {}) {
  let events = null,
    sessionId = null;
  const close = () => {
    events?.close();
    events = null;
    sessionId = null;
  };
  const gone = () => {
    close();
    if (!element.isConnected) return;
    element.classList.remove('ready');
    element.textContent = '';
    onGone();
  };
  return {
    close,
    follow(status) {
      if (!status?.id || status.id === sessionId) return;
      close();
      sessionId = status.id;
      element.classList.remove('ready');
      element.textContent = 'Getting ready…';
      const show = (next) => {
        if (!element.isConnected) return close();
        if (next.state === 'stopped') return gone();
        element.classList.toggle('ready', next.state === 'ready' || !!next.conversion);
        element.textContent = readinessText(next);
        onStatus(next);
      };
      if (!window.EventSource) {
        api(`/api/streams/${status.id}`).then(show, gone);
        return;
      }
      const source = (events = new EventSource(`/api/streams/${status.id}/events`));
      source.addEventListener('status', (event) => {
        if (events !== source) return;
        try {
          show(JSON.parse(event.data));
        } catch {}
      });
      // A session that no longer exists answers 404 and the browser stops retrying.
      source.onerror = () => {
        if (events === source && source.readyState === 2) gone();
      };
    },
  };
}

// Shared by the sheet and the title page: cards, selection, prepare and readiness.
// `onChange(resolution, options)` runs when the selection or availability changes.
// `auto`: opened by the page rather than by the viewer (the title page), so an item the
// player has just stopped is not prepared again until the viewer shows intent.
function bindChooser(root, itemId, { onChange = () => {}, auto = false } = {}) {
  const cards = root.querySelector('.stream-options'),
    readiness = root.querySelector('.stream-readiness');
  // The cards must show what will actually play. The server checks the file itself (a
  // film with the same name can be listed under this title) and may move to another
  // release; when the checked release differs from the card, the cards are reloaded.
  let synced = null;
  const verify = (status) => {
    const shown = options?.resolutions.find((o) => o.resolution === status.resolution);
    const wrongFilm = status.error?.reason === 'wrong-film';
    const hash = status.state === 'ready' ? status.release?.hash : null;
    if (!wrongFilm && (!hash || hash === shown?.release?.hash)) return;
    const key = `${status.id}:${hash || 'none'}`;
    if (synced === key) return;
    synced = key;
    streamOptions(itemId, { refresh: true })
      .then((data) => {
        if (!root.isConnected) return;
        options = data;
        const focused = root.contains(document.activeElement)
          ? document.activeElement.dataset.streamResolution
          : null;
        render();
        if (focused) root.querySelector(`[data-stream-resolution="${focused}"]`)?.focus();
      })
      .catch(() => {});
  };
  const watcher = readinessWatcher(readiness, () => forgetPrepared(itemId), verify);
  let options = cachedOptions(itemId),
    selected = options ? preferredResolution(options) : lastResolution(),
    picked = false;
  const state = {
    // True once the viewer has chosen a card; only such a choice is remembered.
    get picked() {
      return picked;
    },
    get selected() {
      return selected;
    },
    get options() {
      return options;
    },
    close: watcher.close,
  };
  const prepare = (intent = !auto) => {
    if (!options?.canStream || !options.guard?.ok || !selected) return;
    if (!intent && recentlyStopped(itemId)) return;
    readiness.classList.remove('ready');
    readiness.textContent = 'Getting ready…';
    prepareStream(itemId, selected)
      .then((status) => {
        if (root.isConnected && status.resolution === selected) watcher.follow(status);
      })
      .catch((error) => {
        if (!root.isConnected) return;
        readiness.classList.remove('ready');
        readiness.textContent = failureView(error.reason, error.message, {
          resolution: selected,
        }).title;
      });
  };
  const render = () => {
    cards.innerHTML = optionCards(options, selected);
    if (!options) {
      readiness.textContent = 'Checking what can be streamed…';
      return;
    }
    if (!options.canStream) {
      readiness.textContent = failureView('permission').body;
    } else if (!options.guard?.ok) {
      readiness.classList.remove('ready');
      readiness.innerHTML = `<span>${esc(options.guard?.message || 'Connect the VPN to stream.')}</span> <button type="button" class="text-button stream-recheck">Check again</button>`;
    } else if (!selected) {
      readiness.textContent =
        'Nothing here can play on this device right now. You can download it instead.';
    } else if (/^Checking/.test(readiness.textContent)) readiness.textContent = '';
    onChange(selected, options);
  };
  root.addEventListener('click', (event) => {
    const card = event.target.closest('[data-stream-resolution]');
    if (card && !card.disabled) {
      const resolution = Number(card.dataset.streamResolution);
      if (resolution === selected) return;
      selected = resolution;
      picked = true;
      watcher.close();
      render();
      root.querySelector(`[data-stream-resolution="${resolution}"]`)?.focus();
      prepare(true);
      return;
    }
    if (event.target.closest('.stream-recheck')) {
      readiness.textContent = 'Checking the VPN…';
      streamOptions(itemId, { refresh: true })
        .then((data) => {
          options = data;
          selected = preferredResolution(options);
          render();
          prepare(true);
          if (!options.guard?.ok) root.querySelector('.stream-recheck')?.focus();
        })
        .catch((error) => (readiness.textContent = error.message));
    }
  });
  render();
  if (options) prepare();
  streamOptions(itemId)
    .then((data) => {
      if (!root.isConnected) return;
      const first = !options;
      options = data;
      if (first) selected = preferredResolution(options);
      else if (
        !streamPlan(
          options.resolutions.find((o) => o.resolution === selected),
          deviceCapabilities(),
        ).selectable
      )
        selected = preferredResolution(options);
      const focused = root.contains(document.activeElement)
        ? document.activeElement.dataset.streamResolution
        : null;
      render();
      if (focused) root.querySelector(`[data-stream-resolution="${focused}"]`)?.focus();
      if (first) prepare();
    })
    .catch((error) => {
      if (!root.isConnected) return;
      cards.innerHTML = '';
      readiness.textContent = `${error.message} You can download it instead.`;
      onChange(null, null);
    });
  return state;
}

const artwork = (...urls) => urls.find((url) => /^https?:\/\//.test(url || '')) || '';

// The sheet an episode's Stream button opens. Play is focused at once and works before
// the options arrive (the remembered resolution is used); the backend prepares while the
// viewer reads it. `onPlay({ resolution, replay })` and `onDownload()` are provided by the app.
export function openStreamSheet({ item, title, onPlay, onDownload }) {
  const image = artwork(item.thumbnail, title.background, title.poster);
  const resumable = item.state?.position >= 10 && !item.state?.completed;
  const subtitle =
    title.kind === 'movie'
      ? title.year || 'Movie'
      : `${episodeLabel(item)}${item.name ? ' · ' + item.name : ''}`;
  modal(
    `<div class="stream-sheet"><div class="stream-sheet-head">${image ? `<img class="stream-sheet-art" src="${esc(image)}" alt="">` : ''}<div class="stream-sheet-title"><p class="eyebrow">Stream now</p><h2>${esc(title.name)}</h2><p class="meta">${esc(subtitle)}</p></div></div><div class="stream-options" role="group" aria-label="Stream quality"></div><p class="stream-readiness" role="status" aria-live="polite"></p><div class="actions stream-sheet-actions"><button type="button" class="primary stream-play" data-sheet-play>${icon('play')}<span>${resumable ? `Resume from ${clockTime(item.state.position)}` : 'Play'}</span></button>${resumable ? '<button type="button" data-sheet-restart>From the beginning</button>' : ''}<button type="button" class="quiet" data-sheet-download>Download instead</button></div></div>`,
  );
  const root = $('#dialog-content .stream-sheet');
  const play = root.querySelector('[data-sheet-play]');
  const chooser = bindChooser(root, item.id, {
    onChange: (resolution, options) => {
      play.disabled = !!options && (!options.canStream || !options.guard?.ok || !resolution);
      if (play.disabled && document.activeElement === play)
        root.querySelector('.stream-recheck, [data-sheet-download]')?.focus();
    },
  });
  setTimeout(() => (play.disabled ? root.querySelector('[data-sheet-download]') : play).focus(), 0);
  $('#dialog').addEventListener('close', chooser.close, { once: true });
  $('#dialog-content').onclick = (event) => {
    const start = event.target.closest('[data-sheet-play], [data-sheet-restart]');
    if (start && !start.disabled) {
      chooser.close();
      if (chooser.picked && chooser.selected) saveResolution(chooser.selected);
      onPlay({ resolution: chooser.selected, replay: start.hasAttribute('data-sheet-restart') });
    } else if (event.target.closest('[data-sheet-download]')) {
      chooser.close();
      onDownload();
    }
  };
}

// The inline chooser on a title page for the title's main item.
export const streamPanelHtml = (item) =>
  `<div class="stream-panel" data-stream-panel="${esc(item.id)}"><p class="stream-panel-label">Stream quality</p><div class="stream-options" role="group" aria-label="Stream quality"></div><p class="stream-readiness" role="status" aria-live="polite"></p></div>`;
let panelState = null;
// The player covers the page: its readiness connection is closed so it neither holds a
// connection (Chromium allows 6 per host) nor keeps that session alive.
export function closeStreamPanel() {
  panelState?.close();
}
export function bindStreamPanel(item) {
  panelState?.close();
  panelState = null;
  const root = document.querySelector(`[data-stream-panel="${item.id}"]`);
  if (!root) return;
  const button = document.querySelector(`[data-action="stream-play"][data-item="${item.id}"]`);
  panelState = bindChooser(root, item.id, {
    auto: true,
    onChange: (resolution, options) => {
      if (!button) return;
      if (resolution) button.dataset.resolution = String(resolution);
      else delete button.dataset.resolution;
      button.dataset.picked = String(!!panelState?.picked);
      button.disabled = !!options && (!options.canStream || !options.guard?.ok || !resolution);
    },
  });
}
