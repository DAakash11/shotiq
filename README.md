# ShotIQ

An interactive dashboard for exploring NBA shot data — shot distance, angle, defender pressure and shot-clock context.

Opens on **Shai Gilgeous-Alexander, 2025-26** — the reigning MVP — and any player from 1996-97 onwards can be loaded from the UI.

## Features

- **Player and season selection** — search any player in NBA history by name and pick any season back to 1996-97, when shot coordinates were first recorded league-wide. Seasons before 2013-14 predate player tracking, which the season picker labels rather than failing on.
- **Shot table** — every field-goal attempt with date, opponent, quarter, game clock, action type, court zone, distance, release angle and result. Built on a reusable, data-agnostic `DataTable` component driven by a column configuration.
- **Search and sort** — case-insensitive search across date, opponent, action and zone. Click any column header to cycle ascending → descending → back to game order. Missing values always sort last, in either direction.
- **Shooting by distance** — made and missed **attempts** stacked per distance band, so the bar's length carries shot selection while the colour boundary carries accuracy. A tick on each bar marks where that boundary would fall if the player shot league average on the same attempts, making the gap an edge counted in shots rather than in percentage points.
- **Tracking charts** — field-goal percentage by closest defender and by shot clock, each against the player's own season average. Seasons before 2013-14 predate tracking and say so instead of rendering empty axes.

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

## Tests

```
npm test
```

```
cd server
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.venv\Scripts\python.exe -m pytest
```

| Suite | Covers |
| --- | --- |
| `src/utils/sorting.test.js` | The sort comparator — missing values last in *both* directions, the input array never mutated, natural ordering so `Q2` precedes `Q10`. |
| `src/utils/aggregate.test.js` | Chart aggregation — league rates weighted by attempts rather than averaged, rates left `null` at zero attempts, thin samples flagged. |
| `src/services/nbaApi.test.js` | Query-string construction and the `response.ok` check, since `fetch` resolves rather than rejects on 4xx and 5xx. |
| `src/components/DistanceChart.test.jsx` | The league-tick arithmetic either side of the colour boundary, plus a guard that Recharts still hands the row to a custom shape. |
| `src/components/charts.render.test.jsx` | Both charts mounted in a DOM — values printed, ticks drawn, empty seasons rendering nothing. |
| `server/tests/test_nba_source.py` | Season parsing and validation, shot-angle derivation, team-abbreviation lookup, player-search ranking. |
| `server/tests/test_api.py` | Real HTTP requests through FastAPI's `TestClient`. |

The API tests run **entirely offline**: the default subject's responses are committed to `server/cache/`, so the data endpoints resolve from disk and the results are deterministic. One test asserts `meta.source == "cache"` specifically so the suite fails if it ever starts silently reaching out to `stats.nba.com`.

## Project structure

```
src/
  components/   presentational React components
  hooks/        reusable stateful logic (useFetchData)
  services/     the only place that calls fetch
  utils/        pure data logic — sorting, chart aggregation
server/         FastAPI service + cached NBA data
```

Components never call `fetch` directly. They call a service function, or a hook that wraps one, so request handling stays in one place and components can be tested without a network.

The same split applies to data shaping: everything the charts need is computed by pure functions in `utils/`, so the reshaping can be unit-tested without mounting a component and the chart components only ever draw.

One aggregation is worth calling out, because getting it wrong is silent. League field-goal percentage per band is re-derived as `sum(made) / sum(attempts)`, never as the mean of the per-row percentages the API returns. Those rows are split by court area, so a band pairs a 9-attempt backcourt row with a 26,514-attempt one; weighting them equally moves *Above the Break 3* from a true .350 to a reported .429. A test pins the correct figure.

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
