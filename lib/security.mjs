// Security middleware: headers, a small in-memory login throttle, an
// SSRF guard for the stream proxy, and signed media tokens for Chromecast.
// No external deps — small and auditable.
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";

// ---- security headers (manual; avoids a helmet dependency) ----
// CSP note: script-src allows 'unsafe-inline' because the UI uses inline
// onclick handlers. XSS surface is contained (all interpolated values pass
// through esc()/textContent). Removing 'unsafe-inline' means refactoring every
// inline handler to delegated listeners — a worthwhile future hardening step.
const CSP = [
  "default-src 'self'",
  "img-src 'self' https: data:",
  // real-debrid: direct playback (lib/playable.mjs) — <video src> needs media-src
  "media-src 'self' blob: data: https://*.real-debrid.com",
  // gstatic: the Google Cast sender SDK (cast_sender.js + framework) — the
  // only external script; everything else stays vendored/self-hosted.
  "script-src 'self' 'unsafe-inline' https://www.gstatic.com",
  "worker-src 'self' blob:", // hls.js spawns a blob web worker
  "style-src 'self' 'unsafe-inline'",
  // real-debrid: hls.js fetches direct manifests/segments over XHR
  "connect-src 'self' https://*.real-debrid.com",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export function securityHeaders(_req, res, next) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.removeHeader("X-Powered-By");
  next();
}

// ---- login rate limiter (per IP, sliding window) ----
export function makeRateLimiter({ windowMs = 15 * 60 * 1000, max = 10 } = {}) {
  const hits = new Map(); // ip -> [timestamps]
  // opportunistic cleanup so the map can't grow unbounded
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, arr] of hits) {
      const kept = arr.filter((t) => t > cutoff);
      if (kept.length) hits.set(ip, kept);
      else hits.delete(ip);
    }
  }, windowMs).unref?.();

  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const cutoff = now - windowMs;
    const arr = (hits.get(ip) || []).filter((t) => t > cutoff);
    if (arr.length >= max) {
      res.setHeader("Retry-After", Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: "Too many attempts. Try again later." });
    }
    arr.push(now);
    hits.set(ip, arr);
    next();
  };
}

// ---- SSRF guard for the proxy ----
// The proxy fetches an arbitrary user-supplied URL. Without a guard an authed
// user could make the server hit internal services (cloud metadata, localhost,
// LAN). Allow only http(s), and reject any host that resolves to a
// private/loopback/link-local address.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80")) return true;           // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

// ---- signed media tokens (Chromecast) ----
// A Chromecast fetches /proxy/* itself and has no session cookie, so stream
// URLs carry a short-lived HMAC token bound to the exact upstream `url` param.
// A leaked token therefore unlocks one upstream URL for a few hours — it is
// not a general proxy or API credential. Secret is per-boot: a restart only
// interrupts casts in flight (local playback still has the cookie).
const MEDIA_TOKEN_SECRET = process.env.CAST_TOKEN_SECRET || crypto.randomBytes(32).toString("hex");
const MEDIA_TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // outlasts any episode + long pauses

function mediaSig(url, exp) {
  return crypto.createHmac("sha256", MEDIA_TOKEN_SECRET).update(`${url}|${exp}`).digest("base64url");
}

// Token for `url`, valid ~6h. Format: "<expiryMs>.<hmac>".
export function signMediaToken(url, exp = Date.now() + MEDIA_TOKEN_TTL_MS) {
  return `${exp}.${mediaSig(url, exp)}`;
}

export function verifyMediaToken(url, token) {
  if (typeof url !== "string" || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(mediaSig(url, exp));
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// Returns the validated URL or throws. Resolves DNS and checks every address.
// Known gap: this is check-then-fetch, so a DNS rebinding attacker (TTL 0,
// swap in a private IP between our lookup and fetch's own) can still reach
// internal hosts. Closing it means pinning the resolved IP for the actual
// connection via a custom undici Agent `lookup` — undici would be our first
// runtime dependency beyond express, so it's accepted for now: the proxy is
// invite-gated and media tokens are bound to exact URLs, so only a logged-in
// member running a hostile DNS server could exploit the race.
export async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("invalid url"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme not allowed");
  const host = u.hostname;
  // literal IP host
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("blocked host");
    return u;
  }
  // resolve and verify all A/AAAA records are public
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw new Error("dns failed"); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("blocked host");
  return u;
}
