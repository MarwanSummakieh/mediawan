// AnimeTosho → Real-Debrid — a QUALITY-tier source.
//
// Release files are the only thing that can deliver REMUX, 4K or lossless 5.1,
// which is why the text-searched indexes lead rather than the scrapers they
// used to defer to.
//
// AnimeTosho mirrors Nyaa and used to be the ONLY anime index here. That was a
// single point of failure and it failed: measured 2026-07-31, the newest entry
// its API would return for any query was 2026-05-08, so every show that began
// airing after early May resolved to zero candidates. Nyaa is now a sibling
// provider (./nyaa.mjs) with its own circuit breaker, so a stale index can no
// longer take the live one down with it. AnimeTosho keeps its place because its
// coverage of older and BD content is good and its metadata is richer.
//
// The shared implementation lives in ./torrent-source.mjs — this file is only
// the index binding.
import { searchAnimeTorrents } from "../torrents.mjs";
import { makeTorrentProvider, withNote } from "./torrent-source.mjs";

export const debridAnimeProvider = makeTorrentProvider({
  name: "debrid",
  label: "AnimeTosho",
  search: searchAnimeTorrents,
});

// Re-exported: this was withNote's original home and both the registry's
// siblings and the tests import it from here.
export { withNote };
