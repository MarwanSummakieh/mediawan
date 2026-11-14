import { clockTime, playbackPosition, seekPlan, atTitleEnd } from './playback-time.js';
import { closeLive } from './sports.js';
import { $, esc, api, toast, modal, closeModal, episodeLabel } from './core.js';
import {
  createSubtitleRenderer,
  subtitleSizes,
  subtitleColors,
  subtitleBackgrounds,
  shiftSubtitleCues,
  srtToVtt,
  decodeSubtitle,
  isArabic,
  subtitleLanguageLabel,
} from './subtitles.js';
import { releases } from './torrents.js';
import {
  canStream,
  deviceCapabilities,
  decodeFailed,
  streamOptions,
  cachedOptions,
  optionCards,
  saveResolution,
  lastResolution,
  preferredResolution,
  playerId,
  streamStopped,
  closeStreamPanel,
} from './stream-ui.js';
import {
  startupView,
  failureView,
  failureReason,
  fallbackNote,
  resolutionLabel,
  releaseFacts,
  streamPlan,
} from './streaming.js';
let subtitleRenderer = null;
let active = null,
  queue = null,
  hls = null,
  conversion = null,
  timer = null,
  countdown = null,
  loading = false,
  scrubbing = false;
const video = () => $('#video');
const icons = {
  back: '<path d="m14 5-7 7 7 7"/>',
  play: '<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 5h3v14H7zm7 0h3v14h-3z" fill="currentColor" stroke="none"/>',
  rewind:
    '<path d="M4 8a9 9 0 1 1-1 7M4 3v5h5"/><text x="12" y="16" text-anchor="middle" font-size="9" font-family="sans-serif" fill="currentColor" stroke="none">10</text>',
  forward:
    '<path d="M20 8a9 9 0 1 0 1 7M20 3v5h-5"/><text x="12" y="16" text-anchor="middle" font-size="9" font-family="sans-serif" fill="currentColor" stroke="none">10</text>',
  volume: '<path d="M11 4 6 8H3v8h3l5 4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  muted: '<path d="M11 4 6 8H3v8h3l5 4Zm5 5 5 6m0-6-5 6"/>',
  fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  exitFullscreen: '<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5"/>',
  previous: '<path d="M6 5v14m12-14L8 12l10 7Z"/>',
  next: '<path d="M18 5v14M6 5l10 7-10 7Z"/>',
  queue: '<path d="M4 6h16M4 12h10M4 18h10m4-5 4 3-4 3Z"/>',
  chapters: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m4-10h4m-4 4h4"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="#171918"/><circle cx="15" cy="17" r="3" fill="#171918"/>',
  subtitles: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M10 9H7v6h3m7-6h-3v6h3"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
function iconButton(id, icon, label, shortcut = '') {
  const button = $('#' + id);
  if (button.dataset.icon !== icon) {
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icons[icon]}</svg>`;
    button.dataset.icon = icon;
  }
  button.setAttribute('aria-label', label);
  button.title = shortcut ? `${label} (${shortcut})` : label;
}
let controlsTimer = null,
  keyboardControls = false;
function showControls() {
  $('#player').classList.remove('controls-idle');
  $('#player').classList.toggle('keyboard-controls', keyboardControls);
  clearTimeout(controlsTimer);
  if (
    !active ||
    video().paused ||
    loading ||
    keyboardControls ||
    !$('#player-settings').hidden ||
    !$('#player-subtitles').hidden
  )
    return;
  controlsTimer = setTimeout(() => {
    if (video().paused || loading || scrubbing || $('#dialog').open || !$('#up-next').hidden)
      return;
    if ($('#player').contains(document.activeElement)) $('#player').focus();
    clearTimeout(controlsTimer);
    $('#player').classList.add('controls-idle');
  }, 3000);
}
function closeSettings(restoreFocus = false) {
  $('#player-settings').hidden = true;
  $('#player-settings-toggle').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('#player-settings-toggle').focus();
  showControls();
}
function closeSubtitles(restoreFocus = false) {
  $('#player-subtitles').hidden = true;
  $('#player-subtitles-toggle').setAttribute('aria-expanded', 'false');
  subtitleRenderer?.preview(false);
  if (restoreFocus) $('#player-subtitles-toggle').focus();
  showControls();
}
function openSubtitles() {
  closeSettings();
  $('#player-subtitles').hidden = false;
  $('#player-subtitles-toggle').setAttribute('aria-expanded', 'true');
  subtitleRenderer.preview($('#subtitle-appearance').open);
  showControls();
  $('#subtitles').focus();
}
function clearSubtitleTrack() {
  subtitleRenderer?.detach();
  for (const track of Array.from(video().textTracks || [])) track.mode = 'disabled';
  video()
    .querySelectorAll('track')
    .forEach((t) => {
      if (t.dataset.blob) URL.revokeObjectURL(t.dataset.blob);
      t.remove();
    });
  if (active?.stream) {
    clearTimeout(active.stream.subtitle?.retry);
    active.stream.subtitle = null;
  }
}
function releaseSubtitleFile() {
  clearSubtitleTrack();
  if (active?.subtitleFile) URL.revokeObjectURL(active.subtitleFile);
  $('#subtitle-file').value = '';
}
export const playing = () => !!active;
export function currentQueue() {
  return queue;
}
export function replaceQueue(next) {
  queue = next;
}
async function releaseConversion() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  if (conversion) {
    const key = conversion;
    conversion = null;
    await api(`/api/media/sessions/${key}`, {}, 'DELETE').catch(() => {});
  }
}
export async function report(type = 'progress', beacon = false) {
  // A stream has no watch-history session until its start request has answered.
  if (!active || loading || !active.session) return;
  const payload = {
    type,
    seq: ++active.seq,
    position: playbackPosition(video().currentTime, active.offset, active.info.duration),
    duration: active.info.duration || 0,
  };
  const url = `/api/playback/${active.session.id}/events`;
  if (beacon) {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
    return;
  }
  try {
    await api(url, payload);
  } catch (error) {
    $('#player-message').textContent = `Progress could not be saved: ${error.message}`;
  }
}
export async function closePlayer() {
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  clearInterval(timer);
  cancelNext();
  const stream = active?.stream;
  if (stream) detachStream(stream);
  hideStartup();
  // The stop report reads the position now; the player is hidden before it is answered.
  const owner = active;
  const stopped = report('stop');
  loading = true;
  video().pause();
  $('#player').hidden = true;
  document.body.classList.remove('player-open');
  releaseSubtitleFile();
  if (stream) stopStream(stream);
  await stopped;
  if (active !== owner) return; // something new started playing meanwhile
  $('#shell').removeAttribute('inert');
  await releaseConversion();
  video().removeAttribute('src');
  video().load();
  active = null;
  clearTimeout(controlsTimer);
  closeSettings();
  closeSubtitles();
  queue = null;
  loading = false;
  window.dispatchEvent(new Event('library-changed'));
}
// `stream`: { resolution, hint: { title, item }, position } plays the item through Stream
// now instead of a local file (see playStream below).
export async function play(
  itemId,
  titleId,
  { replay = false, queueId = null, stream = null } = {},
) {
  if (stream) return playStream(itemId, titleId, { replay, queueId, ...stream });
  closeStreamPanel();
  await closeLive();
  clearInterval(timer);
  cancelNext();
  const previousStream = active?.stream;
  if (previousStream) detachStream(previousStream);
  hideStartup();
  await report('stop');
  loading = true;
  video().pause();
  releaseSubtitleFile();
  if (previousStream) stopStream(previousStream);
  await releaseConversion();
  try {
    const title = await api(`/api/titles/${titleId}`),
      item = title.items.find((i) => i.id === itemId);
    if (!item?.available)
      throw new Error(
        'This episode is not downloaded. Download it or explicitly skip to another episode.',
      );
    if (!queueId && !replay && item.state.mode === 'shuffle') {
      const saved = (await api('/api/queues')).find(
        (q) => q.mode === 'shuffle' && q.items[q.index] === itemId,
      );
      if (saved) queueId = (await api(`/api/queues/${saved.id}/fork`, {})).id;
    }
    queue = queueId
      ? await api(`/api/queues/${queueId}`)
      : title.kind !== 'movie'
        ? await api('/api/queues', { titleId, startItem: itemId })
        : null;
    const info = await api(`/api/items/${itemId}/media`),
      preferences = await api('/api/preferences');
    const session = await api('/api/playback', { itemId, replay, queueId: queue?.id });
    active = {
      item,
      title,
      info,
      preferences,
      session,
      seq: 0,
      offset: 0,
      pendingPosition: session.position,
      subtitleDelay: 0,
      onlineSubtitles: [],
    };
    try {
      const saved = Number(localStorage.getItem(`mw:subsync:${itemId}`));
      if (Number.isFinite(saved)) active.subtitleDelay = Math.max(-120, Math.min(120, saved));
    } catch {}
    $('#subtitle-delay').value = String(active.subtitleDelay);
    $('#subtitle-status').textContent = '';
    $('#subtitle-find').disabled = false;
    $('#player-subtitles-toggle').classList.remove('subtitles-active');
    renderQuality();
    scrubbing = false;
    updateTransport();
    $('#player').hidden = false;
    document.body.classList.add('player-open');
    closeSettings();
    closeSubtitles();
    $('#shell').setAttribute('inert', '');
    $('#player-title').textContent = title.name;
    $('#player-episode').textContent =
      title.kind === 'movie' ? '' : `${episodeLabel(item)}${item.name ? ' · ' + item.name : ''}`;
    $('#player-message').textContent = '';
    const { supportedSubtitles, preferred } = populateMenus(info, preferences);
    if (info.direct && (!preferred || preferred.index === info.audio[0]?.index))
      await source(`/api/items/${itemId}/file`, session.position);
    else await convert(session.position);
    applyPreferredSubtitles(supportedSubtitles, preferences);
    loading = false;
    active.pendingPosition = null;
    updateTransport();
    timer = setInterval(() => void report(), 10000);
    if (
      preferences.subtitleMode === 'preferred' &&
      preferences.subtitleLanguage &&
      $('#subtitles').value === ''
    )
      void findSubtitles(true);
    $('#player-close').focus();
    showControls();
  } catch (error) {
    loading = false;
    if (active) active.pendingPosition = null;
    updateTransport();
    $('#player-message').textContent = error.message;
    toast(error.message);
    if (!active) $('#player').hidden = true;
  }
}
const textSubtitleCodecs = ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text'];
function populateMenus(info, preferences) {
  $('#audio').innerHTML = info.audio
    .map(
      (t) =>
        `<option value="${t.index}">${esc(t.language)} · ${esc(t.title || t.codec)} ${t.channels || ''}</option>`,
    )
    .join('');
  const supportedSubtitles = info.subtitles.filter((t) => textSubtitleCodecs.includes(t.codec));
  $('#subtitles').innerHTML =
    '<option value="">Off</option>' +
    supportedSubtitles
      .map(
        (t) =>
          `<option value="${t.index}">${esc(subtitleLanguageLabel(t.language))} · ${esc(t.title || t.codec)}</option>`,
      )
      .join('');
  if (!supportedSubtitles.length)
    $('#subtitle-status').textContent = info.subtitles.length
      ? 'This file only has image subtitles. Find online subtitles or open an SRT/VTT file.'
      : 'No subtitles in this file. Find online subtitles or open an SRT/VTT file.';
  updateQueueButtons();
  const preferred = info.audio.find(
    (t) => preferences.audioLanguage && t.language === preferences.audioLanguage,
  );
  if (preferred) $('#audio').value = String(preferred.index);
  return { supportedSubtitles, preferred };
}
function updateQueueButtons() {
  if (!active) return;
  $('#previous').disabled = !queue || queue.index <= 0;
  $('#next').disabled = !queue || queue.index >= queue.items.length - 1;
  $('#player-queue').disabled = !queue;
  $('#previous').hidden = $('#next').hidden = $('#player-queue').hidden = !queue;
  $('#chapters').hidden = !active.info.chapters?.length;
  $('#chapters').disabled = !active.info.chapters?.length;
}
function applyPreferredSubtitles(supportedSubtitles, preferences) {
  if (preferences.subtitleMode !== 'preferred') return;
  const track = supportedSubtitles.find(
    (t) =>
      t.language === preferences.subtitleLanguage ||
      (isArabic(t.language) && isArabic(preferences.subtitleLanguage)),
  );
  if (track) {
    $('#subtitles').value = String(track.index);
    setSubtitles();
  }
}
function renderTitle() {
  const { title, item } = active;
  $('#player-title').textContent = title.name || '';
  $('#player-episode').textContent =
    title.kind === 'movie' || !item.episode
      ? ''
      : `${episodeLabel(item)}${item.name ? ' · ' + item.name : ''}`;
}

// ---- Stream now -----------------------------------------------------------------------
// A streamed item plays through the same <video>, hls.js, menus, history and queue code as
// a local file. Differences: media info comes from the stream status, conversions are
// restarted with /api/streams/:sid/convert, embedded subtitles come from the stream, and
// the session is kept alive with heartbeats and stopped when the player closes.
const artworkUrl = (...urls) => urls.find((url) => /^https?:\/\//.test(url || '')) || '';
const absolutePosition = () =>
  active ? playbackPosition(video().currentTime, active.offset, active.info.duration) : 0;
const newStream = (fields) => ({
  id: null,
  itemId: null,
  resolution: null,
  // Compatibility playback: every start/convert of this stream asks for an H.264 transcode.
  forceTranscode: false,
  // Conversions this player has already used or seen on the session. A start always makes
  // a new one, but the first status after it may still describe the previous attempt.
  seen: new Set(),
  status: null,
  startedAt: Date.now(),
  sourced: false,
  probed: false,
  failed: null,
  closing: false,
  stale: false,
  events: null,
  heartbeat: null,
  tick: null,
  switching: null,
  nextPrepared: false,
  conversionSubtitles: [],
  subtitle: null,
  recoveredAt: 0,
  ...fields,
});
const streamCapabilities = (stream) =>
  stream.forceTranscode ? { ...deviceCapabilities(), forceTranscode: true } : deviceCapabilities();
// The status's conversion if it belongs to this player's current attempt, else null.
const freshConversion = (stream, status) =>
  status.conversion && !stream.seen.has(status.conversion.id) ? status.conversion : null;
// Server-sent events for one session (polling where EventSource is missing).
function streamEvents(owner, id, handler) {
  const gone = (error) => {
    if (error.status === 404 && active === owner)
      handler({ id, state: 'stopped', message: 'The stream ended. It may have expired.' });
  };
  if (!window.EventSource) {
    const poll = setInterval(() => api(`/api/streams/${id}`).then(handler, gone), 500);
    return { close: () => clearInterval(poll) };
  }
  const events = new EventSource(`/api/streams/${id}/events`);
  events.addEventListener('status', (event) => {
    if (active !== owner) return events.close();
    let status;
    try {
      status = JSON.parse(event.data);
    } catch {
      return;
    }
    handler(status);
  });
  // A closed stream (404) stops reconnecting; confirm with one status request.
  events.onerror = () => {
    if (events.readyState === 2 && active === owner) api(`/api/streams/${id}`).then(handler, gone);
  };
  return events;
}
function detachStream(stream) {
  stream.events?.close();
  stream.events = null;
  clearInterval(stream.heartbeat);
  clearInterval(stream.tick);
  const switching = stream.switching;
  if (switching) {
    switching.events?.close();
    clearTimeout(switching.timer);
  }
}
function stopStream(stream) {
  detachStream(stream);
  if (stream.closing) return;
  stream.closing = true;
  const ids = [stream.id, stream.switching?.id].filter(Boolean);
  stream.switching = null;
  for (const id of ids) api(`/api/streams/${id}`, {}, 'DELETE').catch(() => {});
  if (ids.length) streamStopped(stream.itemId);
}
function heartbeat(owner) {
  const stream = owner.stream;
  if (active !== owner || !stream.id || stream.failed || stream.closing) return;
  const position = Math.max(0, owner.pendingPosition ?? absolutePosition());
  api(`/api/streams/${stream.id}/heartbeat`, { position }).catch((error) => {
    if (error.status === 404 && active === owner && owner.stream === stream && !stream.closing)
      void showStreamFailure(owner, 'stopped', 'The stream ended on the server.');
  });
  // Embedded subtitles grow while FFmpeg converts: fetch again only when the conversion
  // has written well past what the track holds, and the playhead is getting close to its
  // end or the last fetch is old. The visible track stays until the new one has loaded.
  const subtitle = stream.subtitle;
  const c = stream.status?.conversion;
  const written = c && c.id === conversion ? c.offset + (c.convertedSeconds || 0) : Infinity;
  if (
    subtitle &&
    subtitle.loaded &&
    !subtitle.complete &&
    !subtitle.fetching &&
    !loading &&
    $('#subtitles').value === String(subtitle.index) &&
    written > subtitle.until + 20 &&
    (position > subtitle.until - 60 || Date.now() - subtitle.loadedAt > 45000)
  )
    refreshStreamSubtitle(owner, subtitle);
}
function hideStartup() {
  $('#stream-start').hidden = true;
  $('#stream-start').classList.remove('failed');
  $('#player').classList.remove('stream-starting');
}
function showStartupShell(owner) {
  const image = artworkUrl(owner.title.background, owner.item.thumbnail, owner.title.poster);
  const art = $('#stream-start-art');
  if (image && art.getAttribute('src') !== image) art.src = image;
  if (!image) art.removeAttribute('src');
  art.hidden = !image;
  $('#stream-start').hidden = false;
  $('#player').classList.add('stream-starting');
}
const startupSteps = ['sources', 'connecting', 'buffering'];
function renderStartup(owner, status) {
  const stream = owner.stream;
  if (active !== owner || stream.failed) return;
  const view = startupView(status, { elapsedMs: Date.now() - stream.startedAt });
  const panel = $('#stream-start');
  panel.classList.remove('failed');
  $('#stream-start-title').textContent = view.title;
  $('#stream-start-detail').textContent = view.detail;
  const current = startupSteps.indexOf(view.stage);
  panel.querySelectorAll('[data-step]').forEach((step, index) => {
    step.classList.toggle('done', index < current || view.stage === 'playing');
    step.classList.toggle('current', index === current);
  });
  $('#stream-start-meter').classList.toggle('indeterminate', view.progress == null);
  $('#stream-start-bar').style.width =
    view.progress == null ? '' : `${Math.round(view.progress * 100)}%`;
  const resolution = status?.resolution || stream.resolution;
  $('#stream-start-quality').textContent = [
    resolution ? resolutionLabel(resolution) : '',
    ...releaseFacts(status?.release),
  ]
    .filter(Boolean)
    .join(' · ');
  $('#stream-start-note').textContent =
    fallbackNote(status) ||
    (owner.stream.forceTranscode
      ? 'This device cannot play the original video, so the server is converting it.'
      : '');
  $('#stream-start-actions').innerHTML = '';
}
// A plain explanation and next steps in place of the start-up progress. Never a dead end.
function showStreamFailure(owner, reason, message) {
  const stream = owner.stream;
  if (active !== owner || stream.closing) return;
  stream.failed = { reason, message };
  // Where this player was (or was seeking to), so "Try again" resumes exactly there.
  if (stream.sourced) stream.failedAt = Math.max(0, owner.pendingPosition ?? absolutePosition());
  clearInterval(stream.tick);
  if (stream.switching) cancelSwitch(owner);
  loading = false;
  owner.pendingPosition = null;
  video().pause();
  closeSettings();
  closeSubtitles();
  // The browser said it could play the original video and then could not. Asking the
  // viewer to choose is a dead stop for no reason: convert on the server at once, at the
  // same position, and remember it for this device. A second failure shows the screen.
  if (reason === 'playback' && !stream.forceTranscode) {
    decodeFailed(owner.info);
    void restartStream(owner, { forceTranscode: true });
    return;
  }
  let ownOthers = 0;
  const render = () => {
    if (active !== owner || owner.stream !== stream || !stream.failed) return;
    const options = cachedOptions(owner.item.id);
    // The other quality on offer for this title: 4K beside 1080p, 720p or SD.
    const option = options?.resolutions.find((o) => o.resolution !== stream.resolution) || null;
    const otherResolution = option ? option.resolution : stream.resolution === 2160 ? 1080 : 2160;
    const view = failureView(reason, message, {
      resolution: stream.resolution,
      other: option && {
        resolution: otherResolution,
        available: streamPlan(option, deviceCapabilities()).selectable,
      },
      canDownload: canStream(),
      ownOthers,
      compatible: stream.forceTranscode,
    });
    $('#stream-start').classList.add('failed');
    $('#stream-start-title').textContent = view.title;
    $('#stream-start-detail').textContent = view.body;
    $('#stream-start-note').textContent = '';
    const focused = document.activeElement?.dataset?.streamAction;
    $('#stream-start-actions').innerHTML = view.actions
      .map(
        (action, index) =>
          `<button type="button" class="${index ? '' : 'primary'}" data-stream-action="${action.id}" ${action.resolution ? `data-resolution="${action.resolution}"` : ''}>${esc(action.label)}</button>`,
      )
      .join('');
    const target =
      (focused && $(`#stream-start-actions [data-stream-action="${focused}"]`)) ||
      $('#stream-start-actions button');
    target?.focus();
  };
  showStartupShell(owner);
  render();
  streamOptions(owner.item.id).then(render, () => {});
  if (reason === 'limit')
    ownStreams(owner).then(
      (list) => {
        ownOthers = list.length;
        render();
      },
      () => {},
    );
  updateTransport();
  showControls();
}
// "Try again" starts again: the server makes a new conversion on every start. The
// position is sent when this player knows it (a restart mid-playback); otherwise the
// server resumes from the saved point.
function restartStream(
  owner,
  { resolution = owner.stream.resolution, forceTranscode = owner.stream.forceTranscode } = {},
) {
  const position = owner.stream.sourced ? (owner.stream.failedAt ?? absolutePosition()) : undefined;
  return playStream(owner.item.id, owner.title.id, {
    queueId: queue?.id,
    resolution,
    position,
    forceTranscode,
    hint: { title: owner.title, item: owner.item },
  });
}
// This player's other sessions. Sessions of the user's other devices are never touched.
async function ownStreams(owner) {
  const { items } = await api('/api/streams');
  const keep = [owner.stream.id, owner.stream.switching?.id];
  return items.filter((s) => s.player === playerId() && !keep.includes(s.id));
}
async function stopOtherStreams(owner) {
  const mine = await ownStreams(owner);
  await Promise.all(mine.map((s) => api(`/api/streams/${s.id}`, {}, 'DELETE').catch(() => {})));
}
async function playStream(
  itemId,
  titleId,
  {
    replay = false,
    queueId = null,
    resolution = null,
    hint = null,
    position,
    forceTranscode = false,
  } = {},
) {
  // Respond in this frame: tear down what is playing and show the shell with the title,
  // artwork and a live status before any request is made.
  clearInterval(timer);
  cancelNext();
  closeStreamPanel();
  const previous = active;
  const previousStream = previous?.stream || null;
  if (previousStream) detachStream(previousStream);
  void report('stop');
  loading = true;
  video().pause();
  releaseSubtitleFile();
  let released = Promise.resolve();
  if (previousStream) {
    // The server owns a stream's conversion; a reused session keeps it running.
    if (hls) hls.destroy();
    hls = null;
    conversion = null;
  } else released = releaseConversion();
  video().removeAttribute('src');
  video().load();
  const title =
    hint?.title || (previous?.title?.id === titleId ? previous.title : { id: titleId, name: '' });
  const item = hint?.item || title.items?.find((i) => i.id === itemId) || { id: itemId };
  active = {
    item,
    title,
    info: { duration: 0, audio: [], subtitles: [], chapters: [] },
    preferences: previous?.preferences || {},
    session: null,
    seq: 0,
    offset: 0,
    pendingPosition: replay
      ? 0
      : (position ?? (item.state && !item.state.completed ? item.state.position || 0 : 0)),
    subtitleDelay: 0,
    onlineSubtitles: [],
    stream: newStream({
      itemId,
      resolution: resolution || null,
      forceTranscode,
      // A retry reuses this player's session: the earlier attempts' conversions are stale.
      seen: new Set(
        previousStream
          ? [...previousStream.seen, previousStream.status?.conversion?.id].filter(Boolean)
          : [],
      ),
    }),
  };
  const owner = active,
    stream = owner.stream;
  const releasePrevious = (keepId) => {
    if (
      previousStream?.id &&
      previousStream.id !== keepId &&
      previousStream.id !== active?.stream?.id
    )
      stopStream(previousStream);
  };
  queue = null;
  try {
    const saved = Number(localStorage.getItem(`mw:subsync:${itemId}`));
    if (Number.isFinite(saved)) owner.subtitleDelay = Math.max(-120, Math.min(120, saved));
  } catch {}
  $('#subtitle-delay').value = String(owner.subtitleDelay);
  $('#subtitle-status').textContent = '';
  $('#subtitle-find').disabled = false;
  $('#player-subtitles-toggle').classList.remove('subtitles-active');
  $('#audio').innerHTML = '';
  $('#subtitles').innerHTML = '<option value="">Off</option>';
  scrubbing = false;
  $('#player').hidden = false;
  document.body.classList.add('player-open');
  closeSettings();
  closeSubtitles();
  $('#shell').setAttribute('inert', '');
  renderTitle();
  $('#player-message').textContent = '';
  updateQueueButtons();
  showStartupShell(owner);
  renderStartup(owner, null);
  // Events arrive only on change; the tick keeps the elapsed-time hints honest.
  stream.tick = setInterval(() => {
    if (!stream.sourced) renderStartup(owner, stream.status);
  }, 1000);
  renderQuality();
  updateTransport();
  $('#player-close').focus();
  showControls();
  try {
    const titleRequest = api(`/api/titles/${titleId}`);
    titleRequest.catch(() => {});
    // Closing live TV and releasing the previous local conversion run alongside the start;
    // neither has anything to do with it.
    const teardown = Promise.all([closeLive().catch(() => {}), released.catch(() => {})]);
    const start = async () => {
      // Without an explicit choice: the viewer's last choice if this device can play it.
      // (The server's own default ignores the device, e.g. 4K movies on a 1080p screen.)
      let chosen = resolution;
      if (!chosen) {
        const options = await streamOptions(itemId).catch(() => null);
        if (active !== owner) return null;
        chosen = options ? preferredResolution(options) : null;
        if (options && !chosen) {
          const fallback = options.resolutions[0];
          throw Object.assign(new Error(fallback?.reason || ''), { reason: 'unavailable' });
        }
        stream.resolution = chosen;
        renderStartup(owner, null);
      }
      const body = { capabilities: streamCapabilities(stream), player: playerId() };
      if (chosen) body.resolution = chosen;
      if (replay) body.position = 0;
      else if (position != null) body.position = Math.max(0, position);
      return api(`/api/items/${itemId}/stream`, body);
    };
    const [status] = await Promise.all([start(), teardown]);
    if (!status) return releasePrevious();
    // The start request reuses the previous session when it is the same item and
    // resolution (a retry); otherwise the previous one is stopped now, not before, so a
    // session prepared by it for this item stays warm.
    releasePrevious(status.id);
    const fresh = await titleRequest.catch((error) => {
      api(`/api/streams/${status.id}`, {}, 'DELETE').catch(() => {});
      throw error;
    });
    if (active !== owner) {
      if (!active || active.item.id !== itemId)
        api(`/api/streams/${status.id}`, {}, 'DELETE').catch(() => {});
      return;
    }
    owner.title = fresh;
    owner.item = fresh.items.find((i) => i.id === itemId) || item;
    stream.id = status.id;
    stream.resolution = status.resolution;
    renderTitle();
    showStartupShell(owner);
    renderQuality();
    stream.events = streamEvents(owner, status.id, (next) => onStreamStatus(owner, next));
    stream.heartbeat = setInterval(() => heartbeat(owner), 3000);
    // Watch history needs the stream to exist first (docs/streaming.md, Watch history).
    stream.setup = (async () => {
      const [preferences, q] = await Promise.all([
        api('/api/preferences'),
        queueId
          ? api(`/api/queues/${queueId}`)
          : fresh.kind !== 'movie'
            ? api('/api/queues', { titleId, startItem: itemId })
            : null,
      ]);
      const session = await api('/api/playback', { itemId, replay, queueId: q?.id });
      return { preferences, q, session };
    })();
    onStreamStatus(owner, status);
    const { preferences, q, session } = await stream.setup;
    if (active !== owner) return;
    owner.preferences = preferences;
    owner.session = session;
    queue = q;
    updateQueueButtons();
    timer = setInterval(() => void report(), 10000);
  } catch (error) {
    releasePrevious();
    if (active === owner) showStreamFailure(owner, failureReason(error), error.message);
  }
}
function onStreamStatus(owner, status) {
  const stream = owner.stream;
  if (active !== owner || status.id !== stream.id || stream.closing) return;
  stream.status = status;
  if (status.playback && !stream.probed) {
    stream.probed = true;
    owner.info = status.playback;
    populateMenus(owner.info, owner.preferences || {});
  }
  // Before playback starts, only the conversion made for this attempt counts; one left
  // over from an earlier attempt (a retry reuses the session) is ignored, failure included.
  const fresh = stream.sourced ? status.conversion : freshConversion(stream, status);
  const staleFailure =
    status.error?.reason === 'conversion' && status.conversion && !fresh && !stream.sourced;
  if (fresh?.audio != null && !stream.sourced) $('#audio').value = String(fresh.audio);
  if (status.state === 'failed' && !staleFailure)
    return showStreamFailure(owner, failureReason(status), status.error?.message || status.message);
  if (status.state === 'stopped') return showStreamFailure(owner, 'stopped', status.message);
  if (stream.failed) return;
  stream.stale = status.conversion?.state === 'stopped';
  if (!stream.sourced) {
    // This player's own start point: its session's resume point, which is the position
    // it sent (or its saved history) and the point its new conversion starts from.
    if (fresh?.requested != null) owner.pendingPosition = fresh.requested;
    else if (status.resumePosition != null) owner.pendingPosition = status.resumePosition;
    renderStartup(
      owner,
      staleFailure || (status.conversion && !fresh)
        ? { ...status, state: 'starting', conversion: null, error: null }
        : status,
    );
    if (fresh?.state === 'ready' && fresh.url) void beginPlayback(owner, fresh);
  }
  updateTransport();
}
async function beginPlayback(owner, c) {
  const stream = owner.stream;
  stream.sourced = true;
  stream.seen.add(c.id);
  clearInterval(stream.tick);
  try {
    const { preferences } = await stream.setup;
    if (active !== owner || owner.stream !== stream || stream.failed) return;
    conversion = c.id;
    owner.offset = c.offset;
    stream.conversionSubtitles = c.subtitles || [];
    await source(c.url, Math.max(0, (c.requested || 0) - c.offset), true);
    if (active !== owner || owner.stream !== stream) return;
    hideStartup();
    applyPreferredSubtitles(
      owner.info.subtitles.filter((t) => textSubtitleCodecs.includes(t.codec)),
      preferences,
    );
    loading = false;
    owner.pendingPosition = null;
    updateTransport();
    if (
      preferences.subtitleMode === 'preferred' &&
      preferences.subtitleLanguage &&
      $('#subtitles').value === ''
    )
      void findSubtitles(true);
    showControls();
  } catch (error) {
    if (active === owner && owner.stream === stream)
      showStreamFailure(owner, failureReason(error), error.message);
  }
}
async function convertStream(owner, position, autoplay) {
  let stream = owner.stream;
  // Seeking during a resolution switch: continue on the new session.
  if (stream.switching) {
    if (stream.switching.latest) stream = promoteSwitch(owner, stream, stream.switching, true);
    else cancelSwitch(owner);
  }
  if (hls) hls.destroy();
  hls = null;
  let result;
  try {
    result = await api(`/api/streams/${stream.id}/convert`, {
      position,
      audio: Number($('#audio').value) || undefined,
      capabilities: streamCapabilities(stream),
    });
  } catch (error) {
    if (active === owner && owner.stream === stream) {
      owner.pendingPosition = position;
      showStreamFailure(owner, failureReason(error), error.message);
    }
    return;
  }
  if (active !== owner || owner.stream !== stream) return;
  conversion = result.id;
  stream.seen.add(result.id);
  owner.offset = result.offset;
  stream.conversionSubtitles = result.subtitles || [];
  stream.stale = false;
  try {
    await source(result.url, Math.max(0, position - result.offset), autoplay);
  } catch (error) {
    if (active === owner && owner.stream === stream) {
      owner.pendingPosition = position;
      showStreamFailure(owner, 'playback', error.message);
    }
    return;
  }
  setSubtitles();
  $('#player-message').textContent = '';
}

// Resolution: switch mid-playback without losing the place. The old playlist keeps
// playing until the new session has converted past the playhead, then the player swaps.
function renderQuality() {
  const group = $('#stream-quality'),
    stream = active?.stream;
  group.hidden = !stream;
  if (!stream) return;
  const options = cachedOptions(active.item.id);
  const focused = group.contains(document.activeElement)
    ? document.activeElement.dataset.streamResolution
    : null;
  $('#stream-quality-options').innerHTML = optionCards(
    options,
    stream.switching?.resolution || stream.resolution,
  );
  if (focused) $(`#stream-quality-options [data-stream-resolution="${focused}"]`)?.focus();
  // Shown at once from the cache (even if old), refreshed in the background.
  streamOptions(active.item.id).then(
    (fresh) => active?.stream === stream && fresh !== options && renderQuality(),
    () => {},
  );
}
let switchMessageTimer = null;
function switchMessage(text, clearAfter = 0) {
  clearTimeout(switchMessageTimer);
  $('#stream-quality-status').textContent = text;
  $('#player-message').textContent = text;
  if (clearAfter)
    switchMessageTimer = setTimeout(() => {
      if ($('#player-message').textContent === text) $('#player-message').textContent = '';
      if ($('#stream-quality-status').textContent === text)
        $('#stream-quality-status').textContent = '';
    }, clearAfter);
}
function cancelSwitch(owner) {
  const switching = owner.stream.switching;
  if (!switching) return;
  owner.stream.switching = null;
  switching.events?.close();
  clearTimeout(switching.timer);
  if (switching.id) api(`/api/streams/${switching.id}`, {}, 'DELETE').catch(() => {});
  renderQuality();
}
async function changeResolution(resolution) {
  const owner = active,
    stream = owner?.stream;
  if (!stream?.id || resolution === (stream.switching?.resolution || stream.resolution)) return;
  saveResolution(resolution);
  if (!stream.sourced || stream.failed) {
    closeSettings();
    return void restartStream(owner, { resolution });
  }
  cancelSwitch(owner);
  if (resolution === stream.resolution) {
    switchMessage(`Staying in ${resolutionLabel(resolution)}`, 4000);
    return;
  }
  const label = resolutionLabel(resolution);
  const switching = { resolution, id: null, events: null, latest: null, readyAt: 0, timer: null };
  stream.switching = switching;
  renderQuality();
  switchMessage(`Switching to ${label}. Playback continues meanwhile.`);
  try {
    const status = await api(`/api/streams/${stream.id}/resolution`, {
      resolution,
      position: Math.max(0, absolutePosition()),
      capabilities: streamCapabilities(stream),
    });
    if (active !== owner || owner.stream !== stream || stream.switching !== switching) {
      if (status.id !== active?.stream?.id)
        api(`/api/streams/${status.id}`, {}, 'DELETE').catch(() => {});
      return;
    }
    switching.id = status.id;
    switching.events = streamEvents(owner, status.id, (next) =>
      onSwitchStatus(owner, stream, switching, next),
    );
    onSwitchStatus(owner, stream, switching, status);
  } catch (error) {
    if (stream.switching !== switching) return;
    stream.switching = null;
    renderQuality();
    const view = failureView(failureReason(error), error.message, { resolution });
    switchMessage(`${view.title}. Still playing in ${resolutionLabel(stream.resolution)}.`, 8000);
  }
}
function onSwitchStatus(owner, stream, switching, status) {
  if (active !== owner || owner.stream !== stream || stream.switching !== switching) return;
  if (status.id !== switching.id) return;
  const label = resolutionLabel(switching.resolution);
  if (status.state === 'failed' || status.state === 'stopped') {
    cancelSwitch(owner);
    const view = failureView(failureReason(status), status.error?.message || status.message, {
      resolution: switching.resolution,
    });
    switchMessage(`${view.title}. Still playing in ${resolutionLabel(stream.resolution)}.`, 8000);
    return;
  }
  switching.latest = status;
  const c = status.conversion;
  if (c?.state === 'ready' && c.url) {
    if (!switching.readyAt) {
      switching.readyAt = Date.now();
      switching.timer = setTimeout(() => void swapStream(owner, stream, switching), 8000);
    }
    if (video().paused || c.offset + (c.convertedSeconds || 0) >= absolutePosition() + 3)
      void swapStream(owner, stream, switching);
    else switchMessage(`Switching to ${label}: almost ready.`);
    return;
  }
  const view = startupView(status);
  switchMessage(
    `Switching to ${label}: ${view.title.toLowerCase()}${view.progress != null && status.state === 'probing' ? ` ${Math.round((view.progress / 0.95) * 100)}%` : ''}. Playback continues meanwhile.`,
  );
}
// Make the switching session the current one (menus follow its file).
function promoteSwitch(owner, old, switching, stopOld) {
  old.switching = null;
  switching.events?.close();
  clearTimeout(switching.timer);
  detachStream(old);
  const status = switching.latest;
  const next = newStream({
    id: status.id,
    itemId: old.itemId,
    resolution: switching.resolution,
    forceTranscode: old.forceTranscode,
    seen: new Set(status.conversion ? [status.conversion.id] : []),
    status,
    sourced: true,
    probed: !!status.playback,
    // Next Up is prepared again at the new resolution.
    nextPrepared: false,
    conversionSubtitles: status.conversion?.subtitles || [],
  });
  owner.stream = next;
  next.events = streamEvents(owner, status.id, (s) => onStreamStatus(owner, s));
  next.heartbeat = setInterval(() => heartbeat(owner), 3000);
  if (status.playback) {
    const choice = $('#subtitles').value;
    const language = owner.info.subtitles.find((t) => String(t.index) === choice)?.language;
    owner.info = status.playback;
    populateMenus(owner.info, owner.preferences || {});
    if (status.conversion?.audio != null) $('#audio').value = String(status.conversion.audio);
    addOnlineSubtitles(owner.onlineSubtitles);
    if (owner.subtitleFile) addFileOption(owner.subtitleUpload?.name || 'Subtitle file');
    const same = language && owner.info.subtitles.find((t) => t.language === language);
    $('#subtitles').value =
      choice.startsWith('online:') || choice === 'file' ? choice : same ? String(same.index) : '';
  }
  if (stopOld) stopStream(old);
  renderQuality();
  return next;
}
async function swapStream(owner, old, switching) {
  if (active !== owner || owner.stream !== old || old.switching !== switching) return;
  if (loading) {
    clearTimeout(switching.timer);
    switching.timer = setTimeout(() => void swapStream(owner, old, switching), 500);
    return;
  }
  const position = absolutePosition(),
    resume = !video().paused;
  const next = promoteSwitch(owner, old, switching, false);
  const c = switching.latest.conversion;
  loading = true;
  owner.pendingPosition = position;
  updateTransport();
  if (hls) hls.destroy();
  hls = null;
  conversion = c.id;
  owner.offset = c.offset;
  try {
    await source(c.url, Math.max(0, position - c.offset), resume);
    if (active !== owner || owner.stream !== next) return;
    setSubtitles();
    switchMessage(`Now streaming in ${resolutionLabel(next.resolution)}.`, 4000);
  } catch (error) {
    if (active === owner && owner.stream === next)
      showStreamFailure(owner, 'playback', error.message);
  } finally {
    stopStream(old);
    if (active === owner) {
      loading = false;
      owner.pendingPosition = null;
      updateTransport();
      showControls();
    }
  }
}

async function source(url, seek = 0, autoplay = true) {
  clearSubtitleTrack();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        Object.assign(new Error('Playback could not start. Try compatibility playback.'), {
          reason: 'playback',
        }),
      );
    }, 25000);
    const error = () => {
      cleanup();
      reject(
        Object.assign(new Error('This format needs compatibility playback.'), {
          reason: 'playback',
        }),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      video().removeEventListener('error', error);
      video().onloadedmetadata = null;
    };
    let settled = false;
    video().addEventListener('error', error, { once: true });
    video().onloadedmetadata = () => {
      cleanup();
      settled = true;
      if (seek > 0) video().currentTime = seek;
      if (autoplay)
        video()
          .play()
          .catch(() => {
            $('#player-message').textContent = 'Press Play to begin.';
          });
      resolve();
    };
    if (url.includes('.m3u8') && window.Hls?.isSupported()) {
      const instance = (hls = new window.Hls({ startPosition: 0, lowLatencyMode: false }));
      hls.loadSource(url);
      hls.attachMedia(video());
      hls.on(window.Hls.Events.ERROR, (_, data) => {
        if (!data.fatal || hls !== instance) return; // a replaced player is gone on purpose
        const owner = active,
          stream = owner?.stream;
        if (!settled) {
          // Before the first frame: the caller shows what to do next.
          cleanup();
          if (!stream)
            $('#player-message').textContent = 'Playback failed. Try compatibility playback again.';
          reject(
            Object.assign(
              new Error(
                stream ? 'The video could not be played.' : 'Compatibility playback failed',
              ),
              { reason: 'playback' },
            ),
          );
          return;
        }
        if (!stream) {
          $('#player-message').textContent = 'Playback failed. Try compatibility playback again.';
          return;
        }
        // A stream recovers once by restarting its conversion at the playhead; a second
        // fatal error soon after, or one during a restart, shows the failure screen.
        if (!loading && Date.now() - stream.recoveredAt > 15000) {
          stream.recoveredAt = Date.now();
          void convert(absolutePosition(), !video().paused).catch((e) => toast(e.message));
        } else showStreamFailure(owner, 'playback', 'Playback kept failing on this device.');
      });
    } else video().src = url;
  });
}
async function convert(position, autoplay = true) {
  if (!active) return;
  const owner = active;
  loading = true;
  showControls();
  active.pendingPosition = position;
  updateTransport();
  $('#player-message').textContent = '';
  video().pause();
  try {
    if (owner.stream) return await convertStream(owner, position, autoplay);
    await releaseConversion();
    const result = await api(`/api/items/${active.item.id}/convert`, {
      seek: position,
      audio: Number($('#audio').value) || undefined,
    });
    if (active !== owner) {
      await api(`/api/media/sessions/${result.id}`, {}, 'DELETE').catch(() => {});
      return;
    }
    conversion = result.id;
    active.offset = result.offset;
    await source(result.url, 0, autoplay);
    setSubtitles();
    $('#player-message').textContent = '';
  } finally {
    loading = false;
    if (active) active.pendingPosition = null;
    updateTransport();
    showControls();
  }
}
// Applies the viewer's delay to one track's cues (and, for external files, the conversion
// offset) without accumulating drift; the original times are kept per cue.
function syncFor(owner, track, external) {
  const originals = new WeakMap();
  return () => {
    if (active !== owner || !track.isConnected) return;
    shiftSubtitleCues(
      track.track.cues,
      active.subtitleDelay,
      external ? active.offset : 0,
      originals,
    );
    subtitleRenderer.render();
  };
}
function setSubtitles() {
  clearSubtitleTrack();
  const index = $('#subtitles').value;
  $('#player-subtitles-toggle').classList.toggle('subtitles-active', index !== '');
  if (index === '' || !active) return;
  const owner = active;
  const label = $('#subtitles').selectedOptions[0]?.textContent || 'Subtitles';
  const language = index.startsWith('online:')
    ? active.onlineSubtitles.find((t) => t.id === index.slice(7))?.language
    : active.info.subtitles.find((t) => String(t.index) === index)?.language;
  const srclang = language ? (isArabic(language) ? 'ar' : language) : '';
  const external = index.startsWith('online:') || index === 'file';
  if (!external && active.stream) {
    if (!active.stream.conversionSubtitles.includes(Number(index))) {
      $('#subtitles').value = '';
      $('#player-subtitles-toggle').classList.remove('subtitles-active');
      $('#subtitle-status').textContent =
        'This track is not available while streaming. Find online subtitles instead.';
      return;
    }
    active.stream.subtitle = {
      index: Number(index),
      label,
      srclang,
      until: 0,
      complete: false,
      loadedAt: 0,
      loaded: false,
      fetching: false,
      attempts: 0,
      retry: null,
    };
    return loadStreamSubtitle(owner, active.stream.subtitle);
  }
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = label;
  if (srclang) track.srclang = srclang;
  track.src =
    index === 'file'
      ? active.subtitleFile
      : index.startsWith('online:')
        ? `/api/items/${active.item.id}/subtitles/online/${encodeURIComponent(index.slice(7))}`
        : `/api/items/${active.item.id}/subtitles/${index}?offset=${active.offset}`;
  track.default = true;
  active.syncSubtitles = syncFor(owner, track, external);
  track.addEventListener('load', () => {
    if (active !== owner || !track.isConnected) return;
    active.syncSubtitles();
    $('#subtitle-status').textContent = '';
  });
  track.addEventListener('error', () => {
    if (active !== owner || !track.isConnected) return;
    $('#subtitle-status').textContent =
      'These subtitles could not be loaded. Choose another track or open a subtitle file.';
    toast('These subtitles could not be loaded');
  });
  video().appendChild(track);
  subtitleRenderer.attach(track);
}
// Embedded text of a stream is written by the running conversion and grows; cue times are
// on the playlist timeline, and the headers say how far it reaches. Each (re)load builds
// a new track beside the visible one and swaps it in only once its cues are ready, so
// nothing disappears while the next part arrives. 409 means the conversion is not ready.
function loadStreamSubtitle(owner, state) {
  const stream = owner.stream;
  const current = () =>
    active === owner &&
    owner.stream === stream &&
    stream.subtitle === state &&
    $('#subtitles').value === String(state.index);
  const failed = () => {
    state.fetching = false;
    if (!current() || state.loaded) return; // a failed refresh keeps the visible track
    $('#subtitle-status').textContent =
      'These subtitles could not be loaded. Choose another track or open a subtitle file.';
    toast('These subtitles could not be loaded');
  };
  state.fetching = true;
  fetch(`/api/streams/${stream.id}/subtitles/embedded/${state.index}`)
    .then(async (response) => {
      if (response.status === 409 && current() && ++state.attempts < 30) {
        state.fetching = false;
        state.retry = setTimeout(() => current() && loadStreamSubtitle(owner, state), 1500);
        return;
      }
      if (!response.ok) throw new Error('Subtitles unavailable');
      const text = await response.text();
      if (!current()) return;
      const url = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = state.label;
      if (state.srclang) track.srclang = state.srclang;
      track.dataset.blob = url;
      track.src = url;
      track.addEventListener(
        'load',
        () => {
          if (!current() || !track.isConnected) {
            URL.revokeObjectURL(url);
            return track.remove();
          }
          state.until = Number(response.headers.get('X-Subtitle-Until')) || 0;
          state.complete = response.headers.get('X-Subtitle-Complete') === 'true';
          state.loadedAt = Date.now();
          state.loaded = true;
          state.fetching = false;
          subtitleRenderer.attach(track);
          active.syncSubtitles = syncFor(owner, track, false);
          active.syncSubtitles();
          video()
            .querySelectorAll('track')
            .forEach((old) => {
              if (old === track) return;
              if (old.dataset.blob) URL.revokeObjectURL(old.dataset.blob);
              old.remove();
            });
          $('#subtitle-status').textContent = '';
        },
        { once: true },
      );
      track.addEventListener('error', () => {
        URL.revokeObjectURL(url);
        track.remove();
        failed();
      });
      video().appendChild(track);
      track.track.mode = 'hidden'; // a disabled track would never load
    })
    .catch(failed);
}
function refreshStreamSubtitle(owner, state) {
  state.loadedAt = Date.now();
  loadStreamSubtitle(owner, state);
}
function addOnlineSubtitles(tracks) {
  $('#subtitles-online')?.remove();
  if (!tracks.length) return;
  const group = document.createElement('optgroup');
  group.id = 'subtitles-online';
  group.label = 'Online · OpenSubtitles';
  group.innerHTML = tracks
    .map((t) => `<option value="online:${esc(t.id)}">${esc(t.label)}</option>`)
    .join('');
  $('#subtitles').appendChild(group);
}
function addFileOption(name) {
  $('#subtitle-file-option')?.remove();
  const option = document.createElement('option');
  option.id = 'subtitle-file-option';
  option.value = 'file';
  option.textContent = name;
  $('#subtitles').appendChild(option);
}
async function findSubtitles(selectPreferred = false) {
  if (!active || $('#subtitle-find').disabled) return;
  const owner = active;
  $('#subtitle-find').disabled = true;
  $('#subtitle-status').textContent = 'Finding subtitles…';
  try {
    const tracks = await api(`/api/items/${owner.item.id}/subtitles`);
    if (active !== owner) return;
    const selection = $('#subtitles').value;
    active.onlineSubtitles = tracks;
    addOnlineSubtitles(tracks);
    if (tracks.length) {
      $('#subtitles').value = selection;
      if (selectPreferred && !selection && !active.subtitleUserChoice) {
        const preferred = tracks.find(
          (t) =>
            t.language === active.preferences.subtitleLanguage ||
            (isArabic(t.language) && isArabic(active.preferences.subtitleLanguage)),
        );
        if (preferred) {
          $('#subtitles').value = `online:${preferred.id}`;
          setSubtitles();
        }
      }
    }
    $('#subtitle-status').textContent = tracks.length
      ? 'Choose an online track. Adjust delay if needed.'
      : 'No online subtitles found. You can open an SRT/VTT file.';
  } catch (error) {
    if (active === owner)
      $('#subtitle-status').textContent = `${error.message} You can open an SRT/VTT file.`;
  } finally {
    if (active === owner) $('#subtitle-find').disabled = false;
  }
}
function updateSubtitleStyleControls() {
  for (const [id, key] of [
    ['size', 'size'],
    ['color', 'color'],
    ['bg', 'bg'],
    ['bg-opacity', 'bgOpacity'],
    ['pos', 'pos'],
    ['align', 'align'],
  ])
    $('#subtitle-' + id).value = String(subtitleRenderer.style[key]);
  $('#subtitle-bg-opacity').disabled = subtitleRenderer.style.bg === 'none';
}
export async function advance(delta) {
  if (!queue || loading) return;
  cancelNext();
  const stopped = report('stop');
  // Respond to the press at once; the queue requests come next.
  const wasPlaying = !video().paused;
  loading = true;
  video().pause();
  updateTransport();
  await stopped;
  try {
    queue = await api(
      `/api/queues/${queue.id}`,
      { revision: queue.revision, index: queue.index + delta },
      'PATCH',
    );
    const next = await api(`/api/queues/${queue.id}`);
    const item = next.entries[next.index];
    if (!item.available && !canStream())
      throw new Error('This queued episode is unavailable. Download it, or use Queue to skip it.');
    // Not downloaded: stream it, at the resolution of the current stream when there is one.
    await play(item.id, item.title_id, {
      queueId: queue.id,
      replay: item.available && queue.mode === 'shuffle',
      stream: item.available
        ? null
        : { resolution: active?.stream?.resolution || lastResolution(), hint: { item } },
    });
  } catch (error) {
    if (loading && active && !active.stream?.failed) {
      loading = false;
      updateTransport();
      if (wasPlaying)
        video()
          .play()
          .catch(() => {});
    }
    toast(error.message);
    $('#player-message').textContent = error.message;
  }
}
function cancelNext() {
  clearInterval(countdown);
  countdown = null;
  $('#up-next').hidden = true;
}
export async function showQueue(queueId = queue?.id) {
  if (!queueId) return;
  const data = await api(`/api/queues/${queueId}`);
  modal(
    `<h2>${esc(data.name)} · ${data.mode === 'shuffle' ? 'Shuffle' : 'Queue'}</h2><div class="actions"><button data-queue-clear>Clear queue</button></div>${data.entries.map((item, index) => `<div class="row ${index === data.index ? 'queue-current' : ''}"><div class="row-main"><strong>${index + 1}. ${esc(item.name)}</strong><p class="meta">${esc(episodeLabel(item))} · ${item.available ? 'Downloaded' : canStream() ? 'Not downloaded' : 'Unavailable'}</p></div><button data-queue-play="${index}" ${item.available || canStream() ? '' : 'disabled'}>${item.available || !canStream() ? 'Play' : 'Stream'}</button><button data-queue-up="${index}" ${index === 0 ? 'disabled' : ''} aria-label="Move ${esc(item.name)} up">↑</button><button data-queue-remove="${index}" aria-label="Remove ${esc(item.name)}">Remove</button></div>`).join('') || '<p>Queue is empty.</p>'}`,
  );
  $('#dialog-content').onclick = async (event) => {
    const b = event.target.closest('button');
    if (!b) return;
    try {
      if (b.hasAttribute('data-queue-play')) {
        const index = Number(b.dataset.queuePlay);
        const sourceQueue =
          queue?.id === data.id ? data : await api(`/api/queues/${data.id}/fork`, {});
        const updated = await api(
          `/api/queues/${sourceQueue.id}`,
          { revision: sourceQueue.revision, index },
          'PATCH',
        );
        closeModal();
        const item = data.entries[index];
        await play(item.id, item.title_id, {
          queueId: updated.id,
          replay: item.available && data.mode === 'shuffle' && index !== data.index,
          stream: item.available
            ? null
            : { resolution: active?.stream?.resolution || lastResolution(), hint: { item } },
        });
        return;
      }
      let items = [...data.items];
      if (b.hasAttribute('data-queue-clear')) items = [];
      else if (b.hasAttribute('data-queue-remove')) items.splice(Number(b.dataset.queueRemove), 1);
      else if (b.hasAttribute('data-queue-up')) {
        const index = Number(b.dataset.queueUp);
        [items[index - 1], items[index]] = [items[index], items[index - 1]];
      } else return;
      const updated = await api(
        `/api/queues/${data.id}`,
        { revision: data.revision, items },
        'PATCH',
      );
      if (queue?.id === data.id) queue = updated;
      await showQueue(data.id);
    } catch (error) {
      toast(error.message);
    }
  };
}
function updateTransport() {
  if (!active) return;
  const duration = active.info.duration || 0;
  const position =
    active.pendingPosition != null
      ? active.pendingPosition
      : playbackPosition(video().currentTime, active.offset, duration);
  const slider = $('#player-seek');
  slider.max = String(duration);
  slider.disabled = loading || !duration;
  if (!scrubbing) slider.value = String(position);
  const shown = scrubbing ? Number(slider.value) : position;
  slider.style.setProperty('--played', `${duration ? (shown / duration) * 100 : 0}%`);
  // A stream's duration is unknown until its file has been read.
  $('#player-time').textContent = duration
    ? `${clockTime(shown)} / ${clockTime(duration)}`
    : clockTime(shown);
  slider.setAttribute('aria-valuetext', `${clockTime(shown)} of ${clockTime(duration)}`);
  iconButton(
    'player-toggle',
    video().paused ? 'play' : 'pause',
    video().paused ? 'Play' : 'Pause',
    'Space',
  );
  iconButton(
    'player-mute',
    video().muted || !video().volume ? 'muted' : 'volume',
    video().muted ? 'Unmute' : 'Mute',
    'M',
  );
  $('#player-volume').value = String(video().volume);
  const stream = active.stream;
  const waiting = loading || (!video().paused && video().readyState < 3);
  // A stream says where it is buffering and how it is going, not just that it is.
  $('#player-buffering').textContent = loading
    ? stream?.sourced
      ? `Buffering at ${clockTime(position)}`
      : 'Preparing…'
    : waiting
      ? 'Buffering…'
      : '';
  const live = stream?.sourced && waiting && stream.status ? startupView(stream.status) : null;
  $('#player-buffer-detail').textContent = live?.detail || '';
  $('#player-buffer-meter').hidden = !(
    live &&
    live.progress != null &&
    (stream.status.state === 'buffering' || stream.status.state === 'probing')
  );
  if (live?.progress != null)
    $('#player-buffer-bar').style.width = `${Math.round(live.progress * 100)}%`;
  $('#player-loading').hidden = !$('#player-buffering').textContent || !$('#stream-start').hidden;
  for (const id of [
    'player-toggle',
    'player-back',
    'player-forward',
    'convert',
    'audio',
    'chapters',
  ])
    $('#' + id).disabled = loading || (id === 'chapters' && !active.info.chapters?.length);
}
async function seekTo(target) {
  if (!active || loading) return;
  cancelNext();
  const ranges = Array.from({ length: video().seekable.length }, (_, i) => [
    video().seekable.start(i),
    video().seekable.end(i),
  ]);
  const plan = seekPlan(target, active.info.duration, active.offset, !!conversion, ranges);
  if (plan.restart) {
    await convert(plan.position, !video().paused);
    await report('seek');
  } else video().currentTime = plan.relative;
  updateTransport();
}
export function initPlayer() {
  subtitleRenderer = createSubtitleRenderer(video(), $('#subtitle-layer'));
  for (const [id, choices] of [
    ['size', subtitleSizes],
    ['color', subtitleColors],
    ['bg', subtitleBackgrounds],
  ])
    $('#subtitle-' + id).innerHTML = choices
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join('');
  updateSubtitleStyleControls();
  for (const [id, key] of [
    ['size', 'size'],
    ['color', 'color'],
    ['bg', 'bg'],
    ['bg-opacity', 'bgOpacity'],
    ['pos', 'pos'],
    ['align', 'align'],
  ])
    $('#subtitle-' + id).onchange = () => {
      const value = $('#subtitle-' + id).value;
      subtitleRenderer.set({
        ...subtitleRenderer.style,
        [key]: ['pos', 'bgOpacity'].includes(key) ? Number(value) : value,
      });
      updateSubtitleStyleControls();
    };
  $('#subtitle-style-reset').onclick = () => {
    subtitleRenderer.reset();
    updateSubtitleStyleControls();
  };
  $('#subtitle-pos').oninput = () => {
    const value = $('#subtitle-pos').value;
    if (value !== '' && Number.isFinite(Number(value)))
      subtitleRenderer.set({ ...subtitleRenderer.style, pos: Number(value) });
  };
  $('#subtitle-appearance').ontoggle = () =>
    subtitleRenderer.preview($('#subtitle-appearance').open && !$('#player-subtitles').hidden);
  const changeSubtitleDelay = (normalize) => {
    if (!active) return;
    const delay = Number($('#subtitle-delay').value);
    active.subtitleDelay = Number.isFinite(delay) ? Math.max(-120, Math.min(120, delay)) : 0;
    if (normalize) $('#subtitle-delay').value = String(active.subtitleDelay);
    try {
      localStorage.setItem(`mw:subsync:${active.item.id}`, String(active.subtitleDelay));
    } catch {}
    active.syncSubtitles?.();
  };
  $('#subtitle-delay').onchange = () => changeSubtitleDelay(true);
  $('#subtitle-delay').oninput = () => {
    if ($('#subtitle-delay').value !== '') changeSubtitleDelay(false);
  };
  $('#subtitle-sync-reset').onclick = () => {
    $('#subtitle-delay').value = '0';
    $('#subtitle-delay').onchange();
  };
  $('#subtitle-find').onclick = () => void findSubtitles();
  $('#subtitle-file').onchange = async () => {
    const file = $('#subtitle-file').files[0] || active?.subtitleUpload,
      owner = active;
    if (!file || !owner) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('Choose a subtitle file smaller than 2 MB.');
      const text = srtToVtt(
        decodeSubtitle(
          await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('This subtitle file could not be read.'));
            reader.readAsArrayBuffer(file);
          }),
          $('#subtitle-file-encoding').value || owner.preferences.subtitleLanguage,
        ),
      );
      if (!/(?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s*-->/.test(text))
        throw new Error('Choose a valid SRT or WebVTT file.');
      if (active !== owner) return;
      active.subtitleUpload = file;
      active.subtitleUserChoice = true;
      if (active.subtitleFile) URL.revokeObjectURL(active.subtitleFile);
      active.subtitleFile = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
      addFileOption(file.name);
      $('#subtitles').value = 'file';
      setSubtitles();
    } catch (error) {
      if (active === owner) $('#subtitle-status').textContent = error.message;
    } finally {
      if (active === owner) $('#subtitle-file').value = '';
    }
  };
  $('#subtitle-file-encoding').onchange = () => {
    if (active?.subtitleUpload) void $('#subtitle-file').onchange();
  };
  for (const [id, icon, label] of [
    ['player-close', 'back', 'Back to library'],
    ['player-toggle', 'play', 'Play'],
    ['player-back', 'rewind', 'Rewind 10 seconds'],
    ['player-forward', 'forward', 'Forward 10 seconds'],
    ['player-mute', 'volume', 'Mute'],
    ['player-fullscreen', 'fullscreen', 'Fullscreen'],
    ['previous', 'previous', 'Previous episode'],
    ['next', 'next', 'Next episode'],
    ['player-queue', 'queue', 'Episode queue'],
    ['chapters', 'chapters', 'Chapters'],
    ['player-settings-toggle', 'settings', 'Playback settings'],
    ['player-settings-close', 'close', 'Close playback settings'],
    ['player-subtitles-toggle', 'subtitles', 'Subtitles'],
    ['player-subtitles-close', 'close', 'Close subtitles'],
  ])
    iconButton(id, icon, label);
  $('#player-settings-toggle').onclick = () => {
    const open = $('#player-settings').hidden;
    closeSubtitles();
    $('#player-settings').hidden = !open;
    $('#player-settings-toggle').setAttribute('aria-expanded', String(open));
    showControls();
    if (open) $('#player-settings-close').focus();
  };
  $('#player-settings-close').onclick = () => closeSettings(true);
  $('#player-subtitles-toggle').onclick = () =>
    $('#player-subtitles').hidden ? openSubtitles() : closeSubtitles(true);
  $('#player-subtitles-settings').onclick = openSubtitles;
  $('#player-subtitles-close').onclick = () => closeSubtitles(true);
  $('#player').addEventListener('pointermove', () => {
    keyboardControls = false;
    showControls();
  });
  $('#player').addEventListener('pointerdown', (event) => {
    keyboardControls = false;
    if (!event.target.closest('#player-settings, #player-settings-toggle')) closeSettings();
    if (
      !event.target.closest(
        '#player-subtitles, #player-subtitles-toggle, #player-subtitles-settings',
      )
    )
      closeSubtitles();
    showControls();
  });
  $('#player').addEventListener('focusin', showControls);
  document.addEventListener('keydown', (event) => {
    if (!active || $('#dialog').open) return;
    keyboardControls = true;
    showControls();
    if ((event.key === 'Escape' || event.keyCode === 10009) && !$('#player-subtitles').hidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeSubtitles(true);
      return;
    }
    if ((event.key === 'Escape' || event.keyCode === 10009) && !$('#player-settings').hidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeSettings(true);
      return;
    }
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return;
    const key = event.key.toLowerCase();
    if (
      (key === ' ' && event.target.tagName !== 'BUTTON') ||
      key === 'k' ||
      event.keyCode === 10252
    ) {
      event.preventDefault();
      if (!loading) $('#player-toggle').click();
    } else if (key === 'm') $('#player-mute').click();
    else if (key === 'f') $('#player-fullscreen').click();
    else if (key === 'c') $('#player-subtitles-toggle').click();
    else if (event.keyCode === 415 && !loading)
      void video()
        .play()
        .catch((e) => toast(e.message));
    else if (event.keyCode === 19) video().pause();
  });
  $('#player-toggle').onclick = () => {
    // After a long pause the server stops an unwatched stream conversion; restart it here.
    if (video().paused && active?.stream?.stale && !loading)
      return void convert(absolutePosition(), true).catch((e) => toast(e.message));
    if (video().paused)
      video()
        .play()
        .catch((e) => toast(e.message));
    else video().pause();
  };
  $('#stream-start-actions').onclick = (event) => {
    const button = event.target.closest('[data-stream-action]');
    const owner = active;
    if (!button || !owner?.stream) return;
    const action = button.dataset.streamAction;
    if (action === 'close') return void closePlayer();
    if (action === 'download') {
      const itemId = owner.item.id;
      return void closePlayer().then(() => releases(itemId));
    }
    button.disabled = true;
    if (action === 'stop-others')
      return void stopOtherStreams(owner)
        .then(() => active === owner && restartStream(owner))
        .catch((e) => {
          button.disabled = false;
          toast(e.message);
        });
    const resolution =
      action === 'other-resolution' ? Number(button.dataset.resolution) : owner.stream.resolution;
    if (action === 'other-resolution') saveResolution(resolution);
    void restartStream(owner, {
      resolution,
      forceTranscode: owner.stream.forceTranscode || action === 'compatibility',
    });
  };
  $('#stream-quality-options').onclick = (event) => {
    const card = event.target.closest('[data-stream-resolution]');
    if (card && !card.disabled) void changeResolution(Number(card.dataset.streamResolution));
  };
  // Next Up from a warm session: prepare the next episode at 80 %.
  video().addEventListener('timeupdate', () => {
    const stream = active?.stream;
    const duration = active?.info.duration;
    if (!stream?.id || stream.nextPrepared || loading || !duration) return;
    if (!queue || queue.index >= queue.items.length - 1) return;
    if (absolutePosition() < duration * 0.8) return;
    stream.nextPrepared = true;
    api(`/api/streams/${stream.id}/prepare-next`, {}).catch(() => {});
  });
  $('#player-back').onclick = () =>
    seekTo((video().currentTime || 0) + (active?.offset || 0) - 10).catch((e) => toast(e.message));
  $('#player-forward').onclick = () =>
    seekTo((video().currentTime || 0) + (active?.offset || 0) + 10).catch((e) => toast(e.message));
  $('#player-seek').oninput = () => {
    scrubbing = true;
    showControls();
    updateTransport();
  };
  $('#player-seek').onchange = () => {
    const target = Number($('#player-seek').value);
    scrubbing = false;
    showControls();
    seekTo(target).catch((e) => {
      toast(e.message);
      updateTransport();
    });
  };
  $('#player-seek').onblur = () => {
    scrubbing = false;
    updateTransport();
  };
  $('#player-mute').onclick = () => {
    video().muted = !video().muted;
  };
  $('#player-volume').oninput = () => {
    video().volume = Number($('#player-volume').value);
    video().muted = false;
  };
  $('#player-fullscreen').onclick = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if ($('#player').requestFullscreen) await $('#player').requestFullscreen();
      else toast('Fullscreen is unavailable in this browser');
    } catch (e) {
      toast(e.message);
    }
  };
  document.addEventListener('fullscreenchange', () => {
    iconButton(
      'player-fullscreen',
      document.fullscreenElement ? 'exitFullscreen' : 'fullscreen',
      document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen',
      'F',
    );
  });
  video().onclick = () => {
    if (!loading) $('#player-toggle').click();
  };
  video().ondblclick = () => $('#player-fullscreen').click();
  for (const event of ['playing', 'pause', 'waiting'])
    video().addEventListener(event, showControls);
  for (const event of [
    'timeupdate',
    'durationchange',
    'loadedmetadata',
    'progress',
    'waiting',
    'playing',
    'pause',
    'seeking',
    'seeked',
    'volumechange',
  ])
    video().addEventListener(event, updateTransport);
  $('#player-close').onclick = () => void closePlayer();
  $('#previous').onclick = () => void advance(-1);
  $('#next').onclick = () => void advance(1);
  $('#player-queue').onclick = () => showQueue().catch((e) => toast(e.message));
  const restartConversion = () =>
    convert((video().currentTime || 0) + (active?.offset || 0), !video().paused).catch((e) =>
      toast(e.message),
    );
  // For a stream, compatibility playback must ask for a transcode; resending the same
  // capabilities would repeat the plan that just failed.
  $('#convert').onclick = () => {
    if (active?.stream) active.stream.forceTranscode = true;
    return restartConversion();
  };
  $('#audio').onchange = restartConversion;
  $('#subtitles').onchange = () => {
    if (active) active.subtitleUserChoice = true;
    setSubtitles();
  };
  $('#chapters').onclick = () => {
    modal(
      `<h2>Chapters</h2>${(active?.info.chapters || []).map((c, i) => `<button class="release" data-chapter="${i}">${esc(c.name)} · ${Math.floor(c.start / 60)}:${String(Math.floor(c.start % 60)).padStart(2, '0')}</button>`).join('')}`,
    );
    $('#dialog-content').onclick = (e) => {
      const b = e.target.closest('[data-chapter]');
      if (!b) return;
      const chapter = active.info.chapters[Number(b.dataset.chapter)];
      closeModal();
      seekTo(chapter.start).catch((e) => toast(e.message));
    };
  };
  video().addEventListener('pause', () => void report('pause'));
  video().addEventListener('seeked', () => void report('seek'));
  video().addEventListener('error', () => {
    if (!loading && active)
      $('#player-message').textContent =
        'This format may need compatibility playback. Select that button below.';
  });
  video().addEventListener('ended', async () => {
    if (!active || loading) return;
    if (
      !atTitleEnd(
        playbackPosition(video().currentTime, active.offset, active.info.duration),
        active.info.duration,
      )
    ) {
      $('#player-message').textContent =
        'Playback stopped before the end. Retry compatibility playback to continue.';
      await report('pause');
      return;
    }
    await report('ended');
    if (!queue || queue.index >= queue.items.length - 1) return;
    // From a local file, an episode that is not downloaded is streamed only on request.
    const following = active.title.items?.find((i) => i.id === queue.items[queue.index + 1]);
    const offerStream = !active.stream && following && !following.available && canStream();
    $('#up-next').hidden = false;
    let seconds = 10;
    $('#up-next-label').textContent = offerStream
      ? 'The next episode is not downloaded'
      : 'Next episode is ready';
    $('#up-next-play').textContent = offerStream ? 'Stream it' : 'Play now';
    if (active.preferences.autoplay && !offerStream)
      countdown = setInterval(() => {
        $('#up-next-label').textContent = `Next episode in ${--seconds} seconds`;
        if (seconds <= 0) void advance(1);
      }, 1000);
  });
  $('#up-next-play').onclick = () => void advance(1);
  $('#up-next-cancel').onclick = cancelNext;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void report('pause', true);
  });
  window.addEventListener('pagehide', () => {
    void report('stop', true);
    const ids = [active?.stream?.id, active?.stream?.switching?.id].filter(Boolean);
    for (const id of ids)
      fetch(`/api/streams/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        keepalive: true,
      }).catch(() => {});
  });
}
