#!/usr/bin/env node
// Down-level the frontend for old TV webviews.
//
// Samsung's 2020 sets run Tizen 5.5 = Chromium 69, which predates optional
// chaining (`?.`), nullish coalescing (`??`) and the CSS `inset` shorthand.
// The app uses all three heavily, so on those TVs app.js is a SYNTAX ERROR:
// the script never parses, nothing boots, and the screen is black. Nothing in
// the console, nothing in the logs — the parse fails before any of our code runs.
//
// So: one esbuild pass per asset into public/tv-build/. server.mjs serves those
// copies to Tizen user agents and the originals to everyone else, so desktop
// browsers keep getting the untouched source and this stays a TV-only concern.
// If public/tv-build/ is missing the server just serves the originals — the
// build is optional, not load-bearing, for anything but the TV.
//
//   npm run build:tv
import { build } from "esbuild";
import { readdirSync, statSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO, "public");
const OUT = path.join(SRC, "tv-build");

// Chromium 69 is the floor: Tizen 5.5 (2020 sets). Newer TVs are all above it.
const TARGET = "chrome69";
const ASSETS = ["app.js", "tv.js", "config.js", "styles.css", "tv.css"];

mkdirSync(OUT, { recursive: true });

let failed = false;
for (const name of ASSETS) {
  const infile = path.join(SRC, name);
  const outfile = path.join(OUT, name);
  try {
    await build({
      entryPoints: [infile],
      outfile,
      target: TARGET,
      bundle: false,   // these are plain scripts, not modules — no bundling
      minify: false,   // keep it readable; the TV is on the LAN, size is moot
      legalComments: "none",
      logLevel: "warning",
    });
    const before = statSync(infile).size, after = statSync(outfile).size;
    console.log(`  ${name.padEnd(12)} ${before} → ${after} bytes`);
  } catch (e) {
    failed = true;
    console.error(`  ${name}: ${e.message}`);
  }
}

// Guard against a silent regression: if anything post-Chromium-69 survives into
// the output, the TV would black-screen again with no other clue.
const BANNED = [
  [/\?\./, "optional chaining (needs Chromium 80)"],
  [/\?\?/, "nullish coalescing (needs Chromium 80)"],
  [/(^|[;{\s])inset\s*:/, "CSS inset shorthand (needs Chromium 87)"],
  [/\.at\(-/, "Array.prototype.at (needs Chromium 92)"],
  [/\breplaceAll\(/, "String.replaceAll (needs Chromium 85)"],
  [/\|\|=|&&=|\?\?=/, "logical assignment (needs Chromium 85)"],
];
for (const name of readdirSync(OUT)) {
  const text = readFileSync(path.join(OUT, name), "utf8");
  for (const [re, why] of BANNED) {
    if (re.test(text)) {
      failed = true;
      console.error(`  ${name}: still contains ${why}`);
    }
  }
}

console.log(failed ? "\nTV build FAILED" : `\nTV assets written to public/tv-build (target ${TARGET})`);
process.exit(failed ? 1 : 0);
