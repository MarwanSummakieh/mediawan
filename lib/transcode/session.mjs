// Live transcoding — the piece that makes a 60 GB remux watchable over a
// residential uplink without degrading what plays on the LAN.
//
// The delivery decision has three outcomes, in order of preference:
//
//   direct   — LAN client, browser-safe codecs. Serve the file. No ffmpeg.
//   remux    — LAN client, unplayable CONTAINER but fine codecs (the common
//              .mkv case). Repackage to fMP4/HLS with `-c copy`: no quality
//              loss whatsoever, and cheap enough to be free.
//   encode   — something needs converting. Only the offending stream is
//              touched: browser-safe video is copied even when the audio must
//              convert (and vice versa), and the QuickSync bitrate cap applies
//              only when the video itself is too big for the tunnel. This is
//              the only lossy path, and it exists because the alternative
//              isn't "better quality", it's buffering.
//
// The old design had exactly one of these — Real-Debrid's transcoder — applied
// to everyone regardless of where they were watching from, at roughly half the
// source bitrate with surround folded to stereo. Splitting it by client is what
// lets the LAN see untouched remuxes while remote viewers still get something
// that plays smoothly.
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.mjs";
import { probeFile, pickAudio, hasLanguage } from "./probe.mjs";
import { LANGS } from "../quality.mjs";
import * as store from "../cache/store.mjs";

const SESSION_ROOT = path.join(store.CACHE_DIR, "..", "transcode");

// id -> session
const sessions = new Map();

export function status() {
  return {
    enabled: config.transcode.enabled,
    active: sessions.size,
    maxSessions: config.transcode.maxSessions,
    sessions: [...sessions.values()].map((s) => ({
      id: s.id, mode: s.mode, seekSec: s.seekSec, startedAt: s.startedAt, lastReadAt: s.lastReadAt,
    })),
  };
}

// Decide how to deliver `probe` to this client. Pure, so the choice is
// testable without spawning anything.
export function planDelivery(probe, { local, targetMbps = config.transcode.remoteMbps, mode: audioMode = null, audioIndex = null } = {}) {
  const v = probe.video;
  // Language drives track selection for ANIME: "dub" means the English track,
  // "sub" the Japanese one. `null` means no preference — the normal case for
  // films and live-action TV, whose audio is just the film's audio — and then
  // the best track wins on merit. Never strict: a single-track file with no
  // language tags must still play whatever was asked for.
  //
  // `audioIndex` outranks both: it is the viewer having picked a track by hand
  // from the audio menu, which lists this file's actual streams. Honoured only
  // when the file really has that stream — a stale index from the previous
  // release must fall back to picking on merit, not silently mute the film.
  // Anime states its language as sub/dub. Films and live-action TV state
  // nothing — and that used to mean NO preference at all, which handed the
  // decision to pickAudio's last resort: sort by channel count. On a MULTi
  // release that resolves to whichever language got the 5.1 mix, so a film with
  // Spanish 5.1 and English 2.0 served Spanish to everyone, deterministically,
  // with ffmpeg mapping that single track (-map 0:<audioIndex> below) so the
  // English one never even reached the client. config.audioLangs is the
  // preference films never had; it is a PREFERENCE, not a requirement, so a
  // genuinely foreign film with no English track still falls through to its own
  // audio rather than being refused.
  const requested = LANGS[audioMode] || null;
  const languages = requested || config.audioLangs;
  const chosen = audioIndex != null
    ? (probe.audio || []).find((t) => t.index === audioIndex) || null
    : null;
  const a = chosen || pickAudio(probe, { languages });
  // Only an ASKED-FOR language can be missing. Without `requested` guarding
  // these, every French film would report languageOk:false and the player would
  // tell the viewer its audio was wrong.
  const languageOk = chosen || !requested ? true : hasLanguage(probe, requested);
  const langNote = requested && !languageOk ? ` (no ${audioMode === "dub" ? "English" : "Japanese"} track in this release)` : "";
  if (!v) return { mode: "encode", reason: "no video stream detected", audioIndex: a?.index ?? null, languageOk, audioMode };

  // Common to every branch: which track, whether the language was found, and
  // the full track list so the player can offer an audio menu without
  // re-resolving anything.
  const common = {
    audioIndex: a?.index ?? null,
    audioMode,
    languageOk,
    audioTracks: (probe.audio || []).map((t) => ({
      index: t.index, codec: t.codec, channels: t.channels, language: t.language, title: t.title,
    })),
  };

  if (local) {
    // On the LAN there is bandwidth to spare, so quality is never traded away.
    // The only question is whether the client can open the container.
    const codecsFine = v.browserSafe && (!a || a.browserSafe);
    const mp4ish = /mp4|mov|m4v/i.test(probe.container || "");
    // Direct play hands over the whole file, so the client picks its own track.
    // That's only acceptable when there's nothing to choose — otherwise a dub
    // request would silently get whichever track the container lists first,
    // and a hand-picked track would be ignored outright.
    const singleTrack = (probe.audio || []).length <= 1;
    if (codecsFine && mp4ish && singleTrack)
      return { ...common, mode: "direct", reason: `browser-safe codecs in an MP4 container${langNote}` };
    if (codecsFine)
      return { ...common, mode: "remux", reason: `repackaging ${probe.container} without re-encoding${audioMode ? `, ${audioMode} track` : ""}${langNote}` };
    // Codecs the client can't decode (HEVC, TrueHD, DTS). Video still gets
    // copied where possible — only the offending stream is converted.
    return {
      ...common,
      mode: "encode",
      reason: `LAN client but ${[!v.browserSafe && v.codec, a && !a.browserSafe && a.codec].filter(Boolean).join(" + ")} needs conversion${langNote}`,
      copyVideo: v.browserSafe,
      targetMbps: null, // no bitrate cap on the LAN
    };
  }

  // Remote: the constraint is the uplink, not the codec. Even a browser-safe
  // 80 Mbps remux has to come down to fit.
  const overBudget = probe.mbps == null || probe.mbps > targetMbps;
  const videoOk = v.browserSafe && !overBudget;
  if (videoOk && (!a || a.browserSafe)) {
    return { ...common, mode: "remux", reason: `already ${probe.mbps?.toFixed(1)} Mbps, under the ${targetMbps} Mbps remote budget${langNote}` };
  }
  // Convert ONLY the stream that needs it. An under-budget H.264 file whose
  // audio is AC-3 used to take the full-encode path here — a second lossy
  // generation on video that could have been copied bit-for-bit, purely
  // because the audio needed converting. When the video fits the budget it is
  // copied untouched and the bitrate cap applies to nothing; the cap matters
  // only when the video itself is what's oversized.
  return {
    ...common,
    mode: "encode",
    reason: videoOk
      ? `remote client: video copied, ${a?.codec || "audio"} needs conversion${langNote}`
      : `remote client: ${probe.mbps ? `${probe.mbps.toFixed(1)} Mbps` : "unknown bitrate"} → ${targetMbps} Mbps${langNote}`,
    copyVideo: videoOk,
    targetMbps: videoOk ? null : targetMbps,
  };
}

// Build the ffmpeg argument list for a plan. Separated out so the flags can be
// inspected in tests and printed in diagnostics — an ffmpeg command line is the
// single most useful thing to see when transcoding misbehaves.
export function ffmpegArgs({ input, outDir, plan, probe, seekSec = 0, forceSoftware = false }) {
  // -y and -nostdin are not cosmetic. ffmpeg ASKS before overwriting an
  // existing output, and the subtitle sidecars (sub-<index>.vtt, below) are
  // plain file outputs that a re-seek re-creates in the same directory. With no
  // terminal attached the prompt reads EOF and ffmpeg quits:
  //   File 'sub-2.vtt' already exists. Overwrite? [y/N] Not overwriting - exiting
  // …which kills the WHOLE session, video included, so a seek into an
  // already-watched episode simply stopped playback. -nostdin closes the door
  // on every other interactive prompt too, since nothing here can ever answer.
  const args = ["-hide_banner", "-loglevel", "warning", "-nostdin", "-y"];

  // DECODE IN SOFTWARE, ENCODE ON THE GPU.
  //
  // This deliberately does not use `-hwaccel qsv`. Hardware decode covers a
  // subset of codecs, and when the source falls outside it the failure is
  // brutal rather than graceful: measured on a real VC-1 remux, QSV decode
  // produced zero frames, so the encoder never opened and ffmpeg exited with
  // "Could not open encoder before EOF" — no picture at all, for a file that
  // software-decodes fine. Release files are exactly where odd codecs live
  // (VC-1, MPEG-2, 10-bit HEVC), so the compatible path is the right default.
  //
  // Little is lost: encoding is the expensive half and it still runs on the
  // GPU, which is what an N100 actually needs help with.
  // Reading straight from the debrid CDN rather than a local file is the normal
  // case — playback must not wait for a multi-gigabyte download. Over a film's
  // runtime a single dropped connection is close to certain, and without these
  // ffmpeg simply exits and the viewer's stream dies mid-scene.
  const inputOpts = [];
  if (/^https?:/i.test(input)) {
    inputOpts.push(
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_on_network_error", "1",
      "-reconnect_delay_max", "10",
      "-rw_timeout", "30000000", // 30s in microseconds: fail a wedged socket rather than hang forever
    );
  }
  // Seeking BEFORE -i is the fast path (keyframe seek, no decode of the skipped
  // portion), which is what makes scrubbing bearable on a big file. On an HTTP
  // source this becomes a range request, so it stays cheap.
  if (seekSec > 0) inputOpts.push("-ss", String(seekSec));
  args.push(...inputOpts, "-i", input);

  // Map exactly one video and one audio track. Without this ffmpeg picks
  // "best" by its own rules and a 5.1 release regularly comes out as the
  // director's-commentary stereo track.
  args.push("-map", "0:v:0");
  if (plan.audioIndex != null) args.push("-map", `0:${plan.audioIndex}`);
  else args.push("-map", "0:a:0?");

  if (plan.mode === "remux" || plan.copyVideo) {
    args.push("-c:v", "copy");
  } else {
    const enc = config.transcode.hwaccel === "qsv" && !forceSoftware ? "h264_qsv" : "libx264";
    const filters = [];
    // Spend the bitrate cap on 1080p, never on 2160p. A capped encode left at
    // 4K spreads the same bits over four times the pixels and the result is
    // mud; downscaled first, the identical budget looks dramatically better.
    // Scaling runs before the tonemap chain so the expensive zscale work
    // touches a quarter of the pixels. Uncapped (LAN) encodes keep the source
    // resolution — there the codec, not the bitrate, was the problem.
    if (plan.targetMbps && (probe.video?.height || 0) > 1080) filters.push("scale=-2:1080");
    // Tone-map HDR down for SDR clients. Without this the picture arrives grey
    // and desaturated — visibly worse than an SDR source of the same release.
    // Frames are in system memory (software decode), so this is a plain filter
    // chain with no hwdownload/hwupload round trip.
    if (probe.video?.hdr) {
      filters.push("zscale=t=linear:npl=100,tonemap=hable,zscale=t=bt709:m=bt709:r=tv,format=yuv420p");
    } else {
      args.push("-pix_fmt", "yuv420p"); // 10-bit sources must come down to 8-bit for H.264 baseline clients
    }
    if (filters.length) args.push("-vf", filters.join(","));
    args.push("-c:v", enc);
    if (plan.targetMbps) {
      const kbps = Math.round(plan.targetMbps * 1000);
      // A hard cap, not an average: the tunnel cares about peaks. bufsize at 2x
      // the rate keeps VBV from clamping so tightly that quality collapses on
      // motion.
      args.push("-b:v", `${kbps}k`, "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`);
    }
    // QSV presets barely move the encode cost — the heavy lifting is fixed-
    // function hardware — but veryfast measurably softens the picture at a
    // capped bitrate. medium (the encoder's own default) is the right trade.
    // libx264 keeps veryfast: there the preset IS the CPU cost, and the
    // software path only exists as a fallback the N100 can barely afford.
    if (enc === "h264_qsv") args.push("-preset", "medium", "-look_ahead", "0");
    else args.push("-preset", "veryfast", "-crf", "21");
  }

  // Audio: copy when the client can decode it, otherwise convert. 5.1 is
  // PRESERVED where the codec allows (E-AC3 carries it and browsers decode it),
  // rather than folded to stereo the way the debrid transcoder did.
  // AAC, always, and multichannel where the source is multichannel.
  //
  // This used to emit E-AC3 for anything above stereo, to "preserve 5.1 rather
  // than fold it down". Chrome cannot decode E-AC3 or AC-3 at all — verified in
  // the browser, MediaSource.isTypeSupported('audio/mp4; codecs="ec-3"') is
  // false — so that produced a stream with no playable audio. It broke dub
  // specifically and consistently: English tracks on these releases are 5.1
  // while the Japanese ones are 2.0, so sub took the stereo path and worked
  // while dub took the surround path and died.
  //
  // AAC carries 5.1 perfectly well and every target decodes it, so the channel
  // layout survives without betting on a codec the client has to license.
  const a = (probe.audio || []).find((t) => t.index === plan.audioIndex) || probe.audio?.[0];
  const ch = Math.min(6, a?.channels || 2);
  // Copy whenever the TRACK is decodable, including alongside a video encode —
  // re-encoding AAC to AAC at a similar rate only loses a generation. The one
  // exception is lossless FLAC under a bitrate-capped encode: several Mbps of
  // audio would crowd the video out of a small budget, so that converts.
  if (a?.browserSafe && !(plan.targetMbps && a.codec === "flac")) {
    args.push("-c:a", "copy");
  } else {
    args.push("-c:a", "aac", "-ac", String(ch), "-b:a", ch > 2 ? "384k" : "192k");
  }

  // Segment on a fixed cadence, via GOP SIZE rather than -force_key_frames.
  //
  // Without this ffmpeg can only cut where the source already has a keyframe,
  // which on a remux meant ~11s segments against a requested 4 — slow startup
  // and coarse seeking. The obvious tool, `-force_key_frames expr:...`, is
  // silently ignored by h264_qsv: measured on an 8s clip it produced a single
  // 8s segment, where `-g` produced the expected two 4s ones. Can't be done at
  // all when the video is copied — the GOP is whatever the release shipped.
  if (plan.mode === "encode" && !plan.copyVideo) {
    const fps = probe.video?.fps || 24;
    args.push("-g", String(Math.max(24, Math.round(fps * 4))));
  }

  // RELATIVE output names, with ffmpeg's cwd set to outDir by the caller.
  //
  // This is not cosmetic. `-hls_fmp4_init_filename` defaults to a bare
  // "init.mp4" that ffmpeg resolves against its PROCESS CWD, not against the
  // playlist path — so with absolute playlist/segment paths the init segment
  // silently landed in the repo root instead of the session directory. The
  // playlist still advertised `#EXT-X-MAP:URI="init.mp4"`, the file was never
  // where the route looked for it, and every fragment load timed out: an fMP4
  // stream is unplayable without its init segment. Worse, every session wrote
  // to that same one path, so concurrent viewers clobbered each other.
  args.push(
    "-f", "hls",
    "-hls_time", "4",
    "-hls_playlist_type", "event", // grows as segments appear; seekable as it goes
    "-hls_flags", "independent_segments+append_list",
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", "seg-%05d.m4s",
    "index.m3u8",
  );

  // Embedded TEXT subtitles ride along as sidecar WebVTT files. This is what
  // makes anime sub mode watchable from a release file: fansub subtitles live
  // INSIDE the mkv, and mapping only video+audio silently threw them away
  // while the UI claimed English was burned in (true of the old scraper
  // streams, never of release files). Each track becomes sub-<index>.vtt in
  // the session dir, timed from the session's own start (-ss precedes -i, so
  // every output shares the origin), which is exactly the media element's
  // clock. Bitmap subs (PGS/VobSub) can't become text and are skipped — that
  // would need OCR or a burn-in, not a remux.
  //
  // The subtitles demux from a SECOND -i of the same source, not from input 0.
  // Sharing one demuxer looks obviously right (the file is read once) and is
  // how this used to work — and on current ffmpeg builds it silently DESTROYS
  // the HLS audio. Measured on a real release (h264 copy + eac3→aac + two ASS
  // subs, ffmpeg N-124716): with the vtt outputs fed from input 0, segment 0
  // carried 4 s of video and TWO audio frames, every later segment carried
  // none, and ffmpeg exited 0 with an empty stderr — the sparse subtitle
  // stream backpressures the threaded scheduler's shared pipeline and the
  // audio encoder simply starves. The same command with the subs on their own
  // input produces full audio (185 frames in segment 0) and identical VTTs.
  // The price is a second read of the source; it is only paid when text subs
  // exist, and a stream nobody can hear is not a lower price.
  //
  // `-flush_packets 1` is load-bearing, not tuning. The WebVTT muxer buffers
  // and writes on close, so on a full episode the sidecar did not EXIST until
  // ffmpeg exited — measured live on a 24-minute release: segments streaming,
  // sub-3.vtt absent for minutes, and the player asking for a file that wasn't
  // there yet. Flushing per packet makes each cue land as it is produced, which
  // is what lets subtitles start with the picture instead of after the encode.
  const subs = textSubs(probe);
  if (subs.length) {
    args.push(...inputOpts, "-i", input);
    for (const s of subs) {
      args.push("-map", `1:${s.index}`, "-c:s", "webvtt", "-flush_packets", "1", `sub-${s.index}.vtt`);
    }
  }
  return args;
}

// The subtitle streams a session can carry as text. Capped: a release with 20
// language tracks would otherwise spawn 20 extra outputs for languages nobody
// here reads.
const TEXT_SUB_CODECS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"]);
export function textSubs(probe) {
  return (probe?.subtitles || []).filter((s) => TEXT_SUB_CODECS.has(s.codec)).slice(0, 8);
}

export class TranscodeError extends Error {}

// Start (or reuse) a session for one file+plan combination. Sessions are keyed
// so two viewers watching the same thing the same way share one encoder — an
// N100 cannot afford to run the same encode twice.
export async function startSession({ filePath, cacheKey, identity, local, seekSec = 0, expectedBytes = 0, mode = null, audioIndex = null }) {
  if (!config.transcode.enabled) throw new TranscodeError("transcoding is disabled");

  const probe = await probeFile(filePath, { expectedBytes });
  const plan = planDelivery(probe, { local, mode, audioIndex });
  if (plan.mode === "direct") return { mode: "direct", plan, probe };

  // Identity must be STABLE across requests, which rules out the input path:
  // a debrid link carries a freshly-minted token every time it is unrestricted,
  // so hashing it would mint a new encoder per request and exhaust the session
  // cap within a few page loads. `identity` is the release's cache key, which
  // names the same file however its URL was spelled today.
  //
  // The audio index belongs in it too: two viewers watching one file in
  // different languages need different encoders, and collapsing them would
  // hand the second viewer the first one's track.
  const keyBase = `${identity || filePath}|${plan.mode}|${plan.targetMbps ?? "x"}|${plan.audioIndex ?? "x"}`;
  return openSession({ input: filePath, keyBase, plan, probe, cacheKey, seekSec });
}

// Same file, same plan, new start point — the fast path behind the player's
// seek-anywhere. A scrub outside the transcoded window must not re-resolve
// providers or re-probe the file (that is seconds, plus Real-Debrid calls);
// the running session already knows everything except where to start.
//
// The ancestor is retired FIRST: a jump is the same viewer abandoning that
// timeline, and freeing its slot is what lets consecutive scrubs work at all
// on a 2-session cap. Only the exact ancestor — a blanket "stop every sibling"
// would let a second viewer starting the same episode kill the first one's
// live encoder.
//
// Returns null when the session is gone (reaped after idling) — the caller
// then falls back to a full stream request.
export async function reseekSession(id, seekSec = 0) {
  const s = sessions.get(id);
  if (!s) return null;
  if (Math.floor(seekSec) === Math.floor(s.seekSec)) { s.lastReadAt = Date.now(); return s; }
  await stopSession(id);
  return openSession({ input: s.input, keyBase: s.keyBase, plan: s.plan, probe: s.probe, cacheKey: s.cacheKey, seekSec });
}

// Remove every session directory on disk that this process doesn't own.
//
// Session ids are DETERMINISTIC (same file, same plan, same seek → same id), so
// a directory left behind by a killed process is exactly where the next play of
// that episode will write — and ffmpeg's append_list flag then APPENDS a whole
// second encode after the stale one, overwriting init.mp4 on the way. Seen
// live: a play appended 358 fresh segments after 358 leftovers from a
// force-killed server, producing a 48-minute playlist whose first half no
// longer matched its init segment, and the player hung on segment 0 forever.
// A fresh process owns no sessions by definition, so at boot everything on
// disk is garbage; sweep it all.
export async function sweepSessionRoot(root = SESSION_ROOT) {
  let names = [];
  try { names = await fsp.readdir(root); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (sessions.has(name)) continue; // owned by this process — a live encoder
    await fsp.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
    removed++;
  }
  if (removed) console.log(`  [transcode] swept ${removed} stale session dir(s)`);
  return removed;
}

async function openSession({ input, keyBase, plan, probe, cacheKey, seekSec = 0 }) {
  const id = crypto.createHash("sha1")
    .update(`${keyBase}|${Math.floor(seekSec)}`)
    .digest("hex").slice(0, 16);

  const existing = sessions.get(id);
  if (existing) { existing.lastReadAt = Date.now(); return existing; }

  // At capacity: reclaim an ABANDONED session before refusing.
  //
  // The reaper alone is not enough. It clears sessions after 60s idle, but the
  // cap is small (an N100 does not run many 1080p encodes), so a single viewer
  // switching episode — or toggling sub/dub, which is a second encoder by
  // design — fills both slots and then gets "transcoder busy" for a minute.
  // Observed live: a play returned 502 purely because two finished sessions
  // were still cooling off.
  //
  // A session nobody has read from in ~10s has no viewer attached: the player
  // pulls segments continuously while watching. Those are reclaimed oldest
  // first. If every session IS being actively read, the box genuinely is full
  // and refusing is correct — the caller degrades to a floor-tier stream.
  if (sessions.size >= config.transcode.maxSessions) {
    const ABANDONED_MS = 10_000;
    const stale = [...sessions.values()]
      .filter((s) => Date.now() - s.lastReadAt > ABANDONED_MS)
      .sort((a, b) => a.lastReadAt - b.lastReadAt)[0];
    if (stale) await stopSession(stale.id);
  }
  if (sessions.size >= config.transcode.maxSessions) {
    throw new TranscodeError(`transcoder busy (${sessions.size}/${config.transcode.maxSessions} sessions in active use)`);
  }

  const outDir = path.join(SESSION_ROOT, id);
  // Not in `sessions`, so anything already at this path is a dead process's
  // leftovers — never append to it (see sweepSessionRoot for what that does).
  await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(outDir, { recursive: true });

  const session = {
    // input/keyBase/seekSec are retained for reseekSession: a seek restarts
    // this exact file and plan at a new offset without re-resolving anything.
    id, keyBase, input, seekSec, mode: plan.mode, plan, probe, outDir, cacheKey,
    startedAt: Date.now(), lastReadAt: Date.now(), stderr: "", softwareFallback: false,
  };

  const spawnFfmpeg = (forceSoftware) => {
    const args = ffmpegArgs({ input, outDir, plan, probe, seekSec, forceSoftware });
    // cwd is the session dir so ffmpeg's relative output names — including the
    // fMP4 init segment, which ignores the playlist path — land beside the
    // playlist rather than in the process's working directory.
    const proc = spawn(config.transcode.ffmpeg, args, { cwd: outDir, stdio: ["ignore", "ignore", "pipe"] });
    session.proc = proc;
    session.stderr = "";
    proc.stderr.on("data", (d) => {
      // Keep only the tail: ffmpeg is chatty and a stuck session shouldn't grow
      // unbounded in memory, but the last few KB are what diagnose a failure.
      session.stderr = (session.stderr + d.toString()).slice(-4096);
    });
    proc.on("exit", (code) => {
      if (!code) { session.exited = true; session.exitCode = 0; return; }
      // QSV can refuse a stream it nominally supports (odd profiles, 10-bit
      // variants, unusual resolutions) and the symptom is a dead session, not a
      // degraded one. Retry once in software rather than hand the viewer a
      // failure: a soft-encoded picture beats no picture, even on an N100.
      if (!forceSoftware && /qsv|encoder|Invalid argument|no packets/i.test(session.stderr)) {
        console.warn(`  [transcode] ${id}: QSV failed, retrying in software — ${session.stderr.slice(-200)}`);
        session.softwareFallback = true;
        spawnFfmpeg(true);
        return;
      }
      session.exited = true;
      session.exitCode = code;
      console.warn(`  [transcode] ${id} exited ${code}: ${session.stderr.slice(-400)}`);
    });
    return proc;
  };
  spawnFfmpeg(false);

  if (cacheKey) store.acquire(cacheKey); // pin the source against eviction
  sessions.set(id, session);
  return session;
}

export function touch(id) {
  const s = sessions.get(id);
  if (s) s.lastReadAt = Date.now();
  return s || null;
}

export const getSession = (id) => sessions.get(id) || null;

export async function stopSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { s.proc.kill("SIGKILL"); } catch {}
  if (s.cacheKey) store.release(s.cacheKey);
  try { await fsp.rm(s.outDir, { recursive: true, force: true }); } catch {}
}

// Reap sessions nobody is reading any more.
//
// This is not housekeeping, it's load-bearing: a leaked ffmpeg keeps a CPU core
// saturated forever, and on a 4-core N100 two leaks are the whole box. The
// player stops requesting segments the moment a viewer closes the tab, so
// "nothing read recently" is a reliable signal that the session is dead.
let reaper = null;
export function startReaper() {
  if (reaper) return;
  reaper = setInterval(() => {
    const cutoff = Date.now() - config.transcode.idleTimeoutMs;
    for (const s of [...sessions.values()]) {
      if (s.lastReadAt < cutoff || (s.exited && s.exitCode)) stopSession(s.id);
    }
  }, 15_000);
  reaper.unref?.();
}

export async function stopAll() {
  for (const id of [...sessions.keys()]) await stopSession(id);
  if (reaper) { clearInterval(reaper); reaper = null; }
}
