"""Normalized AI error CATEGORIES for observability.

WHY THIS EXISTS. The router already produces two closed sets of PII-free codes — the
per-attempt transport ``reason_code`` (``ai/errors.py``) and the terminal ``error_code``
on :class:`AICallMetadata` — and both are exactly right for a log line, where the reader
wants the specific diagnosis. They are the WRONG grain for a dashboard: "how often does a
provider rate-limit us?" has to know that ``http_429`` and a cooldown skip are the same
story, and "is anything actually broken?" has to know that ``kill_switch_engaged`` is not.

So this module adds a COARSER axis alongside the specific one; it never replaces it. Both
travel on the observation — ``status_message`` keeps the precise code, metadata carries the
category — because collapsing the specific code into the category would throw away the only
thing that tells an operator what to do next.

CONTRACT, inherited from ``ai/errors.py`` and non-negotiable:
- Input is a closed-set code or an exception CLASS NAME. Never an exception body, never a
  response payload, never worker text.
- Output is one of :data:`CATEGORIES`. A code this module does not recognise maps to
  ``"unknown"`` — it never falls back to echoing its input, which is how a free-text
  exception message would otherwise reach a trace attribute.

Pure functions, no I/O, no logging. Safe to call from anywhere including the mask path.
"""

from __future__ import annotations

from .errors import (
    REASON_HTTP_429,
    REASON_HTTP_ERROR,
    REASON_MAX_TOKENS_NO_PARTS,
    REASON_MISSING_KEY,
    REASON_NO_CANDIDATES,
    REASON_NO_TEXT_CONTENT,
    REASON_SDK_ERROR,
)

# --- The closed category set ------------------------------------------------
# Deliberately small. Every extra category is a dashboard filter someone has to
# understand, and a category with one member is just the code it came from.
TIMEOUT = "timeout"
RATE_LIMIT = "rate_limit"
PROVIDER_ERROR = "provider_error"
INVALID_OUTPUT = "invalid_output"
OUTPUT_TRUNCATED = "output_truncated"
VALIDATION_FAILURE = "validation_failure"
AUTHENTICATION_ERROR = "authentication_error"
NETWORK_ERROR = "network_error"
BUDGET_BLOCKED = "budget_blocked"
CONFIG_ERROR = "config_error"
DISABLED_BY_POSTURE = "disabled_by_posture"
UNKNOWN = "unknown"

CATEGORIES: frozenset[str] = frozenset(
    {
        TIMEOUT,
        RATE_LIMIT,
        PROVIDER_ERROR,
        INVALID_OUTPUT,
        OUTPUT_TRUNCATED,
        VALIDATION_FAILURE,
        AUTHENTICATION_ERROR,
        NETWORK_ERROR,
        BUDGET_BLOCKED,
        CONFIG_ERROR,
        DISABLED_BY_POSTURE,
        UNKNOWN,
    }
)


# --- Per-attempt transport failures ----------------------------------------
# Keyed by the closed-set reason codes the provider clients raise.
_TRANSPORT: dict[str, str] = {
    REASON_HTTP_429: RATE_LIMIT,
    REASON_HTTP_ERROR: PROVIDER_ERROR,
    REASON_SDK_ERROR: PROVIDER_ERROR,
    # The model answered, but with nothing usable in it. Distinct from a transport
    # failure: retrying reaches the same provider successfully and gets the same
    # non-answer, which is why the router refuses to retry the truncation case.
    REASON_NO_CANDIDATES: INVALID_OUTPUT,
    REASON_NO_TEXT_CONTENT: INVALID_OUTPUT,
    REASON_MAX_TOKENS_NO_PARTS: OUTPUT_TRUNCATED,
    # A missing credential is a deployment mistake, not a provider incident. It is
    # the one transport reason that will NEVER clear on a retry or a fallback.
    REASON_MISSING_KEY: AUTHENTICATION_ERROR,
}

# Exception CLASS NAMES, for the untyped failures the router reduces to `type(exc).__name__`.
# Class names only — see the module contract. Kept short: anything not listed is
# genuinely unknown, and pretending otherwise makes the category lie.
_EXCEPTION_CLASSES: dict[str, str] = {
    # asyncio.TimeoutError is an alias of the builtin on >= 3.11; both names appear
    # depending on which layer raised.
    "TimeoutError": TIMEOUT,
    "ReadTimeout": TIMEOUT,
    "WriteTimeout": TIMEOUT,
    "PoolTimeout": TIMEOUT,
    "ConnectTimeout": TIMEOUT,
    "ConnectError": NETWORK_ERROR,
    "NetworkError": NETWORK_ERROR,
    "RemoteProtocolError": NETWORK_ERROR,
    "ReadError": NETWORK_ERROR,
    "JSONDecodeError": INVALID_OUTPUT,
    "ValidationError": VALIDATION_FAILURE,
}


def categorize_transport(reason: str | None) -> str:
    """Category for ONE provider attempt that failed.

    ``reason`` is either a transport ``reason_code`` or, for an untyped failure, the
    exception's class name — exactly the two things the router already puts in its log
    line, so this adds no new information flow and therefore no new PII surface.
    """
    if not reason:
        return UNKNOWN
    return _TRANSPORT.get(reason) or _EXCEPTION_CLASSES.get(reason, UNKNOWN)


# --- Terminal router outcomes ----------------------------------------------
# The closed set of `AICallMetadata.error_code` values `_dispatch` can produce.
# Grouped by WHAT AN OPERATOR WOULD DO, which is the only useful axis here:
#   budget_blocked      -> we chose not to spend; raise a cap or accept the mock
#   disabled_by_posture -> we chose not to call; flip a flag if that is wrong
#   config_error        -> something is misconfigured and no call can succeed
#   rate_limit          -> the provider is pushing back; it clears on its own
_TERMINAL: dict[str, str] = {
    "llm_call_failed": PROVIDER_ERROR,
    "retry_budget_exhausted": PROVIDER_ERROR,
    "daily_cap_exceeded": BUDGET_BLOCKED,
    "cumulative_cap_exceeded": BUDGET_BLOCKED,
    "user_daily_cap_exceeded": BUDGET_BLOCKED,
    "cost_ceiling_exceeded": BUDGET_BLOCKED,
    # NOT a cap. The ledger could not be reached, so the spend is unverifiable and the
    # call is refused fail-closed — a config/infra problem wearing a budget costume.
    # `_SPEND_BLOCK_LOG_MESSAGES` in the router exists because conflating these two
    # already cost this project a debugging round; the category keeps them apart.
    "spend_store_unavailable": CONFIG_ERROR,
    "provider_cooldown": RATE_LIMIT,
    "kill_switch_engaged": DISABLED_BY_POSTURE,
    # Authored by apps/api, not the router, but it lands in the same field.
    "extract_service_unreachable": NETWORK_ERROR,
    "parse_service_unreachable": NETWORK_ERROR,
    "stt_service_unreachable": NETWORK_ERROR,
}


def categorize_terminal(error_code: str | None) -> str | None:
    """Category for the router's TERMINAL outcome, or ``None`` when there was no error.

    ``None`` in, ``None`` out — deliberately not ``"unknown"``. A successful call has no
    error category, and giving it one would put every healthy call into a dashboard slice
    named after a failure.
    """
    if not error_code:
        return None
    return _TERMINAL.get(error_code, UNKNOWN)
