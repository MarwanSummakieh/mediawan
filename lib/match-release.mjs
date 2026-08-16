// Does this file actually contain the thing the user asked for?
//
// Torrents are not one-film-one-file. Compilation packs are common and popular
// — "Great Films 5" holds 66 unrelated features, "IMDB Top 250" holds hundreds
// — and they rank well because they have enormous seeder counts. Handed one of
// those, the old file picker took the LARGEST video in the torrent, so asking
// for a Michael Jackson concert film played American Gangster instead. Season
// packs do the same to episodes.
//
// Torrentio supplies a fileIdx that names the right file, but it isn't always
// present (apibay text results never have one) and it isn't always right (its
// index and the debrid service's file order can disagree). So the index is
// treated as a HINT and the filename is the evidence: whatever we're about to
// stream has to look like what was requested, or we refuse it and let the
// caller try the next release. Refusing is cheap; playing the wrong film is
// the bug being fixed.
const VIDEO_RE = /\.(mkv|mp4|avi|m4v|mov|webm)$/i;
const JUNK_RE = /\b(sample|trailer|extras?|behind.the.scenes|featurette|deleted.scenes)\b/i;

// Words that carry no identifying weight, plus the noise every release name
// wears: codecs, resolutions, groups, containers.
const STOP = new Set(["the", "a", "an", "of", "and", "or", "in", "on", "at", "to", "for", "s"]);

export function normalize(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    // Apostrophes are DELETED, not split on: release names drop them, so
    // "Jackson's" must normalise to "jacksons" to match a file called
    // "Michael Jacksons This Is It". Splitting produced "jackson" + "s" and
    // the titles never matched.
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function titleTokens(s) {
  return normalize(s).split(" ").filter((t) => t && t.length > 1 && !STOP.has(t));
}

// Every significant word of the wanted title must appear in the candidate.
// Deliberately containment, not equality: real filenames carry years, codecs,
// group tags and sometimes a translated title alongside the original.
export function titleMatches(candidate, wanted) {
  const want = titleTokens(wanted);
  if (!want.length) return false;
  const hay = new Set(titleTokens(candidate));
  return want.every((t) => hay.has(t));
}

// "S02E05", "2x05", " 205 " — enough to tell episodes apart inside a pack.
export function fileHasEpisode(name, season, episode) {
  const s = Number(season), e = Number(episode);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return true;
  const pad = (n) => String(n).padStart(2, "0");
  return new RegExp(`(s0*${s}[\\s._-]*e0*${e}|${s}x0*${e}|\\bs0*${s}\\b.*\\be0*${e}\\b)(?!\\d)`, "i")
    .test(String(name)) || new RegExp(`[^0-9]${pad(s)}${pad(e)}[^0-9]`).test(String(name));
}

// Will this release reach the viewer at its ORIGINAL quality, or go through
// Real-Debrid's transcoder on the way?
//
// This matters more than it looks. RD's /streaming/transcode re-encodes rather
// than remuxes: measured on a 5.29 GB Interstellar file, the source runs at
// 4.2 Mbit/s and what comes back out is 2.4 — roughly half, with the surround
// track folded down too. An H.264 MP4 skips that entirely and plays as it was
// released; an .mkv can't, because no browser opens the container.
//
// Judged from the release NAME, so it can be shown in the Servers panel before
// anything is resolved. Returns "original" | "converted" | null (can't tell).
export function playbackQuality(name) {
  const n = String(name || "");
  if (/x265|h\.?265|hevc/i.test(n)) return "converted"; // TVs decode it, desktop mostly doesn't
  if (/\bmkv\b/i.test(n)) return "converted";
  if (/\bmp4\b/i.test(n) && /x264|h\.?264|avc/i.test(n)) return "original";
  if (/\bmp4\b/i.test(n)) return "original";
  return null;
}

// Dolby Vision / HDR10. Gorgeous on a TV that gets the original bytes —
// actively WORSE than a plain SDR release when something re-encodes it, because
// the transcoder flattens the wide colour range to SDR without tone mapping and
// the picture comes out grey and washed out. So this only matters in
// combination with playbackQuality: HDR + "converted" is a release to avoid.
export function isHdr(name) {
  return /\b(hdr10\+?|hdr|dolby\s*vision|\bdv\b|dovi|pq10|hlg)\b/i.test(String(name || ""));
}

// A sequel numbered with a ROMAN NUMERAL rather than the word "Season".
//
// AniList files Tanya's second season as "Youjo Senki II" and Overlord's fourth
// as "Overlord IV", and release groups copy that name verbatim ("[Erai-raws]
// Youjo Senki II - 04"). Nothing here used to read that, so wantedSeason fell
// through to its season-1 default and the identity gate INVERTED: every release
// that correctly said "S2" was rejected as the wrong season, and the only ones
// left were the "II"-named releases, which happened to be the CR/WEB-DL tagged
// ones Real-Debrid refuses with a 451. Measured on Saga of Tanya the Evil
// Season 2 episode 4 — the SubsPlease 1080p release with 2506 seeders was
// dropped as "wrong season", and the play failed with nothing but takedowns.
//
// A whitelist, not a Roman-numeral parser, and deliberately narrow:
//   • "I" is season 1, which is already the default — reading it changes
//     nothing and it appears inside tags and ordinary words constantly;
//   • bare "V" and "X" are excluded: one letter alone is far more often a
//     stylisation or a version marker than a season ("Senki Zesshou Symphogear
//     XV" is a name, not season fifteen).
const ROMAN = { ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9 };
// Longest alternatives first so "viii" can't match as "vi", and a numeral
// followed by ". Word" is skipped — that is a numbered SUBTITLE ("Heaven's
// Feel - II. Lost Butterfly"), not a season. A dot followed by digits is just a
// dotted release name ("Youjo.Senki.II.04.1080p") and still counts.
const ROMAN_RE = /(?:^|[\s._\-[(])(viii|vii|vi|iv|ix|iii|ii)(?=$|[\s._\-\])])(?!\s*\.\s*[a-z])/gi;
// A numeral introduced by one of these names a DIVISION of a season, not the
// season itself — "The Final Season Part II" is season 4 part 2, not season 2.
const DIVISION = /^(?:part|cour|vol|volume|chapter|act|arc|phase|movie|film|episode|ep)$/i;

export function romanSeason(name) {
  const s = String(name || "");
  for (const m of s.matchAll(ROMAN_RE)) {
    const before = s.slice(0, m.index).match(/([a-z]+)[\s._-]*$/i);
    if (before && DIVISION.test(before[1])) continue;
    return ROMAN[m[1].toLowerCase()];
  }
  return null;
}

// Which season is this? Returns a number, or null when the name says nothing.
//
// Anime titles carry the season in prose ("Shingeki no Kyojin Season 2", "2nd
// Season", "Final Season") while release names use the compact form ("S02"), so
// both spellings have to be understood to compare a request against a result.
export function seasonOf(name) {
  const n = String(name || "");
  // Compact "S02", "S2", "S02E05". The trailing guard only blocks a further
  // DIGIT — an episode suffix still names its season and must be read, which an
  // earlier version wrongly rejected.
  const compact = n.match(/(?:^|[\s._\-[(])s(?:eason)?\s?(\d{1,2})(?!\d)/i);
  if (compact) return Number(compact[1]);
  const spelled = n.match(/\bseason\s*(\d{1,2})\b/i);
  if (spelled) return Number(spelled[1]);
  const ordinal = n.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i);
  if (ordinal) return Number(ordinal[1]);
  // Last, because it is the weakest signal: an explicit "S2" anywhere in the
  // name outranks a Roman numeral that might be part of the title proper.
  return romanSeason(n);
}

// Could this release plausibly serve the requested season?
//
// Deliberately permissive: only a DIRECT CONTRADICTION rejects. A release that
// states no season is fine (single-cour shows rarely bother), and so is a
// complete-series pack, which genuinely contains every season.
//
// This is a GATE, not a score. It was previously left to ranking, and ranking
// let a strong preference win over correctness — a dual-audio Season 1 pack
// outscored the right Season 2 release on a dub request, which would have
// served the wrong season's episode 1. No preference may override identity.
export function seasonMatches(releaseName, wantSeason) {
  if (!Number.isFinite(wantSeason)) return true;
  const n = String(releaseName || "");

  // An explicit RANGE ("S01-S04") genuinely spans seasons — check containment.
  const range = n.match(/s(\d{1,2})\s*[-~]\s*s(\d{1,2})/i);
  if (range) {
    const [lo, hi] = [Number(range[1]), Number(range[2])].sort((a, b) => a - b);
    return wantSeason >= lo && wantSeason <= hi;
  }

  // A STATED season is decisive, and it is checked before any "complete"
  // wording. "Attack on Titan Season 01 S01 [2013] COMPLETE" is a complete
  // SEASON ONE pack, not a complete series — reading the word COMPLETE as
  // "contains every season" is what let it answer a season-2 request.
  const got = seasonOf(n);
  if (got != null) return got === wantSeason;

  // Nothing stated. Whether that's acceptable depends on which season was asked
  // for, and the asymmetry is deliberate:
  //
  //   Season 1 (or unknown) — accept. Single-cour releases almost never carry a
  //   season tag, and demanding one would reject most of the anime catalogue.
  //
  //   Season 2+ — REQUIRE positive confirmation. Anime sequels share a base
  //   title and diverge only in a suffix ("Season 2", "The Final Season",
  //   "Part 2"), so an untagged release is far more likely to be a different
  //   entry in the franchise than the specific season requested. Measured live:
  //   a dub request for Shingeki no Kyojin Season 2 resolved to "The Final
  //   Season Part 2", which states no season number and so slipped through.
  return !(wantSeason > 1);
}

// The show's name with its season suffix removed.
//
// Needed because the season is part of the TITLE for anime — AniList calls it
// "Shingeki no Kyojin Season 2" — and tokenising that whole string makes the
// word "season" a required token, so it fails to match a release named
// "Shingeki no Kyojin S2 26". Season is compared separately by seasonMatches;
// this leaves just the identity part for the title comparison.
export function baseTitle(s) {
  return String(s || "")
    .replace(/\b(the\s+)?final\s+season\b.*$/i, "")
    .replace(/\bseason\s*\d{1,2}\b.*$/i, "")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)\s+season\b.*$/i, "")
    .replace(/\b(?:part|cour)\s*\d{1,2}\b.*$/i, "")
    .replace(/[\s:._-]*\bs\d{1,2}\b\s*$/i, "")
    // The Roman-numeral form of the same suffix, and only at the very END so a
    // numeral that belongs to the title proper is left alone ("Fate/stay night
    // Movie: Heaven's Feel - II. Lost Butterfly" keeps its numeral because the
    // subtitle follows it). Without this, "Youjo Senki II" kept "II" as a
    // required token and every release named "Youjo Senki S2 - 04" — including
    // SubsPlease's — was rejected as a title mismatch.
    .replace(/[\s:._-]*\b(?:viii|vii|vi|iv|ix|iii|ii)\s*$/i, "")
    .replace(/[\s:._\-–]+$/, "")
    .trim();
}

// Is this release plausibly the show that was asked for?
//
// Checked against BOTH the romaji and English names, because releases use
// either — "Attack on Titan S02E01" shares no word with "Shingeki no Kyojin",
// and vice versa, so testing one alone rejects half the catalogue.
//
// Containment, not equality: real release names carry group tags, resolutions,
// codecs and episode numbers around the title.
export function titleRelevant(releaseName, meta) {
  const forms = [meta?.romaji, meta?.title].filter(Boolean).map(baseTitle).filter(Boolean);
  if (!forms.length) return true; // nothing to compare against — don't invent a reason to reject
  return forms.some((t) => titleMatches(releaseName, t));
}

// Does this release span more than one season?
//
// It matters for FILE selection, not release selection. A single-season release
// numbers its files from 1 ("- 01"), so an episode number alone identifies them.
// A multi-season pack numbers files ABSOLUTELY across the whole run — Attack on
// Titan S1-S4 is "01-75", where season 2 episode 1 is file 26 — so an episode
// number alone silently resolves to the wrong season's episode. Measured live:
// a dub request for S02E01 returned a S1-S4 pack and picked file "01", i.e.
// season ONE's premiere.
export function isMultiSeason(name) {
  const n = String(name || "");
  return /s\d{1,2}\s*[-~]\s*s\d{1,2}/i.test(n) ||
    /\b(complete\s+series|all\s+seasons|season\s*\d\s*[-~]\s*\d)\b/i.test(n) ||
    /\bseries\b.*\bs\d{1,2}\s*[-~]/i.test(n);
}

// The full identity gate: right show AND right season.
//
// Neither half suffices alone. Title alone lets a different season of the same
// show through (that's how a Season 1 pack answered a Season 2 request);
// season alone lets an unrelated show through when its name happens to carry a
// matching season number.
//
// A known limitation: a SPIN-OFF passes both halves — "Attack on Titan : Junior
// High" contains every word of "Attack on Titan" and can state the same season.
// Name-based matching cannot separate those, which is exactly why an id-mapped
// provider outranks this one for sequels (see lib/providers/index.mjs).
export function releaseIsRelevant(releaseName, meta) {
  return titleRelevant(releaseName, meta) && seasonMatches(releaseName, wantedSeason(meta));
}

// Which season does this metadata entry represent?
//
// Defaults to 1 when the title names none, and that default is load-bearing.
// A title with no season marker IS a first season — "Sousou no Frieren" is
// Frieren season 1 — but treating the answer as "unknown" switched the season
// gate off entirely, and a request for Frieren episode 1 was answered with a
// release labelled S02E01. Season two of the right show is still the wrong
// content. Unstated releases continue to pass (see seasonMatches), so this only
// rejects releases that positively claim a different season.
// BOTH names are consulted, not just the romaji one. The two forms don't
// always mark the season the same way — AniList calls Tanya's sequel "Youjo
// Senki II" in romaji and "Saga of Tanya the Evil Season 2" in English — and
// reading only the romaji name (which `||` did, since a present romaji hid the
// English one entirely) threw away the clearer of the two. First stated answer
// wins; silence in one name is not a contradiction of the other.
export function wantedSeason(meta) {
  for (const t of [meta?.romaji, meta?.title]) {
    const s = seasonOf(t);
    if (s) return s;
  }
  return 1;
}

// Every name this show might be filed under, season suffix removed.
//
// Both forms are needed because a release chosen by one name routinely names
// its files by the other — a "Shingeki no Kyojin" release whose episodes are
// called "Attack on Titan S02E01.mkv" is entirely normal.
export function titleForms(meta) {
  return [...new Set([meta?.romaji, meta?.title].filter(Boolean).map(baseTitle).filter(Boolean))];
}

// A release name that advertises itself as a collection. These are legitimate
// torrents — they're just never what a single-title request wants unless a
// verified file index picks the entry out of them.
export function isCompilation(name) {
  return /\b(collection|complete series|anthology|filmograph|\d+\s*movies|movie pack|top \d+|great films|box ?set|duology|trilogy|quadrilogy|pentalogy|saga)\b/i
    .test(String(name || ""));
}

// Choose which file inside a torrent to stream.
//   files: [{ path, bytes, id }]  (debrid-service shape)
//   want:  { title, year, season, episode, fileIdx }
// Returns the file, or null meaning "this release can't serve the request" —
// the caller should move to the next candidate rather than stream something.
export function pickVideoFile(files, want = {}) {
  const videos = (files || []).filter((f) => VIDEO_RE.test(f.path || "") && !JUNK_RE.test(f.path || ""));
  if (!videos.length) return null;
  const episodic = want.season != null && want.episode != null;
  const name = (f) => (f.path || "").split("/").pop();

  // Titles to accept, ANY of which identifies the file.
  //
  // A single title is not enough. Anime carries a romaji name and an English
  // one, and a release picked by its romaji name routinely names its files in
  // English — "Shingeki no Kyojin Season 2" as the wanted title against a file
  // called "Attack on Titan S02E01.mkv" shares no word at all, so every file in
  // a season pack was rejected and the release skipped. Single-file torrents
  // slipped through on the videos.length === 1 shortcut below, which is why
  // some titles played and others silently didn't.
  const titles = (want.titles?.length ? want.titles : [want.title]).filter(Boolean);
  const titleOk = (f) => !titles.length || titles.some((t) => titleMatches(name(f), t));

  // Episode number alone is enough when the wanted title is episodic and the
  // pack is season-scoped; the season-qualified form is checked separately.
  const episodeOk = (f) => fileHasEpisode(name(f), want.season, want.episode);

  // The hint first — but only if the file it points at corroborates it.
  if (want.fileIdx != null) {
    const hinted = videos.find((f) => f.id === want.fileIdx + 1) || videos[want.fileIdx];
    if (hinted) {
      const ok = episodic ? episodeOk(hinted) : (!titles.length || videos.length === 1 || titleOk(hinted));
      if (ok) return hinted;
      // Hint disagrees with the filename — distrust it and search properly.
    }
  }

  // Search by name.
  //
  // WHICH field discriminates depends on what was asked for. For an episode,
  // the episode NUMBER is the only thing that separates the files — every file
  // in a season pack matches the show's title equally, so title-matching alone
  // degrades to "return the largest video", which is the exact bug this
  // function exists to prevent. Title is the discriminator only for a film.
  const n = Number(want.episode);
  const wantEp = want.episode != null && Number.isFinite(n);
  // The episode number as its own token — "- 01", "E01", "[01]", " 01." — with
  // years, resolutions and CRC tags removed first so their digits can't pose as
  // one.
  const epRe = new RegExp(`(?:^|[\\s._\\-\\[(]|\\bEP?)0*${n}(?:v\\d)?(?=[\\s._\\-\\])]|$)`, "i");
  // "S02E01" separately: there is no word boundary between the season digits
  // and the E, so the token form above cannot see it — and that is the single
  // most common way an episode file is named.
  const sxxExxRe = new RegExp(`s\\d{1,2}[\\s._-]*e0*${n}(?!\\d)`, "i");
  const strip = (s) => s.replace(/\b(19|20)\d{2}\b/g, "").replace(/\d{3,4}p/gi, "").replace(/\[[0-9A-F]{8}\]/gi, "");
  const epTokenOk = (f) => { const s = strip(name(f)); return sxxExxRe.test(s) || epRe.test(s); };

  let matches;
  if (episodic) {
    // Multi-season pack: only a season-qualified match will do (see above).
    matches = videos.filter(episodeOk);
  } else if (wantEp && videos.length > 1) {
    // Season-scoped pack. Prefer files that match the title too, but fall back
    // to the episode alone — the RELEASE was already confirmed as the right
    // show and season before we got here (see releaseIsRelevant), and plenty of
    // packs don't repeat the show name in every filename.
    matches = videos.filter((f) => epTokenOk(f) && titleOk(f));
    if (!matches.length) matches = videos.filter(epTokenOk);
  } else {
    matches = videos.filter(titleOk);
  }
  if (matches.length) return matches.sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0];

  // A single video and nothing contradicting it: plenty of well-made torrents
  // name the file generically ("movie.mkv") inside a correctly-named folder,
  // and the release itself was matched by id upstream.
  if (videos.length === 1) return videos[0];

  // Several videos, none of which look like the request: this is a pack and we
  // cannot tell which entry was wanted. Refuse rather than guess.
  return null;
}

export { VIDEO_RE };
