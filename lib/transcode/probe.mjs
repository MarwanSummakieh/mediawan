// ffprobe wrapper — what is actually inside this file?
//
// Release NAMES are used for ranking because they're all you have before you
// fetch. Once the bytes are on the array, guessing stops: the container tells
// you its codecs, channel layouts and runtime exactly. That matters because the
// delivery decision (direct play / remux / re-encode) is wrong if it's made on
// a mislabelled filename, and release names are mislabelled constantly.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.mjs";

const run = promisify(execFile);

// Codecs a browser can play in a fragmented-MP4/HLS container without being
// re-encoded. Everything else has to be converted for remote delivery — but on
// the LAN a native client may well handle it, so this is a delivery input, not
// a rejection.
const BROWSER_VIDEO = new Set(["h264", "vp8", "vp9", "av1"]);
// What a browser can decode INSIDE an fMP4/HLS container, which is narrower
// than what it plays in a standalone file. Verified against Chrome with
// MediaSource.isTypeSupported: aac/flac/opus are true; mp3 and vorbis in MP4
// are FALSE, and ac3/eac3 are false outright (they need a codec licence).
// Listing something here that the browser can't decode produces a stream with
// silent-or-broken audio and no error worth the name — that is exactly how
// E-AC3 broke every 5.1 dub while stereo subs kept working.
const BROWSER_AUDIO = new Set(["aac", "opus", "flac"]);
// HEVC is deliberately absent: TVs decode it, desktop Chrome largely does not,
// and this decision has to hold for both.

// `expectedBytes` is the file's FINAL size, which matters because playback
// starts before the download finishes. ffprobe reports bit_rate from the bytes
// present, so probing 16 MB of a 3.1 GB remux reports ~0.2 Mbps — and a
// delivery plan built on that number concludes the stream is already tiny
// enough to send untouched, which is exactly wrong. Duration is safe to read
// from a partial file (it lives in the container header), so the honest bitrate
// is expected-size over probed duration.
export async function probeFile(filePath, { expectedBytes = 0 } = {}) {
  const { stdout } = await run(config.transcode.ffprobe, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ], { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });

  const j = JSON.parse(stdout);
  const streams = j.streams || [];
  const video = streams.find((s) => s.codec_type === "video") || null;
  const audios = streams.filter((s) => s.codec_type === "audio");
  const subs = streams.filter((s) => s.codec_type === "subtitle");

  const durationSec = Number(j.format?.duration) || Number(video?.duration) || 0;
  const onDiskBytes = Number(j.format?.size) || 0;
  // Prefer the final size when we know it and it exceeds what's on disk — that
  // is the partial-download case, where format.bit_rate is meaningless.
  const sizeForRate = expectedBytes > onDiskBytes ? expectedBytes : onDiskBytes;
  const mbps = durationSec > 0 && sizeForRate > 0
    ? (sizeForRate * 8) / durationSec / 1e6
    : (Number(j.format?.bit_rate) || 0) / 1e6 || null;

  return {
    durationSec,
    sizeBytes: onDiskBytes,
    expectedBytes: expectedBytes || onDiskBytes,
    partial: expectedBytes > onDiskBytes,
    mbps: mbps || null,
    container: j.format?.format_name || null,
    video: video && {
      codec: video.codec_name,
      width: video.width,
      height: video.height,
      // Needed to size the GOP: segment length is a frame count, not a time.
      fps: (() => {
        const [n, d] = String(video.r_frame_rate || "").split("/").map(Number);
        return n && d ? n / d : null;
      })(),
      // HDR shows up as a wide-gamut transfer function. Remote delivery has to
      // tone-map it: an untouched HDR grade shown on an SDR client looks grey
      // and washed out, which is worse than a plain SDR encode of the same file.
      hdr: /smpte2084|arib-std-b67|bt2020/i.test(
        `${video.color_transfer || ""} ${video.color_primaries || ""} ${video.color_space || ""}`),
      browserSafe: BROWSER_VIDEO.has(video.codec_name),
    },
    audio: audios.map((a, i) => ({
      index: a.index,
      order: i,
      codec: a.codec_name,
      channels: a.channels,
      layout: a.channel_layout || null,
      language: a.tags?.language || null,
      title: a.tags?.title || null,
      browserSafe: BROWSER_AUDIO.has(a.codec_name),
    })),
    subtitles: subs.map((s) => ({
      index: s.index,
      codec: s.codec_name,
      language: s.tags?.language || null,
      title: s.tags?.title || null,
    })),
  };
}

// Pick the audio track to serve.
//
// This is where "dub" actually happens. A dual-audio remux ships Japanese and
// English (often plus commentary and other dubs), and ffmpeg's default — the
// first audio stream — is frequently the wrong one. Language is therefore the
// PRIMARY key, not a tiebreak: a viewer who asked for dub would rather have
// stereo English than lossless 5.1 Japanese.
//
// `languages` is an ordered list of acceptable ISO codes (see LANGS in
// lib/quality.mjs); the first that matches any track wins. Within a language,
// prefer more channels, then a browser-decodable codec, then declaration order.
//
// Commentary tracks are excluded: they're tagged the requested language and
// often have the most channels, so they'd win outright.
const COMMENTARY = /\b(commentar|director|cast|interview|karaoke|audio\s*description)\b/i;

// A track declares its language two ways: the ISO tag, and the TITLE. Fansub
// releases in particular ship untagged tracks titled "Japanese" / "English
// Dub" — matching tags alone treats those files as language-less and hands the
// decision to channel count, which on a dual-audio release is the English 5.1.
// That is precisely how a SUB request came back speaking English.
//
// Only the two families this app ever requests (LANGS in lib/quality.mjs).
const LANG_FAMILY = {
  jpn: { codes: /^(jpn|jp|ja)/i, words: /japan|nihongo|日本/i },
  eng: { codes: /^(eng|en)/i, words: /english/i },
};
const familyOf = (code) => (/^j/i.test(code) ? "jpn" : /^e/i.test(code) ? "eng" : null);

function matchesFamily(t, fam) {
  const f = LANG_FAMILY[fam];
  if (!f) return false;
  if (f.codes.test(t.language || "")) return true;
  return f.words.test(t.title || "");
}

export function pickAudio(probe, { languages = [], strict = false } = {}) {
  const all = probe.audio || [];
  if (!all.length) return null;
  const tracks = all.filter((t) => !COMMENTARY.test(t.title || "")).length
    ? all.filter((t) => !COMMENTARY.test(t.title || ""))
    : all;

  const byQuality = (a, b) =>
    (b.channels || 0) - (a.channels || 0) ||
    Number(!a.browserSafe) - Number(!b.browserSafe) ||
    a.order - b.order;

  for (const lang of languages) {
    const fam = familyOf(lang);
    const hit = tracks.filter((t) =>
      (t.language || "").toLowerCase().startsWith(lang.toLowerCase()) || (fam && matchesFamily(t, fam)));
    if (hit.length) return [...hit].sort(byQuality)[0];
  }
  // No track in any requested language. `strict` says the caller cannot use a
  // substitute — a dub request served the Japanese track is not a degraded
  // result, it's the wrong thing — so report the miss instead of guessing.
  if (strict && languages.length) return null;

  // Nothing declares the requested language. Before falling back on raw
  // quality, prefer tracks that declare NOTHING — no tag, no other-language
  // title. An undeclared track on a dual-audio release is far likelier to be
  // the Japanese original than the one already labelled "English Dub" is:
  // channel count used to decide here, and the English 5.1 beat the Japanese
  // 2.0 on the very request that asked for Japanese. A track POSITIVELY tagged
  // some other language ("ger", "fre") is not a candidate original — those
  // fall through to the plain quality fallback with everything else.
  const wanted = new Set(languages.map(familyOf).filter(Boolean));
  if (wanted.size) {
    const otherFams = Object.keys(LANG_FAMILY).filter((f) => !wanted.has(f));
    const neutral = tracks.filter((t) => !t.language && !otherFams.some((f) => matchesFamily(t, f)));
    if (neutral.length) return [...neutral].sort(byQuality)[0];
  }

  // Untagged single-track files are the common case for a plain sub release;
  // there is nothing to choose and the one track is right.
  return [...tracks].sort(byQuality)[0];
}

// Does this file carry the language the viewer asked for? Tags and titles both
// count — see LANG_FAMILY.
export function hasLanguage(probe, languages = []) {
  return (probe.audio || []).some((t) =>
    languages.some((l) =>
      (t.language || "").toLowerCase().startsWith(l.toLowerCase()) ||
      matchesFamily(t, familyOf(l))));
}

// Is ffmpeg present, and does QuickSync actually work here?
//
// Checked rather than assumed, because the failure mode is silent and awful: a
// missing QSV device makes ffmpeg fall back to libx264, an N100 cannot keep up
// with that in real time, and every remote viewer gets stuttering video with no
// error anywhere.
export async function capabilities() {
  const out = { ffmpeg: false, qsv: false, encoders: [], error: null };
  try {
    const { stdout } = await run(config.transcode.ffmpeg, ["-hide_banner", "-encoders"], { timeout: 15_000 });
    out.ffmpeg = true;
    out.encoders = ["h264_qsv", "hevc_qsv", "libx264"].filter((e) => stdout.includes(e));
    out.qsv = out.encoders.includes("h264_qsv");
  } catch (e) {
    out.error = e.message;
  }
  return out;
}
