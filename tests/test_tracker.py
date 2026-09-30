import asyncio

from app.db import Store
from app.geo import Point
from app.glympse import InviteUpdate
from app.tracker import Tracker


class FakeClient:
    """Glympse sends 'completed' only on the first fetch, not on later incremental ones."""

    def __init__(self):
        self.calls = 0

    async def current_invites(self, tag):
        return ["ABC"]

    async def invite(self, code, next_ts):
        self.calls += 1
        if self.calls == 1:
            return InviteUpdate([Point(1790770073637, 40.67, -73.98)], 1790770073638, ended=True)
        return InviteUpdate([], next_ts, ended=False)


def test_ended_share_stays_ended(tmp_path):
    tracker = Tracker(Store(tmp_path / "t.sqlite3"), FakeClient())
    asyncio.run(tracker.poll_once())
    asyncio.run(tracker.poll_once())
    assert tracker.share_active is False
    assert len(tracker.store.trip_points("2026-09-30")) == 1
