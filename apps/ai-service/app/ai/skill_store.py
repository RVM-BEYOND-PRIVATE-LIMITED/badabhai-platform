"""DB-backed SkillCanonicalStore over HTTP (ADR-0030 / FORK-B-1 — seam A).

The request-path half of fork-B: ``canonicalize_skill`` needs the domain-scoped HNSW
lookup + the unresolved-phrase upsert, but the ai-service is DB-FREE and
``skill_alias``/``unresolved_phrase`` are RLS-locked + REVOKE'd from the Data-API roles.
So this store calls two INTERNAL NestJS routes (InternalServiceGuard, shared secret) and
the api runs the authorized queries on its owner connection:

    POST {backend_api_url}/internal/skills/nearest-aliases  -> {candidates: [{skill_id, score}]}
    POST {backend_api_url}/internal/skills/unresolved       -> 204 (+ hash-only event)

FAILURE POSTURE (deliberate, opposite directions):
- The SEARCH fails OPEN TO UNRESOLVED: any HTTP/parse error returns ``[]`` so the phrase
  degrades to the status-quo raw-phrase profile — canonicalization NEVER blocks
  extraction (TAX-8 guard). The pseudonymize/embed half stays FAIL-CLOSED (SG-2).
- The RECORD swallows errors (count-only log): losing one growth-queue row is acceptable;
  failing a worker's profile turn for it is not.

SG-1: ``record_unresolved`` receives the ALREADY-pseudonymized text from
``canonicalize_skill`` (emb.text) — this module never sees the raw phrase. Nothing here
logs phrase content, ever.
"""

from __future__ import annotations

import httpx

from ..config import Settings
from ..logging_config import get_logger
from .canonicalize import NullSkillStore, SkillCanonicalStore

logger = get_logger("ai.skill_store")

_TIMEOUT_SECONDS = 5.0
_TOKEN_HEADER = "x-internal-service-token"


class HttpSkillStore:
    """SkillCanonicalStore backed by the api's internal skill routes (seam A)."""

    def __init__(self, base_url: str, token: str):
        self._base = base_url.rstrip("/")
        self._headers = {_TOKEN_HEADER: token}

    def nearest_aliases(
        self, domain_id: str, query_vector: list[float], k: int
    ) -> list[tuple[str, float]]:
        try:
            with httpx.Client(timeout=_TIMEOUT_SECONDS) as client:
                resp = client.post(
                    f"{self._base}/internal/skills/nearest-aliases",
                    headers=self._headers,
                    json={"domain_id": domain_id, "vector": query_vector, "k": k},
                )
            if resp.status_code != 200:
                raise RuntimeError(f"HTTP {resp.status_code}")
            raw = resp.json().get("candidates") or []
            out: list[tuple[str, float]] = []
            for c in raw:
                skill_id = c.get("skill_id")
                score = c.get("score")
                if isinstance(skill_id, str) and isinstance(score, (int, float)):
                    out.append((skill_id, float(score)))
            return out
        except Exception as exc:  # fail OPEN to UNRESOLVED — never block extraction
            logger.warning(
                "skill_store nearest_aliases failed (degrading to UNRESOLVED)",
                extra={"extra": {"error": type(exc).__name__}},
            )
            return []

    def record_unresolved(self, phrase: str, domain_id: str, lang: str) -> None:
        try:
            with httpx.Client(timeout=_TIMEOUT_SECONDS) as client:
                resp = client.post(
                    f"{self._base}/internal/skills/unresolved",
                    headers=self._headers,
                    json={"phrase": phrase, "domain_id": domain_id, "lang": lang},
                )
            if resp.status_code >= 300:
                raise RuntimeError(f"HTTP {resp.status_code}")
        except Exception as exc:  # swallow — a lost queue row must not fail the turn
            logger.warning(
                "skill_store record_unresolved failed (miss not recorded)",
                extra={"extra": {"error": type(exc).__name__}},
            )


def get_skill_store(settings: Settings) -> SkillCanonicalStore:
    """The FORK-B-1 store factory. Returns the :class:`HttpSkillStore` only when the seam
    is fully configured (api url + internal token); otherwise the inert
    :class:`NullSkillStore` — so a half-configured deployment degrades to the status quo
    (raw phrase kept, nothing recorded) instead of erroring."""
    if settings.backend_api_url and settings.internal_service_token:
        return HttpSkillStore(settings.backend_api_url, settings.internal_service_token)
    return NullSkillStore()
