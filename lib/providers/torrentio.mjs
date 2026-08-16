// Torrentio as an anime STREAM fallback — the Stremio-stack sibling of the
// AnimeTosho debrid provider. Torrentio indexes far more anime trackers than
// AnimeTosho alone and already maps episodes into season packs (fileIdx), but
// it speaks Kitsu ids, so matching means translating AniList → Kitsu first
// (relations.yuna.moe, cached per title). Like every lazy provider it is
// warm-started in the background on each resolve and only surfaced when the
// scrapers come up empty; playback still goes through OUR Real-Debrid client,
// so the RD token never reaches Torrentio.
import { torrentioReleases, preferQuality } from "../stremio/addons.mjs";
import { withNote } from "./debrid.mjs";
import { wantedSeason, isMultiSeason, seasonMatches, titleForms } from "../match-release.mjs";
import { debridEnabled, streamFromMagnet } from "../debrid/realdebrid.mjs";
import { looksFetchable } from "../quality.mjs";

const RELATIONS = process.env.RELATIONS_BASE || "https://relations.yuna.moe";

// anilistId -> kitsu id (or null when the mapping service has no entry).
const kitsuCache = new Map();
async function kitsuIdFor(anilistId) {
  if (kitsuCache.has(anilistId)) return kitsuCache.get(anilistId);
  let kitsu = null;
  try {
    const r = await fetch(`${RELATIONS}/api/ids?source=anilist&id=${anilistId}`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) kitsu = (await r.json())?.kitsu ?? null;
  } catch {} // mapping service down → treat as no-match; the next resolve retries
  if (kitsu !== null) kitsuCache.set(anilistId, kitsu); // don't cache failures
  return kitsu;
}

export const torrentioAnimeProvider = {
  name: "torrentio",
  label: "Torrentio",
  tier: "quality", // release files — the only tier that reaches REMUX/4K/5.1
  // Playback still goes through OUR debrid client, so no token means this
  // cannot serve either. See getProvidersHealth in ./index.mjs.
  available: debridEnabled,
  async match(meta) {
    if (!debridEnabled()) return null;
    if (!Number.isInteger(meta.anilistId) || meta.anilistId <= 0) return null; // probes use negative ids
    const kitsu = await kitsuIdFor(meta.anilistId);
    return kitsu ? { kitsu, meta } : null;
  },
  async episodes() {
    return { sub: [], dub: [] }; // stream-only; the grid comes from metadata now
  },
  async resolve(show, ep, mode) {
    // Dub is a dual-audio release plus a track selection, not a separate
    // source — see lib/providers/debrid.mjs for why this no longer refuses.
    // Kitsu-id streams are served under "series" (Anime Kitsu convention); a few
    // deployments use "anime" — try both before giving up.
    let releases = await torrentioReleases("series", `kitsu:${show.kitsu}:${Number(ep)}`).catch(() => []);
    if (!releases.length)
      releases = await torrentioReleases("anime", `kitsu:${show.kitsu}:${Number(ep)}`).catch(() => []);
    // preferQuality ranks on picture/sound while keeping Torrentio's own order
    // as the tiebreak — its ordering encodes which release holds the right
    // episode, and a pure re-rank can promote a pack whose fileIdx points at a
    // spin-off. Waits are generous here: this is the tier worth waiting for.
    const runtimeMin = show.meta?.duration ?? null;
    // A dub request searches a much narrower field: dual-audio releases are a
    // minority, and being less popular they are less often already sitting in
    // the debrid cache. Four attempts is enough when any good release will do;
    // for dub it ran out before finding a cached one and reported "no dub
    // available" for an episode that has plenty. Widen the search and shorten
    // each wait so the extra attempts don't cost proportionally more time —
    // an uncached torrent is what the wait is spent on, and it fails either way.
    // Attempts are budgeted for the EXPENSIVE case (a torrent added, then
    // polled for a cache hit). Cheap rejections — DMCA-blocked hashes, which
    // RD refuses at addMagnet in ~200ms — used to consume that budget anyway,
    // and they cluster at the TOP of the ranked list because the best-seeded
    // release of a popular show is the one that gets taken down first. Measured
    // on "Smoking Behind the Supermarket with You" ep 1: the top 3 ranked
    // candidates were all blocked, so a 4-attempt sub budget had one real try
    // left and the episode reported no sources while 8 usable releases sat
    // further down. Sub gets the same width as dub.
    const { attempts, waitMs } = mode === "dub"
      ? { attempts: 10, waitMs: 7000 }
      : { attempts: 10, waitMs: 12000 };

    // Trust the id mapping for WHICH SHOW, but still check what a release says
    // about its season.
    //
    // The Kitsu id was supposed to make this unnecessary. It doesn't: measured
    // live, a request for Frieren season 1 episode 1 came back with a release
    // named "S02E01" and would have played season two's premiere. Mapping
    // services and release groups disagree about how a continuing show is
    // numbered, so a release that positively claims a different season is
    // dropped here too. Releases that state no season still pass — most don't.
    const want = wantedSeason(show.meta);
    // Playback goes through Real-Debrid, whose takedown filter refuses tagged
    // release names — rank with that in mind (see RD_FILTERED_TAGS in quality.mjs).
    const ranked = preferQuality(releases, { runtimeMin, mode, rdFilter: true });
    const inSeason = ranked.filter((c) => seasonMatches(c.name, want));
    const pool = inSeason.length ? inSeason : ranked;
    const tally = { blocked: 0, uncached: 0, error: 0 }; // see debrid.mjs — failures explain themselves
    // The best merely-UNCACHED candidate, for the play route's fetch-on-demand
    // fallback — see fetchCandidate in torrent-source.mjs.
    let fetchable = null;
    const wantFor = (c) => ({
      titles: titleForms(show.meta),
      episode: ep,
      season: isMultiSeason(c.name) ? want : undefined,
    });
    const sawUncached = (c) => {
      tally.uncached++;
      if (!fetchable && looksFetchable(c)) fetchable = c;
    };
    for (const c of pool.slice(0, attempts)) {
      try {
        // fileIdx is Torrentio's answer to "which file in this pack", and it is
        // usually right — but pickVideoFile treats it as a HINT and checks the
        // filename against `want`. For a multi-season pack that check needs the
        // season, or an absolutely-numbered file ("26" for S02E01) is accepted
        // as episode 1 of season 1. See lib/providers/debrid.mjs.
        const s = await streamFromMagnet(c.magnet, {
          waitMs, metaTries: 6, fileIdx: c.fileIdx,
          onSkip: (reason) => (reason === "uncached" ? sawUncached(c) : tally[reason]++),
          want: wantFor(c),
        });
        if (s) return [{
          ...s,
          quality: c.quality ? String(c.quality) : "auto",
          provider: "torrentio",
          tier: "quality",
          score: c._s ?? null, // see debrid.mjs — lets the registry rank across providers
          // Identity is VERIFIED here: the request was `kitsu:<id>:<ep>`, and a
          // Kitsu id names one specific season, so whatever comes back is that
          // season's episode. The text-searched provider can only infer this
          // from a release name (see debrid.mjs), which is why the registry
          // prefers this source for sequels.
          identityVerified: true,
          release: c.name,
          mbps: c.mbps ?? null,
          audioLabel: c.audioLabel ?? null,
          langLabel: c.langLabel ?? null, // see debrid.mjs — the name's language claim
          source: `Torrentio · ${[c.quality ? `${c.quality}p` : null, c.tier, c.audioLabel].filter(Boolean).join(" · ") || "release"}`,
        }];
        // (a null return already counted itself via onSkip)
      } catch (e) {
        // uncached/blocked/one bad candidate — try the next, but remember why
        if (e?.code === 35 || /infringing/i.test(e?.message || "")) tally.blocked++;
        else if (/not cached/i.test(e?.message || "")) sawUncached(c);
        else tally.error++;
      }
    }
    const out = withNote([], tally, pool.length);
    if (fetchable) out.fetchCandidate = {
      magnet: fetchable.magnet,
      name: fetchable.name,
      quality: fetchable.quality ?? null,
      fileIdx: fetchable.fileIdx ?? null,
      want: wantFor(fetchable),
    };
    return out;
  },
};
