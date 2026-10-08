import { esc } from './core.js';

export function durationLabel(seconds) {
  if (!(seconds > 0)) return 'Runtime unavailable';
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  const minutes = Math.round(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
    : `${minutes} min`;
}
export function itemRuntime(item) {
  return `${durationLabel(item.durationSeconds)}${item.durationSource === 'file' ? ' · Local file' : item.durationSource === 'estimate' ? ' · Estimated' : item.durationSeconds ? ' · Catalog' : ''}`;
}
export function metadataHtml(title) {
  const movie = title.kind === 'movie';
  const runtime =
    movie && title.items[0]?.durationSeconds
      ? itemRuntime(title.items[0])
      : `${durationLabel(title.runtimeSeconds)}${!movie && title.runtimeSeconds ? ' per episode · Typical' : ''}`;
  const facts = [
    runtime,
    title.imdbRating ? `IMDb ${title.imdbRating}/10` : '',
    title.anilistRating ? `AniList ${title.anilistRating}/100` : '',
    title.status?.replace(/_/g, ' '),
  ];
  const fields = [
    ['Released', title.released?.slice(0, 10)],
    ['Director', title.directors],
    ['Writers', title.writers],
    ['Cast', title.cast],
    ['Country', title.country],
    ['Language', title.language],
    ['Network', title.network],
    ['Studio', title.studios],
    ['Awards', title.awards],
  ];
  const rows = fields
    .map(([name, value]) => {
      const text = Array.isArray(value) ? value.join(', ') : value;
      return text ? `<div><dt>${name}</dt><dd>${esc(text)}</dd></div>` : '';
    })
    .join('');
  const trailers = (title.trailers || [])
    .filter((t) => /^[\w-]{11}$/.test(t.id))
    .map(
      (t, i) =>
        `<a href="https://www.youtube.com/watch?v=${esc(t.id)}" target="_blank" rel="noopener noreferrer">${esc(t.name)} ${i + 1}</a>`,
    )
    .join(' · ');
  const source = /^tt\d+$/.test(title.external_id)
    ? `<a href="https://www.imdb.com/title/${esc(title.external_id)}/" target="_blank" rel="noopener noreferrer">IMDb</a> · Cinemeta`
    : title.kind === 'anime' && /^\d+$/.test(title.external_id)
      ? `<a href="https://anilist.co/anime/${esc(title.external_id)}" target="_blank" rel="noopener noreferrer">AniList</a>`
      : '';
  const tvmaze = Number.isInteger(title.tvmazeId)
    ? ` · Episode data: <a href="https://www.tvmaze.com/shows/${title.tvmazeId}" target="_blank" rel="noopener noreferrer">TVmaze</a> (<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA</a>)`
    : '';
  return `<p class="runtime-facts">${facts.filter(Boolean).map(esc).join(' · ')}</p><details class="metadata-details"><summary>Cast &amp; details</summary><dl class="metadata-list">${rows}</dl>${trailers ? `<p class="meta">${trailers}</p>` : ''}<p class="meta">${source}${tvmaze}</p><button class="quiet" data-action="refresh-metadata">Refresh metadata</button></details>`;
}
export function episodeMetadata(item) {
  const file = item.fileInfo;
  const technical = file
    ? [
        file.width && file.height ? `${file.width} × ${file.height}` : '',
        file.video?.toUpperCase(),
        file.bytes ? `${(file.bytes / 1073741824).toFixed(2)} GiB` : '',
        ...(file.audio || []).map(
          (a) => `${a.language} ${a.codec?.toUpperCase()}${a.channels ? ` ${a.channels}ch` : ''}`,
        ),
        (file.subtitles || []).length
          ? `Subtitles: ${[...new Set(file.subtitles.map((s) => s.language))].join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  return `<p class="episode-runtime">${esc(itemRuntime(item))}</p>${item.description ? `<details class="episode-description"><summary>Synopsis</summary><p class="muted">${esc(item.description)}</p></details>` : ''}${technical ? `<details class="episode-description"><summary>File details</summary><p class="meta">${esc(technical)}</p></details>` : ''}`;
}
