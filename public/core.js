export const $ = (selector) => document.querySelector(selector);
export const esc = (value) =>
  String(value == null ? '' : value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export async function api(url, body, method) {
  const response = await fetch(url, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
let toastTimer;
export function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#toast').hidden = true), 5000);
}
let restoreFocus;
export function modal(html) {
  restoreFocus = document.activeElement;
  $('#dialog-content').innerHTML = html;
  if (!$('#dialog').open) {
    if ($('#dialog').showModal) $('#dialog').showModal();
    else $('#dialog').setAttribute('open', '');
  }
  setTimeout(() => $('#dialog-content').querySelector('button,input,select')?.focus(), 0);
}
export function closeModal() {
  if ($('#dialog').close) $('#dialog').close();
  else $('#dialog').removeAttribute('open');
  restoreFocus?.focus();
}
export const episodeLabel = (item) =>
  item?.episode
    ? item.season
      ? `S${item.season} · E${item.episode}`
      : `Episode ${item.episode}`
    : 'Movie';
export const progress = (state) =>
  state?.duration
    ? `<progress class="progress" aria-label="Watch progress" value="${Math.min(state.position, state.duration)}" max="${state.duration}"></progress>`
    : '';
export function poster(title) {
  const url = String(title.poster || '');
  return /^https?:\/\//.test(url)
    ? `<img src="${esc(url)}" alt="" loading="lazy">`
    : `<div class="poster-placeholder">${esc(title.name)}</div>`;
}
export function card(title, mode = 'library') {
  const item = mode === 'resume' ? title.resumable : mode === 'next' ? title.next : null;
  const remaining = item?.state.duration
    ? `${Math.ceil(Math.max(0, item.state.duration - item.state.position) / 60)} min left`
    : '';
  return `<article class="card"><a class="poster" href="#/title/${esc(title.id)}" aria-label="Open ${esc(title.name)}">${poster(title)}${item ? `<span class="badge">${esc(episodeLabel(item))}</span>` : title.readyCount ? '<span class="badge">Downloaded</span>' : ''}</a>${item ? progress(item.state) : ''}<a class="card-name" href="#/title/${esc(title.id)}">${esc(title.name)}</a><p class="meta">${esc(item ? (mode === 'resume' ? remaining : item.name) : [title.year, title.kind === 'movie' ? 'Movie' : title.kind === 'anime' ? 'Anime' : 'Series'].filter(Boolean).join(' · '))}</p>${item ? `<div class="resume-actions"><button class="card-action ${mode === 'resume' ? 'primary' : ''}" data-action="${item.available ? 'play' : 'release'}" data-item="${esc(item.id)}" data-title="${esc(title.id)}">${item.available ? (mode === 'resume' ? 'Resume' : 'Play next') : 'Not downloaded'}</button>${mode === 'resume' ? `<button class="menu-button" data-action="resume-menu" data-title="${esc(title.id)}" data-item="${esc(item.id)}" aria-label="More actions for ${esc(title.name)}">•••</button>` : ''}</div>` : ''}</article>`;
}
export function heading(name, caption = '', action = '') {
  return `<header class="page-heading"><div><h1>${esc(name)}</h1>${caption ? `<p>${esc(caption)}</p>` : ''}</div>${action}</header>`;
}
export const empty = (name, description, action = '') =>
  `<div class="empty"><h2>${esc(name)}</h2><p>${esc(description)}</p>${action}</div>`;
