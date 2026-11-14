"""The Mediawan web server: JSON API plus the static web UI."""

import json
import logging
import os
import re
import threading
import time
from contextlib import asynccontextmanager
from functools import partial
from pathlib import Path

from fastapi import Body, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from . import __version__, live_api, media, translate
from .auth import COOKIE, SESSION_DAYS, Accounts, admin_user, current_user, hash_password, public
from .config import Config
from .db import Database
from .library import Library
from .metadata import Metadata
from .online import CDN_HEADERS, Online, OnlineError
from .scanner import Scanner
from .usenet import Usenet

log = logging.getLogger("mediawan")
STATIC = Path(__file__).parent / "static"


class Jobs:
    """Background loop: library scan + metadata on a timer or on demand, session cleanup."""

    def __init__(
        self, scanner: Scanner, metadata: Metadata, sessions: media.Sessions, interval: int
    ):
        self.scanner, self.metadata, self.sessions = scanner, metadata, sessions
        self.interval = interval
        self.wake = threading.Event()
        self.stopping = threading.Event()
        self.thread: threading.Thread | None = None
        self.metadata_running = False

    def start(self):
        self.thread = threading.Thread(target=self._loop, name="mediawan-jobs", daemon=True)
        self.thread.start()

    def trigger(self):
        self.wake.set()

    def stop(self):
        self.stopping.set()
        self.wake.set()

    def run_library(self):
        try:
            self.scanner.scan()
            self.metadata_running = True
            self.metadata.refresh_pending()
        except Exception:  # keep the loop alive whatever happens
            log.exception("Library job failed")
        finally:
            self.metadata_running = False

    def _loop(self):
        next_scan = 0.0
        while not self.stopping.is_set():
            if self.wake.is_set() or time.time() >= next_scan:
                self.wake.clear()
                self.run_library()
                next_scan = time.time() + self.interval if self.interval > 0 else float("inf")
            self.sessions.cleanup()
            self.wake.wait(30)


def create_app(
    config: Config | None = None,
    *,
    http_client=None,
    online_clients: tuple | None = None,
    translate_client=None,
    live_clients: tuple | None = None,
    background: bool = True,
) -> FastAPI:
    """online_clients: (httpx.Client, httpx.AsyncClient) for AniList/MegaPlay, and
    translate_client: httpx.Client for LibreTranslate; both for tests."""
    config = config or Config.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = app.state
        state.config = config
        state.db = Database(config.database)
        state.accounts = Accounts(state.db)
        state.accounts.bootstrap_admin(config.admin_email, config.admin_password)
        state.library = Library(state.db)
        state.scanner = Scanner(
            state.db, config.library_roots, prober=partial(media.probe, config.ffprobe)
        )
        state.metadata = Metadata(
            state.db,
            config.catalog_url,
            config.metadata_online,
            config.database.parent / "art",
            client=http_client,
        )
        state.sessions = media.Sessions(
            config.ffmpeg, config.ffprobe, config.runtime, config.hwaccel, config.max_transcodes
        )
        state.subtitles = media.Subtitles(config.ffmpeg, config.runtime)
        sync_client, async_client = online_clients or (None, None)
        state.online = Online(
            state.db,
            config.database.parent / "online.key",
            client=sync_client,
            async_client=async_client,
            enabled=config.online_anime,
        )
        state.usenet = Usenet(
            state.db,
            state.metadata,
            state.online,
            config.ffprobe,
            config.newznab_indexers,
            config.usenet_dav_url,
            config.usenet_dav_api_key,
            config.usenet_dav_user,
            config.usenet_dav_password,
            config.usenet_dav_category,
        )
        state.translator = translate.Translator(
            config.translate_url,
            config.database.parent / "subtitles-translated",
            config.translate_api_key,
            client=translate_client,
        )
        provider_client, fixtures_client = live_clients or (None, None)  # (for tests)
        live_api.start(state, config, background, provider_client, fixtures_client)
        state.jobs = Jobs(state.scanner, state.metadata, state.sessions, config.scan_interval)
        if background:
            state.jobs.start()
        yield
        state.translator.stop()
        live_api.stop(state)
        state.jobs.stop()
        state.sessions.stop_all()
        await state.online.aclient.aclose()
        state.db.close()

    app = FastAPI(
        title="Mediawan",
        version=__version__,
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )

    @app.exception_handler(ValueError)
    async def bad_request(_, error: ValueError):
        return JSONResponse({"detail": str(error)}, 400)

    @app.exception_handler(KeyError)
    async def not_found(_, error: KeyError):
        return JSONResponse({"detail": "Not found"}, 404)

    @app.exception_handler(media.Busy)
    async def busy(_, error: media.Busy):
        return JSONResponse({"detail": str(error)}, 503)

    @app.exception_handler(OnlineError)
    async def online_failed(_, error: OnlineError):
        return JSONResponse({"detail": str(error)}, error.status)

    def st(request: Request):
        return request.app.state

    # ---- accounts ----------------------------------------------------------------------

    @app.get("/healthz")
    def health():
        return {"ok": True, "version": __version__}

    @app.get("/api/status")
    def status(request: Request):
        s = st(request)
        return {"version": __version__, "setup": s.db.one("SELECT id FROM users LIMIT 1") is None}

    def _sign_in(response: Response, token: str):
        response.set_cookie(
            COOKIE,
            token,
            max_age=SESSION_DAYS * 86400,
            httponly=True,
            samesite="lax",
            secure=config.secure_cookie,
            path="/",
        )

    @app.post("/api/setup")
    def setup(request: Request, response: Response, body: dict = Body(...)):
        """First run without ADMIN_EMAIL: the first account becomes the administrator."""
        s = st(request)
        with s.db.lock:
            if s.db.one("SELECT id FROM users LIMIT 1"):
                raise HTTPException(409, "Setup is already done")
            s.accounts.create(
                body.get("email", ""),
                body.get("name") or "Administrator",
                body.get("password", ""),
                role="admin",
            )
        user, token = s.accounts.login(body["email"], body["password"], request.client.host)
        _sign_in(response, token)
        return public(user)

    @app.post("/api/login")
    def login(request: Request, response: Response, body: dict = Body(...)):
        email = str(body.get("email", ""))
        client = f"{request.client.host if request.client else '?'}|{email.lower()}"
        user, token = st(request).accounts.login(email, str(body.get("password", "")), client)
        _sign_in(response, token)
        return public(user)

    @app.post("/api/logout")
    def logout(request: Request, response: Response):
        token = request.cookies.get(COOKIE)
        if token:
            st(request).accounts.logout(token)
        response.delete_cookie(COOKIE, path="/")
        return {"ok": True}

    @app.get("/api/me")
    def me(request: Request, user=Depends(current_user)):
        return {**public(user), "preferences": st(request).library.preferences(user["id"])}

    @app.post("/api/me/password")
    def change_password(request: Request, body: dict = Body(...), user=Depends(current_user)):
        from .auth import verify_password

        if not verify_password(str(body.get("current", "")), user["pw_hash"]):
            raise HTTPException(400, "Your current password is incorrect")
        if len(str(body.get("password", ""))) < 10:
            raise HTTPException(400, "Use 10 or more characters")
        st(request).db.run(
            "UPDATE users SET pw_hash=? WHERE id=?", hash_password(body["password"]), user["id"]
        )
        return {"ok": True}

    @app.get("/api/admin/users")
    def users(request: Request, _=Depends(admin_user)):
        return st(request).db.all("SELECT id, email, name, role, active FROM users ORDER BY id")

    @app.post("/api/admin/users")
    def add_user(request: Request, body: dict = Body(...), _=Depends(admin_user)):
        role = "admin" if body.get("role") == "admin" else "member"
        user_id = st(request).accounts.create(
            body.get("email", ""), body.get("name", ""), body.get("password", ""), role
        )
        return {"id": user_id}

    @app.patch("/api/admin/users/{user_id}")
    def edit_user(
        user_id: int, request: Request, body: dict = Body(...), admin=Depends(admin_user)
    ):
        db = st(request).db
        if not db.one("SELECT id FROM users WHERE id=?", user_id):
            raise KeyError(user_id)
        if user_id == admin["id"] and (body.get("active") is False or body.get("role") == "member"):
            raise HTTPException(400, "You cannot demote or disable your own account")
        if "active" in body:
            db.run("UPDATE users SET active=? WHERE id=?", int(bool(body["active"])), user_id)
            if not body["active"]:
                db.run("DELETE FROM sessions WHERE user_id=?", user_id)
        if body.get("role") in ("admin", "member"):
            db.run("UPDATE users SET role=? WHERE id=?", body["role"], user_id)
        if body.get("password"):
            if len(body["password"]) < 10:
                raise HTTPException(400, "Use 10 or more characters")
            db.run(
                "UPDATE users SET pw_hash=? WHERE id=?", hash_password(body["password"]), user_id
            )
            db.run("DELETE FROM sessions WHERE user_id=?", user_id)
        return {"ok": True}

    # ---- browsing ----------------------------------------------------------------------

    @app.get("/api/home")
    def home(request: Request, user=Depends(current_user)):
        s = st(request)
        rails = s.library.home(user["id"])
        if config.online_anime:
            anime = s.online.continue_watching(user["id"])
            if anime:  # right after the library's own Continue Watching / Next Up rails
                at = sum(1 for r in rails if r["id"] in ("continue", "next"))
                rails.insert(
                    at, {"id": "online", "name": "Continue Watching · Anime", "items": anime}
                )
        watching = s.usenet.continue_watching(user["id"])
        if watching:
            at = sum(1 for r in rails if r["id"] in ("continue", "next"))
            rails.insert(
                at, {"id": "usenet", "name": "Continue Watching · Online", "items": watching}
            )
        return {"rails": rails}

    @app.get("/api/titles")
    def titles(
        request: Request,
        kind: str = "",
        q: str = "",
        genre: str = "",
        sort: str = "name",
        limit: int = 200,
        offset: int = 0,
        user=Depends(current_user),
    ):
        lib = st(request).library
        return {
            "titles": lib.titles(user["id"], kind, q.strip(), genre, sort, min(limit, 500), offset),
            "genres": lib.genres(),
        }

    @app.get("/api/titles/{title_id}")
    def title(title_id: int, request: Request, user=Depends(current_user)):
        found = st(request).library.title(user["id"], title_id)
        if not found:
            raise KeyError(title_id)
        if user["role"] != "admin":
            for item in found["items"]:
                for f in item["files"]:
                    f.pop("name", None)
        return found

    @app.put("/api/titles/{title_id}/tags/{tag}")
    def add_tag(title_id: int, tag: str, request: Request, user=Depends(current_user)):
        st(request).library.tag(user["id"], title_id, tag, True)
        return {"ok": True}

    @app.delete("/api/titles/{title_id}/tags/{tag}")
    def remove_tag(title_id: int, tag: str, request: Request, user=Depends(current_user)):
        st(request).library.tag(user["id"], title_id, tag, False)
        return {"ok": True}

    @app.post("/api/titles/{title_id}/watched")
    def title_watched(
        title_id: int, request: Request, body: dict = Body(...), user=Depends(current_user)
    ):
        db = st(request).db
        items = [r["id"] for r in db.all("SELECT id FROM items WHERE title_id=?", title_id)]
        if body.get("season") is not None:
            items = [
                r["id"]
                for r in db.all(
                    "SELECT id FROM items WHERE title_id=? AND season=?",
                    title_id,
                    int(body["season"]),
                )
            ]
        st(request).library.set_watched(user["id"], items, bool(body.get("watched", True)))
        return {"ok": True}

    @app.post("/api/items/{item_id}/watched")
    def item_watched(
        item_id: int, request: Request, body: dict = Body(...), user=Depends(current_user)
    ):
        st(request).library.set_watched(user["id"], [item_id], bool(body.get("watched", True)))
        return {"ok": True}

    @app.post("/api/progress")
    def progress(request: Request, body: dict = Body(...), user=Depends(current_user)):
        s = st(request)
        if body.get("session"):
            s.sessions.get(str(body["session"]))  # keeps the stream alive while paused
        return s.library.progress(
            user["id"], int(body["item_id"]), body.get("position", 0), body.get("duration", 0)
        )

    # ---- collections, queues, preferences ----------------------------------------------

    @app.get("/api/collections")
    def collections(request: Request, user=Depends(current_user)):
        return st(request).library.collections(user["id"])

    @app.get("/api/collections/{collection_id}")
    def collection(collection_id: int, request: Request, user=Depends(current_user)):
        lib = st(request).library
        found = lib.collection(user["id"], collection_id)
        return {**found, "cards": lib.collection_titles(user["id"], found)}

    @app.post("/api/collections")
    def new_collection(request: Request, body: dict = Body(...), user=Depends(current_user)):
        return st(request).library.save_collection(
            user["id"], body.get("name", ""), body.get("titles", [])
        )

    @app.patch("/api/collections/{collection_id}")
    def edit_collection(
        collection_id: int, request: Request, body: dict = Body(...), user=Depends(current_user)
    ):
        lib = st(request).library
        current = lib.collection(user["id"], collection_id)
        titles_ = list(body.get("titles", current["titles"]))
        if body.get("add"):
            titles_.append(int(body["add"]))
        if body.get("remove"):
            titles_ = [t for t in titles_ if t != int(body["remove"])]
        return lib.save_collection(
            user["id"], body.get("name", current["name"]), titles_, collection_id
        )

    @app.delete("/api/collections/{collection_id}")
    def delete_collection(collection_id: int, request: Request, user=Depends(current_user)):
        st(request).library.delete_collection(user["id"], collection_id)
        return {"ok": True}

    @app.get("/api/queues")
    def queues(request: Request, user=Depends(current_user)):
        return st(request).library.queues(user["id"])

    @app.post("/api/queues")
    def new_queue(request: Request, body: dict = Body(...), user=Depends(current_user)):
        return st(request).library.create_queue(
            user["id"],
            body.get("name", "Queue"),
            body.get("mode", "sequential"),
            body.get("titles", []),
            body.get("items", []),
            body.get("collection"),
            body.get("start_item"),
        )

    @app.get("/api/queues/{queue_id}")
    def get_queue(queue_id: int, request: Request, user=Depends(current_user)):
        return st(request).library.queue(user["id"], queue_id)

    @app.post("/api/queues/{queue_id}/step")
    def step_queue(
        queue_id: int, request: Request, body: dict = Body(default={}), user=Depends(current_user)
    ):
        return st(request).library.step_queue(
            user["id"], queue_id, int(body.get("step", 1)), body.get("item")
        )

    @app.delete("/api/queues/{queue_id}")
    def delete_queue(queue_id: int, request: Request, user=Depends(current_user)):
        st(request).library.delete_queue(user["id"], queue_id)
        return {"ok": True}

    @app.get("/api/preferences")
    def preferences(request: Request, user=Depends(current_user)):
        return st(request).library.preferences(user["id"])

    @app.put("/api/preferences")
    def save_preferences(request: Request, body: dict = Body(...), user=Depends(current_user)):
        return st(request).library.save_preferences(user["id"], body)

    # ---- playback ----------------------------------------------------------------------

    def _probe(s, file: dict) -> dict:
        if file.get("probe"):
            info = json.loads(file["probe"])
            if not info.get("error"):
                return info
        info = media.probe(config.ffprobe, file["path"])
        s.db.run("UPDATE files SET probe=? WHERE id=?", json.dumps(info), file["id"])
        return info

    @app.post("/api/play")
    def play(request: Request, body: dict = Body(...), user=Depends(current_user)):
        """Decide how to play an item on this device and start a stream if one is needed."""
        s = st(request)
        item = s.library.item(int(body["item_id"]))
        if not item:
            raise KeyError("item")
        prefs = s.library.preferences(user["id"])
        caps = media.Caps.parse(body.get("caps"))
        caps.max_height = min(caps.max_height, int(prefs["max_height"]))
        if prefs["stereo"]:
            caps.channels = 2
        files = s.db.all("SELECT * FROM files WHERE item_id=? AND missing=0", item["id"])
        if body.get("file_id"):
            files = [f for f in files if f["id"] == int(body["file_id"])]
        file = media.choose_file(files, caps)
        if not file:
            raise HTTPException(404, "No playable file for this item. Rescan the library?")
        if not Path(file["path"]).is_file():
            s.db.run("UPDATE files SET missing=1 WHERE id=?", file["id"])
            raise HTTPException(410, "That file is no longer on disk")
        try:
            info = _probe(s, file)
        except (RuntimeError, OSError, ValueError) as error:
            raise HTTPException(422, f"FFprobe could not read this file: {error}")
        audio = body.get("audio")
        the_plan = media.plan(
            info,
            caps,
            file["path"],
            int(audio) if audio is not None else None,
            prefs["audio_language"] or None,
        )
        if body.get("escalate"):
            the_plan = media.escalate(the_plan, info, caps, body["escalate"])
        start = body.get("start")
        start = s.library.resume_position(user["id"], item["id"]) if start is None else float(start)
        start = max(0.0, min(start, max(0.0, info["duration"] - 5)))
        result = {
            "item": item,
            "file_id": file["id"],
            "mode": the_plan.mode,
            "reasons": the_plan.reasons,
            "duration": info["duration"],
            "position": start,
            "audio_index": the_plan.audio_index,
            "preferences": prefs,
            "audio": [
                {
                    "index": a["index"],
                    "codec": a["codec"],
                    "lang": a["lang"],
                    "title": a["title"],
                    "channels": a["channels"],
                }
                for a in info["audio"]
            ],
            "subtitles": _offer_languages(
                s,
                _subtitle_list(s, file, info),
                lambda src: {"file": file["id"], "key": src["key"], "lang": src["lang"]},
            ),
            "next": None,
        }
        following = s.library.next_item(item["id"])
        if following:
            result["next"] = {
                "item_id": following["id"],
                "label": s.library.item(following["id"])["label"],
            }
        if the_plan.mode == "direct":
            result.update(url=f"/api/files/{file['id']}/raw", start=0.0, session=None)
        else:
            session = s.sessions.start(
                user_id=user["id"],
                client=str(body.get("client", "web")),
                file=file,
                item_id=item["id"],
                info=info,
                the_plan=the_plan,
                caps=caps,
                start=start,
            )
            result.update(
                url=f"/api/stream/{session.id}/index.m3u8",
                start=session.start,
                session=session.id,
                hwaccel=session.public()["hwaccel"],
            )
        return result

    def _subtitle_list(s, file: dict, info: dict) -> list[dict]:
        out = []
        for sub in info["subtitles"]:
            out.append(
                {
                    "key": f"s{sub['index']}",
                    "lang": sub["lang"],
                    "title": sub["title"],
                    "forced": sub["forced"],
                    "default": sub["default"],
                    "codec": sub["codec"],
                    "available": sub["text"],
                    "external": False,
                    "url": f"/api/files/{file['id']}/subtitles/s{sub['index']}.vtt",
                }
            )
        for sub in s.db.all(
            "SELECT * FROM subtitles WHERE file_id=? ORDER BY lang, id", file["id"]
        ):
            out.append(
                {
                    "key": f"x{sub['id']}",
                    "lang": sub["lang"],
                    "title": Path(sub["path"]).name,
                    "forced": bool(sub["forced"]),
                    "default": False,
                    "codec": sub["format"],
                    "available": True,
                    "external": True,
                    "url": f"/api/files/{file['id']}/subtitles/x{sub['id']}.vtt",
                }
            )
        return out

    # ---- subtitles in every wanted language (translate.py) ------------------------------

    def _offer_languages(s, subs: list[dict], describe, prepare: bool = True) -> list[dict]:
        """Offer every SUBTITLE_LANGUAGES language: real tracks first, translations to fill
        the gaps. describe(source) says where the source track comes from; it travels signed
        inside the URL, so the endpoint can only translate tracks this server offered."""
        wanted = config.subtitle_languages
        if wanted:

            def link(source: dict, lang: str) -> str:
                token = s.online.sign(json.dumps(describe(source), separators=(",", ":")))
                return f"/api/subtitles/translated/{token}/{lang}.vtt"

            subs, source = translate.with_languages(
                subs, wanted, link, can_translate=s.translator.enabled
            )
            if prepare and source and s.translator.enabled:  # so picking one is instant
                for sub in subs:
                    if sub.get("translated") and sub["available"]:
                        _translation(s, describe(source), sub["lang"], urgent=False)
        for sub in subs:
            sub.pop("_src", None)
        return subs

    def _translation(s, desc: dict, target: str, urgent: bool = True) -> translate.Job:
        if "file" in desc:
            file = s.db.one("SELECT * FROM files WHERE id=?", int(desc["file"]))
            if not file:
                raise KeyError(desc["file"])
            source_id = f"file:{file['id']}:{int(file['mtime'])}:{desc['key']}"

            def load() -> str:
                return _subtitle_path(s, file, desc["key"]).read_text("utf-8", errors="replace")

        elif "dav" in desc:
            remote = s.usenet.file(str(desc["dav"]))
            source_id = f"dav:{remote['id']}:{desc['key']}"

            def load() -> str:
                path = s.subtitles.embedded(remote, int(desc["key"][1:]))
                return path.read_text("utf-8", errors="replace")

        else:
            url = str(desc["url"])
            source_id = "url:" + url

            def load() -> str:
                response = s.online.client.get(url, headers=CDN_HEADERS)
                response.raise_for_status()
                return response.text

        return s.translator.request(source_id, load, desc.get("lang"), target, urgent)

    @app.get("/api/subtitles/translated/{token}/{lang}.vtt")
    def translated_subtitle(token: str, lang: str, request: Request, user=Depends(current_user)):
        """The translated track, or 202 with progress while it is being made."""
        s = st(request)
        if lang not in config.subtitle_languages:
            raise HTTPException(404, "That subtitle language is not offered")
        job = _translation(s, json.loads(s.online.unsign(token)), lang)
        if job.status == "ready":
            return FileResponse(
                job.path,
                media_type="text/vtt; charset=utf-8",
                headers={"Cache-Control": "private, max-age=86400"},
            )
        if job.status == "failed":
            return JSONResponse(job.public(), 502)
        return JSONResponse(job.public(), 202, headers={"Cache-Control": "no-store"})

    def _session_for(s, sid: str, user: dict) -> media.Session:
        session = s.sessions.get(sid)
        if not session or (session.user_id != user["id"] and user["role"] != "admin"):
            raise HTTPException(404, "This stream has ended")
        return session

    @app.get("/api/stream/{sid}/{name}")
    async def stream_file(sid: str, name: str, request: Request, user=Depends(current_user)):
        if not media.HLS_FILE.match(name):
            raise HTTPException(404)
        s = st(request)
        session = _session_for(s, sid, user)
        path = await run_in_threadpool(s.sessions.wait_for, session, name, 30)
        if not path:
            if session.error:
                raise HTTPException(500, f"Streaming failed: {session.error}")
            raise HTTPException(404, "Segment not ready")
        if name == "index.m3u8":
            return Response(
                path.read_text(),
                media_type="application/vnd.apple.mpegurl",
                headers={"Cache-Control": "no-store"},
            )
        return FileResponse(
            path, media_type="video/mp4" if name.endswith(".mp4") else "video/iso.segment"
        )

    @app.delete("/api/sessions/{sid}")
    def stop_session(sid: str, request: Request, user=Depends(current_user)):
        s = st(request)
        session = s.sessions.items.get(sid)
        if session and (session.user_id == user["id"] or user["role"] == "admin"):
            s.sessions.stop(sid)
        return {"ok": True}

    @app.post("/api/sessions/{sid}/ping")
    def ping_session(sid: str, request: Request, user=Depends(current_user)):
        session = _session_for(st(request), sid, user)
        return {"error": session.error, "finished": session.finished}

    def _file(s, file_id: int) -> dict:
        file = s.db.one("SELECT * FROM files WHERE id=? AND missing=0", file_id)
        if not file:
            raise KeyError(file_id)
        return file

    @app.get("/api/files/{file_id}/raw")
    def raw(file_id: int, request: Request, user=Depends(current_user)):
        """Direct play, with HTTP range requests for seeking."""
        file = _file(st(request), file_id)
        info = json.loads(file["probe"]) if file["probe"] else {}
        kind = media.container_of(info, file["path"]) if info.get("container") else None
        return FileResponse(
            file["path"], media_type=f"video/{kind or 'mp4'}", content_disposition_type="inline"
        )

    def _subtitle_path(s, file: dict, key: str) -> Path:
        """A text subtitle track of a file as WebVTT on disk (converted once, then cached)."""
        if key.startswith("s") and key[1:].isdigit():
            info = json.loads(file["probe"] or "{}")
            index = int(key[1:])
            if not any(x["index"] == index and x["text"] for x in info.get("subtitles", [])):
                raise HTTPException(404, "Picture-based subtitles cannot be shown as text")
            return s.subtitles.embedded(file, index)
        if key.startswith("x") and key[1:].isdigit():
            sub = s.db.one(
                "SELECT * FROM subtitles WHERE id=? AND file_id=?", int(key[1:]), file["id"]
            )
            if not sub:
                raise KeyError(key)
            return s.subtitles.sidecar(sub)
        raise KeyError(key)

    @app.get("/api/files/{file_id}/subtitles/{key}.vtt")
    async def subtitle(file_id: int, key: str, request: Request, user=Depends(current_user)):
        s = st(request)
        file = _file(s, file_id)
        try:
            path = await run_in_threadpool(_subtitle_path, s, file, key)
        except RuntimeError as error:
            raise HTTPException(422, f"Could not convert subtitles: {error}")
        return FileResponse(
            path,
            media_type="text/vtt; charset=utf-8",
            headers={"Cache-Control": "private, max-age=3600"},
        )

    # ---- online anime (AniList + MegaPlay) ---------------------------------------------

    @app.get("/api/online/search")
    def online_search(request: Request, q: str = "", user=Depends(current_user)):
        if not config.online_anime:
            return {"enabled": False, "results": []}
        return {"enabled": True, "results": st(request).online.search(q)}

    @app.get("/api/online/anime/{anilist_id}")
    def online_anime(anilist_id: int, request: Request, user=Depends(current_user)):
        online = st(request).online
        found = online.anime(anilist_id)
        watched = online.watched(user["id"], anilist_id)
        for e in found["episodes"]:
            row = watched.get(e["number"])
            e["position"] = row["position"] if row else 0
            e["duration"] = row["duration"] if row else 0
            e["completed"] = bool(row and row["completed"])
        found["next"] = online.next_episode(watched, found["available"])
        last = max(watched.values(), key=lambda r: r["played_at"], default=None)
        found["lang"] = last["lang"] if last else "sub"
        return found

    @app.post("/api/online/play")
    def online_play(request: Request, body: dict = Body(...), user=Depends(current_user)):
        """Find an episode on MegaPlay and hand the player a proxied playlist."""
        s = st(request)
        anilist_id, episode = int(body["anilist_id"]), int(body["episode"])
        lang = body.get("lang") if body.get("lang") in ("sub", "dub") else "sub"
        show = s.online.anime(anilist_id)
        if not 1 <= episode <= max(show["available"], 1):
            raise HTTPException(404, f"Episode {episode} is not out yet")
        found = s.online.resolve(anilist_id, show["mal_id"], episode, lang)
        start = body.get("start")
        if start is None:
            row = s.online.watched(user["id"], anilist_id).get(episode)
            start = row["position"] if row and not row["completed"] else 0.0
        names = {e["number"]: e["name"] for e in show["episodes"]}
        return {
            "mode": "online",
            "online": {
                "anilist_id": anilist_id,
                "episode": episode,
                "lang": lang,
                "name": show["name"],
                "poster": show["poster"],
                "background": show["background"],
                "available": show["available"],
            },
            "item": {
                "id": None,
                "title_name": show["name"],
                "label": f"Episode {episode}",
                "name": names.get(episode) or "",
            },
            "url": s.online.link(found["master"]),
            "session": None,
            "start": 0.0,
            "position": float(start),
            "duration": 0,  # the player reads it from the playlist
            "reasons": [
                (
                    f"Streamed from MegaPlay ({'dubbed' if lang == 'dub' else 'subtitled'}) "
                    "through this server; video and audio are copied, never re-encoded"
                )
            ],
            "audio_index": 1 if lang == "dub" else 0,
            "audio": [
                {
                    "index": 0,
                    "codec": "",
                    "lang": "ja",
                    "title": "Japanese (subtitled)",
                    "channels": 0,
                },
                {"index": 1, "codec": "", "lang": "en", "title": "English (dubbed)", "channels": 0},
            ],
            "subtitles": _offer_languages(
                s,
                [
                    {
                        # By language/label, not position: the order differs between sub and
                        # dub and between episodes, and the player remembers the key.
                        "key": "o-"
                        + re.sub(r"[^a-z0-9]+", "-", (t["lang"] or "") + " " + t["label"].lower()),
                        "lang": t["lang"],
                        "title": t["label"],
                        "forced": False,
                        "default": t["default"],
                        "codec": "webvtt",
                        "available": True,
                        "external": False,
                        "url": s.online.link(t["url"]),
                        "_src": t["url"],
                    }
                    for t in found["subtitles"]
                ],
                lambda src: {"url": src["_src"], "lang": src["lang"]},
            ),
            "intro": found["intro"],
            "outro": found["outro"],
            "preferences": s.library.preferences(user["id"]),
            "next": {"episode": episode + 1, "label": f"Episode {episode + 1}"}
            if episode < show["available"]
            else None,
        }

    @app.post("/api/online/progress")
    def online_progress(request: Request, body: dict = Body(...), user=Depends(current_user)):
        return st(request).online.progress(user["id"], body)

    @app.get("/api/online/hls/{token}")
    async def online_playlist(token: str, request: Request, user=Depends(current_user)):
        text = await st(request).online.playlist(token)
        return Response(
            text, media_type="application/vnd.apple.mpegurl", headers={"Cache-Control": "no-store"}
        )

    @app.get("/api/online/seg/{token}")
    async def online_segment(token: str, request: Request, user=Depends(current_user)):
        upstream, kind = await st(request).online.open(token)
        headers = {"Cache-Control": "private, max-age=86400"}  # segments never change
        if upstream.headers.get("content-length"):
            headers["Content-Length"] = upstream.headers["content-length"]
        return StreamingResponse(
            upstream.aiter_bytes(65536),
            media_type=kind,
            headers=headers,
            background=BackgroundTask(upstream.aclose),
        )

    # ---- online movies and TV (Cinemeta + Usenet) --------------------------------------

    @app.get("/api/usenet/search")
    def usenet_search(request: Request, q: str = "", user=Depends(current_user)):
        return {"results": st(request).usenet.search(q)}

    @app.get("/api/usenet/title/{kind}/{imdb_id}")
    def usenet_title(kind: str, imdb_id: str, request: Request, user=Depends(current_user)):
        usenet = st(request).usenet
        found = dict(usenet.title(kind, imdb_id))
        watched = usenet.watched(user["id"], imdb_id)

        def seen(season: int, episode: int) -> dict:
            row = watched.get((season, episode))
            return {
                "position": row["position"] if row else 0,
                "duration": row["duration"] if row else 0,
                "completed": bool(row and row["completed"]),
            }

        found["episodes"] = [{**e, **seen(e["season"], e["episode"])} for e in found["episodes"]]
        found["next"] = usenet.next_up(found, watched)
        found["ready"] = usenet.ready
        return found

    @app.get("/api/usenet/releases/{kind}/{imdb_id}")
    def usenet_releases(
        kind: str,
        imdb_id: str,
        request: Request,
        season: int = 0,
        episode: int = 0,
        user=Depends(current_user),
    ):
        usenet = st(request).usenet
        return {"releases": usenet.releases(usenet.title(kind, imdb_id), season, episode)}

    @app.post("/api/usenet/play")
    def usenet_play(request: Request, body: dict = Body(...), user=Depends(current_user)):
        """Open a release on the sidecar and start a stream that copies it to the player."""
        s = st(request)
        usenet = s.usenet
        title = usenet.title(str(body["kind"]), str(body["id"]))
        season, episode = int(body.get("season") or 0), int(body.get("episode") or 0)
        prefs = s.library.preferences(user["id"])
        caps = media.Caps.parse(body.get("caps"))
        caps.max_height = min(caps.max_height, int(prefs["max_height"]))
        if prefs["stereo"]:
            caps.channels = 2
        row = usenet.watched(user["id"], title["id"]).get((season, episode))
        last = row and row["release"]  # resume in the version that was being watched
        try:
            found = usenet.open(title, season, episode, body.get("release") or last, caps)
        except OnlineError:
            if body.get("release") or not last:
                raise
            found = usenet.open(title, season, episode, None, caps)
        info = found["info"]
        audio = body.get("audio")
        the_plan = media.plan(
            info,
            caps,
            "",
            int(audio) if audio is not None else None,
            prefs["audio_language"] or None,
        )
        if the_plan.mode == "direct":  # the file is on the sidecar, so it is always repackaged
            the_plan = media.escalate(the_plan, info, caps, "remux")
            the_plan.reasons = [f"{info['video'][0]['codec']} video is copied without re-encoding"]
        if body.get("escalate"):
            the_plan = media.escalate(the_plan, info, caps, body["escalate"])
        start = body.get("start")
        if start is None:
            start = row["position"] if row and not row["completed"] else 0.0
        start = max(0.0, min(float(start), max(0.0, info["duration"] - 5)))
        session = s.sessions.start(
            user_id=user["id"],
            client=str(body.get("client", "web")),
            file=usenet.file(found["url"]),
            item_id=0,
            info=info,
            the_plan=the_plan,
            caps=caps,
            start=start,
        )
        pairs = [(e["season"], e["episode"]) for e in title["episodes"]]
        at = pairs.index((season, episode)) if (season, episode) in pairs else -1
        following = pairs[at + 1] if 0 <= at < len(pairs) - 1 else (0, 0)
        token = s.online.sign(found["url"])
        return {
            "mode": the_plan.mode,
            "usenet": {
                "kind": title["kind"],
                "id": title["id"],
                "season": season,
                "episode": episode,
                "name": title["name"],
                "poster": title["poster"],
                "background": title["background"],
                "release": found["id"],
                "next_season": following[0],
                "next_episode": following[1],
            },
            "item": {
                "id": None,
                "title_name": title["name"],
                "label": f"S{season} · E{episode}" if title["kind"] == "show" else "",
                "name": title["episodes"][at]["name"] if at >= 0 else "",
            },
            "url": f"/api/stream/{session.id}/index.m3u8",
            "session": session.id,
            "hwaccel": session.public()["hwaccel"],
            "start": session.start,
            "position": start,
            "duration": info["duration"],
            "reasons": [f"Streamed from Usenet: {found['name']}", *the_plan.reasons],
            "audio_index": the_plan.audio_index,
            "audio": [
                {k: a[k] for k in ("index", "codec", "lang", "title", "channels")}
                for a in info["audio"]
            ],
            # Reading a subtitle track out of a remote file reads the whole file, so
            # translations start when one is picked, not on every play.
            "subtitles": _offer_languages(
                s,
                [
                    {
                        "key": f"s{sub['index']}",
                        "lang": sub["lang"],
                        "title": sub["title"],
                        "forced": sub["forced"],
                        "default": sub["default"],
                        "codec": sub["codec"],
                        "available": sub["text"],
                        "external": False,
                        "url": f"/api/usenet/subtitles/{token}/s{sub['index']}.vtt",
                    }
                    for sub in info["subtitles"]
                ],
                lambda src: {"dav": found["url"], "key": src["key"], "lang": src["lang"]},
                prepare=False,
            ),
            "preferences": prefs,
            "next": {"season": following[0], "episode": following[1]} if following[1] else None,
        }

    @app.post("/api/usenet/progress")
    def usenet_progress(request: Request, body: dict = Body(...), user=Depends(current_user)):
        s = st(request)
        if body.get("session"):
            s.sessions.get(str(body["session"]))  # keeps the stream alive while paused
        return s.usenet.progress(user["id"], body)

    @app.get("/api/usenet/subtitles/{token}/s{index}.vtt")
    async def usenet_subtitle(token: str, index: int, request: Request, user=Depends(current_user)):
        s = st(request)
        remote = s.usenet.file(s.online.unsign(token))
        try:
            path = await run_in_threadpool(s.subtitles.embedded, remote, index)
        except RuntimeError as error:
            raise HTTPException(422, f"Could not convert subtitles: {media.no_logins(str(error))}")
        return FileResponse(
            path,
            media_type="text/vtt; charset=utf-8",
            headers={"Cache-Control": "private, max-age=3600"},
        )

    # ---- artwork -----------------------------------------------------------------------

    def _art(s, url: str | None):
        path = s.metadata.artwork(url)
        if not path:
            raise HTTPException(404, "No artwork")
        head = path.read_bytes()[:12]
        kind = (
            "image/png"
            if head.startswith(b"\x89PNG")
            else "image/webp"
            if head[8:12] == b"WEBP"
            else "image/jpeg"
        )
        return FileResponse(
            path, media_type=kind, headers={"Cache-Control": "private, max-age=604800"}
        )

    live_api.routes(app, config, _art)

    # Registered before /api/art/{title_id}/{field}, which would otherwise capture "item/8".
    @app.get("/api/art/item/{item_id}")
    def item_art(item_id: int, request: Request, user=Depends(current_user)):
        s = st(request)
        row = s.db.one("SELECT thumbnail url FROM items WHERE id=?", item_id)
        if not row:
            raise KeyError(item_id)
        return _art(s, row["url"])

    @app.get("/api/art/{title_id}/{field}")
    def art(title_id: int, field: str, request: Request, user=Depends(current_user)):
        if field not in ("poster", "background", "logo"):
            raise HTTPException(404)
        s = st(request)
        row = s.db.one(f"SELECT {field} url FROM titles WHERE id=?", title_id)
        if not row:
            raise KeyError(title_id)
        return _art(s, row["url"])

    # ---- administration ----------------------------------------------------------------

    @app.post("/api/admin/scan")
    def scan(request: Request, _=Depends(admin_user)):
        s = st(request)
        if s.scanner.running:
            return {"started": False, "running": True}
        if s.jobs.thread and s.jobs.thread.is_alive():
            s.jobs.trigger()
        else:
            threading.Thread(target=s.jobs.run_library, daemon=True).start()
        return {"started": True}

    @app.get("/api/admin/overview")
    def overview(request: Request, _=Depends(admin_user)):
        s = st(request)
        count = lambda sql: s.db.one(sql)["n"]
        return {
            "scan": {
                "running": s.scanner.running,
                "last": s.scanner.last,
                "metadata_running": s.jobs.metadata_running,
            },
            "roots": [str(r) for r in config.library_roots],
            "counts": {
                "movies": count("SELECT COUNT(*) n FROM titles WHERE kind='movie'"),
                "shows": count("SELECT COUNT(*) n FROM titles WHERE kind='show'"),
                "files": count("SELECT COUNT(*) n FROM files WHERE missing=0"),
                "missing": count("SELECT COUNT(*) n FROM files WHERE missing=1"),
                "unmatched": count("SELECT COUNT(*) n FROM unmatched"),
                "no_metadata": count("SELECT COUNT(*) n FROM titles WHERE matched=-1"),
            },
            "settings": {
                "hwaccel": config.hwaccel,
                "max_transcodes": config.max_transcodes,
                "metadata_online": config.metadata_online,
                "scan_interval": config.scan_interval,
            },
            "sessions": [x.public() for x in s.sessions.items.values()],
        }

    @app.get("/api/admin/review")
    def review(request: Request, _=Depends(admin_user)):
        s = st(request)
        return {
            "files": s.db.all("SELECT * FROM unmatched ORDER BY path"),
            "titles": [
                dict(r, genres=json.loads(r["genres"]))
                for r in s.db.all(
                    "SELECT id, kind, name, year, matched, genres FROM titles "
                    "WHERE matched=-1 ORDER BY name"
                )
            ],
            "missing": s.db.all(
                "SELECT f.id, f.path, t.name title, i.season, i.episode FROM files f "
                "JOIN items i ON i.id=f.item_id JOIN titles t ON t.id=i.title_id "
                "WHERE f.missing=1 ORDER BY f.path LIMIT 500"
            ),
        }

    @app.post("/api/admin/review/{unmatched_id}/assign")
    def assign_unmatched(
        unmatched_id: int, request: Request, body: dict = Body(...), _=Depends(admin_user)
    ):
        s = st(request)
        row = s.db.one("SELECT path FROM unmatched WHERE id=?", unmatched_id)
        if not row:
            raise KeyError(unmatched_id)
        result = s.scanner.assign(row["path"], body)
        _refresh_after_assign(s, result)
        return result

    @app.post("/api/admin/files/{file_id}/assign")
    def assign_file(file_id: int, request: Request, body: dict = Body(...), _=Depends(admin_user)):
        s = st(request)
        row = s.db.one("SELECT path FROM files WHERE id=?", file_id)
        if not row:
            raise KeyError(file_id)
        result = s.scanner.assign(row["path"], body)
        _refresh_after_assign(s, result)
        return result

    def _refresh_after_assign(s, result: dict):
        if result.get("item_id") and config.metadata_online:
            title_row = s.db.one("SELECT title_id FROM items WHERE id=?", result["item_id"])
            threading.Thread(
                target=_safe_refresh, args=(s, title_row["title_id"]), daemon=True
            ).start()

    def _safe_refresh(s, title_id: int):
        try:
            s.metadata.refresh(title_id)
        except Exception as error:  # noqa: BLE001 - network errors of every kind
            log.warning("Metadata refresh failed: %s", error)

    @app.get("/api/admin/titles/{title_id}")
    def admin_title(title_id: int, request: Request, _=Depends(admin_user)):
        row = st(request).db.one("SELECT * FROM titles WHERE id=?", title_id)
        if not row:
            raise KeyError(title_id)
        return {
            **row,
            "genres": json.loads(row["genres"]),
            "locked_fields": json.loads(row["locked_fields"]),
        }

    @app.patch("/api/admin/titles/{title_id}")
    def edit_title(title_id: int, request: Request, body: dict = Body(...), _=Depends(admin_user)):
        s = st(request)
        if body.get("unlock"):
            s.metadata.unlock(title_id, list(body.pop("unlock")))
        row = s.metadata.edit(title_id, body)
        return {
            **row,
            "genres": json.loads(row["genres"]),
            "locked_fields": json.loads(row["locked_fields"]),
        }

    @app.post("/api/admin/titles/{title_id}/refresh")
    def refresh_title(title_id: int, request: Request, _=Depends(admin_user)):
        if not config.metadata_online:
            raise HTTPException(409, "Metadata is offline (METADATA_ONLINE=false)")
        row = st(request).metadata.refresh(title_id, force=True)
        return {
            **row,
            "genres": json.loads(row["genres"]),
            "locked_fields": json.loads(row["locked_fields"]),
        }

    @app.get("/api/admin/metadata/search")
    def search_metadata(request: Request, kind: str = "movie", q: str = "", _=Depends(admin_user)):
        return st(request).metadata.search(kind, q)

    # ---- web UI ------------------------------------------------------------------------

    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/")
    def index():
        # Stamp asset URLs with their modification time, so browsers and TVs pick up an
        # update immediately instead of running a cached app.js.
        html = (STATIC / "index.html").read_text(encoding="utf-8")
        for name in ("app.js", "styles.css"):
            stamp = int((STATIC / name).stat().st_mtime)
            html = html.replace(f"/static/{name}", f"/static/{name}?v={stamp}")
        return Response(html, media_type="text/html", headers={"Cache-Control": "no-cache"})

    return app


def main():
    import uvicorn

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    uvicorn.run(
        create_app(),
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8787")),
        # Only trust X-Forwarded-For from these proxies, or anyone could fake their address
        # and dodge the login rate limit.
        proxy_headers=True,
        forwarded_allow_ips=os.environ.get("FORWARDED_ALLOW_IPS", "127.0.0.1"),
    )


if __name__ == "__main__":
    main()
