# School bus tracker

Follows the morning school bus (Glympse tag `bcscarroll6`), records its trail
every school day, and predicts when it will reach any stop on the route. Each
viewer picks their stop and walk time; the page shows the ETA, when to leave,
a live map, and the distribution of past arrival times at that stop.

## Multiple families

Settings (stop + walk minutes) live in each browser's `localStorage`; the
server stores nothing per user. The first visit opens the settings dialog.
To set up someone else's device, use **Settings → Copy setup link**, which
produces a link like `/?stop=7&walk=5`. Opening it saves those settings and
skips the dialog. If `SITE_PASSWORD` is set, they'll also need the password.

## How it works

- **Recorder** (`app/tracker.py`): Mon–Fri, 6:30–8:30 America/New_York, polls
  the public Glympse viewer API every 30s and stores each GPS point in SQLite.
  Glympse only keeps the last ~10 minutes after a share ends, so history can
  only be built by recording live.
- **Prediction** (`app/predict.py`): for each past morning that reached the
  viewer's stop, find the moment the bus was where it is now (same direction) and take
  the time it needed from there. The median over past mornings is the ETA; the
  quartiles are the range shown.
- **Fallback**: until there are 3 recorded mornings, or when the bus is
  somewhere past trips never matched, the ETA is the stop's printed time.
- **Leave-by** = ETA − the viewer's walk time, computed in the browser. Green:
  on track. Yellow (5 min before): prepare to leave. Red: leave now, or hurry
  if the bus is closer than the walk.

## Run locally

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest
FORCE_TRACKING=1 .venv/bin/uvicorn app.main:app --reload   # poll now, ignoring the time window
```

Open http://localhost:8000. Data goes to `./data/bus.sqlite3`.

## Deploy on Railway

1. Push this repo to GitHub and create a Railway project from it
   (`railway.json` sets the start command and health check).
2. Add a **Volume** to the service, mounted at `/data`.
3. Set variables:
   - `DATA_DIR=/data` (required, or history is lost on every deploy)
   - `SITE_PASSWORD=...` (recommended; the site shows where your kids get on the bus).
     The username is `family` unless `SITE_USER` is set.
4. Under Settings → Networking, generate a domain.
5. Keep it at **one replica** and leave **Serverless / App Sleeping off**. The
   recorder runs inside the web process and must stay awake.

## Settings (env vars)

| Variable | Default | |
|---|---|---|
| `TRACK_START` / `TRACK_END` | `06:30` / `08:30` | Recording window, local time. Start before the first stop (07:10). |
| `POLL_SECONDS` | `30` | Glympse poll interval |
| `DEFAULT_STOP` | `9` | Stop shown to a viewer who hasn't chosen one |
| `DEFAULT_WALK_MINUTES` | `10` | Pre-filled walk time for new viewers |
| `MIN_HISTORY_TRIPS` | `3` | Mornings needed before trusting history |
| `GLYMPSE_TAG` | `bcscarroll6` | Glympse tag to follow |
| `TZ_NAME` | `America/New_York` | |
| `DATA_DIR` | `./data` | Where the SQLite file lives |
| `SITE_PASSWORD` / `SITE_USER` | unset / `family` | HTTP basic auth |

Route stops and coordinates are in `app/config.py` (`ROUTE`). Our stop is the last one.

## API

- `GET /api/status?stop=N`: everything the page shows for stop N (state, ETA, bus position, trail)
- `GET /api/history?stop=N`: past mornings' arrival times at stop N vs. its schedule

`stop` defaults to `DEFAULT_STOP`; an unknown stop returns 404.
