"""Résumé import: POST /resume/parse (ADR-0041, RI-3).

HTTP AND TRACING ONLY. Every decision lives in `app/resume_import/resume_parse.py`, and
the privacy argument lives in `app/resume_import/parse_policy.py`. This module exists so
that neither of those has to import FastAPI to be read or tested.

DISTINCT FROM `routers/resume.py`, which GENERATES a résumé from a finished profile. This
one READS an uploaded one. Same noun, opposite direction, and they share nothing.
"""

from __future__ import annotations

from fastapi import APIRouter

from ..ai import prompt_registry
from ..ai.langfuse_tracing import WORKFLOW_PROFILE_BUILD
from ..config import get_settings
from ..contracts import ResumeParseInput, ResumeParseOutput
from ..resume_import.resume_parse import parse_resume
from ._shared import resolve_prompt, router, workflow_scope

api_router = APIRouter()


@api_router.post("/resume/parse", response_model=ResumeParseOutput)
async def resume_parse(body: ResumeParseInput) -> ResumeParseOutput:
    """Read an uploaded résumé into typed, cited values.

    DEGRADES, NEVER FAILS (ruling D9). There is no raise and no non-2xx path here: an
    unset bucket, an unreadable document, a password, a blown deadline and an
    off-contract model response all return a valid body carrying a `failure_reason` from
    the closed vocabulary. The worker's cost is a sentence of Hinglish, never the flow.
    """
    settings_now = get_settings()

    # ROOT TRACE. The SAME workflow as `/profile/parse` and `/profiling/extract`,
    # deliberately: importing a résumé is a step of building ONE worker's profile, and
    # apps/api stamps the same BL-19 correlation id across all of them, so the import and
    # the interview that follows it land in one trace rather than two nothing joins.
    #
    # METADATA IS COUNTS AND A POSTURE FLAG. `storage_key` and `mime` are deliberately
    # absent: the key identifies a worker's document in a bucket and has no business on a
    # span attribute. `raw_text` IS here, because "was this import run with masking off?"
    # is the question a later review of ADR-0041 D5 will open with, and a trace that
    # cannot answer it is a trace that has to be reconstructed from deploy history.
    with workflow_scope(
        name=WORKFLOW_PROFILE_BUILD,
        worker_ref=body.worker_ref,
        metadata={
            "target_fields": len(body.target_fields),
            "language": body.language,
            "raw_text": settings_now.resume_parse_raw_text_enabled,
        },
    ):
        # THE PROMPT IS RESOLVED rather than read off the module constant, so the
        # generation records WHICH version produced this import — the only way "did v2
        # read résumés better than v1?" is answerable at all. `None` (management off, or
        # the name never registered) falls back to `RESUME_PARSE_SYSTEM_PROMPT`.
        resolved = resolve_prompt(prompt_registry.RESUME_PARSE)
        return await parse_resume(
            body,
            settings=settings_now,
            router=router,
            system_prompt=resolved.text if resolved is not None else None,
            prompt=resolved,
        )
