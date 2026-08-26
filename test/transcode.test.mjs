// Unit tests for the delivery planner and the ffmpeg argument builder — the
// pure halves of lib/transcode/session.mjs. No ffmpeg, no network, no files.
// The planner decides WHAT gets converted (the "minimal transcoding" rule:
// only the stream that actually needs it), and the arg builder is inspected
// as a command line because that is what diagnoses a misbehaving transcode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planDelivery, ffmpegArgs } from "../lib/transcode/session.mjs";

const BROWSER_VIDEO = ["h264", "vp8", "vp9", "av1"];
const BROWSER_AUDIO = ["aac", "opus", "flac"];

const probeOf = ({ vcodec = "h264", height = 1080, mbps = 4, acodec = "aac",
  channels = 2, hdr = false, container = "matroska,webm" } = {}) => ({
  durationSec: 1440, sizeBytes: 0, expectedBytes: 0, partial: false,
  mbps, container,
  video: {
    codec: vcodec, width: Math.round((height * 16) / 9), height, fps: 24, hdr,
    browserSafe: BROWSER_VIDEO.includes(vcodec),
  },
  audio: [{
    index: 1, order: 0, codec: acodec, channels, layout: null,
    language: "jpn", title: null, browserSafe: BROWSER_AUDIO.includes(acodec),
  }],
  subtitles: [],
});

const argsOf = (plan, probe, extra = {}) =>
  ffmpegArgs({ input: "in.mkv", outDir: "/tmp/x", plan, probe, ...extra }).join(" ");

// ---------- planDelivery: convert only what needs converting ----------

test("LAN: browser-safe codecs in an mkv → lossless remux", () => {
  const p = planDelivery(probeOf(), { local: true });
  assert.equal(p.mode, "remux");
});

test("LAN: safe video + DTS audio → encode that copies the video, no cap", () => {
  const p = planDelivery(probeOf({ acodec: "dts" }), { local: true });
  assert.equal(p.mode, "encode");
  assert.equal(p.copyVideo, true);
  assert.equal(p.targetMbps, null);
});

test("remote: under budget with safe codecs → remux, not encode", () => {
  const p = planDelivery(probeOf({ mbps: 4 }), { local: false, targetMbps: 6 });
  assert.equal(p.mode, "remux");
});

test("remote: under-budget H.264 with AC-3 audio copies the video and converts only the audio", () => {
  // The regression this planner change exists for: this case used to take the
  // full-encode path — a second lossy generation on video that fit the budget
  // bit-for-bit, purely because the audio needed converting.
  const p = planDelivery(probeOf({ mbps: 4, acodec: "ac3", channels: 6 }), { local: false, targetMbps: 6 });
  assert.equal(p.mode, "encode");
  assert.equal(p.copyVideo, true);
  assert.equal(p.targetMbps, null, "a copied video stream takes no bitrate cap");
});

test("remote: over budget → capped encode of the video", () => {
  const p = planDelivery(probeOf({ mbps: 25 }), { local: false, targetMbps: 6 });
  assert.equal(p.mode, "encode");
  assert.equal(p.copyVideo, false);
  assert.equal(p.targetMbps, 6);
});

test("remote: HEVC under budget still encodes — the codec, not the size, is the problem", () => {
  const p = planDelivery(probeOf({ vcodec: "hevc", mbps: 4 }), { local: false, targetMbps: 6 });
  assert.equal(p.mode, "encode");
  assert.equal(p.copyVideo, false);
});

test("remote: unknown bitrate is treated as over budget", () => {
  const p = planDelivery(probeOf({ mbps: null }), { local: false, targetMbps: 6 });
  assert.equal(p.mode, "encode");
  assert.equal(p.copyVideo, false);
});

// ---------- ffmpegArgs: the command line the plan turns into ----------

test("capped encode of a 4K source downscales to 1080p", () => {
  const probe = probeOf({ height: 2160, mbps: 40 });
  const plan = planDelivery(probe, { local: false, targetMbps: 6 });
  const args = argsOf(plan, probe);
  assert.match(args, /scale=-2:1080/);
});

test("capped encode of a 1080p source does not scale", () => {
  const probe = probeOf({ vcodec: "hevc", mbps: 25 });
  const plan = planDelivery(probe, { local: false, targetMbps: 6 });
  assert.doesNotMatch(argsOf(plan, probe), /scale=-2:1080/);
});

test("uncapped LAN encode keeps the source resolution", () => {
  // On the LAN the codec was the problem, not the bitrate — a 4K picture
  // stays 4K.
  const probe = probeOf({ vcodec: "hevc", height: 2160, mbps: 40 });
  const plan = planDelivery(probe, { local: true });
  assert.equal(plan.targetMbps, null);
  assert.doesNotMatch(argsOf(plan, probe), /scale=-2:1080/);
});

test("copied video emits -c:v copy and no forced GOP", () => {
  const probe = probeOf({ mbps: 4, acodec: "ac3" });
  const plan = planDelivery(probe, { local: false, targetMbps: 6 });
  const args = argsOf(plan, probe);
  assert.match(args, /-c:v copy/);
  assert.doesNotMatch(args, / -g \d/);
});

test("browser-safe audio is copied even alongside a video encode", () => {
  const probe = probeOf({ vcodec: "hevc", mbps: 25, acodec: "aac", channels: 6 });
  const plan = planDelivery(probe, { local: false, targetMbps: 6 });
  assert.match(argsOf(plan, probe), /-c:a copy/);
});

test("FLAC under a bitrate cap converts to AAC — lossless audio would crowd out the video", () => {
  const probe = probeOf({ vcodec: "hevc", mbps: 25, acodec: "flac", channels: 6 });
  const plan = planDelivery(probe, { local: false, targetMbps: 6 });
  const args = argsOf(plan, probe);
  assert.doesNotMatch(args, /-c:a copy/);
  assert.match(args, /-c:a aac/);
  assert.match(args, /-b:a 384k/); // 5.1 stays 5.1, at the surround rate
});

test("FLAC with no cap (remux) is copied untouched", () => {
  const probe = probeOf({ acodec: "flac", channels: 6 });
  const plan = planDelivery(probe, { local: true });
  assert.equal(plan.mode, "remux");
  assert.match(argsOf(plan, probe), /-c:a copy/);
});

test("QSV encodes use the medium preset; the software fallback stays veryfast", () => {
  const probe = probeOf({ vcodec: "hevc", mbps: 25 });
  const plan = planDelivery(probe, { local: false, targetMbps: 6 });
  assert.match(argsOf(plan, probe), /h264_qsv.*-preset medium/);
  assert.match(argsOf(plan, probe, { forceSoftware: true }), /libx264.*-preset veryfast -crf 21/);
});

test("HDR tone-mapping joins the filter chain after the downscale", () => {
  const probe = probeOf({ vcodec: "hevc", height: 2160, mbps: 40, hdr: true });
  const plan = planDelivery(probe, { local: false, targetMbps: 6 });
  const args = argsOf(plan, probe);
  assert.match(args, /scale=-2:1080,zscale=/); // fewer pixels through the expensive tonemap
});

// ---------- planDelivery: a hand-picked audio track ----------
// The language selector for films and TV: the viewer names one of the file's
// own streams, which outranks both merit and any sub/dub language preference.

const multi = () => ({
  durationSec: 7200, sizeBytes: 0, expectedBytes: 0, partial: false, mbps: 4,
  container: "matroska,webm",
  video: { codec: "h264", width: 1920, height: 1080, fps: 24, hdr: false, browserSafe: true },
  audio: [
    { index: 1, order: 0, codec: "eac3", channels: 6, language: "eng", title: null, browserSafe: false },
    { index: 2, order: 1, codec: "aac", channels: 2, language: "fre", title: null, browserSafe: true },
  ],
  subtitles: [],
});

test("audioIndex picks the named track over the best one", () => {
  const p = planDelivery(multi(), { local: true, audioIndex: 2 });
  assert.equal(p.audioIndex, 2, "the French stereo track was asked for by index");
});

test("without audioIndex the best track still wins on merit", () => {
  // 5.1 beats stereo when nobody has expressed a preference
  assert.equal(planDelivery(multi(), { local: true }).audioIndex, 1);
});

// ---------- films get a default audio language ----------
//
// The regression this pins: anime states its language as sub/dub, films state
// nothing, and "nothing" used to mean no preference at all — which dropped
// through pickAudio to its last resort, sort-by-channel-count. A MULTi release
// mixes one language in 5.1 and the rest in stereo, so the film played in
// whichever language the encoder favoured. Reported live: one household member
// got Spanish audio on every film while anime was fine for everyone, because
// only the film path had no language to ask for.
const filmWith = (tracks) => ({
  durationSec: 7200, sizeBytes: 0, expectedBytes: 0, partial: false, mbps: 4,
  container: "matroska,webm",
  video: { codec: "h264", width: 1920, height: 1080, fps: 24, hdr: false, browserSafe: true },
  audio: tracks.map((t, i) => ({
    index: i + 1, order: i, codec: "aac", layout: null, title: null, browserSafe: true, ...t,
  })),
  subtitles: [],
});

test("film: Spanish 5.1 does not beat English stereo when no mode is given", () => {
  const p = planDelivery(filmWith([
    { language: "spa", channels: 6 },
    { language: "eng", channels: 2 },
  ]), { local: false, targetMbps: 6 });
  assert.equal(p.audioIndex, 2, "English wins on language, not on channel count");
});

test("film: English still wins from the back of the track list", () => {
  const p = planDelivery(filmWith([
    { language: "spa", channels: 6 },
    { language: "fre", channels: 6 },
    { language: "eng", channels: 2 },
  ]), { local: true });
  assert.equal(p.audioIndex, 3);
});

test("film: among several English tracks the best one still wins", () => {
  const p = planDelivery(filmWith([
    { language: "eng", channels: 2 },
    { language: "eng", channels: 6 },
  ]), { local: true });
  assert.equal(p.audioIndex, 2, "language first, then quality — as before");
});

test("film: a genuinely foreign film keeps its own audio and is not a language miss", () => {
  // The preference must not become a requirement: a French film has no English
  // track and that is correct, not a failure to report to the viewer.
  const p = planDelivery(filmWith([{ language: "fre", channels: 6 }]), { local: true });
  assert.equal(p.audioIndex, 1);
  assert.equal(p.languageOk, true, "nothing was asked for, so nothing can be missing");
  assert.doesNotMatch(p.reason, /no (English|Japanese) track/);
});

test("film: an explicit audioIndex still overrides the default preference", () => {
  const p = planDelivery(filmWith([
    { language: "spa", channels: 6 },
    { language: "eng", channels: 2 },
  ]), { local: true, audioIndex: 1 });
  assert.equal(p.audioIndex, 1, "the viewer picked Spanish on purpose");
});

test("anime: sub/dub is unaffected by the film default", () => {
  const probe = filmWith([
    { language: "eng", channels: 6 },
    { language: "jpn", channels: 2 },
  ]);
  assert.equal(planDelivery(probe, { local: true, mode: "sub" }).audioIndex, 2);
  assert.equal(planDelivery(probe, { local: true, mode: "dub" }).audioIndex, 1);
});

test("anime: a real language miss is still reported", () => {
  const p = planDelivery(filmWith([{ language: "eng", channels: 6 }]), { local: true, mode: "sub" });
  assert.equal(p.languageOk, false);
  assert.match(p.reason, /no Japanese track/);
});

test("audioIndex outranks the sub/dub language preference", () => {
  // "dub" means English, and track 1 IS English — the explicit pick still wins
  const p = planDelivery(multi(), { local: true, mode: "dub", audioIndex: 2 });
  assert.equal(p.audioIndex, 2);
  assert.equal(p.languageOk, true, "an explicit pick is never a language miss");
});

test("a stale audioIndex falls back to merit instead of muting the film", () => {
  // index 9 belongs to the release the viewer switched away from
  const p = planDelivery(multi(), { local: true, audioIndex: 9 });
  assert.equal(p.audioIndex, 1);
});

test("every plan reports the file's full track list for the language menu", () => {
  const p = planDelivery(multi(), { local: false, targetMbps: 6 });
  assert.deepEqual(p.audioTracks.map((t) => [t.index, t.language, t.channels]),
    [[1, "eng", 6], [2, "fre", 2]]);
});

test("a multi-track file never direct-plays — the client would pick its own track", () => {
  const probe = { ...multi(), container: "mov,mp4,m4a", audio: multi().audio.map((a) => ({ ...a, codec: "aac", browserSafe: true })) };
  const p = planDelivery(probe, { local: true, audioIndex: 2 });
  assert.equal(p.mode, "remux", "the chosen track has to be mapped, so it goes through ffmpeg");
  assert.equal(p.audioIndex, 2);
});

// ---------- pickAudio: the sub/dub track decision ----------
// Language is read from TAGS and TITLES both — fansub releases ship untagged
// tracks titled "Japanese" / "English Dub", and matching tags alone handed the
// decision to channel count, where the English 5.1 beats the Japanese 2.0 on
// the very request that asked for Japanese.
import { pickAudio, hasLanguage } from "../lib/transcode/probe.mjs";
import { rawFileIsPlayable } from "../lib/transcode/session.mjs";

// ---------- rawFileIsPlayable: the fallback when the transcoder says no ----------
//
// Refusing to transcode sends the caller looking for a fallback, and the only
// one available is the untouched release. Whether that is a fallback at all is
// this question. It used to be assumed rather than asked, and the assumption
// was wrong for the shape a release usually has — which is how "changing the
// resolution stops the audio" happened: the dial asks for a second encoder, a
// full box refuses, and the raw MKV that came back played picture and silence.

test("rawFileIsPlayable: an MP4 of H.264 + AAC is genuinely playable", () => {
  assert.equal(rawFileIsPlayable(probeOf({ container: "mov,mp4,m4a" })), true);
});

test("rawFileIsPlayable: AC-3 audio is a silent movie, not a fallback", () => {
  const p = probeOf({ acodec: "ac3", channels: 6, container: "mov,mp4,m4a" });
  assert.equal(p.video.browserSafe, true, "the PICTURE is fine — that is the trap");
  assert.equal(rawFileIsPlayable(p), false);
});

test("rawFileIsPlayable: an mkv is not something a browser opens", () => {
  assert.equal(rawFileIsPlayable(probeOf()), false, "matroska, however safe its codecs");
});

test("rawFileIsPlayable: HEVC video fails on the picture instead", () => {
  assert.equal(rawFileIsPlayable(probeOf({ vcodec: "hevc", container: "mov,mp4,m4a" })), false);
});

test("rawFileIsPlayable: EVERY track has to be decodable, not just the chosen one", () => {
  // Nothing maps streams on this path, so the browser plays whichever track it
  // prefers — commonly the 5.1 one, which is commonly the undecodable one.
  const p = probeOf({ container: "mov,mp4,m4a" });
  p.audio.push({ index: 2, order: 1, codec: "eac3", channels: 6, layout: null,
    language: "eng", title: null, browserSafe: false });
  assert.equal(rawFileIsPlayable(p), false);
});

test("rawFileIsPlayable: no probe at all is not a licence to guess", () => {
  assert.equal(rawFileIsPlayable(null), false);
  assert.equal(rawFileIsPlayable(undefined), false);
});

const SUB = ["jpn", "ja", "jp"], DUB = ["eng", "en"];
const at = (tracks) => ({ audio: tracks.map((t, i) => ({ order: i, index: i + 1, browserSafe: true, ...t })) });

test("pickAudio: tagged dual audio picks the requested language", () => {
  const p = at([{ language: "eng", channels: 6 }, { language: "jpn", channels: 2 }]);
  assert.equal(pickAudio(p, { languages: SUB }).language, "jpn");
  assert.equal(pickAudio(p, { languages: DUB }).language, "eng");
});

test("pickAudio: untagged tracks titled by language still match", () => {
  const p = at([
    { language: null, title: "English Dub 5.1", channels: 6 },
    { language: null, title: "Japanese", channels: 2 },
  ]);
  assert.equal(pickAudio(p, { languages: SUB }).title, "Japanese");
  assert.equal(pickAudio(p, { languages: DUB }).title, "English Dub 5.1");
  assert.equal(hasLanguage(p, SUB), true, "a titled track counts as carrying the language");
});

test("pickAudio: sub request never falls back onto an explicitly-English track", () => {
  // The regression: no jpn tag anywhere, eng tagged, untagged original —
  // channels-first fallback used to serve the English 5.1 for a SUB request.
  const p = at([{ language: "eng", channels: 6 }, { language: null, channels: 2 }]);
  const picked = pickAudio(p, { languages: SUB });
  assert.equal(picked.language, null, "the untagged track is likelier the original than the labelled dub");
});

test("pickAudio: fully-labelled file without the language falls back on quality", () => {
  const p = at([{ language: "eng", channels: 6 }, { language: "ger", channels: 2 }]);
  assert.equal(pickAudio(p, { languages: SUB }).language, "eng"); // nothing neutral left
});

test("pickAudio: strict still reports a genuine miss", () => {
  const p = at([{ language: "eng", channels: 6 }]);
  assert.equal(pickAudio(p, { languages: SUB, strict: true }), null);
});

// ---------- embedded subtitles ride the session as sidecar VTTs ----------

const subProbe = (subs) => ({ ...probeOf({ mbps: 25, vcodec: "hevc" }), subtitles: subs });

test("ffmpegArgs: text subtitle streams become sub-<index>.vtt outputs, demuxed from their OWN input", () => {
  const probe = subProbe([
    { index: 2, codec: "ass", language: "eng", title: "English (Full)" },
    { index: 3, codec: "hdmv_pgs_subtitle", language: "eng", title: "Signs (PGS)" },
    { index: 4, codec: "subrip", language: "spa", title: null },
  ]);
  const plan = planDelivery(probe, { local: false, targetMbps: 6 });
  const args = argsOf(plan, probe);
  // Subs map from input 1, a second -i of the same source. Feeding them from
  // input 0 silently starved the HLS audio on current ffmpeg builds — measured
  // live: 4 s of video and TWO audio frames per segment, exit 0, empty stderr.
  assert.equal(args.split("-i ").length - 1, 2, "text subs require a second -i of the source");
  // -flush_packets is required, not cosmetic: without it the WebVTT muxer
  // buffers to close and the sidecar doesn't exist until the encode finishes.
  assert.match(args, /-map 1:2 -c:s webvtt -flush_packets 1 sub-2\.vtt/);
  assert.match(args, /-map 1:4 -c:s webvtt -flush_packets 1 sub-4\.vtt/);
  assert.doesNotMatch(args, /1:3/, "bitmap subs can't become text and are skipped");
});

test("ffmpegArgs: no text subs → ONE input, no second read of the source", () => {
  const probe = subProbe([]);
  const plan = planDelivery(probe, { local: false, targetMbps: 6 });
  const args = argsOf(plan, probe);
  assert.equal(args.split("-i ").length - 1, 1, "the second input is only paid for when subs exist");
});

test("ffmpegArgs: a seek applies to BOTH inputs so cues share the session origin", () => {
  const probe = subProbe([{ index: 2, codec: "ass", language: "eng" }]);
  const plan = planDelivery(probe, { local: false, targetMbps: 6 });
  const args = argsOf(plan, probe, { seekSec: 120 });
  assert.equal(args.split("-ss 120").length - 1, 2, "-ss must precede each -i, or subtitles drift by the seek offset");
});

// Regression, observed as constant audio desync on every remote resume once
// 1080p picks started coming in under budget. Input -ss lands on the keyframe
// at-or-before the target; a COPIED video stream keeps everything from that
// keyframe, while accurate_seek trims the decoded audio to the exact target —
// so the tracks left the muxer offset by up to a GOP (measured: 3s on a 4s
// GOP). -noaccurate_seek starts every stream at the keyframe instead.
test("ffmpegArgs: a copy-video seek starts EVERY stream at the keyframe", () => {
  const probe = probeOf({ acodec: "eac3", mbps: 4 }); // safe video under budget, audio converts
  const plan = planDelivery(probe, { local: false, targetMbps: 6 });
  assert.equal(plan.copyVideo, true);
  assert.match(argsOf(plan, probe, { seekSec: 47 }), /-noaccurate_seek -ss 47/,
    "copied video cannot be trimmed to the target, so audio must not be either");
  assert.doesNotMatch(argsOf(plan, probe), /-noaccurate_seek/,
    "no seek, nothing to align");
});

test("ffmpegArgs: a full encode keeps the seek accurate — the resume point is exact", () => {
  const probe = probeOf({ mbps: 25 }); // over budget → video re-encodes
  const plan = planDelivery(probe, { local: false, targetMbps: 6 });
  assert.equal(plan.copyVideo, false);
  const args = argsOf(plan, probe, { seekSec: 47 });
  assert.doesNotMatch(args, /-noaccurate_seek/, "both streams decode and trim to the same instant");
  assert.match(args, /-ss 47/);
});

test("ffmpegArgs: no text subs → the command is exactly the old shape", () => {
  const probe = subProbe([{ index: 2, codec: "hdmv_pgs_subtitle", language: "eng" }]);
  const plan = planDelivery(probe, { local: false, targetMbps: 6 });
  assert.match(argsOf(plan, probe), /index\.m3u8$/);
});

// Regression, observed in production. The sidecars above are plain file
// outputs, so re-running a session over the same directory (any seek does this)
// made ffmpeg stop and ask:
//   File 'sub-2.vtt' already exists. Overwrite? [y/N] Not overwriting - exiting
// There is no terminal to answer, so it exited 1 and took the video with it —
// seeking into an already-watched episode just stopped playback.
test("ffmpegArgs: never waits on a prompt — overwrite is pre-answered", () => {
  const probe = subProbe([{ index: 2, codec: "subrip", language: "eng" }]);
  const plan = planDelivery(probe, { local: false, targetMbps: 6 });
  const args = argsOf(plan, probe);
  assert.match(args, /(^|\s)-y(\s|$)/, "must overwrite existing sidecars rather than ask");
  assert.match(args, /(^|\s)-nostdin(\s|$)/, "nothing can answer a prompt, so refuse stdin outright");
  // Both must precede -i: ffmpeg only honours them as input-side global options.
  assert.ok(args.indexOf("-y") < args.indexOf("-i "), "-y must be a global option, before -i");
});

// ---------- stale session dirs from a dead process ----------
//
// Session ids are deterministic, so a directory left by a killed server is
// exactly where the next play of that episode writes — and ffmpeg's
// append_list flag then APPENDS a second encode after the corpse, overwriting
// init.mp4. Measured live: a 48-minute playlist for a 24-minute episode whose
// first half no longer matched its init segment; the player hung on segment 0.
test("sweepSessionRoot: removes dirs this process doesn't own", async () => {
  const { sweepSessionRoot } = await import("../lib/transcode/session.mjs");
  const os = await import("node:os");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mw-sweep-"));
  for (const id of ["deadbeef00000001", "deadbeef00000002"]) {
    await fsp.mkdir(path.join(root, id), { recursive: true });
    await fsp.writeFile(path.join(root, id, "index.m3u8"), "#EXTM3U\n");
  }
  assert.equal(await sweepSessionRoot(root), 2);
  assert.deepEqual(await fsp.readdir(root), []);
  await fsp.rm(root, { recursive: true, force: true });
});

test("sweepSessionRoot: a missing root is not an error", async () => {
  const { sweepSessionRoot } = await import("../lib/transcode/session.mjs");
  assert.equal(await sweepSessionRoot("Z:\does\not\exist"), 0);
});

// ---------- the resolution dial ----------
//
// `maxHeight` is the viewer's own control, and the point of it is that it
// OVERRIDES the planner's judgement in both directions: down (a smaller picture
// than the source, on any client) and up (no automatic 1080p cap on a capped
// remote encode). Everything the planner infers stays inferred; only the number
// of lines is theirs.

test("dial: a downscale on the LAN forces an encode out of what would have been a remux", () => {
  const probe = probeOf({ height: 2160 });          // browser-safe codecs in an mkv
  assert.equal(planDelivery(probe, { local: true }).mode, "remux");
  const p = planDelivery(probe, { local: true, maxHeight: 720 });
  assert.equal(p.mode, "encode");
  assert.equal(p.copyVideo, false, "a smaller picture cannot come from a copied stream");
  assert.equal(p.targetMbps, null, "the LAN has no bitrate budget — only the size was asked for");
  assert.equal(p.scaleHeight, 720);
  assert.match(argsOf(p, probe), /scale=-2:720/);
});

test("dial: a downscale on a remote copy-video stream re-encodes it", () => {
  // Under budget with safe codecs, this is a straight remux by default.
  const probe = probeOf({ mbps: 4 });
  assert.equal(planDelivery(probe, { local: false, targetMbps: 6 }).mode, "remux");
  const p = planDelivery(probe, { local: false, targetMbps: 6, maxHeight: 480 });
  assert.equal(p.mode, "encode");
  assert.equal(p.copyVideo, false);
  assert.equal(p.targetMbps, 6);
  assert.match(argsOf(p, probe), /scale=-2:480/);
});

test("dial: asking for MORE than the automatic rule keeps the source resolution", () => {
  // The complaint this exists for: a capped remote encode was pinned to 1080p
  // whatever the viewer wanted, with no way to say "spend it on pixels".
  const probe = probeOf({ height: 2160, mbps: 40 });
  assert.match(argsOf(planDelivery(probe, { local: false, targetMbps: 6 }), probe), /scale=-2:1080/);
  const p = planDelivery(probe, { local: false, targetMbps: 6, maxHeight: 2160 });
  assert.equal(p.scaleHeight, null);
  assert.equal(p.outputHeight, 2160);
  assert.doesNotMatch(argsOf(p, probe), /scale=/);
});

test("dial: asking for more than the file holds is not an upscale", () => {
  const probe = probeOf({ height: 720, mbps: 3 });
  const p = planDelivery(probe, { local: true, maxHeight: 2160 });
  assert.equal(p.mode, "remux", "nothing to do — the file is already smaller than the ask");
  assert.equal(p.outputHeight, 720);
});

test("dial: asking for exactly the source resolution changes nothing", () => {
  const probe = probeOf({ height: 1080, mbps: 4 });
  const p = planDelivery(probe, { local: false, targetMbps: 6, maxHeight: 1080 });
  assert.equal(p.mode, "remux");
  assert.equal(p.scaleHeight ?? null, null);
});

test("dial: junk and absurd values fall back to the automatic rule", () => {
  const probe = probeOf({ height: 2160, mbps: 40 });
  for (const bad of [null, undefined, 0, "", "auto", -1, 12, NaN]) {
    const p = planDelivery(probe, { local: false, targetMbps: 6, maxHeight: bad });
    assert.equal(p.scaleHeight, 1080, `${String(bad)} must mean "no opinion"`);
  }
});

test("dial: the plan reports what actually comes out, for the menu to show", () => {
  const probe = probeOf({ height: 2160, mbps: 40 });
  assert.equal(planDelivery(probe, { local: false, targetMbps: 6 }).outputHeight, 1080);
  assert.equal(planDelivery(probe, { local: false, targetMbps: 6, maxHeight: 720 }).outputHeight, 720);
  assert.equal(planDelivery(probe, { local: true }).outputHeight, 2160);
});

test("dial: a downscale still tone-maps HDR, and scales before the tonemap chain", () => {
  // Order matters for cost, not correctness: zscale is the expensive filter and
  // it should see a quarter of the pixels, not four times as many.
  const probe = probeOf({ height: 2160, mbps: 40, hdr: true });
  const p = planDelivery(probe, { local: false, targetMbps: 6, maxHeight: 720 });
  const args = argsOf(p, probe);
  assert.match(args, /scale=-2:720,zscale=/);
});
