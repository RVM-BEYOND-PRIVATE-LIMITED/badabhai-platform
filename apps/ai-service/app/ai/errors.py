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

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .gemini_client import LlmResult

# --- Closed set of PII-free transport reason codes -------------------------
# A fixed enum -> provably PII-free. NEVER add a value derived from an exception
# body, a response payload, or any worker text.
REASON_NO_CANDIDATES = "no_candidates"
REASON_MAX_TOKENS_NO_PARTS = "max_tokens_no_parts"
#: The model hit MAX_TOKENS AFTER emitting some text (#1656). Distinct from the
#: no-parts case above: there IS content, it is simply unterminated, so nothing
#: downstream would have noticed except by failing to parse it.
REASON_MAX_TOKENS_TRUNCATED = "max_tokens_truncated"
REASON_HTTP_429 = "http_429"
REASON_HTTP_ERROR = "http_error"
REASON_NO_TEXT_CONTENT = "no_text_content"
REASON_MISSING_KEY = "missing_key"
REASON_SDK_ERROR = "sdk_error"
#: ADR-0054. A call that carries server tools (the web search) was dispatched to a provider
#: whose transport cannot run them. Raised BEFORE any network I/O: sending the request without
#: the tool would return an ungrounded answer that looks exactly like a grounded one.
REASON_TOOLS_UNSUPPORTED = "tools_unsupported"
#: ADR-0054. Anthropic paused a long server-tool turn (`stop_reason: "pause_turn"`). v1 does not
#: continue a paused turn, so the partial response is a failure, never an answer.
REASON_PAUSE_TURN = "pause_turn"
#: ADR-0054. The route's own per-attempt deadline (`TaskRoute.timeout_seconds`) expired. Raised
#: by the router, not a client, so a caller's wait is never outlived by the provider call.
REASON_TIMEOUT = "timeout"

TRANSPORT_REASON_CODES: frozenset[str] = frozenset(
    {
        REASON_NO_CANDIDATES,
        REASON_MAX_TOKENS_NO_PARTS,
        REASON_MAX_TOKENS_TRUNCATED,
        REASON_HTTP_429,
        REASON_HTTP_ERROR,
        REASON_NO_TEXT_CONTENT,
        REASON_MISSING_KEY,
        REASON_SDK_ERROR,
        REASON_TOOLS_UNSUPPORTED,
        REASON_PAUSE_TURN,
        REASON_TIMEOUT,
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

    TWO BILLING FACTS (ADR-0054 security review, H1), read by the router for calls that carry
    server tools and ignored for every other call:

    - ``request_sent`` — False ONLY when the failure was raised before any network I/O (a
      missing key, the SDK absent, tools on a provider that cannot run them). The default is
      True because "unknown" must be treated as "possibly billed".
    - ``billed`` — the measured usage (tokens, searches, cache buckets) when the provider DID
      return a response that was then refused (a paused or truncated turn, no text). Counts
      only: its ``content`` is always empty, so no model text rides an exception.
    """

    def __init__(
        self,
        reason_code: str,
        *,
        status_code: int | None = None,
        request_sent: bool = True,
        billed: LlmResult | None = None,
    ) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code
        self.status_code = status_code
        self.request_sent = request_sent
        self.billed = billed
