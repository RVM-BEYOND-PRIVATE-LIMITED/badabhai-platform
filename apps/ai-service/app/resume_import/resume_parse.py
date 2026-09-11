"""Fetch, extract, mask, call, gate. The RI-3 pipeline, with no FastAPI in it.

SEPARATE FROM THE ROUTER ON PURPOSE. The route is HTTP and tracing; this is the decision
sequence, and it is the sequence a security review has to be able to read top to bottom
without a framework in the way. Its order is the security argument:

    fetch → extract → mask → call → contract → gate → assemble

Nothing reaches the model before `mask`, and nothing reaches the response before `gate`.

WHY THE SERVICE FETCHES ITS OWN DOCUMENT. apps/api could download the object and post the
text, and then the résumé's full contents would pass through the API process, its logs and
its error paths — for no gain, since the extraction libraries live here. This way the
document's text exists in exactly one process and leaves it only as gated values AND their
gated spans.

THAT LAST CLAUSE WAS MISSING AND THE SENTENCE WAS FALSE. `apply_parse_gates` certifies a
field's VALUE; the `evidence.quote` beside it rode out uncertified, and with the raw-text
flag on a quote is verbatim résumé text. A security review found it; `_carries_identifier`
below is the fix. Stated here rather than only at the fix, because this docstring is what a
reader trusts when deciding whether they need to look.

DEGRADES, NEVER FAILS (ruling D9). Every branch below returns a valid `ResumeParseOutput`
carrying a `failure_reason` from the closed vocabulary. There is no path that costs a
worker their onboarding — the worst case is that the import contributes nothing and they
answer the ordinary Hinglish questions.
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
    ParsedField,
    ProfileParseOutput,
    ResumeEmployment,
    ResumeParseInput,
    ResumeParseOutput,
    TargetField,
    TranscriptLine,
)
from ..logging_config import get_logger
from ..profiling import parse_gates
from ..profiling.canonical_roles import coerce_json_text
from ..storage import download_object
from .extract import ExtractionResult, extract
from .parse_policy import input_masker, mask_resume_lines, resume_value_certifier
from .parse_prompt import build_resume_parse_messages, empty_resume_parse

logger = get_logger("ai-service.resume_import")

RESUME_PARSE_TASK_TYPE = "resume_parse"

#: The closed note vocabulary. Mirrors `PARSE_NOTES` in `routers/profile.py` in discipline
#: rather than in content: a note is counted on an event, so an open string here would be a
#: free-text channel from a model into analytics.
RESUME_PARSE_NOTES = frozenset(
    {
        "mock_no_parse",
        "llm_unavailable",
        "lines_dropped_by_masker",
        "fields_rejected",
        "employments_rejected",
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
    target_fields: list[TargetField],
    *,
    fields: dict[str, ParsedField] | None = None,
    employments: list[ResumeEmployment] | None = None,
    failure_reason: str | None = None,
) -> ResumeParseOutput:
    """Assemble the response.

    `unparsed_field_ids` is computed HERE, from what actually survived the gates — never
    taken from the model, which has every incentive to claim it read more than it cited.
    `notes` is filtered to the closed set as the last act before the response leaves, so a
    code added carelessly upstream is dropped rather than published.
    """
    accepted = fields or {}
    extraction = stage.extraction
    return ResumeParseOutput(
        fields=dict(accepted),
        employments=employments or [],
        unparsed_field_ids=[t.field_id for t in target_fields if t.field_id not in accepted],
        notes=[note for note in dict.fromkeys(stage.notes) if note in RESUME_PARSE_NOTES],
        extraction_method=extraction.method if extraction else None,
        page_count=extraction.page_count if extraction else None,
        ocr_confidence=extraction.ocr_confidence if extraction else None,
        line_count=len(extraction.lines) if extraction else 0,
        failure_reason=failure_reason,
        ai_metadata=stage.meta,
    )


async def parse_resume(
    body: ResumeParseInput,
    *,
    settings: Settings,
    router: AIRouter,
    system_prompt: str | None = None,
    prompt: Any = None,
) -> ResumeParseOutput:
    """One uploaded résumé → gated, cited values. Never raises."""
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
        logger.warning("resume_import.fetch_failed", extra={"extra": {"error": str(exc)}})
        return _response(stage, body.target_fields, failure_reason="parse_unavailable")

    # ---- 2. EXTRACT ---------------------------------------------------------
    # Deterministic, offline, no model. `extract` never raises.
    extraction = extract(data, mime=body.mime)
    stage.extraction = extraction
    if extraction.truncated:
        stage.notes.append("extraction_truncated")
    if extraction.degraded_reason is not None:
        return _response(stage, body.target_fields, failure_reason=extraction.degraded_reason)
    if not extraction.lines:
        return _response(stage, body.target_fields, failure_reason="empty_document")

    if not body.target_fields:
        # Nothing was requested, so there is nothing to cite and no reason to spend a call.
        # Still a success: the extraction facts are real and the caller wanted them.
        return _response(stage, body.target_fields)

    # ---- 3. MASK ------------------------------------------------------------
    # ADR-0041 D5 lives in exactly this line. See `parse_policy` for the argument, and
    # note that the certifier used at step 6 is NOT derived from this policy.
    raw_text_enabled = settings.resume_parse_raw_text_enabled
    masked = mask_resume_lines(extraction.lines, input_masker(raw_text_enabled=raw_text_enabled))
    if raw_text_enabled:
        # A NOTE, NOT A LOG LINE WITH THE TEXT IN IT. Which posture produced a given import
        # is the first question any later review of this feature will ask, and it must be
        # answerable from the record rather than from someone's memory of the deploy.
        stage.notes.append("raw_text_policy_active")
    if masked.dropped:
        stage.notes.append("lines_dropped_by_masker")
        logger.warning(
            "resume_import.lines_dropped", extra={"extra": {"lines": masked.dropped}}
        )
    if not masked.lines:
        return _response(stage, body.target_fields, failure_reason="empty_document")

    # ---- 4. CALL, under a hard deadline -------------------------------------
    # `router.run` never raises but can take the provider timeout times the retry chain.
    # Cancelling is safe: the router refunds its spend reservation in a `finally`.
    fallback = empty_resume_parse(body.target_fields).model_dump_json()
    try:
        content, meta = await asyncio.wait_for(
            router.run(
                RESUME_PARSE_TASK_TYPE,
                messages=build_resume_parse_messages(
                    masked, body.target_fields, body.language, system_prompt=system_prompt
                ),
                mock_response=fallback,
                # A LITERAL, WHERE OTHER PRIVACY-SENSITIVE ROUTES DERIVE IT — and deliberately.
                # Elsewhere the flag answers "did the masker refuse anything?", because a
                # blocked message means text the gateway would not mask. Here the masker never
                # blocks the call: `mask_resume_lines` DROPS an un-maskable line and keeps the
                # rest, so there is no blocked state left to derive from by the time this runs.
                # What authorises the call is the policy chosen at step 3 — masked, or
                # ruling-authorised raw — and that decision has already been made and recorded.
                real_call_allowed=True,
                user_ref=body.worker_ref,
                prompt=prompt,
            ),
            timeout=settings.resume_parse_deadline_seconds,
        )
    except TimeoutError:
        # `TimeoutError` ONLY — deliberately not `CancelledError`. On Python >= 3.11
        # `wait_for` raises the builtin, while a `CancelledError` here means the CALLER
        # went away, and swallowing that would turn a disconnect into a fabricated 200.
        logger.warning(
            "resume_import.deadline_exceeded",
            extra={"extra": {"deadline_s": settings.resume_parse_deadline_seconds}},
        )
        return _response(stage, body.target_fields, failure_reason="parse_deadline_exceeded")

    stage.meta = meta
    # Two DIFFERENT degradations. Nothing attempted (mock mode, a spend cap, the kill
    # switch) is a POSTURE; a provider reached and failed is an INCIDENT. Conflating them
    # hides the one that needs an operator.
    if not meta.real_call:
        stage.notes.append("mock_no_parse")
    elif not meta.success:
        stage.notes.append("llm_unavailable")

    # ---- 5. CONTRACT --------------------------------------------------------
    draft = _read_resume_output(content)
    if draft is None:
        return _response(stage, body.target_fields, failure_reason="parse_output_invalid")

    # ---- 6. GATE ------------------------------------------------------------
    # THE LINES AS A TRANSCRIPT, every one `role="worker"`.
    #
    # Gate 2 (ROLE) is therefore satisfied by every line, and that is honest rather than
    # weakened: a résumé contains no assistant turns, so there is nothing for it to
    # forbid. The gate is kept in the path anyway, and `role` is set from a single literal
    # HERE, so the day someone adds a non-document line to this list — a pack question, a
    # hint, an instruction — gate 2 starts biting instead of having been deleted.
    transcript = [
        TranscriptLine(i=line.index, role="worker", text=line.text) for line in masked.lines
    ]

    # RE-WRAPPED, not passed straight through. `apply_parse_gates` is typed on
    # `ProfileParseOutput` and reads exactly one attribute off it, so handing it a
    # `ResumeParseOutput` would work at runtime and be a lie to every reader and type
    # checker. Constructing the object it declares costs nothing and keeps the shared
    # wall's contract honest — and makes it obvious that `employments` is NOT covered by
    # this call and needs `gate_employments` below.
    gated = parse_gates.apply_parse_gates(
        ProfileParseOutput(fields=draft.fields),
        answer_map=[],  # No interview has happened yet — gate 4 is a no-op by construction.
        transcript=transcript,
        target_fields=body.target_fields,
        certify=resume_value_certifier,
    )
    # GATE 6 OVER THE SPAN, WHICH `apply_parse_gates` DOES NOT DO.
    #
    # `check_pii` certifies `parsed.value` and nothing else. On the interview route that is
    # complete by construction: the transcript was pseudonymized before the model saw it, so
    # a quote is a substring of already-masked text and cannot carry what the value cannot.
    #
    # THIS ROUTE BREAKS THAT ASSUMPTION. With `RESUME_PARSE_RAW_TEXT_ENABLED` on, a quote is a
    # literal substring of an UNMASKED résumé line — and the prompt asks for a substring while
    # models routinely return the whole line. The line most likely to be cited for
    # `current_city` or `role_label` is the header: `Ramesh Kumar | CNC Turner | Pune |
    # 9876543210 | PAN ABCDE1234F`. The VALUE ("Pune") passes gate 6 cleanly; the phone and the
    # PAN would have ridden out beside it in `evidence.quote`.
    #
    # Found by the RI-3 security review, not by this file's own tests, which asserted only on
    # values. The claim in the module docstring — "leaves it only as gated values" — was false
    # until this ran, and is true now.
    certified = {
        field_id: parsed
        for field_id, parsed in gated.accepted.items()
        if not _carries_identifier(parsed.evidence.quote)
    }
    spans_rejected = len(gated.accepted) - len(certified)
    if spans_rejected:
        stage.notes.append("fields_rejected")
        logger.info(
            "resume_import.spans_rejected", extra={"extra": {"rejected": spans_rejected}}
        )

    if gated.rejections:
        stage.notes.append("fields_rejected")
        logger.info(
            "resume_import.fields_rejected",
            extra={"extra": parse_gates.count_by_gate(gated.rejections)},
        )

    employments, employment_rejections = gate_employments(draft.employments, transcript)
    if employment_rejections:
        stage.notes.append("employments_rejected")
        logger.info(
            "resume_import.employments_rejected",
            extra={"extra": {"rejected": employment_rejections}},
        )

    return _response(
        stage, body.target_fields, fields=certified, employments=employments
    )


def _read_resume_output(content: str) -> ResumeParseOutput | None:
    """The model's response as a contract object, or None if it is not one.

    Never raises and never repairs. A body this service cannot validate is a body it has
    no way to gate, and the fail-closed reading of an ungateable overlay is "there was no
    overlay".
    """
    try:
        return ResumeParseOutput.model_validate(json.loads(coerce_json_text(content)))
    except Exception as exc:  # noqa: BLE001 — a malformed overlay never costs the import
        # Type name only: the exception body can echo the model's response, which can echo
        # the résumé.
        logger.warning(
            "resume_import.output_unreadable", extra={"extra": {"error": type(exc).__name__}}
        )
        return None


def gate_employments(
    entries: list[ResumeEmployment], transcript: list[TranscriptLine]
) -> tuple[list[ResumeEmployment], int]:
    """Employment rows through the same walls the scalar fields go through.

    WHY THIS IS NOT `apply_parse_gates`. That wall types ONE value against a declared
    `TargetField`; an employment row is four values and a citation, and three of the four
    are free text a taxonomy cannot close. So the gates that transfer are applied here
    explicitly, and the ones that do not are absent rather than faked:

      1. PROVENANCE — kept, and it is the load-bearing one. The row's quote must literally
         appear in the line it cites, so an invented employer has nothing to point at.
      2. ROLE       — kept via provenance's own line lookup; every line is the document.
      3. TYPE/RANGE — kept as year sanity (the contract bounds 1950-2100) plus the
         ordering check below, which the contract cannot express.
      4. AGREEMENT  — nothing to agree with; no interview has happened.
      5. VOCABULARY — not applicable: there is no field-id to close.
      6. PII        — kept, and unchanged from the scalar path: `resume_value_certifier`.
         ADR-0041 D5 authorises an employer NAME; it authorises nothing else, so a row
         whose employer field carries a phone number or a PAN is refused whole.

    A row that fails any of these is DROPPED AND COUNTED, never repaired. Repairing would
    mean writing an employer name nobody can point at in the document — which is the one
    thing this whole design exists to make impossible.
    """
    kept: list[ResumeEmployment] = []
    rejected = 0
    for entry in entries:
        if parse_gates.check_provenance(entry.evidence, transcript) is not None:
            rejected += 1
            continue
        if parse_gates.check_role(entry.evidence, transcript) is not None:
            rejected += 1
            continue
        if _employment_years_wrong(entry):
            rejected += 1
            continue
        if _employment_carries_identifier(entry):
            rejected += 1
            continue
        if entry.employer_name is None and entry.role_title is None:
            # A row that names neither an employer nor a role is a citation with no
            # content. It would render as an empty card the worker has to delete.
            rejected += 1
            continue
        kept.append(entry)
    return kept, rejected


def _employment_years_wrong(entry: ResumeEmployment) -> bool:
    """A stint that ends before it starts is a misreading, not a job.

    The contract already bounds each year to 1950-2100 individually; it cannot express a
    relationship between two fields. Left unchecked this reverses a career on the résumé
    sheet and is the kind of error an employer notices before the worker does.
    """
    return (
        entry.start_year is not None
        and entry.end_year is not None
        and entry.end_year < entry.start_year
    )


def _employment_carries_identifier(entry: ResumeEmployment) -> bool:
    """Gate 6 for an employment row — every string in it, not just the employer name.

    `role_title` is as capable of carrying a phone number as `employer_name` is, and a
    model handed an unmasked document will occasionally put the whole contact line into
    whichever field it thought the line was about.

    BLOCKED **OR ALTERED**, matching `parse_gates.check_pii` exactly. `resume_value_certifier`
    never rewrites today, so checking only `blocked` was equivalent — and that equivalence
    is precisely the kind that stops holding silently. A mutation proved it: widening the
    certifier to the full gateway (which returns `blocked=False` and the text rewritten to
    `[EMPLOYER_1]`) left this function returning False, so the scalar path collapsed while
    the employment path sailed on with a placeholder written into `employer_name_enc`.
    "Altered" is the load-bearing half of gate 6 everywhere else; it is now the load-bearing
    half here too.
    """
    # THE CITED SPAN IS ONE OF THE STRINGS, and it was missing from this tuple until the
    # RI-3 security review. An employment row's quote is the line it was read from — on a
    # résumé that is the line carrying the employer AND, very often, the contact details
    # printed beside it.
    for text in (entry.employer_name, entry.role_title, entry.evidence.quote):
        if text is None:
            continue
        blocked, certified = resume_value_certifier(text)
        if blocked or certified != text:
            return True
    return False


def _carries_identifier(text: str) -> bool:
    """Gate 6 for one string, blocked-or-altered, the same test `check_pii` applies."""
    blocked, certified = resume_value_certifier(text)
    return blocked or certified != text
