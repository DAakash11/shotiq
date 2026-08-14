"""Builds the prompt, calls the LLM, and caches what comes back.

This is the ONLY module that knows which vendor is being called, in the
same spirit as nba_source.py being the only module that knows
stats.nba.com exists. Swapping Gemini for another provider should mean
editing this file and nothing else: the route, the digest, and the
frontend all deal in a plain dict with four keys.

Two safety properties are deliberate and worth keeping:

1. The model is given the digest and nothing else. Every number in a
   summary therefore traces to analytics.build_digest(), so checking one
   is a matter of reading one dict rather than trusting prose.

2. Generation fails closed. config.SUMMARY_LIVE defaults to False, so an
   unconfigured deployment serves only summaries already on disk and can
   never spend quota on this project's key.
"""

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import analytics
import config

CACHE_DIR = Path(__file__).parent / "cache"

# Pinned deliberately, not 'gemini-flash-latest'. An alias means the model
# under this prompt can change without a commit, which would make a summary
# irreproducible and a regression impossible to date. Pinning means
# behaviour changes only when this line does.
#
# Model ids go stale fast -- gemini-2.5-flash already 404s for new keys --
# so list models before changing this rather than trusting memory.
MODEL = os.getenv("SHOTIQ_SUMMARY_MODEL", "gemini-3.7-flash")

# Low, not zero. This is a factual task with one right reading of the
# numbers, and summaries are cached, so there is nothing to gain from
# variety and a great deal to lose from invention.
TEMPERATURE = 0.2

SUMMARY_FIELDS = ("headline", "strengths", "watch", "context")


class SummaryUnavailable(Exception):
    """No summary can be produced, and the caller should say so plainly.

    Raised directly when the model itself misbehaved -- empty response,
    prose instead of JSON, a missing field.
    """


class NothingToSummarise(SummaryUnavailable):
    """The data cannot support a summary, whatever the model does.

    A season with no recorded attempts. Nothing is wrong with the request
    or the service; there is simply nothing to say.
    """


class GenerationDisabled(SummaryUnavailable):
    """Generation is switched off or unconfigured, and nothing is cached.

    Deliberately not the same case as the two above: the request was fine
    and the data is fine, but this deployment is not permitted to spend
    quota. That distinction is what lets the route answer 503 here and
    422 for a genuinely empty season.

    These are named for what happened, not for a status code. summary.py
    does not know HTTP exists -- main.py maps them.
    """


SYSTEM_INSTRUCTION = """\
You are a basketball analyst writing a short note on one player's shooting \
in one season. You are given a JSON digest of his shot data. It is your \
only source.

Rules:

- Use only numbers that appear in the digest. Never estimate, infer, or \
recall a number that is not there.
- Use nothing you know about this player from outside the digest: no \
awards, teammates, injuries, team results, or career history. If it is not \
in the digest, it does not exist for this note.
- Any bucket marked "lowSample": true rests on fewer than minAttempts \
attempts. Never use one as evidence for anything. If it is worth \
mentioning at all, say plainly that the sample is too small to read.
- Weigh volume, not only accuracy. A rate on 5% of attempts is a footnote; \
the same rate on 40% of them is the story. "sharePct" is that share.
- Give rates as percentages to one decimal, like 57.3%. Give a gap against \
the league in percentage points, like "12.7 points above league average" \
-- never as a ratio, and never as a percentage of a percentage. "diffPt" \
is already that gap.
- "leagueFgPct" is the league on the same range, so it is a like-for-like \
comparison. Say so when you use it.
- Write plainly and specifically. No hype, no cliches, no addressing the \
reader, no closing flourish."""

# Field order here is generation order, and headline is LAST on purpose.
# Gemini fills the schema in the order given, so putting the headline first
# would make it commit to a thesis before examining any evidence and then
# bend the numbers to fit it. Generated last, it summarises analysis the
# model has already written. The UI reads by key, so display order is
# unaffected.
RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "strengths": {
            "type": "array",
            "minItems": 2,
            "maxItems": 3,
            "items": {
                "type": "string",
                "description": (
                    "One sentence. Name a specific range, situation or shot "
                    "type; cite the rate and either the attempt count or the "
                    "share of attempts; give the gap against the league where "
                    "the digest has one."
                ),
            },
        },
        "watch": {
            "type": "array",
            "minItems": 1,
            "maxItems": 2,
            "items": {
                "type": "string",
                "description": (
                    "One sentence naming a genuine weakness or risk visible "
                    "in the digest, with the numbers that show it. Do not "
                    "invent a concern to fill this out, and do not soften a "
                    "real one."
                ),
            },
        },
        "context": {
            "type": "string",
            "description": (
                "Two or three sentences on shot diet -- where the attempts "
                "come from, how contested, how early in the clock -- that "
                "frame the strengths and watch items."
            ),
        },
        "headline": {
            "type": "string",
            "description": (
                "One sentence, at most 18 words, naming the single most "
                "defining feature of this shooting season. Write it last, "
                "from what you have already said."
            ),
        },
    },
    "required": list(SUMMARY_FIELDS),
    "propertyOrdering": ["strengths", "watch", "context", "headline"],
}


def build_prompt(digest):
    """The user turn: the digest, and the instruction to use only it.

    Separated from the call so the tests can assert what the model is told
    without a client, and so the prompt can be printed and read.
    """
    return (
        f"Shooting digest for {digest.get('player')}, "
        f"{digest.get('season')} {digest.get('seasonType') or ''}".strip()
        + ":\n\n"
        + json.dumps(digest, indent=1, ensure_ascii=False)
        + "\n\nWrite the note. Every number you use must appear above."
    )


def digest_fingerprint(digest):
    """A short, stable hash of the digest the summary was written from.

    Stored alongside the cached summary so a stale one is detectable. If
    the underlying shot data is refetched and the numbers move, the
    fingerprint stops matching and the summary can be regenerated rather
    than quietly describing last week's data.
    """
    canonical = json.dumps(digest, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]


def _cache_path(player_id, season):
    return CACHE_DIR / f"summary-{player_id}-{season}.json"


def _read_cache(player_id, season):
    path = _cache_path(player_id, season)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _write_cache(player_id, season, payload):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _cache_path(player_id, season).write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
    )


def _build_client():
    """Construct the vendor client. Import is local so the module loads
    without the SDK installed, which keeps the rest of the API importable
    on a machine that has never configured a key."""
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise GenerationDisabled(
            "GEMINI_API_KEY is not set. Copy .env.example to .env and add a "
            "key from https://aistudio.google.com/apikey"
        )

    from google import genai

    return genai.Client(api_key=api_key)


def _parse(text):
    """Turn the model's response into the four fields, or fail loudly.

    responseSchema makes bare JSON overwhelmingly likely -- verified, no
    markdown fence -- but 'overwhelmingly likely' is not 'guaranteed', and a
    half-parsed summary must never reach the cache and become permanent.
    """
    if not text or not text.strip():
        raise SummaryUnavailable("The model returned an empty response")

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SummaryUnavailable(f"The model did not return JSON: {exc}") from exc

    missing = [field for field in SUMMARY_FIELDS if not parsed.get(field)]
    if missing:
        raise SummaryUnavailable(f"Summary is missing {', '.join(missing)}")

    return {field: parsed[field] for field in SUMMARY_FIELDS}


def generate(digest, client=None):
    """Ask the model for a summary of this digest. Makes a network call.

    The client is injectable so the tests can pass a stub: they assert the
    prompt, the schema and the parsing without ever reaching the network or
    needing a key.
    """
    if not analytics.has_enough_data(digest):
        raise NothingToSummarise(
            f"{digest.get('player') or 'This player'} has no recorded "
            f"attempts in {digest.get('season')}, so there is nothing to "
            f"summarise."
        )

    from google.genai import types

    client = client or _build_client()

    try:
        response = client.models.generate_content(
            model=MODEL,
            contents=build_prompt(digest),
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_INSTRUCTION,
                response_mime_type="application/json",
                response_schema=RESPONSE_SCHEMA,
                temperature=TEMPERATURE,
            ),
        )
    except SummaryUnavailable:
        raise
    except Exception as exc:
        # Anything the vendor SDK raises -- the model overloaded, a quota
        # exhausted, the network gone, a stale model id -- becomes our own
        # error type here.
        #
        # Found by the first real call, which hit "503 UNAVAILABLE: this
        # model is currently experiencing high demand". Without this the
        # SDK's exception sails past every handler in the route and the
        # client gets an opaque 500, when the honest answer is that the
        # upstream failed and trying again later may well work.
        raise SummaryUnavailable(
            f"The model could not be reached ({type(exc).__name__}: {exc}). "
            f"This is often temporary."
        ) from exc

    summary = _parse(response.text)
    summary["meta"] = {
        "model": MODEL,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "digest": digest_fingerprint(digest),
        "source": "live",
    }
    return summary


def load_summary(player_id, season, digest, refresh=False, client=None):
    """Serve a cached summary, or generate one if allowed to.

    Cache first, always. A summary of a completed season will never need to
    change, and the whole point of caching is that the committed one for
    the default subject makes the feature work with no key at all -- for a
    reviewer cloning this repo, and for the offline test suite.
    """
    if not refresh:
        cached = _read_cache(player_id, season)
        if cached is not None:
            cached.setdefault("meta", {})["source"] = "cache"
            # Not an error: the cached prose is still a fair description
            # unless the numbers moved a lot. Flagged rather than discarded,
            # so the UI can decide and quota is not spent automatically.
            if cached["meta"].get("digest") != digest_fingerprint(digest):
                cached["meta"]["stale"] = True
            return cached

    if not config.SUMMARY_LIVE:
        raise GenerationDisabled(
            "Live generation is disabled (SHOTIQ_SUMMARY_LIVE is not 'true'), "
            "and no summary is cached for this player and season."
        )

    summary = generate(digest, client=client)
    _write_cache(player_id, season, summary)
    return summary
