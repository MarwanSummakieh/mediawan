// Device pairing — signing a TV in without using the TV.
//
// Typing an email and password on a remote is miserable: an on-screen keyboard,
// one character per four D-pad presses. So the TV never asks for credentials.
// It asks the server for a short CODE, shows it, and polls. You open the app on
// a phone or laptop where you're already signed in, type the six characters,
// and the TV's next poll comes back with a session.
//
// Two secrets, deliberately: the CODE is short and human-typeable but only ever
// travels phone-ward, and the POLL TOKEN is long and random and only the TV that
// requested the pairing ever sees it. Someone who reads the code off a screen
// still cannot claim the session, because approving is what the code does and
// collecting is what the token does. That split is the whole security model, so
// don't let the code become sufficient on its own.
import crypto from "node:crypto";

// Read off a screen across a room and typed by hand, so drop the characters
// people mix up: I/L/1, O/0, U (looks like V in some TV fonts). 30 left, which
// is ~729 million six-character codes against a five-minute window.
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const CODE_LENGTH = 6;
export const TTL_MS = 5 * 60 * 1000;      // a code is worth nothing five minutes later
const MAX_PENDING = 50;                    // bound the store; TVs are few
export const MAX_ATTEMPTS = 10;            // wrong guesses before a pairing is burned

// code -> { code, pollToken, createdAt, expiresAt, userId|null, attempts, claimed }
const pending = new Map();

function randomCode() {
  let out = "";
  const bytes = crypto.randomBytes(CODE_LENGTH * 2);
  for (let i = 0; out.length < CODE_LENGTH && i < bytes.length; i++) {
    // reject bytes past the last whole multiple so every letter stays equally likely
    const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
    if (bytes[i] < limit) out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out.length === CODE_LENGTH ? out : randomCode();
}

export function sweep(now = Date.now()) {
  for (const [code, p] of pending) if (p.expiresAt <= now) pending.delete(code);
}

// The TV asks for a pairing. Returns what it needs to display and to poll with.
export function createPairing(now = Date.now()) {
  sweep(now);
  if (pending.size >= MAX_PENDING) {
    // drop the oldest rather than refuse — a flood is far likelier to be a TV
    // retry loop than an attack, and a refused pairing looks like a broken app
    const oldest = [...pending.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) pending.delete(oldest.code);
  }
  let code = randomCode();
  while (pending.has(code)) code = randomCode();
  const p = {
    code,
    pollToken: crypto.randomBytes(32).toString("hex"),
    createdAt: now,
    expiresAt: now + TTL_MS,
    userId: null,
    attempts: 0,
    claimed: false,
  };
  pending.set(code, p);
  return { code: p.code, pollToken: p.pollToken, expiresAt: p.expiresAt };
}

// A signed-in browser approves a code. `userId` is whoever is approving — that
// is the account the TV ends up signed in as.
const normalize = (raw) => String(raw || "").trim().toUpperCase().replace(/[\s-]/g, "");

export function approvePairing(rawCode, userId, now = Date.now()) {
  const code = normalize(rawCode);
  if (code.length !== CODE_LENGTH) return { ok: false, error: "bad-code" };
  // Look the entry up BEFORE sweeping: "that code expired, grab the new one off
  // the TV" is a far more useful thing to be told than "unknown code", and
  // sweeping first would erase the difference.
  const p = pending.get(code);
  sweep(now);
  if (!p) return { ok: false, error: "unknown-code" };
  if (p.expiresAt <= now) { pending.delete(code); return { ok: false, error: "expired" }; }
  if (p.userId) return { ok: false, error: "already-approved" };
  p.userId = userId;
  return { ok: true };
}

// The TV polls with its token. Once this returns a userId the pairing is spent —
// a replayed token must not mint a second session.
export function claimPairing(pollToken, now = Date.now()) {
  if (!pollToken) return { status: "unknown" };
  let found = null;
  for (const p of pending.values()) if (p.pollToken === pollToken) { found = p; break; }
  sweep(now); // as above: identify first, tidy after
  if (!found || found.claimed) return { status: "unknown" }; // spent → as if it never existed
  // Say "expired" rather than "unknown" so the TV can quietly ask for a fresh
  // code and reprint it, instead of leaving a dead one on screen.
  if (found.expiresAt <= now) { pending.delete(found.code); return { status: "expired" }; }
  if (!found.userId) return { status: "pending", expiresAt: found.expiresAt };
  found.claimed = true;
  pending.delete(found.code);
  return { status: "approved", userId: found.userId };
}

// Wrong guesses burn the pairing rather than the guesser's patience, so a code
// can't be ground down by a script that also knows it's only six characters.
export function noteFailedAttempt(rawCode) {
  const p = pending.get(normalize(rawCode));
  if (!p) return;
  if (++p.attempts >= MAX_ATTEMPTS) pending.delete(p.code);
}

// test seam
export function _reset() { pending.clear(); }
export function _size() { return pending.size; }
