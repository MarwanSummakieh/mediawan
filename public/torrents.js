import { $, api, esc, modal, closeModal, toast } from './core.js';

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
        .filter((r) => !direct || r.accepted || rejected);
      if (direct)
        items.sort(
          (a, b) => Number(b.accepted) - Number(a.accepted) || (b.seeders || 0) - (a.seeders || 0),
        );
      $('#dialog-content').innerHTML =
        `<h2>Choose a release</h2><label>Download with<select id="release-provider"><option value="torrent" ${direct ? 'selected' : ''} ${!data.torrentConfigured ? 'disabled' : ''}>Direct torrent · qBittorrent</option><option value="realdebrid" ${!direct ? 'selected' : ''} ${!data.debridConfigured ? 'disabled' : ''}>Real-Debrid</option></select></label>
        <p class="meta">${direct ? `At least ${data.rules.minSeeders} reported seeders · ${data.rules.resolutions.map((n) => n + 'p').join(' / ')} · ${data.rules.movieMaxGB} GB movies / ${data.rules.episodeMaxGB} GB episodes. Counts may be stale; live progress is checked after selection. Direct torrents connect this PC to peers.` : 'Download the original file through Real-Debrid.'}</p>
        ${direct ? `<label class="check"><input id="show-rejected" type="checkbox" ${rejected ? 'checked' : ''}>Show filtered releases (${data.items.filter((r) => !r.accepted).length})</label>` : ''}
        ${items.map((r) => `<button class="release" data-release="${r.index}" ${direct && !r.accepted ? 'disabled' : ''}>${esc(r.label)}${direct ? `<span class="meta">${r.accepted ? 'Meets search rules' : esc(r.reasons.join(' · '))}</span>` : ''}</button>`).join('')}
        ${!items.length ? '<p>No releases meet these rules. Review the filtered results or adjust Torrent rules in Settings.</p>' : ''}`;
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
  return `<section class="section"><form id="torrent-rules" class="form"><h2>Torrent rules</h2><p class="meta">qBittorrent: ${admin.torrentConfigured ? 'Configured' : 'Not configured'}. Rules apply to new jobs and retries. Existing jobs keep their saved rules. CAM / TS / screeners are always excluded.</p>${fields.map(([key, label, min, max, step]) => `<label>${label}<input type="number" name="${key}" min="${min}" max="${max}" step="${step}" required value="${r[key]}"></label>`).join('')}
    <fieldset><legend>Accepted resolutions</legend>${[480, 720, 1080, 2160].map((n) => `<label class="check"><input type="checkbox" name="resolutions" value="${n}" ${r.resolutions.includes(n) ? 'checked' : ''}>${n === 2160 ? '2160p / 4K' : n + 'p'}</label>`).join('')}</fieldset>
    <label class="check"><input type="checkbox" name="rejectUnknown" ${r.rejectUnknown ? 'checked' : ''}>Reject unknown seed count, size or resolution</label><p class="meta">Timeouts stop the selected torrent and retain partial data. They never choose another release automatically. Uploads can continue until the ratio or time limit is reached.</p><button class="primary">Save torrent rules</button><button type="button" id="torrent-health">Test connection</button><p id="torrent-status" role="status"></p></form></section>`;
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
    payload.resolutions = data.getAll('resolutions').map(Number);
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
