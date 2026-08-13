"""BL-19: the request-id/correlation-id middleware (app/main.py's request_id_tracing)
and the JsonFormatter fields it feeds (app/logging_config.py).

apps/api's AiService mints one id per outbound call and sends it as both
x-request-id and x-correlation-id (mirrors the existing x-ai-internal-token
pattern). This is the ai-service half: bind the id for the lifetime of the
request so every log line emitted while handling it carries the SAME value the
caller logged on a failure -- and echo it back so a caller can confirm what was
bound, without requiring a caller to send anything at all (a bare curl/future
client still gets a fresh id rather than an untagged request).
"""

from __future__ import annotations

import json
import logging

from fastapi.testclient import TestClient

from app.logging_config import JsonFormatter, correlation_id_var, request_id_var
from app.main import app

client = TestClient(app)


def test_echoes_back_the_caller_supplied_ids():
    res = client.get(
        "/health",
        headers={"x-request-id": "req-123", "x-correlation-id": "corr-456"},
    )
    assert res.status_code == 200
    assert res.headers["x-request-id"] == "req-123"
    assert res.headers["x-correlation-id"] == "corr-456"


def test_generates_ids_when_the_caller_sends_none():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.headers["x-request-id"]
    assert res.headers["x-correlation-id"]


def test_correlation_id_falls_back_to_request_id_when_only_one_is_sent():
    res = client.get("/health", headers={"x-request-id": "req-only"})
    assert res.status_code == 200
    assert res.headers["x-request-id"] == "req-only"
    assert res.headers["x-correlation-id"] == "req-only"


def test_two_requests_get_two_different_generated_ids():
    """No accidental reuse across requests -- each caller gets its own trace."""
    first = client.get("/health").headers["x-request-id"]
    second = client.get("/health").headers["x-request-id"]
    assert first != second


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
    req_token = request_id_var.set("req-abc")
    corr_token = correlation_id_var.set("corr-xyz")
    try:
        entry = json.loads(JsonFormatter().format(_record()))
    finally:
        request_id_var.reset(req_token)
        correlation_id_var.reset(corr_token)
    assert entry["request_id"] == "req-abc"
    assert entry["correlation_id"] == "corr-xyz"


def test_formatter_omits_the_fields_when_nothing_is_bound():
    """Outside a request (e.g. a boot-time log line), the fields don't appear at
    all rather than showing up as null noise on every line."""
    assert request_id_var.get() is None
    assert correlation_id_var.get() is None
    entry = json.loads(JsonFormatter().format(_record()))
    assert "request_id" not in entry
    assert "correlation_id" not in entry
