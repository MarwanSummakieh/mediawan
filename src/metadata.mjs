// Catalog runtime is expressed in minutes; local probes use seconds.
export function runtimeSeconds(value) {
  if (typeof value === 'number')
    return value > 0 && Number.isFinite(value) ? value * 60 : undefined;
  const text = String(value || '')
    .trim()
    .toLowerCase();
  if (/^\d+(\.\d+)?$/.test(text)) return runtimeSeconds(Number(text));
  const match = text.match(
    /^(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minutes?))?$/,
  );
  const seconds = match ? (Number(match[1] || 0) * 60 + Number(match[2] || 0)) * 60 : 0;
  return seconds > 0 ? seconds : undefined;
}
export const plainText = (value) =>
  String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
export const populated = (value) =>
  Object.fromEntries(
    Object.entries(value).filter(
      ([, v]) => v !== undefined && v !== null && v !== '' && (!Array.isArray(v) || v.length),
    ),
  );
const names = (value) =>
  Array.isArray(value)
    ? value.filter((v) => typeof v === 'string')
    : typeof value === 'string'
      ? [value]
      : [];
export function catalogMetadata(meta, kind) {
  const linked = (categories) =>
    (meta.links || [])
      .filter((l) => categories.includes(String(l.category).toLowerCase()))
      .map((l) => l.name);
  return populated({
    kind,
    external_id: String(meta.imdb_id || meta.id),
    name: meta.name || meta.title,
    poster: meta.poster,
    background: meta.background,
    logo: meta.logo,
    description: plainText(meta.description),
    year: String(meta.year || meta.releaseInfo || '').slice(0, 4),
    releaseInfo: meta.releaseInfo,
    released: meta.released,
    genres: names(meta.genres || meta.genre),
    cast: names(meta.cast || linked(['cast', 'actor'])),
    directors: names(meta.director || linked(['director', 'directors'])),
    writers: names(meta.writer || linked(['writer', 'writers'])),
    country: meta.country,
    language: meta.language,
    awards: meta.awards,
    imdbRating: meta.imdbRating,
    runtimeSeconds: runtimeSeconds(meta.runtime),
    runtimeSource: runtimeSeconds(meta.runtime) ? 'Cinemeta' : undefined,
    trailers: (meta.trailers || [])
      .filter((t) => /^[\w-]{11}$/.test(t.source || ''))
      .map((t) => ({ id: t.source, name: t.type || 'Trailer' })),
  });
}
