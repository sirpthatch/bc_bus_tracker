"""Minimal client for the public Glympse viewer API (the same calls glympse.com/!<tag> makes)."""

import logging
from dataclasses import dataclass

import httpx

from . import config
from .geo import Point

log = logging.getLogger(__name__)


@dataclass
class InviteUpdate:
    points: list[Point]
    next: int
    ended: bool


def parse_location(row: list) -> Point:
    # Rows look like [ts_ms, lat*1e6, lon*1e6, speed_cm_s, heading, ...]
    speed = row[3] / 100 if len(row) > 3 and row[3] is not None and row[3] >= 0 else None
    heading = row[4] if len(row) > 4 and row[4] is not None and row[4] >= 0 else None
    return Point(ts=int(row[0]), lat=row[1] / 1e6, lon=row[2] / 1e6, speed=speed, heading=heading)


def parse_invite(resp: dict) -> InviteUpdate:
    props = {p["n"]: p["v"] for p in resp.get("properties", [])}
    return InviteUpdate(
        points=[parse_location(r) for r in resp.get("location", [])],
        next=int(resp.get("next", 0)),
        ended=bool(props.get("completed") or props.get("expired")),
    )


class GlympseClient:
    def __init__(self, http: httpx.AsyncClient):
        self.http = http
        self.token: str | None = None

    async def _login(self) -> None:
        r = await self.http.get(
            f"{config.GLYMPSE_API}/account/login",
            params={"username": "viewer", "password": "password", "api_key": config.GLYMPSE_API_KEY},
        )
        r.raise_for_status()
        self.token = r.json()["response"]["access_token"]

    async def _get(self, path: str, params: dict | None = None) -> dict:
        for attempt in range(2):
            if self.token is None:
                await self._login()
            r = await self.http.get(
                f"{config.GLYMPSE_API}{path}",
                params=params,
                headers={"Authorization": f"Bearer {self.token}"},
            )
            body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            if attempt == 0 and (r.status_code == 401 or body.get("result") == "failure"):
                log.info("Glympse token rejected (%s); logging in again", body.get("meta") or r.status_code)
                self.token = None
                continue
            r.raise_for_status()
            if body.get("result") != "ok":
                raise RuntimeError(f"Glympse error on {path}: {body}")
            return body["response"]
        raise RuntimeError(f"Glympse auth failed for {path}")

    async def current_invites(self, tag: str) -> list[str]:
        group = await self._get(f"/groups/{tag}")
        return [m["invite"] for m in group.get("members", []) if m.get("invite")]

    async def invite(self, code: str, next_ts: int) -> InviteUpdate:
        return parse_invite(await self._get(f"/invites/{code}", {"next": next_ts, "uncompressed": "true"}))
