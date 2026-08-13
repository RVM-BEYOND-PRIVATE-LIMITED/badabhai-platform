"""The pseudonymization gateway: POST /pseudonymize."""

from __future__ import annotations

from fastapi import APIRouter

from ..contracts import PseudonymizationInput, PseudonymizationOutput
from ..pseudonymize import pseudonymize
from ._shared import logger

api_router = APIRouter()


@api_router.post("/pseudonymize", response_model=PseudonymizationOutput)
def pseudonymize_endpoint(body: PseudonymizationInput) -> PseudonymizationOutput:
    result = pseudonymize(body.text)
    logger.info(
        "pseudonymize",
        extra={
            "extra": {
                "blocked": result.blocked,
                "replaced_entities": result.replaced_entities,
                # BL-19: named body_request_id, NOT request_id -- that key now belongs to the
                # HTTP-level trace id JsonFormatter binds from request_id_tracing's contextvar
                # (logging_config.py). This is a DIFFERENT, pre-existing concept: a per-call id
                # apps/api mints into the request BODY (ai.service.ts's pseudonymize()), unrelated
                # to the header-level trace id. Reusing the same key would have silently clobbered
                # one or the other in the log line.
                "body_request_id": body.request_id,
            }
        },
    )
    return PseudonymizationOutput(
        pseudonymized_text=result.text,
        blocked=result.blocked,
        blocked_reason=result.blocked_reason,
        replaced_entities=result.replaced_entities,
        placeholder_tokens=result.placeholder_tokens,
    )
