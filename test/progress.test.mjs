// Watch progress across all three verticals.
//
// The bug being locked down: progress was keyed on an AniList id, so a film had
// nothing to key a row on and recorded NOTHING — Continue Watching could only
// ever show anime. This covers the generalised store and, importantly, the
// migration, because an existing install already has rows in the old shape and
// a rebuild that loses them is worse than the missing feature.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ONE database for the whole file, seeded in the pre-migration shape.
//
// It has to be one: db.mjs reads its path from lib/config.mjs, which is
// evaluated on first import and cached by the ESM loader, so a later DB_PATH
// change has no effect no matter how the db module itself is re-imported.
// Cases are kept apart by USER instead — which the store separates anyway.
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mediawan-test-")), "test.sqlite");
{
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE progress (
      user_id    INTEGER NOT NULL,
      anilist_id INTEGER NOT NULL,
      title      TEXT NOT NULL,
      cover      TEXT,
      episode    TEXT NOT NULL,
      seconds    REAL NOT NULL DEFAULT 0,
      duration   REAL NOT NULL DEFAULT 0,
      updated    INTEGER NOT NULL,
      PRIMARY KEY (user_id, anilist_id)
    );
    INSERT INTO progress VALUES (1, 135865, 'Saga of Tanya the Evil Season 2', 'cover.jpg', '4', 300, 1400, 1000);
  `);
  legacy.close();
}
process.env.DB_PATH = file;
const db = await import("../lib/db.mjs");

// `updated` is a millisecond clock, so writes issued back-to-back tie and
// ORDER BY leaves tied rows in an arbitrary order. Anywhere recency is the
// thing under test, separate the writes.
const tick = () => new Promise((r) => setTimeout(r, 5));

test("migration: existing anime rows survive the rebuild", () => {
  const rows = db.getContinueWatching(1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "anime");
  assert.equal(rows[0].media_id, "135865");
  assert.equal(rows[0].title, "Saga of Tanya the Evil Season 2");
  assert.equal(rows[0].cover, "cover.jpg");
  assert.equal(rows[0].episode, "4");
  assert.equal(rows[0].seconds, 300);
  // and the anime lookups still find it by its numeric id
  assert.equal(db.getProgressFor(1, "anime", 135865).seconds, 300);
  assert.equal(db.getWatchedTitles(1)[0].anilist_id, 135865);
});

test("migration is idempotent — re-running the guard changes nothing", async () => {
  await import("../lib/db.mjs?again=1"); // fresh module instance, same file
  assert.equal(db.getContinueWatching(1).length, 1);
  assert.equal(db.getProgressFor(1, "anime", 135865).title, "Saga of Tanya the Evil Season 2");
});

test("one row per vertical, ordered by recency across all of them", async () => {
  const u = 2;
  db.saveProgress({ userId: u, kind: "anime", mediaId: 135865, title: "Tanya", episode: "4", seconds: 300, duration: 1400 });
  await tick();
  db.saveProgress({ userId: u, kind: "movie", mediaId: "tt0816692", title: "Interstellar", seconds: 600, duration: 10140 });
  await tick();
  db.saveProgress({ userId: u, kind: "tv", mediaId: "tt0903747", title: "Breaking Bad", season: 2, episode: "4", seconds: 120, duration: 2800 });

  const rows = db.getContinueWatching(u);
  assert.deepEqual(rows.map((r) => r.kind), ["tv", "movie", "anime"], "newest first, regardless of vertical");
  assert.equal(rows.find((r) => r.kind === "tv").season, 2);
  assert.equal(rows.find((r) => r.kind === "movie").episode, ""); // a film has none
  assert.equal(rows.find((r) => r.kind === "anime").season, null);
});

test("ids from different verticals never collide", () => {
  const u = 3;
  // Same string, different kinds — these are two unrelated things.
  db.saveProgress({ userId: u, kind: "movie", mediaId: "tt1", title: "A film", seconds: 10, duration: 100 });
  db.saveProgress({ userId: u, kind: "tv", mediaId: "tt1", title: "A show", season: 1, episode: "1", seconds: 20, duration: 100 });
  assert.equal(db.getContinueWatching(u).length, 2);
  assert.equal(db.getProgressFor(u, "movie", "tt1").title, "A film");
  assert.equal(db.getProgressFor(u, "tv", "tt1").title, "A show");
});

test("a TV row tracks the show, moving with the episode", () => {
  const u = 4;
  const save = (season, episode, seconds) => db.saveProgress({
    userId: u, kind: "tv", mediaId: "tt0903747", title: "Breaking Bad", season, episode, seconds, duration: 2800,
  });
  save(1, "1", 2000);
  save(1, "2", 90);
  const rows = db.getContinueWatching(u);
  assert.equal(rows.length, 1, "one row per show, not one per episode");
  assert.equal(rows[0].episode, "2");
  assert.equal(rows[0].seconds, 90);
});

test("a null title or cover never erases the one already stored", () => {
  const u = 5;
  // First write knows the film; a later one (a deep link, which has no catalog
  // record) knows only the id — and used to blank the card's art.
  db.saveProgress({ userId: u, kind: "movie", mediaId: "tt0816692", title: "Interstellar", cover: "poster.jpg", seconds: 10, duration: 10140 });
  db.saveProgress({ userId: u, kind: "movie", mediaId: "tt0816692", title: null, cover: null, seconds: 900, duration: 10140 });
  const row = db.getProgressFor(u, "movie", "tt0816692");
  assert.equal(row.title, "Interstellar");
  assert.equal(row.cover, "poster.jpg");
  assert.equal(row.seconds, 900); // the position still advanced
});

test("an unknown title inserts cleanly and is repairable later", () => {
  const u = 6;
  // `title` is NOT NULL, so the very first write of a deep-linked film — which
  // knows nothing but the id — must not blow up on the constraint.
  db.saveProgress({ userId: u, kind: "movie", mediaId: "tt0111161", title: null, seconds: 30, duration: 8520 });
  assert.equal(db.getProgressFor(u, "movie", "tt0111161").title, "");
  db.saveProgress({ userId: u, kind: "movie", mediaId: "tt0111161", title: "The Shawshank Redemption", cover: "p.jpg", seconds: 60, duration: 8520 });
  assert.equal(db.getProgressFor(u, "movie", "tt0111161").title, "The Shawshank Redemption");
});

test("a finished FILM drops out of Continue Watching", () => {
  const u = 7;
  db.saveProgress({ userId: u, kind: "movie", mediaId: "done", title: "Watched to the end", seconds: 9900, duration: 10000 });
  db.saveProgress({ userId: u, kind: "movie", mediaId: "midway", title: "Half watched", seconds: 5000, duration: 10000 });
  // Duration unknown — still loading when the ping fired. Unknown is not finished.
  db.saveProgress({ userId: u, kind: "movie", mediaId: "unknown", title: "No duration yet", seconds: 5000, duration: 0 });

  const ids = db.getContinueWatching(u).map((r) => r.media_id);
  assert.ok(!ids.includes("done"), "a finished film has nowhere to continue to");
  assert.ok(ids.includes("midway"));
  assert.ok(ids.includes("unknown"));
});

test("a finished EPISODE keeps its show in Continue Watching", () => {
  const u = 11;
  // Finishing an episode means the viewer is mid-series, not done with it —
  // dropping the show here would hide it exactly when it matters most.
  db.saveProgress({ userId: u, kind: "tv", mediaId: "tt0903747", title: "Breaking Bad", season: 1, episode: "1", seconds: 2790, duration: 2800 });
  db.saveProgress({ userId: u, kind: "anime", mediaId: 21, title: "ONE PIECE", episode: "3", seconds: 1399, duration: 1400 });
  assert.deepEqual(
    db.getContinueWatching(u).map((r) => r.kind).sort(),
    ["anime", "tv"]);
});

test("recommendations are seeded from anime only", () => {
  const u = 8;
  db.saveProgress({ userId: u, kind: "anime", mediaId: 135865, title: "Tanya", episode: "4", seconds: 300, duration: 1400 });
  db.saveProgress({ userId: u, kind: "movie", mediaId: "tt0816692", title: "Interstellar", seconds: 600, duration: 10140 });
  const watched = db.getWatchedTitles(u);
  assert.equal(watched.length, 1, "an IMDb id resolves to nothing in the AniList meta cache");
  assert.equal(watched[0].anilist_id, 135865);
});

test("progress is per user", () => {
  db.saveProgress({ userId: 9, kind: "movie", mediaId: "tt1", title: "A film", seconds: 10, duration: 100 });
  db.saveProgress({ userId: 10, kind: "movie", mediaId: "tt1", title: "A film", seconds: 80, duration: 100 });
  assert.equal(db.getProgressFor(9, "movie", "tt1").seconds, 10);
  assert.equal(db.getProgressFor(10, "movie", "tt1").seconds, 80);
});
