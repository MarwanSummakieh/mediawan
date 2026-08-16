// One torrent INDEXER, wired to Real-Debrid — the shape every text-searched
// quality-tier provider shares.
//
// This exists because AnimeTosho and Nyaa are the same provider logic pointed
// at different indexes, and folding both into one provider (as a first pass
// did) has a specific failure: they share a circuit breaker, so one index
// throwing suppresses the other for the whole backoff window, and nothing in
// health or the failure note says which index actually found anything. A dead
// index must be able to fail alone — that is the entire lesson of AnimeTosho
// going stale on 2026-05-08 while Nyaa carried on serving the same releases.
//
// Contributes nothing to the episode grid (torrents don't enumerate episodes);
// the grid comes from AniList metadata.
import { debridEnabled, streamFromMagnet } from "../debrid/realdebrid.mjs";
import { rankReleases } from "../torrents.mjs";
import { rankIgnoringFloor, looksFetchable } from "../quality.mjs";
import { wantedSeason, releaseIsRelevant, isMultiSeason, titleForms, seasonMatches } from "../match-release.mjs";
import { fetchAbsoluteOffset } from "../anilist.mjs";

// Episodes aired before this entry, 0 when it starts its own numbering. Guarded
// so a probe meta (negative/absent id) never reaches AniList.
async function absoluteOffset(meta) {
  const id = meta?.anilistId;
  if (!Number.isInteger(id) || id <= 0) return 0;
  return fetchAbsoluteOffset(id).catch(() => 0);
}

// Empty result plus a human reason. The note rides ON the array so the provider
// contract (`streams.length`) is unchanged for every existing caller and test —
// only code that looks for `.note` sees the addition.
export function withNote(list, tally, considered, emptyNote = "nothing indexed for this episode yet") {
  // Nothing was even tried. This is the ordinary case for an episode that
  // hasn't aired (or aired minutes ago), and it is a completely different
  // message from "we tried and they were all blocked" — the first means wait,
  // the second means pick another release.
  if (!considered) return Object.assign(list, { note: emptyNote });
  const parts = [];
  if (tally.blocked) parts.push(`${tally.blocked} blocked (takedown)`);
  if (tally.uncached) parts.push(`${tally.uncached} not cached`);
  if (tally.error) parts.push(`${tally.error} failed`);
  parts.push(`of ${considered} found`);
  return Object.assign(list, { note: parts.join(", ") });
}

// The query forms a text index will actually match.
//
// AniList names a sequel "Shingeki no Kyojin Season 2"; essentially every
// release group writes "S2". Nyaa matches literally, so the AniList form found
// ZERO results for an episode with three usable releases — measured on Attack
// on Titan Season 2 episode 5, where "…Season 2" returned nothing and "…S2"
// returned hits. The English and romaji titles diverge the same way, so both
// base forms are tried.
//
// Ordered widest-confidence first, and searching stops at the first form that
// returns anything. Dropping the season from a query is safe because
// releaseIsRelevant re-checks the season on every result afterwards.
// A split-cour entry adds a THIRD problem: its AniList name carries a cour
// subtitle the releases never use. "BLEACH: Sennen Kessen-hen - Kashin-tan"
// ships as "Bleach - Sennen Kessen-hen - 41", so searching the full name found
// one stray release while the run title found the field. Dropping the trailing
// " - <subtitle>" recovers the name groups actually publish under.
const runTitle = (t) => {
  const m = String(t || "").match(/^(.{6,}?)\s+[-–—]\s+\S.*$/);
  return m ? m[1].trim() : null;
};

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// The words that identify THIS cour rather than the run it belongs to — the
// trailing subtitle of each title form ("Kashin-tan", "The Calamity").
//
// Needed because a continuation's NATIVE episode number also matches earlier
// cours: asked for "The Calamity" episode 1, a search for episode 1 returned
// "Bleach.S17.E01-E13" — cour one — which then outranked the correct release on
// picture quality and played the wrong episode entirely. A release claiming the
// native number has to name this cour to be believed.
export function courMarkers(meta) {
  const out = new Set();
  for (const t of [meta?.romaji, meta?.title]) {
    const m = String(t || "").match(/^.{6,}?\s+[-–—]\s+(\S.*)$/);
    if (!m) continue;
    const marker = norm(m[1].replace(/^the\s+/i, ""));
    if (marker.length >= 4) out.add(marker);
  }
  return [...out];
}

export function titleQueries(meta, baseQuery) {
  const season = wantedSeason(meta);
  const forms = new Set([baseQuery]);
  if (season > 1) {
    forms.add(String(baseQuery).replace(/\bseason\s*(\d+)\b/i, "S$1"));
    for (const t of titleForms(meta)) forms.add(`${t} S${season}`);
  }
  for (const t of titleForms(meta)) forms.add(t);
  // Run titles last: they are the broadest form, and the episode filter plus
  // releaseIsRelevant still gate everything they return.
  for (const t of [baseQuery, ...titleForms(meta)]) {
    const run = runTitle(t);
    if (run) forms.add(run);
  }
  return [...forms].filter(Boolean);
}

// Everything BEFORE Real-Debrid: search every query form, gate identity, rank.
//
// Exported separately from the resolve loop so `npm run why` can print exactly
// what a play would have considered — same queries, same gates, same order —
// without spending Real-Debrid calls to do it.
export async function gatherCandidates({ search, show, ep, mode }) {
  const runtimeMin = show.meta?.duration ?? null;
  // For a dub request, add the dual-audio vocabulary to the SEARCH as well —
  // ranking can only order what the indexer returned, and a plain title
  // query buries dual-audio releases behind dozens of Japanese-only ones.
  const forms = titleQueries(show.meta, show.query);
  const queries = mode === "dub"
    ? [`${show.query} dual audio`, `${show.query} dual`, ...forms]
    : forms;
  // Episode numbers a release might carry for THIS episode.
  //
  // A split-cour show is one AniList entry per cour, each numbered from 1,
  // while release groups number the run continuously: Bleach TYBW "The
  // Calamity" episode 1 ships as "- 41". When an offset exists this entry is
  // a CONTINUATION, and its native numbering belongs to an earlier cour — so
  // the absolute number leads. Getting this backwards is not a miss, it is
  // wrong content: asked for Bleach "The Calamity" episode 1, the native
  // number matched a "Bleach.S17.E01-E13" BluRay pack — cour ONE — and
  // happily played its first episode. The native number stays as a fallback
  // for the groups that do restart at 1.
  const offset = Number(ep) > 0 ? await absoluteOffset(show.meta) : 0;
  const epNums = offset > 0 ? [String(Number(ep) + offset), String(ep)] : [String(ep)];
  const markers = offset > 0 ? courMarkers(show.meta) : [];

  // Every query form, in PARALLEL, merged.
  //
  // These used to run in sequence with a break on the first form that
  // returned anything, which let a single stray result short-circuit the
  // broader forms behind it: Bleach's full cour title matched one release
  // that then failed the relevance gate, and the run title that had the
  // whole field was never tried. Merging is also faster — these are
  // independent HTTP reads, not a chain.
  let found = [];
  let epUsed = epNums[0];
  for (const epNum of epNums) {
    const lists = await Promise.all(queries.map((q) => search(q, epNum).catch(() => [])));
    const seen = new Set();
    const hits = [];
    for (const c of lists.flat()) {
      const id = c.hash || c.magnet || c.name;
      if (!seen.has(id)) { seen.add(id); hits.push(c); }
    }
    if (!hits.length) continue;
    // On a continuation, the NATIVE number is ambiguous — it addresses an
    // earlier cour just as well as this one — so those candidates must name
    // this cour to be trusted. The absolute number needs no such proof: it
    // is unique across the whole run.
    const usable = (offset > 0 && epNum === String(ep) && markers.length)
      ? hits.filter((c) => markers.some((m) => norm(c.name).includes(m)))
      : hits;
    if (!usable.length) continue;
    // Only a hit that could plausibly BE this title ends the search — an
    // irrelevant one is the same as nothing, and stopping on it is how the
    // absolute-numbering fallback got skipped entirely.
    if (usable.some((c) => releaseIsRelevant(c.name, show.meta))) { found = usable; epUsed = epNum; break; }
    if (!found.length) { found = usable; epUsed = epNum; } // nothing better so far
  }

  // Identity gate — right show AND right season — applied BEFORE ranking.
  //
  // Text search is fuzzy: asking for "Shingeki no Kyojin Season 2" returns
  // Season 1 packs, spin-offs and other entries in the franchise. Ranking
  // cannot be trusted to sort that out, because a strong preference beats
  // relevance — measured live, a dual-audio Season 1 pack outscored the
  // correct Season 2 release on a dub request, and its "episode 01" file
  // would have played as season 2's premiere.
  const wantSeason = wantedSeason(show.meta);
  const relevant = found.filter((c) => releaseIsRelevant(c.name, show.meta));

  // When the gate empties the list, nothing here could be CONFIRMED as the
  // right thing. For a sequel, serving the unfiltered list anyway is
  // precisely the bug this gate exists to prevent — better to return
  // nothing and let an id-mapped source answer. For a first season the
  // inference is reliable enough that an empty gate is more likely
  // over-strict matching than genuinely wrong content, so fall back.
  // The fallback must never re-admit a release that CONTRADICTS the season.
  //
  // It used to fall back to the raw list, which let "[Judas] Sousou no
  // Frieren (Season 02)" serve season ONE episode 2 — the gate had already
  // rejected it, and the fallback handed it back. seasonMatches only
  // rejects a direct contradiction (a release stating no season still
  // passes), so this keeps the fallback's purpose — forgiving fuzzy title
  // matching — without forgiving the one thing that is provably wrong.
  const notContradicting = found.filter((c) => seasonMatches(c.name, wantSeason));
  const pool = relevant.length ? relevant : (wantSeason > 1 ? [] : notContradicting);
  // Anime resolves through Real-Debrid, whose takedown filter refuses tagged
  // release names outright — rank with that in mind (see RD_FILTERED_TAGS).
  const cands = rankReleases(pool, { runtimeMin, mode, rdFilter: true });
  return { found, pool, cands, epUsed, wantSeason, runtimeMin };
}

// `search(query, ep)` is the only thing that differs between these providers.
export function makeTorrentProvider({ name, label, search }) {
  return {
    name,
    label,
    tier: "quality",
    // Without a token this declines every title, which would otherwise read as
    // "no match" — a non-fault — in the admin panel. See getProvidersHealth.
    available: debridEnabled,
    async match(meta) {
      if (!debridEnabled()) return null;
      const query = meta.romaji || meta.title;
      return query ? { query, meta } : null;
    },
    async episodes() {
      return { sub: [], dub: [] }; // stream-only; the grid comes from metadata
    },
    async resolve(show, ep, mode) {
      // Dub is served by DUAL-AUDIO releases, not by a separate source: release
      // files carry both languages in one container, so a dub request is a
      // ranking preference plus an audio-track selection at playback — and one
      // download serves both.
      const { found, pool, cands, epUsed, wantSeason, runtimeMin } =
        await gatherCandidates({ search, show, ep, mode });
      // Distinguish the two ways this list can be empty: the index had nothing
      // at all, versus it had results that couldn't be confirmed as this season.
      if (!pool.length) return withNote([], {}, 0, found.length
        ? `${found.length} release(s) found but none confirmed as this season`
        : "nothing indexed for this episode yet");

      // The dual-audio field is narrower and less often debrid-cached, so a dub
      // request needs more attempts and can afford a shorter wait on each. Both
      // budgets are wide because the top-ranked candidates of a popular show are
      // the ones most likely to be DMCA-blocked, and those refusals are instant.
      const { attempts, waitMs } = mode === "dub"
        ? { attempts: 10, waitMs: 7000 }
        : { attempts: 10, waitMs: 12000 };
      // Why each candidate was passed over, so a failure can explain itself.
      const tally = { blocked: 0, uncached: 0, error: 0 };
      // The best release that failed as merely UNCACHED (not refused, not
      // dead): if nothing serves, this is the one worth asking Real-Debrid to
      // fetch — the caller reads it off the result (see fetchCandidate below).
      let fetchable = null;
      const sawUncached = (c) => {
        tally.uncached++;
        if (!fetchable && looksFetchable(c)) fetchable = c;
      };
      const want = (c) => ({
        titles: titleForms(show.meta),
        // The number the RELEASE uses, which for a split-cour continuation is
        // the absolute one — the file inside the torrent is named the same way
        // its torrent is.
        episode: epUsed,
        // A multi-season pack numbers its files absolutely, so an episode
        // number alone picks the wrong season's episode. Passing `season`
        // makes pickVideoFile demand an S02E01-style filename; a pack with
        // only absolute numbering then matches nothing and we move on —
        // refusing beats serving season 1 when season 2 was asked for.
        season: isMultiSeason(c.name) ? wantSeason : undefined,
      });
      const tryList = async (list) => {
        for (const c of list) {
          try {
            const s = await streamFromMagnet(c.magnet, {
              waitMs,
              metaTries: 6,
              // A skipped candidate reports WHY — blocked vs merely uncached —
              // which the two outcomes' shared control flow would otherwise lose.
              onSkip: (reason) => (reason === "uncached" ? sawUncached(c) : tally[reason]++),
              want: want(c),
            });
            if (s) return [{
              ...s,
              quality: c.quality ? String(c.quality) : "auto",
              provider: name,
              tier: "quality",
              // Identity is INFERRED, not verified: the index is searched by
              // title text, so which season a result belongs to is read off the
              // release name. That inference is weak for sequels — anime seasons
              // share a base title and differ only in a suffix — so the registry
              // ranks this behind an id-mapped source when a sequel was requested.
              identityVerified: false,
              // The ranker's score travels WITH the stream so the registry can
              // rank across providers. Without it, ordering falls back to array
              // position and a worse release can win on nothing but listing order.
              score: c._s ?? null,
              release: c.name,
              mbps: c.mbps ?? null,
              audioLabel: c.audioLabel ?? null,
              // What the release NAME claims about spoken language — the Servers
              // panel shows it so a source can be chosen by language before it
              // plays. ffprobe's real track list supersedes it once delivered.
              langLabel: c.langLabel ?? null,
              // Names the INDEX that found it, not the debrid service that serves
              // it — every one of these plays through Real-Debrid, so "Real-Debrid"
              // on every row said nothing and hid which index was actually working.
              source: `${label} · ${[c.quality ? `${c.quality}p` : null, c.tier, c.audioLabel].filter(Boolean).join(" · ") || "release"}`,
            }];
            // (a null return already counted itself via onSkip)
          } catch (e) {
            // uncached/blocked/one bad candidate — try the next, but remember why
            if (e?.code === 35 || /infringing/i.test(e?.message || "")) tally.blocked++;
            else if (/not cached/i.test(e?.message || "")) sawUncached(c);
            else tally.error++;
          }
        }
        return null;
      };

      const first = cands.slice(0, attempts);
      let served = await tryList(first);

      // The floor kept only releases worth watching — but a floor-approved
      // list where EVERY entry is blocked or uncached serves nothing at all.
      // Grand Blue S3 episode 4: five releases, the 1080p pair 451-blocked,
      // the 720p/480p never even attempted because the floor had already
      // dropped them. A watchable 720p beats a 502, so when the gated list is
      // exhausted the sub-floor releases get a few attempts of their own —
      // ranked the same way, floor ignored.
      let considered = first.length;
      if (!served) {
        const tried = new Set(first.map((c) => c.hash || c.magnet || c.name));
        const below = rankIgnoringFloor(pool, { runtimeMin, mode, rdFilter: true })
          .filter((c) => !tried.has(c.hash || c.magnet || c.name))
          .slice(0, 4);
        considered += below.length;
        if (below.length) served = await tryList(below);
      }
      if (served) return served;

      const out = withNote([], tally, considered);
      // Nothing cached, but something fetchable — hand the play route what it
      // needs to start a Real-Debrid download and answer 202 instead of 502,
      // the same contract movies and TV already have. Riding on the array like
      // `note` so the provider contract (`streams.length`) is unchanged.
      if (fetchable) out.fetchCandidate = {
        magnet: fetchable.magnet,
        name: fetchable.name,
        quality: fetchable.quality ?? null,
        want: want(fetchable),
      };
      return out;
    },
  };
}
