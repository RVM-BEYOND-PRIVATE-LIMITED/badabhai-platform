"""Fetch, extract, mask, call, gate. The RI-autofill mapping pipeline, with no FastAPI in it.

SEPARATE FROM THE PARSE AND SUMMARY PIPELINES ON PURPOSE. `resume_parse.py` reads
citable VALUES and `resume_summary.py` reads one Hinglish line; this answers one
question per pack item: which of THESE closed option ids does the document support.
Three contracts, three prompts, three gates, three consumers — sharing a pipeline
would let one instruction loosen another.

Its order is the same security argument:

    fetch → extract → mask → call → contract → gate → assemble

Nothing reaches the model before `mask`, and nothing reaches the response before
`gate`.

OWNER OVERRIDE B (2026-09-20) OF RULING D2 APPLIES TO THE CONSUMER, NOT TO THIS
PIPELINE. The API writes returned ids as answers on the identity "haan" without
per-fact confirmation — but every gate below stays as strict as the parse's. The
override widens what may be DONE with a mapping, never what counts AS one.

DEGRADES, NEVER FAILS (ruling D9). Every branch below returns a valid
`ResumeOptionMapOutput` carrying a `failure_reason` from the closed vocabulary.
The worst case is that the import stages no mappings and the Haan hands over to
an unfilled form — today's behaviour byte for byte.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any

from ..ai.router import AIRouter
from ..config import Settings
from ..contracts import (
    AICallMetadata,
    ResumeOptionMapInput,
    ResumeOptionMapOutput,
    ResumeOptionMapping,
    TranscriptLine,
)
from ..logging_config import get_logger
from ..profiling import parse_gates
from ..profiling.canonical_roles import coerce_json_text
from ..storage import download_object
from .extract import ExtractionResult, extract
from .option_map_prompt import build_resume_option_map_messages, empty_resume_option_map
from .parse_policy import input_masker, mask_resume_lines, resume_value_certifier

logger = get_logger("ai-service.resume_option_map")

RESUME_OPTION_MAP_TASK_TYPE = "resume_option_map"

#: The closed note vocabulary. Same discipline as `RESUME_PARSE_NOTES` in
#: `resume_parse.py`: a note is counted on an event, so an open string here
#: would be a free-text channel from a model into analytics.
RESUME_OPTION_MAP_NOTES = frozenset(
    {
        "mock_no_mappings",
        "llm_unavailable",
        "lines_dropped_by_masker",
        "mappings_rejected",
        "raw_text_policy_active",
        "extraction_truncated",
    }
)


@dataclass
class _Stage:
    """What the pipeline has learned so far. Counts and codes only — never document text."""

    notes: list[str] = field(default_factory=list)
    extraction: ExtractionResult | None = None
    meta: AICallMetadata | None = None


def _response(
    stage: _Stage,
    *,
    mappings: list[ResumeOptionMapping] | None = None,
    failure_reason: str | None = None,
) -> ResumeOptionMapOutput:
    """Assemble the response.

    `notes` is filtered to the closed set as the last act before the response
    leaves, so a code added carelessly upstream is dropped rather than published.
    """
    return ResumeOptionMapOutput(
        mappings=mappings or [],
        notes=[note for note in dict.fromkeys(stage.notes) if note in RESUME_OPTION_MAP_NOTES],
        failure_reason=failure_reason,
        ai_metadata=stage.meta,
    )


async def map_resume_options(
    body: ResumeOptionMapInput,
    *,
    settings: Settings,
    router: AIRouter,
    system_prompt: str | None = None,
    prompt: Any = None,
) -> ResumeOptionMapOutput:
    """One uploaded résumé → gated option mappings. Never raises."""
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
        logger.warning("resume_option_map.fetch_failed", extra={"extra": {"error": str(exc)}})
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

    if not body.questions:
        # Nothing was asked, so there is nothing to cite and no reason to spend a call.
        return _response(stage)

    # ---- 3. MASK ------------------------------------------------------------
    # ADR-0041 D5 lives in exactly this line — the same posture as the parse and the
    # summary: the input policy may be raw behind a flag, but the OUTPUT wall below
    # never is.
    raw_text_enabled = settings.resume_parse_raw_text_enabled
    masked = mask_resume_lines(extraction.lines, input_masker(raw_text_enabled=raw_text_enabled))
    if raw_text_enabled:
        stage.notes.append("raw_text_policy_active")
    if masked.dropped:
        stage.notes.append("lines_dropped_by_masker")
        logger.warning(
            "resume_option_map.lines_dropped", extra={"extra": {"lines": masked.dropped}}
        )
    if not masked.lines:
        return _response(stage, failure_reason="empty_document")

    # ---- 4. CALL, under a hard deadline -------------------------------------
    # `router.run` never raises but can take the provider timeout times the retry chain.
    fallback = empty_resume_option_map().model_dump_json()
    try:
        content, meta = await asyncio.wait_for(
            router.run(
                RESUME_OPTION_MAP_TASK_TYPE,
                messages=build_resume_option_map_messages(
                    masked,
                    body.questions,
                    None,
                    body.language,
                    system_prompt=system_prompt,
                ),
                mock_response=fallback,
                # Same posture as the parse and summary: the masker DROPS an un-maskable
                # line and keeps the rest, so there is no blocked state left to derive.
                real_call_allowed=True,
                user_ref=body.worker_ref,
                prompt=prompt,
            ),
            timeout=settings.resume_parse_deadline_seconds,
        )
    except TimeoutError:
        logger.warning(
            "resume_option_map.deadline_exceeded",
            extra={"extra": {"deadline_s": settings.resume_parse_deadline_seconds}},
        )
        return _response(stage, failure_reason="parse_deadline_exceeded")

    stage.meta = meta
    if not meta.real_call:
        stage.notes.append("mock_no_mappings")
    elif not meta.success:
        stage.notes.append("llm_unavailable")

    # ---- 5. CONTRACT --------------------------------------------------------
    draft = _read_option_map_output(content)
    if draft is None:
        return _response(stage, failure_reason="parse_output_invalid")

    # ---- 6. GATE ------------------------------------------------------------
    # FOUR CHECKS PER MAPPING, each fail-to-drop (never repair):
    #   1. QUESTION MEMBERSHIP — `question_key` must name an asked question.
    #   2. OPTION MEMBERSHIP — every id must be one of THAT question's options, verbatim.
    #   3. CARDINALITY — single_select takes at most one id.
    #   4. PROVENANCE + PII — the span must literally appear on the cited line, and the
    #      quote must pass the hard-identifier wall (blocked OR altered is refused).
    transcript = [
        TranscriptLine(i=line.index, role="worker", text=line.text) for line in masked.lines
    ]
    by_key = {q.question_key: q for q in body.questions}
    kept: list[ResumeOptionMapping] = []
    seen_keys: set[str] = set()
    rejected = 0
    for mapping in draft.mappings:
        if mapping.question_key in seen_keys:
            rejected += 1
            continue
        question = by_key.get(mapping.question_key)
        if question is None:
            rejected += 1
            continue
        allowed = {o.option_key for o in question.options}
        if not mapping.option_keys or any(k not in allowed for k in mapping.option_keys):
            rejected += 1
            continue
        if question.answer_type == "single_select" and len(mapping.option_keys) > 1:
            rejected += 1
            continue
        if parse_gates.check_provenance(mapping.evidence, transcript) is not None:
            rejected += 1
            continue
        if parse_gates.check_role(mapping.evidence, transcript) is not None:
            rejected += 1
            continue
        if _quote_carries_identifier(mapping.evidence.quote):
            rejected += 1
            continue
        seen_keys.add(mapping.question_key)
        kept.append(mapping)
    if rejected:
        stage.notes.append("mappings_rejected")
        logger.info(
            "resume_option_map.mappings_rejected", extra={"extra": {"rejected": rejected}}
        )

    return _response(stage, mappings=kept)


def _quote_carries_identifier(text: str) -> bool:
    """Gate 6 for one cited span, blocked-or-altered — the same test `check_pii` applies."""
    blocked, certified = resume_value_certifier(text)
    return blocked or certified != text


def _read_option_map_output(content: str) -> ResumeOptionMapOutput | None:
    """The model's response as a contract object, or None if it is not one.

    Never raises and never repairs. A body this service cannot validate is a body it has
    no way to gate, and the fail-closed reading of an ungateable overlay is "there was no
    overlay".
    """
    try:
        raw = json.loads(coerce_json_text(content))
    except Exception as exc:  # noqa: BLE001 — a malformed overlay never costs the import
        logger.warning(
            "resume_option_map.output_unreadable", extra={"extra": {"error": type(exc).__name__}}
        )
        return None
    try:
        return ResumeOptionMapOutput.model_validate(raw)
    except Exception as exc:  # noqa: BLE001 — a malformed overlay never costs the import
        logger.warning(
            "resume_option_map.output_unreadable", extra={"extra": {"error": type(exc).__name__}}
        )
        return None
