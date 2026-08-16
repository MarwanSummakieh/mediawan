// Servers — the selectable-source layer under the player's Servers panel.
//
// Until now a movie/TV play was a black box: the server walked its ranked
// release list, streamed the first one Real-Debrid had cached, and the user got
// whatever that was. When the pick was a bad rip, a foreign dub or a 40 GB
// REMUX that buffers, there was no way to say "give me a different one".
//
// A "server" is simply one of those releases, named and addressable. The id has
// to survive a round-trip to the browser AND a ranked-list re-shuffle (the
// caches behind those lists expire in minutes), so it is derived from the
// torrent itself — infoHash plus, for a season pack, the file index of this
// episode — never from a position in an array.
//
// A FAVOURITE is deliberately coarser than an id: pinning one specific torrent
// would be worthless on the next episode. Favourites store a release
// SIGNATURE (quality band + source tag, e.g. "q1080|WEB-DL"), which carries
// across episodes and titles, and only reorders candidates — it never forces an
// uncached release on the player.
import { parseSourceTier as parseSource, parseResolution as parseQuality, describe, looksFetchable } from "./quality.mjs";

const HASH_RE = /btih:([a-z0-9]{32,40})/i;

// Stable id for one release: "<infoHash>" or "<infoHash>:<fileIdx>".
export function serverId(c) {
  const hash = String(c?.hash || (c?.magnet || "").match(HASH_RE)?.[1] || "").toLowerCase();
  if (!hash) return "";
  return c.fileIdx != null ? `${hash}:${c.fileIdx}` : hash;
}

// Release group: "[SubsPlease] …" at the front (fansub convention) or a
// trailing "-SPARKS" / "-RARBG.mkv" (scene convention). Null when neither.
export function releaseGroup(name = "") {
  const lead = String(name).match(/^\s*[[(]([^\])]{2,24})[\])]/);
  if (lead) return lead[1].trim();
  const tail = String(name)
    .replace(/\.(mkv|mp4|avi|m4v|mov|webm)$/i, "")
    .match(/[-–]\s*([A-Za-z0-9]{2,20})\s*(?:\[[^\]]*\])?$/);
  return tail ? tail[1] : null;
}

// Short headline for a row: "1080p BluRay" / "2160p REMUX" / "AnimePahe".
export function serverLabel(c) {
  const q = c.quality || parseQuality(c.name || "");
  const tag = parseSource(c.name || "");
  const parts = [q ? `${q}p` : null, tag].filter(Boolean);
  return parts.length ? parts.join(" ") : (releaseGroup(c.name) || "Release");
}

// What a favourite pins: everything about a release except which title it is.
export function releaseSignature(c) {
  const q = c.quality || parseQuality(c.name || "");
  return `q${q || 0}|${parseSource(c.name || "") || "-"}`;
}

// Ranked releases -> the client's server rows. Capped: a popular film can carry
// 80+ Torrentio results and the panel is a menu, not a torrent index.
// max is generous on purpose: a popular film really does have ~77 releases and
// the panel is the user's escape hatch when the automatic picks won't play.
export function describeReleases(list = [], max = 100) {
  const seen = new Set();
  const out = [];
  // Releases that cannot be fetched are not choices, they are noise — picking
  // one only buys the viewer a 12-second wait and "didn't start". They are
  // dropped rather than dimmed, since the panel exists to answer "give me
  // something that works". If EVERY release looks dead the list is kept intact:
  // one may still be cached, and an empty panel removes the escape hatch.
  const live = list.filter(looksFetchable);
  for (const c of (live.length ? live : list)) {
    const id = serverId(c);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: serverLabel(c),
      name: c.name || "Unknown release",
      group: releaseGroup(c.name),
      quality: c.quality || parseQuality(c.name || "") || null,
      tag: parseSource(c.name || ""),
      seeders: c.seeders || 0,
      size: c.size || 0,
      sig: releaseSignature(c),
      // WHICH INDEX found this release, as distinct from which debrid service
      // will serve it. Movies and TV merge Torrentio with apibay and then label
      // every row by the debrid backend, so both read "Real-Debrid" and
      // Torrentio looks absent when it is in fact supplying most of the list.
      indexer: c.indexer || null,
      // What the release IS, on the axes the ranker uses. This replaces the old
      // `playback: original|converted` flag, which described whether the debrid
      // transcoder would touch the file — no longer meaningful now that the
      // original bytes always arrive and transcoding happens locally.
      //
      // langLabel/subLabel are the release NAME's language claim. The panel
      // marks them as such: the row that is playing shows ffprobe's real track
      // list instead, which is the only authoritative answer.
      ...(({ mbps, audioLabel, videoCodec, langLabel, subLabel, languages }) =>
        ({ mbps, audioLabel, videoCodec, langLabel, subLabel, languages }))(describe(c)),
    });
    if (out.length >= max) break;
  }
  return out;
}

// Union several release lists, first-seen wins, deduped by torrent identity.
// Indexers overlap heavily but each also holds titles the others don't, so the
// old "use apibay ONLY when Torrentio returned nothing" rule threw away real
// supply: three bad Torrentio hits meant apibay's thirty were never consulted.
export function mergeReleases(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const c of list || []) {
      const id = serverId(c) || `name:${c.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(c);
    }
  }
  return out;
}

export function findRelease(list = [], id) {
  if (!id) return null;
  return list.find((c) => serverId(c) === id) || null;
}

// Stable partition: releases whose signature the user has favourited move to
// the front, everything else keeps its ranked order. `prefer` is the raw
// comma-separated query value from the client.
export function preferSignatures(list = [], prefer = "") {
  const want = new Set(String(prefer || "").split(",").map((s) => s.trim()).filter(Boolean));
  if (!want.size) return list;
  const hit = [], miss = [];
  for (const c of list) (want.has(releaseSignature(c)) ? hit : miss).push(c);
  return hit.length ? [...hit, ...miss] : list;
}
