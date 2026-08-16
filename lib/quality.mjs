// The quality model — one place that decides which release is BEST.
//
// This replaces the old split-brain ranking (scoreRelease in torrents.mjs,
// preferQuality/BAND in stremio/addons.mjs), which optimised for something
// other than picture quality and said so in its own comments: 2160p was ranked
// BELOW 480p because 4K is "less likely RD-cached", and YIFY earned a bonus
// because its small H.264 MP4s avoided Real-Debrid's transcoder.
//
// Both justifications are gone:
//   • RD retired /torrents/instantAvailability (403 disabled_endpoint), so
//     cache-hit probability is no longer knowable and can't be optimised for.
//   • Transcoding now happens HERE, on the box, with QuickSync. Container and
//     codec no longer constrain what the client can play, so there is no reason
//     to prefer a worse release for being browser-friendly.
//
// What's left is the only thing that should ever have driven this: how good
// does it look and sound. Ranking is quality-first, with seeders demoted to a
// tiebreak — they predict availability, not quality, and letting them lead is
// how a 66-film compilation pack once outranked the film someone asked for.
import { isCompilation } from "./match-release.mjs";

// ---------- parsing ----------

// Resolution as a number, so it can be compared and thresholded.
//
// An EXPLICIT tag always wins over one implied by the source. "Hybrid 1080p UHD
// BluRay" is a 1080p file that was sourced from a UHD disc — reading the "UHD"
// as the output resolution promoted real 1080p releases above their true peers
// by pretending they were 4K. Only fall back to UHD/4K when no explicit
// <n>p tag is present at all.
export function parseResolution(name) {
  const n = String(name || "");
  if (/2160p/i.test(n)) return 2160;
  if (/1080p/i.test(n)) return 1080;
  if (/720p/i.test(n)) return 720;
  if (/480p/i.test(n)) return 480;
  if (/\b4k\b|\buhd\b/i.test(n)) return 2160; // source tag, used only as a last resort
  return 0; // unstated — treated as unknown, not as zero quality
}

// How the release was produced. Order matters: a "BluRay REMUX" is a REMUX.
// A remux is a lossless copy of the disc; everything below it is re-encoded,
// and that is exactly the axis this whole rebuild cares about.
export function parseSourceTier(name) {
  const n = String(name || "");
  if (/\bremux\b/i.test(n)) return "REMUX";
  if (/blu-?ray|bdrip|brrip|\bbdremux\b/i.test(n)) return "BluRay";
  if (/web-?dl/i.test(n)) return "WEB-DL";
  if (/webrip/i.test(n)) return "WEBRip";
  if (/hdtv/i.test(n)) return "HDTV";
  if (/hdrip/i.test(n)) return "HDRip";
  return null;
}

export function parseVideoCodec(name) {
  const n = String(name || "");
  if (/\bav1\b/i.test(n)) return "AV1";
  if (/x265|h\.?265|hevc/i.test(n)) return "HEVC";
  if (/x264|h\.?264|\bavc\b/i.test(n)) return "AVC";
  return null;
}

// Audio, which nothing in this codebase parsed before today.
//
// Two independent facts matter and they are not the same: the CODEC says
// whether the track is lossless, the CHANNEL COUNT says whether it's surround.
// A lossless stereo FLAC and a lossy 5.1 AC3 are both "better" than each other
// depending on which you weight, so they're scored separately rather than
// collapsed into one ladder.
//
// Channel count is often implied by the codec rather than written out: TrueHD
// and DTS-HD MA releases are essentially always at least 5.1, so absence of a
// "5.1" tag isn't evidence of stereo.
const LOSSLESS = /\b(truehd|true-?hd|dts-?hd(\s*ma)?|dts-?x|flac|\blpcm\b|\bpcm\b)\b/i;
export function parseAudio(name) {
  const n = String(name || "");

  let codec = null;
  if (/\bdts-?x\b/i.test(n)) codec = "DTS-X";
  else if (/\btrue-?hd\b/i.test(n)) codec = "TrueHD";
  else if (/\bdts-?hd(\s*ma)?\b/i.test(n)) codec = "DTS-HD MA";
  else if (/\bflac\b/i.test(n)) codec = "FLAC";
  // DDP / DD+ / E-AC3 are the same thing under three names, and the trailing
  // channel count is usually glued straight on ("DDP5.1"), so no word boundary
  // can be required after it.
  else if (/(\be-?ac-?3|\bddp|\bdd\+)/i.test(n)) codec = "E-AC3";
  else if (/(\bac-?3\b|\bdd(?=[\s._-]?[2578][\s._-]?[01])|dolby\s*digital)/i.test(n)) codec = "AC3";
  else if (/\bdts\b/i.test(n)) codec = "DTS";
  else if (/\bopus\b/i.test(n)) codec = "Opus";
  else if (/\baac\b/i.test(n)) codec = "AAC";

  // Explicit "5.1" / "7.1" / "2.0", or the "6ch"/"8ch" form some groups use.
  //
  // No \b anchors here: the count is routinely welded to the codec ("DDP5.1",
  // "TrueHD7.1"), which leaves no word boundary to match on. Digit lookarounds
  // do the guarding instead, and they have to — without the trailing (?!\d),
  // "2160p" parses as 2.1 and "1080p" as 8.0.
  //
  // The separator is REQUIRED and only ever "." or "_": every real layout tag
  // writes it ("DDP5.1", "AAC 2.0", "TrueHD_7_1"). Making it optional read any
  // bare two-digit token as a layout — episode "- 51" scored as 5.1 surround
  // and "- 20" claimed a stereo track it knew nothing about.
  let channels = null;
  const m = n.match(/(?<!\d)([2578])[._]([01])(?!\d)/);
  if (m) channels = Number(m[1]) + Number(m[2]); // 5.1 -> 6, 7.1 -> 8, 2.0 -> 2
  const ch = n.match(/\b([2-8])\s?ch\b/i);
  if (!channels && ch) channels = Number(ch[1]);
  // Infer surround ONLY from the disc formats that are essentially always
  // surround. TrueHD/DTS-HD MA/DTS-X carry a 5.1+ mix by construction.
  //
  // FLAC and PCM deliberately do NOT qualify, despite being lossless: anime BD
  // remuxes ship stereo FLAC constantly. Verified against a real release —
  // "[PMR] Frieren (BD Remux 1080p AVC FLAC AAC)" probes as flac 2ch, so
  // inferring 5.1 from the codec was scoring stereo releases as surround.
  if (!channels && /\b(truehd|true-?hd|dts-?hd(\s*ma)?|dts-?x)\b/i.test(n)) channels = 6;

  return {
    codec,
    channels,
    lossless: LOSSLESS.test(n),
    atmos: /\batmos\b/i.test(n),
  };
}

// ---------- audio language / dub ----------
//
// Dub is an AUDIO TRACK, not a separate stream.
//
// The old model got this from AllAnime, which published separate sub and dub
// episode lists and served a different file for each. Release files don't work
// that way: a "Dual Audio" encode carries Japanese AND English in one file, so
// choosing dub is choosing a track — which also means a single download serves
// both, and the player can switch languages without re-resolving anything.
//
// Judged from the release NAME here, because that's all there is before the
// file is fetched. It's a prior, not a fact: ffprobe reads the real track list
// at delivery and overrules this (see lib/transcode/probe.mjs).
export function parseDub(name) {
  const n = String(name || "");
  // Language PAIRS, in either order, with any of the separators groups actually
  // use. The separator set matters: "[JPN-ENG]" is as common as "JPN+ENG", and
  // accepting only "+" silently classified real dual-audio releases as
  // Japanese-only — seen live on an Attack on Titan BluRay pack.
  const PAIR = /\b(jpn|jap|ja|jp)\s*[+\-/&]\s*(eng|en)\b|\b(eng|en)\s*[+\-/&]\s*(jpn|jap|ja|jp)\b/i;
  const dual = /\b(dual[\s._-]?audio|multi[\s._-]?audio|dual)\b/i.test(n) || PAIR.test(n);
  // "Dubbed"/"English Dub" without a dual marker: English only.
  const dubOnly = !dual && /\b(eng(lish)?[\s._-]?dub(bed)?|dub(bed)?[\s._-]?eng(lish)?|\bdubbed\b|\[dub\])\b/i.test(n);
  // Explicitly sub-only — cannot serve dub at all.
  const subOnly = !dual && !dubOnly && /\b(sub(bed|s)?[\s._-]?only|\[sub\]|softsubs?|hardsubs?)\b/i.test(n);
  return { dual, dubOnly, subOnly, canDub: dual || dubOnly };
}

// ISO-639 codes a track might carry for each mode. ffprobe emits 639-2 ("eng",
// "jpn") but plenty of releases tag 639-1 ("en", "ja"), so both are accepted.
export const LANGS = {
  dub: ["eng", "en"],
  sub: ["jpn", "ja", "jp"],
};

// ---------- which languages does this release claim? ----------
//
// parseDub answers one question (can this serve English audio?) on the anime
// axis. Films and TV need the general form: the Servers panel lists 30-odd
// releases and, without this, nothing on a row said whether it carried English,
// French, or six tracks — you found out by playing it.
//
// Read from the NAME, so it is a claim, not a fact. ffprobe overrules it the
// moment the file is delivered, and the panel labels the two differently — a
// guess presented as truth is worse than no label.
//
// Tokens are 3+ letters, delimited. Two-letter ISO codes are deliberately
// absent: "IT", "DE", "PL" collide with ordinary title words (the film "IT",
// "DE Niro"), and a row that claims Italian audio because the title contains
// "it" is worse than a row that claims nothing. The French scene's VF/VFF/VFQ
// are the exception — those never appear as words.
const LANG_TOKENS = [
  ["eng", /(?:^|[\s._\-[\]()+&/])eng(?:lish)?(?:[\s._\-[\]()+&/]|$)/i],
  ["jpn", /(?:^|[\s._\-[\]()+&/])(?:jpn|jap(?:anese)?)(?:[\s._\-[\]()+&/]|$)/i],
  ["fre", /(?:^|[\s._\-[\]()+&/])(?:fre(?:nch)?|fra|truefrench|vff|vfq|vfi|vf)(?:[\s._\-[\]()+&/]|$)/i],
  ["ger", /(?:^|[\s._\-[\]()+&/])(?:ger(?:man)?|deu|deutsch)(?:[\s._\-[\]()+&/]|$)/i],
  ["spa", /(?:^|[\s._\-[\]()+&/])(?:spa(?:nish)?|esp|castellano|latino|lat)(?:[\s._\-[\]()+&/]|$)/i],
  ["ita", /(?:^|[\s._\-[\]()+&/])(?:ita(?:lian)?)(?:[\s._\-[\]()+&/]|$)/i],
  ["por", /(?:^|[\s._\-[\]()+&/])(?:por(?:tuguese)?|pt[\s._-]?br|brazilian)(?:[\s._\-[\]()+&/]|$)/i],
  ["rus", /(?:^|[\s._\-[\]()+&/])(?:rus(?:sian)?)(?:[\s._\-[\]()+&/]|$)/i],
  ["ara", /(?:^|[\s._\-[\]()+&/])(?:ara(?:bic)?)(?:[\s._\-[\]()+&/]|$)/i],
  ["kor", /(?:^|[\s._\-[\]()+&/])(?:kor(?:ean)?)(?:[\s._\-[\]()+&/]|$)/i],
  ["chi", /(?:^|[\s._\-[\]()+&/])(?:chi(?:nese)?|zho|mandarin|cantonese)(?:[\s._\-[\]()+&/]|$)/i],
  ["hin", /(?:^|[\s._\-[\]()+&/])(?:hin(?:di)?)(?:[\s._\-[\]()+&/]|$)/i],
  ["tam", /(?:^|[\s._\-[\]()+&/])(?:tam(?:il)?)(?:[\s._\-[\]()+&/]|$)/i],
  ["tel", /(?:^|[\s._\-[\]()+&/])(?:tel(?:ugu)?)(?:[\s._\-[\]()+&/]|$)/i],
  ["dut", /(?:^|[\s._\-[\]()+&/])(?:dut(?:ch)?|nld)(?:[\s._\-[\]()+&/]|$)/i],
  ["pol", /(?:^|[\s._\-[\]()+&/])(?:pol(?:ish)?|lektor)(?:[\s._\-[\]()+&/]|$)/i],
  ["tur", /(?:^|[\s._\-[\]()+&/])(?:tur(?:kish)?)(?:[\s._\-[\]()+&/]|$)/i],
  ["swe", /(?:^|[\s._\-[\]()+&/])(?:swe(?:dish)?)(?:[\s._\-[\]()+&/]|$)/i],
  ["nor", /(?:^|[\s._\-[\]()+&/])(?:nor(?:wegian)?)(?:[\s._\-[\]()+&/]|$)/i],
  ["dan", /(?:^|[\s._\-[\]()+&/])(?:dan(?:ish)?)(?:[\s._\-[\]()+&/]|$)/i],
  ["fin", /(?:^|[\s._\-[\]()+&/])(?:fin(?:nish)?)(?:[\s._\-[\]()+&/]|$)/i],
  ["heb", /(?:^|[\s._\-[\]()+&/])(?:heb(?:rew)?)(?:[\s._\-[\]()+&/]|$)/i],
  ["tha", /(?:^|[\s._\-[\]()+&/])(?:tha(?:i)?)(?:[\s._\-[\]()+&/]|$)/i],
  ["vie", /(?:^|[\s._\-[\]()+&/])(?:vie(?:tnamese)?)(?:[\s._\-[\]()+&/]|$)/i],
  ["ukr", /(?:^|[\s._\-[\]()+&/])(?:ukr(?:ainian)?)(?:[\s._\-[\]()+&/]|$)/i],
  ["cze", /(?:^|[\s._\-[\]()+&/])(?:cze(?:ch)?|ces)(?:[\s._\-[\]()+&/]|$)/i],
  ["hun", /(?:^|[\s._\-[\]()+&/])(?:hun(?:garian)?)(?:[\s._\-[\]()+&/]|$)/i],
  ["gre", /(?:^|[\s._\-[\]()+&/])(?:gre(?:ek)?|ell)(?:[\s._\-[\]()+&/]|$)/i],
];

// A subtitle claim is NOT an audio claim, and conflating them is the specific
// way this feature would mislead: "VOSTFR" is French SUBS over original audio,
// and "ESub" is an English subtitle track on a film whose audio is very often
// Hindi or Tamil. These are stripped before audio tokens are read, so a
// subtitle language never gets reported as spoken. Order matters — the generic
// "<lang> Subs" pattern runs after the fixed abbreviations.
const SUB_MARKERS = [
  [/vostfr/i, "fre"],
  [/\bvosta\b/i, "eng"],
  [/\be[\s._-]?subs?\b/i, "eng"],
  // "MSubs"/"Multi-Subs" mean SEVERAL subtitle languages, unspecified. Calling
  // that English would be a guess dressed as a fact.
  [/\b(?:m|multi)[\s._-]?subs?\b/i, null],
  [/\b(?:soft|hard)[\s._-]?subs?\b/i, null],
  [/\b([a-z]{3,10})[\s._-]?subs?\b/i, null], // "Eng Subs", "Fre Sub"
  [/\bsub(?:bed|s)?[\s._-]?only\b/i, null],
];

// Multi-track markers that name no language: "MULTi", "Dual Audio", "6 Audio".
const MULTI_RE = /(?:^|[\s._\-[\]()])multi(?:[\s._-]?(?:audio|lang(?:uage)?s?))?(?:[\s._\-[\]()]|$)|\b\d{1,2}[\s._-]?audios?\b/i;

// Language tags live in the TECHNICAL tail of a release name — after the year
// or the resolution — never in the title itself. Scanning the whole string
// turns a title's own words into false claims: "The Italian Job" would report
// Italian audio and "Hindi Medium" Hindi. Cutting to the tail removes that
// entire class of error, and costs nothing: no group writes "1080p.BluRay"
// before the language.
function techTail(name) {
  const s = String(name || "");
  const m = s.match(/(?:^|[\s._\-[\]()])((?:19|20)\d{2}|\d{3,4}[pi])(?=[\s._\-[\]()]|$)/);
  return m ? s.slice(m.index + m[0].length) : s;
}

export function parseLanguages(name) {
  const raw = String(name || "");
  const tail = techTail(raw);
  // Cut the subtitle clauses out first (see SUB_MARKERS).
  let audioPart = tail;
  const subs = new Set();
  for (const [re, code] of SUB_MARKERS) {
    const m = audioPart.match(re);
    if (!m) continue;
    if (code) subs.add(code);
    else if (m[1]) {
      // "Eng Subs" — the captured word is the subtitle language, if we know it.
      const word = m[1].toLowerCase();
      const hit = LANG_TOKENS.find(([, r]) => r.test(` ${word} `));
      if (hit) subs.add(hit[0]);
    }
    audioPart = audioPart.replace(re, " ");
  }
  const dub = parseDub(raw);
  // Only languages the name actually NAMES. A bare "DUAL"/"Dual Audio" marker
  // is reported as exactly that and nothing more: the anime convention where
  // dual means Japanese+English does not hold for live action, and inferring it
  // made "House of the Dragon … DUAL DDP5.1" claim a Japanese track. An
  // explicit pair ("[JPN+ENG]") needs no inference — both tokens are right
  // there in the tail.
  const audio = LANG_TOKENS.filter(([, re]) => re.test(audioPart)).map(([code]) => code);
  return {
    audio,
    subs: [...subs],
    // MULTi means "more than one" without saying which.
    multi: MULTI_RE.test(tail) || dub.dual || audio.length > 1,
    dual: dub.dual,
  };
}

// Human label for a row: "English · French", "Dual Audio", "Multi-language".
// Empty when the name says nothing — an honest blank beats a guessed "English".
const LANG_LABELS = { eng: "English", jpn: "Japanese", fre: "French", ger: "German",
  spa: "Spanish", ita: "Italian", por: "Portuguese", rus: "Russian", ara: "Arabic",
  kor: "Korean", chi: "Chinese", hin: "Hindi", tam: "Tamil", tel: "Telugu",
  dut: "Dutch", pol: "Polish", tur: "Turkish", swe: "Swedish", nor: "Norwegian",
  dan: "Danish", fin: "Finnish", heb: "Hebrew", tha: "Thai", vie: "Vietnamese",
  ukr: "Ukrainian", cze: "Czech", hun: "Hungarian", gre: "Greek" };
export const languageName = (code) => LANG_LABELS[String(code || "").toLowerCase()] || null;

export function languageLabel(langs, { max = 3 } = {}) {
  if (!langs) return null;
  const named = (langs.audio || []).map(languageName).filter(Boolean);
  if (named.length) {
    const shown = named.slice(0, max).join(" · ");
    return named.length > max ? `${shown} +${named.length - max}` : shown;
  }
  if (langs.dual) return "Dual Audio";
  if (langs.multi) return "Multi-language";
  return null;
}

// ---------- bitrate: the only honest smearing detector ----------
//
// Release names lie about quality constantly — "1080p BluRay" is stamped on
// 1.6 GB re-encodes and on 30 GB remuxes alike. Size over runtime doesn't lie.
// This is what actually separates the picture the user wants from the smeared
// one they complained about, and no name-based heuristic substitutes for it.
export function bitrateMbps(bytes, runtimeMin) {
  const b = Number(bytes), r = Number(runtimeMin);
  if (!Number.isFinite(b) || !Number.isFinite(r) || b <= 0 || r <= 0) return null;
  return (b * 8) / (r * 60) / 1e6;
}

// Minimum plausible bitrate for a release to be what it claims. Below these a
// "1080p" file is an upscale or a heavy re-encode: YIFY 1080p lands around
// 1.5–2.5 Mbps, a real WEB-DL starts around 5.
const BITRATE_FLOOR = { 2160: 12, 1080: 4, 720: 2, 480: 0.8 };

// A pack's `size` covers every episode in it, so dividing by ONE episode's
// runtime yields a wildly inflated figure. Bitrate checks are skipped for
// anything that looks like a pack rather than trusted and misread.
function looksLikePack(name) {
  return isCompilation(name) ||
    /\b(season|s\d{1,2})[\s._-]*(complete|pack)\b/i.test(String(name || "")) ||
    /\bs\d{1,2}[\s._-]*e?\d{1,3}[\s._-]*[-~][\s._-]*e?\d{1,3}\b/i.test(String(name || "")) ||
    /\b\d{1,3}\s*[-~]\s*\d{1,3}\b/.test(String(name || ""));
}

// ---------- groups ----------
// Groups that release at or near source. Not a quality guarantee, but a strong
// prior when two candidates are otherwise indistinguishable.
const GOOD_GROUP = /\b(FraMeSToR|CtrlHD|EbP|D-Z0N3|HiFi|BLURANiUM|W4NK3R|TAoE|SubsPlease|Erai-raws|EMBER|FLUX|NTb|CMRG|playWEB|SMURF|TEPES)\b/i;

// Re-encoders whose entire product is "small file". They were previously
// REWARDED here (+12) because small H.264 MP4s dodged RD's transcoder; with
// local transcoding that rationale is gone and they are simply what the user
// asked to avoid.
const SMALL_ENCODE_GROUP = /\b(YIFY|YTS(\.\w+)?|GALAXYRG|RARBG|PSA|QxR|Tigole|MeGusta|afm72|Silence)\b/i;

// Not a quality tier at all — a camera pointed at a screen.
const JUNK = /\b(CAM|HDCAM|TS|TELESYNC|HDTS|TELECINE|SCREENER|SCR|R5|KORSUB|HC|DVDSCR)\b/i;

// ---- Real-Debrid's release-name filter ----
//
// Since May 2026, RD refuses (451 / infringing_file) essentially every release
// whose NAME carries a licensed-simulcast tag. Measured 2026-07-31 across the
// day's failures: every blocked candidate carried CR / WEB-DL / WEBRip, every
// accepted one carried none. Ranking those releases first meant a play's whole
// attempt budget could be spent collecting guaranteed 451s — Grand Blue S3's
// two floor-passing releases were both tagged, both blocked, and the episode
// reported no sources while playable releases sat below the floor.
//
// This is a PENALTY, not a gate, and it is off by default: WEB-DL is often
// genuinely the best source, the filter is one backend's policy rather than a
// property of the release, and a future backend without the filter (or RD
// dropping it) must see these releases at their honest rank. Callers that are
// about to hand the winner to Real-Debrid pass `rdFilter: true`.
export const RD_FILTERED_TAGS = /\b(CR|Crunchyroll|WEB-?DL|WEBRip)\b/i;
const RD_FILTER_PENALTY = 80; // sinks tagged releases below untagged peers without touching order among themselves

// ---------- the floor: what we refuse outright ----------
//
// A hard floor rather than a scoring penalty, because the user's spec has a
// literal minimum ("1080p minimum") and a soft penalty lets a heavily-seeded
// 720p win when the 1080p field is thin. Returning a REASON keeps this
// debuggable — check-sources prints why a release was dropped.
export function meetsFloor(release, { runtimeMin = null, minResolution = 1080 } = {}) {
  const name = release?.name || "";
  if (JUNK.test(name)) return { ok: false, reason: "junk source (cam/telesync)" };

  const res = parseResolution(name);
  // Unstated resolution (res === 0) is not evidence of a bad release — plenty
  // of anime releases omit it — so it passes the gate and is scored low instead.
  if (res && res < minResolution) return { ok: false, reason: `${res}p below ${minResolution}p floor` };

  if (!looksLikePack(name)) {
    const mbps = bitrateMbps(release?.size, runtimeMin);
    const floor = BITRATE_FLOOR[res || 1080];
    if (mbps != null && floor != null && mbps < floor)
      return { ok: false, reason: `${mbps.toFixed(1)} Mbps below ${floor} Mbps floor for ${res || 1080}p` };
  }
  return { ok: true, reason: null };
}

// ---------- scoring ----------

const RES_SCORE = { 2160: 100, 1080: 70, 720: 25, 480: 5, 0: 15 };
const TIER_SCORE = { REMUX: 60, BluRay: 42, "WEB-DL": 32, WEBRip: 12, HDTV: 4, HDRip: 4 };

// Bitrate earns points on a curve that flattens out: the gap between 2 and 8
// Mbps is the difference between smeared and clean, the gap between 60 and 80
// is invisible. Capped so a huge remux can't win on size alone.
function bitrateScore(mbps) {
  if (mbps == null) return 0;
  return Math.min(45, Math.sqrt(Math.max(0, mbps)) * 7);
}

function audioScore(a) {
  let s = 0;
  if (a.lossless) s += 30;
  else if (a.codec === "E-AC3" || a.codec === "DTS") s += 12;
  else if (a.codec === "AC3") s += 8;
  if (a.channels >= 8) s += 22;
  else if (a.channels >= 6) s += 20; // 5.1 — what the user asked for
  else if (a.channels === 2) s += 2; // AAC 2.0 is acceptable, not preferred
  if (a.atmos) s += 6;
  return s;
}

// One number, best-first. `runtimeMin` comes from cached AniList/Cinemeta
// metadata and is what makes the bitrate term possible — without it the model
// still works, it just loses its sharpest signal.
export function qualityScore(release, { runtimeMin = null, mode = "sub", rdFilter = false } = {}) {
  const name = release?.name || "";
  const res = parseResolution(name);
  const tier = parseSourceTier(name);
  const audio = parseAudio(name);
  const pack = looksLikePack(name);
  const mbps = pack ? null : bitrateMbps(release?.size, runtimeMin);

  let s = 0;
  s += RES_SCORE[res] ?? 15;
  s += TIER_SCORE[tier] ?? 0;
  s += bitrateScore(mbps);
  s += audioScore(audio);

  // Language weighting. For a dub request an English track is not a preference,
  // it is the request — so a dual-audio release outranks a better-looking
  // Japanese-only one, and an explicitly sub-only release is pushed to the
  // bottom rather than played with the wrong audio. Weighted above resolution
  // on purpose: a 1080p dub beats a 4K release the viewer can't understand.
  const dub = parseDub(name);
  if (mode === "dub") {
    if (dub.dual) s += 120;
    else if (dub.dubOnly) s += 110;
    else if (dub.subOnly) s -= 200;
    else s -= 40; // unmarked: might be dual, probably isn't — try it after known ones
  } else if (dub.dubOnly) {
    s -= 60; // sub was asked for and this release has no Japanese track
  }

  if (GOOD_GROUP.test(name)) s += 10;
  if (SMALL_ENCODE_GROUP.test(name)) s -= 45;
  if (JUNK.test(name)) s -= 500;
  // The serving backend refuses names like this — see RD_FILTERED_TAGS.
  if (rdFilter && RD_FILTERED_TAGS.test(name)) s -= RD_FILTER_PENALTY;
  // Packs still rank, but never ahead of a proper single release: for some
  // obscure titles the pack is genuinely the only copy in existence.
  if (isCompilation(name)) s -= 60;

  // Seeders are a TIEBREAK. They say a release is retrievable, not that it's
  // good, and weighting them heavily is what let compilation packs win before.
  s += Math.log10((release?.seeders || 0) + 1) * 6;

  return s;
}

// Full picture for one release — used for ranking, for the Servers panel, and
// for check-sources to prove the ranking honours the spec.
export function describe(release, { runtimeMin = null } = {}) {
  const name = release?.name || "";
  const pack = looksLikePack(name);
  const mbps = pack ? null : bitrateMbps(release?.size, runtimeMin);
  const audio = parseAudio(name);
  const dub = parseDub(name);
  const languages = parseLanguages(name);
  return {
    resolution: parseResolution(name),
    tier: parseSourceTier(name),
    videoCodec: parseVideoCodec(name),
    audio,
    dub,
    languages,
    // What the NAME claims about spoken language, for the Servers panel. Null
    // when it claims nothing; the panel says so rather than inventing English.
    langLabel: languageLabel(languages),
    subLabel: (languages.subs || []).map(languageName).filter(Boolean).join(" · ") || null,
    mbps,
    pack,
    audioLabel: [audio.codec, audio.channels === 6 ? "5.1" : audio.channels === 8 ? "7.1" : audio.channels === 2 ? "2.0" : null,
      audio.atmos ? "Atmos" : null, dub.dual ? "Dual Audio" : dub.dubOnly ? "Dub" : null].filter(Boolean).join(" ") || null,
  };
}

// Rank a candidate list quality-first, dropping anything under the floor.
// Returns { list, rejected } so callers can report WHY the field thinned out
// instead of silently returning nothing.
//
// `mode` ("sub" | "dub") is a RANKING input, not a filter: releases that can't
// carry the requested language sink but aren't removed, because the name is
// only a prior — plenty of dual-audio releases never say so, and ffprobe is the
// one that actually knows. Removing them here would make a title with poor
// naming unplayable in dub even when a dub track exists.
export function rankByQuality(list, { runtimeMin = null, minResolution = 1080, mode = "sub", rdFilter = false } = {}) {
  const kept = [], rejected = [];
  for (const c of list || []) {
    const gate = meetsFloor(c, { runtimeMin, minResolution });
    if (!gate.ok) { rejected.push({ name: c?.name, reason: gate.reason }); continue; }
    kept.push({ ...c, ...describe(c, { runtimeMin }), quality: parseResolution(c?.name || ""), _s: qualityScore(c, { runtimeMin, mode, rdFilter }) });
  }
  kept.sort((a, b) => b._s - a._s);
  return { list: kept, rejected };
}

// When the floor leaves nothing playable, callers need a way to try anyway
// rather than show an empty screen. Same ordering, no gate.
export function rankIgnoringFloor(list, { runtimeMin = null, mode = "sub", rdFilter = false } = {}) {
  return (list || [])
    .map((c) => ({ ...c, ...describe(c, { runtimeMin }), quality: parseResolution(c?.name || ""), _s: qualityScore(c, { runtimeMin, mode, rdFilter }) }))
    .sort((a, b) => b._s - a._s);
}

// ---------- can this release be fetched at all? ----------
//
// A torrent with ZERO seeders is not slow, it is gone. A debrid service can
// only serve it if the file is already in its own cache; otherwise no amount of
// waiting completes it. Attempting one is far from free — each costs a full
// cache-probe timeout (8-15s) — and a popular film's list is mostly these, so a
// single play could spend a minute failing before it reached a release that
// works. That is the "many of these" the user watched it grind through.
//
// Two things are deliberately NOT treated as dead:
//   • a known cache hit — it needs no seeders at all, so it plays instantly;
//   • an ABSENT seeder count (undefined/null, which some indexers omit) —
//     missing data is not evidence of a dead torrent, and treating it as zero
//     would throw away most of one indexer's catalogue.
export function looksFetchable(c) {
  if (c?.cached) return true;
  const s = c?.seeders;
  if (s === undefined || s === null || s === "") return true;
  return Number(s) > 0;
}

// For a play that will be TRANSCODED, a 1080p source beats a 4K one — put the
// ≤1080p candidates first, keeping each group's internal order.
//
// This is not a quality judgment, it's a pipeline one. A remote client gets at
// most 1080p at the bitrate cap, so a 2160p source contributes nothing the
// output can show — but it costs everything: the N100 must software-decode 4K
// (HEVC, usually 10-bit HDR, so a tonemap on top) to feed an encode that then
// throws three quarters of the pixels away. Measured symptom: the encoder runs
// slower than realtime and the viewer "always" buffers, because the player is
// perpetually at the live edge of a transcode that cannot get ahead. The same
// episode from a 1080p source decodes several times faster and reaches the
// SAME output quality — grain-filtered web-dls actually fare better at a small
// bitrate than tonemapped 4K grain does.
//
// Unknown resolutions (quality 0/null) count as ≤1080p: they're almost always
// episode files whose name just doesn't say, not 4K remuxes, and sinking them
// would override the quality ranking on a guess. When NOTHING is ≤1080p the
// list is returned untouched — a 4K-only title must still play.
export function preferTranscodeFriendly(list) {
  const hd = [], uhd = [];
  for (const c of list || []) (Number(c?.quality) > 1080 ? uhd : hd).push(c);
  return hd.length && uhd.length ? [...hd, ...uhd] : (list || []);
}
