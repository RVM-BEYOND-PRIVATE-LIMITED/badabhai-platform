"""Helpers shared by more than one router module.

Moved verbatim out of ``app/main.py``; ``_pseudonymization_meta`` is used by both
``routers/profiling.py`` and ``routers/job_posting.py``, so it lives here rather
than in either one. Re-exported from ``app.main`` (unchanged import surface).
"""

from __future__ import annotations

from ..contracts import PseudonymizationMeta
from ..pseudonymize import PseudonymizationResult


def _pseudonymization_meta(result: PseudonymizationResult) -> PseudonymizationMeta:
    return PseudonymizationMeta(
        blocked=result.blocked,
        blocked_reason=result.blocked_reason,
        replaced_entities=result.replaced_entities,
        placeholder_tokens=result.placeholder_tokens,
    )
