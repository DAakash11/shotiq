"""ShotIQ API — the only thing the React app talks to.

Two jobs:
  * serve NBA shot data (this file, plus nba_source.py)
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
    version="0.1.0",
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


@app.get("/api/health")
def health():
    """Cheap liveness check that never touches stats.nba.com."""
    return {
        "status": "ok",
        "subject": {
            "playerId": config.PLAYER_ID,
            "season": config.SEASON,
            "seasonType": config.SEASON_TYPE,
        },
    }


@app.get("/api/shots")
def get_shots(refresh: bool = Query(False, description="Bypass the cache and refetch")):
    """Every field-goal attempt, one record per shot."""
    try:
        return nba_source.load_shots(refresh=refresh)
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not load shot data and no cache is available: {exc}",
        ) from exc


@app.get("/api/splits")
def get_splits(refresh: bool = Query(False, description="Bypass the cache and refetch")):
    """Tracking splits: defender distance, shot clock, dribbles, touch time."""
    try:
        return nba_source.load_splits(refresh=refresh)
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not load split data and no cache is available: {exc}",
        ) from exc
