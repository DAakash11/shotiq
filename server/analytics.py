"""Turns raw API payloads into the compact factual digest the LLM is given.

This is the Python twin of src/utils/aggregate.js, and the duplication is
deliberate. The client could compute these numbers -- it already does, for
the charts -- but the summary endpoint must not accept them. Anything the
client posts is attacker-controlled, and posting aggregates would mean
arbitrary text reaching an LLM prompt paid for by this project's key. So
the client posts a player id and a season, and the server re-derives every
number from its own cached data.

The cost of that decision is two implementations that must agree. Both test
suites therefore pin the same three numbers off the same committed cache
(.573 / .446 / +12.7 for the 8-16 ft band), so drift fails a test on
whichever side moved.

It is a twin, not a port. The charts need axis-sized labels and pixel
geometry; a prompt needs neither, and wants the descriptive label the API
actually returned. Where the two differ, that is why.

Pure functions only: no network, no file access, no API keys.
"""

# Below this many attempts a percentage is mostly noise -- at 25 attempts
# the 95% interval around a .500 shooter is roughly +/-20 percentage
# points. Flagged rather than dropped, so the model can see the bucket
# exists without building a claim on twelve shots. Must stay in step with
# MIN_ATTEMPTS in src/utils/aggregate.js.
MIN_ATTEMPTS = 25

# stats.nba.com's zoneRange values, in court order. These are the join key
# between a player's shots and the league averages returned alongside them:
# both sides carry zoneRange, so the comparison needs no lookup table.
#
# 'Back Court Shot' is deliberately absent. Those are buzzer heaves, and a
# .667 league rate on nine attempts league-wide would read to a model as a
# genuine efficiency signal rather than as noise about the clock.
DISTANCE_BANDS = [
    ("Less Than 8 ft.", "Less than 8 ft"),
    ("8-16 ft.", "8-16 ft"),
    ("16-24 ft.", "16-24 ft"),
    ("24+ ft.", "24+ ft"),
]

# The tracking splits worth spending prompt tokens on. Dribbles and touch
# time say much the same thing as shot clock for a primary ball handler,
# and a longer prompt is a worse one.
SPLIT_KEYS = ("defenderDistance", "shotClock", "general")


def _rate(made, attempts):
    """A rate is undefined with no attempts -- None, never 0.

    Zero would tell the model the player missed everything from a range he
    never shot from, which is exactly the kind of confident wrong sentence
    a summary must not contain.
    """
    return made / attempts if attempts else None


def _round(value, places=3):
    """Round, preserving None.

    Full float precision is both false precision and wasted tokens:
    0.5728155339805825 says nothing .573 does not.
    """
    return None if value is None else round(value, places)


def _points(value):
    """A rate difference expressed in percentage points: 0.1272 -> 12.7.

    Percentage points, not a ratio -- '+12.7pt' is a claim a reader can
    check, '1.29x' invites the model to call it '29% better', which is a
    different and wrong statement.
    """
    return None if value is None else round(value * 100, 1)


def shooting_by_distance(shots, league_averages):
    """Player shooting per distance band, against the league on the same range.

    Returns every band in court order even where the player never shot from
    one, so the digest keeps a stable shape across players and seasons and
    the model is never left guessing whether a range was omitted or unused.
    """
    player = {}
    for shot in shots or []:
        made, attempts = player.get(shot.get("zoneRange"), (0, 0))
        player[shot.get("zoneRange")] = (
            made + (1 if shot.get("made") else 0),
            attempts + 1,
        )

    # The league rate must be re-derived from raw makes and attempts.
    # Averaging the per-row fgPct values is the classic aggregation error:
    # the league rows are split by court area, so a 9-attempt backcourt row
    # would weigh as much as a 26,000-attempt one. On 2025-26 that mistake
    # moves 'Above the Break 3' from a true .350 to a reported .429.
    league = {}
    for row in league_averages or []:
        made, attempts = league.get(row.get("zoneRange"), (0, 0))
        league[row.get("zoneRange")] = (
            made + (row.get("fgm") or 0),
            attempts + (row.get("fga") or 0),
        )

    bands = []
    for key, label in DISTANCE_BANDS:
        made, attempts = player.get(key, (0, 0))
        league_made, league_attempts = league.get(key, (0, 0))

        fg_pct = _rate(made, attempts)
        league_pct = _rate(league_made, league_attempts)
        diff = None if fg_pct is None or league_pct is None else fg_pct - league_pct

        bands.append(
            {
                "band": label,
                "attempts": attempts,
                "made": made,
                "fgPct": _round(fg_pct),
                "leagueFgPct": _round(league_pct),
                # Percentage points above or below the league on this range.
                "diffPt": _points(diff),
                "lowSample": 0 < attempts < MIN_ATTEMPTS,
            }
        )

    return bands


def split_series(rows):
    """One tracking split (defender distance, shot clock, ...) as prompt rows.

    Buckets the player never shot from are dropped entirely rather than
    carried as nulls. The chart keeps them so the axis stays stable between
    players; a prompt has no axis, and an empty bucket is a line the model
    could only misread.
    """
    series = []
    for row in rows or []:
        attempts = row.get("fga") or 0
        if not attempts:
            continue

        # stats.nba.com emits an unlabelled shot-clock row -- null range,
        # null sortOrder -- for attempts taken with the shot clock off.
        # It arrives with real attempts and zero makes: 69 attempts at
        # 0.0% on LeBron's 2015-16, above MIN_ATTEMPTS and so not flagged
        # as a thin sample. Handing that to a model is handing it a
        # confident, meaningless, nameless statistic; a bucket with no
        # name cannot be described, only misdescribed.
        # Stripped, because a whitespace-only label is truthy and would
        # sail through an emptiness check while still being no name at all.
        label = str(row.get("label") or "").strip()
        if not label:
            continue

        series.append(
            {
                # The full descriptive label, unlike the chart's shortened
                # axis tick: '0-2 Feet - Very Tight' tells a model what the
                # bucket means, where '0-2 ft' makes it infer.
                "bucket": label,
                "attempts": attempts,
                "made": row.get("fgm") or 0,
                "fgPct": _round(row.get("fgPct")),
                # eFG% credits a three as worth 1.5 twos. Without it a
                # bucket full of threes reads as worse shooting than it is.
                "efgPct": _round(row.get("efgPct")),
                # Share of the player's total attempts. This is what makes a
                # bucket worth mentioning at all -- .620 on 4% of his shots
                # is a footnote, on 40% it is the story.
                "sharePct": _points(row.get("frequency")),
                "lowSample": attempts < MIN_ATTEMPTS,
            }
        )

    return series


def _overall(shots_meta, splits_overall):
    """Season totals, preferring the tracking row where it exists.

    The shots payload counts attempts itself; the splits payload's Overall
    row carries eFG% and the two/three breakdown that shot records do not.
    They are the same season from the same source, so where both exist they
    agree -- but only one of them exists before 2013-14.
    """
    totals = {
        "attempts": shots_meta.get("attempts") or 0,
        "made": shots_meta.get("made") or 0,
        "fgPct": _round(shots_meta.get("fgPct")),
    }

    if splits_overall:
        totals.update(
            {
                "efgPct": _round(splits_overall.get("efgPct")),
                "fg2a": splits_overall.get("fg2a"),
                "fg2Pct": _round(splits_overall.get("fg2Pct")),
                "fg3a": splits_overall.get("fg3a"),
                "fg3Pct": _round(splits_overall.get("fg3Pct")),
            }
        )

    return totals


def build_digest(shots_payload, splits_payload=None):
    """The complete set of facts the prompt is allowed to talk about.

    Everything the model sees comes from here, which is the point: the
    prompt cannot mention a number this function did not produce, so
    checking the summary against the data is a matter of reading one dict.

    Seasons before 2013-14 predate player tracking, and a player can have a
    season with no attempts at all. Both come back as a digest with an
    honest zero rather than an exception -- deciding whether there is
    enough here to summarise belongs to the caller.
    """
    shots_payload = shots_payload or {}
    splits_payload = splits_payload or {}

    meta = shots_payload.get("meta") or {}
    splits = splits_payload.get("splits") or {}

    digest = {
        "player": meta.get("player"),
        "season": meta.get("season"),
        "team": meta.get("team"),
        "seasonType": meta.get("seasonType"),
        "games": (splits_payload.get("meta") or {}).get("games"),
        "overall": _overall(meta, splits_payload.get("overall")),
        "byDistance": shooting_by_distance(
            shots_payload.get("shots"),
            shots_payload.get("leagueAverages"),
        ),
        "minAttempts": MIN_ATTEMPTS,
    }

    for key in SPLIT_KEYS:
        series = split_series(splits.get(key))
        # Omit an empty split rather than sending an empty list. A pre-2013
        # season has no tracking at all, and the absence of the key says
        # that more clearly to a model than 'defenderDistance: []'.
        if series:
            digest[key] = series

    return digest


def has_enough_data(digest):
    """Whether there is anything here worth asking a model to summarise.

    A season with no attempts is not a short summary, it is no summary --
    and calling the LLM on it would spend quota to be told so.
    """
    return bool(digest.get("overall", {}).get("attempts"))
