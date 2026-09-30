import sqlite3
from pathlib import Path

from .geo import Point

SCHEMA = """
CREATE TABLE IF NOT EXISTS points (
    trip_date TEXT NOT NULL,     -- local date, YYYY-MM-DD
    ts INTEGER NOT NULL,         -- epoch ms
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    speed REAL,
    heading REAL,
    PRIMARY KEY (trip_date, ts)
) WITHOUT ROWID;
"""


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)

    def add_points(self, trip_date: str, points: list[Point]) -> int:
        cur = self.conn.executemany(
            "INSERT OR IGNORE INTO points VALUES (?, ?, ?, ?, ?, ?)",
            [(trip_date, p.ts, p.lat, p.lon, p.speed, p.heading) for p in points],
        )
        self.conn.commit()
        return cur.rowcount

    def trip_points(self, trip_date: str) -> list[Point]:
        rows = self.conn.execute(
            "SELECT ts, lat, lon, speed, heading FROM points WHERE trip_date = ? ORDER BY ts",
            (trip_date,),
        )
        return [Point(*r) for r in rows]

    def trip_dates(self, before: str | None = None, limit: int = 100) -> list[str]:
        """Most recent first."""
        rows = self.conn.execute(
            "SELECT DISTINCT trip_date FROM points WHERE trip_date < ? ORDER BY trip_date DESC LIMIT ?",
            (before or "9999-12-31", limit),
        )
        return [r[0] for r in rows]
