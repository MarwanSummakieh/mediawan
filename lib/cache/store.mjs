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

export function acquire(key) {
  inUse.set(key, (inUse.get(key) || 0) + 1);
  db.touchCacheEntry(key);
}
export function release(key) {
  const n = (inUse.get(key) || 0) - 1;
  if (n > 0) inUse.set(key, n);
  else inUse.delete(key);
}
export const isInUse = (key) => (inUse.get(key) || 0) > 0;

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
  const row = db.getCacheEntry(key);
  if (!row) return null;
  if (!fs.existsSync(row.path)) { db.deleteCacheEntry(key); return null; } // index/disk drifted
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
    if (isInUse(row.key)) continue;
    try { await fsp.rm(row.path, { force: true }); } catch { /* already gone */ }
    db.deleteCacheEntry(row.key);
    freed += row.bytes;
  }
  return freed;
}

// Can `bytes` be admitted, evicting if necessary? A file larger than the whole
// budget is refused outright rather than emptying the cache for one item.
export async function makeRoom(bytes) {
  const budget = config.cache.budgetBytes;
  if (!Number.isFinite(bytes) || bytes <= 0) return true; // unknown size — admit and reconcile later
  if (bytes > budget) return false;
  const used = db.cacheTotalBytes();
  if (used + bytes <= budget) return true;
  const freed = await evict(used + bytes - budget);
  return db.cacheTotalBytes() + bytes <= budget || freed > 0;
}

export function pathFor(key, sourceUrl) {
  return path.join(CACHE_DIR, safeName(key, sourceUrl));
}

// Register a new (partial) entry. The row exists from the first byte so that a
// crash leaves a reclaimable record instead of an orphaned file on the array.
export async function admit({ key, sourceUrl, total, title }) {
  await ensureDir();
  const p = pathFor(key, sourceUrl);
  db.putCacheEntry({ key, path: p, bytes: 0, total: total || 0, state: "partial", title, sourceUrl });
  return p;
}

export const complete = (key, bytes) => db.updateCacheEntry(key, { bytes, state: "complete" });
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
