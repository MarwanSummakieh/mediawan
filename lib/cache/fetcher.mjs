// Pull a release file from the debrid CDN onto the array.
//
// Sequential and resumable, and deliberately NOT "download then play": the
// write is front-to-back, so a reader can start consuming the head while the
// tail is still arriving. That is what keeps first-play latency close to
// streaming while still ending up with a complete local file.
//
// Every fetch is idempotent by key. Two viewers starting the same episode at
// once join the same download rather than racing to write the same path.
import fs from "node:fs";
import fsp from "node:fs/promises";
import * as store from "./store.mjs";
import * as db from "../db.mjs";

// key -> { promise, bytes, total, path, abort }
const active = new Map();

export const activeFetches = () =>
  [...active.entries()].map(([key, f]) => ({ key, bytes: f.bytes, total: f.total }));

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
  const existing = store.lookup(key);
  if (existing?.state === "complete") return { path: existing.path, key, joined: true, cached: true };
  if (active.has(key)) return { path: active.get(key).path, key, joined: true, cached: false };

  if (!(await store.makeRoom(total))) {
    throw new Error(`cache: ${total} bytes exceeds the budget or cannot be freed`);
  }

  const path_ = await store.admit({ key, sourceUrl: url, total, title });
  // Resume if a partial file survived a restart: HTTP range picks up where the
  // bytes stop, which on a 60 GB remux is the difference between a hiccup and
  // starting over.
  let from = 0;
  try { from = (await fsp.stat(path_)).size; } catch { /* no partial file */ }

  const abort = new AbortController();
  const entry = { bytes: from, total, path: path_, abort, promise: null };
  entry.promise = pump(entry, { key, url, from }).finally(() => active.delete(key));
  active.set(key, entry);
  entry.promise.catch(() => {}); // background rejection must never crash the process
  return { path: path_, key, joined: false, cached: false };
}

async function pump(entry, { key, url, from }) {
  const headers = from > 0 ? { Range: `bytes=${from}-` } : {};
  const res = await fetch(url, { headers, signal: entry.abort.signal });
  if (!res.ok && res.status !== 206) {
    store.fail(key);
    throw new Error(`cache fetch: HTTP ${res.status}`);
  }
  // A server that ignores Range restarts the body at 0; appending then would
  // corrupt the file, so truncate and take it from the top.
  const restarted = from > 0 && res.status !== 206;
  if (restarted) { from = 0; entry.bytes = 0; }

  const len = Number(res.headers.get("content-length")) || 0;
  if (len) {
    entry.total = from + len;
    db.updateCacheEntry(key, { bytes: entry.bytes });
    if (!entry.totalWritten) db.putCacheEntry({ key, path: entry.path, bytes: entry.bytes, total: entry.total, state: "partial" });
  }

  const out = fs.createWriteStream(entry.path, { flags: restarted || from === 0 ? "w" : "a" });
  let sinceFlush = 0;
  try {
    for await (const chunk of res.body) {
      if (!out.write(Buffer.from(chunk))) await new Promise((r) => out.once("drain", r));
      entry.bytes += chunk.length;
      sinceFlush += chunk.length;
      // Persist progress periodically, not per chunk — this is a hot loop and
      // the index only needs to be approximately right until completion.
      if (sinceFlush > 16 * 1024 * 1024) { store.progress(key, entry.bytes); sinceFlush = 0; }
    }
    await new Promise((r) => out.end(r));
    store.complete(key, entry.bytes);
    return entry.path;
  } catch (e) {
    try { out.destroy(); } catch {}
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
