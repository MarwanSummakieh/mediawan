import { $, api, esc, modal, closeModal, toast } from './core.js';

export async function downloadSeason(title, season) {
  modal('<h2>Checking season…</h2>');
  $('#dialog-content').onclick = null;
  try {
    const path = `/api/titles/${title.id}/seasons/${season}/downloads`;
    const data = await api(path);
    if (!$('#dialog').open) return;
    const count = (state) => data.items.filter((item) => item.state === state).length;
    const label =
      title.kind === 'anime' && !season ? 'all episodes' : season ? `season ${season}` : 'specials';
    const enabled = data.torrentConfigured || data.debridConfigured;
    $('#dialog-content').innerHTML = `<h2>Download ${esc(label)}</h2>
      <p>${count('pending')} episodes to download${count('downloaded') ? ` · ${count('downloaded')} already downloaded` : ''}${count('already_queued') ? ` · ${count('already_queued')} already queued` : ''}${count('unreleased') ? ` · ${count('unreleased')} not released` : ''}</p>
      ${
        data.active
          ? '<p>This season is already being queued.</p><button id="season-view" class="primary">View downloads</button>'
          : `<form id="season-download-form" class="form">
      <label>Download with<select name="provider"><option value="realdebrid" ${!data.debridConfigured ? 'disabled' : ''} ${data.debridConfigured ? 'selected' : ''}>Real-Debrid</option><option value="torrent" ${!data.torrentConfigured ? 'disabled' : ''} ${!data.debridConfigured && data.torrentConfigured ? 'selected' : ''}>Direct torrent · qBittorrent</option></select></label>
      <label>Quality<select name="resolution">${data.resolutions.map((resolution) => `<option value="${resolution}">${resolution}p WEB-DL</option>`).join('')}</select></label>
      <p class="meta">Chooses a matching release for each episode. Downloaded and queued episodes are skipped. Unavailable episodes appear in Downloads.</p>
      <p id="season-provider-note" class="meta"></p>
      ${!enabled ? '<p class="error">No download provider is configured.</p>' : ''}
      <button class="primary" ${!enabled || !count('pending') ? 'disabled' : ''}>Download ${count('pending')} episodes</button><p id="season-error" class="error" role="alert"></p></form>`
      }`;
    if (data.active) {
      $('#season-view').onclick = () => {
        closeModal();
        location.hash = '/downloads';
      };
      return;
    }
    const form = $('#season-download-form');
    const providerNote = () => {
      $('#season-provider-note').textContent =
        form.elements.provider.value === 'torrent'
          ? 'Torrent rules apply. Episodes sharing an existing torrent may need a separate release or Real-Debrid.'
          : 'Downloads original episode files through Real-Debrid.';
    };
    form.elements.provider.onchange = providerNote;
    providerNote();
    form.onsubmit = async (event) => {
      event.preventDefault();
      const submit = form.querySelector('button');
      if (submit.disabled) return;
      submit.disabled = true;
      $('#season-error').textContent = '';
      try {
        await api(path, {
          provider: form.elements.provider.value,
          resolution: Number(form.elements.resolution.value),
        });
        closeModal();
        toast('Season download queued');
        location.hash = '/downloads';
      } catch (error) {
        submit.disabled = false;
        $('#season-error').textContent = error.message;
      }
    };
  } catch (error) {
    if ($('#dialog').open)
      $('#dialog-content').innerHTML =
        `<h2>Season unavailable</h2><p class="error">${esc(error.message)}</p>`;
  }
}

export function seasonDownloadRow(batch) {
  const count = (state) => batch.items.filter((item) => item.state === state).length;
  const active = ['queued', 'finding'].includes(batch.state);
  const unavailable = batch.items.filter((item) => item.state === 'unavailable');
  const label = batch.season ? `Season ${batch.season}` : 'Episodes';
  return `<div class="row"><div class="row-main"><h3>${esc(batch.name)} · ${label}</h3>
    <p class="meta">${batch.resolution === 2160 ? '4K' : batch.resolution + 'p'} · ${batch.provider === 'torrent' ? 'Direct torrent' : 'Real-Debrid'} · ${active ? `Finding releases (${batch.items.length - count('pending')}/${batch.items.length})` : batch.state === 'stopped' ? 'Queueing stopped' : 'Queueing finished'}</p>
    <p class="meta">${count('queued')} queued${count('downloaded') ? ` · ${count('downloaded')} downloaded` : ''}${count('already_queued') ? ` · ${count('already_queued')} already queued` : ''}${count('unreleased') ? ` · ${count('unreleased')} not released` : ''}${!active && count('pending') ? ` · ${count('pending')} not queued` : ''}</p>
    ${batch.error ? `<p class="error">${esc(batch.error)}</p>` : ''}
    ${unavailable.length ? `<details><summary>${unavailable.length} unavailable</summary>${unavailable.map((item) => `<p class="error">Episode ${esc(item.episode)}: ${esc(item.error)}</p>`).join('')}</details>` : ''}
    ${active ? '<p class="meta">Stopping queueing leaves existing downloads running.</p>' : ''}</div>
    <div class="actions">${active ? `<button data-action="season-stop" data-id="${esc(batch.id)}">Stop queueing</button>` : ''}<button data-action="download-title" data-title="${esc(batch.title_id)}">Open title</button></div></div>`;
}

export async function releases(itemId) {
  modal('<h2>Finding releases…</h2>');
  $('#dialog-content').onclick = null;
  try {
    const data = await api(`/api/items/${itemId}/releases`);
    if (!$('#dialog').open) return;
    let provider = data.torrentConfigured ? 'torrent' : 'realdebrid',
      rejected = false;
    const render = () => {
      const direct = provider === 'torrent';
      const items = data.items
        .map((r, index) => ({ ...r, index }))
        .filter((r) => r.qualityAccepted && (!direct || r.accepted || rejected));
      if (direct)
        items.sort(
          (a, b) => Number(b.accepted) - Number(a.accepted) || (b.seeders || 0) - (a.seeders || 0),
        );
      $('#dialog-content').innerHTML =
        `<h2>Choose a release</h2><label>Download with<select id="release-provider"><option value="torrent" ${direct ? 'selected' : ''} ${!data.torrentConfigured ? 'disabled' : ''}>Direct torrent · qBittorrent</option><option value="realdebrid" ${!direct ? 'selected' : ''} ${!data.debridConfigured ? 'disabled' : ''}>Real-Debrid</option></select></label>
        <p class="meta">${esc(data.qualityRule)}. Required for both providers. No quality fallback.</p>
        <p class="meta">${direct ? `At least ${data.rules.minSeeders} reported seeders · ${data.rules.movieMaxGB} GB movies / ${data.rules.episodeMaxGB} GB episodes. Counts may be stale; live progress is checked after selection. Direct torrents connect this PC to peers.` : 'Download the original file through Real-Debrid.'}</p>
        ${direct ? `<label class="check"><input id="show-rejected" type="checkbox" ${rejected ? 'checked' : ''}>Show filtered releases (${data.items.filter((r) => r.qualityAccepted && !r.accepted).length})</label>` : ''}
        ${items.map((r) => `<button class="release" data-release="${r.index}" ${direct && !r.accepted ? 'disabled' : ''}>${esc(r.label)}${direct ? `<span class="meta">${r.accepted ? 'Meets search rules' : esc(r.reasons.join(' · '))}</span>` : ''}</button>`).join('')}
        ${!items.length ? `<p>No releases meet these rules. ${esc(data.qualityRule)} is required; other qualities and sources cannot be selected.</p>` : ''}`;
      $('#release-provider').onchange = (e) => {
        provider = e.target.value;
        render();
      };
      if ($('#show-rejected'))
        $('#show-rejected').onchange = (e) => {
          rejected = e.target.checked;
          render();
        };
    };
    render();
    $('#dialog-content').onclick = async (e) => {
      const button = e.target.closest('[data-release]');
      if (!button || button.disabled) return;
      button.disabled = true;
      try {
        await api(`/api/items/${itemId}/download`, {
          ...data.items[Number(button.dataset.release)],
          provider,
        });
        closeModal();
        toast('Download queued');
        location.hash = '/downloads';
      } catch (error) {
        button.disabled = false;
        toast(error.message);
      }
    };
  } catch (error) {
    $('#dialog-content').innerHTML =
      `<h2>Releases unavailable</h2><p class="error">${esc(error.message)}</p>`;
  }
}

export function downloadRow(j) {
  const action = (label, operation) =>
    `<button data-action="download-action" data-id="${esc(j.id)}" data-operation="${operation}">${label}</button>`;
  const direct = j.provider === 'torrent';
  let controls = '';
  if (j.state === 'ready' || j.state === 'evicted' || j.retryable === false)
    controls = `<button data-action="download-title" data-title="${esc(j.titleId)}">Open title</button>`;
  else if (['failed', 'cancelled'].includes(j.state)) controls = action('Retry', 'retry');
  else if (j.state === 'paused') controls = action('Resume', 'resume') + action('Cancel', 'cancel');
  else if (j.state === 'stopping') controls = '<span class="meta">Stopping…</span>';
  else controls = (direct ? action('Pause', 'pause') : '') + action('Cancel', 'cancel');
  const state =
    j.state === 'checking'
      ? 'Finding peers and checking files'
      : j.state === 'evicted'
        ? 'Removed to free storage'
        : j.state === 'preparing'
          ? 'Checking with Real-Debrid'
          : j.state;
  return `<div class="row"><div class="row-main"><h3>${esc(j.name)}${j.episode ? ` · Episode ${j.episode}` : ''}</h3><p class="meta">${direct ? 'Direct torrent' : 'Real-Debrid'} · ${esc(state)}${j.total ? ` · ${Math.round((100 * j.bytes) / j.total)}% · ${(j.total / 1073741824).toFixed(1)} GB` : ''}</p>
    ${direct && j.seeders != null ? `<p class="meta">${j.seeders} connected seeders · ${j.peers} other peers · ${(j.speed / 1048576).toFixed(1)} MB/s${j.availability != null && j.availability >= 0 ? ` · ${j.availability.toFixed(2)} copies available` : ''}</p>` : ''}
    ${j.total ? `<progress class="progress" value="${j.bytes}" max="${j.total}" aria-label="Download progress"></progress>` : ''}${j.error ? `<p class="error">${esc(j.error)}</p>` : ''}</div><div class="actions">${controls}</div></div>`;
}
export function torrentRulesForm(admin) {
  if (!admin) return '';
  const r = admin.torrentRules;
  const fields = [
    ['minSeeders', 'Minimum reported seeders', 0, 10000, 1],
    ['movieMaxGB', 'Maximum movie size (GB)', 0.1, 1000, 0.1],
    ['episodeMaxGB', 'Maximum episode size (GB)', 0.1, 1000, 0.1],
    ['metadataMinutes', 'Metadata timeout (minutes)', 1, 30, 1],
    ['stallMinutes', 'No-progress timeout (minutes)', 1, 120, 1],
    ['maxConcurrent', 'Concurrent downloads', 1, 4, 1],
    ['uploadKBps', 'Upload limit per torrent (KB/s)', 16, 102400, 1],
    ['seedRatio', 'Stop seeding at ratio', 0, 10, 0.1],
    ['seedMinutes', 'Or after seeding (minutes)', 0, 1440, 1],
  ];
  return `<section class="section"><form id="torrent-rules" class="form"><h2>Torrent rules</h2><p class="meta">qBittorrent: ${admin.torrentConfigured ? 'Configured' : 'Not configured'}. Rules apply to new jobs and retries. Existing jobs keep their saved rules. CAM / TS / screeners are always excluded.</p><p class="meta">Required quality for both providers: 1080p WEB-DL for anime and TV shows · 2160p WEB-DL for movies. This rule cannot be changed.</p>${fields.map(([key, label, min, max, step]) => `<label>${label}<input type="number" name="${key}" min="${min}" max="${max}" step="${step}" required value="${r[key]}"></label>`).join('')}
    <label class="check"><input type="checkbox" name="rejectUnknown" ${r.rejectUnknown ? 'checked' : ''}>Reject unknown seed count or size</label><p class="meta">Timeouts stop the selected torrent and retain partial data. They never choose another release automatically. Uploads can continue until the ratio or time limit is reached.</p><button class="primary">Save torrent rules</button><button type="button" id="torrent-health">Test connection</button><p id="torrent-status" role="status"></p></form></section>`;
}
export function bindTorrentRules() {
  const form = $('#torrent-rules');
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = new FormData(form),
      payload = {};
    for (const [key, value] of data)
      if (!['resolutions', 'rejectUnknown'].includes(key)) payload[key] = Number(value);
    payload.rejectUnknown = data.has('rejectUnknown');
    try {
      await api('/api/admin/torrent-rules', payload, 'PUT');
      toast('Torrent rules saved');
    } catch (error) {
      toast(error.message);
    }
  };
  $('#torrent-health').onclick = async () => {
    try {
      const result = await api('/api/admin/torrent-health');
      $('#torrent-status').textContent = `Connected to qBittorrent ${result.version}`;
    } catch (error) {
      $('#torrent-status').textContent = error.message;
    }
  };
}
