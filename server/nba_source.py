"""Talks to stats.nba.com and hands the frontend clean, predictable JSON.

This is the only module that knows stats.nba.com exists. It does four jobs:

1. Calls the two nba_api endpoints we need, for any player and season.
2. Normalises their SHOUTING_SNAKE_CASE columns into camelCase records,
   dropping fields the UI has no use for and deriving shot angle.
3. Caches every successful response to disk, keyed by player and season,
   and falls back to that cache when the upstream is unavailable.
4. Searches the offline player list that ships with nba_api.

Why cache so aggressively: stats.nba.com is undocumented, rate-limits
hard, and blocks datacenter IP ranges. Completed seasons are also
immutable -- a 2021-22 shot chart will never change -- so there is no
correctness cost to caching a past season indefinitely.
"""

import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path

from nba_api.stats.endpoints import playerdashptshots, shotchartdetail
from nba_api.stats.static import players, teams

import config

CACHE_DIR = Path(__file__).parent / "cache"

SEASON_PATTERN = re.compile(r"^(\d{4})-(\d{2})$")

# team_id=0 means "this player, whichever team he was on". Pinning a real
# team id would silently drop half the shots of anyone traded mid-season.
ANY_TEAM = 0


# --- validation ---------------------------------------------------------


def parse_season(season):
    """Validate a '2025-26' style season and return its start year."""
    match = SEASON_PATTERN.match(season or "")
    if not match:
        raise ValueError(f"Season must look like '2025-26', got {season!r}")

    start_year = int(match.group(1))
    if start_year < config.FIRST_SHOT_CHART_YEAR:
        raise ValueError(
            f"Shot coordinates only exist from "
            f"{config.season_label(config.FIRST_SHOT_CHART_YEAR)} onwards"
        )
    if start_year > config.latest_season_start_year():
        raise ValueError(f"Season {season} has not started yet")

    return start_year


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


def _player_name(player_id):
    player = players.find_player_by_id(player_id)
    return player["full_name"] if player else None


_TEAM_ABBREVIATIONS = {}


def _team_abbreviation(team_id):
    """'OKC' for team id 1610612760. Looked up once, then memoised.

    Deriving this from TEAM_NAME by string matching does not work -- 'OKC'
    is not a substring of 'Oklahoma City Thunder'.
    """
    if team_id not in _TEAM_ABBREVIATIONS:
        team = teams.find_team_name_by_id(team_id)
        _TEAM_ABBREVIATIONS[team_id] = team["abbreviation"] if team else None
    return _TEAM_ABBREVIATIONS[team_id]


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


def _meta(player_id, season, source, extra=None):
    meta = {
        "playerId": player_id,
        "player": _player_name(player_id),
        "season": season,
        "seasonType": config.SEASON_TYPE,
        "hasTracking": parse_season(season) >= config.FIRST_TRACKING_YEAR,
        "source": source,
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    if extra:
        meta.update(extra)
    return meta


# --- cache --------------------------------------------------------------


def _cache_path(kind, player_id, season):
    return CACHE_DIR / f"{kind}-{player_id}-{season}.json"


def _read_cache(kind, player_id, season):
    path = _cache_path(kind, player_id, season)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _write_cache(kind, player_id, season, payload):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _cache_path(kind, player_id, season).write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
    )


# --- player search ------------------------------------------------------


def search_players(query, limit=15):
    """Search the offline player list bundled with nba_api. No network."""
    matches = players.find_players_by_full_name(query)

    # Active players first, then alphabetically -- someone typing "curry"
    # almost certainly means Stephen, not Dell.
    matches.sort(key=lambda player: (not player["is_active"], player["full_name"]))

    return [
        {
            "id": player["id"],
            "name": player["full_name"],
            "isActive": player["is_active"],
        }
        for player in matches[:limit]
    ]


def list_seasons():
    """Every season with shot-chart data, newest first."""
    latest = config.latest_season_start_year()
    return [
        {
            "value": config.season_label(year),
            "hasTracking": year >= config.FIRST_TRACKING_YEAR,
        }
        for year in range(latest, config.FIRST_SHOT_CHART_YEAR - 1, -1)
    ]


# --- shot-level data ----------------------------------------------------


def _fetch_shots(player_id, season):
    response = shotchartdetail.ShotChartDetail(
        team_id=ANY_TEAM,
        player_id=player_id,
        season_nullable=season,
        season_type_all_star=config.SEASON_TYPE,
        context_measure_simple="FGA",
        timeout=config.NBA_TIMEOUT_SECONDS,
    ).get_dict()

    raw_shots = _rows_as_dicts(_find_result_set(response, "Shot_Chart_Detail"))

    shots = []
    for row in raw_shots:
        home, visitor = row.get("HTM"), row.get("VTM")
        # We no longer pin a team id, so read the player's team from the row
        # itself. That keeps home/away correct for a player traded mid-season.
        is_home = home == _team_abbreviation(row.get("TEAM_ID"))
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

    return {
        "meta": _meta(
            player_id,
            season,
            "live",
            {
                "team": raw_shots[0]["TEAM_NAME"] if raw_shots else None,
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


def _fetch_splits(player_id, season):
    response = playerdashptshots.PlayerDashPtShots(
        player_id=player_id,
        team_id=ANY_TEAM,
        season=season,
        season_type_all_star=config.SEASON_TYPE,
        timeout=config.NBA_TIMEOUT_SECONDS,
    ).get_dict()

    overall_rows = _rows_as_dicts(_find_result_set(response, "Overall"))
    overall = (
        _normalise_split_row(overall_rows[0], "SHOT_TYPE") if overall_rows else None
    )

    splits = {}
    for key, (result_set_name, label_column) in SPLIT_SETS.items():
        rows = _rows_as_dicts(_find_result_set(response, result_set_name))
        normalised = [_normalise_split_row(row, label_column) for row in rows]
        # SORT_ORDER encodes the meaningful sequence (e.g. shot clock
        # 24-22 before 4-0). Alphabetical would scramble the chart.
        normalised.sort(key=lambda item: item["sortOrder"] or 0)
        splits[key] = normalised

    return {
        "meta": _meta(
            player_id,
            season,
            "live",
            {"games": overall["games"] if overall else None},
        ),
        "overall": overall,
        "splits": splits,
    }


# --- public API ---------------------------------------------------------


def _load(kind, fetcher, player_id, season, refresh=False):
    """Serve from cache unless asked to refresh; fall back to cache on failure."""
    parse_season(season)

    if not refresh:
        cached = _read_cache(kind, player_id, season)
        if cached is not None:
            cached["meta"]["source"] = "cache"
            return cached

    try:
        payload = fetcher(player_id, season)
    except Exception as exc:
        cached = _read_cache(kind, player_id, season)
        if cached is not None:
            cached["meta"]["source"] = "cache"
            cached["meta"]["warning"] = f"Live fetch failed, served cache: {exc}"
            return cached
        raise

    _write_cache(kind, player_id, season, payload)
    return payload


def load_shots(player_id=None, season=None, refresh=False):
    return _load(
        "shots",
        _fetch_shots,
        player_id or config.DEFAULT_PLAYER_ID,
        season or config.DEFAULT_SEASON,
        refresh,
    )


def load_splits(player_id=None, season=None, refresh=False):
    return _load(
        "splits",
        _fetch_splits,
        player_id or config.DEFAULT_PLAYER_ID,
        season or config.DEFAULT_SEASON,
        refresh,
    )
