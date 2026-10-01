"""Background poller: records the bus's trail each school morning."""

import asyncio
import logging
from datetime import datetime

from . import config
from .db import Store
from .glympse import GlympseClient
from .geo import Point
from .predict import PastTrip, arrivals_by_stop, build_past_trip, thin

log = logging.getLogger(__name__)


def in_window(now: datetime) -> bool:
    if config.FORCE_TRACKING:
        return True
    return now.weekday() in config.TRACK_WEEKDAYS and config.TRACK_START <= now.time() < config.TRACK_END


class Tracker:
    def __init__(self, store: Store, client: GlympseClient):
        self.store = store
        self.client = client
        self.invite_next: dict[str, int] = {}
        # Glympse only sends a property once, so remember which shares have ended.
        self.invite_ended: set[str] = set()
        self.share_active = False
        self.last_poll: datetime | None = None
        self.last_error: str | None = None
        # Arrival time at each stop per past date (None = never reached it). Past days don't change.
        self._day_arrivals: dict[str, dict[int, int | None]] = {}
        # Thinned trails of the most recent mornings, reloaded once per day.
        self._recent: tuple[str, list[tuple[str, list[Point]]]] | None = None
        self._history: dict[tuple[str, int], list[PastTrip]] = {}

    def _remember_arrivals(self, date: str, points: list[Point] | None = None) -> dict[int, int | None]:
        if date not in self._day_arrivals:
            self._day_arrivals[date] = arrivals_by_stop(points if points is not None else self.store.trip_points(date))
        return self._day_arrivals[date]

    def _recent_trails(self, today: str) -> list[tuple[str, list[Point]]]:
        if self._recent is None or self._recent[0] != today:
            trails = []
            for date in self.store.trip_dates(before=today, limit=config.MAX_HISTORY_TRIPS):
                points = self.store.trip_points(date)
                self._remember_arrivals(date, points)
                trails.append((date, thin(points)))
            self._recent = (today, trails)
            self._history = {}
        return self._recent[1]

    def history(self, today: str, stop: config.Stop) -> list[PastTrip]:
        """Recent past trips that reached this stop, most recent first. Cached per day."""
        trails = self._recent_trails(today)
        key = (today, stop.num)
        if key not in self._history:
            trips = []
            for date, points in trails:
                arrival = self._day_arrivals[date][stop.num]
                if arrival is not None:
                    trips.append(build_past_trip(date, points, stop, arrival))
            self._history[key] = trips
        return self._history[key]

    def arrivals(self, today: str, stop: config.Stop) -> list[tuple[str, int]]:
        """(date, arrival_ts) at this stop for every recorded morning before today, most recent first."""
        out = []
        for date in self.store.trip_dates(before=today, limit=10_000):
            arrival = self._remember_arrivals(date)[stop.num]
            if arrival is not None:
                out.append((date, arrival))
        return out

    async def poll_once(self) -> None:
        codes = await self.client.current_invites(config.GLYMPSE_TAG)
        active = False
        for code in codes:
            update = await self.client.invite(code, self.invite_next.get(code, 0))
            self.invite_next[code] = update.next
            if update.ended:
                self.invite_ended.add(code)
            active = active or code not in self.invite_ended
            by_date: dict[str, list] = {}
            for p in update.points:
                date = datetime.fromtimestamp(p.ts / 1000, config.TZ).date().isoformat()
                by_date.setdefault(date, []).append(p)
            for date, pts in by_date.items():
                added = self.store.add_points(date, pts)
                if added:
                    log.info("Stored %d new points for %s from invite %s", added, date, code)
        self.share_active = active

    async def run(self) -> None:
        log.info("Tracker started; window %s-%s %s", config.TRACK_START, config.TRACK_END, config.TZ)
        while True:
            now = datetime.now(config.TZ)
            if in_window(now):
                try:
                    await self.poll_once()
                    self.last_error = None
                except Exception as e:  # keep polling through network hiccups
                    log.exception("Poll failed")
                    self.last_error = str(e)
                self.last_poll = now
                await asyncio.sleep(config.POLL_SECONDS)
            else:
                self.share_active = False
                self.invite_next.clear()
                self.invite_ended.clear()
                await asyncio.sleep(30)
