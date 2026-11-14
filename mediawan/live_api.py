"""HTTP routes for live sports (channels, schedule, live streams) and their admin page."""

import logging
import re
import threading
import time

from fastapi import Body, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from . import live, sports
from .auth import admin_user, current_user
from .config import Config

log = logging.getLogger("mediawan.live")


def _scrub(text: str) -> str:
    return re.sub(r"(username|password)=[^&'\s]+", r"\1=…", str(text))


def start(state, config: Config, background: bool, client=None, fixtures_client=None):
    """Create the live TV services on app start-up."""
    # httpx logs every request URL at INFO, and an Xtream provider's URLs carry its password.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    folder = config.live_dir or config.database.parent / "live-tv"
    state.live = live.Catalog(folder, client=client)
    state.guide = sports.Guide(
        folder,
        state.live,
        sports.DEFAULT_GUIDES if config.live_guides is None else config.live_guides,
        client=client,
    )
    state.fixtures = sports.Fixtures(client=fixtures_client) if config.live_fixtures else None
    state.streams = live.Streams(
        state.live,
        config.ffmpeg,
        config.ffprobe,
        config.runtime,
        config.hwaccel,
        transcodes=lambda: sum(
            1 for s in list(state.sessions.items.values()) if s.plan.mode == "transcode"
        ),
        max_transcodes=config.max_transcodes,
    )
    state.guide_stop = threading.Event()
    if background and config.live_tv:

        def loop():
            while not state.guide_stop.is_set():
                if state.live.channels and state.guide.stale():
                    try:
                        state.guide.refresh()
                    except Exception as error:  # noqa: BLE001 - keep the loop alive
                        log.error("Guide refresh failed: %s", _scrub(error))  # no URLs in logs
                state.guide_stop.wait(900)

        threading.Thread(target=loop, name="mediawan-guide", daemon=True).start()


def stop(state):
    state.guide_stop.set()
    state.streams.stop_all()


def routes(app: FastAPI, config: Config, art):
    """art(state, url) -> FileResponse for a cached remote image."""

    def st(request: Request):
        state = request.app.state
        if not config.live_tv:
            raise HTTPException(404, "Live TV is turned off (LIVE_TV=false)")
        return state

    def viewer(user: dict, client) -> str:
        return f"{user['id']}:{str(client or 'web')[:40]}"

    @app.get("/api/live")
    def live_status(request: Request, user=Depends(current_user)):
        if not config.live_tv:
            return {"enabled": False}
        s = request.app.state
        return {
            "enabled": True,
            "channels": len(s.live.channels),
            "languages": s.live.languages(),
            "sports": live.SPORTS,
            "max_connections": s.live.max_connections,
            "guide": {
                "updated": s.guide.data.get("updated") or None,
                "channels": len(s.guide.data["programmes"]),
            },
            "watching": [
                {"channel": live.public(x.channel), "viewers": len(x.viewers)}
                for x in s.streams.items.values()
            ],
        }

    @app.get("/api/live/channels")
    def live_channels(
        request: Request, q: str = "", language: str = "", offset: int = 0, limit: int = 60,
        user=Depends(current_user),
    ):  # fmt: skip
        s = st(request)
        found = s.live.search(q, language, min(limit, 200), max(offset, 0))
        for c in found["channels"]:
            c["now"] = s.guide.now(c["id"])
        return found

    @app.get("/api/live/schedule")
    async def live_schedule(
        request: Request, start: float, end: float, language: str = "", user=Depends(current_user)
    ):
        s = st(request)
        if not 0 < end - start <= 3 * 86400:
            raise HTTPException(400, "Ask for at most three days at a time")
        events = await run_in_threadpool(
            sports.schedule, s.guide, s.fixtures, s.live, start, end, language
        )
        return {"events": events, "guide_updated": s.guide.data.get("updated") or None}

    @app.get("/api/live/channels/{channel_id}/guide")
    def channel_guide(channel_id: str, request: Request, user=Depends(current_user)):
        s = st(request)
        channel = s.live.by_id.get(channel_id)
        if not channel:
            raise KeyError(channel_id)
        now = time.time()
        upcoming = [p for p in s.guide.programmes(channel_id) if p[1] > now][:12]
        return {
            "channel": live.public(channel),
            "programmes": [
                {"start": p[0], "stop": p[1], "title": p[2], "desc": p[3]} for p in upcoming
            ],
        }

    @app.post("/api/live/watch")
    async def watch(request: Request, body: dict = Body(...), user=Depends(current_user)):
        s = st(request)
        key = viewer(user, body.get("client"))
        stream = await run_in_threadpool(
            s.streams.watch, str(body.get("channel_id")), key, bool(body.get("tv"))
        )
        ready = await run_in_threadpool(s.streams.wait_ready, stream, 30)
        if not ready:
            error = stream.error
            s.streams.leave(stream.id, key)
            raise HTTPException(
                502,
                "The channel stopped before it started playing" + (f": {error}" if error else ""),
            )
        channel = stream.channel
        programme = s.guide.now(channel["id"])
        return {
            "mode": "live",
            "live": {
                "stream": stream.id,
                "channel": live.public(channel),
                "programme": programme,
                "viewers": len(stream.viewers),
            },
            "item": {
                "id": None,
                "title_name": channel["name"],
                "label": "Live",
                "name": programme["title"] if programme else channel.get("group") or "",
            },
            "url": f"/api/live/stream/{stream.id}/index.m3u8",
            "session": None,
            "start": 0.0,
            "position": 0.0,
            "duration": 0,
            "reasons": stream.reasons
            + [
                "Shared with everyone watching this channel"
                if len(stream.viewers) > 1
                else "One provider connection, shared if others join this channel"
            ],
            "audio_index": None,
            "audio": [],
            "subtitles": [],
            "preferences": s.library.preferences(user["id"]),
            "next": None,
        }

    @app.get("/api/live/stream/{sid}/{name}")
    def live_file(sid: str, name: str, request: Request, user=Depends(current_user)):
        if not live.LIVE_FILE.match(name):
            raise HTTPException(404)
        s = st(request)
        stream = s.streams.get(sid)
        if not stream:
            raise HTTPException(404, "This live stream has ended")
        path = stream.dir / name
        if name == "index.m3u8":
            try:
                text = path.read_text(errors="ignore")
            except OSError as error:
                raise HTTPException(404, "Not ready") from error
            return Response(
                text,
                media_type="application/vnd.apple.mpegurl",
                headers={"Cache-Control": "no-store"},
            )
        if not path.exists():
            raise HTTPException(404, "Segment gone")
        return FileResponse(path, media_type="video/mp2t")

    @app.post("/api/live/streams/{sid}/ping")
    def live_ping(
        sid: str, request: Request, body: dict = Body(default={}), user=Depends(current_user)
    ):
        s = st(request)
        stream = s.streams.get(sid, viewer(user, body.get("client")))
        if not stream:
            raise HTTPException(404, "This live stream has ended")
        return {
            "error": stream.error,
            "viewers": len(stream.viewers),
            "programme": s.guide.now(stream.channel["id"]),
        }

    @app.delete("/api/live/streams/{sid}")
    def live_leave(sid: str, request: Request, client: str = "", user=Depends(current_user)):
        st(request).streams.leave(sid, viewer(user, client))
        return {"ok": True}

    @app.get("/api/live/logo/{channel_id}")
    def logo(channel_id: str, request: Request, user=Depends(current_user)):
        s = st(request)
        channel = s.live.by_id.get(channel_id)
        if not channel or not channel.get("logo"):
            raise HTTPException(404, "No logo")
        return art(s, channel["logo"])

    # ---- admin --------------------------------------------------------------------------

    def overview(s) -> dict:
        data = s.live.data
        return {
            "name": data.get("name"),
            "imported": data.get("importedAt"),
            "channels": len(s.live.channels),
            "max_connections": s.live.max_connections,
            "account": s.live.status() if s.live.channels else None,
            "guide": {
                "updated": s.guide.data.get("updated") or None,
                "running": s.guide.running,
                "sources": [
                    # Scrubbed again on the way out: a guide.json saved by an older version
                    # may hold a provider URL with its password in an error message.
                    {**src, "error": _scrub(src["error"])} if src.get("error") else src
                    for src in s.guide.data.get("sources") or []
                ],
                "channels": len(s.guide.data["programmes"]),
            },
            "fixtures": bool(s.fixtures),
            "streams": [x.public() for x in s.streams.items.values()],
            "folder": str(s.live.folder),
        }

    @app.get("/api/admin/live")
    async def admin_live(request: Request, _=Depends(admin_user)):
        s = st(request)
        return await run_in_threadpool(overview, s)

    def _after_import(s):
        threading.Thread(target=s.guide.refresh, daemon=True).start()

    @app.post("/api/admin/live/xtream")
    async def import_xtream(request: Request, body: dict = Body(...), _=Depends(admin_user)):
        s = st(request)
        account = s.live.account() or {}
        password = body.get("password") or (
            account.get("password") if body.get("server") == account.get("server") else ""
        )
        if not (body.get("server") and body.get("username") and password):
            raise HTTPException(400, "Enter the server, username and password")
        try:
            count = await run_in_threadpool(
                s.live.import_xtream,
                body["server"],
                body["username"],
                password,
                bool(body.get("everything")),
            )
        except Exception as error:  # network trouble reads better than a 500
            if isinstance(error, ValueError):
                raise
            raise HTTPException(502, "Could not reach the provider") from error
        _after_import(s)
        return {"channels": count}

    @app.post("/api/admin/live/m3u")
    async def import_m3u(request: Request, body: dict = Body(...), _=Depends(admin_user)):
        s = st(request)
        text = str(body.get("text") or "")
        if len(text) > 30 * 1024 * 1024:
            raise HTTPException(413, "That playlist is larger than 30 MB")
        count = await run_in_threadpool(s.live.import_m3u, text, body.get("name") or "Playlist")
        _after_import(s)
        return {"channels": count}

    @app.post("/api/admin/live/settings")
    def live_settings(request: Request, body: dict = Body(...), _=Depends(admin_user)):
        s = st(request)
        if "max_connections" in body:
            s.live.set_max_connections(int(body["max_connections"]))
        return {"max_connections": s.live.max_connections}

    @app.post("/api/admin/live/guide")
    def refresh_guide(request: Request, _=Depends(admin_user)):
        s = st(request)
        if not s.live.channels:
            raise HTTPException(409, "Import channels first")
        if not s.guide.running:
            threading.Thread(target=s.guide.refresh, daemon=True).start()
        return {"started": True}

    @app.delete("/api/admin/live/streams/{sid}")
    def end_stream(sid: str, request: Request, _=Depends(admin_user)):
        st(request).streams.stop(sid)
        return {"ok": True}
