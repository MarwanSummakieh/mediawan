#!/usr/bin/env node
// Set a user's password directly in the database.
//
// The app seeds its admin ONCE — bootstrap() gives up the moment the users
// table has a row — so editing ADMIN_PASSWORD in .env does nothing after the
// first deploy. Passwords are stored as scrypt hashes and cannot be read back
// out. Between those two facts, a forgotten password used to mean being locked
// out of your own server with no way in. This is that way in.
//
// Run it INSIDE the container, where /data holds the live database:
//   node scripts/set-password.mjs you@example.com 'new-password'
//
// Reuses the app's own hashPassword, so the stored format can never drift from
// what the login route verifies against.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const [email, password] = process.argv.slice(2);
const MIN = Number(process.env.MIN_PASSWORD_LENGTH) || 8;

if (!email || !password) {
  console.error("usage: node scripts/set-password.mjs <email> <new-password>");
  console.error("       (quote the password if it contains spaces or symbols)");
  process.exit(1);
}
if (password.length < MIN) {
  console.error(`password must be at least ${MIN} characters`);
  process.exit(1);
}

// Same derivation as lib/db.mjs — imported rather than copied would drag in the
// whole schema-creating module, so the one function is mirrored here.
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pw, salt, 32);
  return `${salt.toString("hex")}:${dk.toString("hex")}`;
}

const dbFile = process.env.DB_PATH ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data.sqlite");
console.log(`database: ${dbFile}`);

const db = new DatabaseSync(dbFile);
const user = db.prepare("SELECT id, email, name, role FROM users WHERE lower(email)=lower(?)").get(email);
if (!user) {
  console.error(`\nno account with that email. accounts on this server:`);
  for (const u of db.prepare("SELECT email, role FROM users ORDER BY id").all())
    console.error(`  ${u.email}  (${u.role})`);
  process.exit(1);
}

db.prepare("UPDATE users SET pw_hash=?, active=1 WHERE id=?").run(hashPassword(password), user.id);
// Existing sessions keep working off their own tokens; drop them so a password
// change actually means something.
const sessions = db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
console.log(`\npassword updated for ${user.email} (${user.role})`);
console.log(`signed out ${sessions.changes} existing session(s) — sign in again with the new password`);
