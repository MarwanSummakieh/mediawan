#!/usr/bin/env node
// Build + sign the Samsung TV package (tizen/Mediawan → Mediawan.wgt).
//
// The Tizen CLI ships inside the VS Code Tizen extension rather than on PATH,
// and its location is user-specific, so find it rather than hard-coding a path.
// Everything else is `tz build` + `tz pack -t wgt` against the signing profile.
//
//   npm run tv-build                                        # points at production
//   npm run tv-build -- --url http://192.168.1.5:8787/?tv=1 # point at a dev server
//   npm run tv-build -- --profile samsung --release
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = path.join(REPO, "tizen", "Mediawan");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const profile = flag("profile", "mediawan");
const buildType = args.includes("--release") ? "Release" : "Debug";
const url = flag("url", null);

// The extension unpacks the SDK under ~/.tizen-extension-platform; a full Tizen
// Studio install puts the same binary under ~/tizen-studio. Accept either, and
// fall back to whatever `tz` is on PATH.
const CANDIDATES = [
  path.join(os.homedir(), ".tizen-extension-platform", "server", "sdktools", "data", "tools", "tizen-core", "tz.exe"),
  path.join(os.homedir(), "tizen-studio", "tools", "tizen-core", "tz.exe"),
  path.join("C:", "tizen-studio", "tools", "tizen-core", "tz.exe"),
];
const tz = CANDIDATES.find(existsSync) || "tz";
const sdkData = path.join(os.homedir(), ".tizen-extension-platform", "server", "sdktools", "sdk-data");
const profiles = path.join(sdkData, "profile", "profiles.xml");

// Throws rather than process.exit(): exit() skips `finally`, and the finally
// below is what puts config.xml back after a --url rewrite. One failed build
// once leaked a dev URL into the widget — and every later build then treated
// the dirty file as the original. Never again.
function run(label, argv) {
  const r = spawnSync(tz, argv, { cwd: PROJECT, encoding: "utf8" });
  if (r.error) {
    console.error(`\n${label} could not run the Tizen CLI (${tz}).`);
    console.error("Install the Tizen extension for VS Code, or Tizen Studio with the TV extension.");
    throw new Error(`${label}: tizen CLI unavailable`);
  }
  process.stdout.write(r.stdout || "");
  if (r.status !== 0) {
    process.stderr.write(r.stderr || "");
    throw new Error(`${label} failed (exit ${r.status})`);
  }
}

if (!existsSync(PROJECT)) {
  console.error(`missing project directory: ${PROJECT}`);
  process.exit(1);
}
console.log(`tizen cli: ${tz}\nprofile:   ${profile} (${buildType})`);

// --url repoints the widget at a dev server for a hardware test, then puts
// config.xml back — the file on disk stays canonical (production) either way,
// so a half-finished test can't quietly ship a LAN address to the TV.
const configPath = path.join(PROJECT, "config.xml");
const original = readFileSync(configPath, "utf8");
if (url) {
  const origin = new URL(url).origin;
  const xmlUrl = url.replace(/&/g, "&amp;"); // a raw & is invalid XML — tz dies with a cryptic "invalid path"
  writeFileSync(configPath, original
    .replace(/<content src="[^"]*"\/>/, `<content src="${xmlUrl}"/>`)
    .replace(/(<tizen:allow-navigation>)([^<]*)(<\/tizen:allow-navigation>)/, `$1$2 ${origin}$3`));
  console.log(`url:       ${url}  (config.xml restored afterwards)`);
}
console.log("");
let failed = null;
try {
  run("build", ["build", "-b", buildType, "."]);
  const packArgs = ["pack", "-t", "wgt", "-s", profile, "."];
  if (existsSync(profiles)) packArgs.push("-p", profiles);
  run("pack", packArgs);
} catch (e) {
  failed = e;
} finally {
  if (url) writeFileSync(configPath, original); // ALWAYS undo the --url rewrite
}
if (failed) {
  console.error(`\n${failed.message}`);
  process.exit(1);
}

const out = path.join(PROJECT, buildType, "Mediawan.wgt");
console.log(existsSync(out)
  ? `\n${out}\nInstall it with:  npm run tv-install -- <tv-ip>`
  : "\npack reported success but no Mediawan.wgt was found — check the output above.");
