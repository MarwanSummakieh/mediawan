// "Try ranked releases until one streams" — now across every configured debrid
// backend, not just Real-Debrid.
//
// Two failure modes must never be conflated. A backend returning null means it
// answered honestly and simply doesn't have that release cached (or it's
// DMCA-blocked) — a normal miss, move on. A backend THROWING means the API
// itself failed (429, 5xx, auth), and we learned nothing about the cache. Early
// versions reported an RD rate-limit storm as "no cached release", which sent
// people hunting for a film that was there all along. Errors are counted per
// backend so the final message names what actually happened.
//
// With several backends the same distinction scales: one service being down
// must not stop the next from answering, and "nothing is cached anywhere" is
// only true if every backend gave a real answer.
import { serverId, serverLabel, releaseSignature } from "../servers.mjs";
import { enabledBackends, hashOf } from "./backends.mjs";
import { parseSourceTier as parseSource, describe, looksFetchable } from "../quality.mjs";

// Try the best releases first, but do not spend every attempt in one band.
//
// Ranking is quality-first now, which means the top of the list is a wall of
// 60-80 GB 2160p REMUXes. Those are precisely the releases a debrid service is
// LEAST likely to have cached, and since the bulk cache-check endpoint is gone
// (Real-Debrid retired it) the only way to find out is to try each one. Twelve
// attempts could therefore be spent entirely on 4K remuxes and come back with
// "none cached" while a perfectly good 1080p WEB-DL sat further down, cached
// and instant. Seen live on House of the Dragon S01E01: the first six
// candidates were all 2160p REMUX.
//
// So the attempt order interleaves: keep quality order within each resolution
// band, but round-robin across bands. The best release is still tried first —
// this only changes what gets tried SECOND, which is the whole difference
// between "plays instantly" and "no cached release".
export function spreadByQuality(list) {
  const bands = new Map();
  for (const c of list) {
    const b = c.quality || 0;
    if (!bands.has(b)) bands.set(b, []);
    bands.get(b).push(c);
  }
  // Highest band first, so the top pick is unchanged.
  const queues = [...bands.entries()].sort((a, b) => b[0] - a[0]).map(([, v]) => v);
  const out = [];
  while (queues.some((q) => q.length)) {
    for (const q of queues) if (q.length) out.push(q.shift());
  }
  return out;
}

// Attach the release's identity to the stream so the player's Servers panel can
// mark which row is live, and remember it as a favourite.
function decorate(s, c, backend) {
  // `c` has already been through the quality model (rankReleases attaches the
  // describe() fields), but re-derive defensively for hand-picked releases
  // arriving from the Servers panel, which skip ranking entirely.
  const d = c.audioLabel !== undefined ? c : { ...c, ...describe(c) };
  return {
    ...s,
    quality: c.quality ? String(c.quality) : "auto",
    tag: parseSource(c.name),
    tier: "quality",
    release: c.name || null,
    mbps: d.mbps ?? null,
    audioLabel: d.audioLabel ?? null,
    // The panel row now says what the release actually IS — "2160p · REMUX ·
    // TrueHD 7.1" rather than a bare resolution — because that's the axis the
    // ranking is built on and the user is choosing along.
    source: `${backend.label} · ${[c.quality ? `${c.quality}p` : null, d.tier, d.audioLabel].filter(Boolean).join(" · ") || "release"}`,
    backend: backend.name,
    serverId: serverId(c),
    serverLabel: serverLabel(c),
    serverName: c.name || null,
    sig: releaseSignature(c),
  };
}

// Put releases this backend has confirmed cached at the front, keeping ranked
// order within each half. One bulk call replaces a dozen speculative round
// trips — and it means we play the BEST cached release, not the first lucky hit.
async function orderByCache(backend, candidates) {
  if (!backend.checkCached) return { list: candidates, known: false };
  const withHash = candidates.map((c) => ({ c, h: c.hash?.toLowerCase() || hashOf(c.magnet) })).filter((x) => x.h);
  if (!withHash.length) return { list: candidates, known: false };
  let cached;
  try { cached = await backend.checkCached(withHash.map((x) => x.h)); }
  catch { return { list: candidates, known: false }; } // probe failed → fall back to trying blind
  const hit = [], miss = [];
  for (const { c, h } of withHash) (cached.has(h) ? hit : miss).push(c);
  // `known` means the hit list is authoritative: if it's empty, this backend
  // genuinely has nothing and there's no point spending attempts on it.
  return { list: hit.length ? hit : miss, known: true, cachedCount: hit.length };
}

// candidates: rankReleases() output ({ magnet, quality, hash?, fileIdx? }).
// Resolves to { stream } on the first playable release, else { error, detail }.
// `backends` is injectable for tests; callers use the live registry.
// `want` ({ title, year, season, episode }) is what the user actually asked
// for. It travels all the way to the file picker so a compilation pack can be
// rejected instead of silently serving a different film.
// `startDownload` opts in to the nothing-cached fallback: when no release is
// cached anywhere, fetch the best one and return a handle to poll instead of an
// error. It is OFF by default and passed explicitly by the play routes, so that
// side-effecting path is never reached by a caller that only wanted a lookup
// (the quality-menu second pass, for one) or by a unit test.
export async function streamFirstCached(candidates, {
  max = 12, waitMs = 8000, fromMagnet = null, backends = null, want = null,
  startDownload = null,
} = {}) {
  // Back-compat: a bare fromMagnet still behaves as a single anonymous backend,
  // which keeps the existing unit tests (and any caller passing one) honest.
  const list = backends || (fromMagnet
    ? [{ name: "injected", label: "Real-Debrid", enabled: () => true, fromMagnet, remove: async () => {} }]
    : enabledBackends());
  if (!list.length) return { error: "debrid-disabled", detail: "no debrid service is configured" };

  const notes = [];
  // Did ANY backend ever get a real cache answer (a clean "no", not an error)?
  // Only if none did is this an outage rather than an absent film. Deriving
  // that from the note text is what broke it once: a mixed result reads
  // "…none cached (1 API errors…)", which a substring check calls an outage.
  let sawRealAnswer = false;
  // Releases a backend refused for a takedown. The download fallback below must
  // never pick one of these: a blocked hash fails instantly, and it burns the
  // single fetch that fallback gets.
  const blocked = new Set();
  for (const backend of list) {
    const { list: ordered, known, cachedCount } = await orderByCache(backend, candidates);
    // A bulk cache probe answering "I have none of these" IS a real answer.
    if (known && !cachedCount) { sawRealAnswer = true; notes.push(`${backend.label}: has none of them cached`); continue; }
    let tried = 0, apiErrors = 0, lastErr = null;
    // The "hold a transcoded stream and keep hunting for an untouched one"
    // dance is gone. It existed because a container the browser couldn't open
    // had to go through the debrid transcoder, which halves the bitrate — so
    // an .mkv REMUX was something to avoid. Transcoding is local now and takes
    // the original bytes, so container no longer implies quality loss and the
    // FIRST release the ranker picked is simply the one we want.
    let held = null;
    // Don't spend the attempt budget on releases that cannot complete. Each
    // miss costs a full `waitMs`, and a dead torrent misses every time — see
    // looksFetchable. Kept as a LAST RESORT only: if every candidate looks
    // dead, one of them might still be sitting in the service's cache, and
    // trying beats refusing to play.
    const live = ordered.filter(looksFetchable);
    const pool = live.length ? live : ordered;
    if (live.length < ordered.length)
      notes.push(`${backend.label}: skipped ${ordered.length - live.length} release(s) with no seeders`);
    for (const c of spreadByQuality(pool).slice(0, max)) { // cap attempts so a play can't hang
      tried++;
      try {
        const s = await backend.fromMagnet(c.magnet, {
          waitMs, fileIdx: c.fileIdx ?? null, want,
          // Backends that can tell a takedown from a plain miss report it here
          // (Real-Debrid does); ones that can't simply never call it.
          onSkip: (reason) => { if (reason === "blocked") blocked.add(c); },
        });
        if (s) {
          // `file` = original bytes for the local pipeline; `hls` only appears
          // on the degraded path (local transcoding off), and is still better
          // than nothing, so it's held as a safety net rather than returned.
          if (s.type !== "hls") return { stream: decorate(s, c, backend) };
          if (!held) held = { stream: s, candidate: c };
          else backend.remove?.(s.torrentId).catch(() => {}); // don't hoard torrents
        }
        // null → not cached / blocked: the normal miss, try the next release
      } catch (e) {
        // Account-level failures (free account, locked "parcel") won't fix
        // themselves by trying more torrents on THIS service — but another
        // backend may be perfectly healthy, so move on rather than give up.
        if (/premium|parcel/i.test(e.message)) { notes.push(`${backend.label}: ${e.message}`); apiErrors = tried; lastErr = e; break; }
        apiErrors++; lastErr = e;
      }
    }
    // Only the degraded-path stream was available — better than nothing.
    if (held) return { stream: decorate(held.stream, held.candidate, backend) };
    if (tried && apiErrors === tried) {
      // One hand-picked release reads badly as "all 1 attempt(s) failed with
      // API errors" — the count is noise and the cause is what matters.
      notes.push(tried === 1
        ? `${backend.label}: ${lastErr.message}`
        : `${backend.label}: ${lastErr.message} (all ${tried} releases failed the same way)`);
    } else if (tried) {
      sawRealAnswer = true; // at least one candidate came back a genuine miss
      // "none cached" is the honest summary but a poor explanation: a release
      // is also skipped when its files don't match the request. Name the size
      // of the field so the difference between "this episode is unavailable"
      // and "you asked for releases nobody has cached" is visible.
      notes.push(`${backend.label}: tried ${tried} of ${ordered.length} releases, none cached or matching${apiErrors ? ` (${apiErrors} API errors, last: ${lastErr.message})` : ""}`);
    }
  }

  // Nothing was cached anywhere. Rather than stop here, ask the debrid service
  // to FETCH the best release and hand back a handle to poll.
  //
  // This used to be a dead end, and it was a defensible one while a second
  // source existed to carry the play. With one backend it isn't: "none of the
  // releases we tried are cached" ends the request for a title Real-Debrid
  // would have downloaded in a couple of minutes. Waiting on a progress bar is
  // a worse experience than instant playback and a far better one than an
  // error. Only attempted on a genuine cache answer — if every call errored,
  // that's an outage and adding a torrent won't help.
  //
  // The pick is the best-RANKED candidate that can actually complete: it needs
  // live seeders (an uncached zero-seeder torrent never finishes — the one case
  // where looksFetchable's "unknown is fine" optimism is still right, since
  // unknown isn't evidence either way) and it must not be a hash a backend just
  // refused for a takedown. If every candidate fails those tests there is
  // nothing worth fetching, and the honest error below is the answer.
  if (sawRealAnswer && startDownload) {
    const best = candidates.find((c) => looksFetchable(c) && !blocked.has(c));
    if (best) {
      try {
        const d = await startDownload(best.magnet, { fileIdx: best.fileIdx ?? null, want });
        return {
          downloading: {
            ...d,
            release: best.name || null,
            quality: best.quality || null,
            sig: releaseSignature(best),
          },
        };
      } catch (e) {
        notes.push(`download start failed: ${e.message}`);
      }
    }
  }

  return {
    error: sawRealAnswer ? "no cached release" : "debrid-error",
    detail: notes.join("; ") || "no debrid backend produced an answer",
  };
}

// Best cached release in each quality band OTHER than `have` — the lazy second
// pass that fills the player's Quality menu once playback has started.
// Deliberately frugal: few candidates per band, and bands the release list
// doesn't even contain cost nothing.
export async function streamPerBand(candidates, have, { fromMagnet = null, backends = null, want = null } = {}) {
  const streams = [];
  for (const band of [2160, 1080, 720]) {
    if (band === Number(have)) continue;
    const group = candidates.filter((c) => c.quality === band);
    if (!group.length) continue;
    const r = await streamFirstCached(group, { max: 3, waitMs: 8000, fromMagnet, backends, want });
    if (r.stream) streams.push(r.stream);
  }
  return streams;
}
