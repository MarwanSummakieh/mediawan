// Which files can skip Real-Debrid's live transcoder?
//
// Every play used to go through it, including files a browser can already
// decode. That costs an extra API round trip plus RD's transcoder spin-up on
// each start — the pause before a film begins — and turns seeking into segment
// hunting instead of a byte-range request. The rule has to hold for BOTH
// targets at once: desktop browsers and the TV's Chromium 69 webview.
import { test } from "node:test";
import assert from "node:assert/strict";
import { playsNatively } from "../lib/debrid/realdebrid.mjs";

test("H.264 MP4 plays as-is — the common case, and the one worth skipping the transcode for", () => {
  assert.equal(playsNatively("Interstellar.2014.1080p.BluRay.x264-YIFY.mp4", "video/mp4"), true);
  assert.equal(playsNatively("Movie.2019.720p.WEB-DL.h264.m4v", "video/mp4"), true);
  assert.equal(playsNatively("Movie.mp4", ""), true); // RD sometimes reports no mimeType
});

test("containers a browser cannot open still get remuxed", () => {
  assert.equal(playsNatively("Movie.2014.1080p.BluRay.x264-GROUP.mkv", "video/x-matroska"), false);
  assert.equal(playsNatively("Old.Movie.avi", "video/x-msvideo"), false);
  assert.equal(playsNatively("Movie.ts", "video/mp2t"), false);
});

test("HEVC is remuxed even inside an MP4 — TVs decode it, desktop Chrome mostly doesn't", () => {
  assert.equal(playsNatively("Movie.2014.2160p.x265-GROUP.mp4", "video/mp4"), false);
  assert.equal(playsNatively("Movie.2014.1080p.HEVC.mp4", "video/mp4"), false);
  assert.equal(playsNatively("Movie.2014.1080p.h.265.mp4", "video/mp4"), false);
});

test("a contradicting mimeType wins over the extension", () => {
  assert.equal(playsNatively("Movie.mp4", "video/x-matroska"), false);
});

test("missing or malformed input never claims native playback by accident", () => {
  assert.equal(playsNatively("", ""), false);
  assert.equal(playsNatively(null, null), false);
  assert.equal(playsNatively(undefined, "video/mp4"), false);
});
