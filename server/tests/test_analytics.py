"""Unit tests for the digest the LLM prompt is built from.

Nothing here touches the network or an API key. The fixture tests read the
committed cache for the default subject, which is the same file the JS
suite pins its numbers to -- so if analytics.py and aggregate.js ever stop
agreeing, one of the two suites fails.
"""

import json
from pathlib import Path

import pytest

import analytics

CACHE_DIR = Path(__file__).parent.parent / "cache"


def _cache(name):
    return json.loads((CACHE_DIR / name).read_text(encoding="utf-8"))


def _shots(zone_range, attempts, made):
    """A synthetic run of shots from one zone."""
    return [{"zoneRange": zone_range, "made": index < made} for index in range(attempts)]


def _band(bands, label):
    return next(band for band in bands if band["band"] == label)


@pytest.fixture(scope="module")
def digest():
    """The real digest for the default subject, built once for the module."""
    return analytics.build_digest(
        _cache("shots-1628983-2025-26.json"),
        _cache("splits-1628983-2025-26.json"),
    )


class TestShootingByDistance:
    def test_returns_every_band_even_when_unused(self):
        # A stable shape matters: the model must never have to guess
        # whether a missing range means "never shot" or "not reported".
        bands = analytics.shooting_by_distance(_shots("8-16 ft.", 10, 5), [])

        assert [band["band"] for band in bands] == [
            "Less than 8 ft",
            "8-16 ft",
            "16-24 ft",
            "24+ ft",
        ]

    def test_counts_makes_and_attempts(self):
        band = _band(analytics.shooting_by_distance(_shots("24+ ft.", 100, 39), []), "24+ ft")

        assert (band["attempts"], band["made"]) == (100, 39)
        assert band["fgPct"] == 0.39

    def test_a_rate_with_no_attempts_is_none_not_zero(self):
        # Zero would say he missed everything from a range he never used.
        band = _band(analytics.shooting_by_distance([], []), "16-24 ft")

        assert band["attempts"] == 0
        assert band["fgPct"] is None
        assert band["diffPt"] is None

    def test_weights_the_league_rate_by_attempts(self):
        # The league rows are split by court area, so the naive mean of the
        # two percentages (.667 and .352) would give .510 rather than the
        # true .352 -- letting a 9-attempt row outweigh a 26,000-attempt one.
        bands = analytics.shooting_by_distance(
            _shots("24+ ft.", 10, 4),
            [
                {"zoneRange": "24+ ft.", "fgm": 6, "fga": 9},
                {"zoneRange": "24+ ft.", "fgm": 9152, "fga": 26000},
            ],
        )

        assert _band(bands, "24+ ft")["leagueFgPct"] == 0.352

    def test_reports_the_gap_in_percentage_points(self):
        bands = analytics.shooting_by_distance(
            _shots("8-16 ft.", 100, 57),
            [{"zoneRange": "8-16 ft.", "fgm": 446, "fga": 1000}],
        )

        assert _band(bands, "8-16 ft")["diffPt"] == 12.4

    def test_ignores_backcourt_heaves(self):
        # Those describe the clock, not shot selection, and nine league
        # attempts at .667 would read as a real efficiency signal.
        bands = analytics.shooting_by_distance(
            _shots("Back Court Shot", 4, 1),
            [{"zoneRange": "Back Court Shot", "fgm": 6, "fga": 9}],
        )

        assert sum(band["attempts"] for band in bands) == 0

    def test_flags_a_sample_too_thin_to_read_as_a_rate(self):
        thin = _band(analytics.shooting_by_distance(_shots("16-24 ft.", 12, 8), []), "16-24 ft")
        thick = _band(analytics.shooting_by_distance(_shots("16-24 ft.", 90, 40), []), "16-24 ft")

        assert thin["lowSample"] is True
        assert thick["lowSample"] is False

    def test_an_unused_band_is_not_flagged_as_low_sample(self):
        # Zero attempts is absence, not a thin sample, and flagging it would
        # invite the model to caveat a range that simply never came up.
        assert _band(analytics.shooting_by_distance([], []), "24+ ft")["lowSample"] is False

    def test_survives_a_player_with_no_shots_at_all(self):
        bands = analytics.shooting_by_distance(None, None)

        assert len(bands) == 4
        assert all(band["fgPct"] is None for band in bands)


class TestSplitSeries:
    def test_normalises_a_bucket(self):
        rows = analytics.split_series(
            [
                {
                    "label": "2-4 Feet - Tight",
                    "fga": 531,
                    "fgm": 312,
                    "fgPct": 0.588,
                    "efgPct": 0.6,
                    "frequency": 0.402,
                }
            ]
        )

        assert rows == [
            {
                "bucket": "2-4 Feet - Tight",
                "attempts": 531,
                "made": 312,
                "fgPct": 0.588,
                "efgPct": 0.6,
                "sharePct": 40.2,
                "lowSample": False,
            }
        ]

    def test_keeps_the_descriptive_label_the_chart_shortens(self):
        # The chart shows '0-2 ft' because an axis tick has no room. A
        # prompt has room, and the tail is what tells the model what the
        # bucket means.
        rows = analytics.split_series(
            [{"label": "0-2 Feet - Very Tight", "fga": 70, "fgm": 35, "fgPct": 0.5}]
        )

        assert rows[0]["bucket"] == "0-2 Feet - Very Tight"

    def test_drops_buckets_the_player_never_shot_from(self):
        rows = analytics.split_series(
            [
                {"label": "0-2 Feet - Very Tight", "fga": 0, "fgm": 0, "fgPct": None},
                {"label": "2-4 Feet - Tight", "fga": 531, "fgm": 312, "fgPct": 0.588},
            ]
        )

        assert [row["bucket"] for row in rows] == ["2-4 Feet - Tight"]

    def test_preserves_the_order_it_was_given(self):
        # nba_source has already sorted these by SORT_ORDER, which encodes
        # the meaningful sequence (shot clock 24-22 before 4-0).
        labels = ["24-22", "22-18 Very Early", "18-15 Early"]
        rows = analytics.split_series(
            [{"label": label, "fga": 40, "fgm": 20, "fgPct": 0.5} for label in labels]
        )

        assert [row["bucket"] for row in rows] == labels

    @pytest.mark.parametrize("rows", [None, []])
    def test_survives_a_season_before_tracking_existed(self, rows):
        assert analytics.split_series(rows) == []


class TestBuildDigest:
    def test_survives_empty_payloads(self):
        digest = analytics.build_digest(None, None)

        assert digest["overall"]["attempts"] == 0
        assert analytics.has_enough_data(digest) is False

    def test_omits_tracking_sections_entirely_when_absent(self):
        # An absent key says "this season predates tracking" more clearly
        # than an empty list does.
        digest = analytics.build_digest({"meta": {}, "shots": []}, None)

        assert "defenderDistance" not in digest
        assert "shotClock" not in digest

    def test_carries_the_low_sample_threshold_for_the_prompt(self):
        # The prompt tells the model what lowSample means, and the number
        # has to come from the same constant the flag was computed with.
        assert analytics.build_digest(None, None)["minAttempts"] == 25


class TestAgainstTheCommittedCache:
    """The real fixture, pinned to the same numbers as the JS suite."""

    def test_identifies_the_subject(self, digest):
        assert digest["player"] == "Shai Gilgeous-Alexander"
        assert digest["season"] == "2025-26"
        assert digest["team"] == "Oklahoma City Thunder"
        assert digest["games"] == 68

    def test_season_totals(self, digest):
        assert digest["overall"] == {
            "attempts": 1321,
            "made": 731,
            "fgPct": 0.553,
            "efgPct": 0.597,
            "fg2a": 1023,
            "fg2Pct": 0.602,
            "fg3a": 298,
            "fg3Pct": 0.386,
        }

    def test_the_pinned_band(self, digest):
        # THE drift test. src/utils/aggregate.test.js pins the same three
        # numbers off the same cache file, so a change to either
        # implementation that moves them fails on one side or the other.
        band = _band(digest["byDistance"], "8-16 ft")

        assert band["fgPct"] == 0.573
        assert band["leagueFgPct"] == 0.446
        assert band["diffPt"] == 12.7

    def test_band_attempts_sum_to_the_season_total_less_backcourt(self, digest):
        # He took no backcourt heaves in 2025-26, so every attempt should be
        # accounted for by exactly one band.
        assert sum(band["attempts"] for band in digest["byDistance"]) == 1321

    def test_the_tracking_splits_are_present_and_ordered(self, digest):
        assert digest["defenderDistance"][0]["bucket"] == "0-2 Feet - Very Tight"
        assert digest["shotClock"][0]["bucket"].startswith("24-22")
        assert {row["bucket"] for row in digest["general"]} == {
            "Catch and Shoot",
            "Pull Ups",
            "Less than 10 ft",
            "Other",
        }

    def test_shares_of_attempts_account_for_the_whole_season(self, digest):
        # FGA_FREQUENCY is a share of total attempts, so the defender
        # buckets should very nearly sum to 100% -- a sanity check that the
        # field means what the prompt will tell the model it means.
        total = sum(row["sharePct"] for row in digest["defenderDistance"])
        assert 99 <= total <= 101

    def test_is_small_enough_to_be_a_prompt(self, digest):
        # The digest IS the prompt's payload. If it grows without anyone
        # noticing, every summary gets more expensive and less focused.
        assert len(json.dumps(digest)) < 4000
