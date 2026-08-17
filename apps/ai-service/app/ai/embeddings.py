"""Skill-alias embedding generation (ADR-0030 / TAX-3) — the OFFLINE corpus embed.

Embeds skill_alias TEXT (aliases, not labels) into a vector(768) so TAX-4/TAX-6 can
nearest-neighbour against it. This is the offline corpus embed, NOT the request-path
worker/job embed (that is TAX-4/TAX-6).

INVARIANTS (ADR-0030):
- **SG-2**: every text is pseudonymized (fail-closed) BEFORE the embed call — even though
  skill phrases are PII-light, a residual employer name must never egress to the provider
  unmasked. A blocked phrase is skipped, never embedded.
- **SG-4**: the REAL provider call requires ``AI_ENABLE_REAL_CALLS`` + a key (staging-first,
  allowlisted per-task). The DEFAULT is a deterministic MOCK embedding, so the pipeline +
  TAX-4 tests run with ZERO spend.
- **SG-3**: these embeddings feed CANONICALIZATION (nearest-neighbour id assignment), NEVER
  ranking (ADR-0030 invariant-#4 boundary).
- Dimension **768** matches ``skill_alias.embedding`` (Vertex text-multilingual-embedding-002
  / the configured Gemini embedding model — confirm at the staging real run, §7).

The batch embed itself is a db-side runner in ``packages/db`` (``embed-skill-aliases.ts``,
the live ``/embeddings/skill-alias`` endpoint) rather than an in-process ai-service batch —
this module stays DB-free by design and exposes only the per-text primitives below.
"""

from __future__ import annotations

import hashlib
import math
import random
import struct
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass

import httpx

from ..config import Settings
from ..logging_config import get_logger
from ..pseudonymize import pseudonymize
from . import cost_tracker
from .langfuse_tracing import EMBED_TEXT, get_tracer

logger = get_logger("ai.embeddings")

# Dimension of the stored vector — MUST equal skill_alias.embedding vector(768).
EMBEDDING_DIMENSION = 768
# Task-type key for the per-task real-call allowlist (config.ai_real_call_tasks).
EMBEDDING_TASK_TYPE = "skill_embedding"
# Label recorded on mock rows (never a real spend).
MOCK_MODEL = "mock-embedding"

_GEMINI_EMBED_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
_TIMEOUT_SECONDS = 30.0

# Texts per ``batchEmbedContents`` call — the DEFAULT for settings.ai_embed_request_batch.
#
# THIS IS A QUOTA FIX, not a latency tweak, and it addresses the per-DAY request
# quota (`EmbedContentRequestsPerDayPerProjectPerModel`, 1000/day on the free tier):
# at one request per alias the 9121-row corpus needs 9121 requests and stalled a real
# run at 998 rows. At 100 texts per request the same corpus is ~92 requests. The
# per-text price is identical either way.
#
# IT IS NOT THE CONTROL FOR THROTTLING, and Phase 6 measurement says so directly.
# Across 201 real Langfuse observations the batch SIZE does not separate success from
# failure: a 100-text request succeeded (3594 ms) while a 50-text one failed, and the
# failures line up instead with how many texts had been sent in the preceding minute.
# See _TextRateLimiter for the constraint that does bind.
EMBED_REQUEST_BATCH = 100
# A 100-text batch does ~100x the work of a single embed, so it gets its own
# ceiling; _TIMEOUT_SECONDS is sized for one text and would trip on a full batch.
_BATCH_TIMEOUT_SECONDS = 300.0
# Rolling window the per-minute text quota is measured over.
_RATE_WINDOW_SECONDS = 60.0


def embed_request_batch(settings: Settings) -> int:
    """Texts per provider request, clamped to something a single HTTP call can carry."""
    return max(1, min(250, int(settings.ai_embed_request_batch)))


class ProviderEmbedError(RuntimeError):
    """A provider embed call failed, carrying the HTTP status when there was one.

    Drives two decisions, and they are deliberately different questions.

    ``isolatable`` — can splitting the batch rescue the rest of it? True for a 4xx
    other than 429 (malformed content, too-long input), which is plausibly caused by
    ONE text; the alternative is letting one bad alias discard the 99 good embeds
    beside it. False for 429/5xx/transport, which hit every text equally, so splitting
    would multiply requests against a provider already refusing them.

    ``retryable`` — is re-sending the SAME request safe and likely to help? True when
    the provider demonstrably did no work: a 429 (refused), a 5xx (failed server-side,
    and embeddings are not billed on error), or a connect failure (never sent). It is
    deliberately FALSE for a read timeout: the request WAS sent and the response is
    unknown, so a retry can pay for the same texts twice. That case is opt-in via
    ``ai_embed_retry_on_read_timeout`` rather than a default, because "no duplicate
    billing from uncontrolled retries" outranks recovering a rare hung request.
    """

    def __init__(self, message: str, *, status: int | None = None, retryable: bool = False,
                 retry_after: float | None = None) -> None:
        super().__init__(message)
        self.status = status
        self._retryable = retryable
        self.retry_after = retry_after

    @property
    def isolatable(self) -> bool:
        return self.status is not None and 400 <= self.status < 500 and self.status != 429

    @property
    def retryable(self) -> bool:
        if self.status is not None:
            return self.status == 429 or self.status >= 500
        return self._retryable

    @property
    def rate_limited(self) -> bool:
        return self.status == 429


class _TextRateLimiter:
    """A rolling-window budget on TEXTS SENT, shared process-wide.

    ---------------------------------------------------------------------------
    WHY TEXTS, AND WHY A SHARED BUCKET
    ---------------------------------------------------------------------------
    The provider counts each content inside a ``batchEmbedContents`` against the
    per-minute embed quota, so the meter runs on texts, not on HTTP calls. Phase 6
    measured this on our own traces: the largest 60-second window whose requests all
    succeeded carried 148 texts, and every failure sits where the preceding minute was
    already full. Pacing the requests is therefore the control; the batch size only
    decides how quickly the budget is spent, and (separately) how many requests the
    per-DAY quota sees.

    The quota is per PROJECT, so the bucket is a module singleton rather than
    per-request state — two concurrent runner batches share one provider allowance,
    and a per-request limiter would let them each stay "under" it while together going
    over.

    ---------------------------------------------------------------------------
    A REFUSED REQUEST STILL COSTS QUOTA
    ---------------------------------------------------------------------------
    ``charge`` is called for attempts that FAILED as well as ones that succeeded. This
    is the finding that makes naive retrying actively harmful: in the Phase 5 traces a
    50-text request was rejected at +211s when only 55 texts had SUCCEEDED in the prior
    minute — but 194 texts had been attempted and refused in that same window. Retrying
    into a window the failed attempts have already exhausted spends more quota to
    produce more failures.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._events: deque[tuple[float, int]] = deque()

    def _prune(self, now: float) -> None:
        while self._events and now - self._events[0][0] >= _RATE_WINDOW_SECONDS:
            self._events.popleft()

    def charge(self, texts: int, now: float | None = None) -> None:
        """Record texts sent to the provider, successfully or not."""
        with self._lock:
            t = time.monotonic() if now is None else now
            self._prune(t)
            self._events.append((t, texts))

    def delay_for(self, texts: int, limit: int, now: float | None = None) -> float:
        """Seconds to wait before `texts` more may be sent. 0 when there is room."""
        if limit <= 0:
            return 0.0
        with self._lock:
            t = time.monotonic() if now is None else now
            self._prune(t)
            used = sum(n for _, n in self._events)
            if used + texts <= limit:
                return 0.0
            # Wait for enough of the oldest entries to age out that this request fits.
            # A single request larger than the whole limit can never fit; it is released
            # once the window is empty rather than deadlocking, and the provider's own
            # 429 remains the backstop for that misconfiguration.
            need = used + texts - limit
            freed = 0
            for ts, n in self._events:
                freed += n
                if freed >= need:
                    return max(0.0, _RATE_WINDOW_SECONDS - (t - ts))
            # Draining the ENTIRE window still would not make room, i.e. this single
            # request is larger than the whole per-minute limit. Waiting cannot help, so
            # release it once the window is clear rather than blocking forever; with the
            # window already empty there is nothing to wait for at all. The provider's
            # own 429 stays the backstop for that misconfiguration.
            if not self._events:
                return 0.0
            return max(0.0, _RATE_WINDOW_SECONDS - (t - self._events[0][0]))

    def reset(self) -> None:
        with self._lock:
            self._events.clear()


# Process-wide: the quota being modelled belongs to the provider project, not to a request.
_rate_limiter = _TextRateLimiter()


def get_rate_limiter() -> _TextRateLimiter:
    """The shared limiter. Exposed so tests can reset it between cases."""
    return _rate_limiter


def _parse_retry_after(value: str | None) -> float | None:
    """`Retry-After` in delta-seconds form. A malformed header is ignored, not fatal."""
    if not value:
        return None
    try:
        seconds = float(value.strip())
    except ValueError:
        return None
    return seconds if seconds >= 0 else None


def _backoff_delay(attempt: int, exc: ProviderEmbedError, settings: Settings) -> float:
    """How long to wait before retry `attempt` (1-based), bounded and jittered.

    A 429 is treated differently from a 5xx on purpose. Exponential backoff from a
    couple of seconds retries INSIDE the same rate window, where the budget is already
    spent and the failed attempt has spent more of it — so a rate-limit refusal waits
    out the window instead (the provider's own ``Retry-After`` when it sends one,
    otherwise a configured cooldown). Jitter is full-range on the exponential path so
    that several runners recovering from one provider blip do not resynchronise into a
    thundering herd.
    """
    if exc.rate_limited:
        base = exc.retry_after if exc.retry_after is not None else float(
            settings.ai_embed_rate_limit_cooldown_seconds
        )
    else:
        base = float(settings.ai_embed_backoff_base_seconds) * (2 ** (attempt - 1))
        base = random.uniform(base / 2.0, base)  # noqa: S311 - jitter, not cryptography
    return max(0.0, min(base, float(settings.ai_embed_backoff_max_seconds)))


@dataclass
class EmbeddingResult:
    """One embed outcome. ``vector`` is None iff the text was blocked (fail-closed) —
    the caller SKIPS that row, leaving its embedding NULL for a later re-run.

    ``text`` is the PSEUDONYMIZED (safe) text that was actually embedded — the single
    place SG-2's output surfaces, so a caller (TAX-4 unresolved_phrase, cost accounting)
    reuses it WITHOUT re-pseudonymizing. It is None when blocked: a blocked phrase's
    ``pseudonymize().text`` still holds the residual PII that TRIGGERED the block, so it
    must never be handed back (fail-closed for the record path too)."""

    vector: list[float] | None
    blocked: bool
    is_mock: bool
    model: str
    text: str | None = None


def _mock_embedding(text: str) -> list[float]:
    """Deterministic hash -> 768-vector in [-1, 1). Same text -> same vector, so the
    seed is idempotent and TAX-4 tests run offline with zero spend. NOT semantically
    meaningful — a stand-in until the real provider is wired (§7)."""
    out: list[float] = []
    counter = 0
    while len(out) < EMBEDDING_DIMENSION:
        digest = hashlib.sha256(f"{text}:{counter}".encode()).digest()
        for i in range(0, len(digest), 4):
            (n,) = struct.unpack(">I", digest[i : i + 4])
            out.append((n / 2**32) * 2.0 - 1.0)
        counter += 1
    return out[:EMBEDDING_DIMENSION]


def _real_embedding(text: str, settings: Settings) -> list[float]:
    """Call the configured real embedding provider (Gemini ``embedContent``). Reached
    ONLY when SG-4 is satisfied. VERIFIED LIVE 2026-07-14 (first gated run):
    ``gemini-embedding-001`` + ``outputDimensionality: 768`` → HTTP 200, 768 dims
    (``text-embedding-004`` is retired — the provider 404s it). Truncated-dimension
    embeddings come back UNNORMALIZED, so we L2-normalize before storing: cosine ops are
    scale-invariant either way, but stored vectors stay comparable if anything ever uses
    an inner product. Never logs the text (pseudonymized, but still content)."""
    api_key = settings.gemini_flash_api_key
    if not api_key:
        raise RuntimeError("skill_embedding: real call enabled but GEMINI_FLASH_API_KEY unset")
    model = settings.embedding_model
    url = f"{_GEMINI_EMBED_BASE}/{model}:embedContent"
    body = {
        "model": f"models/{model}",
        "content": {"parts": [{"text": text}]},
        # Pin the house dimension — without this the model returns its native width
        # (3072 for gemini-embedding-001) and the dim check below rejects it.
        "outputDimensionality": EMBEDDING_DIMENSION,
    }
    headers = {"x-goog-api-key": api_key}  # header, never a ?key= (avoids URL-log leak)
    with httpx.Client(timeout=_TIMEOUT_SECONDS) as client:
        resp = client.post(url, headers=headers, json=body)
    if resp.status_code < 200 or resp.status_code >= 300:
        raise RuntimeError(f"skill_embedding provider HTTP {resp.status_code}")
    values = (resp.json().get("embedding") or {}).get("values") or []
    if len(values) != EMBEDDING_DIMENSION:
        raise RuntimeError(
            f"skill_embedding dim mismatch: got {len(values)}, expected {EMBEDDING_DIMENSION}"
        )
    vector = [float(v) for v in values]
    norm = math.sqrt(sum(v * v for v in vector))
    if norm <= 0.0:
        raise RuntimeError("skill_embedding: zero-norm vector from provider")
    return [v / norm for v in vector]


def _real_embedding_batch(texts: list[str], settings: Settings) -> list[list[float]]:
    """Embed many ALREADY-PSEUDONYMIZED texts in ONE provider request.

    The batch twin of :func:`_real_embedding` — same model, same pinned
    ``outputDimensionality``, same client-side L2 normalization, same
    never-log-the-text rule. The ONLY difference is that N texts ride one HTTP
    request instead of N, which is what keeps the corpus embed inside the
    provider's per-day REQUEST quota (see ``EMBED_REQUEST_BATCH``).

    Takes safe text and does NOT pseudonymize: SG-2 already ran in
    :func:`embed_texts`, which is the only caller. Keeping the gateway in one
    place means there is no second code path that could embed a raw phrase.

    Order is load-bearing — the provider returns embeddings positionally, so the
    count is checked before anything is mapped back to an alias id. A short or
    reordered response raises rather than silently pairing a vector with the
    wrong row, which at rest is indistinguishable from a correct embedding.
    """
    api_key = settings.gemini_flash_api_key
    if not api_key:
        raise RuntimeError("skill_embedding: real call enabled but GEMINI_FLASH_API_KEY unset")
    model = settings.embedding_model
    url = f"{_GEMINI_EMBED_BASE}/{model}:batchEmbedContents"
    body = {
        "requests": [
            {
                "model": f"models/{model}",
                "content": {"parts": [{"text": text}]},
                "outputDimensionality": EMBEDDING_DIMENSION,
            }
            for text in texts
        ]
    }
    headers = {"x-goog-api-key": api_key}  # header, never a ?key= (avoids URL-log leak)
    try:
        with httpx.Client(timeout=_BATCH_TIMEOUT_SECONDS) as client:
            resp = client.post(url, headers=headers, json=body)
    except httpx.ConnectError as exc:
        # Never reached the provider, so nothing was embedded and nothing was billed.
        raise ProviderEmbedError(f"skill_embedding transport: {type(exc).__name__}", retryable=True) from exc
    except httpx.TimeoutException as exc:
        # The request WAS sent and the outcome is unknown. Retrying can pay twice for
        # the same texts, so this is retryable only when explicitly opted into.
        raise ProviderEmbedError(
            f"skill_embedding timeout: {type(exc).__name__}",
            retryable=bool(settings.ai_embed_retry_on_read_timeout),
        ) from exc
    except httpx.HTTPError as exc:
        raise ProviderEmbedError(f"skill_embedding transport: {type(exc).__name__}") from exc
    if resp.status_code < 200 or resp.status_code >= 300:
        raise ProviderEmbedError(
            f"skill_embedding provider HTTP {resp.status_code}",
            status=resp.status_code,
            retry_after=_parse_retry_after(resp.headers.get("retry-after")),
        )
    embeddings = resp.json().get("embeddings") or []
    if len(embeddings) != len(texts):
        raise RuntimeError(
            f"skill_embedding batch size mismatch: got {len(embeddings)}, sent {len(texts)}"
        )
    vectors: list[list[float]] = []
    for entry in embeddings:
        values = (entry or {}).get("values") or []
        if len(values) != EMBEDDING_DIMENSION:
            raise RuntimeError(
                f"skill_embedding dim mismatch: got {len(values)}, expected {EMBEDDING_DIMENSION}"
            )
        vector = [float(v) for v in values]
        norm = math.sqrt(sum(v * v for v in vector))
        if norm <= 0.0:
            raise RuntimeError("skill_embedding: zero-norm vector from provider")
        vectors.append([v / norm for v in vector])
    return vectors


@dataclass
class _AttemptOutcome:
    """What the paced/retrying wrapper did, for the trace and the log."""

    vectors: list[list[float]] | None
    attempts: int
    waited_seconds: float
    rate_limited: bool
    error: Exception | None


def _embed_batch_paced(
    safe_texts: list[str],
    settings: Settings,
    sleep: Callable[[float], None] | None = None,
) -> _AttemptOutcome:
    """One provider batch, PACED against the per-minute text budget and retried a bounded
    number of times.

    THE FOUR REQUIREMENTS THIS EXISTS TO SATISFY, and where each one lives:

    - *No retry storm.* Attempts are capped by ``ai_embed_max_retries`` (a total, not a
      per-error budget) and only ``retryable`` failures are retried at all. An isolatable
      4xx is raised straight back so the caller can bisect it, which is a different and
      cheaper recovery than re-sending.
    - *Bounded exponential backoff.* ``_backoff_delay`` clamps to
      ``ai_embed_backoff_max_seconds`` and jitters the exponential path; a 429 waits out
      the rate window instead of doubling from two seconds inside it.
    - *No duplicate billing.* Only failures where the provider demonstrably did no work
      are retried. A read timeout is excluded by default — see ProviderEmbedError.
    - *Resumability.* Exhausting the retries returns ``vectors=None`` rather than raising
      past the caller, so those slots stay None, the rows stay NULL, and the next run
      picks them up. Nothing here can turn a transient failure into a lost alias.

    The pacing wait is itself bounded: the db-side runner holds an HTTP request open for
    at most ten minutes, so a limiter configured tighter than the batch size could hang
    the caller until it times out and lose the whole batch. Past
    ``ai_embed_max_pacing_wait_seconds`` this gives up cleanly instead, which costs a
    resumable retry rather than a client timeout.
    """
    # Resolved at CALL time, not bound as a default: a default argument captures
    # time.sleep at import, which would make the waits unpatchable and every retry test
    # spend its backoff in real seconds.
    nap = time.sleep if sleep is None else sleep
    limit = int(settings.ai_embed_texts_per_minute)
    max_retries = max(0, int(settings.ai_embed_max_retries))
    limiter = get_rate_limiter()
    waited = 0.0
    rate_limited = False
    last_error: Exception | None = None
    attempts_made = 0

    for attempt in range(1, max_retries + 2):
        # ── pace BEFORE sending: stay under the budget rather than discover it ──
        if limit > 0:
            delay = limiter.delay_for(len(safe_texts), limit)
            if delay > 0:
                if waited + delay > float(settings.ai_embed_max_pacing_wait_seconds):
                    last_error = ProviderEmbedError(
                        "skill_embedding: pacing wait would exceed the per-request ceiling"
                    )
                    break
                logger.info(
                    "embed_texts: pacing for the per-minute text budget",
                    extra={"extra": {"texts": len(safe_texts), "wait_seconds": round(delay, 2),
                                     "limit_per_minute": limit}},
                )
                nap(delay)
                waited += delay
        try:
            # Charge BEFORE the call. The provider counts the attempt whatever its
            # outcome, so crediting only successes would let a run of 429s look free to
            # the limiter and keep it sending into an exhausted window.
            limiter.charge(len(safe_texts))
            attempts_made = attempt
            vectors = _real_embedding_batch(safe_texts, settings)
            return _AttemptOutcome(vectors, attempt, waited, rate_limited, None)
        except ProviderEmbedError as exc:
            last_error = exc
            if exc.isolatable:
                raise  # the caller bisects; re-sending the same batch would just refail
            if not exc.retryable or attempt > max_retries:
                break
            rate_limited = rate_limited or exc.rate_limited
            delay = _backoff_delay(attempt, exc, settings)
            logger.warning(
                "embed_texts: provider refused a batch; backing off",
                extra={"extra": {"texts": len(safe_texts), "attempt": attempt,
                                 "status": exc.status, "backoff_seconds": round(delay, 2)}},
            )
            nap(delay)
            waited += delay
        except Exception as exc:  # noqa: BLE001 - classified by the caller, never retried
            last_error = exc
            break

    return _AttemptOutcome(None, attempts_made, waited, rate_limited, last_error)


def embed_texts(texts: list[str], settings: Settings) -> list[EmbeddingResult | None]:
    """Pseudonymize-then-embed a whole batch, preserving input order.

    The OFFLINE-CORPUS counterpart to :func:`embed_text`, which stays the single-text
    request path (canonicalization, domain match) and is deliberately untouched.

    Same SG-2/SG-4 contract: every text is pseudonymized FIRST, a blocked text is
    never sent to the provider, and the real provider still requires the master flag
    + key + the ``skill_embedding`` allowlist. Mock mode delegates to ``embed_text``
    per text so the deterministic hash vectors stay byte-identical to the
    single-text path — a batch run and a per-row run must not produce different
    vectors for the same alias.

    THREE OUTCOMES PER SLOT, and the caller must keep them apart:
      - ``EmbeddingResult`` with a vector — embedded.
      - ``EmbeddingResult`` with ``blocked=True`` — fail-closed; the row stays NULL
        and is reported for a human. Never retried blindly.
      - ``None`` — the PROVIDER call failed for that slot. The row stays NULL and is
        picked up by the next resumable run. Distinct from blocked on purpose:
        reporting a transient provider error as ``blocked`` would send a clean alias
        to a human for inspection and drop it from this run's fetch window.

    A failed batch fails only its own chunk — the chunks around it still land, and
    the locally-computed blocked verdicts survive, because pseudonymization happens
    before any network call.
    """
    if not texts:
        return []

    # Mock: no network, no batching to do — reuse the single-text path verbatim.
    if not settings.real_call_enabled_for(EMBEDDING_TASK_TYPE):
        return [embed_text(text, settings) for text in texts]

    tracer = get_tracer()
    model = settings.embedding_model
    results: list[EmbeddingResult | None] = [None] * len(texts)
    # (index, safe_text) for everything that cleared the gateway. Index carried
    # explicitly so blocked slots can't shift the mapping of the rest.
    pending: list[tuple[int, str]] = []

    for i, text in enumerate(texts):
        # SG-2: pseudonymize FIRST — a blocked phrase is never sent to the provider.
        result = pseudonymize(text)
        if result.blocked:
            # As in embed_text: the raw phrase is the thing we may not record, so the
            # observation carries the REFUSAL and nothing else.
            with tracer.observation(name=EMBED_TEXT, as_type="embedding", model=MOCK_MODEL) as obs:
                obs.update(level="WARNING", status_message="pseudonymization_blocked")
            results[i] = EmbeddingResult(
                vector=None, blocked=True, is_mock=True, model=MOCK_MODEL, text=None
            )
            continue
        pending.append((i, result.text))

    # LIFO work stack rather than a flat loop, so a chunk that fails on ONE bad text
    # can be split and its halves retried immediately (see ProviderEmbedError.
    # isolatable). Worst case for a single poison text is ~2*log2(batch) extra
    # requests instead of losing the whole chunk; a transient failure never splits,
    # so the request-quota cost of the common path is unchanged.
    request_batch = embed_request_batch(settings)
    stack: list[list[tuple[int, str]]] = [
        pending[start : start + request_batch] for start in range(0, len(pending), request_batch)
    ]
    stack.reverse()  # keep corpus order on the happy path (pop() takes from the end)

    while stack:
        chunk = stack.pop()
        safe_texts = [safe for _, safe in chunk]
        with tracer.observation(
            name=EMBED_TEXT, as_type="embedding", input={"texts": len(safe_texts)}, model=model
        ) as obs:
            try:
                outcome = _embed_batch_paced(safe_texts, settings)
            except ProviderEmbedError as exc:
                # Isolatable 4xx: probably ONE bad text. _embed_batch_paced re-raises
                # these rather than retrying, because re-sending an identical malformed
                # batch just spends quota to fail again. Split so the good ones still
                # land; the bad one converges to a single-item call that fails alone.
                obs.update(level="WARNING", status_message=f"provider_failed: {type(exc).__name__}")
                if len(chunk) > 1:
                    mid = len(chunk) // 2
                    stack.append(chunk[mid:])
                    stack.append(chunk[:mid])
                    continue
                logger.warning(
                    "embed_texts: provider rejected a single text; row left unembedded",
                    extra={"extra": {"texts": 1, "status": exc.status}},
                )
                continue
            if outcome.vectors is None:
                exc = outcome.error
                # Whole-chunk failure that survived the retry policy (429 / 5xx /
                # transport). Leave these slots as None so the rows stay NULL for the
                # next resumable run, and keep going — one bad chunk must not discard
                # the batches that already succeeded. Never logs the text.
                obs.update(
                    level="WARNING",
                    status_message=f"provider_failed: {type(exc).__name__ if exc else 'unknown'}",
                    # The retry story travels WITH the failure. "Provider failed" alone
                    # cannot tell an operator whether the policy gave up early or fought
                    # for ninety seconds first, which is the difference between a
                    # misconfiguration and a genuinely unavailable provider.
                    metadata={
                        "attempts": outcome.attempts,
                        "waited_seconds": round(outcome.waited_seconds, 2),
                        "rate_limited": outcome.rate_limited,
                        "status": getattr(exc, "status", None),
                    },
                )
                logger.warning(
                    "embed_texts: provider batch failed; rows left unembedded for a later run",
                    extra={"extra": {
                        "texts": len(safe_texts),
                        "error": type(exc).__name__ if exc else "unknown",
                        "attempts": outcome.attempts,
                        "waited_seconds": round(outcome.waited_seconds, 2),
                        "rate_limited": outcome.rate_limited,
                    }},
                )
                continue
            vectors = outcome.vectors
            obs.update(
                # NOT the vectors: 768 floats x100 would dwarf every other payload.
                output={"texts": len(vectors), "dimensions": EMBEDDING_DIMENSION, "is_mock": False},
                usage_details={"input": sum(cost_tracker.estimate_tokens(t) for t in safe_texts)},
                # Throttling stays visible even when the batch eventually SUCCEEDED. A
                # run that only got through because it waited 60s per request is healthy
                # by every count and is telling you the limit is wrong; recording it only
                # on failure would hide exactly that.
                metadata={
                    "tokens_estimated": True,
                    "batched": True,
                    "attempts": outcome.attempts,
                    "waited_seconds": round(outcome.waited_seconds, 2),
                    "rate_limited": outcome.rate_limited,
                },
            )
        # strict=True: a length mismatch here would pair a vector with the WRONG
        # alias, which is undetectable at rest. _real_embedding_batch already
        # checks the count; this makes truncation impossible rather than unlikely.
        for (i, safe), vector in zip(chunk, vectors, strict=True):
            results[i] = EmbeddingResult(
                vector=vector, blocked=False, is_mock=False, model=model, text=safe
            )

    return results


def embed_text(text: str, settings: Settings) -> EmbeddingResult:
    """Pseudonymize (fail-closed) THEN embed. Mock by default; real only under SG-4.

    TRACED as an ``embedding`` observation, not a plain span: only the generation-family
    types carry model, tokens and cost, and this is the one AI call in the service that
    is made in a LOOP (one per skill label), so a canonicalization pass that quietly
    became the expensive half of an extraction is otherwise invisible.

    It nests under whatever task is active — the extraction's own trace when the
    canonicalization pass runs inline, the batch's trace when the runner drives it.
    ``asyncio.to_thread`` (how the extract path calls this) copies the context, so the
    nesting survives the hop off the event loop.
    """
    tracer = get_tracer()
    # SG-2: pseudonymize FIRST — a blocked phrase is never sent to the provider.
    result = pseudonymize(text)
    if result.blocked:
        # The raw phrase is by definition the thing we may not record, so the
        # observation carries the REFUSAL and nothing else. A silent skip here used to
        # be invisible outside the batch counters.
        with tracer.observation(name=EMBED_TEXT, as_type="embedding", model=MOCK_MODEL) as obs:
            obs.update(level="WARNING", status_message="pseudonymization_blocked")
        return EmbeddingResult(vector=None, blocked=True, is_mock=True, model=MOCK_MODEL, text=None)

    # ``result.text`` is the masked text — the ONLY thing the embedder ever sees, and the
    # safe text the caller reuses (never the raw ``text``). It is therefore also the only
    # thing that may be traced.
    safe = result.text
    is_mock = not settings.real_call_enabled_for(EMBEDDING_TASK_TYPE)
    model = MOCK_MODEL if is_mock else settings.embedding_model
    with tracer.observation(name=EMBED_TEXT, as_type="embedding", input=safe, model=model) as obs:
        vector = _mock_embedding(safe) if is_mock else _real_embedding(safe, settings)
        obs.update(
            # NOT the vector: 768 floats are unreadable in a trace and would dwarf every
            # other payload in the batch. Its shape is the part worth keeping.
            output={"dimensions": len(vector), "is_mock": is_mock},
            # ESTIMATED, and labelled as such — the embeddings API reports no token
            # counts, so this is the same estimate the spend ledger budgets against.
            usage_details={"input": cost_tracker.estimate_tokens(safe)},
            metadata={"tokens_estimated": True, "replaced_entities": result.replaced_entities},
        )
    return EmbeddingResult(vector=vector, blocked=False, is_mock=is_mock, model=model, text=safe)

