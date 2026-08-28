"""The SYNTHETIC-PERSONA harness routes (R7 §1) — registered only on an armed process.

WHAT THIS IS FOR. Iterating on what the interview actually extracts requires giving a model a
whole persona: a name, a phone, employers, cities. Through the real gateway that persona arrives
as ``[PERSON_1]`` working at ``[EMPLOYER_1]`` in a city that survives but a company that does not,
and the résumé it produces cannot be diffed against the ratified samples at all. So this module
runs the same Phase C body with the masker replaced.

WHY IT IS SAFE, STATED AS THREE INDEPENDENT BARRIERS rather than one flag:

  1. **The reason.** ``AI_SYNTHETIC_PERSONA_MODE`` is a string, not a bool — deliberate, visible
     in shell history, impossible to inherit from a stray ``true``.
  2. **The route does not exist.** ``main.py`` includes this router only when that reason is set.
     On any other process these URLs 404. A route that is absent cannot be reached by a confused
     client, an authenticated caller, or a mistake — which is strictly stronger than a route that
     exists and checks a flag.
  3. **It cannot arrive on a deployed box.** ``Settings`` refuses to boot with the reason set and
     ``BACKEND_API_URL`` pointing anywhere but loopback, and
     ``apps/api/src/config/synthetic-persona-posture.guard.test.ts`` asserts neither compose file
     declares the variable.

WHAT IT IS NOT. It is not a second implementation. It calls ``profiling._extract`` — the exact
body ``/profiling/extract`` runs — with ``passthrough_masker`` instead of ``default_masker``. The
real-worker routes name their masker directly and cannot be pointed at this one.

NOTHING HERE IS A PRIVACY DECISION ABOUT REAL WORKERS. The personas are invented. If a real
transcript is ever sent to this route, that is a harness misuse and the reason string is the
record of who armed it.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter

from ..contracts import InterviewExtractInput, InterviewExtractOutput
from ..profiling.parse_masking import passthrough_masker
from .profiling import _extract

logger = logging.getLogger("ai.synthetic")

api_router = APIRouter()


@api_router.post("/synthetic/extract", response_model=InterviewExtractOutput)
async def synthetic_extract(body: InterviewExtractInput) -> InterviewExtractOutput:
    """Phase C over an UNMASKED synthetic transcript.

    Deliberately NOT ``/profiling/extract`` with a flag on the body: a distinct path means the
    access log, the trace and any proxy rule can all tell the two apart without parsing a
    payload, and the real route keeps exactly the shape it has today.
    """
    # WARNING, not INFO, and once per call. Whoever is reading logs on a box where this fires
    # should see it without going looking — that is most of what makes barrier 1 real.
    logger.warning(
        "synthetic-persona extract: the pseudonymisation gateway is BYPASSED for this call",
        extra={"extra": {"transcript_lines": len(body.transcript)}},
    )
    return await _extract(body, passthrough_masker)
