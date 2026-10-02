import { test, after, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import express from "express";

// Every filesystem/database assertion runs in an isolated temporary directory.
const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "mediawan-pipeline-"));
process.env.DB_PATH = path.join(directory, "data.sqlite");
process.env.CACHE_DIR = path.join(directory, "cache");
process.env.CACHE_RESERVE_BYTES = "0";
const { config, envNumber } = await import("../lib/config.mjs");
const { inspectCapabilities } = await import("../lib/transcode/probe.mjs");
const { describePipeline } = await import("../lib/pipeline.mjs");
const fetcher = await import("../lib/cache/fetcher.mjs");
const store = await import("../lib/cache/store.mjs");
const db = await import("../lib/db.mjs");
const { startSession } = await import("../lib/transcode/session.mjs");
const { serveCachedFile } = await import("../lib/cache/serve.mjs");
const originalFetch = globalThis.fetch;
const originalCache = { ...config.cache };

async function settled() {
  const until = Date.now() + 3000;
  while (fetcher.activeFetches().length && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fetcher.activeFetches().length, 0, "background downloads must finish");
}

afterEach(async () => {
  mock.restoreAll();
  fetcher.cancelAll();
  await settled();
  globalThis.fetch = originalFetch;
  Object.assign(config.cache, originalCache);
  for (const row of db.listCacheEntries()) {
    await fsp.rm(row.path, { force: true });
    db.deleteCacheEntry(row.key);
  }
});
after(async () => { db.closeDb(); await fsp.rm(directory, { recursive: true, force: true }); });

test("configuration accepts explicit LAN zero and rejects unsafe capacities", () => {
  assert.equal(envNumber("0", 8788, { min: 0 }), 0);
  for (const value of ["-1", "Infinity", "2.5", "nope", ""]) assert.equal(envNumber(value, 2), 2);
  assert.equal(envNumber("2.5", 6, { integer: false }), 2.5);
});

test("compiled QSV is not reported as a working GPU, and errors omit command output", async () => {
  const result = await inspectCapabilities({ settings: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", hwaccel: "qsv" }, execute: async (_tool, args) => {
    if (args.includes("-version")) return { stdout: "ffprobe version" };
    if (args.includes("-encoders")) return { stdout: "h264_qsv hevc_qsv libx264" };
    throw Object.assign(new Error("private command line and credentials"), { code: 1 });
  } });
  assert.equal(result.ffmpeg, true);
  assert.equal(result.ffprobe, true);
  assert.equal(result.qsv, false);
  assert.equal(result.qsvError, "Quick Sync test: 1");
  assert.doesNotMatch(JSON.stringify(result), /private|credentials/);
});

test("a real QSV smoke encode and ffprobe are both required", async () => {
  const result = await inspectCapabilities({ settings: { ffmpeg: "ffmpeg", ffprobe: "missing", hwaccel: "qsv" }, execute: async (tool, args) => {
    if (tool === "missing") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { stdout: args.includes("-encoders") ? "h264_qsv libx264" : "" };
  } });
  assert.equal(result.qsv, true);
  assert.equal(result.ffprobe, false);
  assert.match(result.ffprobeError, /ENOENT/);
});

test("working VAAPI keeps encoding on the GPU when Quick Sync rejects the device", async () => {
  const calls = [];
  const result = await inspectCapabilities({ settings: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", hwaccel: "qsv", device: "/dev/dri/renderD128" }, execute: async (_tool, args) => {
    calls.push(args);
    if (args.includes("-encoders")) return { stdout: "h264_qsv h264_vaapi libx264" };
    if (args.includes("h264_qsv")) throw Object.assign(new Error("MFX unsupported"), { code: 1 });
    return { stdout: "" };
  } });
  assert.equal(result.qsv, false);
  assert.equal(result.vaapi, true);
  assert.equal(result.hardwareMode, "vaapi");
  assert.ok(calls.find((args) => args.includes("-qsv_device")));
  const vaapi = calls.find((args) => args.includes("h264_vaapi"));
  assert.equal(vaapi[vaapi.indexOf("-vaapi_device") + 1], "/dev/dri/renderD128");
  assert.equal(vaapi[vaapi.indexOf("-vf") + 1], "format=nv12,hwupload");
});

test("explicit software mode does not initialize either GPU encoder", async () => {
  const calls = [];
  const result = await inspectCapabilities({ settings: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", hwaccel: "none" }, execute: async (_tool, args) => {
    calls.push(args);
    return { stdout: "h264_qsv h264_vaapi libx264" };
  } });
  assert.equal(result.hardwareMode, "none");
  assert.equal(calls.length, 2, "only ffmpeg encoder inventory and ffprobe version should run");
});

const diagnostic = (overrides = {}) => describePipeline({
  settings: config,
  caps: { ffmpeg: true, ffprobe: true, qsv: true, encoders: ["h264_qsv", "libx264"], error: null },
  cache: { dir: directory, usedBytes: 100, budgetBytes: 1000, entries: 1, complete: 0, partial: 1, writable: true, freeBytes: 1e12 },
  transfers: [{ key: "release", title: "Example", bytes: 25, total: 100, url: "https://private.invalid/token" }],
  sessionState: { active: 1, sessions: [{ id: "abc", mode: "encode", startedAt: 0, lastReadAt: 5000, input: "secret media URL" }] },
  services: [{ name: "realdebrid", label: "Real-Debrid", configured: true, token: "secret token" }],
  now: 10000, ...overrides,
});

test("admin diagnostics return live progress and omit provider tokens and source URLs", () => {
  const state = diagnostic();
  assert.equal(state.setup.ready, true);
  assert.equal(state.downloader.active[0].progress, 25);
  assert.equal(state.encoder.sessions[0].ageSec, 10);
  assert.equal(state.encoder.sessions[0].idleSec, 5);
  assert.doesNotMatch(JSON.stringify(state), /private|secret/);
});

test("diagnostics distinguish missing providers and software fallback from a ready NAS", () => {
  const state = diagnostic({ services: [], caps: { ffmpeg: true, ffprobe: true, qsv: false, encoders: ["libx264"] } });
  assert.equal(state.setup.ready, false);
  assert.equal(state.downloader.status, "action-needed");
  assert.equal(state.encoder.mode, "software");
  assert.equal(state.encoder.status, "action-needed");
  assert.equal(state.setup.checks.find((c) => c.id === "hardware").status, "warning");
});

test("VAAPI fallback is reported as ready hardware encoding", () => {
  const state = diagnostic({ caps: { ffmpeg: true, ffprobe: true, qsv: false, vaapi: true, encoders: ["h264_vaapi", "libx264"] } });
  assert.equal(state.setup.ready, true);
  assert.equal(state.encoder.mode, "vaapi");
  assert.equal(state.encoder.status, "ready");
  assert.match(state.setup.checks.find((c) => c.id === "hardware").detail, /VAAPI/);
});

test("simultaneous requests for a release join one background download", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("hello", { headers: { "content-length": "5" } }); };
  const results = await Promise.all([1, 2, 3].map(() => fetcher.fetchToCache({ key: "same", url: "https://example.test/file.mkv", total: 5 })));
  await settled();
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.joined).length, 2);
  assert.equal(db.getCacheEntry("same").state, "complete");
  assert.equal(await fsp.readFile(db.getCacheEntry("same").path, "utf8"), "hello");
});

test("a cache lookup while response headers are pending preserves the download index", async () => {
  let finish;
  globalThis.fetch = async () => new Promise((resolve) => { finish = () => resolve(new Response("hello")); });
  await fetcher.fetchToCache({ key: "headers-pending", url: "https://example.test/file.mkv" });
  const until = Date.now() + 2000;
  while (!finish && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.lookup("headers-pending").state, "partial");
  const joined = await fetcher.fetchToCache({ key: "headers-pending", url: "https://example.test/file.mkv" });
  assert.equal(joined.joined, true);
  finish();
  await settled();
  const row = db.getCacheEntry("headers-pending");
  assert.equal(row.state, "complete");
  assert.equal(row.total, 5, "chunked responses record their final size on completion");
});

test("failed connections and short responses are marked failed, never playable", async () => {
  globalThis.fetch = async () => { throw new Error("connection failed"); };
  await fetcher.fetchToCache({ key: "offline", url: "https://example.test/file.mkv", total: 5 });
  await settled();
  assert.equal(db.getCacheEntry("offline").state, "failed");
  assert.equal(fetcher.readyToPlay("offline"), false);
  globalThis.fetch = async () => new Response("short", { headers: { "content-length": "20" } });
  await fetcher.fetchToCache({ key: "short", url: "https://example.test/file.mkv", total: 20 });
  await settled();
  assert.equal(db.getCacheEntry("short").state, "failed");
});

test("simultaneous downloads reserve their full size before consuming storage", async () => {
  config.cache.budgetBytes = 100;
  let finish;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Promise((r) => { finish = () => r(new Response("x".repeat(60), { headers: { "content-length": "60" } })); }); };
  await Promise.all(["first", "second"].map((key) => fetcher.fetchToCache({ key, url: "https://example.test/file.mkv", total: 60 })));
  const until = Date.now() + 2000;
  while ((!finish || fetcher.activeFetches().length > 1) && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1, "second download must not spend the first download's reservation");
  finish();
  await settled();
  assert.equal(db.cacheTotalBytes(), 60);
});

async function partial(key) {
  const filename = await store.admit({ key, sourceUrl: "https://example.test/file.mkv", total: 10 });
  await fsp.writeFile(filename, "abcde");
  store.progress(key, 5);
  return filename;
}

test("resume validates Content-Range start and keeps a mismatched response off disk", async () => {
  const filename = await partial("bad-range");
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.Range, "bytes=5-");
    return new Response("abcde", { status: 206, headers: { "content-range": "bytes 0-4/10", "content-length": "5" } });
  };
  await fetcher.fetchToCache({ key: "bad-range", url: "https://example.test/file.mkv", total: 10 });
  await settled();
  assert.equal(db.getCacheEntry("bad-range").state, "failed");
  assert.equal(await fsp.readFile(filename, "utf8"), "abcde");
});

test("a valid partial range retains the full advertised size and is not playable", async () => {
  await partial("short-range");
  globalThis.fetch = async () => new Response("fg", { status: 206, headers: { "content-range": "bytes 5-6/10", "content-length": "2" } });
  await fetcher.fetchToCache({ key: "short-range", url: "https://example.test/file.mkv", total: 10 });
  await settled();
  const row = db.getCacheEntry("short-range");
  assert.equal(row.total, 10);
  assert.equal(row.bytes, 7);
  assert.equal(row.state, "failed");
});

test("a correct resume appends the remaining bytes and becomes playable", async () => {
  const filename = await partial("good-range");
  globalThis.fetch = async () => new Response("fghij", { status: 206, headers: { "content-range": "bytes 5-9/10", "content-length": "5" } });
  await fetcher.fetchToCache({ key: "good-range", url: "https://example.test/file.mkv", total: 10 });
  await settled();
  assert.equal(fetcher.readyToPlay("good-range"), true);
  assert.equal(await fsp.readFile(filename, "utf8"), "abcdefghij");
});

test("evicting some bytes does not admit a download when pinned files still exhaust the budget", async () => {
  config.cache.budgetBytes = 100;
  for (const [key, bytes] of [["pinned", 80], ["old", 10]]) {
    const filename = await store.admit({ key, sourceUrl: "file.mkv", total: bytes });
    await fsp.writeFile(filename, "x".repeat(bytes));
    store.complete(key, bytes);
  }
  store.pin("pinned");
  assert.equal(await store.makeRoom(50), false);
  assert.equal(db.getCacheEntry("old"), null);
  assert.equal(db.getCacheEntry("pinned").bytes, 80);
});

test("disabled caching refuses downloads without contacting a source", async () => {
  config.cache.enabled = false;
  globalThis.fetch = () => { throw new Error("must not fetch"); };
  await assert.rejects(fetcher.fetchToCache({ key: "disabled", url: "https://example.test/file.mkv" }), /disabled/);
});

async function completeFile(key, text = "abcde") {
  const filename = await store.admit({ key, sourceUrl: "https://example.test/file.mp4", total: text.length });
  await fsp.writeFile(filename, text);
  store.complete(key, text.length);
  return filename;
}

test("playback leases protect concurrent readers and release idempotently", async () => {
  await completeFile("readers");
  const first = store.playbackLease("readers", { graceMs: 0 });
  const second = store.playbackLease("readers", { graceMs: 0 });
  first();
  first();
  assert.equal(await store.evict(5), 0, "one finished reader must not unpin the other");
  second();
  assert.equal(await store.evict(5), 5);
});

test("direct playback grace protects Range gaps and expires after the latest response", async (t) => {
  await completeFile("range-grace");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  store.playbackLease("range-grace", { graceMs: 2000 })();
  t.mock.timers.tick(1500);
  store.playbackLease("range-grace", { graceMs: 2000 })();
  t.mock.timers.tick(1500);
  assert.equal(await store.evict(5), 0, "the later Range response renews the grace period");
  t.mock.timers.tick(500);
  assert.equal(await store.evict(5), 5);
});

test("a cached source is pinned during asynchronous probing and released after startup failure", async () => {
  const filename = await completeFile("probing");
  config.cache.playbackGraceMs = 0;
  const previous = { ...config.transcode };
  config.transcode.enabled = true;
  // Node is an available executable, but cannot emit ffprobe's JSON. This
  // exercises the asynchronous process-failure path without a media dependency.
  config.transcode.ffprobe = process.execPath;
  try {
    const failure = assert.rejects(startSession({ filePath: filename, cacheKey: "probing", local: true }));
    assert.equal(store.isInUse("probing"), true);
    assert.equal(await store.evict(5), 0);
    await failure;
    assert.equal(store.isInUse("probing"), false);
    assert.equal(await store.evict(5), 5);
  } finally { Object.assign(config.transcode, previous); }
});

test("lookup and new admission cannot race an asynchronous unlink", async () => {
  const filename = await completeFile("unlink-race");
  const nativeRm = fsp.rm;
  let finishUnlink;
  mock.method(fsp, "rm", (name, options) => name === filename
    ? new Promise((resolve, reject) => { finishUnlink = () => nativeRm(name, options).then(resolve, reject); })
    : nativeRm(name, options));
  const eviction = store.evict(5);
  assert.equal(store.lookup("unlink-race"), null, "a path with an unlink in progress cannot be played");
  assert.throws(() => store.playbackLease("unlink-race"), /being evicted/);
  let admitted = false;
  const admission = store.reserve("unlink-race", 5).then(() => { admitted = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(admitted, false, "a new download must wait before recreating that path");
  finishUnlink();
  await eviction;
  await admission;
  assert.equal(admitted, true);
  mock.restoreAll();
  await completeFile("unlink-race");
  store.unreserve("unlink-race");
  assert.equal(await fsp.readFile(filename, "utf8"), "abcde");
});

async function directServer(work) {
  const app = express();
  app.get("/:key", serveCachedFile);
  const server = await new Promise((resolve) => { const running = app.listen(0, "127.0.0.1", () => resolve(running)); });
  try { await work(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test("direct HTTP playback supports suffix ranges, refuses invalid ranges and partial files", async () => {
  await completeFile("http-ranges");
  await partial("http-partial");
  config.cache.playbackGraceMs = 0;
  await directServer(async (base) => {
    const suffix = await originalFetch(`${base}/http-ranges`, { headers: { Range: "bytes=-2" } });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get("content-range"), "bytes 3-4/5");
    assert.equal(await suffix.text(), "de");
    for (const range of ["bytes=9-", "bytes=3-1", "bytes=-", "bytes=-0", "bytes=0-1,3-4", "invalid"]) {
      const invalid = await originalFetch(`${base}/http-ranges`, { headers: { Range: range } });
      assert.equal(invalid.status, 416, range);
      await invalid.text();
    }
    const unfinished = await originalFetch(`${base}/http-partial`);
    assert.equal(unfinished.status, 404);
    await unfinished.text();
  });
  assert.equal(store.isInUse("http-ranges"), false);
});

test("an active HTTP response pins its source and a client disconnect destroys the reader", async () => {
  await completeFile("http-active");
  config.cache.playbackGraceMs = 0;
  let reader;
  mock.method(fs, "createReadStream", () => {
    reader = new PassThrough();
    queueMicrotask(() => reader.write("a"));
    return reader;
  });
  await directServer(async (base) => {
    const abort = new AbortController();
    const response = await originalFetch(`${base}/http-active`, { signal: abort.signal });
    assert.equal(store.isInUse("http-active"), true);
    assert.equal(await store.evict(5), 0);
    abort.abort();
    await response.body.cancel().catch(() => {});
    const until = Date.now() + 2000;
    while (!reader.destroyed && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(reader.destroyed, true);
    assert.equal(store.isInUse("http-active"), false);
  });
  assert.equal(await store.evict(5), 5);
});

test("a direct-file disk read error ends the response and releases the source", async () => {
  await completeFile("http-error");
  config.cache.playbackGraceMs = 0;
  mock.method(fs, "createReadStream", () => {
    const reader = new PassThrough();
    queueMicrotask(() => reader.destroy(new Error("simulated disk read failure")));
    return reader;
  });
  await directServer(async (base) => {
    await assert.rejects(originalFetch(`${base}/http-error`));
  });
  assert.equal(store.isInUse("http-error"), false);
  assert.equal(await store.evict(5), 5);
});
