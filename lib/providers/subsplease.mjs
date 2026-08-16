// SubsPlease → Real-Debrid — a QUALITY-tier source, and the FIRST one tried.
//
// Added 2026-07-31, after a day of reproducing why brand-new episodes wouldn't
// play. Three separate failures pointed at the same gap:
//   • AnimeTosho (the mirror) had been silently stale since 2026-05-08;
//   • Torrentio's Kitsu index had zero entries for Grand Blue Season 3;
//   • every release Nyaa DID surface for the newest episodes carried a
//     CR/WEB-DL tag, which Real-Debrid's takedown filter refuses with a 451.
//
// SubsPlease is the simulcast group itself: first-party, live to the minute,
// and its untagged "[SubsPlease] Show - 01 (1080p)" names pass RD's filter —
// measured on the day, the accepted releases were exactly the untagged ones.
// That combination is why it leads the provider list: for a currently-airing
// show it is both the freshest index and the one whose releases actually play.
//
// Its API returns no seeders and no size; searchSubsPlease leaves both ABSENT
// (not zero) so the ranker treats them as unknown rather than as evidence.
// The shared implementation lives in ./torrent-source.mjs — this file is only
// the index binding.
import { searchSubsPlease } from "../torrents.mjs";
import { makeTorrentProvider } from "./torrent-source.mjs";

export const subsPleaseProvider = makeTorrentProvider({
  name: "subsplease",
  label: "SubsPlease",
  search: searchSubsPlease,
});
