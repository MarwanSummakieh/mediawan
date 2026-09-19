// Synthetic diagnostic; run as a separate Node process inside the deployed web
// container. No production database, provider credentials, or user media are used.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const prefix = "mediawan-synthetic-smoke-";
const tempParent = path.resolve(os.tmpdir());
const temporary = await fsp.mkdtemp(path.join(tempParent, prefix));
const appRoot = path.resolve(process.env.MEDIAWAN_SMOKE_APP_DIR || "/app");
let db, cache, downloader, encoder, server;
let succeeded = false;

// Set isolation BEFORE any application import. These values affect only this
// child process, not the running web server or its Compose configuration.
Object.assign(process.env, {
  NODE_ENV: "test",
  ADMIN_EMAIL: "synthetic-smoke@example.invalid",
  ADMIN_PASSWORD: crypto.randomBytes(24).toString("hex"),
  DB_PATH: path.join(temporary, "smoke.sqlite"),
  CACHE_DIR: path.join(temporary, "cache"),
  CACHE_DOWNLOADS: "true",
  CACHE_MAX_DOWNLOADS: "1",
  CACHE_BUDGET_BYTES: String(64 * 1024 * 1024),
  CACHE_RESERVE_BYTES: "0",
  CACHE_PLAYBACK_GRACE_MS: "0",
  TRANSCODE: "true",
  TRANSCODE_HWACCEL: "vaapi",
  TRANSCODE_REMOTE_MBPS: "6",
  TRANSCODE_MAX_SESSIONS: "1",
  TRANSCODE_DEVICE: process.env.TRANSCODE_DEVICE || "/dev/dri/renderD128",
});

const moduleAt = (name) => import(pathToFileURL(path.join(appRoot, name)).href);
const insideTemporary = (filename) => {
  const relative = path.relative(temporary, path.resolve(filename));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
};

try {
  const { config } = await moduleAt("lib/config.mjs");
  assert.equal(path.resolve(config.dbPath), path.join(temporary, "smoke.sqlite"));
  db = await moduleAt("lib/db.mjs");
  cache = await moduleAt("lib/cache/store.mjs");
  downloader = await moduleAt("lib/cache/fetcher.mjs");
  encoder = await moduleAt("lib/transcode/session.mjs");
  const { capabilities, probeFile } = await moduleAt("lib/transcode/probe.mjs");
  assert.equal(path.resolve(cache.CACHE_DIR), path.join(temporary, "cache"));
  assert.equal(db.listCacheEntries().length, 0);

  const caps = await capabilities();
  assert.equal(caps.hardwareMode, "vaapi", `VAAPI unavailable: ${caps.vaapiError || caps.error || "unknown cause"}`);
  assert.equal(caps.ffprobe, true);

  // MPEG-4 Part 2 deliberately requires H.264 conversion in Mediawan, so this
  // cannot accidentally pass by merely remuxing an already-compatible stream.
  const original = path.join(temporary, "synthetic.mkv");
  await run(config.transcode.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "8", "-c:v", "mpeg4", "-q:v", "4",
    "-c:a", "aac", "-b:a", "96k", "-shortest", original,
  ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const sourceBytes = (await fsp.stat(original)).size;
  assert.ok(sourceBytes > 0 && sourceBytes < 16 * 1024 * 1024);

  let requests = 0;
  server = http.createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/synthetic.mkv") { res.writeHead(404).end(); return; }
    requests++;
    res.writeHead(200, { "Content-Type": "video/x-matroska", "Content-Length": sourceBytes });
    const input = fs.createReadStream(original);
    input.once("error", () => res.destroy());
    res.once("close", () => input.destroy());
    input.pipe(res);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const key = `smoke-${crypto.randomUUID()}`;
  const transfer = await downloader.fetchToCache({
    key, url: `http://127.0.0.1:${server.address().port}/synthetic.mkv`, total: sourceBytes, title: "Synthetic pipeline check",
  });
  const downloadDeadline = Date.now() + 15_000;
  while (!downloader.readyToPlay(key) && Date.now() < downloadDeadline) {
    assert.notEqual(db.getCacheEntry(key)?.state, "failed", "synthetic download failed");
    await sleep(25);
  }
  const row = db.getCacheEntry(key);
  assert.equal(row?.state, "complete", "download did not complete before timeout");
  assert.equal(row.bytes, sourceBytes);
  assert.equal(row.total, sourceBytes);
  assert.equal(requests, 1, "the cache must have fetched the generated file once");
  assert.ok(insideTemporary(transfer.path));
  const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
  assert.equal(sha(await fsp.readFile(transfer.path)), sha(await fsp.readFile(original)));
  assert.equal(cache.stats().complete, 1);

  const session = await encoder.startSession({
    filePath: transfer.path, cacheKey: key, identity: key, local: false, expectedBytes: sourceBytes,
  });
  assert.equal(session.mode, "encode");
  assert.equal(session.plan.copyVideo, false);
  assert.ok(insideTemporary(session.outDir));
  assert.equal(cache.isInUse(key), true, "encoder must hold a playback lease");
  assert.equal(await cache.evict(sourceBytes), 0, "active synthetic source must survive eviction");
  const encodeDeadline = Date.now() + 30_000;
  while (!session.exited && Date.now() < encodeDeadline) await sleep(50);
  assert.equal(session.exited, true, "encode did not finish before timeout");
  assert.equal(session.exitCode, 0, `encoder failed: ${session.stderr.slice(-600)}`);
  assert.equal(session.softwareFallback, false, "a software fallback must not count as a successful GPU test");
  assert.ok(session.proc.spawnargs.includes("h264_vaapi"), "the actual process must use VAAPI");

  const playlist = path.join(session.outDir, "index.m3u8");
  const manifest = await fsp.readFile(playlist, "utf8");
  assert.match(manifest, /#EXT-X-ENDLIST/);
  assert.match(manifest, /#EXT-X-MAP:URI="init.mp4"/);
  const segments = manifest.split(/\r?\n/).filter((line) => /^seg-\d+\.m4s$/.test(line));
  assert.ok(segments.length >= 2, "eight seconds should produce at least two HLS segments");
  for (const name of ["init.mp4", ...segments]) assert.ok((await fsp.stat(path.join(session.outDir, name))).size > 0);
  const output = await probeFile(playlist);
  assert.equal(output.video.codec, "h264");
  assert.equal(output.video.width, 640);
  assert.equal(output.video.height, 360);
  assert.equal(output.audio[0]?.codec, "aac");
  assert.ok(output.durationSec >= 7.5 && output.durationSec <= 9);

  await encoder.stopSession(session.id);
  assert.equal(cache.isInUse(key), false);
  assert.equal(await cache.evict(sourceBytes), sourceBytes);
  assert.equal(cache.stats().entries, 0);
  console.log(JSON.stringify({ ok: true, downloader: "complete; SHA-256 matched", bytes: sourceBytes,
    encoder: "h264_vaapi", video: "640x360 H.264", audio: "AAC", seconds: output.durationSec,
    hlsSegments: segments.length, activeSourceProtected: true, releasedSourceEvicted: true }));
  succeeded = true;
} catch (error) {
  console.error(`SYNTHETIC_SMOKE_FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  downloader?.cancelAll();
  if (encoder) await encoder.stopAll().catch(() => {});
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (downloader) {
    const deadline = Date.now() + 5000;
    while (downloader.activeFetches().length && Date.now() < deadline) await sleep(25);
  }
  db?.closeDb();
  // Only this mkdtemp result may be removed, and only directly under tmpdir.
  assert.equal(path.dirname(path.resolve(temporary)), tempParent);
  assert.ok(path.basename(temporary).startsWith(prefix));
  await fsp.rm(temporary, { recursive: true, force: true });
  console.log(`SYNTHETIC_SMOKE_CLEANUP=complete; RESULT=${succeeded ? "pass" : "fail"}`);
}
