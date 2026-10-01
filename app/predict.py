"""Arrival detection and ETA prediction from past trips.

For each past morning we know when the bus reached our stop. Given where the bus
is now, find the moment on each past trip when it was at the same spot (heading
the same way); the time from there to our stop on that trip is one sample of
"time remaining". The median of those samples is the prediction.
"""

import statistics
from dataclasses import dataclass

from . import config
from .geo import Point, distance_m, heading_diff

MOVING_M_S = 2.0
HEADING_TOLERANCE = 60
HEADING_PENALTY_M = 200


@dataclass
class PastTrip:
    date: str
    points: list[Point]  # only points up to arrival
    arrival_ts: int


@dataclass
class Prediction:
    eta_ts: int
    low_ts: int
    high_ts: int
    trips_used: int


def find_arrival(points: list[Point], lat: float, lon: float, radius_m: float = config.ARRIVE_RADIUS_M) -> int | None:
    """Timestamp of the first point within radius of the stop."""
    for p in points:
        if distance_m(p.lat, p.lon, lat, lon) <= radius_m:
            return p.ts
    return None


def arrivals_by_stop(points: list[Point], route: list[config.Stop] = config.ROUTE) -> dict[int, int | None]:
    return {s.num: find_arrival(points, s.lat, s.lon) for s in route}


def build_past_trip(date: str, points: list[Point], stop: config.Stop, arrival: int | None = None) -> PastTrip | None:
    if arrival is None:
        arrival = find_arrival(points, stop.lat, stop.lon)
    if arrival is None:
        return None
    before = [p for p in points if p.ts <= arrival]
    return PastTrip(date, before, arrival)


def thin(points: list[Point], min_gap_ms: int = 5000) -> list[Point]:
    """Keep at most one point per min_gap_ms. Plenty for matching, and far less memory."""
    out: list[Point] = []
    for p in points:
        if not out or p.ts - out[-1].ts >= min_gap_ms:
            out.append(p)
    return out


def _moving(p: Point) -> bool:
    return p.speed is not None and p.speed >= MOVING_M_S and p.heading is not None


def match_ts(trip: PastTrip, cur: Point, radius_m: float = config.MATCH_RADIUS_M) -> int | None:
    """When was the bus on this past trip at the current position, going the same way?"""
    best_score, best_ts = None, None
    for p in trip.points:
        d = distance_m(p.lat, p.lon, cur.lat, cur.lon)
        if d > radius_m:
            continue
        score = d
        # The route can pass the same corner twice; prefer points heading the same way.
        if _moving(cur) and _moving(p) and heading_diff(cur.heading, p.heading) > HEADING_TOLERANCE:
            score += HEADING_PENALTY_M
        if best_score is None or score < best_score:
            best_score, best_ts = score, p.ts
    return best_ts


def predict(cur: Point, history: list[PastTrip], min_trips: int = config.MIN_HISTORY_TRIPS) -> Prediction | None:
    remaining = []
    for trip in history:
        ts = match_ts(trip, cur)
        if ts is not None:
            remaining.append(trip.arrival_ts - ts)
    if len(remaining) < min_trips:
        return None
    remaining.sort()
    if len(remaining) >= 4:
        low, _, high = statistics.quantiles(remaining, n=4)
    else:
        low, high = remaining[0], remaining[-1]
    return Prediction(
        eta_ts=cur.ts + int(statistics.median(remaining)),
        low_ts=cur.ts + int(low),
        high_ts=cur.ts + int(high),
        trips_used=len(remaining),
    )


def last_stop_passed(points: list[Point], route: list[config.Stop] = config.ROUTE) -> tuple[config.Stop, int] | None:
    """The furthest scheduled stop the bus has reached today, and when."""
    for stop in reversed(route):
        ts = find_arrival(points, stop.lat, stop.lon)
        if ts is not None:
            return stop, ts
    return None
