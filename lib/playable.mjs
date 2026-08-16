// playUrl builder — decides HOW the client reaches each stream's bytes.
//
// Three kinds of upstream:
//   • Release FILES (type "file") from the quality tier. Not playable as-is:
//     they go to the local pipeline (lib/delivery.mjs) to be cached and then
//     direct-played, remuxed, or downscaled for this particular client.
//   • Embed CDNs (the floor tier) gate on a Referer header a browser can't
//     set, so their bytes MUST route through /proxy/*.
//   • Real-Debrid links need no headers at all (verified live: manifest 200s
//     with none, CORS is `*`). Proxying them only funnels every video byte
//     through the origin — three trips over the same residential line in
//     production, capped by its upload leg. Measured: 30 Mbit/s direct vs a
//     9–26 Mbit/s tunnel ceiling. So RD plays DIRECT.
//
// Direct comes with strings attached: RD links are commonly locked to the IP
// that generated them (fine for the household, 403 for a remote member), and
// RD's open CORS is their header, not ours. So the proxied URL always rides
// along as `fallbackUrl`, and the player retries with it before giving up on
// the stream — remote members and any RD policy change degrade to today's
// behaviour instead of breaking. RD_DIRECT=false forces proxy-only for all.
import { signMediaToken } from "./security.mjs";

const RD_DIRECT = process.env.RD_DIRECT !== "false";

export function isRdUrl(url) {
  try { return /(^|\.)real-debrid\.com$/i.test(new URL(url).hostname); }
  catch { return false; }
}

// `origin` rides along beside `referer` because some hosts check both — a
// Referer-only request gets a 403 from them, which looks exactly like a dead
// source. The signed token still covers the URL alone, so adding the parameter
// doesn't invalidate anything.
export function proxyUrl(s, sign = signMediaToken) {
  const base = s.type === "hls" ? "/proxy/hls" : "/proxy/mp4";
  const origin = s.origin ? `&origin=${encodeURIComponent(s.origin)}` : "";
  return `${base}?url=${encodeURIComponent(s.url)}&referer=${encodeURIComponent(s.referer || "")}${origin}&t=${sign(s.url)}`;
}

// One stream in, one playable stream out.
//
// `local` says the client reached us on the LAN listener, which is the whole
// basis of the two-tier delivery model: local clients have gigabit and get the
// best available bytes, remote clients are behind a residential uplink (a
// measured 9-26 Mbit/s through the tunnel) and get something sized to fit.
//
// A `type: "file"` stream is a release file, not a browser-ready URL — it is
// handed to the local pipeline (lib/delivery.mjs) rather than given to the
// player directly, and carries `needsDelivery` so the caller knows to do that.
// `direct` is injectable for tests.
export function toPlayable(s, { sign = signMediaToken, direct = RD_DIRECT, local = false } = {}) {
  const proxied = proxyUrl(s, sign);

  if (s.type === "file") {
    return { ...s, needsDelivery: true, local: !!local, playUrl: null, fallbackUrl: proxied };
  }

  // Direct only over HTTPS. Real-Debrid hands out plain http:// links unless the
  // account has "Download Port: Secured" set, and a browser refuses to load
  // http:// media into an https:// page — production is behind an HTTPS tunnel,
  // so a direct http link is silently blocked as mixed content and playback
  // dies. The proxy is same-origin, so it always works; this just means an
  // http-configured account loses the speed benefit rather than the ability to
  // play at all.
  if (direct && isRdUrl(s.url) && /^https:/i.test(s.url))
    return { ...s, local: !!local, playUrl: s.url, fallbackUrl: proxied };
  return { ...s, local: !!local, playUrl: proxied };
}
