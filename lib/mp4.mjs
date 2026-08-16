// Minimal MP4 box reader — just enough to answer "can a browser stream this
// file directly, or does it need remuxing first?"
//
// An MP4 keeps its media in `mdat` and its INDEX — sample tables, timestamps,
// codec descriptions — in `moov`. Nothing requires `moov` to come first, and
// plenty of releases put it at the end. Such a file plays perfectly from local
// disk and badly over HTTP: the browser has to reach the far end before it can
// interpret a single frame, and what you get is stuttering video with smeared
// audio. Measured on a real release: a 1.84 GB MP4 laid out ftyp/free/mdat,
// with moov nowhere in the first 1.5 MB.
//
// So "is this an H.264 MP4" was never a sufficient test for streaming it
// untouched. It also has to be laid out front-to-back, and its audio has to be
// something browsers actually decode — AC3/E-AC3/DTS are common in releases and
// no browser will touch them.

// The box types that legitimately appear at the top level of an MP4. Requiring
// the FIRST box to be one of these stops arbitrary bytes parsing as a box —
// four printable characters in the right place is otherwise enough to fool the
// walker (an HTML error page from the CDN would happily "parse").
const TOP_LEVEL = new Set(["ftyp", "styp", "moov", "mdat", "free", "skip", "wide", "pnot", "junk", "moof", "mfra", "uuid", "meta"]);

// Walk the top-level boxes of whatever prefix of the file we have.
export function topLevelBoxes(buf) {
  const out = [];
  let off = 0;
  if (buf.length < 8 || !TOP_LEVEL.has(buf.toString("latin1", 4, 8))) return out;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (!/^[a-zA-Z0-9 ]{4}$/.test(type)) break;   // not a box — stop rather than guess
    let header = 8;
    if (size === 1) {                              // 64-bit extended size
      if (off + 16 > buf.length) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    }
    out.push({ type, size, offset: off });
    if (size < header) break;                      // malformed; don't loop forever
    off += size;
    if (out.length > 32) break;
  }
  return out;
}

// True only when we can SEE moov ahead of mdat. Not knowing counts as false:
// guessing wrong here means a broken-looking stream, and the fallback (remux)
// always works.
export function isFastStart(buf) {
  const boxes = topLevelBoxes(buf);
  for (const b of boxes) {
    if (b.type === "moov") return true;
    if (b.type === "mdat") return false;           // media first → index is at the end
  }
  return false;                                    // ran out of prefix without finding moov
}

// Audio codecs a browser can decode. Anything else has to be transcoded, or the
// picture plays and the sound is noise.
const AUDIO_OK = ["mp4a", "Opus", "opus"];
const AUDIO_BAD = ["ac-3", "ec-3", "dtsc", "dtse", "dtsh", "dtsl", "alac", "fLaC"];

// Only meaningful once moov is in the buffer (i.e. a faststart file).
// Returns true / false / null when the header doesn't say.
export function audioIsBrowserSafe(buf) {
  const s = buf.toString("latin1");
  if (AUDIO_BAD.some((c) => s.includes(c))) return false;
  if (AUDIO_OK.some((c) => s.includes(c))) return true;
  return null;
}

// One verdict from a prefix of the file.
export function canStreamDirectly(buf) {
  if (!isFastStart(buf)) return { ok: false, why: "moov is not at the front (not faststart)" };
  const audio = audioIsBrowserSafe(buf);
  if (audio === false) return { ok: false, why: "audio codec a browser can't decode" };
  if (audio === null) return { ok: false, why: "audio codec undetermined" };
  return { ok: true, why: "faststart with browser-safe audio" };
}
