// Debrid backends — the redundancy Movies and TV never had.
//
// Anime survives an outage because it has three independent providers. Movies
// and TV had exactly one: Real-Debrid. Every release we discovered, however
// many, funnelled into a single cache, so "RD hasn't got this" meant "this film
// does not play" with no second opinion available. Adding more torrent indexers
// can't fix that — they all end at the same door.
//
// So debrid access becomes a registry, the same shape the anime providers use.
// Backends are tried in order; each is independent, and one being down, rate
// limited or missing a release never blocks the next.
//
// A backend is:
//   name, label
//   enabled()                  -> is a token configured?
//   fromMagnet(magnet, opts)   -> stream | null (not cached — try elsewhere)
//                                 throws only on unexpected API failure
//   remove(id)                 -> tidy up a torrent we added
//   checkCached(hashes)?       -> optional: Set of hashes this service has,
//                                 answered in ONE call
//   accountFault(err)?         -> optional: is this error the service refusing
//                                 the ACCOUNT (dead token, lapsed sub) rather
//                                 than one release being absent? Returns a
//                                 plain-English cause, or null. Without it a
//                                 lapsed subscription is indistinguishable
//                                 from a hundred unlucky releases.
//
// checkCached is the prize. Without it you learn a release isn't cached by
// trying it — a round trip each. With it, one request over all 100 discovered
// releases returns the playable set instantly, so we pick the BEST cached
// release rather than the first lucky one.
import { streamFromMagnet as rdFromMagnet, remove as rdRemove, debridEnabled as rdEnabled,
  accountFault as rdAccountFault } from "./realdebrid.mjs";

const hashOf = (magnet) => (String(magnet).match(/btih:([a-z0-9]{32,40})/i)?.[1] || "").toLowerCase();
const VIDEO_RE = /\.(mkv|mp4|avi|m4v|mov|webm)$/i;

// ---- Real-Debrid: the incumbent, unchanged ----
// No checkCached: RD retired its bulk instant-availability endpoint, which is
// precisely why a second service with one is worth having.
const realdebrid = {
  name: "realdebrid",
  label: "Real-Debrid",
  enabled: rdEnabled,
  fromMagnet: rdFromMagnet,
  remove: rdRemove,
  accountFault: rdAccountFault,
};

// ---- Premiumize ----
// Verified live: /cache/check and /transfer/directdl exist and reject bad keys
// as documented. Cached items come back from directdl with links immediately,
// so there's no add/poll/delete cycle at all.
const PM_API = process.env.PREMIUMIZE_BASE || "https://www.premiumize.me/api";
const pmKey = () => process.env.PREMIUMIZE_API_KEY || "";

async function pmCall(path, params) {
  const qs = new URLSearchParams({ apikey: pmKey(), ...params });
  const r = await fetch(`${PM_API}${path}?${qs}`, { signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error(`Premiumize ${path}: unreadable response (${r.status})`);
  if (j.status === "error") throw new Error(`Premiumize ${path}: ${j.message || "error"}`);
  return j;
}

const premiumize = {
  name: "premiumize",
  label: "Premiumize",
  enabled: () => Boolean(pmKey()),
  async checkCached(hashes) {
    const out = new Set();
    // chunked: the query string is a URL, not a mailbox
    for (let i = 0; i < hashes.length; i += 50) {
      const batch = hashes.slice(i, i + 50);
      const qs = new URLSearchParams({ apikey: pmKey() });
      for (const h of batch) qs.append("items[]", h);
      const r = await fetch(`${PM_API}/cache/check?${qs}`, { signal: AbortSignal.timeout(20000) });
      const j = await r.json().catch(() => null);
      if (!j || j.status === "error") continue; // a failed probe must not veto the backend
      (j.response || []).forEach((isCached, k) => { if (isCached) out.add(batch[k]); });
    }
    return out;
  },
  async fromMagnet(magnet, { fileIdx = null } = {}) {
    const j = await pmCall("/transfer/directdl", { src: magnet });
    const files = j.content || [];
    if (!files.length) return null; // not cached here
    const videos = files.filter((f) => VIDEO_RE.test(f.path || ""));
    if (!videos.length) return null;
    const byIdx = fileIdx != null ? files[fileIdx] : null;
    const pick = (byIdx && VIDEO_RE.test(byIdx.path || "")) ? byIdx
      : videos.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
    const url = pick.stream_link || pick.link;
    if (!url) return null;
    return {
      url,
      // stream_link is Premiumize's browser-ready transcode; `link` is the raw file
      type: pick.stream_link && /\.m3u8/i.test(pick.stream_link) ? "hls" : "mp4",
      referer: "https://www.premiumize.me/",
      filename: (pick.path || "").split("/").pop(),
      torrentId: null, // directdl leaves nothing behind to clean up
    };
  },
  async remove() {},
  // Premiumize answers a bad or unpaid key with a status:"error" body, which
  // pmCall turns into prose — there is no code to switch on, so match the
  // shapes it actually sends.
  accountFault: (e) => (/not[_ ]logged[_ ]in|invalid.{0,12}(api)?[_ ]?key|premium|account/i.test(e?.message || "")
    ? "Premiumize rejected the API key (wrong, or the subscription has lapsed) — check PREMIUMIZE_API_KEY"
    : null),
};

export const backends = [realdebrid, premiumize];
export const enabledBackends = (list = backends) => list.filter((b) => b.enabled());
export const anyDebridEnabled = () => enabledBackends().length > 0;
export { hashOf };
