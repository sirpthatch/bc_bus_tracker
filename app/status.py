"""Builds the JSON the web page renders."""

from datetime import date, datetime, timedelta

from . import config
from .geo import Point
from .predict import PastTrip, find_arrival, last_stop_passed, predict

STALE_AFTER = timedelta(minutes=10)
MAX_TRAIL_POINTS = 400


def _iso(ts_ms: int | None) -> str | None:
    if ts_ms is None:
        return None
    return datetime.fromtimestamp(ts_ms / 1000, config.TZ).isoformat()


def _scheduled_on(day: date, stop: config.Stop) -> datetime:
    return datetime.combine(day, stop.scheduled, config.TZ)


def next_school_morning(now: datetime) -> date:
    day = now.date()
    if now.time() >= config.TRACK_END or now.weekday() not in config.TRACK_WEEKDAYS:
        day += timedelta(days=1)
    while day.weekday() not in config.TRACK_WEEKDAYS:
        day += timedelta(days=1)
    return day


def build_status(
    now: datetime,
    stop: config.Stop,
    today_points: list[Point],
    history: list[PastTrip],
    tracking: bool,
    share_active: bool,
    last_error: str | None = None,
) -> dict:
    arrival_ts = find_arrival(today_points, stop.lat, stop.lon)
    latest = today_points[-1] if today_points else None
    bus_fresh = latest is not None and now - datetime.fromtimestamp(latest.ts / 1000, config.TZ) < STALE_AFTER

    service_day = now.date() if tracking or arrival_ts else next_school_morning(now)
    scheduled = _scheduled_on(service_day, stop)

    if arrival_ts:
        state = "arrived"
    elif not tracking:
        state = "off_hours"
    elif bus_fresh and share_active:
        state = "tracking"
    elif today_points and not share_active:
        state = "ended"
    else:
        state = "waiting"

    prediction = predict(latest, history) if state == "tracking" else None
    if prediction:
        eta_ts, low_ts, high_ts, source = prediction.eta_ts, prediction.low_ts, prediction.high_ts, "history"
    else:
        eta_ts = low_ts = high_ts = int(scheduled.timestamp() * 1000)
        source = "schedule"
    if arrival_ts:
        eta_ts = low_ts = high_ts = arrival_ts
        source = "arrived"

    step = max(1, len(today_points) // MAX_TRAIL_POINTS)
    passed = last_stop_passed(today_points) if today_points else None

    return {
        "now": now.isoformat(),
        "state": state,
        "stop": {
            "num": stop.num,
            "name": stop.name,
            "lat": stop.lat,
            "lon": stop.lon,
            "scheduled": stop.scheduled.strftime("%H:%M"),
        },
        "scheduled": scheduled.isoformat(),
        "eta": _iso(eta_ts),
        "eta_low": _iso(low_ts),
        "eta_high": _iso(high_ts),
        "eta_source": source,
        "history_trips": len(history),
        "trips_used": prediction.trips_used if prediction else 0,
        "min_history_trips": config.MIN_HISTORY_TRIPS,
        "default_walk_minutes": config.DEFAULT_WALK_MINUTES,
        "arrived_at": _iso(arrival_ts),
        "bus": (
            {
                "lat": latest.lat,
                "lon": latest.lon,
                "heading": latest.heading,
                "speed_mph": round(latest.speed * 2.23694) if latest.speed is not None else None,
                "at": _iso(latest.ts),
            }
            if latest and (bus_fresh or arrival_ts)
            else None
        ),
        "trail": [[p.lat, p.lon] for p in today_points[::step]],
        "last_stop": (
            {
                "num": passed[0].num,
                "name": passed[0].name,
                "scheduled": _scheduled_on(now.date(), passed[0]).isoformat(),
                "at": _iso(passed[1]),
            }
            if passed
            else None
        ),
        "route": [
            {"num": s.num, "name": s.name, "lat": s.lat, "lon": s.lon, "scheduled": s.scheduled.strftime("%H:%M")}
            for s in config.ROUTE
        ],
        "track_window": [config.TRACK_START.strftime("%H:%M"), config.TRACK_END.strftime("%H:%M")],
        "error": last_error,
    }


def history_summary(arrivals: list[tuple[str, int]], stop: config.Stop) -> list[dict]:
    out = []
    for trip_date, arrival_ts in arrivals:
        arrived = datetime.fromtimestamp(arrival_ts / 1000, config.TZ)
        scheduled = _scheduled_on(arrived.date(), stop)
        out.append({
            "date": trip_date,
            "arrived": arrived.isoformat(),
            "minutes_vs_schedule": round((arrived - scheduled).total_seconds() / 60, 1),
        })
    return out
