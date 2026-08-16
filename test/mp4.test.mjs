// Can this MP4 be streamed straight to a browser?
//
// Regression under test, from a real release: House of the Dragon S01E01.mp4,
// 1.84 GB, laid out ftyp/free/mdat with `moov` at the very end. Serving that
// untouched gave stuttering video and smeared audio, because the browser can't
// index the file without reaching the end of it. "H.264 in an MP4" was not a
// sufficient test — layout and audio codec matter too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { topLevelBoxes, isFastStart, audioIsBrowserSafe, canStreamDirectly } from "../lib/mp4.mjs";

// Build a box: 4-byte size, 4-char type, payload.
function box(type, payload = Buffer.alloc(0), declaredSize) {
  const size = declaredSize ?? payload.length + 8;
  const b = Buffer.alloc(8);
  b.writeUInt32BE(size, 0);
  b.write(type, 4, "latin1");
  return Buffer.concat([b, payload]);
}
const faststart = (audio = "mp4a") => Buffer.concat([
  box("ftyp", Buffer.from("isom")),
  box("moov", Buffer.concat([Buffer.from("....avc1...."), Buffer.from(`....${audio}....`)])),
  box("mdat", Buffer.alloc(64)),
]);
// the real-world broken layout: media first, index somewhere past our prefix
const notFaststart = Buffer.concat([
  box("ftyp", Buffer.from("isom")),
  box("free", Buffer.alloc(8)),
  box("mdat", Buffer.alloc(200), 1_836_200_000), // declares a huge size we never read
]);

test("topLevelBoxes walks a normal header", () => {
  const boxes = topLevelBoxes(faststart());
  assert.deepEqual(boxes.map((b) => b.type), ["ftyp", "moov", "mdat"]);
});

test("the actual bug: moov after mdat is refused", () => {
  assert.equal(isFastStart(notFaststart), false);
  assert.equal(canStreamDirectly(notFaststart).ok, false);
  assert.match(canStreamDirectly(notFaststart).why, /faststart/);
});

test("a properly laid-out file with AAC is allowed through", () => {
  assert.equal(isFastStart(faststart()), true);
  assert.equal(canStreamDirectly(faststart()).ok, true);
});

test("audio the browser can't decode is refused even when the layout is fine", () => {
  for (const codec of ["ac-3", "ec-3", "dtsc", "fLaC"]) {
    const buf = faststart(codec);
    assert.equal(isFastStart(buf), true, `${codec}: layout is fine`);
    assert.equal(canStreamDirectly(buf).ok, false, `${codec} must not stream directly`);
    assert.match(canStreamDirectly(buf).why, /audio/);
  }
});

test("an undetermined audio codec is refused — remuxing always works, guessing doesn't", () => {
  const noAudioInfo = Buffer.concat([box("ftyp", Buffer.from("isom")), box("moov", Buffer.from("....avc1....")), box("mdat", Buffer.alloc(16))]);
  assert.equal(audioIsBrowserSafe(noAudioInfo), null);
  assert.equal(canStreamDirectly(noAudioInfo).ok, false);
});

test("a truncated prefix that never reaches moov is refused, not assumed", () => {
  assert.equal(isFastStart(box("ftyp", Buffer.from("isom"))), false);
  assert.equal(isFastStart(Buffer.alloc(0)), false);
});

test("garbage never sends the walker into a loop", () => {
  assert.deepEqual(topLevelBoxes(Buffer.from("not an mp4 at all, really")), []);
  const zeroSize = Buffer.concat([box("ftyp", Buffer.alloc(4), 0), box("moov")]);
  assert.ok(topLevelBoxes(zeroSize).length <= 32);
});

test("64-bit extended box sizes are handled", () => {
  const b = Buffer.alloc(16);
  b.writeUInt32BE(1, 0);
  b.write("mdat", 4, "latin1");
  b.writeBigUInt64BE(9_000_000_000n, 8);
  const boxes = topLevelBoxes(Buffer.concat([box("ftyp", Buffer.from("isom")), b]));
  assert.deepEqual(boxes.map((x) => x.type), ["ftyp", "mdat"]);
  assert.equal(boxes[1].size, 9_000_000_000);
});
