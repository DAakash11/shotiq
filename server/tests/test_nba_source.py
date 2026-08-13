"""Unit tests for the pure logic in the data layer.

Nothing here touches the network. The player and team lookups use the
offline lists that ship with nba_api.
"""

from datetime import date

import pytest

import config
import nba_source


class TestParseSeason:
    def test_accepts_a_valid_season(self):
        assert nba_source.parse_season("2025-26") == 2025

    @pytest.mark.parametrize("value", ["nope", "2025", "2025/26", "25-26", ""])
    def test_rejects_malformed_input(self, value):
        with pytest.raises(ValueError, match="must look like"):
            nba_source.parse_season(value)

    def test_rejects_seasons_before_shot_charts_existed(self):
        # Shot coordinates were first recorded league-wide in 1996-97.
        with pytest.raises(ValueError, match="1996-97"):
            nba_source.parse_season("1990-91")

    def test_rejects_a_season_that_has_not_started(self):
        with pytest.raises(ValueError, match="not started"):
            nba_source.parse_season("2099-00")


class TestSeasonHelpers:
    @pytest.mark.parametrize(
        ("start_year", "expected"),
        [(1996, "1996-97"), (1999, "1999-00"), (2025, "2025-26")],
    )
    def test_season_label_spans_two_years(self, start_year, expected):
        assert config.season_label(start_year) == expected

    def test_before_october_we_are_still_in_last_years_season(self):
        assert config.latest_season_start_year(date(2026, 8, 13)) == 2025

    def test_october_tips_off_the_new_season(self):
        assert config.latest_season_start_year(date(2026, 10, 1)) == 2026


class TestShotAngle:
    def test_is_none_at_the_rim_where_an_angle_means_nothing(self):
        assert nba_source._shot_angle_degrees(-5, 1, 0) is None

    def test_is_none_when_coordinates_are_missing(self):
        assert nba_source._shot_angle_degrees(None, 179, 18) is None

    def test_straight_on_is_zero_degrees(self):
        assert nba_source._shot_angle_degrees(0, 200, 20) == 0.0

    def test_right_of_the_rim_is_positive(self):
        assert nba_source._shot_angle_degrees(100, 100, 14) > 0

    def test_left_of_the_rim_is_negative(self):
        assert nba_source._shot_angle_degrees(-100, 100, 14) < 0

    def test_matches_a_known_shot(self):
        # A real Jokic attempt: LOC_X 43, LOC_Y 179, reported as 18 ft.
        assert nba_source._shot_angle_degrees(43, 179, 18) == 13.5


class TestTeamAbbreviation:
    def test_resolves_an_abbreviation_that_is_not_a_substring_of_the_name(self):
        # Regression test. Deriving this by checking whether 'OKC' appears
        # inside 'Oklahoma City Thunder' fails -- those letters are not
        # contiguous -- which silently broke home/away detection.
        assert nba_source._team_abbreviation(1610612760) == "OKC"

    def test_returns_none_for_an_unknown_team(self):
        assert nba_source._team_abbreviation(1) is None


class TestIsoDate:
    def test_reformats_the_compact_date(self):
        assert nba_source._iso_date("20211020") == "2021-10-20"

    @pytest.mark.parametrize("value", [None, "", "2021-10-20"])
    def test_passes_through_anything_unexpected(self, value):
        assert nba_source._iso_date(value) == value


class TestSearchPlayers:
    def test_ranks_active_players_above_retired_ones(self):
        results = nba_source.search_players("curry")
        assert results[0]["name"] == "Stephen Curry"
        assert results[0]["isActive"] is True

    def test_returns_nothing_for_an_unknown_name(self):
        assert nba_source.search_players("zzzzzzzz") == []

    def test_respects_the_limit(self):
        assert len(nba_source.search_players("a", limit=3)) <= 3


class TestListSeasons:
    def test_is_newest_first(self):
        seasons = nba_source.list_seasons()
        assert seasons[0]["value"] > seasons[-1]["value"]

    def test_reaches_back_to_the_first_shot_chart_season(self):
        assert nba_source.list_seasons()[-1]["value"] == "1996-97"

    def test_flags_the_player_tracking_cutoff(self):
        by_season = {s["value"]: s["hasTracking"] for s in nba_source.list_seasons()}
        # SportVU cameras arrived in every arena for 2013-14.
        assert by_season["2013-14"] is True
        assert by_season["2012-13"] is False
