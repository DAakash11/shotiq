"""Integration tests exercising real HTTP requests against the API.

These deliberately never reach stats.nba.com. The default subject's
responses are committed to server/cache/, so the data endpoints resolve
from disk -- which makes these tests deterministic and runnable offline.
"""

from fastapi.testclient import TestClient

import main

client = TestClient(main.app)


class TestHealth:
    def test_reports_ok_and_the_configured_defaults(self):
        response = client.get("/api/health")
        assert response.status_code == 200

        body = response.json()
        assert body["status"] == "ok"
        assert body["defaults"]["season"] == "2025-26"


class TestShots:
    def test_defaults_to_the_featured_player(self):
        response = client.get("/api/shots")
        assert response.status_code == 200

        meta = response.json()["meta"]
        assert meta["player"] == "Shai Gilgeous-Alexander"
        assert meta["season"] == "2025-26"

    def test_is_served_from_the_committed_cache(self):
        # If this ever says "live", the test is silently hitting the
        # network and is no longer deterministic.
        assert client.get("/api/shots").json()["meta"]["source"] == "cache"

    def test_reported_totals_agree_with_the_records(self):
        body = client.get("/api/shots").json()
        meta = body["meta"]

        assert len(body["shots"]) == meta["attempts"]
        assert sum(1 for shot in body["shots"] if shot["made"]) == meta["made"]

    def test_every_record_has_the_shape_the_table_expects(self):
        shot = client.get("/api/shots").json()["shots"][0]
        assert set(shot) >= {
            "id",
            "gameDate",
            "opponent",
            "isHome",
            "period",
            "clock",
            "distanceFt",
            "angleDeg",
            "made",
        }
        assert isinstance(shot["made"], bool)

    def test_row_ids_are_unique_so_react_keys_stay_stable(self):
        shots = client.get("/api/shots").json()["shots"]
        assert len({shot["id"] for shot in shots}) == len(shots)

    def test_never_lists_the_players_own_team_as_the_opponent(self):
        # Home/away is derived from each row's team id; getting it wrong
        # would make the player appear to play himself.
        opponents = {shot["opponent"] for shot in client.get("/api/shots").json()["shots"]}
        assert "OKC" not in opponents

    def test_includes_league_averages_as_a_comparison_baseline(self):
        assert len(client.get("/api/shots").json()["leagueAverages"]) > 0

    def test_rejects_a_season_before_shot_charts_existed(self):
        response = client.get("/api/shots", params={"season": "1990-91"})
        assert response.status_code == 400
        assert "1996-97" in response.json()["detail"]

    def test_rejects_a_malformed_season(self):
        assert client.get("/api/shots", params={"season": "nope"}).status_code == 400


class TestSplits:
    def test_returns_tracking_buckets_in_a_meaningful_order(self):
        body = client.get("/api/splits").json()
        buckets = body["splits"]["defenderDistance"]

        assert [bucket["sortOrder"] for bucket in buckets] == sorted(
            bucket["sortOrder"] for bucket in buckets
        )
        # Tightest coverage first, most open last.
        assert buckets[0]["label"].startswith("0-2")
        assert buckets[-1]["label"].startswith("6+")

    def test_flags_that_this_season_has_tracking_data(self):
        assert client.get("/api/splits").json()["meta"]["hasTracking"] is True


class TestPlayerSearch:
    def test_ranks_active_players_first(self):
        response = client.get("/api/players", params={"q": "curry"})
        assert response.status_code == 200
        assert response.json()["players"][0]["name"] == "Stephen Curry"

    def test_requires_at_least_two_characters(self):
        # FastAPI validates min_length before our code runs, so this is a
        # 422 from the framework rather than a 400 from us.
        assert client.get("/api/players", params={"q": "c"}).status_code == 422

    def test_returns_an_empty_list_rather_than_an_error_for_no_matches(self):
        response = client.get("/api/players", params={"q": "zzzzzzzz"})
        assert response.status_code == 200
        assert response.json()["players"] == []


class TestSeasons:
    def test_lists_seasons_newest_first(self):
        seasons = client.get("/api/seasons").json()["seasons"]
        assert seasons[0]["value"] == "2025-26"
        assert seasons[-1]["value"] == "1996-97"

    def test_marks_which_seasons_have_player_tracking(self):
        by_season = {
            season["value"]: season["hasTracking"]
            for season in client.get("/api/seasons").json()["seasons"]
        }
        assert by_season["2013-14"] is True
        assert by_season["2012-13"] is False
