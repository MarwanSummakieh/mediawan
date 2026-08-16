// Central configuration. Reads env, applies safe dev defaults, and — in
// production — refuses to boot with missing or default secrets.
import crypto from "node:crypto";

const isProd = process.env.NODE_ENV === "production";

function required(name) {
  const v = process.env[name];
  if (!v) {
    if (isProd) {
      console.error(`\n  FATAL: ${name} must be set in production. Refusing to start.\n`);
      process.exit(1);
    }
    return null;
  }
  return v;
}

// Admin seed. In prod both must be set and the password must not be the dev default.
const adminEmail = process.env.ADMIN_EMAIL || (isProd ? required("ADMIN_EMAIL") : "admin@example.com");
const adminPassword = process.env.ADMIN_PASSWORD || (isProd ? required("ADMIN_PASSWORD") : "changeme");
if (isProd && adminPassword === "changeme") {
  console.error("\n  FATAL: ADMIN_PASSWORD is still the default 'changeme'. Set a real one.\n");
  process.exit(1);
}
if (isProd && adminPassword && adminPassword.length < 10) {
  console.error("\n  FATAL: ADMIN_PASSWORD must be at least 10 characters in production.\n");
  process.exit(1);
}

export const config = {
  isProd,
  port: Number(process.env.PORT) || 8787,
  // Behind Cloudflare Tunnel / a reverse proxy the real client IP is in
  // X-Forwarded-For; trust one hop so rate-limiting and logs see it.
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : (isProd ? 1 : 0),
  // Secure cookie flag: on in prod (served over HTTPS via the tunnel).
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : isProd,
  sessionMaxAgeDays: Number(process.env.SESSION_MAX_AGE_DAYS) || 30,
  dbPath: process.env.DB_PATH || null, // null → default next to lib/
  admin: { email: adminEmail, password: adminPassword },
  minPasswordLength: Number(process.env.MIN_PASSWORD_LENGTH) || 8,

  // ---- LAN vs remote delivery ----
  // The socket a request arrives on IS the locality signal. Behind cloudflared
  // with trust proxy on, req.ip is the tunnel's and can't be used to tell a
  // living-room TV from someone on hotel wifi — but a client that reached the
  // LAN listener is local by construction, and nothing about that is spoofable
  // from outside the network. 0 disables the LAN listener entirely.
  lanPort: Number(process.env.LAN_PORT) || 8788,

  // ---- source cache ----
  // Not a library: an LRU working set that self-evicts. Playback reads from
  // here rather than re-pulling from the debrid CDN on every watch, which is
  // also what makes seeking and local transcoding reliable.
  cache: {
    dir: process.env.CACHE_DIR || null, // null → <data dir>/cache
    budgetBytes: Number(process.env.CACHE_BUDGET_BYTES) || 5 * 1024 ** 4, // 5 TB of the 20 TB array
  },

  // ---- transcoding ----
  // LAN clients get the original bytes (remux at most). Remote clients get a
  // capped encode that fits the tunnel — the measured ceiling there is 9–26
  // Mbit/s against a residential upload leg, so the default target sits well
  // under it. This is the same trade Jellyfin makes, and why it feels fine
  // through the same tunnel that struggles with raw remuxes.
  transcode: {
    enabled: process.env.TRANSCODE !== "false",
    ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",
    ffprobe: process.env.FFPROBE_PATH || "ffprobe",
    hwaccel: process.env.TRANSCODE_HWACCEL || "qsv", // qsv | none
    remoteMbps: Number(process.env.TRANSCODE_REMOTE_MBPS) || 6,
    // An N100 will not run many 1080p encodes at once; refuse past this rather
    // than let every session stutter.
    maxSessions: Number(process.env.TRANSCODE_MAX_SESSIONS) || 2,
    idleTimeoutMs: Number(process.env.TRANSCODE_IDLE_MS) || 60_000,
  },

  // Which audio track a FILM or live-action episode gets when nobody has asked
  // for one. Anime answers this with sub/dub; everything else had no answer at
  // all, and "no answer" meant pickAudio's last resort — most channels wins.
  // On a MULTi release that is whichever dub the encoder gave 5.1 to, so a film
  // carrying Spanish 5.1 + English 2.0 played Spanish, every time, for everyone.
  // ISO-639-2/1 codes, best first. Empty string restores the old behaviour.
  audioLangs: (process.env.AUDIO_LANGS ?? "eng,en")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),

  // ---- ranking ----
  // The user's spec: 1080p minimum, 4K welcome, no smeared re-encodes.
  minResolution: Number(process.env.MIN_RESOLUTION) || 1080,
};

// Warn (dev) if the admin password is weak — helps avoid shipping it.
if (!isProd && adminPassword === "changeme") {
  console.warn("  [dev] Using default admin password 'changeme' — override with ADMIN_PASSWORD for anything real.");
}

export default config;
