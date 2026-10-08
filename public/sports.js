import { $, esc, api, toast, modal, closeModal, heading, empty } from './core.js';

let schedule = null,
  channels = [],
  liveSession = null,
  hls = null,
  heartbeat = null,
  playbackGeneration = 0;
const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
function dateKey(time = new Date()) {
  return `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}-${String(time.getDate()).padStart(2, '0')}`;
}
const time = (stamp) =>
  new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(stamp);
const dayLabel = (date) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(date + 'T12:00:00Z'));
function sportsUrl(values = {}) {
  const url = new URL(location.hash.slice(1), 'http://local');
  for (const [key, value] of Object.entries(values))
    value ? url.searchParams.set(key, value) : url.searchParams.delete(key);
  return '#/sports' + url.search;
}
function dateOffset(date, delta) {
  const day = new Date(date + 'T12:00:00Z');
  day.setUTCDate(day.getUTCDate() + delta);
  return day.toISOString().slice(0, 10);
}
const option = (value, label, current) =>
  `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`;
const statusLabel = { live: 'On now', upcoming: 'Upcoming', finished: 'Ended' };
function eventRow(event, admin) {
  const languages = [...new Set(event.channels.map((c) => c.language).filter(Boolean))];
  return `<article class="sports-event"><div class="sports-event-time"><time datetime="${new Date(event.start).toISOString()}">${esc(time(event.start))}</time><span class="sports-status ${event.status}">${statusLabel[event.status]}</span></div><div class="sports-event-main"><p class="sports-competition">${esc([event.sport, event.competition].filter(Boolean).join(' · '))}</p><h3>${esc(event.title)}</h3>${event.subtitle ? `<p class="meta">${esc(event.subtitle)}</p>` : ''}<p class="meta">${event.channels.length ? `${event.channels.length} channel${event.channels.length === 1 ? '' : 's'}${languages.length ? ' · ' + esc(languages.join(' / ')) : ''}` : 'No channel linked'} · Until ${esc(time(event.end))}</p></div><div class="sports-event-actions">${event.status !== 'finished' && event.channels.length ? `<button class="${event.status === 'live' ? 'primary' : ''}" data-action="sports-watch" data-id="${esc(event.id)}">${event.status === 'live' ? 'Watch' : 'View channels'}</button>` : ''}${admin && event.source === 'manual' ? `<button class="quiet" data-action="sports-edit" data-id="${esc(event.id)}">Edit</button>` : ''}</div></article>`;
}
export async function sportsPage(url, user) {
  const date = url.searchParams.get('date') || dateKey();
  schedule = await api(`/api/sports?${new URLSearchParams({ date, timezone: timezone() })}`);
  const sport = url.searchParams.get('sport') || '',
    status = url.searchParams.get('status') || '',
    query = url.searchParams.get('q') || '';
  const admin = user.role === 'admin';
  const matching = schedule.events.filter(
    (e) =>
      (!sport || e.sport === sport) &&
      `${e.title} ${e.competition}`.toLowerCase().includes(query.toLowerCase()),
  );
  const filtered = matching.filter((e) => !status || e.status === status);
  const count = (value) => matching.filter((e) => !value || e.status === value).length;
  let html = heading(
    'Live sports',
    '',
    admin
      ? '<div class="actions"><button data-action="sports-add">Add event</button><button class="quiet" data-action="sports-manage">Manage live TV</button></div>'
      : '',
  ).replace('page-heading', 'page-heading sports-heading');
  html += `<div class="sports-datebar"><div class="actions"><a class="sports-day" href="${esc(sportsUrl({ date: dateOffset(date, -1) }))}" aria-label="Previous day">←</a><h2>${esc(dateLabel(date))}</h2><a class="sports-day" href="${esc(sportsUrl({ date: dateOffset(date, 1) }))}" aria-label="Next day">→</a></div><div class="actions"><a class="sports-day ${date === dateKey() ? 'selected' : ''}" href="${esc(sportsUrl({ date: '' }))}">Today</a><label class="sports-date-label">Date<input id="sports-date" type="date" value="${esc(date)}" required></label></div></div>`;
  html += `<div class="sports-filters"><nav class="sports-tabs" aria-label="Event status">${[
    ['', 'All events'],
    ['live', 'On now'],
    ['upcoming', 'Upcoming'],
  ]
    .map(
      ([value, label]) =>
        `<a href="${esc(sportsUrl({ status: value }))}" ${status === value ? 'aria-current="page"' : ''}>${label}<span>${count(value)}</span></a>`,
    )
    .join(
      '',
    )}</nav><form id="sports-filter" class="sports-filter-form"><label>Sport<select name="sport">${option('', 'All sports', sport)}${schedule.sports.map((s) => option(s, s, sport)).join('')}</select></label><label>Find an event<input name="q" type="search" value="${esc(query)}" placeholder="Team, event or competition"></label><button>Search</button></form></div>`;
  if (['missing', 'unavailable', 'stale', 'refreshing'].includes(schedule.guideStatus)) {
    const message =
      schedule.guideStatus === 'refreshing'
        ? 'The programme guide is updating.'
        : schedule.guideStatus === 'stale'
          ? 'The guide could not be updated. Showing the saved schedule.'
          : schedule.guideStatus === 'unavailable'
            ? 'The programme guide is unavailable. Check the guide source or add events.'
            : schedule.guideConfigured
              ? 'The programme guide has not been refreshed.'
              : 'Connect a programme guide to fill the daily schedule. Events can also be added manually.';
    html += `<p class="sports-notice" role="status">${esc(message)}${admin ? ' <button class="text-button" data-action="sports-manage">Manage live TV</button>' : ''}</p>`;
  }
  if (!filtered.length)
    html += empty(
      schedule.events.length ? 'No matching events' : 'No events listed for this day',
      schedule.events.length
        ? 'Try another sport or search.'
        : schedule.channels
          ? 'Check another day, open a channel below, or add a scheduled event.'
          : 'Import your live TV playlist to connect channels to matches and events.',
      admin ? '<button data-action="sports-add">Add event</button>' : '',
    );
  for (const [state, title] of [
    ['live', 'On now'],
    ['upcoming', date === dateKey() ? 'Later today' : 'Upcoming'],
    ['finished', 'Finished'],
  ]) {
    const items = filtered.filter((e) => e.status === state);
    if (items.length)
      html += `<section class="sports-section"><div class="section-heading"><h2>${title}</h2><span class="meta">${items.length} event${items.length === 1 ? '' : 's'}</span></div>${items.map((e) => eventRow(e, admin)).join('')}</section>`;
  }
  html += `<section class="sports-channels section"><button data-action="sports-channels">Browse channels (${schedule.channels})</button><p class="meta">Times shown in ${esc(schedule.timezone)}. “On now” follows the scheduled broadcast time.</p></section>`;
  return html;
}
function dateLabel(date) {
  return `${date === dateKey() ? 'Today · ' : ''}${dayLabel(date)}`;
}
export function bindSportsFilters() {
  $('#sports-date').onchange = (e) => {
    if (e.target.value) location.hash = sportsUrl({ date: e.target.value });
  };
  $('#sports-filter').onsubmit = (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    location.hash = sportsUrl({ sport: data.get('sport'), q: data.get('q') });
  };
  $('#sports-filter select').onchange = () =>
    $('#sports-filter').requestSubmit
      ? $('#sports-filter').requestSubmit()
      : $('#sports-filter').dispatchEvent(new Event('submit', { cancelable: true }));
}
async function loadChannels() {
  channels = (await api('/api/live/channels')).items;
  return channels;
}
function channelButtons(items) {
  return items
    .map(
      (c) =>
        `<button class="sports-channel" data-action="sports-play" data-id="${esc(c.id)}"><strong>${esc(c.name)}</strong><span class="meta">${esc([c.language, c.quality].filter(Boolean).join(' · '))}</span></button>`,
    )
    .join('');
}
function bindDialog(context) {
  $('#dialog-content').onclick = (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    b.disabled = true;
    void sportsAction(b, context)
      .catch((error) => toast(error.message))
      .finally(() => {
        b.disabled = false;
      });
  };
}
export async function sportsAction(button, context) {
  const action = button.dataset.action,
    key = button.dataset.id;
  if (action === 'sports-watch') {
    const event = schedule.events.find((e) => e.id === key);
    modal(
      `<h2>${esc(event.title)}</h2><p class="meta">${event.status === 'upcoming' ? `Scheduled for ${esc(time(event.start))}. Opening a channel plays its current broadcast.` : 'Choose a channel'}</p><div class="sports-channel-list">${channelButtons(event.channels)}</div>`,
    );
    bindDialog(context);
  } else if (action === 'sports-channels') {
    await loadChannels();
    modal(
      '<h2>Live channels</h2><label class="section">Find a channel<input id="channel-search" type="search"></label><div id="channel-results" class="sports-channel-list"></div>',
    );
    const render = () => {
      const q = $('#channel-search').value.toLowerCase();
      const found = channels.filter((c) => `${c.name} ${c.language}`.toLowerCase().includes(q));
      $('#channel-results').innerHTML =
        channelButtons(found.slice(0, 100)) +
        (found.length > 100
          ? '<p class="meta">Search to narrow the channel list.</p>'
          : !found.length
            ? '<p class="meta">No channels found.</p>'
            : '');
    };
    $('#channel-search').oninput = render;
    render();
    bindDialog(context);
  } else if (action === 'sports-play') {
    closeModal();
    await context.closeVod();
    await playLive(key);
  } else if (action === 'sports-manage') {
    const status = await api('/api/admin/live');
    modal(
      `<h2>Manage live TV</h2><p class="meta">${status.channels} channels · Guide: ${esc(status.guideStatus)}${status.guideUpdatedAt ? ' · Updated ' + esc(new Date(status.guideUpdatedAt).toLocaleString()) : ''}</p><form id="live-import" class="form section"><h3>Import playlist</h3><label>M3U file<input name="playlist" type="file" accept=".m3u,.m3u8,text/plain" required></label><p class="meta">Replaces the channel list. Provider credentials stay on the server.</p><button>Import channels</button></form><form id="live-settings" class="form section"><h3>Programme guide</h3><label>XMLTV guide URL<input name="guideUrl" type="url" placeholder="${status.guideConfigured ? 'Leave blank to keep the current guide' : 'https://provider.example/guide.xml'}" autocomplete="off"></label><label>Simultaneous channels<select name="maxConnections">${[1, 2, 3, 4].map((n) => option(String(n), String(n), String(status.maxConnections))).join('')}</select></label><p class="meta">Use the connection limit allowed by your provider.</p><div class="actions"><button>Save settings</button><button type="button" data-action="sports-refresh-guide">Refresh guide</button></div><p id="live-settings-result" class="meta" role="status"></p></form>`,
    );
    bindDialog(context);
    $('#live-import').onsubmit = async (e) => {
      e.preventDefault();
      const b = e.target.querySelector('button');
      b.disabled = true;
      try {
        const file = e.target.elements.playlist.files[0];
        if (file.size > 12 * 1024 * 1024) throw Error('Playlist must be smaller than 12 MB');
        const playlist = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(Error('The playlist could not be read'));
          reader.readAsText(file);
        });
        await api('/api/admin/live/import', { playlist });
        closeModal();
        await context.refresh();
        toast('Channels imported');
      } catch (error) {
        toast(error.message);
      } finally {
        b.disabled = false;
      }
    };
    $('#live-settings').onsubmit = async (e) => {
      e.preventDefault();
      const b = e.target.querySelector('button');
      b.disabled = true;
      const data = new FormData(e.target),
        guideUrl = String(data.get('guideUrl')).trim();
      try {
        await api(
          '/api/admin/live',
          { ...(guideUrl ? { guideUrl } : {}), maxConnections: Number(data.get('maxConnections')) },
          'PATCH',
        );
        $('#live-settings-result').textContent =
          'Settings saved. Refresh the guide to update events.';
        await context.refresh();
      } catch (error) {
        toast(error.message);
      } finally {
        b.disabled = false;
      }
    };
  } else if (action === 'sports-refresh-guide') {
    button.textContent = 'Refreshing…';
    try {
      const result = await api('/api/admin/live/refresh', {});
      toast(
        result.guideStatus === 'ready'
          ? 'Programme guide updated'
          : result.guideConfigured
            ? 'Guide update failed. Check the source and try again.'
            : 'Add a guide URL first',
      );
      await context.refresh();
      if ($('#live-settings-result'))
        $('#live-settings-result').textContent = `Guide: ${result.guideStatus}`;
    } finally {
      button.textContent = 'Refresh guide';
    }
  } else if (action === 'sports-add' || action === 'sports-edit') {
    await loadChannels();
    const event = action === 'sports-edit' ? schedule.events.find((e) => e.id === key) : null;
    const localInput = (stamp) => {
      const d = new Date(stamp);
      return (
        dateKey(d) +
        'T' +
        String(d.getHours()).padStart(2, '0') +
        ':' +
        String(d.getMinutes()).padStart(2, '0')
      );
    };
    const date = schedule.date;
    modal(
      `<h2>${event ? 'Edit event' : 'Add event'}</h2><form id="sports-event-form" class="form section"><label>Match or event<input name="title" value="${esc(event?.title || '')}" maxlength="180" required placeholder="Home team vs Away team"></label><div class="sports-form-pair"><label>Sport<select name="sport">${schedule.sports.map((s) => option(s, s, event?.sport || 'Football')).join('')}</select></label><label>Competition<input name="competition" value="${esc(event?.competition || '')}" maxlength="100"></label></div><div class="sports-form-pair"><label>Starts<input name="start" type="datetime-local" value="${event ? localInput(event.start) : date + 'T18:00'}" required></label><label>Ends<input name="end" type="datetime-local" value="${event ? localInput(event.end) : date + 'T20:00'}" required></label></div><p class="meta">Times in ${esc(timezone())}.</p><fieldset class="sports-channel-picker"><legend>Channels</legend><label>Find a channel<input id="event-channel-search" type="search"></label><div id="event-channel-options"></div><p id="event-channel-count" class="meta" role="status"></p></fieldset><div class="actions"><button class="primary">Save event</button>${event ? `<button type="button" data-action="sports-delete" data-id="${esc(event.id)}">Delete event</button>` : ''}</div></form>`,
    );
    bindDialog(context);
    const selected = new Set(event?.channelIds || []);
    const render = () => {
      const q = $('#event-channel-search').value.toLowerCase();
      const items = channels
        .filter((c) => `${c.name} ${c.language}`.toLowerCase().includes(q))
        .sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)))
        .slice(0, 80);
      $('#event-channel-options').innerHTML =
        items
          .map(
            (c) =>
              `<label class="check"><input type="checkbox" value="${esc(c.id)}" ${selected.has(c.id) ? 'checked' : ''}>${esc(c.name)} <span class="meta">${esc(c.language)}</span></label>`,
          )
          .join('') || '<p class="meta">No channels found.</p>';
      $('#event-channel-count').textContent =
        `${selected.size} selected${channels.length > 80 ? ' · Search to find more channels' : ''}`;
    };
    $('#event-channel-search').oninput = render;
    $('#event-channel-options').onchange = (e) => {
      if (e.target.checked) selected.add(e.target.value);
      else selected.delete(e.target.value);
      $('#event-channel-count').textContent = `${selected.size} selected`;
    };
    render();
    $('#sports-event-form').onsubmit = async (e) => {
      e.preventDefault();
      const b = e.target.querySelector('button');
      b.disabled = true;
      try {
        const data = Object.fromEntries(new FormData(e.target));
        await api(
          `/api/admin/sports/events${event ? '/' + event.id : ''}`,
          {
            title: data.title,
            sport: data.sport,
            competition: data.competition,
            start: new Date(data.start).toISOString(),
            end: new Date(data.end).toISOString(),
            channelIds: [...selected],
          },
          event ? 'PUT' : 'POST',
        );
        closeModal();
        await context.refresh();
        toast('Event saved');
      } catch (error) {
        toast(error.message);
      } finally {
        b.disabled = false;
      }
    };
  } else if (action === 'sports-delete') {
    await api(`/api/admin/sports/events/${key}`, {}, 'DELETE');
    closeModal();
    await context.refresh();
    toast('Event deleted');
  }
}
export const livePlaying = () => !!$('#live-player');
export async function closeLive() {
  ++playbackGeneration;
  clearInterval(heartbeat);
  heartbeat = null;
  const session = liveSession;
  liveSession = null;
  if (hls) {
    hls.destroy();
    hls = null;
  }
  const video = $('#live-video');
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  const player = $('#live-player'),
    restore = player?.restoreFocus;
  player?.remove();
  restore?.focus();
  if (document.fullscreenElement?.id === 'live-video')
    await document.exitFullscreen().catch(() => {});
  if (session)
    await api(`/api/live/sessions/${session.id}`, { lease: session.lease }, 'DELETE').catch(
      () => {},
    );
}
async function playLive(channelId) {
  await closeLive();
  const ticket = ++playbackGeneration;
  const player = document.createElement('section');
  player.id = 'live-player';
  player.setAttribute('aria-label', 'Live TV player');
  player.tabIndex = -1;
  player.restoreFocus = document.activeElement;
  player.innerHTML =
    '<header><button id="live-close">Back to sports</button><strong id="live-channel-name">Opening channel…</strong><span class="sports-status live">Live TV</span></header><video id="live-video" controls playsinline></video><p id="live-player-status" role="status">Starting live playback…</p>';
  document.body.appendChild(player);
  $('#live-close').onclick = closeLive;
  $('#live-close').focus();
  try {
    const session = await api(`/api/live/channels/${channelId}/play`, {});
    if (ticket !== playbackGeneration) {
      await api(`/api/live/sessions/${session.id}`, { lease: session.lease }, 'DELETE').catch(
        () => {},
      );
      return;
    }
    liveSession = session;
    $('#live-channel-name').textContent = session.channel.name;
    heartbeat = setInterval(() => {
      void api(`/api/live/sessions/${session.id}/heartbeat`, { lease: session.lease }).catch(
        (error) => {
          clearInterval(heartbeat);
          if ($('#live-player-status')) $('#live-player-status').textContent = error.message;
        },
      );
    }, 15000);
    const video = $('#live-video');
    const play = () =>
      video.play().catch(() => {
        $('#live-player-status').textContent = 'Press play to watch this channel.';
      });
    video.onplaying = () => {
      $('#live-player-status').textContent = '';
    };
    video.onwaiting = () => {
      $('#live-player-status').textContent = 'Buffering…';
    };
    video.onerror = () => {
      $('#live-player-status').textContent =
        'Playback stopped. Return to sports and try this channel again.';
    };
    if (window.Hls?.isSupported()) {
      hls = new window.Hls();
      hls.loadSource(session.url);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, play);
      hls.on(window.Hls.Events.ERROR, (_event, data) => {
        if (data.fatal && $('#live-player-status'))
          $('#live-player-status').textContent =
            'The channel stopped responding. Return to sports and try another channel.';
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = session.url;
      await play();
    } else {
      await closeLive();
      toast('This browser cannot play live HLS video.');
    }
  } catch (error) {
    if (ticket === playbackGeneration) {
      await closeLive();
      toast(error.message);
    }
  }
}
window.addEventListener('pagehide', () => {
  if (liveSession)
    void fetch(`/api/live/sessions/${liveSession.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease: liveSession.lease }),
      keepalive: true,
    }).catch(() => {});
});
