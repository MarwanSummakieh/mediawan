// Real-Debrid client — turns a torrent magnet into a browser-playable stream.
//
// This is the "stable service" backend: instead of scraping a site that fights
// back, we hand a magnet to Real-Debrid, which (for anything popular) already
// has it cached and hands back a direct HTTPS link. RD can also transcode the
// file to HLS on the fly, which solves the .mkv-in-a-browser problem for free.
//
// The token lives ONLY in the environment (REAL_DEBRID_TOKEN in .env, gitignored)
// — never in code or git. When it's absent the whole debrid layer is simply
// disabled and the app falls back to the scraper providers.
//
// Flow: addMagnet → selectFiles(video) → poll info (cached ⇒ ready in seconds)
//       → unrestrict → transcode to HLS. If a torrent isn't cached we give up
//       fast and let the caller try the next candidate rather than block a user
//       on a live download.
import { pickVideoFile } from "../match-release.mjs";
import { topLevelBoxes, audioIsBrowserSafe } from "../mp4.mjs";

const API = "https://api.real-debrid.com/rest/1.0";
const TOKEN = process.env.REAL_DEBRID_TOKEN || "";
// Video containers we're willing to stream (skip samples/extras by size later).
const VIDEO_RE = /\.(mkv|mp4|avi|m4v|mov|webm)$/i;

export function debridEnabled() {
  return Boolean(TOKEN);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// RD rate-limits the torrent endpoints well below its documented 250/min: a
// play's resolve burst (several candidates × addMagnet/info/select/delete)
// plus the quality-menu probing can trip 429s, which then make perfectly
// cached releases look like failures. Two guards:
//   • pace call STARTS ~250 ms apart (≤ ~240/min across the whole process)
//   • retry a 429 up to twice with a short backoff before giving up
let nextSlot = 0;
// Adaptive: widened when RD actually complains, so the rest of the process stops
// walking into the same wall. Never narrows again within a process — the limit
// is per-account and short-lived bursts are exactly what trips it.
let slotMs = 250;
async function paced() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + slotMs;
  if (wait) await sleep(wait);
}

// A rate limit is NOT a verdict on the release.
//
// RD signals it with `error_code: 34` ("too_many_requests") in the BODY, and not
// always with HTTP 429 — so the body is the reliable signal. Read as a per-
// release failure it is catastrophic: a resolve burst trips the limit, every
// remaining candidate then fails in ~200ms, and the play reports "no playable
// sources" for an episode whose releases are sitting in the cache. Measured on
// "Smoking Behind the Supermarket with You" ep 1 — 8 of 22 candidates were
// accepted on a paced retry, while an unpaced burst had 11 of them rejected
// with code 34.
const isRateLimited = (status, json) => status === 429 || json?.error_code === 34;

async function rd(path, { method = "GET", form } = {}) {
  const opts = { method, headers: { Authorization: `Bearer ${TOKEN}` } };
  if (form) {
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.body = new URLSearchParams(form).toString();
  }
  for (let attempt = 0; ; attempt++) {
    await paced();
    let res;
    try {
      res = await fetch(`${API}${path}`, { ...opts, signal: AbortSignal.timeout(20000) });
    } catch (e) {
      // A request that never completed: DNS, connection reset, TLS, timeout.
      // Node reports every one of them as a bare "fetch failed", which then
      // surfaced to the user as an unreadable error against a release that was
      // never actually the problem. These are transient by nature, so retry —
      // and if it still won't go through, say what actually happened.
      if (attempt < 2) { await sleep(600 * (attempt + 1)); continue; }
      const cause = e.cause?.code || (e.name === "TimeoutError" ? "timed out" : e.message);
      const err = new Error(`network unreachable (${cause}) — the service, not this release`);
      err.network = true;
      throw err;
    }
    if (res.status === 204) return {};
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    // Rate limited: back off and retry the SAME call, and slow every later call
    // in this process. Checked before res.ok because the code arrives in the
    // body — see isRateLimited.
    if (isRateLimited(res.status, json) && attempt < 4) {
      slotMs = Math.min(1500, Math.round(slotMs * 1.7));
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok || json?.error_code) {
      const err = new Error(`RD ${path} → ${res.status} ${json?.error || text.slice(0, 120)}`);
      err.status = res.status;
      err.code = json?.error_code;
      throw err;
    }
    return json ?? {};
  }
}

export async function userInfo() {
  return rd("/user");
}

// Add a magnet, select its video file(s), and wait briefly for RD to report it
// downloaded (i.e. cache-hit). Returns the torrent info once ready, or throws
// "not cached" if it's still downloading after the timeout.
async function prepareTorrent(magnet, { waitMs = 12000, metaTries = 6, fileIdx = null, want = null } = {}) {
  const { id } = await rd("/torrents/addMagnet", { method: "POST", form: { magnet } });
  try {
    // Need the file list before we can select; it appears once metadata resolves.
    // `metaTries` bounds this wait — the anime fallback keeps it short so an
    // uncached torrent is abandoned quickly instead of hanging the play.
    let info = await rd(`/torrents/info/${id}`);
    for (let i = 0; i < metaTries && (!info.files || !info.files.length); i++) {
      await sleep(700);
      info = await rd(`/torrents/info/${id}`);
    }
    // No file list at all after the wait means the MAGNET's metadata hasn't
    // resolved — the signature of a torrent RD doesn't have and is only now
    // seeing, i.e. exactly "not cached". It used to fall through to the video
    // check below and throw "no video file in torrent", which is NOT a
    // skippable error, so a brand-new episode (magnet minutes old, metadata
    // still spreading) escalated a routine miss into a provider fault.
    if (!info.files?.length) throw new Error("not cached (magnet metadata still resolving)");
    const videos = info.files.filter((f) => VIDEO_RE.test(f.path));
    if (!videos.length) throw new Error("no video file in torrent");
    // Which file? `want` ({ title, year, season, episode }) makes this a real
    // decision instead of a guess: pickVideoFile treats fileIdx as a hint and
    // the FILENAME as the evidence. Compilation packs — 66 unrelated films in
    // one torrent, ranked high on seeders — used to resolve to their largest
    // video, so a request for one film happily played another. If nothing in
    // the torrent looks like what was asked for, refuse: "not cached" is the
    // caller's signal to try the next release, which is exactly right here.
    const pick = want
      ? pickVideoFile(info.files || [], { ...want, fileIdx })
      : (fileIdx != null && VIDEO_RE.test((info.files || []).find((f) => f.id === fileIdx + 1)?.path || "")
          ? (info.files || []).find((f) => f.id === fileIdx + 1)
          : videos.sort((a, b) => b.bytes - a.bytes)[0]);
    if (!pick) throw new Error("not cached (no file in this release matches the request)");
    await rd(`/torrents/selectFiles/${id}`, { method: "POST", form: { files: String(pick.id) } });

    const deadline = Date.now() + waitMs;
    for (;;) {
      info = await rd(`/torrents/info/${id}`);
      if (info.status === "downloaded" && info.links?.length) return { id, info };
      if (["magnet_error", "error", "virus", "dead"].includes(info.status))
        throw new Error(`torrent ${info.status}`);
      if (Date.now() > deadline) throw new Error("not cached (still downloading)");
      await sleep(1500);
    }
  } catch (e) {
    // Don't leave a failed/uncached torrent cluttering the account.
    remove(id).catch(() => {});
    throw e;
  }
}

export async function remove(torrentId) {
  return rd(`/torrents/delete/${torrentId}`, { method: "DELETE" }).catch(() => {});
}

// Ask Real-Debrid to FETCH a release it hasn't got cached, and keep it.
//
// Everything above gives up when a torrent isn't already cached, because
// waiting blocks a play. That was the whole answer while the app had a second
// tier to fall back on — it doesn't. With Real-Debrid as the only backend,
// "none of the 12 releases we tried are cached" is a dead end for a title RD
// would happily download in a couple of minutes.
//
// So this adds the magnet, selects the right file, and returns immediately with
// a handle to poll. Crucially it does NOT delete on the way out: the download
// has to survive the request that started it.
export async function startDownload(magnet, { metaTries = 8, fileIdx = null, want = null } = {}) {
  const { id } = await rd("/torrents/addMagnet", { method: "POST", form: { magnet } });
  try {
    let info = await rd(`/torrents/info/${id}`);
    for (let i = 0; i < metaTries && (!info.files || !info.files.length); i++) {
      await sleep(700);
      info = await rd(`/torrents/info/${id}`);
    }
    // The file list can legitimately still be empty here: this path exists FOR
    // uncached torrents, and the newest of those (an episode that aired an hour
    // ago) may not have its magnet metadata spread yet. That is not a reason to
    // fail the fetch — select everything and let downloadStatus pick the video
    // once RD knows the files. The precise want-driven pick below still runs
    // whenever the metadata arrived in time.
    if (!info.files?.length) {
      if (["magnet_error", "error", "virus", "dead"].includes(info.status))
        throw new Error(`torrent ${info.status}`);
      await rd(`/torrents/selectFiles/${id}`, { method: "POST", form: { files: "all" } })
        .catch(() => {}); // too early to select — downloadStatus retries it
      return { torrentId: id, filename: null, bytes: null };
    }
    const videos = info.files.filter((f) => VIDEO_RE.test(f.path));
    if (!videos.length) throw new Error("no video file in torrent");
    const pick = want
      ? pickVideoFile(info.files, { ...want, fileIdx })
      : videos.sort((a, b) => b.bytes - a.bytes)[0];
    if (!pick) throw new Error("no file in this release matches the request");
    await rd(`/torrents/selectFiles/${id}`, { method: "POST", form: { files: String(pick.id) } });
    return { torrentId: id, filename: pick.path.split("/").pop(), bytes: pick.bytes };
  } catch (e) {
    remove(id).catch(() => {}); // couldn't even start — don't leave it behind
    throw e;
  }
}

// Poll a download started above. Returns { status, progress, ready, stream }.
// `stream` appears once RD has the file and it has been unrestricted.
export async function downloadStatus(torrentId) {
  let info = await rd(`/torrents/info/${torrentId}`);
  // A download whose magnet metadata arrived AFTER startDownload returned is
  // parked on waiting_files_selection — nothing progresses until files are
  // chosen, and the caller that knew what it wanted is long gone. Select
  // everything: for the single-file episodes this path exists for that IS the
  // right file, and toStream below picks the largest video when it isn't.
  if (info.status === "waiting_files_selection") {
    await rd(`/torrents/selectFiles/${torrentId}`, { method: "POST", form: { files: "all" } })
      .catch(() => {});
    info = await rd(`/torrents/info/${torrentId}`);
  }
  const state = {
    status: info.status,
    progress: Number(info.progress) || 0,
    speed: Number(info.speed) || 0,
    seeders: Number(info.seeders) || 0,
    filename: info.filename,
    ready: false,
    stream: null,
  };
  if (["magnet_error", "error", "virus", "dead"].includes(info.status)) {
    state.failed = `torrent ${info.status}`;
    return state;
  }
  if (info.status === "downloaded" && info.links?.length) {
    // links[] parallels the SELECTED files in order. With one selected file
    // (the usual case) that's links[0]; with several — the select-all path —
    // take the link of the largest selected video rather than whatever
    // happened to sort first.
    let link = info.links[0];
    if (info.links.length > 1 && Array.isArray(info.files)) {
      const selected = info.files.filter((f) => f.selected);
      const best = selected
        .map((f, i) => ({ f, i }))
        .filter((x) => VIDEO_RE.test(x.f.path || ""))
        .sort((a, b) => (b.f.bytes || 0) - (a.f.bytes || 0))[0];
      if (best && info.links[best.i]) link = info.links[best.i];
    }
    const s = await toStream(link);
    state.ready = true;
    state.stream = {
      url: s.directUrl,
      type: "file",
      referer: "https://real-debrid.com/",
      filename: s.filename,
      filesize: s.filesize,
      torrentId,
    };
  }
  return state;
}

// Can a browser play this file as it is? An H.264 MP4 is the one combination
// every target here decodes natively — desktop browsers and the Tizen webview
// alike. HEVC is deliberately excluded: TVs manage it, desktop Chrome largely
// does not, and this decision has to hold for both.
export function playsNatively(filename, mimeType) {
  const name = String(filename || "");
  if (!/\.(mp4|m4v)$/i.test(name)) return false;          // mkv/avi need remuxing
  if (/\b(x265|h\.?265|hevc)\b/i.test(name)) return false; // not safe on desktop
  return !mimeType || /mp4|mpeg4|octet-stream/i.test(mimeType);
}

// Unrestrict a hoster link into a direct download, and transcode to HLS ONLY
// when the file needs it.
//
// RD's `apple` HLS is generated live, and asking for it costs a round trip plus
// however long RD takes to spin its transcoder up — the startup lag you feel
// before a film begins. For an H.264 MP4 that buys nothing: the browser can
// play the original bytes at full CDN speed, and seeking becomes a byte-range
// request instead of hunting through segments. So the transcode is now reserved
// for containers that genuinely need it (mkv, avi), which is where it earns
// its cost.
// The filename says an MP4 could stream directly; only the FILE says whether it
// actually can. Read a small prefix and check the layout — an MP4 whose `moov`
// index sits after its `mdat` payload plays fine locally and stutters horribly
// over HTTP — and the audio codec, since AC3/DTS are common in releases and no
// browser decodes them. Unknown answers fall back to remuxing, which always
// works. A few KB per resolve, and only for files that got this far.
async function canStreamDirectly(url) {
  const range = async (from, to, ms) => {
    const r = await fetch(url, { headers: { Range: `bytes=${from}-${to}` }, signal: AbortSignal.timeout(ms) });
    if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };
  try {
    // Two small reads instead of one big one. Pulling 256 KB up front timed out
    // on a cold CDN link and cost us the direct path on files that deserved it.
    // Box ORDER is decidable from the first few headers, and only if the file
    // passes that do we fetch the index itself to inspect the audio codec —
    // and we know exactly how long it is, because the box header says so.
    const head = await range(0, 16383, 15000);
    const boxes = topLevelBoxes(head);
    const moov = boxes.find((b) => b.type === "moov");
    const mdat = boxes.find((b) => b.type === "mdat");
    if (!moov || (mdat && mdat.offset < moov.offset))
      return { ok: false, why: "moov is not at the front (not faststart)" };

    let buf = head;
    const end = moov.offset + Math.min(moov.size, 8 * 1024 * 1024); // cap: some indexes are huge
    if (end > head.length) buf = await range(moov.offset, end - 1, 20000);
    const audio = audioIsBrowserSafe(buf);
    if (audio === false) return { ok: false, why: "audio codec a browser can't decode" };
    if (audio === null) return { ok: false, why: "audio codec undetermined" };
    return { ok: true, why: "faststart with browser-safe audio" };
  } catch (e) {
    return { ok: false, why: `probe failed: ${e.message}` };
  }
}

// Unrestrict any supported link (torrent file link OR a video-host link) into a
// direct download. This is Real-Debrid's original product and it's used by two
// callers: the torrent path below, and any hoster link a future source yields;
// (streamtape, mixdrop, vidoza…) are among the ~140 RD supports.
export async function unrestrictLink(link) {
  const un = await rd("/unrestrict/link", { method: "POST", form: { link } });
  return {
    id: un.id,
    url: un.download,
    filename: un.filename,
    mimeType: un.mimeType || "",
    filesize: un.filesize,
  };
}

// The hosts RD can unrestrict, as a Set of bare hostnames. Fetched once and
// memoised by the caller — this list changes about as often as RD adds a host.
export async function supportedHosts() {
  const j = await rd("/hosts");
  return new Set(Object.keys(j || {}));
}

// Turn an unrestricted link into something playable.
//
// This used to hand anything the browser couldn't decode natively to RD's
// /streaming/transcode. That single decision is what capped this app's quality:
// RD's transcoder RE-ENCODES rather than remuxes — measured on a 5.29 GB
// Interstellar file, 4.2 Mbit/s in, 2.4 Mbit/s out, with the surround track
// folded to stereo — and because avoiding it was worth so much, the release
// ranker learned to prefer small H.264 MP4s, i.e. exactly the re-encodes this
// rebuild exists to stop serving.
//
// Transcoding is local now (lib/transcode/), so the right move is to always
// take the ORIGINAL bytes and let our own pipeline remux or downscale per
// client. RD's transcoder survives only as the degraded path for when local
// transcoding is switched off or unavailable — a correctness fallback, not a
// design choice.
async function toStream(link, { allowRemoteTranscode = false } = {}) {
  const un = await unrestrictLink(link);

  if (!allowRemoteTranscode) {
    return { directUrl: un.url, filename: un.filename, mimeType: un.mimeType, hlsUrl: null, filesize: un.filesize };
  }

  // Degraded path: no local transcoder, so a container the browser can't open
  // has to be re-encoded upstream or it won't play at all.
  let native = playsNatively(un.filename, un.mimeType);
  if (native) {
    const verdict = await canStreamDirectly(un.url);
    native = verdict.ok;
    if (!verdict.ok) console.warn(`  [debrid] remuxing ${String(un.filename).slice(0, 50)} — ${verdict.why}`);
  }
  let hls = null;
  if (!native) {
    try {
      const t = await rd(`/streaming/transcode/${un.id}`);
      // RD returns { apple:{full,'1080',...}, dash, liveMP4, h264WebM }. Prefer the
      // highest apple/HLS variant; the keys are quality labels or "full".
      const apple = t.apple || {};
      hls = apple.full || Object.values(apple)[0] || null;
    } catch {} // transcode unavailable → fall back to the direct file below
  }
  return { directUrl: un.url, filename: un.filename, mimeType: un.mimeType, hlsUrl: hls, native, filesize: un.filesize };
}

// A candidate is unusable-but-skippable — try the next release rather than
// treating it as an outage. Three ways that happens:
//   • not cached (or no file in it matched the request)
//   • 451, the hash blocked for a takedown
//   • unrestrict answers "infringing_file" (error_code 35). Seen live: the
//     torrent IS cached and prepares fine, then unrestrict refuses the link.
//     That used to escape as a thrown API error, so a blocked release got
//     counted as a service fault and could push the whole play to
//     "debrid-error" while perfectly good releases sat further down the list.
const skippable = (e) =>
  /not cached/.test(e.message) || e.status === 451 ||
  e.code === 35 || /infringing_file/i.test(e.message);

// WHICH kind of skip, for the caller's failure note. "Blocked" and "not cached"
// are the same control flow (try the next candidate) but completely different
// news for the viewer — blocked means no amount of waiting helps and another
// release is the answer, uncached means this one just isn't fetched yet. They
// were reported identically, so an episode whose every release had been taken
// down claimed to be merely uncached.
export const skipReason = (e) =>
  (e?.status === 451 || e?.code === 35 || /infringing/i.test(e?.message || "")) ? "blocked" : "uncached";

// Public entry point: magnet → { url, type, referer, filename }.
// Returns null when this torrent can't be served (uncached or DMCA-blocked) so
// the caller can try the next candidate; throws only on unexpected failures.
export async function streamFromMagnet(magnet, opts = {}) {
  let prepared;
  try {
    prepared = await prepareTorrent(magnet, opts); // opts: { waitMs, metaTries, fileIdx, want }
  } catch (e) {
    if (skippable(e)) { opts.onSkip?.(skipReason(e)); return null; }
    throw e;
  }
  const { id, info } = prepared;
  try {
    const s = await toStream(info.links[0], { allowRemoteTranscode: opts.allowRemoteTranscode === true });
    // The original bytes, whatever container they're in. `type: "file"` says
    // "this is a release file, not a browser-ready stream" — the delivery layer
    // reads it and decides between direct play, local remux and a capped local
    // encode. Only the degraded path (no local transcoder) yields RD's HLS.
    if (s.hlsUrl) return { url: s.hlsUrl, type: "hls", referer: "https://real-debrid.com/", filename: s.filename, torrentId: id };
    return {
      url: s.directUrl,
      type: "file",
      referer: "https://real-debrid.com/",
      filename: s.filename,
      filesize: s.filesize,
      torrentId: id,
    };
  } catch (e) {
    remove(id).catch(() => {}); // don't leave a torrent we couldn't stream
    if (skippable(e)) { opts.onSkip?.(skipReason(e)); return null; }
    throw e;
  }
}
