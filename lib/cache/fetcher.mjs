// Pull a release file from the debrid CDN onto the array.
//
// Sequential and resumable. Playback streams the remote source while this
// fills the cache; only complete files are reused for subsequent local plays.
//
// Every fetch is idempotent by key. Two viewers starting the same episode at
// once join the same download rather than racing to write the same path.
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../config.mjs";
import * as store from "./store.mjs";
import * as db from "../db.mjs";

// key -> { promise, bytes, total, path, abort }
const active = new Map();

export const activeFetches = () =>
  [...active.entries()].map(([key, f]) => ({ key, title: f.title, bytes: f.bytes, total: f.total }));

export function progressOf(key) {
  const f = active.get(key);
  if (f) return { bytes: f.bytes, total: f.total, done: false };
  const row = db.getCacheEntry(key);
  if (!row) return null;
  return { bytes: row.bytes, total: row.total, done: row.state === "complete" };
}

// Is this file ready to be handed to the transcoder?
//
// Only when it is COMPLETE, and that is a correction rather than caution.
//
// The original design started playback from a "head start" of the download on
// the theory that a sequential write can be read from the front while the tail
// arrives. ffmpeg does not work that way: it reads to the end of what exists,
// treats that as end-of-stream, and exits. Measured on a 7.5 GB 38 Mbps remux,
// a 24 MB head start is about five seconds of video — the encoder consumed it,
// exited, and playback stopped dead at 0.4s with no way to resume, because
// nothing re-launches ffmpeg as more bytes land.
//
// Serving a partial file is therefore not "playback that starts sooner", it is
// playback that stops. The instant-start job belongs to the floor tier, and the
// quality release arrives via upgrade-in-place when it is actually whole.
//
// (A growing-file reader — feeding ffmpeg through a FIFO that blocks at EOF
// instead of ending — would restore true head-start playback, at the cost of
// losing seek-by-byte-range on the source. Worth doing; not free.)
export function readyToPlay(key) {
  const p = progressOf(key);
  return !!p?.done;
}

// Wait (briefly) for the file to become playable. Resolves false if it isn't
// ready in time or the fetch died — the caller then keeps the floor stream and
// surfaces an upgrade handle, rather than blocking a play on a multi-GB pull.
export async function waitUntilReady(key, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (readyToPlay(key)) return true;
    if (!active.has(key)) return readyToPlay(key); // fetch ended — ready, or failed
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Start (or join) a fetch. Returns { path, key, joined } immediately — the
// download continues in the background and progress is observable above.
export async function fetchToCache({ key, url, total = 0, title = null }) {
  if (!config.cache.enabled) throw new Error("cache: background downloads disabled");
  if (active.has(key)) return { path: active.get(key).path, key, joined: true, cached: false };
  const existing = store.lookup(key);
  if (existing?.state === "complete") return { path: existing.path, key, joined: true, cached: true };

  if (active.size >= config.cache.maxDownloads) throw new Error("cache: background download limit reached");
  total = Number.isFinite(total) && total > 0 ? total : 0;
  const path_ = store.pathFor(key, url);
  const abort = new AbortController();
  const entry = { bytes: existing?.bytes || 0, total, title, path: path_, abort, promise: null };
  // Register before the first await: concurrent requests join this download.
  active.set(key, entry);
  entry.promise = (async () => {
    await store.reserve(key, total || entry.bytes);
    await store.admit({ key, sourceUrl: url, total, title });
    let from = 0;
    try { from = (await fsp.stat(path_)).size; } catch {}
    entry.bytes = from;
    return pump(entry, { key, url, from });
  })().catch((error) => {
    store.progress(key, entry.bytes);
    if (!abort.signal.aborted) store.fail(key);
    throw error;
  }).finally(() => { active.delete(key); store.unreserve(key); });
  entry.promise.catch(() => {}); // background rejection must never crash the process
  return { path: path_, key, joined: false, cached: false };
}

async function pump(entry, { key, url, from }) {
  const headers = from > 0 ? { Range: `bytes=${from}-` } : {};
  const res = await fetch(url, { headers, signal: AbortSignal.any([entry.abort.signal, AbortSignal.timeout(6 * 60 * 60 * 1000)]) });
  if (!res.ok && res.status !== 206) {
    await res.body?.cancel();
    store.fail(key);
    throw new Error(`cache fetch: HTTP ${res.status}`);
  }
  // A server that ignores Range restarts the body at 0; appending then would
  // corrupt the file, so truncate and take it from the top.
  const restarted = from > 0 && res.status !== 206;
  if (restarted) { from = 0; entry.bytes = 0; }

  const len = Number(res.headers.get("content-length")) || 0;
  let advertisedTotal = len;
  if (res.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get("content-range") || "");
    const [start, end, complete] = range ? range.slice(1).map(Number) : [];
    if (!range || start !== from || end < start || end >= complete || !Number.isSafeInteger(complete)
      || (len && len !== end - start + 1)) {
      await res.body?.cancel();
      throw new Error("cache fetch: invalid Content-Range for resume");
    }
    // A server can return less than the remaining file. The full advertised
    // size is authoritative so a short range is never marked complete.
    advertisedTotal = complete;
  }
  if (advertisedTotal) {
    entry.total = advertisedTotal;
    try { await store.reserve(key, entry.total); }
    catch (error) { await res.body?.cancel(); throw error; }
    db.putCacheEntry({ key, path: entry.path, bytes: entry.bytes, total: entry.total, state: "partial" });
  }
  if (!res.body) throw new Error("cache fetch: empty response body");
  let reserved = entry.total;
  let sinceFlush = 0;
  try {
    await pipeline(Readable.fromWeb(res.body), async function* (source) {
      for await (const chunk of source) {
        // Chunked responses still obey the budget; grow their reservation in
        // small steps before writing beyond the space already admitted.
        if (entry.bytes + chunk.length > reserved) {
          reserved = Math.max(entry.bytes + chunk.length, reserved + 16 * 1024 * 1024);
          await store.reserve(key, reserved);
        }
        entry.bytes += chunk.length;
        sinceFlush += chunk.length;
        if (sinceFlush >= 16 * 1024 * 1024) { store.progress(key, entry.bytes); sinceFlush = 0; }
        yield chunk;
      }
    }, fs.createWriteStream(entry.path, { flags: restarted || from === 0 ? "w" : "a" }), { signal: entry.abort.signal });
    if (entry.total && entry.bytes !== entry.total) throw new Error("cache fetch: incomplete response");
    store.complete(key, entry.bytes);
    return entry.path;
  } catch (e) {
    // Count what reached disk, not buffered chunks rejected by a failed write.
    try { entry.bytes = (await fsp.stat(entry.path)).size; } catch { entry.bytes = 0; }
    store.progress(key, entry.bytes);
    // Leave the partial file: it's resumable, and it's evictable if it isn't
    // resumed. Deleting here would throw away a mostly-complete 60 GB pull
    // because of one dropped connection.
    if (entry.abort.signal.aborted) return entry.path;
    store.fail(key);
    throw e;
  }
}

// Stop a fetch (viewer moved on, shutdown). The partial file survives.
export function cancel(key) {
  const f = active.get(key);
  if (f) f.abort.abort();
}

export function cancelAll() {
  for (const key of [...active.keys()]) cancel(key);
}
