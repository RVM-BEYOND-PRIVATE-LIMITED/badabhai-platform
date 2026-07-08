"""PII-free transport errors for the LLM provider clients.

The provider clients (``gemini_client`` / ``anthropic_client``) raise a
:class:`LlmTransportError` carrying a ``reason_code`` drawn from a CLOSED set of
constants — NEVER a free-text exception body. That lets the router log WHY a
provider attempt failed while staying provably PII-free: a fixed enum cannot echo
pseudonymized content.

:class:`LlmTransportError` subclasses ``RuntimeError`` so the router's existing
``except RuntimeError`` / ``except Exception`` handling (and the anthropic
client's ``except RuntimeError: raise`` re-raise) keep working unchanged.

CONTRACT: the router logs ONLY ``reason_code`` (and the optional ``status_code``),
never the underlying exception string. Do NOT widen the reason-code set to carry
any text derived from an exception body or response payload.
"""

from __future__ import annotations

# --- Closed set of PII-free transport reason codes -------------------------
# A fixed enum -> provably PII-free. NEVER add a value derived from an exception
# body, a response payload, or any worker text.
REASON_NO_CANDIDATES = "no_candidates"
REASON_MAX_TOKENS_NO_PARTS = "max_tokens_no_parts"
REASON_HTTP_429 = "http_429"
REASON_HTTP_ERROR = "http_error"
REASON_NO_TEXT_CONTENT = "no_text_content"
REASON_MISSING_KEY = "missing_key"
REASON_SDK_ERROR = "sdk_error"

TRANSPORT_REASON_CODES: frozenset[str] = frozenset(
    {
        REASON_NO_CANDIDATES,
        REASON_MAX_TOKENS_NO_PARTS,
        REASON_HTTP_429,
        REASON_HTTP_ERROR,
        REASON_NO_TEXT_CONTENT,
        REASON_MISSING_KEY,
        REASON_SDK_ERROR,
    }
)


class LlmTransportError(RuntimeError):
    """A provider transport failure carrying a PII-free ``reason_code``.

    ``reason_code`` MUST be one of the closed-set constants in this module (a
    fixed enum -> provably PII-free). ``status_code`` is an optional HTTP status
    (e.g. 429). Subclasses ``RuntimeError`` so existing ``except RuntimeError`` /
    ``except Exception`` handlers keep catching it.

    The router logs only ``reason_code`` (and ``status_code``) — NEVER the
    exception body.
    """

    def __init__(self, reason_code: str, *, status_code: int | None = None) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code
        self.status_code = status_code
