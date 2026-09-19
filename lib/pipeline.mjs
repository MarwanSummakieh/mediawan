// Admin-only diagnostics for the built-in NAS download and encode pipeline.
// Only explicit, non-secret fields are returned; source URLs and process
// command lines must never be included in this response.
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.mjs";
import * as store from "./cache/store.mjs";
import { activeFetches } from "./cache/fetcher.mjs";
import { capabilities } from "./transcode/probe.mjs";
import { status as sessionStatus } from "./transcode/session.mjs";
import { backends } from "./debrid/backends.mjs";
import { listCacheEntries } from "./db.mjs";

async function inspectStorage() {
  let testPath;
  try {
    await store.ensureDir();
    testPath = path.join(store.CACHE_DIR, `.write-check-${crypto.randomUUID()}`);
    const file = await fsp.open(testPath, "wx");
    await file.close();
    await fsp.unlink(testPath);
    testPath = null;
    const st = await fsp.statfs(store.CACHE_DIR);
    return { writable: true, freeBytes: st.bavail * st.bsize, error: null };
  } catch (e) {
    return { writable: false, freeBytes: null, error: `Storage check failed (${e.code || "unknown error"})` };
  } finally {
    if (testPath) await fsp.unlink(testPath).catch(() => {});
  }
}

export function describePipeline({ settings, caps, cache, transfers, sessionState, services, failed = 0, now = Date.now() }) {
  const configured = services.some((b) => b.configured);
  const storageReady = cache.writable && cache.freeBytes >= settings.cache.reserveBytes;
  const encoderAvailable = caps.ffmpeg && caps.ffprobe && (caps.qsv || caps.vaapi || caps.encoders.includes("libx264"));
  const hardwareReady = settings.transcode.hwaccel === "none" || caps.qsv || caps.vaapi;
  const checks = [
    { id: "backend", label: "Download source", status: configured ? "ready" : "error",
      detail: configured ? "A provider credential is configured. Account and subscription health are checked under Streaming sources." : "Set REAL_DEBRID_TOKEN or PREMIUMIZE_API_KEY in the NAS .env file, then recreate the web container." },
    { id: "storage", label: "NAS storage", status: storageReady ? "ready" : "error",
      detail: !cache.writable ? "The cache directory is not writable. Check MEDIA_DIR ownership and PUID / PGID."
        : !storageReady ? "Free space is below CACHE_RESERVE_BYTES. Free space or adjust the reserve before downloading."
        : "Cache directory is writable and has free space above the configured reserve." },
    { id: "downloads", label: "Background downloader", status: settings.cache.enabled ? "ready" : "warning",
      detail: settings.cache.enabled ? `Playback saves releases to the NAS in the background, up to ${settings.cache.maxDownloads} downloads at once.`
        : "Background downloads are disabled. Set CACHE_DOWNLOADS=true to retain releases on the NAS." },
    { id: "ffmpeg", label: "Encoder tools", status: encoderAvailable ? "ready" : "error",
      detail: encoderAvailable ? "ffmpeg and ffprobe are available." : "ffmpeg, ffprobe, and a usable H.264 encoder are required. Rebuild the production Docker image or check FFMPEG_PATH / FFPROBE_PATH." },
    { id: "hardware", label: "Intel GPU encoding", status: hardwareReady ? "ready" : "warning",
      detail: settings.transcode.hwaccel === "none" ? "Software encoding is selected."
        : caps.qsv ? "A test frame encoded successfully with Quick Sync."
        : caps.vaapi ? "A test frame encoded successfully with VAAPI on the Intel GPU."
        : "GPU encoding failed its test. Check /dev/dri and VIDEO_GID / RENDER_GID; playback will use software encoding when available." },
    { id: "transcode", label: "Playback encoding", status: settings.transcode.enabled ? "ready" : "warning",
      detail: settings.transcode.enabled ? `Remote video is capped at ${settings.transcode.remoteMbps} Mbps, with ${settings.transcode.maxSessions} simultaneous sessions.`
        : "Transcoding is disabled. Set TRANSCODE=true and recreate the web container." },
  ];
  return {
    checkedAt: new Date(now).toISOString(),
    downloader: {
      enabled: settings.cache.enabled, configured,
      status: !settings.cache.enabled ? "disabled" : configured && storageReady ? "ready" : "action-needed",
      maxDownloads: settings.cache.maxDownloads, failed,
      backends: services.map(({ name, label, configured: present }) => ({ name, label, configured: !!present })),
      active: transfers.map(({ key, title, bytes, total }) => ({ key, title, bytes, total, progress: total > 0 ? Math.min(100, Math.round(bytes / total * 100)) : null })),
      cache: { dir: cache.dir, usedBytes: cache.usedBytes, budgetBytes: cache.budgetBytes,
        reserveBytes: settings.cache.reserveBytes, entries: cache.entries, complete: cache.complete, partial: cache.partial,
        writable: cache.writable, freeBytes: cache.freeBytes, error: cache.error },
    },
    encoder: {
      enabled: settings.transcode.enabled,
      status: !settings.transcode.enabled ? "disabled" : encoderAvailable && hardwareReady ? "ready" : "action-needed",
      mode: !settings.transcode.enabled ? "disabled" : !encoderAvailable ? "unavailable" : caps.qsv ? "qsv" : caps.vaapi ? "vaapi" : "software",
      requestedMode: settings.transcode.hwaccel, ffmpeg: caps.ffmpeg, ffprobe: caps.ffprobe, qsv: caps.qsv, vaapi: !!caps.vaapi,
      encoders: caps.encoders, error: caps.error, qsvError: caps.qsvError, vaapiError: caps.vaapiError, ffprobeError: caps.ffprobeError,
      remoteMbps: settings.transcode.remoteMbps, maxSessions: settings.transcode.maxSessions,
      activeSessions: sessionState.active,
      sessions: sessionState.sessions.map((s) => ({ id: s.id, key: s.key, mode: s.mode,
        ageSec: Math.max(0, Math.round((now - s.startedAt) / 1000)), idleSec: Math.max(0, Math.round((now - s.lastReadAt) / 1000)),
        exited: !!s.exited, softwareFallback: !!s.softwareFallback })),
    },
    setup: { ready: checks.every((c) => c.status === "ready"), checks },
  };
}

export async function pipelineStatus() {
  const [caps, storage] = await Promise.all([capabilities(), inspectStorage()]);
  return describePipeline({ settings: config, caps, cache: { ...store.stats(), ...storage },
    transfers: activeFetches(), sessionState: sessionStatus(), failed: listCacheEntries().filter((r) => r.state === "failed").length,
    services: backends.map((b) => ({ name: b.name, label: b.label, configured: b.enabled() })) });
}
