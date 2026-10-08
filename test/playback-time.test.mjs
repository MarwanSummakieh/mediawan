import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockTime, playbackPosition, seekPlan, atTitleEnd } from '../public/playback-time.js';

test('full title clock is independent of an HLS conversion window and retains resume offset', () => {
  assert.equal(clockTime(8700.64), '2:25:00');
  assert.equal(clockTime(playbackPosition(12, 1800, 8700.64)), '30:12');
  assert.equal(playbackPosition(80, 8690, 8700.64), 8700.64);
  assert.equal(clockTime(0), '0:00');
});
test('seeking before or beyond converted media restarts from the full-title target', () => {
  assert.deepEqual(seekPlan(3600, 8700, 1800, true, [[0, 60]]), {
    position: 3600,
    relative: 1800,
    restart: true,
  });
  assert.deepEqual(seekPlan(300, 8700, 1800, true, [[0, 60]]), {
    position: 300,
    relative: -1500,
    restart: true,
  });
  assert.equal(seekPlan(1830, 8700, 1800, true, [[0, 60]]).restart, false);
  assert.equal(
    seekPlan(1830, 8700, 1800, true, [
      [0, 10],
      [40, 60],
    ]).restart,
    true,
  );
  assert.equal(seekPlan(3600, 8700, 0, false, []).restart, false);
  assert.equal(seekPlan(-100, 8700, 0, false, []).position, 0);
});
test('end of a converted fragment must not complete a movie or advance the queue', () => {
  assert.equal(atTitleEnd(60, 8700), false);
  assert.equal(atTitleEnd(1860, 8700), false);
  assert.equal(atTitleEnd(8699, 8700), true);
  assert.equal(atTitleEnd(0, 0), false);
});
