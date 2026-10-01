import asyncio
import base64
import logging
import secrets
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from . import config
from .db import Store
from .glympse import GlympseClient
from .status import build_status, history_summary
from .tracker import Tracker, in_window

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with httpx.AsyncClient(timeout=20) as http:
        app.state.tracker = Tracker(Store(config.DB_PATH), GlympseClient(http))
        task = asyncio.create_task(app.state.tracker.run())
        yield
        task.cancel()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)


@app.middleware("http")
async def basic_auth(request: Request, call_next):
    if config.SITE_PASSWORD and request.url.path != "/healthz":
        expected = base64.b64encode(f"{config.SITE_USER}:{config.SITE_PASSWORD}".encode()).decode()
        given = request.headers.get("authorization", "").removeprefix("Basic ")
        if not secrets.compare_digest(given, expected):
            return Response(status_code=401, headers={"WWW-Authenticate": 'Basic realm="Bus tracker"'})
    return await call_next(request)


@app.get("/healthz")
async def healthz():
    return {"ok": True}


def _stop(num: int | None) -> config.Stop:
    if num is None:
        return config.DEFAULT_STOP
    if num not in config.STOPS:
        raise HTTPException(404, f"No stop {num} on this route")
    return config.STOPS[num]


@app.get("/api/status")
async def status(request: Request, stop: int | None = None):
    tracker: Tracker = request.app.state.tracker
    now = datetime.now(config.TZ)
    today = now.date().isoformat()
    s = _stop(stop)
    return build_status(
        now,
        s,
        tracker.store.trip_points(today),
        tracker.history(today, s),
        tracking=in_window(now),
        share_active=tracker.share_active,
        last_error=tracker.last_error,
    )


@app.get("/api/history")
async def history(request: Request, stop: int | None = None):
    tracker: Tracker = request.app.state.tracker
    s = _stop(stop)
    return history_summary(tracker.arrivals(datetime.now(config.TZ).date().isoformat(), s), s)


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
