"""ShotIQ API — the only thing the React app talks to.

Two jobs:
  * serve NBA shot data for any player and season
  * proxy the LLM summary call, so the API key never reaches the browser
    and the numbers in a summary are always this server's own

Run locally:
    .venv\\Scripts\\python.exe -m uvicorn main:app --reload --port 8000

Interactive docs: http://localhost:8000/docs
"""

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import analytics
import config
import nba_source
import summary as summary_service

app = FastAPI(
    title="ShotIQ API",
    description=(
        "NBA shot data for the ShotIQ dashboard, plus an LLM scouting note "
        "written only from that data.\n\n"
        "Responses are cached to disk and served from there by default, so "
        "the API works offline and never hammers stats.nba.com."
    ),
    version="0.3.0",
    openapi_tags=[
        {"name": "Shot data", "description": "Per-shot records and tracking splits."},
        {"name": "Lookups", "description": "Offline player and season lists."},
        {
            "name": "AI summary",
            "description": (
                "A short scouting note. The model is given a digest computed "
                "by this server and is instructed to use nothing else, so "
                "every number in a summary traces back to the shot data."
            ),
        },
        {"name": "Service", "description": "Health, and nothing that hits the network."},
    ],
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


@app.get("/api/health", tags=["Service"], summary="Liveness check")
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


@app.get("/api/players", tags=["Lookups"], summary="Search players by name")
def get_players(
    q: str = Query(..., min_length=2, description="Part of a player's name"),
):
    """Search players by name.

    Backed by the offline list bundled with nba_api, so this never touches
    the network and stays fast enough to call on every keystroke.
    """
    return {"query": q, "players": nba_source.search_players(q)}


@app.get("/api/seasons", tags=["Lookups"], summary="Seasons with shot-chart data")
def get_seasons():
    """Seasons with shot-chart data, newest first.

    `hasTracking` marks the seasons that also carry defender-distance and
    shot-clock data, which only exists from 2013-14 onwards.
    """
    return {
        "seasons": nba_source.list_seasons(),
        "default": config.DEFAULT_SEASON,
    }


@app.get("/api/shots", tags=["Shot data"], summary="Every field-goal attempt")
def get_shots(
    playerId: int | None = Query(None, description="Defaults to the featured player"),
    season: str | None = Query(None, description="e.g. 2025-26"),
    refresh: bool = Query(False, description="Bypass the cache and refetch"),
):
    """Every field-goal attempt, one record per shot."""
    return _load_or_503(nba_source.load_shots, playerId, season, refresh)


@app.get("/api/splits", tags=["Shot data"], summary="Tracking splits")
def get_splits(
    playerId: int | None = Query(None, description="Defaults to the featured player"),
    season: str | None = Query(None, description="e.g. 2025-26"),
    refresh: bool = Query(False, description="Bypass the cache and refetch"),
):
    """Tracking splits: defender distance, shot clock, dribbles, touch time.

    Seasons before 2013-14 predate player tracking and return empty splits.
    """
    return _load_or_503(nba_source.load_splits, playerId, season, refresh)


class SummaryMeta(BaseModel):
    """Provenance. Every field here answers 'where did this text come from?'

    Optional almost throughout, on purpose: a summary cached by an earlier
    version of this code must still deserialise rather than 500. A response
    model that rejects its own older files is a trap, not a contract.
    """

    # 'model' collides with Pydantic's protected model_ namespace, and the
    # field is named for the LLM, not for Pydantic.
    model_config = {"protected_namespaces": ()}

    source: str = Field(description="'cache' or 'live'")
    model: str | None = Field(None, description="The LLM that wrote it")
    generatedAt: str | None = None
    digest: str | None = Field(
        None, description="Fingerprint of the numbers this described"
    )
    stale: bool | None = Field(
        None,
        description=(
            "Present and true when the shot data has changed since this "
            "summary was written. The text is kept, not discarded."
        ),
    )
    playerId: int | None = None
    player: str | None = None
    season: str | None = None


class SummaryResponse(BaseModel):
    """What the panel renders.

    Declared so /docs shows the shape rather than an empty schema, and so
    the endpoint cannot quietly start returning something else.
    """

    headline: str = Field(description="One sentence, at most 18 words")
    strengths: list[str] = Field(description="Two or three, each with numbers")
    watch: list[str] = Field(description="One or two genuine concerns")
    context: str = Field(description="Two or three sentences on shot diet")
    meta: SummaryMeta


class SummaryRequest(BaseModel):
    """The entire body the client is allowed to send.

    Two optional identifiers, and nothing else. The client cannot post
    aggregates, prose, or instructions: everything the model sees is
    re-derived here from this server's own cached data. Accepting
    client-computed numbers would let anyone put arbitrary text into an
    LLM prompt paid for by this project's key.

    Pydantic rejects unknown fields rather than ignoring them, so an
    attempt to smuggle one in fails loudly with a 422.
    """

    model_config = {"extra": "forbid"}

    playerId: int | None = Field(None, description="Defaults to the featured player")
    season: str | None = Field(None, description="e.g. 2025-26")


@app.post(
    "/api/summary",
    response_model=SummaryResponse,
    tags=["AI summary"],
    summary="Generate or fetch an AI scouting note",
    # FastAPI documents 200 and its own 422 automatically. The rest are
    # ours, and an undocumented error code is one a client author only
    # discovers in production.
    responses={
        400: {"description": "Malformed season string"},
        422: {
            "description": (
                "The body carried an unknown field, or the season has no "
                "recorded attempts to summarise"
            )
        },
        502: {"description": "The model answered, but not with a usable summary"},
        503: {
            "description": (
                "Nothing is cached and this deployment may not spend quota "
                "(SHOTIQ_SUMMARY_LIVE is not 'true')"
            )
        },
    },
)
def post_summary(
    body: SummaryRequest | None = None,
    refresh: bool = Query(False, description="Regenerate even if one is cached"),
):
    """A short scouting note on this player's shooting, written by an LLM.

    POST rather than GET because it is not a read: on a cache miss it
    spends money and writes a file. GET would also invite proxies and
    browsers to cache it, and to prefetch it on hover -- which is exactly
    the request you do not want fired speculatively.

    The response is the four fields the panel renders, plus provenance:
    which model wrote it, when, whether it came from cache, and a
    fingerprint of the numbers it described.
    """
    body = body or SummaryRequest()
    player_id = body.playerId or config.DEFAULT_PLAYER_ID
    season = body.season or config.DEFAULT_SEASON

    try:
        shots = nba_source.load_shots(player_id, season)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not load shot data and no cache is available: {exc}",
        ) from exc

    # Tracking splits enrich the digest but are not required by it, and they
    # do not exist at all before 2013-14. A failure here must not cost the
    # user a summary they could still have had.
    splits = None
    if shots.get("meta", {}).get("hasTracking"):
        try:
            splits = nba_source.load_splits(player_id, season)
        except Exception:
            splits = None

    digest = analytics.build_digest(shots, splits)

    try:
        result = summary_service.load_summary(
            player_id, season, digest, refresh=refresh
        )
    except summary_service.NothingToSummarise as exc:
        # The request and the service are both fine; the season is empty.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except summary_service.GenerationDisabled as exc:
        # Nothing cached, and this deployment may not spend quota.
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except summary_service.SummaryUnavailable as exc:
        # The model answered, but not with a usable summary.
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    result["meta"].update(
        {
            "playerId": player_id,
            "player": shots.get("meta", {}).get("player"),
            "season": season,
        }
    )
    return result
