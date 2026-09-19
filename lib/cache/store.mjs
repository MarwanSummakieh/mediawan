// The source cache — release files held on the array so playback reads from
// local disk instead of the debrid CDN.
//
// This is a WORKING SET, not a library. It evicts least-recently-used against a
// byte budget and nobody curates it: you press play, the file lands, and it
// stays until the space is wanted for something newer. That distinction is the
// whole point — it buys the reliability of owning the file without turning the
// app into a media manager.
//
// Why it matters beyond speed:
//   • Local transcoding needs seekable local bytes. Transcoding straight from a
//     debrid URL means an upstream hiccup kills playback mid-film and every
//     seek is a fresh range request over the internet.
//   • A file on the array cannot be CAPTCHA-gated, rotated, rate-limited or
//     DMCA'd out from under a viewer. It is the only source in this system that
//     is genuinely immune to the failures that started this rebuild.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "../config.mjs";
import * as db from "../db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default next to the SQLite file (the persistent volume in Docker), same rule
// db.mjs uses, so a default deployment keeps its data in one place.
const dataDir = path.dirname(config.dbPath || path.join(__dirname, "..", "..", "data.sqlite"));
export const CACHE_DIR = config.cache.dir || path.join(dataDir, "cache");

// Files currently being read by a live playback/transcode session. Eviction
// must never delete one of these: freeing a few GB is worthless if it kills the
// stream someone is watching.
const inUse = new Map(); // key -> refcount
const playbackGrace = new Map(); // key -> expiry timer between HTTP ranges
const evicting = new Map(); // key -> pending unlink; lookup must not hand out its path
const reservations = new Map(); // downloading key -> final bytes reserved
let admission = Promise.resolve();

// Serialize admission so simultaneous plays cannot both spend the same space.
export function reserve(key, bytes) {
  const next = admission.then(async () => {
    await ensureDir();
    // A play that fell back to its remote source may immediately request a new
    // cache copy. Do not create it until an already-started unlink is finished.
    while (evicting.has(key)) await evicting.get(key);
    const previous = reservations.get(key);
    reservations.set(key, previous || 0); // protect a resumed partial during eviction
    try {
      if (!(await makeRoom(bytes, { key }))) throw new Error("cache: insufficient storage or cache budget");
      reservations.set(key, bytes);
    } catch (error) {
      if (previous == null) reservations.delete(key);
      else reservations.set(key, previous);
      throw error;
    }
  });
  admission = next.catch(() => {});
  return next;
}
export const unreserve = (key) => reservations.delete(key);

export function acquire(key) {
  if (evicting.has(key)) throw new Error("cache: file is being evicted");
  inUse.set(key, (inUse.get(key) || 0) + 1);
  db.touchCacheEntry(key);
}
export function release(key) {
  const n = (inUse.get(key) || 0) - 1;
  if (n > 0) inUse.set(key, n);
  else inUse.delete(key);
}
export const isInUse = (key) => (inUse.get(key) || 0) > 0 || playbackGrace.has(key);

// An idempotent lease protects an async probe or HTTP response. Grace bridges
// the gap between issuing a direct-play URL and opening it, and between Range
// requests from a buffered player. Timers expire without keeping Node alive.
export function playbackLease(key, { graceMs = config.cache.playbackGraceMs } = {}) {
  acquire(key);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (graceMs > 0) {
      clearTimeout(playbackGrace.get(key));
      const timer = setTimeout(() => {
        if (playbackGrace.get(key) === timer) playbackGrace.delete(key);
      }, graceMs);
      timer.unref?.();
      playbackGrace.set(key, timer);
    }
    release(key);
  };
}

// A stable identity for one playable file. Keyed on the RELEASE rather than the
// title, so two different releases of the same episode are separate entries and
// picking a different one in the Servers panel doesn't clobber the first.
export function cacheKey({ provider, release, episode = null }) {
  const h = crypto.createHash("sha1").update(`${provider}::${release}::${episode ?? ""}`).digest("hex").slice(0, 16);
  return `${provider}-${h}`;
}

function safeName(key, sourceUrl) {
  // Extension matters: ffprobe and ffmpeg both use it as a demuxer hint, and
  // guessing wrong makes a perfectly good file look unreadable.
  const ext = (String(sourceUrl || "").match(/\.(mkv|mp4|avi|m4v|mov|webm|ts)(?:\?|$)/i)?.[1] || "mkv").toLowerCase();
  return `${key}.${ext}`;
}

export async function ensureDir() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
}

// Is this release already on the array and complete?
export function lookup(key) {
  if (evicting.has(key)) return null;
  const row = db.getCacheEntry(key);
  if (!row) return null;
  if (!fs.existsSync(row.path) && !reservations.has(key)) { db.deleteCacheEntry(key); return null; } // index/disk drifted
  db.touchCacheEntry(key);
  return row;
}

// ---- eviction ----

// Free at least `needed` bytes, oldest-first, skipping pinned and in-use
// entries. Returns how much was actually reclaimed — the caller decides whether
// that was enough, because refusing to cache is a valid outcome and is much
// better than evicting something a viewer is mid-way through.
export async function evict(needed) {
  let freed = 0;
  for (const row of db.cacheEvictionCandidates()) {
    if (freed >= needed) break;
    if (isInUse(row.key) || reservations.has(row.key) || evicting.has(row.key)) continue;
    let finishEviction;
    evicting.set(row.key, new Promise((resolve) => { finishEviction = resolve; }));
    try {
      await fsp.rm(row.path, { force: true });
      db.deleteCacheEntry(row.key);
      freed += row.bytes;
    } catch { /* a file we could not remove still consumes space */ }
    finally { evicting.delete(row.key); finishEviction(); }
  }
  return freed;
}

// Can `bytes` be admitted, evicting if necessary? A file larger than the whole
// budget is refused outright rather than emptying the cache for one item.
export async function makeRoom(bytes, { key = null } = {}) {
  const budget = config.cache.budgetBytes;
  if (!Number.isFinite(bytes) || bytes < 0) return false;
  if (bytes > budget) return false;
  const committed = () => {
    const rows = new Map(db.listCacheEntries().map((r) => [r.key, r.bytes]));
    for (const [k, amount] of reservations) rows.set(k, Math.max(rows.get(k) || 0, amount));
    rows.delete(key);
    return [...rows.values()].reduce((sum, size) => sum + size, 0);
  };
  if (committed() + bytes > budget) await evict(committed() + bytes - budget);
  if (committed() + bytes > budget) return false;
  // Disk may contain other applications' data. Leave a real free-space reserve,
  // counting the remaining bytes of other downloads, not only this cache's rows.
  const st = await fsp.statfs(CACHE_DIR);
  const existing = key ? db.getCacheEntry(key)?.bytes || 0 : 0;
  let pending = 0;
  for (const [k, amount] of reservations) {
    if (k !== key) pending += Math.max(0, amount - (db.getCacheEntry(k)?.bytes || 0));
  }
  return st.bavail * st.bsize >= Math.max(0, bytes - existing) + pending + config.cache.reserveBytes;
}

export function pathFor(key, sourceUrl) {
  return path.join(CACHE_DIR, safeName(key, sourceUrl));
}

// Register a new (partial) entry. The row exists from the first byte so that a
// crash leaves a reclaimable record instead of an orphaned file on the array.
export async function admit({ key, sourceUrl, total, title }) {
  await ensureDir();
  const p = pathFor(key, sourceUrl);
  let bytes = 0;
  try { bytes = (await fsp.stat(p)).size; } catch {}
  db.putCacheEntry({ key, path: p, bytes, total: total || 0, state: "partial", title, sourceUrl });
  return p;
}

export const complete = (key, bytes) => db.updateCacheEntry(key, { bytes, total: bytes, state: "complete" });
export const progress = (key, bytes) => db.updateCacheEntry(key, { bytes });
export const fail = (key) => db.updateCacheEntry(key, { state: "failed" });

export const pin = (key, on = true) => db.setCachePinned(key, on);

export function stats() {
  const used = db.cacheTotalBytes();
  const rows = db.listCacheEntries();
  return {
    dir: CACHE_DIR,
    usedBytes: used,
    budgetBytes: config.cache.budgetBytes,
    entries: rows.length,
    complete: rows.filter((r) => r.state === "complete").length,
    partial: rows.filter((r) => r.state === "partial").length,
    inUse: [...inUse.keys()],
  };
}

// Boot-time reconciliation: the index and the array can drift when the process
// dies mid-download or someone clears the directory by hand. Trust the DISK —
// it holds the bytes — and repair the index to match.
export async function reconcile() {
  await ensureDir();
  for (const row of db.listCacheEntries()) {
    try {
      const st = await fsp.stat(row.path);
      // A "partial" row whose file stopped growing is a dead download; it is
      // kept (and evictable) rather than resumed blindly, because we can't know
      // the source URL is still valid.
      if (st.size !== row.bytes) db.updateCacheEntry(row.key, { bytes: st.size });
    } catch {
      db.deleteCacheEntry(row.key); // file is gone — drop the row
    }
  }
}
