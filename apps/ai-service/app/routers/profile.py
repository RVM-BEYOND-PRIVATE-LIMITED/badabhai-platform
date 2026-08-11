"""Transcript -> draft profile: POST /profile/extract and POST /profile/parse."""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter

from ..ai import cost_tracker
from ..ai.canonicalize import canonicalize_labels
from ..ai.embeddings import EMBEDDING_TASK_TYPE, embed_text
from ..ai.langfuse_tracing import get_tracer
from ..ai.model_config import rate_inr_per_1k
from ..ai.skill_store import get_skill_store
from ..config import get_settings
from ..contracts import (
    AICallMetadata,
    DraftProfile,
    JobDomainMatch,
    ProfileExtractionInput,
    ProfileExtractionOutput,
    ProfileParseInput,
    ProfileParseOutput,
    WorkerProfileDraft,
)
from ..profiling import parse_gates, profile_extractor
from ..profiling.canonical_roles import (
    ROLE_TRADE,
    canonicalization_instruction,
    coerce_json_text,
    extract_canonical_role_id,
    normalize_role_id,
)
from ..profiling.domain_match import (
    build_query_text as build_domain_query,
)
from ..profiling.domain_match import (
    get_domain_store,
)
from ..profiling.domain_match import (
    match_domain as match_job_domain,
)
from ..profiling.parse_masking import mask_parse_input
from ..profiling.parse_prompt import build_parse_messages, empty_parse
from ..profiling.prompts import extraction_system_prompt
from ..profiling.signals import has_first_person_claim, label_for_id
from ..pseudonymize import pseudonymize
from ._shared import logger, router, settings

api_router = APIRouter()


@api_router.post("/profile/extract", response_model=ProfileExtractionOutput)
async def profile_extract(body: ProfileExtractionInput) -> ProfileExtractionOutput:
    # Two texts, deliberately different, because two consumers need different things.
    #
    # `llm_text` is the WHOLE conversation, both directions. The model needs our
    # questions to read an answer in context ("5 saal" means nothing alone), and
    # apps/api already labels each line `Worker:` / `Bada Bhai:` so it can tell
    # them apart. Unchanged from before this split — the model was never the
    # problem.
    #
    # `worker_text` is the worker's OWN lines only, and it feeds the deterministic
    # detector. That detector is a keyword/regex reader with no notion of who is
    # speaking, so on the combined blob it read OUR question text as the worker's
    # answers: a controller question listing "Fanuc, Siemens, Mitsubishi, Haas,
    # Heidenhain" produced all five controllers from a worker who said only
    # "fanuc"; a retry worded "jaise 2 saal ya 5 saal" produced 2.0 years from a
    # worker who said "5 saal"; the education question's own examples produced
    # `["ITI", "Diploma"]` from a worker who had not yet been asked. Measured: this
    # split alone corrects experience, preferred cities, skills, controllers and
    # that fabricated education.
    #
    # `messages` absent → both fall back to `transcript` and behaviour is
    # byte-identical to before. That is the rollback lever: apps/api sends both
    # fields, so dropping `messages` restores the previous behaviour exactly.
    msgs = body.messages or []
    if msgs:
        worker_text = "\n".join(m.text for m in msgs if m.role == "worker")
        llm_text = body.transcript or "\n".join(
            f"{'Worker' if m.role == 'worker' else 'Bada Bhai'}: {m.text}" for m in msgs
        )
    else:
        worker_text = llm_text = body.transcript or ""

    # 1. Pseudonymize FIRST — gate. If blocked, fail closed.
    #
    #    `llm_text` is gated because it is what reaches the model. `worker_text` is
    #    gated TOO, and separately, because the two are independent inputs whenever
    #    a caller sends both fields: nothing forces them to describe the same
    #    conversation, so gating only `llm_text` would let a caller hand the
    #    detector text the gate would have refused. apps/api always derives both
    #    from the same messages, so in practice this second call is redundant —
    #    but "in practice" is not a gate, and the property should be structural.
    #
    #    NOT claimed here (an earlier version of this comment did claim it):
    #    `worker_text` is not confined to this process. `rich` is derived from it
    #    and is passed to the router as `mock_response`, which the Langfuse tracer
    #    records as the trace output on the mock path and on every real-call
    #    failure. That payload is closed-set labels and numbers, not free text, and
    #    it predates this split — but it is egress, so the comment must not say
    #    otherwise.
    result = pseudonymize(llm_text)
    if not result.blocked and worker_text is not llm_text:
        worker_gate = pseudonymize(worker_text)
        if worker_gate.blocked:
            result = worker_gate
    if result.blocked:
        return ProfileExtractionOutput(
            profile=DraftProfile(),
            blocked=True,
            blocked_reason=result.blocked_reason,
            is_mock=True,
            extraction_status="blocked",
        )

    # 2. Heuristic extraction over the worker's OWN raw text (trusted local; no network).
    rich, legacy = profile_extractor.extract(worker_text, body.role_family)

    # 3. Route for cost/tracing + optional real-model extraction. The LLM only
    #    ever sees the pseudonymized transcript. The canonicalization rubric makes
    #    the model emit a `canonical_role_id` from the closed taxonomy set.
    messages = [
        {
            "role": "system",
            "content": (
                extraction_system_prompt(body.role_family)
                + canonicalization_instruction()
                + _schema_hint()
            ),
        },
        {"role": "user", "content": result.text},
    ]
    # UNDER A HARD DEADLINE, for the reason `/profile/parse` already is — and this route
    # needed it more, not less. `router.run` never raises, but it can take
    # `gemini_timeout_seconds` times the retry chain, and NOTHING bounded that here.
    #
    # THE CALLER IS ALREADY GONE BY THEN. `apps/api` aborts this request at 8s
    # (`AiService.post`), and Starlette does NOT cancel a running handler when the client
    # disconnects — so an unbounded call kept its worker slot and kept putting requests on
    # a provider that was already rate-limiting us, minutes after the profile it was
    # computing had been written from the fallback. That is the shape of the reported
    # incident: the API gave up, the ai-service did not, and the next trigger started
    # another one on top.
    #
    # Degrading is cheap here: the heuristic pass at step 2 already produced `rich`/`legacy`
    # from the worker's own text with no network at all, so a timeout costs the enrichment
    # overlay and nothing else. Cancelling is safe — the router refunds its spend
    # reservation in a `finally`, so a cancelled call leaks no ledger.
    settings_now = get_settings()
    try:
        content, meta = await asyncio.wait_for(
            router.run(
                "profile_extraction",
                messages=messages,
                mock_response=rich.model_dump_json(),
                real_call_allowed=True,
                user_ref=body.worker_ref,
            ),
            timeout=settings_now.profile_extract_deadline_seconds,
        )
    except TimeoutError:
        # `TimeoutError` ONLY — deliberately not `CancelledError`, matching `/profile/parse`.
        # On Python >= 3.11 `wait_for` raises the builtin, while a `CancelledError` here means
        # the CLIENT went away, and swallowing that would turn a disconnect into a fabricated
        # 200 and break cancellation for everything above this frame.
        logger.warning(
            "profile extract deadline exceeded",
            extra={"extra": {"deadline_s": settings_now.profile_extract_deadline_seconds}},
        )
        return ProfileExtractionOutput(
            profile=legacy,
            blocked=False,
            is_mock=True,
            extraction_status="completed",
            worker_profile_draft=rich,
            # No `ai_metadata`: a fabricated zero-cost record is worse than an absent one,
            # being indistinguishable from a real call that happened to be free. Same rule
            # `/profile/parse` states for its own degraded paths.
            ai_metadata=None,
            job_domain_match=None,
            # NAMED, so apps/api can tell this from a worker who genuinely said nothing.
            # That distinction is the whole reason `error_code` exists on this contract, and
            # it is what stops an outage from reading as "not profiled yet" and re-triggering
            # extraction forever.
            error_code="extract_deadline_exceeded",
        )

    # In real mode, prefer a valid LLM profile but keep locally-read fields
    # (city/salary) since the model only saw masked text.
    if meta.real_call and meta.success:
        # Canonicalization first, LENIENTLY: pull the role id straight from the raw
        # JSON and trust it only if it is a known canonical id (reject
        # hallucinations). This is independent of the strict rich-draft validation
        # below — the model routinely nulls/loosely-types enrichment fields, and a
        # correct canonical role id must not be discarded just because (say)
        # `experience_level` came back null. A valid id overrides the heuristic on
        # `legacy` — the field the canonicalization eval measures — and derives the
        # trade id. A null/invalid id keeps the heuristic.
        role_id = normalize_role_id(extract_canonical_role_id(content))
        if role_id is not None:
            # TD101: A valid id overrides the heuristic ONLY IF the heuristic found it too,
            # or the worker actually made a first-person claim in the text. This prevents
            # the LLM from inventing a role (like "CNC Setter-Operator") when the worker
            # just said "mera bhai operator hai".
            if legacy.canonical_role_id is None and not has_first_person_claim(worker_text):
                role_id = None

        if role_id is not None:
            legacy.canonical_role_id = role_id
            legacy.canonical_trade_id = ROLE_TRADE.get(role_id, legacy.canonical_trade_id)
        # Field-by-field enrichment overlay: keep each well-formed model field even
        # when siblings are malformed (location/salary stay local — masked input).
        rich = profile_extractor.merge_model_draft(rich, content)
        # TODO(WS4 recall backfill, owner review): once the real-eval NEGATIVE tier
        # is confirmed unaffected, enable the rich->legacy canonical backfill here:
        #   legacy = profile_extractor.map_rich_to_legacy(rich, legacy)
        # It fills in-scope machine/skill/role ids the raw-text detector missed
        # (writing only closed-set gazetteer ids). Deferred because backfilling the
        # role from the model's free `primary_role` label could override the model's
        # AUTHORITATIVE `canonical_role_id=null` on a helper/adjacent case and
        # regress the negative tier — verify against the staging --real eval first.

    # Q14 (ADR-0030 OQ#3) — the LIVE-PATH producer of skill_labels: carry the
    # rich draft's raw skill LABELS onto the persisted legacy profile so the
    # résumé can render them. LABELS ONLY — deliberately NOT the deferred WS4
    # map_rich_to_legacy role/id backfill above (negative-tier risk); the
    # matchable `skills`/`machines`/role ids are untouched here. CERTIFIED AT
    # REST via sanitize_skill_labels (hygiene clamp + pseudonymize
    # certification): apps/api persists this profile as profiles.raw_profile and
    # later generated_resumes.sourceProfileSnapshot, and the PDF + payer-facing
    # disclosure surfaces render skill_labels from that snapshot with NO
    # TypeScript pseudonymize equivalent — a suspect label must never persist.
    # The résumé boundary re-certifies (defense in depth). Never logs label text.
    legacy.skill_labels = profile_extractor.sanitize_skill_labels(legacy.skill_labels + rich.skills)

    # TAX-4/FORK-B-1: vector-canonicalize the SKILL labels (SG-3 — the vector layer
    # assigns ids from the closed skill_alias set; below-floor phrases are recorded
    # pseudonymized + stay raw). SKILLS ONLY — deliberately NOT map_rich_to_legacy's
    # role backfill, which the WS4 TODO above still defers (negative-tier risk).
    # Inert unless BOTH the flag is on AND the seam is configured (get_skill_store
    # returns the NullSkillStore otherwise) — the TD65 activation chain.
    if settings.skill_canonicalize_enabled:
        labels = rich.skills + rich.controllers
        # TD68 (TD27 SpendLedger wiring, REAL embed path only): reserve the projected
        # cost of the WHOLE label pass before it runs; on a ledger block SKIP the pass
        # entirely — labels stay raw, the NullSkillStore status quo (extraction is
        # never blocked by canonicalization). Mock embed path: zero ledger traffic.
        embed_is_mock = not settings.real_call_enabled_for(EMBEDDING_TASK_TYPE)
        reserved_inr = 0.0
        ledger_blocked = False
        if not embed_is_mock and labels:
            in_rate, _out = rate_inr_per_1k(settings.embedding_model)
            reserved_inr = (
                sum(cost_tracker.estimate_tokens(label) for label in labels) / 1000.0
            ) * in_rate
            # user_ref attributes this spend to the worker's per-user daily cap —
            # same attribution as the sibling router.run call above (#238 F2).
            reason = await cost_tracker.get_ledger().would_exceed_spend(
                reserved_inr, settings, user_ref=body.worker_ref
            )
            if reason is not None:
                ledger_blocked = True
                reserved_inr = 0.0  # nothing was reserved on a block
                # Counts/reason only — never label text.
                logger.warning(
                    "extract canonicalize pass skipped by spend ledger",
                    extra={"extra": {"labels": len(labels), "reason": reason}},
                )
        if not ledger_blocked:
            actual_inr = 0.0
            # TRACED as its own task. Without this span each label's embed posts a
            # ROOTLESS `embed-text` trace: the router's span closed when `router.run`
            # returned, so there is nothing left for them to nest under, and a
            # ten-label pass turns into ten context-free traces. This is a second AI
            # pass over the same request, so it gets its own root and the embeds nest
            # inside it. `user_ref` matches the extraction's, which is what ties the
            # two traces back to one worker.
            with get_tracer().task(
                task_type="skill_canonicalization_batch",
                input={
                    "labels": len(labels),
                    "domain_id": settings.skill_canonicalize_default_domain,
                },
                user_ref=body.worker_ref,
                real_call=not embed_is_mock,
            ) as canonicalize_task:
                try:
                    # OFF the event loop (#222 HIGH): the store + a real embed are SYNC httpx
                    # calls (per label). Inline they would freeze the whole service (health
                    # checks, every concurrent turn) for up to timeout x labels when the
                    # api/provider is slow — to_thread keeps the loop serving while the pass
                    # runs.
                    assigned, _unresolved = await asyncio.to_thread(
                        canonicalize_labels,
                        labels,
                        settings.skill_canonicalize_default_domain,
                        get_skill_store(settings),
                        settings,
                    )
                    # Leave the full reservation recorded as the actual spend (conservative).
                    actual_inr = reserved_inr
                    # Closed-set skill ids only (SG-3), never label text.
                    canonicalize_task.update(
                        output={"assigned": list(assigned), "unresolved": len(_unresolved)}
                    )
                finally:
                    if reserved_inr > 0.0:
                        # On a raise, actual_inr stayed 0.0 => full refund (no leak).
                        await cost_tracker.get_ledger().record_spend(
                            reserved_inr, actual_inr, user_ref=body.worker_ref
                        )
            for sid in assigned:
                if sid not in legacy.skills:
                    legacy.skills.append(sid)

    # Honest-adjacency flag (advisory ONLY — never ranks/rejects): mark the draft
    # adjacent when it canonicalized to nothing matchable in the CNC/VMC taxonomy
    # (e.g. welding), so it is not silently half-empty. Additive; no matchable
    # field is written here.
    if profile_extractor.is_outside_cnc_vmc_scope(legacy):
        rich.unmatchable_reason = profile_extractor.UNMATCHABLE_OUTSIDE_SCOPE

    # TD-EDU — carry the academic education level/field from the rich draft (the
    # LLM-filled source) onto the PERSISTED legacy profile, so the résumé + resume
    # tab (which read the DraftProfile snapshot) can show them. Mirrors the
    # skill_labels carry above; None stays None (mock mode leaves them unset).
    legacy.education_level = rich.education_level
    legacy.education_field = rich.education_field

    # #499 / TD102: carry the list-topics for education and certifications, sanitized.
    legacy.education = profile_extractor.sanitize_skill_labels(rich.education)
    legacy.certifications = profile_extractor.sanitize_skill_labels(rich.certifications)

    # GENERALIZED PROFILING — the RAG job-domain match. It runs HERE, and where it runs
    # is a deliberate choice: extraction is already off the request path (a BullMQ job),
    # already holds the whole pseudonymized transcript, and already produces exactly the
    # trade vocabulary the retrieval needs. Putting it on the chat's final turn instead
    # would have made the worker wait through an embed, an ANN lookup and a second model
    # call to see "Aapki profile ban rahi hai".
    #
    # NEVER RAISES, and never blocks. Every failure mode inside `match_domain` returns an
    # UNMATCHED status, and this wrapper catches anything unforeseen on top: a
    # classification that failed must cost the worker a label, never their profile.
    domain_match = None
    if settings.domain_match_enabled:
        try:
            query = build_domain_query(
                trade=label_for_id(legacy.canonical_role_id) if legacy.canonical_role_id else None,
                skills=list(rich.skills or []),
                machines=list(rich.machines or []),
            )
            domain_match = await match_job_domain(
                query,
                store=get_domain_store(settings),
                settings=settings,
                router=router,
                embed=embed_text,
                user_ref=body.worker_ref,
                # NO `real_call_allowed` override: unlike ProfilingTurnInput, the
                # extraction contract has no such field, and reading one off `body` here
                # raised an AttributeError that this block's own broad `except` then
                # swallowed into a silent `unmatched_degraded` — the feature looked
                # wired and matched nothing, with one log line naming only
                # "AttributeError". The default (True) is correct anyway: whether a real
                # call happens is decided by AI_ENABLE_REAL_CALLS plus the per-task
                # AI_REAL_CALL_TASKS allowlist inside the router, which is the single
                # enforcement point for every task.
            )
            logger.info(
                "domain match",
                extra={
                    "extra": {
                        "status": domain_match.status,
                        "job_domain_id": domain_match.job_domain_id,
                        "shortlist": len(domain_match.considered),
                    }
                },
            )
        except Exception as exc:  # noqa: BLE001 — a label is never worth a failed profile
            # `exc_info` so an unforeseen error is DIAGNOSABLE. The class name alone
            # ("AttributeError") is what a broad except usually leaves you with, and it
            # is not enough to find a wiring bug in a pass that otherwise degrades
            # silently by design. The traceback carries no worker text: everything in
            # this block is catalog ids, config numbers and already-masked phrases.
            logger.warning(
                "domain match errored",
                extra={"extra": {"error": type(exc).__name__}},
                exc_info=True,
            )
            domain_match = JobDomainMatch(status="unmatched_degraded")

    logger.info("profile extracted", extra={"extra": {"is_mock": not meta.real_call}})
    return ProfileExtractionOutput(
        profile=legacy,
        blocked=False,
        is_mock=not meta.real_call,
        extraction_status="completed",
        worker_profile_draft=rich,
        ai_metadata=meta,
        job_domain_match=(
            JobDomainMatch(
                status=domain_match.status,
                job_domain_id=domain_match.job_domain_id,
                score=domain_match.score,
                considered=domain_match.considered,
            )
            if domain_match is not None
            else None
        ),
        # The router's own diagnosis of the LLM leg, carried across the wire instead of only
        # into the log line — the same gap `/voice/transcribe` had, where three distinct
        # failures and one silent worker all reached apps/api as the same empty result.
        # `meta.error_code` is None on every healthy call (real or mock posture) and carries
        # the spend-cap / transport reason when the router refused or the provider failed.
        error_code=meta.error_code,
    )


def _schema_hint() -> str:
    keys = ", ".join(WorkerProfileDraft.model_fields.keys())
    return f"Schema keys: {keys}."


# --- OIE Phase 7: POST /profile/parse --------------------------------------

PARSE_TASK_TYPE = "profile_parse"

#: Every note `/profile/parse` may emit, as a CLOSED SET.
#:
#: `ProfileParseOutput.notes` is a free-form `list[str]`, which makes it the one place in this
#: response where worker text could leave the service without anyone noticing. So two rules hold
#: here and are tested: nothing but these codes is ever written to it, and the MODEL'S OWN notes are
#: discarded unread. Model output is untrusted input — it arrives from the far side of the privacy
#: boundary, it can echo the transcript verbatim, and `notes` has no gate of its own because there
#: is nothing in a note to check a span against.
PARSE_NOTES = frozenset(
    {
        "mock_no_parse",
        "llm_unavailable",
        "parse_deadline_exceeded",
        "parse_output_invalid",
        "evidence_lines_dropped",
        "answer_text_dropped",
        "normalized_value_withheld",
        "city_unrecognized",
        "fields_rejected",
        "parse_disagreement",
    }
)


def _certify(text: str) -> tuple[bool, str]:
    """Gate 6's wall. Full default length here on purpose — this certifies one parsed VALUE, not a
    message, and a "value" long enough to trip the 20,000-char guard is one that should be blocked
    rather than measured against a per-message bound."""
    result = pseudonymize(text)
    return result.blocked, result.text


@api_router.post("/profile/parse", response_model=ProfileParseOutput)
async def profile_parse(body: ProfileParseInput) -> ProfileParseOutput:
    """THE one LLM call of the OIE interview: type the recorded answers and cite their spans.

    THE FRAMING IS THE ENFORCEMENT (`profiling/parse_prompt.py`): `answer_map` is the record and
    `transcript` is an indexed evidence store. The model is never asked what the worker earns; it is
    told what the worker answered and asked to type it and quote the span. Then the six gates
    (`profiling/parse_gates.py`) run before this response leaves — and run AGAIN in Nest before
    anything is persisted, because two walls that agree are worth more than one wall that is
    trusted.

    DEGRADES, NEVER FAILS. Mock mode, an unavailable provider, a blown deadline, an unparseable
    response and a total gate wipeout all produce the SAME thing: a valid `ProfileParseOutput` with
    no fields. Downstream that projects to `parse_status = "deterministic_only"` and the worker
    still gets a real profile out of the answer map, which is the property normalizing at capture
    time was for. There is no failure branch here that costs a worker their interview.
    """
    settings_now = get_settings()

    if not body.target_fields:
        # Nothing was requested, so there is nothing to cite and no reason to spend a call.
        return empty_parse([])

    # 1. PSEUDONYMIZE FIRST, PER MESSAGE. Never the concatenation — see `parse_masking`.
    masked = mask_parse_input(body)
    notes: list[str] = []
    if masked.dropped_lines:
        notes.append("evidence_lines_dropped")
    if masked.dropped_raw_answers:
        notes.append("answer_text_dropped")
    if masked.withheld_normalized:
        notes.append("normalized_value_withheld")
    if masked.dropped_lines or masked.dropped_raw_answers or masked.withheld_normalized:
        # Counts only — the offending text is by definition un-maskable, so it is the last thing
        # that may be logged.
        logger.warning(
            "dropped un-maskable legs from the parse input",
            extra={
                "extra": {
                    "lines": masked.dropped_lines,
                    "raw_answers": masked.dropped_raw_answers,
                    "normalized": masked.withheld_normalized,
                }
            },
        )

    # 2. THE CALL, under a hard deadline. `router.run` never raises, but it can take
    #    `gemini_timeout_seconds` x the retry chain — an order of magnitude past the p95 budget the
    #    worker is waiting inside. Cancelling is safe: the router refunds its spend reservation in
    #    a `finally`, so a cancelled call leaks no ledger.
    messages = build_parse_messages(masked, body.target_fields, body.language)
    fallback = empty_parse(body.target_fields).model_dump_json()
    try:
        content, meta = await asyncio.wait_for(
            router.run(
                PARSE_TASK_TYPE,
                messages=messages,
                mock_response=fallback,
                real_call_allowed=True,
                user_ref=body.worker_ref,
            ),
            timeout=settings_now.profile_parse_deadline_seconds,
        )
    except TimeoutError:
        # `TimeoutError` ONLY — deliberately not `CancelledError`. On Python >= 3.11 `wait_for`
        # raises the builtin, while a `CancelledError` here means the CLIENT went away, and
        # swallowing that would turn a disconnect into a fabricated 200 and break cancellation for
        # everything above this frame.
        logger.warning(
            "profile parse deadline exceeded",
            extra={"extra": {"deadline_s": settings_now.profile_parse_deadline_seconds}},
        )
        return _parse_response(parse_gates.GateResult(), body, [*notes, "parse_deadline_exceeded"])

    # Two DIFFERENT degradations, and conflating them would hide the one that needs an operator.
    # The router's terminal states are unambiguous: nothing attempted (mock mode, a spend cap, the
    # kill switch) is `real_call=False`, while a provider that was reached and failed every
    # candidate is `real_call=True, success=False`. The first is a posture, the second is an
    # incident.
    if not meta.real_call:
        notes.append("mock_no_parse")
    elif not meta.success:
        notes.append("llm_unavailable")

    # 3. Read the response as a contract object. An unparseable or off-contract body is NOT an
    #    error to raise — it is simply an overlay that contributed nothing.
    parsed = _read_parse_output(content)
    if parsed is None:
        # The call HAPPENED and was billed — an off-contract body does not refund it. The cost
        # rides out even though the overlay contributed nothing, which is exactly the case a
        # spend investigation needs to see.
        return _parse_response(
            parse_gates.GateResult(), body, [*notes, "parse_output_invalid"], meta
        )

    # 4. THE SIX GATES, before the response leaves.
    gated = parse_gates.apply_parse_gates(
        parsed,
        list(body.answer_map),
        masked.transcript,
        list(body.target_fields),
        _certify,
    )
    if gated.rejections:
        notes.append("fields_rejected")
    if gated.disagreements:
        notes.append("parse_disagreement")
    if gated.unrecognized_cities:
        notes.append("city_unrecognized")

    logger.info(
        "profile parsed",
        extra={
            "extra": {
                "is_mock": not meta.real_call,
                "requested": len(body.target_fields),
                "accepted": len(gated.accepted),
                "disagreements": len(gated.disagreements),
                # Field ids and counts only — never a value (§2).
                "rejected_by_gate": parse_gates.count_by_gate(gated.rejections),
            }
        },
    )
    return _parse_response(gated, body, notes, meta)


def _read_parse_output(content: str) -> ProfileParseOutput | None:
    """The model's response as a `ProfileParseOutput`, or None if it is not one.

    Never raises and never repairs. A body this service cannot validate is a body it has no way to
    gate, and the fail-closed reading of an ungateable overlay is "there was no overlay".
    """
    try:
        return ProfileParseOutput.model_validate(json.loads(coerce_json_text(content)))
    except Exception as exc:  # noqa: BLE001 — a malformed overlay is never worth a failed parse
        # Type name only: the exception body can echo the model's response, which can echo the
        # transcript.
        logger.warning(
            "profile parse output unreadable", extra={"extra": {"error": type(exc).__name__}}
        )
        return None


def _parse_response(
    gated: parse_gates.GateResult,
    body: ProfileParseInput,
    notes: list[str],
    meta: AICallMetadata | None = None,
) -> ProfileParseOutput:
    """Assemble the response. `unparsed_field_ids` is computed HERE, from what actually survived the
    gates — never taken from the model, which has every incentive to claim it parsed more than it
    cited. `notes` is filtered to the closed set as the last act before the response leaves, so a
    code added carelessly upstream is dropped rather than published.

    `meta` defaults to None so the early-return degradation paths (the deadline, an off-contract
    body) stay one-liners and report NO cost rather than a zero one — the caller passes it only
    where a call actually completed."""
    accepted = gated.accepted
    return ProfileParseOutput(
        fields=dict(accepted),
        unparsed_field_ids=[t.field_id for t in body.target_fields if t.field_id not in accepted],
        notes=[note for note in dict.fromkeys(notes) if note in PARSE_NOTES],
        ai_metadata=meta,
    )
