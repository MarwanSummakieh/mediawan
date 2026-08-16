// Unit tests for the playUrl builder — the direct-vs-proxied decision.
// The invariant that matters: a direct Real-Debrid playUrl NEVER ships without
// its proxied fallbackUrl, because direct is allowed to fail (IP-locked links
// for remote members, a CORS change on RD's side) and the player leans on the
// fallback to degrade gracefully instead of breaking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toPlayable, isRdUrl, proxyUrl } from "../lib/playable.mjs";

const sign = (url) => "tok-" + url.length; // deterministic stand-in for signMediaToken
const rdHls = { url: "https://4.stream.real-debrid.com/t/ABC/full.m3u8", type: "hls", referer: "https://real-debrid.com/", quality: "1080" };
const rdMp4 = { url: "https://31.download.real-debrid.com/d/TOK/Movie.mkv", type: "mp4", referer: "https://real-debrid.com/" };
// A floor-tier stream, as lib/providers/vidlink.mjs builds it: the host's own
// gating headers travel with the URL because a media element cannot set them.
const scraper = { url: "https://cdn.example.net/ep1.m3u8", type: "hls", referer: "https://animepahe.ru/", origin: "https://animepahe.ru" };

test("isRdUrl: real-debrid hosts and nothing else", () => {
  assert.equal(isRdUrl(rdHls.url), true);
  assert.equal(isRdUrl(rdMp4.url), true);
  assert.equal(isRdUrl(scraper.url), false);
  assert.equal(isRdUrl("https://evil.com/real-debrid.com/x"), false); // host, not path
  assert.equal(isRdUrl("https://notreal-debrid.com/x"), false);       // suffix must be a label
  assert.equal(isRdUrl("not a url"), false);
});

test("RD stream: direct playUrl, proxied fallback rides along", () => {
  const p = toPlayable(rdHls, { sign, direct: true });
  assert.equal(p.playUrl, rdHls.url);
  assert.ok(p.fallbackUrl.startsWith("/proxy/hls?url="));
  assert.match(p.fallbackUrl, /t=tok-/);
  assert.equal(p.quality, "1080"); // the rest of the stream shape passes through
});

test("RD mp4 falls back through /proxy/mp4, hls through /proxy/hls", () => {
  assert.ok(toPlayable(rdMp4, { sign, direct: true }).fallbackUrl.startsWith("/proxy/mp4?"));
  assert.ok(toPlayable(rdHls, { sign, direct: true }).fallbackUrl.startsWith("/proxy/hls?"));
});

test("scraper stream: proxy-only, no fallback field", () => {
  const p = toPlayable(scraper, { sign, direct: true });
  assert.ok(p.playUrl.startsWith("/proxy/hls?url="));
  assert.equal(p.fallbackUrl, undefined);
  assert.match(p.playUrl, /referer=https%3A%2F%2Fanimepahe\.ru%2F/);
});

// Some embed hosts check Origin as well as Referer and 403 without it, which is
// indistinguishable from a dead source at the player. It is omitted rather than
// guessed when the source didn't state one — a wrong Origin is rejected where a
// missing one is usually allowed.
test("proxyUrl: carries Origin when the source gave one, omits it otherwise", () => {
  assert.match(proxyUrl(scraper, sign), /origin=https%3A%2F%2Fanimepahe\.ru/);
  const noOrigin = { ...scraper, origin: "" };
  assert.equal(/[?&]origin=/.test(proxyUrl(noOrigin, sign)), false);
});

test("RD_DIRECT off: even RD streams stay proxied (the kill switch)", () => {
  const p = toPlayable(rdHls, { sign, direct: false });
  assert.ok(p.playUrl.startsWith("/proxy/hls?"));
  assert.equal(p.fallbackUrl, undefined);
});

// Real-Debrid serves plain http:// links unless the account is set to
// "Download Port: Secured". An https:// page cannot load http:// media —
// browsers block it as mixed content — so a direct http link would simply not
// play in production.
test("an http debrid link is proxied, never handed over directly", () => {
  const insecure = { ...rdHls, url: "http://4.stream.real-debrid.com/t/ABC/full.m3u8" };
  const p = toPlayable(insecure, { sign, direct: true });
  assert.ok(p.playUrl.startsWith("/proxy/hls?"), "must route through the proxy");
  assert.equal(p.fallbackUrl, undefined, "the proxy IS the path — no second option needed");
});

test("https debrid links still go direct", () => {
  assert.equal(toPlayable(rdHls, { sign, direct: true }).playUrl, rdHls.url);
});

test("proxyUrl signs the exact upstream url", () => {
  const u = proxyUrl(rdHls, sign);
  assert.match(u, new RegExp("t=tok-" + rdHls.url.length + "$"));
});
