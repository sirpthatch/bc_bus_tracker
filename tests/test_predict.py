from datetime import datetime

from app import config
from app.geo import Point
from app.glympse import parse_invite
from app.predict import build_past_trip, predict
from app.status import build_status

STOP = config.ROUTE[-1]
# 8th Ave & 9th St, the stop before ours.
PREV = config.ROUTE[-2]


def at(hh, mm, ss=0, day=1):
    return datetime(2026, 10, day, hh, mm, ss, tzinfo=config.TZ)


def ms(dt):
    return int(dt.timestamp() * 1000)


def trip(day, start: datetime, minutes_to_stop: float, steps=30):
    """A straight drive from the previous stop to ours taking minutes_to_stop."""
    pts = []
    for i in range(steps + 1):
        f = i / steps
        pts.append(Point(
            ts=ms(start) + int(f * minutes_to_stop * 60_000),
            lat=PREV.lat + f * (STOP.lat - PREV.lat),
            lon=PREV.lon + f * (STOP.lon - PREV.lon),
            speed=5.0,
            heading=300.0,
        ))
    return pts


def history(*durations):
    return [build_past_trip(f"2026-09-{10 + i}", trip(10 + i, at(7, 54, day=1), d), STOP) for i, d in enumerate(durations)]


def test_arrival_detected():
    t = build_past_trip("2026-09-10", trip(10, at(7, 54), 4), STOP)
    assert t is not None
    assert abs(t.arrival_ts - ms(at(7, 58))) <= 60_000


def test_trip_that_never_reaches_stop_is_skipped():
    pts = trip(10, at(7, 54), 4)[:10]
    assert build_past_trip("2026-09-10", pts, STOP) is None


def test_predict_uses_median_of_past_trips():
    hist = history(3, 4, 5, 6, 20)
    cur = Point(ts=ms(at(8, 0)), lat=PREV.lat, lon=PREV.lon, speed=5.0, heading=300.0)
    p = predict(cur, hist)
    assert p is not None and p.trips_used == 5
    assert abs(p.eta_ts - ms(at(8, 5))) <= 60_000
    assert p.low_ts <= p.eta_ts <= p.high_ts


def test_predict_needs_enough_history():
    cur = Point(ts=ms(at(8, 0)), lat=PREV.lat, lon=PREV.lon)
    assert predict(cur, history(4, 5)) is None


def test_predict_ignores_trips_far_from_current_position():
    cur = Point(ts=ms(at(7, 30)), lat=config.ROUTE[0].lat, lon=config.ROUTE[0].lon)
    assert predict(cur, history(4, 5, 6)) is None


def test_status_falls_back_to_schedule_without_history():
    now = at(7, 50)
    pts = trip(1, at(7, 49), 10)[:3]
    s = build_status(now, STOP, pts, [], tracking=True, share_active=True)
    assert s["state"] == "tracking"
    assert s["eta_source"] == "schedule"
    assert s["eta"] == at(7, 58).isoformat()


def test_status_uses_history_when_available():
    now = at(7, 55)
    pts = [Point(ts=ms(now), lat=PREV.lat, lon=PREV.lon, speed=5.0, heading=300.0)]
    s = build_status(now, STOP, pts, history(4, 5, 6), tracking=True, share_active=True)
    assert s["eta_source"] == "history"
    assert s["eta"][11:16] in ("07:59", "08:00")


def test_status_reports_arrival():
    now = at(8, 5)
    s = build_status(now, STOP, trip(1, at(7, 54), 4), [], tracking=True, share_active=True)
    assert s["state"] == "arrived"
    assert s["arrived_at"].startswith("2026-10-01T07:5")
    assert s["last_stop"]["num"] == STOP.num


def test_status_off_hours_points_to_next_school_morning():
    friday_evening = datetime(2026, 10, 2, 18, 0, tzinfo=config.TZ)
    s = build_status(friday_evening, STOP, [], [], tracking=False, share_active=False)
    assert s["state"] == "off_hours"
    assert s["scheduled"] == datetime(2026, 10, 5, 7, 58, tzinfo=config.TZ).isoformat()


def test_parse_invite():
    resp = {
        "location": [[1790770073637, 40673658, -73979203, 729, 32, 24, 8, 3]],
        "next": 1790778874964,
        "properties": [{"t": 1, "n": "completed", "v": True}],
    }
    u = parse_invite(resp)
    assert u.ended and u.next == 1790778874964
    p = u.points[0]
    assert (p.lat, p.lon, p.speed, p.heading) == (40.673658, -73.979203, 7.29, 32)


def test_status_for_an_earlier_stop_uses_its_own_schedule_and_arrival():
    # The bus has passed stop 8 (8th Ave & 9th St) but not yet stop 9.
    pts = trip(1, at(7, 54), 4)[:3]
    s = build_status(at(7, 55), PREV, pts, [], tracking=True, share_active=True)
    assert s["stop"]["num"] == PREV.num
    assert s["state"] == "arrived"
    s9 = build_status(at(7, 55), STOP, pts, [], tracking=True, share_active=True)
    assert s9["state"] == "tracking"
    assert s9["eta"] == at(7, 58).isoformat()


def test_status_schedule_fallback_for_middle_stop():
    s = build_status(at(7, 0), config.STOPS[3], [], [], tracking=True, share_active=False)
    assert s["state"] == "waiting"
    assert s["eta"] == at(7, 37).isoformat()
