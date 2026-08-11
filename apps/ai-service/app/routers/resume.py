"""Resume generation: POST /resume/generate."""

from __future__ import annotations

import json

from fastapi import APIRouter

from ..contracts import ResumeGenerationInput, ResumeGenerationOutput
from ..extraction import build_resume, resolve_taxonomy_ids
from ..profiling.prompts import RESUME_SYSTEM_PROMPT
from ..profiling.signals import label_for_id
from ..pseudonymize import certified_clean_skill_labels, pseudonymize
from ._shared import logger, router

api_router = APIRouter()


@api_router.post("/resume/generate", response_model=ResumeGenerationOutput)
async def resume_generate(body: ResumeGenerationInput) -> ResumeGenerationOutput:
    # Q14: `skill_labels` is the ONLY free-text field on the résumé profile
    # (everything else is closed-set ids/enums/numbers). Labels are already
    # CERTIFIED AT REST at population (/profile/extract → sanitize_skill_labels),
    # but the boundary RE-certifies every label (defense in depth — this also
    # covers old/hand-crafted payloads) before it may appear in the artifact OR
    # the LLM payload — the SAME filtered profile feeds build_resume
    # (mock/deterministic text) and the json.dumps LLM payload below, so both
    # see identical labels. The labels are worker-CONFIRMED by construction:
    # résumé generation is triggered only after `profile.confirmed`
    # (profiles.service.ts) and reads the confirmed snapshot — no new
    # confirmation mechanics here. The résumé ALWAYS completes:
    # all-labels-dropped just degrades the skills line.
    profile = body.profile
    if profile.skill_labels:
        kept = certified_clean_skill_labels(profile.skill_labels)
        if len(kept) != len(profile.skill_labels):
            # COUNT only — never the label text (a dropped label is suspect PII).
            logger.debug(
                "resume skill labels dropped by pseudonymize gate",
                extra={"extra": {"dropped": len(profile.skill_labels) - len(kept)}},
            )
        profile = profile.model_copy(update={"skill_labels": kept})
    if profile.education:
        kept = certified_clean_skill_labels(profile.education)
        profile = profile.model_copy(update={"education": kept})
    if profile.certifications:
        kept = certified_clean_skill_labels(profile.certifications)
        profile = profile.model_copy(update={"certifications": kept})
    text, data = build_resume(profile)
    # Resolve all taxonomy IDs to human-readable labels BEFORE the LLM sees
    # them, so the LLM never echoes raw IDs like skill_milling or mach_vmc
    # into the generated resume text. The machine-readable resume_json that
    # travels alongside the text still carries the raw IDs.
    sanitized = {
        **data,
        "canonical_role_id": label_for_id(data["canonical_role_id"])
        if data.get("canonical_role_id")
        else None,
        "canonical_trade_id": label_for_id(data["canonical_trade_id"])
        if data.get("canonical_trade_id")
        else None,
        "skills": [label_for_id(s) for s in data.get("skills", [])],
        "machines": [label_for_id(m) for m in data.get("machines", [])],
        "skill_labels": [label_for_id(s) for s in data.get("skill_labels", [])],
    }
    payload = json.dumps(sanitized)

    # PSEUDONYMIZE GATE — invariant #3 on the ONE route that had none.
    #
    # THE GAP THIS CLOSES. `certified_clean_skill_labels` above filters exactly three
    # LIST fields; `build_resume` then returns `profile.model_dump()` — the ENTIRE
    # DraftProfile — and `sanitized` overrides only the taxonomy-id fields. So every
    # remaining value went into the user message VERBATIM: `education_level` and
    # `education_field` (model-authored free-text scalars, certified by nothing),
    # `location_preference.current_city` / `preferred_cities`, `experience`,
    # `salary_expectation`, `availability`. A name, phone or employer that a model
    # wrote into any of those egressed raw — while `/profiling/respond` and
    # `/profile/extract` mask that exact class of value on every turn.
    #
    # FAIL-CLOSED THE SAME WAY `/profiling/respond` DOES: on `blocked` the provider is
    # NEVER called. The route still COMPLETES — `text` is the deterministic résumé
    # `build_resume` already produced LOCALLY from the filtered profile, so a worker
    # never loses their résumé over a gateway block; only the LLM polish is skipped.
    # The OUTPUT SHAPE is unchanged (this schema carries no `blocked` field), and
    # `resume_json` stays `data`, the machine-readable ids, exactly as before.
    #
    # ACCEPTED COST, stated plainly: the masked payload is what a REAL model now sees,
    # so a worker's city can reach it as "[CITY_1]" and a 7-digit salary as
    # "[AMOUNT_1]". That is the same treatment every other route already applies to
    # those values, and over-masking is the locked safe direction. Under the committed
    # default (`AI_ENABLE_REAL_CALLS=false`) nothing changes at all: the router takes
    # its mock path and returns `text`, which is built from the unmasked profile.
    gate = pseudonymize(payload)
    if gate.blocked:
        logger.warning(
            "resume generation blocked before the LLM",
            extra={"extra": {"reason": gate.blocked_reason}},
        )
        return ResumeGenerationOutput(
            resume_text=resolve_taxonomy_ids(text),
            resume_json=data,
            format="text",
            is_mock=True,
            # No provider was called, so there is no cost to record (#745). An absent
            # record is the honest answer; a synthesized zero-cost one would appear in
            # `ai.cost_recorded` as a call that never happened.
            ai_metadata=None,
        )

    messages = [
        {"role": "system", "content": RESUME_SYSTEM_PROMPT},
        {"role": "user", "content": gate.text},
    ]
    resume_text, meta = await router.run(
        "resume_generation",
        messages=messages,
        mock_response=text,
        real_call_allowed=True,
        user_ref=body.worker_ref,
    )
    resume_text = resolve_taxonomy_ids(resume_text)
    return ResumeGenerationOutput(
        resume_text=resume_text,
        resume_json=data,
        format="text",
        is_mock=not meta.real_call,
        # #745: `meta` was already built by `router.run` and was being discarded, which is
        # why resume spend reached `ai_jobs` nowhere and `ai.cost_recorded` never. It is
        # returned verbatim — `real_call` already zeroes the rupees on a mocked run, so a
        # mocked environment still records ₹0 rather than fiction.
        ai_metadata=meta,
    )
