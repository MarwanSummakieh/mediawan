import { metadataHtml, episodeMetadata } from './metadata.js';
import {
  releases,
  downloadSeason,
  seasonDownloadRow,
  downloadRow,
  torrentRulesForm,
  bindTorrentRules,
} from './torrents.js';
import {
  $,
  esc,
  api,
  toast,
  modal,
  closeModal,
  episodeLabel,
  progress,
  poster,
  card,
  heading,
  empty,
} from './core.js';
import {
  initPlayer,
  play,
  playing,
  closePlayer,
  currentQueue,
  replaceQueue,
  showQueue,
} from './player.js';
let user = null,
  generation = 0,
  poll = null,
  currentTitle = null,
  discoverResults = [],
  locationKey = '',
  returnPositions = {};
const main = () => $('#main');
const button = (label, action, attrs = '', style = '') =>
  `<button class="${style}" data-action="${action}" ${attrs}>${esc(label)}</button>`;
const option = (value, label, current) =>
  `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`;
const grid = (items) => `<div class="grid">${items.map((t) => card(t)).join('')}</div>`;
function shelf(label, items, mode) {
  return items.length
    ? `<section class="section"><div class="section-heading"><h2>${esc(label)}</h2></div><div class="rail ${mode ? 'resume-rail' : ''}">${items.map((t) => card(t, mode)).join('')}</div></section>`
    : '';
}
async function route({ quiet = false } = {}) {
  if (!user) return;
  const ticket = ++generation;
  clearInterval(poll);
  currentTitle = null;
  const hash = location.hash.slice(1) || '/',
    url = new URL(hash, 'http://local'),
    parts = url.pathname.split('/').filter(Boolean),
    page = parts[0] || 'home';
  if (locationKey !== hash) {
    returnPositions[locationKey] = {
      y: window.scrollY,
      key: document.activeElement?.getAttribute('href'),
    };
    locationKey = hash;
  }
  document
    .querySelectorAll('[data-nav]')
    .forEach((a) =>
      a.classList.toggle(
        'active',
        a.dataset.nav === page || (page === 'title' && a.dataset.nav === 'library'),
      ),
    );
  const draw = (html) => {
    if (ticket !== generation) return;
    main().innerHTML = html;
    if (!quiet) {
      window.scrollTo(0, returnPositions[hash]?.y || 0);
      const href = returnPositions[hash]?.key;
      if (href) {
        const target = [...main().querySelectorAll('a')].find(
          (a) => a.getAttribute('href') === href,
        );
        target?.focus({ preventScroll: true });
      }
    }
  };
  if (!quiet) main().innerHTML = '<p class="loading" role="status">Loading…</p>';
  try {
    if (page === 'home') {
      const data = await api('/api/home'),
        queues = await api('/api/queues');
      const count = data.continueWatching.length + data.nextUp.length + data.recentlyAdded.length;
      draw(
        heading('Home', '', `<a class="quiet" href="#/settings">${esc(user.name)}</a>`) +
          shelf('Continue watching', data.continueWatching, 'resume') +
          shelf('Next up', data.nextUp, 'next') +
          shelf('Recently added', data.recentlyAdded) +
          shelf('My list', data.watchlist) +
          (!count
            ? empty(
                'Make yourself at home',
                'Find a movie or series, download it to your library, and watch it here.',
                `<a class="primary card-action" href="#/discover">Discover something to watch</a>`,
              )
            : '') +
          (queues.some((q) => q.items.length)
            ? `<section class="section"><h2>Saved queues</h2>${queues
                .filter((q) => q.items.length)
                .slice(0, 3)
                .map(
                  (q) =>
                    `<div class="row"><div class="row-main"><h3>${esc(q.name)}</h3><p class="meta">${q.mode === 'shuffle' ? 'Shuffle' : 'In order'} · ${q.items.length} items</p></div>${button('Open queue', 'queue', `data-id="${q.id}"`)}</div>`,
                )
                .join('')}</section>`
            : ''),
      );
    } else if (page === 'library' || page === 'list') {
      const params = new URLSearchParams(url.search);
      if (page === 'list') {
        params.set('scope', 'all');
        if (!params.get('tag')) params.set('tag', 'watchlist');
      }
      const data = await api(`/api/library?${params}`),
        collections = page === 'list' ? await api('/api/collections') : [];
      draw(
        heading(page === 'list' ? 'My List' : 'Your library', `${data.total} titles`) +
          `<form id="filters" class="toolbar"><label>Search<input name="q" type="search" value="${esc(params.get('q'))}" placeholder="Find a title"></label><label>Type<select name="kind">${[
            ['', 'All types'],
            ['movie', 'Movies'],
            ['tv', 'Series'],
            ['anime', 'Anime'],
          ]
            .map(([v, l]) => option(v, l, params.get('kind') || ''))
            .join('')}</select></label><label>View<select name="status">${[
            ['', 'All titles'],
            ['ready', 'Downloaded'],
            ['progress', 'In progress'],
            ['unwatched', 'Unwatched'],
            ['watched', 'Watched'],
          ]
            .map(([v, l]) => option(v, l, params.get('status') || ''))
            .join('')}</select></label><label>Sort<select name="sort">${[
            ['', 'Title'],
            ['added', 'Recently added'],
            ['played', 'Last watched'],
            ['year', 'Year'],
          ]
            .map(([v, l]) => option(v, l, params.get('sort') || ''))
            .join(
              '',
            )}</select></label>${page === 'list' ? `<label>List<select name="tag">${option('watchlist', 'Watchlist', params.get('tag'))}${option('favorite', 'Favorites', params.get('tag'))}</select></label>` : ''}<button>Apply</button></form>` +
          (page === 'list'
            ? `<div class="collection-links">${button('New collection', 'new-collection')}${collections.map((c) => button(c.name, 'collection', `data-id="${c.id}"`)).join('')}</div>`
            : '') +
          (data.items.length
            ? grid(data.items)
            : empty(
                'Nothing here yet',
                page === 'list'
                  ? 'Save titles to your watchlist or favorites from their detail page.'
                  : 'Downloaded titles will appear here. Try different filters or discover a title.',
              )) +
          `<div class="actions section">${data.offset ? button('Previous page', 'page', `data-offset="${Math.max(0, data.offset - 48)}"`) : ''}${data.offset + 48 < data.total ? button('Next page', 'page', `data-offset="${data.offset + 48}"`) : ''}</div>`,
      );
      $('#filters').onsubmit = (e) => {
        e.preventDefault();
        const query = new URLSearchParams(new FormData(e.target));
        location.hash = `/${page}?${query}`;
      };
    } else if (page === 'discover') {
      const q = url.searchParams.get('q') || '';
      draw(
        heading('Discover') +
          `<form id="search" class="toolbar"><label>Search<input name="q" type="search" placeholder="Search movies, series and anime" value="${esc(q)}"></label><button class="primary">Search</button></form><div id="results"><p class="loading">Finding titles…</p></div>`,
      );
      $('#search').onsubmit = (e) => {
        e.preventDefault();
        location.hash = `/discover?${new URLSearchParams(new FormData(e.target))}`;
      };
      try {
        const data = await api(`/api/discover?q=${encodeURIComponent(q)}`);
        if (ticket !== generation) return;
        discoverResults = data.items;
        $('#results').innerHTML = data.items.length
          ? `<div class="grid">${data.items.map((t, i) => `<article class="card"><button class="poster" data-action="discover-title" data-index="${i}" aria-label="Open ${esc(t.name)}">${poster(t)}</button><h3 class="card-name">${esc(t.name)}</h3><p class="meta">${esc(t.year)}</p></article>`).join('')}</div>`
          : empty('No matching titles', 'Try another title.');
      } catch (error) {
        if (ticket === generation)
          $('#results').innerHTML = empty('Discovery is unavailable', error.message);
      }
    } else if (page === 'title') {
      const title = await api(`/api/titles/${parts[1]}`);
      if (ticket !== generation) return;
      currentTitle = title;
      draw(detailHtml(title));
    } else if (page === 'downloads') {
      const [jobs, seasons] = await Promise.all([
        api('/api/downloads'),
        api('/api/season-downloads'),
      ]);
      draw(
        heading('Downloads') +
          (seasons.length
            ? '<section class="section"><h2>Season downloads</h2>' +
              seasons.map(seasonDownloadRow).join('') +
              '</section><h2>Episodes</h2>'
            : '') +
          (jobs.length
            ? jobs.map(downloadRow).join('')
            : empty('No downloads yet', 'Choose a release on a title page to save it locally.')),
      );
      poll = setInterval(() => {
        if (!document.hidden && !playing()) route({ quiet: true });
      }, 5000);
    } else if (page === 'settings') {
      const prefs = await api('/api/preferences');
      const admin = user.role === 'admin' ? await api('/api/admin') : null;
      draw(
        heading('Settings') +
          torrentRulesForm(admin) +
          `<form id="preferences" class="form"><h2>Playback</h2><label class="check section"><input type="checkbox" name="autoplay" ${prefs.autoplay ? 'checked' : ''}>Play the next episode automatically</label><label>Preferred audio language<input name="audioLanguage" placeholder="eng, dan, jpn…" maxlength="20" value="${esc(prefs.audioLanguage)}"></label><label>Preferred subtitle language<input name="subtitleLanguage" maxlength="20" placeholder="eng, dan…" value="${esc(prefs.subtitleLanguage)}"></label><label>Subtitles<select name="subtitleMode">${option('off', 'Off', prefs.subtitleMode)}${option('preferred', 'Use preferred language', prefs.subtitleMode)}</select></label><button class="primary">Save preferences</button></form>${admin ? `<section class="section"><h2>Server</h2><p class="meta">Real-Debrid: ${admin.debridConfigured ? 'Configured' : 'Not configured'}</p><p class="meta">Import folders: ${esc(admin.importRoots.join(', ') || 'None configured')}</p></section><section class="section"><div class="section-heading"><h2>People</h2>${button('Add person', 'add-user')}</div>${admin.users.map((u) => `<div class="row"><div class="row-main"><h3>${esc(u.name)}</h3><p class="meta">${esc(u.email)} · ${u.active ? 'Active' : 'Disabled'} · ${u.role === 'admin' || u.can_download ? 'Downloads allowed' : 'Viewing only'}</p></div>${u.id !== user.id ? button(u.can_download ? 'Disable downloads' : 'Allow downloads', 'user-permission', `data-id="${u.id}" data-active="${!!u.active}" data-allowed="${!u.can_download}"`) : ''}</div>`).join('')}</section>` : ''}<section class="section">${button('Sign out', 'logout')}</section>`,
      );
      bindTorrentRules();
      $('#preferences').onsubmit = async (e) => {
        e.preventDefault();
        const data = new FormData(e.target);
        try {
          await api(
            '/api/preferences',
            {
              autoplay: data.has('autoplay'),
              audioLanguage: data.get('audioLanguage'),
              subtitleLanguage: data.get('subtitleLanguage'),
              subtitleMode: data.get('subtitleMode'),
            },
            'PATCH',
          );
          toast('Preferences saved');
        } catch (error) {
          toast(error.message);
        }
      };
    } else draw(empty('Page not found', 'Use the navigation to return to your library.'));
  } catch (error) {
    draw(empty('Could not open this page', error.message, button('Try again', 'refresh')));
  }
}
function detailHtml(title) {
  const primary = title.primary;
  let html = `<div class="detail"><div class="detail-art poster">${poster(title)}</div><div class="detail-copy"><p class="eyebrow">${esc(title.kind === 'movie' ? 'Movie' : title.kind === 'anime' ? 'Anime' : 'Series')} ${esc(title.year)}</p><h1>${esc(title.name)}</h1>${metadataHtml(title)}<p class="muted">${esc(title.description)}</p><div class="actions">${primary ? button(primary.available ? (title.resumable ? 'Resume ' + episodeLabel(primary) : primary.state.completed ? 'Replay' : 'Play ' + episodeLabel(primary)) : 'Find a release', primary.available ? 'play' : 'release', `data-item="${primary.id}" data-title="${title.id}"`, 'primary') : ''}${title.kind !== 'movie' && title.readyCount ? button('Shuffle episodes', 'shuffle', `data-title="${title.id}"`) : ''}${button(title.tags.includes('watchlist') ? 'In My List' : 'Add to My List', 'tag', `data-tag="watchlist" data-active="${!title.tags.includes('watchlist')}"`)}${button(title.tags.includes('favorite') ? 'Favorited' : 'Favorite', 'tag', `data-tag="favorite" data-active="${!title.tags.includes('favorite')}"`)}${button('Collections', 'add-collection')}</div><p class="meta">${title.readyCount} downloaded${title.genres?.length ? ' · ' + esc(title.genres.join(' / ')) : ''}</p></div></div>`;
  const seasons = [...new Set(title.items.map((i) => i.season))];
  for (const season of seasons) {
    const items = title.items.filter((i) => i.season === season);
    html += `<section><div class="season-header"><h2>${title.kind === 'movie' ? 'Your copy' : season ? `Season ${season}` : title.kind === 'anime' ? 'Episodes' : 'Specials'}</h2><div class="actions">${title.kind !== 'movie' && user.canDownload && items.some((i) => !i.available) ? button(title.kind === 'anime' && !season ? 'Download all episodes' : 'Download season', 'download-season', `data-season="${season}"`) : ''}${title.kind !== 'movie' && items.some((i) => i.available) ? button('Shuffle season', 'shuffle', `data-title="${title.id}" data-season="${season}"`) : ''}${button(items.every((i) => i.state.completed) ? 'Mark unwatched' : 'Mark watched', 'bulk-watched', `data-season="${season}" data-watched="${!items.every((i) => i.state.completed)}"`)}</div></div>${items.map((i) => `<div class="episode"><span class="episode-number">${i.episode || '—'}</span><div class="episode-body">${i.thumbnail ? `<img class="episode-thumbnail" src="${esc(i.thumbnail)}" alt="" loading="lazy">` : ''}<h3>${esc(i.name || episodeLabel(i))}</h3><p class="meta">${i.available ? 'Downloaded' : 'Not downloaded'} · ${i.state.completed ? 'Watched' : i.state.position >= 10 ? 'In progress' : 'Unwatched'}${i.released ? ' · ' + esc(String(i.released).slice(0, 10)) : ''}</p>${episodeMetadata(i)}${progress(i.state)}</div><div class="actions">${button(i.available ? (i.state.position >= 10 && !i.state.completed ? 'Resume' : 'Play') : 'Download', i.available ? 'play' : 'release', `data-item="${i.id}" data-title="${title.id}"`, i.available ? '' : 'quiet')}${button('More', 'item-menu', `data-item="${i.id}"`)}</div></div>`).join('')}</section>`;
  }
  return html;
}
async function chooseCollection() {
  const collections = await api('/api/collections');
  modal(
    '<h2>Add to collection</h2>' +
      collections.map((c) => button(c.name, 'collection-toggle', `data-id="${c.id}"`)).join('') +
      `<form id="new-collection"><label>New collection<input name="name" required maxlength="100"></label><button>Create</button></form>`,
  );
  $('#new-collection').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const c = await api('/api/collections', { name: new FormData(e.target).get('name') });
      if (currentTitle)
        await api(`/api/collections/${c.id}`, { items: [currentTitle.id] }, 'PATCH');
      closeModal();
      toast('Collection created');
      if (!currentTitle) route();
    } catch (error) {
      toast(error.message);
    }
  };
  $('#dialog-content').onclick = async (e) => {
    const b = e.target.closest('[data-id]');
    if (!b || !currentTitle) return;
    try {
      const c = collections.find((c) => c.id === b.dataset.id);
      await api(
        `/api/collections/${c.id}`,
        { items: [...new Set([...c.items, currentTitle.id])] },
        'PATCH',
      );
      closeModal();
      toast('Added to collection');
    } catch (error) {
      toast(error.message);
    }
  };
}
async function action(event) {
  const b = event.target.closest('[data-action]');
  if (!b) return;
  const actionName = b.dataset.action;
  b.disabled = true;
  try {
    if (actionName === 'refresh') await route();
    else if (actionName === 'refresh-metadata') {
      const titleId = currentTitle.id;
      await api(`/api/titles/${titleId}/refresh`, {});
      if (currentTitle?.id === titleId) await route({ quiet: true });
      toast('Metadata refreshed');
    } else if (actionName === 'play') {
      closeModal();
      await play(b.dataset.item, b.dataset.title, { replay: b.dataset.replay === 'true' });
    } else if (actionName === 'release') await releases(b.dataset.item);
    else if (actionName === 'download-season')
      await downloadSeason(currentTitle, Number(b.dataset.season));
    else if (actionName === 'season-stop') {
      await api(`/api/season-downloads/${b.dataset.id}/stop`, {});
      await route({ quiet: true });
    } else if (actionName === 'discover-title') {
      const title = discoverResults[Number(b.dataset.index)];
      const stored = await api('/api/discover', {
        kind: title.kind,
        externalId: title.external_id,
      });
      location.hash = `/title/${stored.id}`;
    } else if (actionName === 'tag') {
      await api(`/api/titles/${currentTitle.id}/tags`, {
        tag: b.dataset.tag,
        active: b.dataset.active === 'true',
      });
      await route({ quiet: true });
    } else if (actionName === 'shuffle') {
      const titleId = b.dataset.title,
        season = b.dataset.season;
      modal(
        '<h2>Shuffle episodes</h2><p class="meta">Downloaded episodes, without repeats.</p><form id="shuffle-form"><label class="check section"><input name="unwatched" type="checkbox">Unwatched episodes only</label><button class="primary">Start shuffle</button></form>',
      );
      $('#dialog-content').onclick = null;
      $('#shuffle-form').onsubmit = async (e) => {
        e.preventDefault();
        try {
          const queue = await api('/api/queues', {
            titleId,
            season: season == null ? undefined : Number(season),
            mode: 'shuffle',
            unwatched: new FormData(e.target).has('unwatched'),
          });
          closeModal();
          await play(queue.items[0], titleId, { queueId: queue.id, replay: true });
        } catch (error) {
          toast(error.message);
        }
      };
    } else if (actionName === 'resume-menu') {
      modal(
        '<h2>Continue watching</h2><div class="actions">' +
          button(
            'Play from beginning',
            'play',
            `data-title="${b.dataset.title}" data-item="${b.dataset.item}" data-replay="true"`,
          ) +
          button('Mark watched', 'watched', `data-item="${b.dataset.item}" data-watched="true"`) +
          button('Remove from Continue Watching', 'dismiss', `data-title="${b.dataset.title}"`) +
          '</div>',
      );
      $('#dialog-content').onclick = action;
    } else if (actionName === 'dismiss') {
      await api(`/api/titles/${b.dataset.title}/dismiss`, { hidden: true });
      closeModal();
      await route({ quiet: true });
    } else if (actionName === 'watched' || actionName === 'bulk-watched') {
      const items =
        actionName === 'watched'
          ? [b.dataset.item]
          : currentTitle.items
              .filter((i) => i.season === Number(b.dataset.season))
              .map((i) => i.id);
      const watched = b.dataset.watched === 'true';
      const result = await api('/api/watched', { items, watched });
      closeModal();
      await route({ quiet: true });
      toast(
        `${items.length} item${items.length === 1 ? '' : 's'} marked ${watched ? 'watched' : 'unwatched'}`,
      );
      const undo = document.createElement('button');
      undo.textContent = 'Undo';
      undo.onclick = async () => {
        try {
          await api('/api/watched/undo', { token: result.undoToken });
          await route({ quiet: true });
          toast('Change undone');
        } catch (error) {
          toast(error.message);
        }
      };
      $('#toast').appendChild(undo);
    } else if (actionName === 'item-menu') {
      const item = currentTitle.items.find((i) => i.id === b.dataset.item),
        attrs = `data-item="${item.id}"`;
      modal(
        `<h2>${esc(item.name || episodeLabel(item))}</h2><div class="actions">${button(item.state.completed ? 'Mark unwatched' : 'Mark watched', 'watched', `${attrs} data-watched="${!item.state.completed}"`)}${item.available ? button('Play from beginning', 'play', `${attrs} data-title="${currentTitle.id}" data-replay="true"`) + button('Add to queue', 'enqueue', attrs) + button('Play next', 'enqueue', `${attrs} data-next="true"`) : ''}${user.role === 'admin' ? button('Import local file', 'import', attrs) : ''}</div>`,
      );
      $('#dialog-content').onclick = action;
    } else if (actionName === 'enqueue') {
      let q = currentQueue();
      if (!q) {
        q = await api('/api/queues', { items: [b.dataset.item] });
        toast('Saved a new queue');
      } else {
        const items = q.items.filter((i) => i !== b.dataset.item);
        items.splice(b.dataset.next === 'true' ? q.index + 1 : items.length, 0, b.dataset.item);
        replaceQueue(await api(`/api/queues/${q.id}`, { revision: q.revision, items }, 'PATCH'));
        toast('Added to queue');
      }
      closeModal();
    } else if (actionName === 'queue') {
      await showQueue(b.dataset.id);
    } else if (actionName === 'download-action') {
      await api(`/api/downloads/${b.dataset.id}`, { action: b.dataset.operation });
      await route({ quiet: true });
    } else if (actionName === 'download-title') {
      location.hash = `/title/${b.dataset.title}`;
    } else if (actionName === 'page') {
      const url = new URL(location.hash.slice(1), 'http://local');
      url.searchParams.set('offset', b.dataset.offset);
      location.hash = url.pathname + url.search;
    } else if (actionName === 'add-collection' || actionName === 'new-collection')
      await chooseCollection();
    else if (actionName === 'collection') {
      const collections = await api('/api/collections'),
        collection = collections.find((c) => c.id === b.dataset.id);
      const titles = await Promise.all(
        collection.items.map((id) => api(`/api/titles/${id}`).catch(() => null)),
      );
      modal(
        `<h2>${esc(collection.name)}</h2>${grid(titles.filter(Boolean))}<div class="actions section">${button('Delete collection', 'delete-collection', `data-id="${collection.id}"`)}</div>`,
      );
      $('#dialog-content').onclick = (e) => {
        if (e.target.closest('a')) closeModal();
        else action(e);
      };
    } else if (actionName === 'delete-collection') {
      await api(`/api/collections/${b.dataset.id}`, {}, 'DELETE');
      closeModal();
      await route({ quiet: true });
    } else if (actionName === 'import') {
      const itemId = b.dataset.item;
      modal(
        '<h2>Import a local file</h2><form id="import-form"><label>Server file path<input name="path" required placeholder="/media/existing/episode.mkv"></label><p class="meta">The file stays in place. Its folder must be allowed in server settings.</p><button class="primary">Import</button></form>',
      );
      $('#dialog-content').onclick = null;
      $('#import-form').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('/api/admin/import', { itemId, path: new FormData(e.target).get('path') });
          closeModal();
          await route({ quiet: true });
          toast('File imported');
        } catch (error) {
          toast(error.message);
        }
      };
    } else if (actionName === 'add-user') {
      modal(
        '<h2>Add a person</h2><form id="user-form" class="form"><label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label><label>Initial password<input name="password" type="password" minlength="10" required autocomplete="new-password"></label><label class="check"><input name="canDownload" type="checkbox">Allow downloads</label><button class="primary">Create account</button></form>',
      );
      $('#dialog-content').onclick = null;
      $('#user-form').onsubmit = async (e) => {
        e.preventDefault();
        const data = new FormData(e.target);
        try {
          await api('/api/admin/users', {
            name: data.get('name'),
            email: data.get('email'),
            password: data.get('password'),
            canDownload: data.has('canDownload'),
          });
          closeModal();
          await route({ quiet: true });
        } catch (error) {
          toast(error.message);
        }
      };
    } else if (actionName === 'user-permission') {
      await api(
        `/api/admin/users/${b.dataset.id}`,
        { active: b.dataset.active === 'true', canDownload: b.dataset.allowed === 'true' },
        'PATCH',
      );
      await route({ quiet: true });
    } else if (actionName === 'logout') await logout();
  } catch (error) {
    toast(error.message);
  } finally {
    b.disabled = false;
  }
}
async function logout() {
  if (playing()) await closePlayer();
  await api('/api/logout', {});
  location.reload();
}
async function boot() {
  const auth = await api('/api/auth');
  user = auth.user;
  if (!user) {
    $('#sidebar').hidden = true;
    main().style.marginLeft = '0';
    main().style.width = '100%';
    main().innerHTML = `<div class="login"><p class="eyebrow">Mediawan</p><h1>Your library awaits.</h1>${auth.setupRequired ? '<p>Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 10 characters on the server, then restart Mediawan.</p>' : '<form id="login" class="form"><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="primary">Sign in</button><p id="login-error" class="error" role="alert"></p></form>'}</div>`;
    if ($('#login'))
      $('#login').onsubmit = async (e) => {
        e.preventDefault();
        const data = new FormData(e.target);
        try {
          await api('/api/login', { email: data.get('email'), password: data.get('password') });
          location.reload();
        } catch (error) {
          $('#login-error').textContent = error.message;
        }
      };
    return;
  }
  $('#account').textContent = user.name;
  $('#signout').onclick = logout;
  $('#dialog-close').onclick = closeModal;
  main().onclick = action;
  initPlayer();
  window.addEventListener('hashchange', () => {
    closeModal();
    route();
  });
  window.addEventListener('library-changed', () => route({ quiet: true }));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !playing()) route({ quiet: true });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.keyCode === 10009) {
      if ($('#dialog').open) {
        e.preventDefault();
        closeModal();
      } else if (playing()) {
        e.preventDefault();
        void closePlayer();
      }
      return;
    }
    if (
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) ||
      ['INPUT', 'SELECT', 'TEXTAREA', 'VIDEO'].includes(document.activeElement.tagName)
    )
      return;
    const root = $('#dialog').open ? $('#dialog') : playing() ? $('#player') : document;
    const candidates = [...root.querySelectorAll('a,button,input,select')].filter(
      (el) => !el.disabled && el.getClientRects().length,
    );
    const origin = document.activeElement.getBoundingClientRect(),
      cx = origin.x + origin.width / 2,
      cy = origin.y + origin.height / 2;
    const horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight',
      positive = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    const ranked = candidates
      .filter((el) => el !== document.activeElement)
      .map((el) => {
        const r = el.getBoundingClientRect(),
          dx = r.x + r.width / 2 - cx,
          dy = r.y + r.height / 2 - cy;
        return { el, primary: horizontal ? dx : dy, secondary: horizontal ? dy : dx };
      })
      .filter((c) => (positive ? c.primary > 5 : c.primary < -5))
      .sort(
        (a, b) =>
          Math.abs(a.primary) +
          Math.abs(a.secondary) * 3 -
          (Math.abs(b.primary) + Math.abs(b.secondary) * 3),
      );
    if (ranked[0]) {
      e.preventDefault();
      ranked[0].el.focus();
      ranked[0].el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  });
  await route();
}
boot().catch((error) => {
  main().innerHTML = empty('Mediawan could not start', error.message);
});
