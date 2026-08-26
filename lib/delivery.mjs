// Delivery — turns a release file into something a specific client can play.
//
// This is where the rebuild's central trade lives. A `type: "file"` stream from
// the quality tier is the ORIGINAL release: an .mkv remux with TrueHD 7.1, say,
// which no browser can open and no residential uplink can carry. Rather than
// picking a worse release to avoid that (what the old ranker did), the file is
// pulled to the array once and adapted per viewer:
//
//   LAN    → the original bytes, or a lossless remux. Full quality.
//   remote → a QuickSync encode capped to fit the tunnel.
//
// One file, two experiences. It's the same thing Jellyfin does, which is why
// Jellyfin feels fine through the same Cloudflare tunnel that struggles with
// raw remuxes served straight through.
import * as store from "./cache/store.mjs";
import * as fetcher from "./cache/fetcher.mjs";
import * as transcode from "./transcode/session.mjs";
import { signMediaToken } from "./security.mjs";

// A stream the player can use right now, given a release file.
//
// Returns one of:
//   { kind: "hls", playUrl }        — a live transcode/remux session
//   { kind: "file", playUrl }       — direct local playback, no ffmpeg
//   { kind: "pending", progress }   — still fetching; caller keeps the floor stream
//   { kind: "unavailable", error }  — nothing doable; caller falls back
// `mode` is the LANGUAGE preference and is anime-specific ("sub" = Japanese,
// "dub" = English). It defaults to null — no preference — because films and
// live-action TV have no such concept: their audio is simply the film's audio.
// Defaulting it to "sub" made every movie request a JAPANESE track, which
// worked only by accident (no match, so it fell through to best-by-channels)
// and would have picked the Japanese dub of an English film that happened to
// ship one.
// `audioIndex` pins one of the file's own audio streams — the language selector
// for films and TV, where the tracks are only knowable after the file is
// probed. null means "pick on merit" (plus `mode`, for anime).
// `maxHeight` is the viewer's resolution dial (null = let the planner decide).
// It rides all the way down to planDelivery because it can change the DELIVERY
// KIND, not just an encoder flag: a file that would have been remuxed
// losslessly has to be encoded once someone asks for a smaller picture.
export async function deliver(stream, { local = false, seekSec = 0, title = null, mode = null, audioIndex = null, maxHeight = null } = {}) {
  if (!stream?.url) return { kind: "unavailable", error: "no source url" };

  const key = store.cacheKey({
    provider: stream.provider || stream.backend || "debrid",
    release: stream.release || stream.serverName || stream.filename || stream.url,
    episode: stream.episode ?? null,
  });

  const expectedBytes = Number(stream.filesize) || 0;

  // PLAYBACK NEVER WAITS FOR A DOWNLOAD.
  //
  // An earlier version of this required the whole release on disk before
  // anything would play, which turned a working service into a 6-minute
  // progress bar for a 7 GB remux. That was wrong, and unnecessary: the debrid
  // link is an ordinary HTTP source with range support, so ffmpeg reads it in
  // place. Measured against a live RD link on a 7 GB BD remux — ffprobe 1.7s
  // (header only), first HLS segment 3.4s, and the encoder then runs ~6x
  // realtime, so it outruns playback comfortably.
  //
  // The cache is therefore an OPTIMISATION, not a precondition: a cached copy
  // is used when present (better seeking, immune to link expiry), and its
  // absence costs a few seconds of startup rather than the whole play.
  const cached = store.lookup(key);
  const source = cached?.state === "complete" ? cached.path : stream.url;
  const fromCache = source !== stream.url;

  return session(source, key, {
    local, seekSec, mode, audioIndex, maxHeight, fromCache,
    expectedBytes: fromCache ? cached.bytes : expectedBytes,
    remoteUrl: stream.url,
  });
}

async function session(filePath, key, { local, seekSec, expectedBytes = 0, mode = null, audioIndex = null, maxHeight = null, fromCache = false, remoteUrl = null }) {
  try {
    const s = await transcode.startSession({
      filePath, identity: key, cacheKey: fromCache ? key : null,
      local, seekSec, expectedBytes, mode, audioIndex, maxHeight,
    });
    if (s.mode === "direct") {
      // Nothing needs doing to this file — the client can read it as it is.
      // Cached copies are served from disk; an uncached one is just the debrid
      // link, which the browser fetches straight from their CDN. That second
      // case is the cheapest playback path in the whole system: no ffmpeg, no
      // download, no bytes through this box at all.
      return {
        kind: "file",
        key,
        playUrl: fromCache
          ? `/media/file/${encodeURIComponent(key)}?t=${signMediaToken(key)}`
          : remoteUrl,
        directRemote: !fromCache,
        plan: s.plan,
        probe: s.probe,
      };
    }
    return {
      kind: "hls",
      key,
      sessionId: s.id,
      playUrl: `/media/hls/${s.id}/index.m3u8?t=${signMediaToken(s.id)}`,
      mode: s.mode,
      plan: s.plan,
      probe: s.probe,
    };
  } catch (e) {
    // Transcoder busy or unavailable. Deliberately not fatal — the caller still
    // has the floor-tier stream, and a working lower-quality picture beats an
    // error dialog.
    return { kind: "unavailable", error: e.message, key };
  }
}

// Progress of an in-flight upgrade, for the client's poll.
export function upgradeStatus(key) {
  const p = fetcher.progressOf(key);
  if (!p) return null;
  return { ...p, ready: fetcher.readyToPlay(key) };
}

export { store, fetcher, transcode };
