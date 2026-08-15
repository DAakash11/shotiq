# ShotIQ

An interactive dashboard for exploring NBA shot data — distance, angle, defender pressure and shot-clock context — with an AI scouting note written only from the numbers on the page.

Opens on **Shai Gilgeous-Alexander, 2025-26**. Any player from 1996-97 onwards can be loaded from the UI.

## Features

- **Player and season selection** — search any player in NBA history, back to 1996-97 when shot coordinates were first recorded league-wide. Seasons before 2013-14 predate player tracking, which the picker labels rather than failing on.
- **Shot table** — every field-goal attempt with date, opponent, quarter, clock, action type, zone, distance, release angle and result. Built on a data-agnostic `DataTable` driven by a column configuration.
- **Search and sort** — case-insensitive search across date, opponent, action and zone. Headers cycle ascending → descending → back to game order. Missing values sort last in *both* directions.
- **Shooting by distance** — made and missed **attempts** stacked per band, so bar length carries shot selection while the colour boundary carries accuracy. A tick marks where that boundary would fall at league average on the same attempts, making the gap an edge counted in shots rather than percentage points.
- **Tracking charts** — FG% by closest defender and by shot clock, against the player's own season average.
- **AI scouting note** — a headline, two or three strengths, concerns, and the shot diet framing them. The model is handed a digest computed by the server and told to use nothing else, so every figure traces back to the shot data.

## Run with Docker

One command, no Node and no Python on the host:

```
docker compose up --build
```

Then open **http://localhost:8080**.

Five seasons ship complete — shot data, tracking splits and the generated note — so a fresh clone gets the whole app, AI panel included, with **no API key and no network**:

| Player | Season | |
| --- | --- | --- |
| Shai Gilgeous-Alexander | 2025-26 | back-to-back MVP, the default subject |
| Nikola Jokić | 2021-22 | second straight MVP |
| Stephen Curry | 2016-17 | 768 attempts from 24+ feet |
| LeBron James | 2015-16 | the Cleveland title season |
| Luka Dončić | 2023-24 | scoring title |

Any other player still works, but needs a live fetch from `stats.nba.com`, and a summary for one needs an API key.

**`web`** is nginx serving the built React app on 8080. **`api`** is FastAPI on uvicorn, deliberately *not* published — reachable only from `web` over the compose network. The browser calls `/api/...` with no host in the path, exactly as it does behind Vite's proxy in development, so nothing in the bundle knows where the API lives and no build-time variable has to be set per deployment.

Details that are load-bearing rather than decorative:

- **The frontend image is multi-stage.** Building needs Node, npm and ~110 MB of packages; serving needs a web server and a directory of files. The build stage is discarded, so the shipped image is 93 MB of nginx and static assets — no Node, no source, no `node_modules`.
- **The API image is Debian-based, not Alpine.** `nba_api` depends on pandas and numpy, compiled C extensions. Alpine's musl libc cannot use prebuilt manylinux wheels, so pip would build both from source — a toolchain and many minutes to reach what Debian installs in seconds.
- **nginx's proxy timeout is raised to 120s.** It defaults to 60s while the API allows itself 90s to reach `stats.nba.com`, so a slow first fetch would be cut off as a 504 while the API waited quite happily.
- **`web` waits for `api` to report *healthy***, not merely to exist, so no request arrives while uvicorn is still importing pandas.
- **`.env` never enters an image.** It is excluded from the build context and passed at runtime. Anything copied into a layer stays there permanently — deleting it in a later step hides it from the final filesystem without removing it from the image.

## Run locally

Two parts: a React frontend and a Python API. Run both.

**API — first terminal**

```
cd server
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

On macOS or Linux the venv binary is `.venv/bin/python`. Interactive API docs at http://localhost:8000/docs.

**Frontend — second terminal**

```
npm install
npm run dev
```

Vite prints a local URL (http://localhost:5173) and proxies `/api` to the Python service.

**Optional — generating new AI summaries.** The five seasons above are committed, so the feature works with no setup. A key is only needed to generate a note for a *different* player or season:

```
cd server
copy .env.example .env
```

Put a free [Google AI Studio](https://aistudio.google.com/apikey) key in `GEMINI_API_KEY`, then set `SHOTIQ_SUMMARY_LIVE=true` in the same file.

That flag defaults to **false**, and only the exact word `true` enables it. A deployment setting nothing at all therefore serves only cached summaries and cannot spend quota. The key is read by the Python service alone — it never reaches the browser, and must never be named with a `VITE_` prefix, because Vite inlines those into the client bundle at build time.

## How it's built

```
src/
  components/   presentational React components
  hooks/        reusable stateful logic (useFetchData)
  services/     the only place that calls fetch
  utils/        pure data logic — sorting, chart aggregation
server/         FastAPI service + cached NBA data
```

Components never call `fetch` directly; they call a service function, or a hook wrapping one, so request handling stays in one place and components are testable without a network. The same split applies to data shaping: everything the charts need is computed by pure functions in `utils/`, so it can be unit-tested without a DOM and the chart components only ever draw.

**One aggregation is worth calling out, because getting it wrong is silent.** League FG% per band is re-derived as `sum(made) / sum(attempts)`, never as the mean of the per-row percentages the API returns. Those rows are split by court area, so a band pairs a 9-attempt backcourt row with a 26,514-attempt one; weighting them equally moves *Above the Break 3* from a true .350 to a reported .429. A test pins the correct figure.

### The AI summary

That aggregation exists twice — `src/utils/aggregate.js` for the charts, `server/analytics.py` for the prompt — and the duplication is deliberate. The client already has the numbers, but the summary endpoint must not accept them: anything a client posts is attacker-controlled, and accepting aggregates would let anyone put arbitrary text into an LLM prompt paid for by this project's key. The request body is two optional identifiers with `extra="forbid"`, so a smuggled field is rejected rather than ignored, and every number the model sees is re-derived server-side.

The price is two implementations that could drift apart silently, so both suites pin the same three figures off the same committed cache file — `.573 / .446 / +12.7` for the 8-16 ft band. A change to either that moves those numbers turns one suite red and names the side that moved.

The model is given the digest and told to use nothing else: no outside knowledge, no web search, and no bucket flagged as a thin sample. That last rule matters more than it sounds — the raw data contains a shot-type bucket with a single made attempt, which a model left to itself will happily report as 100% shooting.

`POST /api/summary` is a POST rather than a GET because on a cache miss it spends money and writes a file, and because a GET invites browsers to prefetch it on hover. Cached notes carry a fingerprint of the numbers they describe; if the underlying data changes, the note is flagged stale rather than silently regenerated.

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
| `src/utils/sorting.test.js` | The comparator — missing values last in *both* directions, input never mutated, `Q2` before `Q10`. |
| `src/utils/aggregate.test.js` | Chart aggregation — league rates weighted not averaged, `null` at zero attempts, thin samples flagged, unlabelled buckets dropped. |
| `src/services/nbaApi.test.js` | Query-string construction and the `response.ok` check, since `fetch` resolves rather than rejects on 4xx and 5xx. |
| `src/components/DistanceChart.test.jsx` | League-tick arithmetic either side of the colour boundary. |
| `src/components/charts.render.test.jsx` | Both charts mounted in a DOM — values printed, ticks drawn, empty seasons rendering nothing. |
| `src/components/AiSummary.test.jsx` | That the panel requests nothing until asked, posts identifiers only, and tells a disabled deployment apart from a real failure. |
| `server/tests/test_nba_source.py` | Season parsing, shot-angle derivation, team-abbreviation lookup, player-search ranking. |
| `server/tests/test_analytics.py` | The server-side digest, including the figures pinned against the JS twin. |
| `server/tests/test_summary.py` | Prompt construction, response parsing, the cache gate, vendor failures becoming our own error type. |
| `server/tests/test_api.py` | Real HTTP requests through FastAPI's `TestClient`. |

**The suite runs entirely offline, and that is enforced rather than trusted.** Cached responses are committed, so data endpoints resolve from disk; one test asserts `meta.source == "cache"` so the suite fails if it starts reaching the network. Because that guard only covers the paths it exercises — and one test slipped past it — the fetchers themselves now raise under a fixture.

Nothing calls the LLM either. Every test injects a stub client, a fixture makes *constructing* a real one raise, and another pins the live-generation flag off regardless of what sits in the developer's `.env`.

## Data

Shot data comes from `stats.nba.com` via [`nba_api`](https://github.com/swar/nba_api).

| Endpoint | Contents |
| --- | --- |
| `GET /api/shots?playerId=&season=` | One record per attempt — distance, angle, coordinates, period and clock, zone, make/miss. Plus league-average FG% by zone as a baseline. |
| `GET /api/splits?playerId=&season=` | Tracking splits — defender distance, shot clock, dribbles, touch time, shot category, each with FG% and eFG%. Empty before 2013-14. |
| `GET /api/players?q=` | Name search, backed by the offline list bundled with `nba_api`, so it never touches the network. |
| `GET /api/seasons` | Selectable seasons, newest first, each flagged for whether tracking data exists. |
| `POST /api/summary` | The AI scouting note for a player and season. |
| `GET /api/health` | Liveness check. Does not call the NBA API. |

Both data endpoints fall back to the configured default when `playerId` or `season` is omitted, so the client never hard-codes who the featured player is.

Queries use `team_id=0` — "this player on whichever team" — because pinning a team id silently drops half the shots of anyone traded mid-season.

Responses are cached to `server/cache/`, keyed by player and season. A completed season is immutable, so the cache is served indefinitely; add `?refresh=true` to force a refetch. The five featured seasons are committed: `stats.nba.com` is undocumented, rate-limits aggressively, and blocks many datacenter IP ranges, so those files double as a fallback keeping the dashboard working when the upstream is not. Other players are fetched live and cached locally.

To change which player and season the app opens on, set `SHOTIQ_PLAYER_ID` and `SHOTIQ_SEASON` — see `server/config.py`.

## Acknowledgements

Built as a pair-programming exercise with Claude (Anthropic). The reasoning behind each architectural decision is recorded in the commit history.
