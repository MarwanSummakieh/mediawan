// The sandbox body: runs VidLink's WebAssembly and answers "give me a token".
//
// This file exists because the token that authorises VidLink's stream API is
// produced by a 2.4 MB Go/WASM binary they compile and serve. There is no
// stable id-based endpoint — a plain id returns an empty body — so using the
// source at all means running their code.
//
// WHY THIS IS ISOLATED, and how far the isolation actually goes:
//
//   • The WASM module itself has no ambient authority. WebAssembly can only
//     reach what its import object grants, and the only imports this binary
//     declares are Go's `gojs.*` syscall/js bridges, which we construct here.
//   • Those bridges let the Go code walk whatever object graph it is handed as
//     its global. So the global it gets is a purpose-built one containing the
//     eight things the glue needs and nothing else — no fetch, no require, no
//     process, no fs.
//   • It runs on a worker thread, so it shares no closures, no module registry
//     and no event loop with the server.
//
// What this is NOT: node:vm is not a security boundary against a determined
// escape, and a worker still lives in the same OS process. This is layered
// mitigation, not a guarantee — which is exactly why the provider ships
// disabled and has to be turned on deliberately. See ../vidlink.mjs.
//
// Verified by proxy-sniffing every property access during a real token
// generation: the binary touches exactly ONE crypto primitive,
// crypto_secretbox_easy — XSalsa20-Poly1305, which is tweetnacl's `secretbox`.
// That is why this needs an 8 KB dependency rather than all of libsodium.
import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";
import nacl from "tweetnacl";

const { glue, wasm } = workerData;

// The minimal world the Go runtime is allowed to see.
//
// Everything here is required by Go's wasm_exec glue; anything not here does
// not exist as far as the binary is concerned. Notably absent and deliberately
// so: fetch, XMLHttpRequest, WebSocket, process, require, import, Buffer.
// `fs` and `process` are NOT provided — the glue installs its own stubs when it
// finds none, and those stubs only write to a discarded stdout.
function makeGlobal() {
  const sandbox = {
    Object, Array, Number, String, Boolean, Symbol, Math, JSON, Date, Error,
    TypeError, RangeError, Promise, Reflect, Proxy, Map, Set, WeakMap, WeakSet,
    ArrayBuffer, DataView, Uint8Array, Uint16Array, Uint32Array, Int8Array,
    Int16Array, Int32Array, Float32Array, Float64Array, BigInt64Array,
    Uint8ClampedArray, TextEncoder, TextDecoder, WebAssembly,
    // Timers: Go's scheduler needs them. Bound so the binary cannot reach the
    // host timer objects themselves.
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    // Randomness for Go's runtime, from the host CSPRNG.
    crypto: { getRandomValues: (a) => globalThis.crypto.getRandomValues(a) },
    performance: { now: () => performance.now() },
    // Swallowed: the binary logs, and its logs are not ours to print.
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    // The single primitive the binary asks for.
    sodium: { crypto_secretbox_easy: (m, n, k) => nacl.secretbox(m, n, k) },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  return sandbox;
}

let getAdv = null;
let started = null;

async function start() {
  const sandbox = makeGlobal();
  const ctx = vm.createContext(sandbox);
  // The glue defines Go's runtime class; it is third-party code and runs with
  // the same restricted global as the binary it serves.
  vm.runInContext(glue, ctx, { timeout: 10_000 });
  // The class name is minified and changes whenever they rebuild (`Dm` at time
  // of writing), so it is found by SHAPE: a constructor whose prototype has a
  // `run` method and whose instances carry an `importObject`. The latter is
  // assigned in the constructor, not on the prototype, so it can only be
  // checked by constructing one.
  let go = null;
  for (const key of Object.keys(sandbox)) {
    const v = sandbox[key];
    if (typeof v !== "function" || !v.prototype || typeof v.prototype.run !== "function") continue;
    try {
      const candidate = new v();
      if (candidate && typeof candidate.importObject === "object" && candidate.importObject) {
        go = candidate;
        break;
      }
    } catch { /* not it */ }
  }
  if (!go) throw new Error("VidLink glue changed shape — no Go runtime class found");
  const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
  // Go's main() registers its exports and then blocks forever; this promise
  // never settles, which is correct and is why nothing awaits it.
  go.run(instance);
  // Registration happens on Go's scheduler, a tick or two after run().
  for (let i = 0; i < 40 && typeof sandbox.getAdv !== "function"; i++)
    await new Promise((r) => setTimeout(r, 50));
  if (typeof sandbox.getAdv !== "function")
    throw new Error("VidLink WASM did not register getAdv");
  getAdv = sandbox.getAdv;
}

parentPort.on("message", async ({ reqId, id }) => {
  try {
    started ??= start();
    await started;
    const token = getAdv(String(id));
    if (!token) throw new Error(`no token generated for "${id}"`);
    parentPort.postMessage({ reqId, token: String(token) });
  } catch (e) {
    // A failed start must be retryable — a transient hiccup should not wedge
    // the source until the server restarts.
    started = null;
    parentPort.postMessage({ reqId, error: e.message });
  }
});
