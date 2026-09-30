import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Point:
    ts: int  # epoch milliseconds
    lat: float
    lon: float
    speed: float | None = None  # m/s
    heading: float | None = None  # degrees clockwise from north


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Equirectangular approximation, accurate to well under a metre at city scale."""
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = math.radians(lat2 - lat1)
    return 6_371_000 * math.hypot(x, y)


def heading_diff(a: float, b: float) -> float:
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d
