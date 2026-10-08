import { clockTime, playbackPosition, seekPlan, atTitleEnd } from './playback-time.js';
import { $, esc, api, toast, modal, closeModal, episodeLabel } from './core.js';
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
  if (!active || video().paused || loading || keyboardControls || !$('#player-settings').hidden)
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
  if (!active || loading) return;
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
  await report('stop');
  loading = true;
  video().pause();
  await releaseConversion();
  video().removeAttribute('src');
  video().load();
  active = null;
  clearTimeout(controlsTimer);
  closeSettings();
  queue = null;
  loading = false;
  $('#player').hidden = true;
  document.body.classList.remove('player-open');
  $('#shell').removeAttribute('inert');
  window.dispatchEvent(new Event('library-changed'));
}
export async function play(itemId, titleId, { replay = false, queueId = null } = {}) {
  clearInterval(timer);
  cancelNext();
  await report('stop');
  loading = true;
  video().pause();
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
    };
    scrubbing = false;
    updateTransport();
    $('#player').hidden = false;
    document.body.classList.add('player-open');
    closeSettings();
    $('#shell').setAttribute('inert', '');
    $('#player-title').textContent = title.name;
    $('#player-episode').textContent =
      title.kind === 'movie' ? '' : `${episodeLabel(item)}${item.name ? ' · ' + item.name : ''}`;
    $('#player-message').textContent = '';
    $('#audio').innerHTML = info.audio
      .map(
        (t) =>
          `<option value="${t.index}">${esc(t.language)} · ${esc(t.title || t.codec)} ${t.channels || ''}</option>`,
      )
      .join('');
    $('#subtitles').innerHTML =
      '<option value="">Off</option>' +
      info.subtitles
        .filter((t) => ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text'].includes(t.codec))
        .map(
          (t) =>
            `<option value="${t.index}">${esc(t.language)} · ${esc(t.title || t.codec)}</option>`,
        )
        .join('');
    $('#previous').disabled = !queue || queue.index <= 0;
    $('#next').disabled = !queue || queue.index >= queue.items.length - 1;
    $('#player-queue').disabled = !queue;
    $('#previous').hidden = $('#next').hidden = $('#player-queue').hidden = !queue;
    $('#chapters').hidden = !info.chapters?.length;
    $('#chapters').disabled = !info.chapters?.length;
    const preferred = info.audio.find(
      (t) => preferences.audioLanguage && t.language === preferences.audioLanguage,
    );
    if (preferred) $('#audio').value = String(preferred.index);
    if (info.direct && (!preferred || preferred.index === info.audio[0]?.index))
      await source(`/api/items/${itemId}/file`, session.position);
    else await convert(session.position);
    if (preferences.subtitleMode === 'preferred') {
      const track = info.subtitles.find((t) => t.language === preferences.subtitleLanguage);
      if (track) {
        $('#subtitles').value = String(track.index);
        setSubtitles();
      }
    }
    loading = false;
    active.pendingPosition = null;
    updateTransport();
    timer = setInterval(() => void report(), 10000);
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
async function source(url, seek = 0, autoplay = true) {
  video()
    .querySelectorAll('track')
    .forEach((t) => t.remove());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Playback could not start. Try compatibility playback.'));
    }, 25000);
    const error = () => {
      cleanup();
      reject(new Error('This format needs compatibility playback.'));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      video().removeEventListener('error', error);
      video().onloadedmetadata = null;
    };
    video().addEventListener('error', error, { once: true });
    video().onloadedmetadata = () => {
      cleanup();
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
      hls = new window.Hls({ startPosition: 0, lowLatencyMode: false });
      hls.loadSource(url);
      hls.attachMedia(video());
      hls.on(window.Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          cleanup();
          $('#player-message').textContent = 'Playback failed. Try compatibility playback again.';
          reject(new Error('Compatibility playback failed'));
        }
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
function setSubtitles() {
  video()
    .querySelectorAll('track')
    .forEach((t) => t.remove());
  const index = $('#subtitles').value;
  if (index === '' || !active) return;
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = 'Selected subtitles';
  track.src = `/api/items/${active.item.id}/subtitles/${index}?offset=${active.offset}`;
  track.default = true;
  video().appendChild(track);
  track.addEventListener('load', () => (track.track.mode = 'showing'));
  track.addEventListener('error', () => toast('These subtitles could not be loaded'));
}
export async function advance(delta) {
  if (!queue || loading) return;
  cancelNext();
  await report('stop');
  try {
    queue = await api(
      `/api/queues/${queue.id}`,
      { revision: queue.revision, index: queue.index + delta },
      'PATCH',
    );
    const next = await api(`/api/queues/${queue.id}`);
    const item = next.entries[next.index];
    if (!item.available)
      throw new Error('This queued episode is unavailable. Download it, or use Queue to skip it.');
    await play(item.id, item.title_id, { queueId: queue.id, replay: queue.mode === 'shuffle' });
  } catch (error) {
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
    `<h2>${esc(data.name)} · ${data.mode === 'shuffle' ? 'Shuffle' : 'Queue'}</h2><div class="actions"><button data-queue-clear>Clear queue</button></div>${data.entries.map((item, index) => `<div class="row ${index === data.index ? 'queue-current' : ''}"><div class="row-main"><strong>${index + 1}. ${esc(item.name)}</strong><p class="meta">${esc(episodeLabel(item))} · ${item.available ? 'Downloaded' : 'Unavailable'}</p></div><button data-queue-play="${index}" ${item.available ? '' : 'disabled'}>Play</button><button data-queue-up="${index}" ${index === 0 ? 'disabled' : ''} aria-label="Move ${esc(item.name)} up">↑</button><button data-queue-remove="${index}" aria-label="Remove ${esc(item.name)}">Remove</button></div>`).join('') || '<p>Queue is empty.</p>'}`,
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
          replay: data.mode === 'shuffle' && index !== data.index,
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
  $('#player-time').textContent = `${clockTime(shown)} / ${clockTime(duration)}`;
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
  $('#player-buffering').textContent = loading
    ? 'Preparing…'
    : !video().paused && video().readyState < 3
      ? 'Buffering…'
      : '';
  $('#player-loading').hidden = !$('#player-buffering').textContent;
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
  ])
    iconButton(id, icon, label);
  $('#player-settings-toggle').onclick = () => {
    const open = $('#player-settings').hidden;
    $('#player-settings').hidden = !open;
    $('#player-settings-toggle').setAttribute('aria-expanded', String(open));
    showControls();
    if (open) $('#player-settings-close').focus();
  };
  $('#player-settings-close').onclick = () => closeSettings(true);
  $('#player').addEventListener('pointermove', () => {
    keyboardControls = false;
    showControls();
  });
  $('#player').addEventListener('pointerdown', (event) => {
    keyboardControls = false;
    if (!event.target.closest('#player-settings, #player-settings-toggle')) closeSettings();
    showControls();
  });
  $('#player').addEventListener('focusin', showControls);
  document.addEventListener('keydown', (event) => {
    if (!active || $('#dialog').open) return;
    keyboardControls = true;
    showControls();
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
    else if (event.keyCode === 415 && !loading)
      void video()
        .play()
        .catch((e) => toast(e.message));
    else if (event.keyCode === 19) video().pause();
  });
  $('#player-toggle').onclick = () => {
    if (video().paused)
      video()
        .play()
        .catch((e) => toast(e.message));
    else video().pause();
  };
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
  $('#convert').onclick = () =>
    convert((video().currentTime || 0) + (active?.offset || 0), !video().paused).catch((e) =>
      toast(e.message),
    );
  $('#audio').onchange = $('#convert').onclick;
  $('#subtitles').onchange = setSubtitles;
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
    $('#up-next').hidden = false;
    let seconds = 10;
    $('#up-next-label').textContent = 'Next episode is ready';
    if (active.preferences.autoplay)
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
  window.addEventListener('pagehide', () => void report('stop', true));
}
