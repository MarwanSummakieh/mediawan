// Asset acquisition and the worker's lifecycle.
//
// Two files are needed from VidLink: the Go wasm_exec glue (script.js) and the
// binary itself (fu.wasm, ~2.4 MB). They are fetched ONCE and cached on disk.
//
// ---- pinning, and why it fails closed ----
//
// Running someone else's binary is one thing; automatically running whatever
// they replace it with tomorrow is another. The second is a standing invitation
// into the process that holds the Real-Debrid token and the session database.
//
// So the first successful fetch records a SHA-256 of both files. Every later
// start re-checks them, and a change is refused with a message rather than
// executed. Re-pinning is a deliberate act: delete the cached assets, or set
// VIDLINK_PIN_WASM / VIDLINK_PIN_GLUE to the new digests.
//
// The cost is that a rebuild on their side takes this source down until someone
// looks at it. That is the correct trade for a FLOOR-tier source — it exists to
// make something play instantly, never to be load-bearing, and the registry's
// circuit breaker already treats it as disposable.
import { Worker } from "node:worker_threads";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.mjs";

const BASE = (process.env.VIDLINK_BASE || "https://vidlink.pro").replace(/\/+$/, "");
// Beside the database, NOT beside the media cache. The cache is an LRU that
// self-evicts, which would delete these; and deriving the path from CACHE_DIR
// puts them wherever that happens to point — the repo root in development, the
// root of the media array in production. The data directory is the one place
// that is always ours and always persistent.
const DATA_DIR = path.dirname(
  config.dbPath || path.join(fileURLToPath(new URL("../../../", import.meta.url)), "data.sqlite"));
const ASSET_DIR = path.join(DATA_DIR, "vidlink");
const WORKER = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const FETCH_TIMEOUT_MS = 60_000;

const PIN_WASM = (process.env.VIDLINK_PIN_WASM || "").toLowerCase().trim();
const PIN_GLUE = (process.env.VIDLINK_PIN_GLUE || "").toLowerCase().trim();

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Fetch once, then serve from disk. `expected` is the pinned digest, if any.
async function asset(name, url, expected) {
  const file = path.join(ASSET_DIR, name);
  let buf = await fsp.readFile(file).catch(() => null);
  if (!buf) {
    // Their edge 403s a request with no browser identity, which presents as
    // "the source is dead" rather than "we asked wrong".
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Referer: `${BASE}/`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`VidLink asset ${name}: upstream ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
    await fsp.mkdir(ASSET_DIR, { recursive: true });
    await fsp.writeFile(file, buf);
  }
  const got = sha256(buf);
  if (expected && got !== expected) {
    throw new Error(
      `VidLink ${name} digest ${got} does not match the pin ${expected} — refusing to run it. ` +
      `If this is a legitimate rebuild, delete ${file} and re-pin.`);
  }
  return { buf, digest: got };
}

// The pin file records what we ran the first time, so a later swap is visible
// even when no explicit env pin was set.
async function pinnedDigests() {
  const f = path.join(ASSET_DIR, "pins.json");
  const saved = await fsp.readFile(f, "utf8").then(JSON.parse).catch(() => ({}));
  return {
    file: f,
    wasm: PIN_WASM || saved.wasm || null,
    glue: PIN_GLUE || saved.glue || null,
    saved,
  };
}

let worker = null;
let seq = 0;
const pending = new Map();

async function ensureWorker() {
  if (worker) return worker;
  const pins = await pinnedDigests();
  const [glue, wasm] = await Promise.all([
    asset("script.js", `${BASE}/script.js`, pins.glue),
    asset("fu.wasm", `${BASE}/fu.wasm`, pins.wasm),
  ]);
  if (!pins.saved.wasm || !pins.saved.glue) {
    await fsp.writeFile(pins.file,
      JSON.stringify({ wasm: wasm.digest, glue: glue.digest, at: new Date().toISOString() }, null, 2));
    console.warn(`  [vidlink] pinned assets on first use — wasm ${wasm.digest.slice(0, 16)}…, glue ${glue.digest.slice(0, 16)}…`);
  }

  const w = new Worker(WORKER, {
    workerData: { glue: glue.buf.toString("utf8"), wasm: wasm.buf },
    // Nothing about this host leaks in. execArgv is emptied deliberately: the
    // server runs under --experimental-sqlite (and, in tests, --input-type),
    // and a worker that inherits the parent's node flags dies on startup with
    // an error that has nothing to do with this source.
    env: {}, argv: [], execArgv: [], stdout: true, stderr: true,
  });
  w.on("message", ({ reqId, token, error }) => {
    const p = pending.get(reqId);
    if (!p) return;
    pending.delete(reqId);
    error ? p.reject(new Error(error)) : p.resolve(token);
  });
  const die = (why) => {
    for (const p of pending.values()) p.reject(new Error(why));
    pending.clear();
    if (worker === w) worker = null;
  };
  w.on("error", (e) => die(`VidLink sandbox crashed: ${e.message}`));
  w.on("exit", () => die("VidLink sandbox exited"));
  w.unref(); // never hold the process open
  worker = w;
  return w;
}

// One token for one id. `id` is an IMDb id ("tt0120587") — verified live that
// the API accepts these directly, so no TMDB mapping is needed.
export async function token(id, { timeoutMs = 20_000 } = {}) {
  const w = await ensureWorker();
  const reqId = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error("VidLink token generation timed out"));
    }, timeoutMs);
    pending.set(reqId, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    w.postMessage({ reqId, id });
  });
}

// Tear the sandbox down — used by tests and by the admin "check now" probe.
export async function stopTokenSandbox() {
  const w = worker;
  worker = null;
  if (w) await w.terminate().catch(() => {});
}
