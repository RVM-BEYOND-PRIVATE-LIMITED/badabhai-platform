"""Router: POST /pseudonymize — the raw pseudonymization gateway.

Moved verbatim out of ``app/main.py``.
"""

from __future__ import annotations

from fastapi import APIRouter

from ..contracts import PseudonymizationInput, PseudonymizationOutput
from ..pseudonymize import pseudonymize
from ..runtime import logger

router = APIRouter()


@router.post("/pseudonymize", response_model=PseudonymizationOutput)
def pseudonymize_endpoint(body: PseudonymizationInput) -> PseudonymizationOutput:
    result = pseudonymize(body.text)
    logger.info(
        "pseudonymize",
        extra={
            "extra": {
                "blocked": result.blocked,
                "replaced_entities": result.replaced_entities,
                "request_id": body.request_id,
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
