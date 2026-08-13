# ShotIQ

An interactive dashboard for exploring NBA shot data — shot distance, angle, defender pressure and shot-clock context.

Opens on **Shai Gilgeous-Alexander, 2025-26** — the reigning MVP — and any player from 1996-97 onwards can be loaded from the UI.

## Features

- **Player and season selection** — search any player in NBA history by name and pick any season back to 1996-97, when shot coordinates were first recorded league-wide. Seasons before 2013-14 predate player tracking, which the season picker labels rather than failing on.
- **Shot table** — every field-goal attempt with date, opponent, quarter, game clock, action type, court zone, distance, release angle and result. Built on a reusable, data-agnostic `DataTable` component driven by a column configuration.
- **Search and sort** — case-insensitive search across date, opponent, action and zone. Click any column header to cycle ascending → descending → back to game order. Missing values always sort last, in either direction.

## Requirements

- Node.js 20 or newer
- Python 3.10 or newer

## Run locally

The app has two parts: a React frontend and a Python API that fetches the NBA data. Run both.

### 1. API — first terminal

```
cd server
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

On macOS or Linux the venv binary is `.venv/bin/python` instead.

Interactive API docs are at http://localhost:8000/docs.

### 2. Frontend — second terminal

```
npm install
npm run dev
```

Vite prints a local URL (http://localhost:5173 by default) and proxies `/api` through to the Python service.

## Project structure

```
src/
  components/   presentational React components
  hooks/        reusable stateful logic (useFetchData)
  services/     the only place that calls fetch
server/         FastAPI service + cached NBA data
```

Components never call `fetch` directly. They call a service function, or a hook that wraps one, so request handling stays in one place and components can be tested without a network.

## Data

Shot data comes from `stats.nba.com` via the [`nba_api`](https://github.com/swar/nba_api) package.

| Endpoint | Contents |
| --- | --- |
| `GET /api/shots?playerId=&season=` | One record per field-goal attempt — distance, angle, court coordinates, period and clock, zone, make/miss. Also returns league-average FG% by zone as a comparison baseline. |
| `GET /api/splits?playerId=&season=` | Tracking splits — defender distance, shot clock, dribbles, touch time and shot category, each with FG% and eFG%. Empty for seasons before 2013-14. |
| `GET /api/players?q=` | Player name search. Backed by the offline list bundled with `nba_api`, so it never touches the network. |
| `GET /api/seasons` | Selectable seasons, newest first, each flagged for whether player-tracking data exists. |
| `GET /api/health` | Liveness check. Does not call the NBA API. |

Both data endpoints fall back to the configured default when `playerId` or `season` is omitted, so the client never has to hard-code who the featured player is.

Queries use `team_id=0`, meaning "this player on whichever team" — pinning a team id would silently drop half the shots of anyone traded mid-season.

Responses are cached to `server/cache/`, keyed by player and season. A completed season is immutable, so the cache is served indefinitely — add `?refresh=true` to force a refetch. Only the default subject's cache is committed to the repository: `stats.nba.com` is undocumented, rate-limits aggressively, and blocks many datacenter IP ranges, so that one file doubles as a fallback keeping the dashboard working when the upstream is unavailable. Other players are fetched live on demand and cached locally.

To change which player and season the app opens on, set the `SHOTIQ_PLAYER_ID` and `SHOTIQ_SEASON` environment variables — see `server/config.py`.

## Acknowledgements

Built as a pair-programming exercise with Claude (Anthropic). The reasoning behind each architectural decision is recorded in the commit history.
