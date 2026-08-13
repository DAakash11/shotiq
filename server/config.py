"""Which player/season ShotIQ analyses.

Every value can be overridden with an environment variable, so the Docker
image at step 7 can be pointed at a different subject without a rebuild.
"""

import os

PLAYER_ID = int(os.getenv("SHOTIQ_PLAYER_ID", "203999"))  # Nikola Jokic
TEAM_ID = int(os.getenv("SHOTIQ_TEAM_ID", "1610612743"))  # Denver Nuggets
SEASON = os.getenv("SHOTIQ_SEASON", "2021-22")
SEASON_TYPE = os.getenv("SHOTIQ_SEASON_TYPE", "Regular Season")

# stats.nba.com is slow and unofficial. Be patient, then give up cleanly.
NBA_TIMEOUT_SECONDS = int(os.getenv("SHOTIQ_NBA_TIMEOUT", "90"))

# Angles are meaningless at the rim (a layup has no meaningful "angle"),
# so we report None below this distance rather than emitting noise.
MIN_DISTANCE_FOR_ANGLE_FT = 3
