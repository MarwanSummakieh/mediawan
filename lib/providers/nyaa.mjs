// Nyaa → Real-Debrid — a QUALITY-tier source, and the LIVE anime index.
//
// Added 2026-07-31 after AnimeTosho — which mirrors Nyaa and had been this
// app's only anime index — stopped ingesting: its newest entry for any query
// was 2026-05-08, nearly three months stale, so every currently-airing show
// resolved to zero candidates from that tier. Grand Blue Season 3 episode 4 had
// eleven releases on Nyaa and none on AnimeTosho.
//
// Deliberately its OWN provider rather than a second search folded into
// ./debrid.mjs: providers share a circuit breaker, so a merged pair means one
// index throwing suppresses the other, and neither health nor the failure note
// can say which index found anything. Separate providers fail separately.
//
// Nyaa publishes no JSON API; searchNyaaTorrents parses its RSS (see
// lib/torrents.mjs), which carries name, infoHash, seeders and size — exactly
// what a candidate needs.
import { searchNyaaTorrents } from "../torrents.mjs";
import { makeTorrentProvider } from "./torrent-source.mjs";

export const nyaaAnimeProvider = makeTorrentProvider({
  name: "nyaa",
  label: "Nyaa",
  search: searchNyaaTorrents,
});
