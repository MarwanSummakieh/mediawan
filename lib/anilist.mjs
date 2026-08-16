// AniList metadata: the pretty posters/banners/synopses that make the UI feel
// like Netflix. Never called on the render path — server caches into SQLite.
const ENDPOINT = "https://graphql.anilist.co";

async function query(q, variables) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: q, variables }),
  });
  if (!res.ok) throw new Error(`AniList ${res.status}`);
  return res.json();
}

const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english }
  description(asHtml: false)
  coverImage { large extraLarge color }
  bannerImage
  genres
  averageScore
  seasonYear
  startDate { year month day }
  format
  episodes
  duration
  nextAiringEpisode { episode airingAt timeUntilAiring }
`;

// Sortable yyyymmdd number so seasons/movies can be ordered chronologically.
const dateNum = (d) => (d?.year ? d.year * 10000 + (d.month || 0) * 100 + (d.day || 0) : null);

function shape(m) {
  return {
    anilistId: m.id,
    malId: m.idMal ?? null,
    title: m.title.english || m.title.romaji,
    romaji: m.title.romaji,
    description: (m.description || "").replace(/<[^>]+>/g, "").slice(0, 600),
    cover: m.coverImage?.extraLarge || m.coverImage?.large,
    color: m.coverImage?.color || "#222",
    banner: m.bannerImage,
    genres: (m.genres || []).slice(0, 4),
    score: m.averageScore,
    year: m.seasonYear || m.startDate?.year,
    start: dateNum(m.startDate),
    format: m.format,
    episodes: m.episodes,
    // Minutes per episode. The quality ranker needs it: size-over-runtime is
    // the only reliable way to tell a real 1080p release from a smeared
    // re-encode wearing the same "1080p" tag (see lib/quality.mjs).
    duration: m.duration ?? null,
    // for currently-airing shows: the next episode, when it airs (epoch secs),
    // and seconds until it airs
    airing: m.nextAiringEpisode
      ? { episode: m.nextAiringEpisode.episode, at: m.nextAiringEpisode.airingAt, inSeconds: m.nextAiringEpisode.timeUntilAiring }
      : null,
  };
}

// Browse/search surfaces are Japan-only: AniList's ANIME type also covers
// Chinese donghua and Korean animation, which kept surfacing in the anime tab.
// (Title-specific lookups — relations, episode meta — stay unfiltered.)
const JP = `countryOfOrigin: "JP"`;

// A themed row (e.g. TRENDING_DESC, POPULARITY_DESC) for the browse page.
export async function fetchRow(sort, perPage = 18) {
  const q = `query ($sort: [MediaSort], $perPage: Int) {
    Page(perPage: $perPage) {
      media(type: ANIME, sort: $sort, isAdult: false, ${JP}) { ${MEDIA_FIELDS} }
    }
  }`;
  const json = await query(q, { sort: [sort], perPage });
  return (json?.data?.Page?.media ?? []).map(shape);
}

// Refresh specific titles by id.
//
// The browse rows keep their own titles current, but everything reached another
// way — search, a franchise link, My List, Continue Watching — was cached once
// and then never looked at again. For a FINISHED show that is harmless; for one
// still airing it is not: the episode grid is built from `airing.episode` (see
// episodeGrid in lib/providers/index.mjs), so a stale copy pins the list at
// whatever had aired when the title was first opened and this week's episode
// never shows up.
//
// Batched by id_in so a row of titles costs one request rather than twenty.
export async function fetchMetas(ids = []) {
  const list = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) return [];
  const q = `query ($ids: [Int], $perPage: Int) {
    Page(perPage: $perPage) {
      media(type: ANIME, id_in: $ids) { ${MEDIA_FIELDS} }
    }
  }`;
  // Deliberately unfiltered by country: this refreshes titles the user already
  // has, and the JP filter belongs to discovery surfaces only.
  const json = await query(q, { ids: list, perPage: Math.min(50, list.length) });
  return (json?.data?.Page?.media ?? []).map(shape);
}

export async function fetchMeta(id) {
  return (await fetchMetas([id]))[0] || null;
}

// Titles matching a set of genres, popular first — powers "Because you watched".
export async function fetchByGenres(genres, perPage = 18) {
  const q = `query ($genres: [String], $perPage: Int) {
    Page(perPage: $perPage) {
      media(type: ANIME, genre_in: $genres, sort: POPULARITY_DESC, isAdult: false, ${JP}) { ${MEDIA_FIELDS} }
    }
  }`;
  const json = await query(q, { genres, perPage });
  return (json?.data?.Page?.media ?? []).map(shape);
}

// A page of titles for one genre (category browsing). Sort is caller-chosen.
export async function fetchCategory(genre, { sort = "POPULARITY_DESC", page = 1, perPage = 30 } = {}) {
  const q = `query ($genre: String, $sort: [MediaSort], $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      media(type: ANIME, genre: $genre, sort: $sort, isAdult: false, ${JP}) { ${MEDIA_FIELDS} }
    }
  }`;
  const json = await query(q, { genre, sort: [sort], page, perPage });
  return (json?.data?.Page?.media ?? []).map(shape);
}

// One page of the unified Browse grid, filtered the same way films and shows
// are (genre + sort + year). AniList pages by number where Cinemeta pages by an
// opaque skip cursor, so the caller's `skip` is translated to a page here —
// that keeps ONE filter contract on the client for three different backends.
// hasMore is "the page came back full", the same test lib/stremio/addons.mjs
// uses; AniList's own pageInfo.hasNextPage agrees but costs an extra field on
// every query for a value we can infer.
const BROWSE_SORTS = {
  popular: "POPULARITY_DESC",
  featured: "SCORE_DESC",   // "Featured" is Cinemeta's rating catalog; score is ours
  new: "START_DATE_DESC",
  trending: "TRENDING_DESC",
};
export async function fetchBrowse({ genre = null, sort = "popular", year = null, skip = 0, perPage = 40 } = {}) {
  const page = Math.floor(skip / perPage) + 1;
  // A year narrows to that season-year; sorting by date inside it is what makes
  // "2019 + New" read chronologically rather than by popularity.
  const filters = [
    genre ? "genre: $genre" : null,
    year ? "seasonYear: $year" : null,
  ].filter(Boolean).join(", ");
  const vars = [
    "$sort: [MediaSort]", "$page: Int", "$perPage: Int",
    genre ? "$genre: String" : null,
    year ? "$year: Int" : null,
  ].filter(Boolean).join(", ");
  const q = `query (${vars}) {
    Page(page: $page, perPage: $perPage) {
      media(type: ANIME, sort: $sort, isAdult: false, ${JP}${filters ? ", " + filters : ""}) { ${MEDIA_FIELDS} }
    }
  }`;
  const json = await query(q, {
    sort: [BROWSE_SORTS[sort] || BROWSE_SORTS.popular],
    page, perPage,
    ...(genre ? { genre } : {}),
    ...(year ? { year } : {}),
  });
  const items = (json?.data?.Page?.media ?? []).map(shape);
  return { items, hasMore: items.length >= perPage, nextSkip: skip + items.length };
}

// Currently-airing shows ("Now Airing" seasonal row), trending first. Each
// carries next-episode info via shape().airing for the countdown badge.
export async function fetchAiring(perPage = 24) {
  const q = `query ($perPage: Int) {
    Page(perPage: $perPage) {
      media(type: ANIME, status: RELEASING, sort: TRENDING_DESC, isAdult: false, format_in: [TV, TV_SHORT, ONA], ${JP}) { ${MEDIA_FIELDS} }
    }
  }`;
  const json = await query(q, { perPage });
  return (json?.data?.Page?.media ?? []).map(shape);
}

// Per-episode metadata for the rich episode list: title + thumbnail, keyed by
// episode number. Titles come as "Episode N - Title"; we parse N and strip it.
export async function fetchEpisodeMeta(id) {
  const q = `query ($id: Int) {
    Media(id: $id, type: ANIME) { streamingEpisodes { title thumbnail } }
  }`;
  const json = await query(q, { id });
  const list = json?.data?.Media?.streamingEpisodes ?? [];
  const map = {};
  list.forEach((e, i) => {
    const m = (e.title || "").match(/^\s*(?:episode|ep|e)\s*(\d+)\s*[-:–]?\s*(.*)$/i);
    const num = m ? Number(m[1]) : i + 1;          // parse the number, else use order
    const title = (m && m[2]) ? m[2].trim() : (e.title || "").trim();
    map[num] = { title, thumbnail: e.thumbnail || null };
  });
  return map;
}

// A random reasonably-popular title: pick the Nth most popular for random N,
// which keeps results watchable while still feeling like a lucky dip.
export async function fetchRandom() {
  const page = 1 + Math.floor(Math.random() * 500); // among the top ~500 popular
  const q = `query ($page: Int) {
    Page(page: $page, perPage: 1) {
      media(type: ANIME, sort: POPULARITY_DESC, isAdult: false, ${JP}) { ${MEDIA_FIELDS} }
    }
  }`;
  const json = await query(q, { page });
  const m = json?.data?.Page?.media?.[0];
  return m ? shape(m) : null;
}

// MAL id lookup for titles cached before malId was part of the shape.
export async function fetchMalId(id) {
  const q = `query ($id: Int) { Media(id: $id, type: ANIME) { idMal } }`;
  const json = await query(q, { id });
  return json?.data?.Media?.idMal ?? null;
}

// One media entry plus its direct relations. AniList models every season,
// movie, and OVA as a separate Media entry linked by edges (SEQUEL, PREQUEL,
// SIDE_STORY, …) — this is the raw material for the franchise/seasons view.
export async function fetchRelations(id) {
  const q = `query ($id: Int) {
    Media(id: $id, type: ANIME) {
      ${MEDIA_FIELDS}
      relations {
        edges {
          relationType(version: 2)
          node { type isAdult ${MEDIA_FIELDS} }
        }
      }
    }
  }`;
  const json = await query(q, { id });
  const m = json?.data?.Media;
  if (!m) return null;
  const edges = (m.relations?.edges ?? [])
    .filter((e) => e.node?.type === "ANIME" && !e.node.isAdult)
    .map((e) => ({ relation: e.relationType, node: shape(e.node) }));
  return { self: shape(m), edges };
}

// How many episodes aired BEFORE this entry in the same continuous run.
//
// AniList models a split-cour show as one entry per cour, each numbered from 1.
// Release groups number the whole run continuously: "BLEACH: Thousand-Year
// Blood War - The Calamity" episode 1 ships as "Bleach - Sennen Kessen-hen -
// 41", because the three preceding cours were 13 + 13 + 14. Asking an index for
// episode 1 therefore matched nothing at all, and every continuation of a long
// show reported "nothing indexed for this episode yet".
//
// Walking PREQUEL edges and summing their episode counts gives the offset. Only
// TV-shaped prequels count — a movie or OVA in the chain is not part of the
// broadcast numbering. The result is a CANDIDATE alias, never a replacement:
// plenty of sequels restart at 1, so callers try the native number first.
const offsetCache = new Map(); // anilistId -> episodes aired before it
const NUMBERED_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);

// Does the prequel belong to the same NAMED run, or is it an earlier era of the
// franchise that groups number separately?
//
// The walk has to stop somewhere, and the title is where. Bleach's Thousand-
// Year Blood War cours are numbered 1-52 among themselves; walking past them
// into the original 366-episode Bleach produced an offset of 406 and an alias
// of "episode 407" for something released as "41". Comparing how much of the
// two titles is a shared prefix separates "…Sennen Kessen-hen - Kashin-tan" vs
// "…Sennen Kessen-hen - Ketsubetsu-tan" (same run, 0.67) from
// "…Sennen Kessen-hen" vs "BLEACH" (different era, 0.24).
function sameRun(a, b) {
  const x = String(a || "").toLowerCase(), y = String(b || "").toLowerCase();
  if (!x || !y) return false;
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i / Math.max(x.length, y.length) >= 0.5;
}

export async function fetchAbsoluteOffset(id, { maxHops = 6 } = {}) {
  if (offsetCache.has(id)) return offsetCache.get(id);
  let offset = 0;
  let cur = id;
  let curTitle = null;
  const seen = new Set([id]);
  try {
    for (let hop = 0; hop < maxHops; hop++) {
      const rel = await fetchRelations(cur);
      if (!rel) break;
      if (curTitle === null) curTitle = rel.self.romaji || rel.self.title;
      const prequel = rel.edges.find((e) =>
        e.relation === "PREQUEL" && NUMBERED_FORMATS.has(e.node.format) && !seen.has(e.node.anilistId));
      if (!prequel) break;
      // A differently-named predecessor is a different numbering era — stop.
      if (!sameRun(curTitle, prequel.node.romaji || prequel.node.title)) break;
      const eps = Number(prequel.node.episodes);
      // An unknown episode count makes every earlier hop unusable too — a
      // partial sum would be a confidently wrong number, which is worse than
      // no alias at all.
      if (!Number.isFinite(eps) || eps <= 0) { offset = 0; break; }
      offset += eps;
      seen.add(prequel.node.anilistId);
      cur = prequel.node.anilistId;
      curTitle = prequel.node.romaji || prequel.node.title; // compare each hop against its own predecessor
    }
  } catch { offset = 0; } // a lookup failure just means "no alias"
  offsetCache.set(id, offset);
  return offset;
}

// Single best match for a title — used when something else (a release name, a
// Cinemeta entry) already picked the show and we only want its artwork.
export async function searchMeta(term) {
  return (await searchManyMeta(term, 1))[0] ?? null;
}

// AniList IS the search index now.
//
// Search used to run against a scraper and then decorate each hit with AniList
// metadata, which meant the catalogue you could browse was whatever that
// scraper happened to know about — and it went blank entirely when the scraper
// did. Searching AniList directly inverts that: the catalogue is the metadata
// provider, and which sources can actually serve a title is resolved later, per
// play, by the provider registry. A title with no available source now shows up
// and reports itself unplayable, rather than being invisible.
export async function searchManyMeta(term, perPage = 12) {
  const q = `query ($search: String, $perPage: Int) {
    Page(perPage: $perPage) {
      media(type: ANIME, search: $search, sort: SEARCH_MATCH, isAdult: false, ${JP}) { ${MEDIA_FIELDS} }
    }
  }`;
  const json = await query(q, { search: term, perPage });
  return (json?.data?.Page?.media ?? []).map(shape);
}
