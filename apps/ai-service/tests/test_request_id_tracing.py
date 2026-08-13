"""BL-19: the request-id/correlation-id middleware (app/main.py's request_id_tracing)
and the JsonFormatter fields it feeds (app/logging_config.py).

apps/api's AiService mints one id per outbound call and sends it as both
x-request-id and x-correlation-id (mirrors the existing x-ai-internal-token
pattern). This is the ai-service half: bind the id for the lifetime of the
request so every log line emitted while handling it carries the SAME value the
caller logged on a failure -- and echo it back so a caller can confirm what was
bound, without requiring a caller to send anything at all (a bare curl/future
client still gets a fresh id rather than an untagged request).

A caller-supplied id is logged VERBATIM into every line of a request it's bound
to, so it must be validated, not merely trusted -- these tests exist because the
first draft of this middleware accepted ANY string and would have let a caller
get PII logged by putting it in the header. Only a UUID-shaped value is honored;
anything else is silently replaced with a freshly generated one.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

import app.config as app_config
from app.config import Settings
from app.logging_config import JsonFormatter, correlation_id_var, request_id_var
from app.main import app

client = TestClient(app)

_A_UUID = "11111111-1111-1111-1111-111111111111"
_ANOTHER_UUID = "22222222-2222-2222-2222-222222222222"


def test_echoes_back_a_caller_supplied_uuid():
    res = client.get(
        "/health",
        headers={"x-request-id": _A_UUID, "x-correlation-id": _ANOTHER_UUID},
    )
    assert res.status_code == 200
    assert res.headers["x-request-id"] == _A_UUID
    assert res.headers["x-correlation-id"] == _ANOTHER_UUID


def test_generates_ids_when_the_caller_sends_none():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.headers["x-request-id"]
    assert res.headers["x-correlation-id"]


def test_correlation_id_falls_back_to_a_fresh_id_when_only_request_id_is_sent():
    res = client.get("/health", headers={"x-request-id": _A_UUID})
    assert res.status_code == 200
    assert res.headers["x-request-id"] == _A_UUID
    # NOT a copy of x-request-id -- each header is validated and generated
    # independently, so an absent correlation id gets its OWN fresh uuid.
    assert res.headers["x-correlation-id"] != _A_UUID


def test_two_requests_get_two_different_generated_ids():
    """No accidental reuse across requests -- each caller gets its own trace."""
    first = client.get("/health").headers["x-request-id"]
    second = client.get("/health").headers["x-request-id"]
    assert first != second


def test_a_non_uuid_request_id_is_rejected_and_replaced():
    """THE PRIVACY-CRITICAL CASE. A caller-supplied id is logged verbatim into
    every line for this request -- free text must never be honored, or a caller
    could get a name/phone/address logged by putting it in the header."""
    res = client.get("/health", headers={"x-request-id": "Ramesh Kumar, phone 9876543210"})
    assert res.status_code == 200
    assert res.headers["x-request-id"] != "Ramesh Kumar, phone 9876543210"
    # Still gets a real, usable trace id -- rejection means "regenerate", not "drop".
    assert res.headers["x-request-id"]


def test_a_non_uuid_correlation_id_is_rejected_and_replaced():
    res = client.get("/health", headers={"x-correlation-id": "not-a-uuid-at-all"})
    assert res.status_code == 200
    assert res.headers["x-correlation-id"] != "not-a-uuid-at-all"
    assert res.headers["x-correlation-id"]


def test_an_oversized_request_id_is_rejected():
    """No length-only bound (128 chars, apps/api's TS-side pattern) is safe here --
    plenty of PII fits in far less. Only exact UUID shape is honored."""
    huge = "a" * 5000
    res = client.get("/health", headers={"x-request-id": huge})
    assert res.status_code == 200
    assert res.headers["x-request-id"] != huge
    assert len(res.headers["x-request-id"]) < 100


def test_a_uuid_with_a_trailing_newline_is_rejected():
    """THE FULLMATCH-VS-MATCH CASE. Python's `$` in a `match()`-style check is
    satisfied at end-of-string OR immediately before a single trailing "\\n" --
    so "<uuid>\\n" would pass a naive `^...$` + .match() check and get written,
    newline and all, straight into a response header. fullmatch() has no such
    exception: the entire string must be exactly the 36-char shape."""
    from app.main import _safe_trace_id

    tampered = f"{_A_UUID}\n"
    result = _safe_trace_id(tampered)
    assert result != tampered
    assert result == _A_UUID or "\n" not in result


def _record(msg: str = "test message") -> logging.LogRecord:
    return logging.LogRecord(
        name="ai-service",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=msg,
        args=(),
        exc_info=None,
    )


def test_formatter_includes_the_bound_ids_in_every_log_line():
    """The mechanism that makes a failing call's log line traceable: while the
    contextvars are bound (as they are for the duration of one request, per the
    middleware above), EVERY log record -- not just one hand-picked line --
    carries the same request_id/correlation_id the caller sent."""
    req_token = request_id_var.set(_A_UUID)
    corr_token = correlation_id_var.set(_ANOTHER_UUID)
    try:
        entry = json.loads(JsonFormatter().format(_record()))
    finally:
        request_id_var.reset(req_token)
        correlation_id_var.reset(corr_token)
    assert entry["request_id"] == _A_UUID
    assert entry["correlation_id"] == _ANOTHER_UUID


def test_formatter_omits_the_fields_when_nothing_is_bound():
    """Outside a request (e.g. a boot-time log line), the fields don't appear at
    all rather than showing up as null noise on every line."""
    assert request_id_var.get() is None
    assert correlation_id_var.get() is None
    entry = json.loads(JsonFormatter().format(_record()))
    assert "request_id" not in entry
    assert "correlation_id" not in entry


def test_the_bound_trace_id_always_wins_over_a_colliding_extra_field():
    """THE BUG THIS PINS. privacy.py used to log an unrelated per-call body id
    under the key "request_id" -- identical to the middleware-bound trace id's
    key -- so `entry.update(extra)` silently overwrote the trace id with it,
    and the log line disagreed with the response header on which id was live.
    Now the bound trace id is reasserted AFTER extra, so it always wins no
    matter what a caller's extra dict happens to contain."""
    req_token = request_id_var.set(_A_UUID)
    try:
        record = _record()
        record.extra = {"request_id": "something-unrelated-a-caller-sent"}
        entry = json.loads(JsonFormatter().format(record))
    finally:
        request_id_var.reset(req_token)
    assert entry["request_id"] == _A_UUID


def test_pseudonymize_endpoint_no_longer_collides_on_request_id():
    """Integration-level proof for the same bug: /pseudonymize's own per-call
    body id now logs under body_request_id, not request_id -- the response
    header and the log line agree on the one true trace id."""
    res = client.post(
        "/pseudonymize",
        json={"text": "hello", "request_id": "client-supplied-body-id"},
        headers={"x-request-id": _A_UUID},
    )
    assert res.status_code == 200
    assert res.headers["x-request-id"] == _A_UUID


_TOKEN = "test-service-token-0123456789abcdef"


@pytest.fixture
def auth_enabled() -> Iterator[None]:
    """Point the module-global settings at a token-bearing Settings, restore after.
    Mirrors test_service_auth.py's own fixture exactly."""
    prior = app_config._settings
    app_config._settings = Settings(ai_internal_token=_TOKEN)
    try:
        yield
    finally:
        app_config._settings = prior


def test_a_401_from_service_auth_still_gets_trace_headers(auth_enabled):
    """THE MIDDLEWARE-ORDERING CASE. request_id_tracing must be the OUTERMOST
    middleware (registered after service_auth) so a request service_auth rejects
    still gets tagged -- otherwise the TD67-mismatch failure apps/api's AiService
    already logs a request id for (ai.service.ts's 401 branch) has no matching id
    on this side at all, the exact class of gap BL-19 exists to close."""
    res = client.post("/pseudonymize", json={"text": "x"})  # no bearer -> 401
    assert res.status_code == 401
    assert res.headers.get("x-request-id")
    assert res.headers.get("x-correlation-id")
