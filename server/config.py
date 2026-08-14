"""Defaults and constants for ShotIQ.

Player and season are no longer fixed -- they arrive as query parameters.
These are only the values used when the client does not ask for anything
specific. They stay environment-overridable so a deployment can feature a
different player without a rebuild.
"""

import os
from datetime import date

from dotenv import load_dotenv

# Loaded here, at the top of the module everything else imports, so it runs
# before any os.getenv call below. A .env read after the first getenv would
# silently do nothing.
#
# Nothing in .env is optional-but-nice: it holds the LLM key. It is
# gitignored, and .env.example documents the shape without the secret.
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

# Shai Gilgeous-Alexander, MVP of the 2025-26 season (his second in a row).
DEFAULT_PLAYER_ID = int(os.getenv("SHOTIQ_PLAYER_ID", "1628983"))
DEFAULT_SEASON = os.getenv("SHOTIQ_SEASON", "2025-26")

SEASON_TYPE = os.getenv("SHOTIQ_SEASON_TYPE", "Regular Season")

# stats.nba.com is slow and unofficial. Be patient, then give up cleanly.
NBA_TIMEOUT_SECONDS = int(os.getenv("SHOTIQ_NBA_TIMEOUT", "90"))

# Angles are meaningless at the rim (a layup has no meaningful "angle"),
# so we report None below this distance rather than emitting noise.
MIN_DISTANCE_FOR_ANGLE_FT = 3

# Shot coordinates were first recorded league-wide in 1996-97.
FIRST_SHOT_CHART_YEAR = 1996

# Player tracking (defender distance, shot clock, touch time) only exists
# from 2013-14, when SportVU cameras were installed in every arena.
# Earlier seasons return empty result sets rather than an error.
FIRST_TRACKING_YEAR = 2013


# Whether the summary endpoint may call the LLM at all.
#
# Defaults to FALSE -- it fails closed. A hosted demo that forgets to set
# anything serves only summaries already committed to the cache, so a
# public URL can never be pointed at this project's quota. Turning it on is
# a deliberate act, taken locally, by someone who can see the bill.
SUMMARY_LIVE = os.getenv("SHOTIQ_SUMMARY_LIVE", "false").strip().lower() == "true"


def latest_season_start_year(today=None):
    """The start year of the most recent season that has begun.

    An NBA season spans two calendar years and tips off in October, so
    before October we are still inside the season that started last year.
    """
    today = today or date.today()
    return today.year if today.month >= 10 else today.year - 1


def season_label(start_year):
    """1996 -> '1996-97', 2025 -> '2025-26'."""
    return f"{start_year}-{str(start_year + 1)[-2:]}"
