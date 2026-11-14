"""Subtitles in the languages the household needs, on every title, every time.

SUBTITLE_LANGUAGES (default Arabic, Danish, Portuguese) are always offered. A real track is used
when the file or stream has one. When it does not, the best text track (English first) is
machine-translated by a LibreTranslate server running next to Mediawan and saved, so each episode
is translated once. Playback starts translating the missing languages in the background, so
picking one is usually instant; a language asked for in the player jumps the queue.
"""

import hashlib
import heapq
import itertools
import logging
import os
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from .parse import LANGUAGE_NAMES

log = logging.getLogger("mediawan.translate")

BATCH = 40  # strings per LibreTranslate request
RETRY_FAILED_AFTER = 30  # seconds before a failed translation may be tried again
_TAG = re.compile(r"<[^>]+>|\{\\[^}]*\}")  # WebVTT/HTML tags and ASS overrides like {\an8}
_TIMING = re.compile(r"(?:\d+:)?\d+:\d+[.,]\d+\s*-->")  # hh:mm:ss.mmm or mm:ss.mmm


# ---- WebVTT -------------------------------------------------------------------------------


@dataclass
class Cue:
    timing: str  # the "00:01.000 --> 00:02.000 align:start" line, kept as it is
    lines: list[str]


def parse_vtt(text: str) -> list[Cue]:
    cues = []
    for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")):
        lines = block.strip("\n").split("\n")
        at = next((i for i, line in enumerate(lines) if _TIMING.match(line.strip())), None)
        if at is None:
            continue  # header, NOTE, STYLE or REGION blocks
        body = [_TAG.sub("", line).strip() for line in lines[at + 1 :]]
        body = [line for line in body if line]
        if body:
            cues.append(Cue(lines[at].strip().replace(",", "."), body))
    return cues


def write_vtt(cues: list[Cue]) -> str:
    return "WEBVTT\n\n" + "".join(f"{c.timing}\n" + "\n".join(c.lines) + "\n\n" for c in cues)


_DASH = re.compile(r"^[-–—]\s*")


def units(cue: Cue) -> tuple[list[str], bool]:
    """What to send for one cue. Dialogue ("- Hi" / "- Hello") is translated line by line;
    anything else as one sentence, since subtitle lines often break mid-sentence."""
    if len(cue.lines) > 1 and all(_DASH.match(line) for line in cue.lines):
        return [_DASH.sub("", line) for line in cue.lines], True
    return [" ".join(cue.lines)], False


# ---- choosing what to offer ---------------------------------------------------------------

_NOT_DIALOGUE = re.compile(r"sign|song|forced|commentary|karaoke", re.IGNORECASE)


def pick_source(subs: list[dict]) -> dict | None:
    """The track to translate from: full English dialogue if there is one."""
    usable = [
        s
        for s in subs
        if s.get("available") and not s.get("forced") and not s.get("translated") and s.get("url")
    ]

    def rank(s):
        title = s.get("title") or ""
        return (s.get("lang") != "en", bool(_NOT_DIALOGUE.search(title)), s.get("lang") is None)

    return min(usable, key=rank) if usable else None


def with_languages(
    subs: list[dict],
    wanted: list[str],
    link: Callable[[dict, str], str],
    can_translate: bool = True,
) -> tuple[list[dict], dict | None]:
    """Add a translated entry for each wanted language the title lacks, and list the wanted
    languages first. `link(source, lang)` makes the URL of a translated track. A language that
    cannot be made is still listed, marked unavailable with the reason."""
    have = {s.get("lang") for s in subs if s.get("available") and not s.get("forced")}
    source = pick_source(subs)
    usable = source is not None and can_translate
    extra = []
    for lang in wanted:
        if lang in have:
            continue
        name = LANGUAGE_NAMES.get(lang, lang.upper())
        why = (
            "translated"
            if usable
            else "translation is off"
            if source
            else "nothing to translate from"
        )
        extra.append(
            {
                "key": f"t-{lang}",
                "lang": lang,
                "title": f"{name} ({why})",
                "forced": False,
                "default": False,
                "codec": "webvtt",
                "available": usable,
                "external": False,
                "translated": True,
                "url": link(source, lang) if usable else None,
            }
        )
    order = {lang: i for i, lang in enumerate(wanted)}
    combined = sorted(subs + extra, key=lambda s: order.get(s.get("lang"), len(order)))
    return combined, source


# ---- translation jobs ---------------------------------------------------------------------


@dataclass
class Job:
    key: str
    target: str
    path: Path
    status: str = "queued"  # queued | working | ready | failed
    done: int = 0
    total: int = 0
    error: str = ""
    finished: float = 0.0
    priority: int = 1  # 0 = someone is waiting for it in the player
    loader: Callable[[], str] | None = field(default=None, repr=False)
    source_lang: str | None = None

    def public(self) -> dict:
        return {"status": self.status, "done": self.done, "total": self.total, "detail": self.error}


class TranslationError(Exception):
    pass


class Unreachable(TranslationError):
    """The server itself is down: no point trying the lines one by one."""


class Translator:
    def __init__(
        self,
        url: str,
        cache_dir: Path,
        api_key: str = "",
        client: httpx.Client | None = None,
    ):
        self.url = (url or "").rstrip("/")
        self.enabled = bool(self.url)
        self.api_key = api_key
        self.dir = Path(cache_dir)
        self.client = client or httpx.Client(timeout=httpx.Timeout(180, connect=10))
        self.jobs: dict[str, Job] = {}
        self.queue: list[tuple[int, int, str]] = []
        self.order = itertools.count()
        self.lock = threading.Condition()
        self.thread: threading.Thread | None = None
        self.stopping = False
        self._languages: tuple[float, set[str]] = (0.0, set())

    def cached(self, source_id: str, target: str) -> Path:
        key = hashlib.sha1(f"{source_id}|{target}".encode()).hexdigest()[:24]
        return self.dir / f"{key}.{target}.vtt"

    def request(
        self,
        source_id: str,
        loader: Callable[[], str],
        source_lang: str | None,
        target: str,
        urgent: bool = True,
    ) -> Job:
        """The job for this source and language: finished, running, or newly queued."""
        path = self.cached(source_id, target)
        key = path.name
        with self.lock:
            job = self.jobs.get(key)
            if path.exists():
                if not job or job.status != "ready":
                    job = self.jobs[key] = Job(key, target, path, status="ready")
                return job
            if not self.enabled:
                return Job(
                    key, target, path, status="failed",
                    error="No translation server is set up (TRANSLATE_URL)",
                )  # fmt: skip
            if job and job.status in ("queued", "working"):
                if urgent and job.priority > 0:
                    job.priority = 0
                    if job.status == "queued":
                        heapq.heappush(self.queue, (0, next(self.order), key))
                        self.lock.notify()
                return job
            if job and job.status == "failed" and time.time() - job.finished < RETRY_FAILED_AFTER:
                return job
            job = Job(key, target, path, priority=0 if urgent else 1, loader=loader,
                      source_lang=source_lang)  # fmt: skip
            self.jobs[key] = job
            heapq.heappush(self.queue, (job.priority, next(self.order), key))
            if not self.thread or not self.thread.is_alive():
                self.thread = threading.Thread(
                    target=self._loop, name="mediawan-translate", daemon=True
                )
                self.thread.start()
            self.lock.notify()
            return job

    def stop(self):
        with self.lock:
            self.stopping = True
            self.lock.notify_all()

    # One job at a time: the NAS's CPU does the translating, and playback must stay smooth.
    def _loop(self):
        while True:
            with self.lock:
                while not self.queue and not self.stopping:
                    self.lock.wait()
                if self.stopping:
                    return
                _, _, key = heapq.heappop(self.queue)
                job = self.jobs.get(key)
                if not job or job.status != "queued":
                    continue  # a stale entry left behind by a priority bump
                job.status = "working"
            try:
                self._work(job)
                job.status = "ready"
                log.info("Translated subtitles to %s (%d lines)", job.target, job.total)
            except Exception as error:  # noqa: BLE001 - report every failure to the player
                job.error = str(error) or error.__class__.__name__
                job.status = "failed"
                log.warning("Subtitle translation to %s failed: %s", job.target, job.error)
            finally:
                job.finished = time.time()
                job.loader = None

    def _work(self, job: Job):
        cues = parse_vtt(job.loader())
        if not cues:
            raise TranslationError("The source subtitles are empty")
        self._check_target(job.target, job.source_lang)
        plan = [units(c) for c in cues]
        strings = list(dict.fromkeys(s for texts, _ in plan for s in texts))  # each once
        job.total = len(strings)
        source = job.source_lang if job.source_lang and job.source_lang != job.target else "auto"
        done: dict[str, str] = {}
        for start in range(0, len(strings), BATCH):
            chunk = strings[start : start + BATCH]
            done.update(zip(chunk, self._translate(chunk, source, job.target)))
            job.done = len(done)
        out = []
        for cue, (texts, dialogue) in zip(cues, plan):
            lines = [done.get(t, t) for t in texts]
            out.append(Cue(cue.timing, ["- " + x for x in lines] if dialogue else lines))
        self.dir.mkdir(parents=True, exist_ok=True)
        partial = job.path.with_suffix(".part")
        partial.write_text(write_vtt(out), encoding="utf-8", newline="\n")  # same bytes on any OS
        os.replace(partial, job.path)

    def _check_target(self, target: str, source: str | None):
        """Fail early, with a useful message, when the server lacks a language."""
        stamp, codes = self._languages
        if time.time() - stamp > 3600:
            try:
                response = self.client.get(f"{self.url}/languages", timeout=15)
                response.raise_for_status()
                codes = {item["code"] for item in response.json()}
                self._languages = (time.time(), codes)
            except (httpx.HTTPError, ValueError, KeyError, TypeError) as error:
                raise TranslationError(f"The translation server is unreachable: {error}") from error
        if codes and target not in codes:
            raise TranslationError(
                f"The translation server has no {LANGUAGE_NAMES.get(target, target)} model; "
                f"add '{target}' to LT_LOAD_ONLY"
            )

    def _translate(self, texts: list[str], source: str, target: str) -> list[str]:
        """Translate a batch, retrying; if a batch keeps failing, go line by line so one bad
        line cannot cost the whole file (a line that still fails stays untranslated)."""
        try:
            return self._call(texts, source, target)
        except Unreachable:
            raise
        except TranslationError:
            if len(texts) == 1:
                return texts
        out = []
        for text in texts:
            try:
                out.extend(self._call([text], source, target))
            except Unreachable:
                raise
            except TranslationError:
                out.append(text)
        return out

    def _call(self, texts: list[str], source: str, target: str) -> list[str]:
        body = {"q": texts, "source": source, "target": target, "format": "text"}
        if self.api_key:
            body["api_key"] = self.api_key
        last, down = None, True
        for attempt in range(3):
            if attempt:
                time.sleep(1.5 * attempt)
            try:
                response = self.client.post(f"{self.url}/translate", json=body)
            except httpx.TransportError as error:  # refused, timed out, DNS…
                last = str(error) or error.__class__.__name__
                continue
            down = False
            if response.status_code >= 500:
                last = f"HTTP {response.status_code}"
                continue
            try:
                data = response.json()
            except ValueError:
                raise TranslationError("The translation server returned a bad answer")
            if response.status_code >= 400:
                raise TranslationError(data.get("error") or f"HTTP {response.status_code}")
            out = data.get("translatedText")
            if isinstance(out, str):
                out = [out]
            if not isinstance(out, list) or len(out) != len(texts):
                raise TranslationError("The translation server returned a bad answer")
            return [str(x) for x in out]
        kind = Unreachable if down else TranslationError
        raise kind(f"The translation server did not answer: {last}")
