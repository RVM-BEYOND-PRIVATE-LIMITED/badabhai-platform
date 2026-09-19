"""Fetch, extract, mask, call, gate. The RI-summary pipeline, with no FastAPI in it.

SEPARATE FROM THE PARSE PIPELINE ON PURPOSE. `resume_parse.py` reads citable
VALUES under six gates; this reads the same document for one worker-facing
Hinglish line: {Job Role} + {total experience} + {short summary}. The two have
different contracts, different prompts, different gates, and different consumers
— sharing a pipeline would let a presentation instruction loosen a citation one.

Its order is the same security argument:

    fetch → extract → mask → call → contract → gate → assemble

Nothing reaches the model before `mask`, and nothing reaches the response before
`gate`.

DEGRADES, NEVER FAILS (ruling D9). Every branch below returns a valid
`ResumeSummaryOutput` carrying a `failure_reason` from the closed vocabulary.
There is no path that costs a worker their onboarding — the worst case is that
the import contributes no summary line and they answer the ordinary Hinglish
questions. Backend-only in this slice: the caller logs the Langfuse trace and
shows nothing in chat yet.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any

from ..ai.router import AIRouter
from ..config import Settings
from ..contracts import AICallMetadata, ResumeSummaryInput, ResumeSummaryOutput
from ..logging_config import get_logger
from ..profiling.canonical_roles import coerce_json_text
from ..storage import download_object
from .extract import ExtractionResult, extract
from .parse_policy import input_masker, mask_resume_lines, resume_value_certifier
from .summary_prompt import build_resume_summary_messages, empty_resume_summary

logger = get_logger("ai-service.resume_summary")

RESUME_SUMMARY_TASK_TYPE = "resume_profile_summary"

#: The closed note vocabulary. Same discipline as `RESUME_PARSE_NOTES` in
#: `resume_parse.py`: a note is counted on an event, so an open string here
#: would be a free-text channel from a model into analytics.
RESUME_SUMMARY_NOTES = frozenset(
    {
        "mock_no_summary",
        "llm_unavailable",
        "lines_dropped_by_masker",
        "fields_rejected",
        "raw_text_policy_active",
        "extraction_truncated",
    }
)

#: Contract bounds, mirrored from `app/contracts.py` so the gate can degrade to
#: null BEFORE validation rather than failing the whole output after it.
_MAX_EXPERIENCE_CHARS = 120
_MAX_SUMMARY_CHARS = 500


@dataclass
class _Stage:
    """What the pipeline has learned so far. Counts and codes only — never document text."""

    notes: list[str] = field(default_factory=list)
    extraction: ExtractionResult | None = None
    meta: AICallMetadata | None = None


def _response(
    stage: _Stage,
    *,
    role_kind: str | None = None,
    experience_text: str | None = None,
    summary_text: str | None = None,
    failure_reason: str | None = None,
) -> ResumeSummaryOutput:
    """Assemble the response.

    `notes` is filtered to the closed set as the last act before the response
    leaves, so a code added carelessly upstream is dropped rather than published.
    """
    return ResumeSummaryOutput(
        role_kind=role_kind,
        experience_text=experience_text,
        summary_text=summary_text,
        notes=[note for note in dict.fromkeys(stage.notes) if note in RESUME_SUMMARY_NOTES],
        failure_reason=failure_reason,
        ai_metadata=stage.meta,
    )


async def summarize_resume(
    body: ResumeSummaryInput,
    *,
    settings: Settings,
    router: AIRouter,
    system_prompt: str | None = None,
    prompt: Any = None,
) -> ResumeSummaryOutput:
    """One uploaded résumé → one gated Hinglish line. Never raises."""
    stage = _Stage()

    # ---- 1. FETCH -----------------------------------------------------------
    # Dormant while the bucket is unset, and dormancy is checked HERE rather than at the
    # route so the reason is one code instead of an HTTP status the caller has to map.
    try:
        data = await download_object(
            settings,
            body.storage_key,
            bucket=settings.resume_uploads_bucket,
            what="resume",
            bucket_var="RESUME_UPLOADS_BUCKET",
        )
    except RuntimeError as exc:
        # The message is PII-free BY CONSTRUCTION (app/storage.py never puts the key, the
        # bytes or a response body in it), which is the only reason it may be logged.
        logger.warning("resume_summary.fetch_failed", extra={"extra": {"error": str(exc)}})
        return _response(stage, failure_reason="parse_unavailable")

    # ---- 2. EXTRACT ---------------------------------------------------------
    # Deterministic, offline, no model. `extract` never raises.
    extraction = extract(data, mime=body.mime)
    stage.extraction = extraction
    if extraction.truncated:
        stage.notes.append("extraction_truncated")
    if extraction.degraded_reason is not None:
        return _response(stage, failure_reason=extraction.degraded_reason)
    if not extraction.lines:
        return _response(stage, failure_reason="empty_document")

    # ---- 3. MASK ------------------------------------------------------------
    # ADR-0041 D5 lives in exactly this line — the same posture as the parse:
    # the input policy may be raw behind a flag, but the OUTPUT wall below never is.
    raw_text_enabled = settings.resume_parse_raw_text_enabled
    masked = mask_resume_lines(extraction.lines, input_masker(raw_text_enabled=raw_text_enabled))
    if raw_text_enabled:
        stage.notes.append("raw_text_policy_active")
    if masked.dropped:
        stage.notes.append("lines_dropped_by_masker")
        logger.warning(
            "resume_summary.lines_dropped", extra={"extra": {"lines": masked.dropped}}
        )
    if not masked.lines:
        return _response(stage, failure_reason="empty_document")

    # ---- 4. CALL, under a hard deadline -------------------------------------
    # `router.run` never raises but can take the provider timeout times the retry chain.
    fallback = empty_resume_summary().model_dump_json()
    try:
        content, meta = await asyncio.wait_for(
            router.run(
                RESUME_SUMMARY_TASK_TYPE,
                messages=build_resume_summary_messages(
                    masked,
                    body.role_kinds,
                    body.language,
                    system_prompt=system_prompt,
                ),
                mock_response=fallback,
                # Same posture as the parse: the masker DROPS an un-maskable line and
                # keeps the rest, so there is no blocked state left to derive from.
                # What authorises the call is the policy chosen at step 3.
                real_call_allowed=True,
                user_ref=body.worker_ref,
                prompt=prompt,
            ),
            timeout=settings.resume_parse_deadline_seconds,
        )
    except TimeoutError:
        logger.warning(
            "resume_summary.deadline_exceeded",
            extra={"extra": {"deadline_s": settings.resume_parse_deadline_seconds}},
        )
        return _response(stage, failure_reason="parse_deadline_exceeded")

    stage.meta = meta
    if not meta.real_call:
        stage.notes.append("mock_no_summary")
    elif not meta.success:
        stage.notes.append("llm_unavailable")

    # ---- 5. CONTRACT --------------------------------------------------------
    draft = _read_summary_output(content)
    if draft is None:
        return _response(stage, failure_reason="parse_output_invalid")

    # ---- 6. GATE ------------------------------------------------------------
    # THREE CHECKS, each fail-to-null (never repair):
    #   1. MEMBERSHIP — `role_kind` must name a supplied kind, exactly.
    #   2. BOUNDS — over-long strings are dropped, not truncated (a truncation
    #      could cut a word and read as a different claim).
    #   3. PII — blocked OR altered by `resume_value_certifier` is refused whole.
    role_kind = _narrow_role_kind(draft.role_kind, body.role_kinds)
    experience_text = _gate_hinglish(draft.experience_text, _MAX_EXPERIENCE_CHARS)
    summary_text = _gate_hinglish(draft.summary_text, _MAX_SUMMARY_CHARS)
    if (
        (draft.role_kind is not None and role_kind is None)
        or (draft.experience_text is not None and experience_text is None)
        or (draft.summary_text is not None and summary_text is None)
    ):
        stage.notes.append("fields_rejected")
        logger.info("resume_summary.fields_rejected", extra={"extra": {"rejected": 1}})

    return _response(
        stage,
        role_kind=role_kind,
        experience_text=experience_text,
        summary_text=summary_text,
    )


def _narrow_role_kind(raw: object, allowed: list[str]) -> str | None:
    """The model's classification, kept only when it names a supplied kind.

    LENIENT SHAPE, STRICT MEMBERSHIP — the same posture as `_narrow_trade_kind`
    in `resume_parse.py`: a model that mangles its shape costs the classification,
    never the call. Membership is exact (whitespace stripped, nothing else
    repaired): a model that cannot echo one id from a list it was given is not
    classifying, and "helping" it would turn the closed list into a suggestion.
    """
    if not isinstance(raw, str):
        return None
    cleaned = raw.strip()
    return cleaned if cleaned in allowed else None


def _gate_hinglish(raw: object, max_chars: int) -> str | None:
    """One Hinglish string through bounds + the hard-identifier wall, or null.

    NON-STRING, BLANK, OVER-LONG, or carrying an identifier (blocked OR altered
    by the certifier) is refused whole — never repaired, never truncated. Repair
    would mean writing a line nobody can point at in the document.
    """
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text or len(text) > max_chars:
        return None
    blocked, certified = resume_value_certifier(text)
    if blocked or certified != text:
        return None
    return text


def _read_summary_output(content: str) -> ResumeSummaryOutput | None:
    """The model's response as a contract object, or None if it is not one.

    Never raises and never repairs. A body this service cannot validate is a body it has
    no way to gate, and the fail-closed reading of an ungateable overlay is "there was no
    overlay".
    """
    try:
        raw = json.loads(coerce_json_text(content))
    except Exception as exc:  # noqa: BLE001 — a malformed overlay never costs the import
        logger.warning(
            "resume_summary.output_unreadable", extra={"extra": {"error": type(exc).__name__}}
        )
        return None
    try:
        return ResumeSummaryOutput.model_validate(raw)
    except Exception as exc:  # noqa: BLE001 — a malformed overlay never costs the import
        logger.warning(
            "resume_summary.output_unreadable", extra={"extra": {"error": type(exc).__name__}}
        )
        return None


def gate_summary_for_test(
    role_kind: str | None,
    experience_text: str | None,
    summary_text: str | None,
    allowed: list[str],
) -> tuple[str | None, str | None, str | None]:
    """The gate as a pure function, for tests that should not build a pipeline.

    Kept beside the pipeline rather than in a test file so the rule has one home.
    """
    _transcript_check(allowed)
    return (
        _narrow_role_kind(role_kind, allowed),
        _gate_hinglish(experience_text, _MAX_EXPERIENCE_CHARS),
        _gate_hinglish(summary_text, _MAX_SUMMARY_CHARS),
    )


def _transcript_check(allowed: list[str]) -> None:
    # A no-op guard that keeps the test helper honest about its own input: an empty
    # allowlist means every non-null role degrades, which is the correct behaviour
    # (no kinds supplied ⇒ no classification possible), not a test bug.
    if not isinstance(allowed, list):
        raise TypeError("allowed role kinds must be a list")


def check_summary_provenance_for_test() -> None:
    """Placeholder for the provenance rule the parse carries and this call omits.

    THE SUMMARY HAS NO CITATIONS BY DESIGN — it is presentation, not evidence — so
    gate 1 (provenance) has nothing to check. Stated here so a reader comparing the
    two pipelines does not read the absence as an oversight: the PII wall above is
    what bounds this output, and it runs on every string.
    """
    return None
