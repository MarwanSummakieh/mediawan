// Unit tests for TV device pairing. The security model is a split of secrets:
// the short CODE only ever authorises, the long POLL TOKEN only ever collects.
// Most of what's asserted here is that neither half can do the other's job.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createPairing, approvePairing, claimPairing, noteFailedAttempt,
  sweep, CODE_LENGTH, TTL_MS, MAX_ATTEMPTS, _reset, _size,
} from "../lib/pairing.mjs";

beforeEach(() => _reset());

test("createPairing: readable code, unrelated poll token, sane expiry", () => {
  const p = createPairing(1000);
  assert.equal(p.code.length, CODE_LENGTH);
  assert.match(p.code, /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]+$/); // no I/L/O/U/0/1
  assert.equal(p.expiresAt, 1000 + TTL_MS);
  assert.equal(p.pollToken.length, 64);
  assert.notEqual(p.pollToken, p.code);
});

test("the happy path: approve on a phone, collect on the TV", () => {
  const p = createPairing();
  assert.equal(claimPairing(p.pollToken).status, "pending");
  assert.deepEqual(approvePairing(p.code, 42), { ok: true });
  const claim = claimPairing(p.pollToken);
  assert.equal(claim.status, "approved");
  assert.equal(claim.userId, 42); // the TV signs in as whoever approved
});

test("the code alone cannot collect a session — only the poll token can", () => {
  const p = createPairing();
  approvePairing(p.code, 7);
  // someone who read the code off the screen tries to use it as a token
  assert.equal(claimPairing(p.code).status, "unknown");
  // the real TV is unaffected
  assert.equal(claimPairing(p.pollToken).status, "approved");
});

test("a pairing is single-use: a replayed token mints nothing", () => {
  const p = createPairing();
  approvePairing(p.code, 7);
  assert.equal(claimPairing(p.pollToken).status, "approved");
  assert.equal(claimPairing(p.pollToken).status, "unknown");
  assert.equal(_size(), 0);
});

test("codes are case- and separator-insensitive when approving", () => {
  const p = createPairing();
  assert.deepEqual(approvePairing(` ${p.code.toLowerCase()} `, 3), { ok: true });
});

test("approving twice is refused — one code, one device", () => {
  const p = createPairing();
  assert.deepEqual(approvePairing(p.code, 1), { ok: true });
  assert.deepEqual(approvePairing(p.code, 2), { ok: false, error: "already-approved" });
  assert.equal(claimPairing(p.pollToken).userId, 1);
});

test("unknown and malformed codes are rejected distinctly", () => {
  assert.deepEqual(approvePairing("", 1), { ok: false, error: "bad-code" });
  assert.deepEqual(approvePairing("ABC", 1), { ok: false, error: "bad-code" });
  assert.deepEqual(approvePairing("ZZZZZZ", 1), { ok: false, error: "unknown-code" });
});

test("expiry is reported as expiry, not as an unknown code", () => {
  const p = createPairing(0);
  // the distinction is the difference between "grab the new code off the TV"
  // and "you typed it wrong"
  assert.deepEqual(approvePairing(p.code, 1, TTL_MS + 1), { ok: false, error: "expired" });
  assert.deepEqual(approvePairing("ZZZZZZ", 1), { ok: false, error: "unknown-code" });
});

test("an expired poll tells the TV to reprint, and the store cleans up", () => {
  const p = createPairing(0);
  assert.equal(claimPairing(p.pollToken, TTL_MS + 1).status, "expired");
  sweep(TTL_MS + 1);
  assert.equal(_size(), 0);
});

test("an unapproved pairing still reports pending right up to expiry", () => {
  const p = createPairing(0);
  assert.equal(claimPairing(p.pollToken, TTL_MS - 1).status, "pending");
});

test("brute force burns the code rather than the attacker's time", () => {
  const p = createPairing();
  for (let i = 0; i < MAX_ATTEMPTS; i++) noteFailedAttempt(p.code);
  assert.equal(_size(), 0);
  assert.deepEqual(approvePairing(p.code, 1), { ok: false, error: "unknown-code" });
});

test("the store stays bounded when a TV retries in a loop", () => {
  for (let i = 0; i < 200; i++) createPairing(i);
  assert.ok(_size() <= 50, `expected the store to stay bounded, got ${_size()}`);
});

test("codes don't collide across a burst", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(createPairing(i).code);
  assert.equal(seen.size, 200);
});
