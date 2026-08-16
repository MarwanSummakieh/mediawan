#!/usr/bin/env node
// Push the built package to a Samsung TV over the network.
//
//   npm run tv-install -- 192.168.1.42
//
// The TV has to be in Developer Mode first (Apps screen → press 12345 on the
// remote → Developer Mode on → enter this PC's IP → reboot the TV). sdb speaks
// to it over port 26101; nothing here touches the Samsung account.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ip = process.argv[2];
if (!ip) {
  console.error("usage: npm run tv-install -- <tv-ip>   (find it in the TV's network settings)");
  process.exit(1);
}

const CANDIDATES = [
  path.join(os.homedir(), ".tizen-extension-platform", "server", "sdktools", "data", "tools", "sdb.exe"),
  path.join(os.homedir(), "tizen-studio", "tools", "sdb.exe"),
  path.join("C:", "tizen-studio", "tools", "sdb.exe"),
];
const TZ = [
  path.join(os.homedir(), ".tizen-extension-platform", "server", "sdktools", "data", "tools", "tizen-core", "tz.exe"),
  path.join(os.homedir(), "tizen-studio", "tools", "tizen-core", "tz.exe"),
];
const sdb = CANDIDATES.find(existsSync) || "sdb";
const tz = TZ.find(existsSync) || "tz";

const wgt = ["Debug", "Release"]
  .map((b) => path.join(REPO, "tizen", "Mediawan", b, "Mediawan.wgt"))
  .find(existsSync);
if (!wgt) {
  console.error("no Mediawan.wgt yet — run `npm run tv-build` first.");
  process.exit(1);
}

const sh = (bin, argv) => {
  const r = spawnSync(bin, argv, { encoding: "utf8" });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  return r.status ?? 1;
};

console.log(`connecting to ${ip}…`);
if (sh(sdb, ["connect", ip]) !== 0) {
  console.error("\nsdb could not reach the TV. Check that it's on the same network and that");
  console.error("Developer Mode is on with this PC's IP entered, then reboot the TV.");
  process.exit(1);
}
sh(sdb, ["devices"]);
// sdb identifies a network target as "<ip>:<port>" — that's the serial tz wants.
const serial = ip.includes(":") ? ip : `${ip}:26101`;
console.log(`\ninstalling ${path.basename(wgt)} to ${serial}…`);
const code = sh(tz, ["install", "-p", wgt, "-e", serial]);
if (code !== 0) {
  console.error("\nInstall failed.");
  console.error("  'Parsing error'  → config.xml is malformed. The usual culprit is the package");
  console.error("                     id, which must be EXACTLY 10 alphanumeric characters.");
  console.error("  certificate/     → the TV wants a Samsung distributor certificate tied to its");
  console.error("  signature error    DUID; make one in Certificate Manager (Samsung account) and");
  console.error("                     re-run: npm run tv-build -- --profile <name>");
  process.exit(code);
}

// Start it so the TV lands on the app rather than leaving it sitting in the
// Apps row. `run` takes the PACKAGE id, not the application id.
console.log("\nlaunching…");
process.exit(sh(tz, ["run", "-p", "MediawanTV", "-e", serial]));
