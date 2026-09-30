"""Settings for the bus tracker. Anything that might need tweaking is an env var."""

import os
from dataclasses import dataclass
from datetime import time
from pathlib import Path
from zoneinfo import ZoneInfo


def _env_time(name: str, default: str) -> time:
    hh, mm = os.environ.get(name, default).split(":")
    return time(int(hh), int(mm))


@dataclass(frozen=True)
class Stop:
    num: int
    scheduled: time
    name: str
    lat: float
    lon: float


# Morning route from the district schedule. Coordinates are the street
# intersections from OpenStreetMap.
ROUTE = [
    Stop(1, time(7, 10), "101st St & Fort Hamilton Pkwy", 40.611154, -74.032555),
    Stop(2, time(7, 25), "5th Ave & 44th St", 40.648465, -74.006824),
    Stop(3, time(7, 37), "6th Ave & 20th St", 40.660579, -73.990635),
    Stop(4, time(7, 39), "6th Ave & 16th St", 40.663823, -73.987453),
    Stop(5, time(7, 45), "11th Ave & Prospect Ave", 40.656150, -73.977308),
    Stop(6, time(7, 48), "Greenwood Ave & E 7th St", 40.651788, -73.974885),
    Stop(7, time(7, 53), "8th Ave & 14th St", 40.662744, -73.981728),
    Stop(8, time(7, 55), "8th Ave & 9th St", 40.665749, -73.979224),
    Stop(9, time(7, 58), "5th Ave & 9th St", 40.669173, -73.986304),
]
MY_STOP = ROUTE[-1]

TZ = ZoneInfo(os.environ.get("TZ_NAME", "America/New_York"))

GLYMPSE_TAG = os.environ.get("GLYMPSE_TAG", "bcscarroll6")
GLYMPSE_API = "https://api.glympse.com/v2"
# The public viewer's anonymous credentials, as used by glympse.com/!<tag>.
GLYMPSE_API_KEY = os.environ.get("GLYMPSE_API_KEY", "0SLq661pXHmqdWgI8Yb1")

TRACK_START = _env_time("TRACK_START", "07:30")
TRACK_END = _env_time("TRACK_END", "08:30")
TRACK_WEEKDAYS = {0, 1, 2, 3, 4}  # Mon-Fri
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "30"))
# Ignore the time window (for local testing).
FORCE_TRACKING = os.environ.get("FORCE_TRACKING") == "1"

WALK_MINUTES_MIN = int(os.environ.get("WALK_MINUTES_MIN", "10"))
WALK_MINUTES_MAX = int(os.environ.get("WALK_MINUTES_MAX", "12"))

# The bus counts as "at the stop" inside this radius.
ARRIVE_RADIUS_M = 75
# A past trip's point matches the bus's current position inside this radius.
MATCH_RADIUS_M = 150
# Past trips needed before trusting history over the printed schedule.
MIN_HISTORY_TRIPS = int(os.environ.get("MIN_HISTORY_TRIPS", "3"))
MAX_HISTORY_TRIPS = 30

DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
DB_PATH = DATA_DIR / "bus.sqlite3"

# Optional HTTP basic auth for the whole site.
SITE_USER = os.environ.get("SITE_USER", "family")
SITE_PASSWORD = os.environ.get("SITE_PASSWORD")
