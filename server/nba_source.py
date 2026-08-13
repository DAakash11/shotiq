"""Talks to stats.nba.com and hands the frontend clean, predictable JSON.

This is the only module that knows stats.nba.com exists. It does three jobs:

1. Calls the two nba_api endpoints we need.
2. Normalises their SHOUTING_SNAKE_CASE columns into camelCase records,
   dropping fields the UI has no use for and deriving shot angle.
3. Caches every successful response to disk, and falls back to that cache
   when the upstream is unavailable.

Why cache so aggressively: stats.nba.com is undocumented, rate-limits hard,
and blocks datacenter IP ranges. It is also *immutable* for a completed
season -- Jokic's 2021-22 shots will never change -- so there is no
correctness cost to caching a past season forever.
"""

import json
import math
from datetime import datetime, timezone
from pathlib import Path

from nba_api.stats.endpoints import playerdashptshots, shotchartdetail
from nba_api.stats.static import teams

import config

CACHE_DIR = Path(__file__).parent / "cache"


# --- helpers ------------------------------------------------------------


def _rows_as_dicts(result_set):
    """Turn nba_api's {headers: [...], rowSet: [[...]]} into dicts."""
    headers = result_set["headers"]
    return [dict(zip(headers, row)) for row in result_set["rowSet"]]


def _find_result_set(payload, name):
    for result_set in payload["resultSets"]:
        if result_set["name"] == name:
            return result_set
    raise KeyError(
        f"stats.nba.com did not return a '{name}' result set. "
        f"Got: {[rs['name'] for rs in payload['resultSets']]}"
    )


def _team_abbreviation(team_id):
    team = teams.find_team_name_by_id(team_id)
    return team["abbreviation"] if team else None


def _shot_angle_degrees(loc_x, loc_y, distance_ft):
    """Angle from straight-on, in degrees. Negative = left of the rim.

    LOC_X/LOC_Y are tenths of a foot with the hoop at the origin, so
    atan2(x, y) measures deviation from a dead-centre shot.
    """
    if distance_ft is None or distance_ft < config.MIN_DISTANCE_FOR_ANGLE_FT:
        return None
    if loc_x is None or loc_y is None:
        return None
    return round(math.degrees(math.atan2(loc_x, loc_y)), 1)


def _iso_date(raw):
    """'20211020' -> '2021-10-20'."""
    if not raw or len(raw) != 8:
        return raw
    return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"


def _meta(source, extra=None):
    meta = {
        "playerId": config.PLAYER_ID,
        "season": config.SEASON,
        "seasonType": config.SEASON_TYPE,
        "source": source,
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    if extra:
        meta.update(extra)
    return meta


# --- cache --------------------------------------------------------------


def _cache_path(name):
    return CACHE_DIR / f"{name}.json"


def _read_cache(name):
    path = _cache_path(name)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _write_cache(name, payload):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _cache_path(name).write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
    )


# --- shot-level data ----------------------------------------------------


def _fetch_shots():
    response = shotchartdetail.ShotChartDetail(
        team_id=config.TEAM_ID,
        player_id=config.PLAYER_ID,
        season_nullable=config.SEASON,
        season_type_all_star=config.SEASON_TYPE,
        context_measure_simple="FGA",
        timeout=config.NBA_TIMEOUT_SECONDS,
    ).get_dict()

    own_abbr = _team_abbreviation(config.TEAM_ID)
    raw_shots = _rows_as_dicts(_find_result_set(response, "Shot_Chart_Detail"))

    shots = []
    for row in raw_shots:
        home, visitor = row.get("HTM"), row.get("VTM")
        is_home = home == own_abbr
        distance = row.get("SHOT_DISTANCE")
        minutes = row.get("MINUTES_REMAINING") or 0
        seconds = row.get("SECONDS_REMAINING") or 0

        shots.append(
            {
                # GAME_ID alone repeats across shots; pairing it with the
                # event id gives every row a genuinely unique React key.
                "id": f"{row['GAME_ID']}-{row['GAME_EVENT_ID']}",
                "gameDate": _iso_date(row.get("GAME_DATE")),
                "opponent": visitor if is_home else home,
                "isHome": is_home,
                "period": row.get("PERIOD"),
                "clock": f"{minutes}:{seconds:02d}",
                "secondsLeftInPeriod": minutes * 60 + seconds,
                "actionType": row.get("ACTION_TYPE"),
                # '2PT Field Goal' -> '2PT'
                "shotType": (row.get("SHOT_TYPE") or "").split(" ")[0],
                "zone": row.get("SHOT_ZONE_BASIC"),
                "zoneArea": row.get("SHOT_ZONE_AREA"),
                "zoneRange": row.get("SHOT_ZONE_RANGE"),
                "distanceFt": distance,
                "angleDeg": _shot_angle_degrees(
                    row.get("LOC_X"), row.get("LOC_Y"), distance
                ),
                "locX": row.get("LOC_X"),
                "locY": row.get("LOC_Y"),
                "made": bool(row.get("SHOT_MADE_FLAG")),
            }
        )

    league_averages = [
        {
            "zone": row.get("SHOT_ZONE_BASIC"),
            "zoneArea": row.get("SHOT_ZONE_AREA"),
            "zoneRange": row.get("SHOT_ZONE_RANGE"),
            "fga": row.get("FGA"),
            "fgm": row.get("FGM"),
            "fgPct": row.get("FG_PCT"),
        }
        for row in _rows_as_dicts(_find_result_set(response, "LeagueAverages"))
    ]

    made = sum(1 for shot in shots if shot["made"])
    player_name = raw_shots[0]["PLAYER_NAME"] if raw_shots else None
    team_name = raw_shots[0]["TEAM_NAME"] if raw_shots else None

    return {
        "meta": _meta(
            "live",
            {
                "player": player_name,
                "team": team_name,
                "attempts": len(shots),
                "made": made,
                "fgPct": round(made / len(shots), 3) if shots else None,
            },
        ),
        "shots": shots,
        "leagueAverages": league_averages,
    }


# --- tracking splits ----------------------------------------------------

# stats.nba.com names the bucket column differently in every result set,
# so map each one we want to its label column and a friendly key.
SPLIT_SETS = {
    "shotClock": ("ShotClockShooting", "SHOT_CLOCK_RANGE"),
    "defenderDistance": ("ClosestDefenderShooting", "CLOSE_DEF_DIST_RANGE"),
    "dribbles": ("DribbleShooting", "DRIBBLE_RANGE"),
    "touchTime": ("TouchTimeShooting", "TOUCH_TIME_RANGE"),
    "general": ("GeneralShooting", "SHOT_TYPE"),
}


def _normalise_split_row(row, label_column):
    return {
        "label": row.get(label_column),
        "sortOrder": row.get("SORT_ORDER"),
        "games": row.get("G"),
        "frequency": row.get("FGA_FREQUENCY"),
        "fgm": row.get("FGM"),
        "fga": row.get("FGA"),
        # These percentages are None wherever the player took no such shot
        # (e.g. no threes with a defender inside two feet). The UI must
        # treat them as missing rather than zero.
        "fgPct": row.get("FG_PCT"),
        "efgPct": row.get("EFG_PCT"),
        "fg2m": row.get("FG2M"),
        "fg2a": row.get("FG2A"),
        "fg2Pct": row.get("FG2_PCT"),
        "fg3m": row.get("FG3M"),
        "fg3a": row.get("FG3A"),
        "fg3Pct": row.get("FG3_PCT"),
    }


def _fetch_splits():
    response = playerdashptshots.PlayerDashPtShots(
        player_id=config.PLAYER_ID,
        team_id=config.TEAM_ID,
        season=config.SEASON,
        season_type_all_star=config.SEASON_TYPE,
        timeout=config.NBA_TIMEOUT_SECONDS,
    ).get_dict()

    overall_rows = _rows_as_dicts(_find_result_set(response, "Overall"))
    overall = _normalise_split_row(overall_rows[0], "SHOT_TYPE") if overall_rows else None

    splits = {}
    for key, (result_set_name, label_column) in SPLIT_SETS.items():
        rows = _rows_as_dicts(_find_result_set(response, result_set_name))
        normalised = [_normalise_split_row(row, label_column) for row in rows]
        # SORT_ORDER encodes the meaningful sequence (e.g. shot clock
        # 24-22 before 4-0). Alphabetical would scramble the chart.
        normalised.sort(key=lambda item: item["sortOrder"] or 0)
        splits[key] = normalised

    player_name = overall_rows[0]["PLAYER_NAME_LAST_FIRST"] if overall_rows else None

    return {
        "meta": _meta("live", {"player": player_name, "games": overall["games"] if overall else None}),
        "overall": overall,
        "splits": splits,
    }


# --- public API ---------------------------------------------------------


def _load(name, fetcher, refresh=False):
    """Serve from cache unless asked to refresh; fall back to cache on failure."""
    if not refresh:
        cached = _read_cache(name)
        if cached is not None:
            cached["meta"]["source"] = "cache"
            return cached

    try:
        payload = fetcher()
    except Exception as exc:
        cached = _read_cache(name)
        if cached is not None:
            cached["meta"]["source"] = "cache"
            cached["meta"]["warning"] = f"Live fetch failed, served cache: {exc}"
            return cached
        raise

    _write_cache(name, payload)
    return payload


def load_shots(refresh=False):
    return _load("shots", _fetch_shots, refresh)


def load_splits(refresh=False):
    return _load("splits", _fetch_splits, refresh)
