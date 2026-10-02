// Range-aware direct playback. The route supplies authentication; this handler
// owns file/response lifetimes so eviction cannot interrupt an active reader.
import fs from "node:fs";
import * as store from "./store.mjs";

export function serveCachedFile(req, res) {
  const row = store.lookup(req.params.key);
  if (!row || row.state !== "complete") return res.status(404).end("not cached");
  const release = store.playbackLease(row.key);
  let source;
  const finish = () => { source?.destroy(); release(); };
  res.once("finish", finish);
  res.once("close", finish);
  try {
    const size = fs.statSync(row.path).size;
    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    res.setHeader("Accept-Ranges", "bytes");
    const invalidRange = () => {
      res.setHeader("Content-Range", `bytes */${size}`);
      return res.status(416).end();
    };
    if (req.headers.range && !range) return invalidRange();
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if ((!range[1] && !range[2]) || start > end || !Number.isSafeInteger(start) || start >= size) return invalidRange();
      res.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", end - start + 1);
      source = fs.createReadStream(row.path, { start, end });
    } else {
      res.setHeader("Content-Length", size);
      source = fs.createReadStream(row.path);
    }
    source.once("error", () => { release(); res.destroy(); });
    source.pipe(res);
  } catch {
    release();
    res.status(404).end("not cached");
  }
}
