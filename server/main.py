"""ShotIQ API — the only thing the React app talks to.

Two jobs:
  * serve NBA shot data for any player and season
  * later, at step 6, proxy the LLM summary call so the API key never
    reaches the browser

Run locally:
    .venv\\Scripts\\python.exe -m uvicorn main:app --reload --port 8000

Interactive docs: http://localhost:8000/docs
"""

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

import config
import nba_source

app = FastAPI(
    title="ShotIQ API",
    description="NBA shot data for the ShotIQ dashboard.",
    version="0.2.0",
)

# In development the React app runs on :5173 and this API on :8000.
# Vite proxies /api so requests are same-origin, but allowing the dev
# origin explicitly means hitting the API straight from the browser works too.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def _load_or_503(loader, player_id, season, refresh):
    """Run a loader, turning its failures into clean HTTP responses."""
    try:
        return loader(player_id=player_id, season=season, refresh=refresh)
    except ValueError as exc:
        # A bad season string is the caller's mistake, not a server fault.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not load data and no cache is available: {exc}",
        ) from exc


@app.get("/api/health")
def health():
    """Cheap liveness check that never touches stats.nba.com."""
    return {
        "status": "ok",
        "defaults": {
            "playerId": config.DEFAULT_PLAYER_ID,
            "season": config.DEFAULT_SEASON,
            "seasonType": config.SEASON_TYPE,
        },
    }


@app.get("/api/players")
def get_players(
    q: str = Query(..., min_length=2, description="Part of a player's name"),
):
    """Search players by name.

    Backed by the offline list bundled with nba_api, so this never touches
    the network and stays fast enough to call on every keystroke.
    """
    return {"query": q, "players": nba_source.search_players(q)}


@app.get("/api/seasons")
def get_seasons():
    """Seasons with shot-chart data, newest first.

    `hasTracking` marks the seasons that also carry defender-distance and
    shot-clock data, which only exists from 2013-14 onwards.
    """
    return {
        "seasons": nba_source.list_seasons(),
        "default": config.DEFAULT_SEASON,
    }


@app.get("/api/shots")
def get_shots(
    playerId: int | None = Query(None, description="Defaults to the featured player"),
    season: str | None = Query(None, description="e.g. 2025-26"),
    refresh: bool = Query(False, description="Bypass the cache and refetch"),
):
    """Every field-goal attempt, one record per shot."""
    return _load_or_503(nba_source.load_shots, playerId, season, refresh)


@app.get("/api/splits")
def get_splits(
    playerId: int | None = Query(None, description="Defaults to the featured player"),
    season: str | None = Query(None, description="e.g. 2025-26"),
    refresh: bool = Query(False, description="Bypass the cache and refetch"),
):
    """Tracking splits: defender distance, shot clock, dribbles, touch time.

    Seasons before 2013-14 predate player tracking and return empty splits.
    """
    return _load_or_503(nba_source.load_splits, playerId, season, refresh)
