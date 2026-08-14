"""Tests for prompt construction, response parsing, and the cache gate.

Nothing here reaches the network or needs an API key. Every test that
involves the model injects a stub client, and one test asserts that the
real client is never even constructed -- so a mistake that starts calling
Gemini during the suite fails rather than quietly costing quota.
"""

import json
from types import SimpleNamespace

import pytest

import analytics
import config
import summary

VALID_RESPONSE = json.dumps(
    {
        "strengths": ["He shot 57.3% from 8-16 ft on 412 attempts."],
        "watch": ["38.0% with 4-0 seconds left."],
        "context": "Most of his attempts come off the dribble.",
        "headline": "A mid-range season with few peers.",
    }
)


class StubClient:
    """Stands in for genai.Client. Records what it was asked."""

    def __init__(self, text=VALID_RESPONSE):
        self._text = text
        self.calls = []
        # The real client exposes client.models.generate_content, so the
        # stub is its own .models namespace.
        self.models = self

    def generate_content(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(text=self._text)


@pytest.fixture
def digest():
    return {
        "player": "Test Player",
        "season": "2025-26",
        "seasonType": "Regular Season",
        "overall": {"attempts": 1321, "made": 731, "fgPct": 0.553},
        "byDistance": [
            {
                "band": "8-16 ft",
                "attempts": 412,
                "made": 236,
                "fgPct": 0.573,
                "leagueFgPct": 0.446,
                "diffPt": 12.7,
                "lowSample": False,
            }
        ],
        "minAttempts": 25,
    }


@pytest.fixture(autouse=True)
def isolated_cache(tmp_path, monkeypatch):
    """Never let a test read or write the committed cache."""
    monkeypatch.setattr(summary, "CACHE_DIR", tmp_path)
    return tmp_path


@pytest.fixture(autouse=True)
def no_real_client(monkeypatch):
    """Building a real client means a key and a network call. Fail loudly."""

    def explode():
        raise AssertionError("the suite tried to construct a real API client")

    monkeypatch.setattr(summary, "_build_client", explode)


class TestBuildPrompt:
    def test_carries_the_whole_digest(self, digest):
        prompt = summary.build_prompt(digest)

        # The numbers must be literally present: the model is told to use
        # only what appears here, so anything absent is unusable.
        assert "0.573" in prompt
        assert "12.7" in prompt
        assert "Test Player" in prompt
        assert "2025-26" in prompt

    def test_restates_the_only_source_rule(self, digest):
        assert "must appear above" in summary.build_prompt(digest)

    def test_is_valid_json_inside(self, digest):
        # A malformed embedded digest would be far worse than a missing one,
        # because the model would still confidently read something.
        prompt = summary.build_prompt(digest)
        body = prompt[prompt.index("{") : prompt.rindex("}") + 1]

        assert json.loads(body)["byDistance"][0]["fgPct"] == 0.573


class TestResponseSchema:
    def test_generates_the_headline_last(self):
        # Regression test for a deliberate decision. Gemini fills the schema
        # in order, so a headline generated first would be a thesis written
        # before any evidence was examined, with the analysis bent to fit it.
        assert summary.RESPONSE_SCHEMA["propertyOrdering"][-1] == "headline"

    def test_requires_every_field_the_ui_renders(self):
        assert set(summary.RESPONSE_SCHEMA["required"]) == set(summary.SUMMARY_FIELDS)

    def test_bounds_the_lists_so_the_panel_cannot_sprawl(self):
        strengths = summary.RESPONSE_SCHEMA["properties"]["strengths"]
        assert (strengths["minItems"], strengths["maxItems"]) == (2, 3)


class TestParse:
    def test_extracts_the_four_fields(self):
        parsed = summary._parse(VALID_RESPONSE)

        assert set(parsed) == set(summary.SUMMARY_FIELDS)

    @pytest.mark.parametrize("text", ["", "   ", None])
    def test_rejects_an_empty_response(self, text):
        with pytest.raises(summary.SummaryUnavailable, match="empty"):
            summary._parse(text)

    def test_rejects_prose_that_is_not_json(self):
        # responseSchema makes this very unlikely, not impossible -- and a
        # half-parsed summary must never reach the cache and become
        # permanent.
        with pytest.raises(summary.SummaryUnavailable, match="did not return JSON"):
            summary._parse("Here is your summary!")

    def test_rejects_a_response_missing_a_field(self):
        incomplete = json.dumps({"headline": "x", "strengths": ["y"], "watch": ["z"]})

        with pytest.raises(summary.SummaryUnavailable, match="context"):
            summary._parse(incomplete)

    def test_rejects_a_field_that_is_present_but_empty(self):
        # An empty list still renders an empty panel, which looks broken.
        empty = json.dumps(
            {"headline": "x", "strengths": [], "watch": ["z"], "context": "c"}
        )

        with pytest.raises(summary.SummaryUnavailable, match="strengths"):
            summary._parse(empty)


class TestGenerate:
    def test_returns_the_summary_with_provenance(self, digest):
        result = summary.generate(digest, client=StubClient())

        assert result["headline"] == "A mid-range season with few peers."
        assert result["meta"]["model"] == summary.MODEL
        assert result["meta"]["source"] == "live"

    def test_sends_the_pinned_model_and_the_schema(self, digest):
        client = StubClient()
        summary.generate(digest, client=client)

        call = client.calls[0]
        assert call["model"] == summary.MODEL
        assert call["config"].response_schema == summary.RESPONSE_SCHEMA
        assert call["config"].response_mime_type == "application/json"
        assert call["config"].temperature == summary.TEMPERATURE

    def test_tells_the_model_to_use_only_the_digest(self, digest):
        client = StubClient()
        summary.generate(digest, client=client)

        instruction = client.calls[0]["config"].system_instruction
        assert "only source" in instruction
        assert "lowSample" in instruction

    def test_refuses_a_season_with_no_attempts(self):
        # Calling the model here would spend quota to be told there is
        # nothing to say.
        empty = analytics.build_digest(None, None)

        with pytest.raises(summary.SummaryUnavailable, match="nothing to summarise"):
            summary.generate(empty, client=StubClient())

    def test_turns_a_vendor_failure_into_our_own_error(self, digest):
        # Regression test. The first live call returned Gemini's
        # "503 UNAVAILABLE: high demand", and the SDK exception sailed past
        # every handler in the route, so the client saw an opaque 500
        # instead of the 502 the design called for. Every error path had
        # been tested except the one raised by someone else's code.
        class ExplodingClient:
            def __init__(self):
                self.models = self

            def generate_content(self, **kwargs):
                raise RuntimeError("503 UNAVAILABLE. high demand")

        with pytest.raises(summary.SummaryUnavailable, match="could not be reached"):
            summary.generate(digest, client=ExplodingClient())

    def test_does_not_swallow_our_own_errors_as_vendor_errors(self, digest):
        # The broad except must not relabel a NothingToSummarise raised
        # deeper down as an unreachable model.
        empty = analytics.build_digest(None, None)

        with pytest.raises(summary.NothingToSummarise):
            summary.generate(empty, client=StubClient())

    def test_records_which_digest_it_described(self, digest):
        result = summary.generate(digest, client=StubClient())

        assert result["meta"]["digest"] == summary.digest_fingerprint(digest)


class TestDigestFingerprint:
    def test_is_stable_for_the_same_data(self, digest):
        assert summary.digest_fingerprint(digest) == summary.digest_fingerprint(digest)

    def test_ignores_key_order(self, digest):
        reordered = dict(reversed(list(digest.items())))

        assert summary.digest_fingerprint(reordered) == summary.digest_fingerprint(digest)

    def test_changes_when_a_number_moves(self, digest):
        before = summary.digest_fingerprint(digest)
        digest["byDistance"][0]["fgPct"] = 0.574

        assert summary.digest_fingerprint(digest) != before


class TestLoadSummary:
    def test_serves_the_cache_without_calling_the_model(
        self, digest, monkeypatch
    ):
        # Live generation is deliberately ENABLED here, so the only reason
        # no call happens is the cache hit itself. With it disabled the test
        # would pass for the wrong reason.
        monkeypatch.setattr(config, "SUMMARY_LIVE", True)
        summary._write_cache(7, "2025-26", summary.generate(digest, client=StubClient()))

        client = StubClient()
        result = summary.load_summary(7, "2025-26", digest, client=client)

        assert client.calls == []
        assert result["meta"]["source"] == "cache"
        assert result["headline"] == "A mid-range season with few peers."

    def test_flags_a_cached_summary_whose_numbers_have_moved(self, digest):
        summary._write_cache(7, "2025-26", summary.generate(digest, client=StubClient()))

        moved = json.loads(json.dumps(digest))
        moved["byDistance"][0]["fgPct"] = 0.601
        result = summary.load_summary(7, "2025-26", moved)

        # Flagged, not discarded: the prose is probably still fair, and
        # throwing it away would spend quota automatically.
        assert result["meta"]["stale"] is True

    def test_does_not_flag_a_summary_that_still_matches(self, digest):
        summary._write_cache(7, "2025-26", summary.generate(digest, client=StubClient()))

        result = summary.load_summary(7, "2025-26", digest)

        assert "stale" not in result["meta"]

    def test_refuses_to_generate_when_live_is_off(self, digest, monkeypatch):
        # The public-deploy guarantee: no cache, no key spent.
        monkeypatch.setattr(config, "SUMMARY_LIVE", False)

        with pytest.raises(summary.SummaryUnavailable, match="disabled"):
            summary.load_summary(7, "2025-26", digest, client=StubClient())

    def test_generates_and_caches_when_live_is_on(self, digest, monkeypatch, isolated_cache):
        monkeypatch.setattr(config, "SUMMARY_LIVE", True)

        result = summary.load_summary(7, "2025-26", digest, client=StubClient())

        assert result["meta"]["source"] == "live"
        assert (isolated_cache / "summary-7-2025-26.json").exists()

    def test_refresh_bypasses_the_cache(self, digest, monkeypatch):
        monkeypatch.setattr(config, "SUMMARY_LIVE", True)
        summary._write_cache(7, "2025-26", summary.generate(digest, client=StubClient()))

        client = StubClient()
        result = summary.load_summary(7, "2025-26", digest, refresh=True, client=client)

        assert len(client.calls) == 1
        assert result["meta"]["source"] == "live"

    def test_defaults_to_failing_closed_when_nothing_is_configured(
        self, monkeypatch
    ):
        # THE public-deploy guarantee. A checkout that sets no environment
        # variable at all must not be able to spend quota, so the default
        # has to be False rather than "on unless disabled".
        import importlib

        monkeypatch.delenv("SHOTIQ_SUMMARY_LIVE", raising=False)
        reloaded = importlib.reload(config)
        try:
            assert reloaded.SUMMARY_LIVE is False
        finally:
            # Leave the module as the rest of the suite expects to find it.
            importlib.reload(config)

    @pytest.mark.parametrize(
        ("value", "expected"),
        [("true", True), ("TRUE", True), (" true ", True), ("1", False), ("yes", False)],
    )
    def test_only_the_word_true_turns_generation_on(
        self, value, expected, monkeypatch
    ):
        # '1' and 'yes' read as enabling to a human, so they are the likely
        # typo. They must not switch quota on by accident.
        import importlib

        monkeypatch.setenv("SHOTIQ_SUMMARY_LIVE", value)
        reloaded = importlib.reload(config)
        try:
            assert reloaded.SUMMARY_LIVE is expected
        finally:
            monkeypatch.delenv("SHOTIQ_SUMMARY_LIVE", raising=False)
            importlib.reload(config)
