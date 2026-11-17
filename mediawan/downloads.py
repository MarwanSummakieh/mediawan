"""Season downloads: whole seasons of a TV show saved into the library, over BitTorrent.

TV shows only. Asking for a season queues one job per aired episode. A single worker takes them
in order, and each episode goes through exactly what streaming does to choose a release
(torrent.py): the hard rules and ranking, the season lock that keeps a season on one group or
pack, the older-series ("sitcom") rules that fall back to 720p or SD when nothing sound exists
at 1080p and refuse a revival labelled with another year, the wrong-episode check, and the
viewer's streaming filter (trusted groups first, files read for subtitles before they are
taken). The quality is chosen once for the season, from its first episode, and kept.

Once a release is chosen its file is switched to "download" mode in the torrent engine
(torrentd.py), which fetches it whole, inside the VPN. When it is complete the file is copied
from the engine into DOWNLOAD_DIR (the library's TV folder, mounted writable only there) as
"<Show>/Season NN/<Show> - SxxEyy.<ext>", and a library scan picks it up.
"""

import json
import logging
import os
import re
import threading
import time
from pathlib import Path

import httpx

from .db import Database
from .parse import normalise
from .torrent import LABELS, TorrentError, Torrents, summary

log = logging.getLogger("mediawan.downloads")

ACTIVE = ("finding", "downloading", "copying")
_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')


class DownloadError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def safe_name(text: str) -> str:
    """A folder or file name that is valid everywhere: no separators, no reserved characters."""
    text = _UNSAFE.sub(" ", text or "").strip(" .")
    return re.sub(r"\s+", " ", text)[:120] or "Untitled"


class Downloads:
    def __init__(
        self,
        db: Database,
        torrents: Torrents,
        root: Path | None,
        title_of,
        on_saved=lambda: None,
        poll: float = 1.0,
        client: httpx.Client | None = None,
        background: bool = True,
    ):
        """title_of(imdb_id) -> the catalog's show (catalog.title). on_saved() runs after each
        episode lands in the library (a scan)."""
        self.db, self.torrents, self.root = db, torrents, Path(root) if root else None
        self.title_of, self.on_saved, self.poll = title_of, on_saved, poll
        self.client = client or httpx.Client(timeout=httpx.Timeout(30, read=120), follow_redirects=False)
        self.live: dict[int, dict] = {}  # job id -> progress figures while it runs
        self.cancelled: set[int] = set()
        self.wake = threading.Event()
        self.stopping = threading.Event()
        self.lock = threading.Lock()
        # Jobs cut short by a restart start again from the beginning.
        self.db.run(f"UPDATE downloads SET state='queued' WHERE state IN ({','.join('?' * len(ACTIVE))})", *ACTIVE)
        if background and self.enabled:
            threading.Thread(target=self._loop, name="mediawan-downloads", daemon=True).start()

    @property
    def enabled(self) -> bool:
        return self.root is not None and self.torrents.enabled

    def why_off(self) -> str | None:
        if self.root is None:
            return "Season downloads are off (DOWNLOAD_DIR is not set)"
        if not self.torrents.enabled:
            return "Season downloads need the torrent engine (TORRENT_URL is not set)"
        return None

    def stop(self):
        self.stopping.set()
        self.wake.set()

    # ---- asking ---------------------------------------------------------------------------

    def _have(self, imdb_id: str, season: int, episode: int) -> bool:
        """The library already holds this episode (any copy that is not missing)."""
        return bool(
            self.db.one(
                "SELECT 1 FROM files f JOIN items i ON i.id=f.item_id JOIN titles t ON t.id=i.title_id "
                "WHERE t.kind='show' AND t.imdb_id=? AND i.season=? AND i.episode=? AND f.missing=0",
                imdb_id, season, episode,
            )
        )  # fmt: skip

    def request_season(self, user_id: int, title: dict, season: int) -> dict:
        """Queue every aired episode of a season. TV shows only."""
        off = self.why_off()
        if off:
            raise DownloadError(off, 409)
        if title.get("kind") != "show":
            raise DownloadError("Only TV shows can be downloaded by the season")
        episodes = [e for e in title.get("episodes") or [] if e["season"] == season]
        if not episodes:
            raise DownloadError(f"Season {season} has no aired episodes")
        # One quality for the whole season, from its first episode: 1080p, or 720p/SD for an
        # older series with nothing sound at 1080p (torrent.py's `standard`). Never 4K.
        found = self.torrents.choices(title, season, episodes[0]["episode"], user_id=user_id)
        quality = found["offered"][0]
        now = int(time.time())
        queued = skipped = 0
        for e in episodes:
            if self._have(title["id"], season, e["episode"]):
                skipped += 1
                continue
            row = self.db.one(
                "SELECT id, state FROM downloads WHERE imdb_id=? AND season=? AND episode=?",
                title["id"], season, e["episode"],
            )  # fmt: skip
            if row and row["state"] in ("queued", "done", *ACTIVE):
                skipped += 1
                continue
            self.db.run(
                "INSERT INTO downloads(user_id, imdb_id, show_name, year, season, episode, episode_name, quality, "
                "state, created, updated) VALUES(?,?,?,?,?,?,?,?,'queued',?,?) "
                "ON CONFLICT(imdb_id, season, episode) DO UPDATE SET user_id=excluded.user_id, "
                "quality=excluded.quality, state='queued', error=NULL, release=NULL, warnings='[]', "
                "path=NULL, updated=excluded.updated",
                user_id, title["id"], title["name"], title.get("year"), season, e["episode"],
                e.get("name") or "", quality, now, now,
            )  # fmt: skip
            queued += 1
        self.wake.set()
        return {"queued": queued, "skipped": skipped, "quality": quality, "label": LABELS.get(quality, "")}

    def list(self) -> list[dict]:
        rows = self.db.all("SELECT * FROM downloads ORDER BY created DESC, show_name, season, episode")
        out = []
        for r in rows:
            job = dict(r)
            job["label"] = LABELS.get(r["quality"], "")
            job["release"] = _json(r["release"])
            job["warnings"] = _json(r["warnings"]) or []
            job.update(self.live.get(r["id"], {}))
            out.append(job)
        return out

    def cancel(self, job_id: int):
        """Stop a job (it stays in the list as cancelled), or remove a finished one from the list."""
        row = self.db.one("SELECT state FROM downloads WHERE id=?", job_id)
        if not row:
            raise KeyError(job_id)
        if row["state"] in ACTIVE:
            self.cancelled.add(job_id)
            self._set(job_id, state="cancelled")
        elif row["state"] == "queued":
            self._set(job_id, state="cancelled")
        else:
            self.db.run("DELETE FROM downloads WHERE id=?", job_id)

    def retry(self, job_id: int):
        row = self.db.one("SELECT state FROM downloads WHERE id=?", job_id)
        if not row:
            raise KeyError(job_id)
        if row["state"] in ("failed", "cancelled"):
            self._set(job_id, state="queued", error=None)
            self.wake.set()

    # ---- the worker -----------------------------------------------------------------------

    def _set(self, job_id: int, **values):
        values["updated"] = int(time.time())
        cols = ", ".join(f"{k}=?" for k in values)
        self.db.run(f"UPDATE downloads SET {cols} WHERE id=?", *values.values(), job_id)

    def _loop(self):
        while not self.stopping.is_set():
            job = self.db.one("SELECT * FROM downloads WHERE state='queued' ORDER BY created, season, episode LIMIT 1")
            if not job:
                self.wake.wait(30)
                self.wake.clear()
                continue
            self.run_one(job)

    def run_one(self, job) -> None:
        job_id = job["id"]
        self.cancelled.discard(job_id)
        try:
            self._run(job)
        except (DownloadError, TorrentError, OSError, httpx.HTTPError) as error:
            if job_id not in self.cancelled:
                log.warning("Download %s S%02dE%02d failed: %s", job["show_name"], job["season"], job["episode"], error)
                self._set(job_id, state="failed", error=str(error)[:500])
        except Exception as error:  # keep the worker alive whatever happens
            log.exception("Download %s failed", job_id)
            self._set(job_id, state="failed", error=f"The download failed ({type(error).__name__})")
        finally:
            self.live.pop(job_id, None)
            self.cancelled.discard(job_id)

    def _stopped(self, job_id: int) -> bool:
        return job_id in self.cancelled or self.stopping.is_set()

    def _destination(self, job, filename: str) -> Path:
        """<root>/<Show>/Season NN/<Show> - SxxEyy.<ext>. A folder the library already has for the
        show is reused, so the episodes join it instead of becoming a second title."""
        name = safe_name(job["show_name"])
        folder = None
        if self.root.is_dir():
            want = normalise(job["show_name"])
            for child in self.root.iterdir():
                bare = re.sub(r"\s*\((?:19|20)\d\d\)$", "", child.name)
                if child.is_dir() and normalise(bare) == want:
                    folder = child
                    break
        if folder is None:
            folder = self.root / (f"{name} ({job['year']})" if job["year"] else name)
        ext = Path(filename).suffix.lower() or ".mkv"
        return folder / f"Season {job['season']:02d}" / f"{name} - S{job['season']:02d}E{job['episode']:02d}{ext}"

    def _run(self, job):
        job_id, user_id = job["id"], job["user_id"]
        season, episode = job["season"], job["episode"]
        self._set(job_id, state="finding", error=None)
        title = self.title_of(job["imdb_id"])
        found = self.torrents.choices(title, season, episode, user_id=user_id)
        quality = job["quality"]
        if not found["qualities"].get(quality, {}).get("ranked"):
            quality = found["offered"][0]  # this episode has nothing at the season's quality
        option = found["qualities"][quality]
        if not option["ranked"]:
            raise DownloadError(option["reason"] or f"No {LABELS.get(quality, '')} release is available")
        # Choosing the release is a prepared stream: connect, check the episode, read the file.
        stream = self.torrents.open(user_id, title, season, episode, quality, f"download-{job_id}", "prepare")
        try:
            while True:
                if self._stopped(job_id):
                    return
                stream = self.torrents.get(user_id, stream.id)  # also keeps it from expiring
                if stream.error:
                    raise DownloadError(stream.error["message"])
                if stream.info and stream.chosen and stream.file:
                    break
                self.live[job_id] = {"message": self.torrents.public(stream)["message"]}
                time.sleep(self.poll)
            info_hash, index = stream.chosen.hash, stream.file["index"]
            url, size = self.torrents.sidecar.file_url(stream.file["url"]), stream.file["size"]
            filename = stream.file["path"]
            release = summary(stream.chosen.entry, quality)
            warnings = self.torrents.warnings(stream, stream.chosen.entry)
            self.torrents.sidecar.mode(info_hash, index, "download")
        finally:
            # The engine keeps a file that is being downloaded when the stream lets go of it.
            self.torrents.close(stream, "Handed to the season download")
        if self._stopped(job_id):
            self.torrents.sidecar.unselect(info_hash, index)
            return
        dest = self._destination(job, filename)
        self._set(job_id, state="downloading", quality=quality, size=size, release=json.dumps(release),
                  warnings=json.dumps(warnings), path=str(dest))  # fmt: skip
        try:
            self._download(job_id, info_hash, index, size)
            if self._stopped(job_id):
                return
            self._set(job_id, state="copying")
            self._copy(job_id, url, dest, size)
        finally:
            self.torrents.sidecar.unselect(info_hash, index)
        if self._stopped(job_id):
            return
        self._set(job_id, state="done", path=str(dest))
        log.info("Downloaded %s", dest)
        try:
            self.on_saved()
        except Exception:
            log.exception("Library scan after a download failed")

    def _download(self, job_id: int, info_hash: str, index: int, size: int):
        stalled_since, last = time.time(), -1
        while not self._stopped(job_id):
            try:
                status = self.torrents.sidecar.status(info_hash)
            except TorrentError as error:
                if error.reason == "gone":
                    raise DownloadError("The torrent engine dropped this download (VPN or disk); it will need a retry")
                raise
            if status.get("error"):
                raise DownloadError(status["error"])
            sel = next((s for s in status.get("selected") or [] if s["index"] == index), None)
            if sel is None:
                raise DownloadError("The torrent engine no longer has this file")
            done = sel.get("downloaded") or 0
            self.live[job_id] = {"downloaded": done, "size": size, "rate": status.get("download_rate", 0),
                                 "peers": status.get("peers", 0)}  # fmt: skip
            if sel.get("complete"):
                return
            if done > last:
                stalled_since, last = time.time(), done
            elif time.time() - stalled_since > 30 * 60:
                raise DownloadError("No progress for 30 minutes: the swarm has stalled")
            time.sleep(self.poll)

    def _copy(self, job_id: int, url: str, dest: Path, size: int):
        """Read the finished file from the engine into the library: a .part file, then renamed."""
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".part")
        copied = 0
        try:
            with self.client.stream("GET", url) as response, open(part, "wb") as out:
                if response.status_code != 200:
                    raise DownloadError(f"The torrent engine answered {response.status_code} for the file")
                for chunk in response.iter_bytes(4 * 1048576):
                    if self._stopped(job_id):
                        raise DownloadError("Cancelled")
                    out.write(chunk)
                    copied += len(chunk)
                    self.live[job_id] = {"copied": copied, "size": size}
            if size and copied != size:
                raise DownloadError(f"The copy is incomplete ({copied} of {size} bytes)")
            os.replace(part, dest)
        except BaseException:
            part.unlink(missing_ok=True)
            raise


def _json(text):
    try:
        return json.loads(text) if text else None
    except ValueError:
        return None
