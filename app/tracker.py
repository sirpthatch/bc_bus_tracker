"""Background poller: records the bus's trail each school morning."""

import asyncio
import logging
from datetime import datetime

from . import config
from .db import Store
from .glympse import GlympseClient
from .predict import PastTrip, build_past_trip, find_arrival

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
        self._history: tuple[str, list[PastTrip]] | None = None
        # Arrival time at our stop per past date (None = never reached it). Past days don't change.
        self._arrivals: dict[str, int | None] = {}

    def history(self, today: str) -> list[PastTrip]:
        """Past trips that reached our stop, most recent first. Cached per day."""
        if self._history is None or self._history[0] != today:
            trips = []
            for date in self.store.trip_dates(before=today, limit=config.MAX_HISTORY_TRIPS * 2):
                trip = build_past_trip(date, self.store.trip_points(date))
                if trip:
                    trips.append(trip)
                if len(trips) >= config.MAX_HISTORY_TRIPS:
                    break
            self._history = (today, trips)
        return self._history[1]

    def arrivals(self, today: str) -> list[tuple[str, int]]:
        """(date, arrival_ts) for every recorded morning before today, most recent first."""
        out = []
        for date in self.store.trip_dates(before=today, limit=10_000):
            if date not in self._arrivals:
                stop = config.MY_STOP
                self._arrivals[date] = find_arrival(self.store.trip_points(date), stop.lat, stop.lon)
            if self._arrivals[date] is not None:
                out.append((date, self._arrivals[date]))
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
