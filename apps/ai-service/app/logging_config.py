"""Minimal JSON structured logging for the AI service."""

from __future__ import annotations

import json
import logging
import sys
from contextvars import ContextVar
from datetime import UTC, datetime

# BL-19: set by the request-id middleware (main.py) for the lifetime of one request,
# so every log line emitted while handling it -- not just one line at the top --
# carries the SAME id the caller (apps/api's AiService) logged on its own side of a
# failed call. This is the root cause fix for "why did this ai-service call fail":
# before this, only an untagged log line existed on this side.
request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
correlation_id_var: ContextVar[str | None] = ContextVar("correlation_id", default=None)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "level": record.levelname.lower(),
            "time": datetime.now(UTC).isoformat(),
            "service": "ai-service",
            "logger": record.name,
            "message": record.getMessage(),
        }
        # Attach any structured extras passed via logger.info(..., extra={"extra": {...}})
        extra = getattr(record, "extra", None)
        if isinstance(extra, dict):
            entry.update(extra)
        # BL-19: bound AFTER extra, and deliberately so -- these are the one trace id this
        # log line must always report correctly, so a caller's own extra dict can never
        # silently clobber them (it happened once: privacy.py used to log an unrelated
        # per-call body id under this exact key before it was renamed to body_request_id).
        request_id = request_id_var.get()
        if request_id is not None:
            entry["request_id"] = request_id
        correlation_id = correlation_id_var.get()
        if correlation_id is not None:
            entry["correlation_id"] = correlation_id
        return json.dumps(entry)


def configure_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)


def get_logger(name: str = "ai-service") -> logging.Logger:
    return logging.getLogger(name)
