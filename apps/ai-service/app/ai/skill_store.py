"""DB-backed SkillCanonicalStore over HTTP (ADR-0030 / FORK-B-1 — seam A).

The request-path half of fork-B: ``canonicalize_skill`` needs the domain-scoped HNSW
lookup + the unresolved-phrase upsert, but the ai-service is DB-FREE and
``skill_alias``/``unresolved_phrase`` are RLS-locked + REVOKE'd from the Data-API roles.
So this store calls two INTERNAL NestJS routes and the api runs the authorized queries
on its owner connection:

    POST {backend_api_url}/internal/skills/nearest-aliases  -> {candidates: [{skill_id, score}]}
    POST {backend_api_url}/internal/skills/unresolved       -> 204 (+ hash-only event)

PHASE 1.5 SCOPE KEY: BOTH bodies carry EXACTLY ONE of ``domain_id`` (legacy 11-slug skill
domain; the api runs the unchanged ``skill_alias.domain_id`` query) or ``job_domain_id``
(canonical ``jd_*``; the api joins ``job_domain_skill``). Neither/both is a 400 api-side,
and a refusal here before the request is even sent.

The unresolved body follows the same rule as of migration 0078, which gave
``unresolved_phrase`` its own ``job_domain_id`` column and widened the unique index — so a
canonical-scoped miss is queued under the domain it actually missed in, rather than being
dropped for want of a legacy slug to name.

AUTH (least privilege — #222 review): the SCOPED ``SKILLS_INTERNAL_TOKEN``
(``x-skills-internal-token``), guarded api-side by ``SkillsInternalGuard``. Deliberately
NOT the api's all-routes ``INTERNAL_SERVICE_TOKEN`` — this credential opens ONLY the two
skills routes, never resume-PII/money routes.

CONCURRENCY: the store is SYNC (httpx.Client, shared per instance for keep-alive). The
async ``/profile/extract`` handler MUST NOT call it inline — the call-site offloads the
whole canonicalize pass via ``asyncio.to_thread`` so the event loop never blocks on the
api (the #222 HIGH finding). Timeout is short (2s connect / 5s total): slow is as good
as down here — we degrade, not wait.

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
from ..contracts import exactly_one_skill_scope
from ..logging_config import get_logger
from .canonicalize import NullSkillStore, SkillCanonicalStore

logger = get_logger("ai.skill_store")

_TIMEOUT = httpx.Timeout(5.0, connect=2.0)
_TOKEN_HEADER = "x-skills-internal-token"
# The api DTO caps k at 1..20 — clamp OUR side too so a mis-set SKILL_CANONICALIZE_TOP_K
# can never turn every lookup into a silent 400 -> [] -> UNRESOLVED-everything.
_K_MIN, _K_MAX = 1, 20


class HttpSkillStore:
    """SkillCanonicalStore backed by the api's internal skill routes (seam A)."""

    def __init__(self, base_url: str, token: str):
        self._base = base_url.rstrip("/")
        self._headers = {_TOKEN_HEADER: token}
        # One shared client per store instance (keep-alive across the per-label loop).
        self._client = httpx.Client(timeout=_TIMEOUT)

    def nearest_aliases(
        self,
        domain_id: str | None,
        query_vector: list[float],
        k: int,
        *,
        job_domain_id: str | None = None,
    ) -> list[tuple[str, float]]:
        # EXACTLY ONE SCOPE KEY ON THE WIRE (Phase 1.5). The api DTO 400s a request carrying
        # neither or both, so send precisely the one that applies:
        #   legacy    -> {"domain_id": "cnc-machining", ...}  (BYTE-IDENTICAL to pre-1.5)
        #   canonical -> {"job_domain_id": "jd_welding", ...} (candidates via job_domain_skill)
        # `domain_id` is deliberately OMITTED (not sent as null) on the canonical path — a
        # fabricated legacy slug would silently re-scope the query to the wrong id space.
        if not exactly_one_skill_scope(domain_id, job_domain_id):
            # Fail CLOSED locally rather than posting an unscoped body and trusting the api to
            # refuse it: "no domain" must never have a chance of meaning "search everything".
            logger.warning(
                "skill_store nearest_aliases refused: need exactly one of "
                "domain_id / job_domain_id",
                extra={
                    "extra": {
                        "has_domain_id": domain_id is not None,
                        "has_job_domain_id": job_domain_id is not None,
                    }
                },
            )
            return []
        scope: dict[str, str | None] = (
            {"job_domain_id": job_domain_id}
            if job_domain_id is not None
            else {"domain_id": domain_id}
        )
        try:
            resp = self._client.post(
                f"{self._base}/internal/skills/nearest-aliases",
                headers=self._headers,
                json={
                    **scope,
                    "vector": query_vector,
                    "k": max(_K_MIN, min(_K_MAX, k)),
                },
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

    def record_unresolved(
        self,
        phrase: str,
        domain_id: str | None,
        lang: str,
        *,
        job_domain_id: str | None = None,
    ) -> None:
        # EXACTLY ONE SCOPE KEY ON THE WIRE, the same rule the search half follows and the
        # same rule `RecordUnresolvedDtoSchema` enforces api-side. Both scopes are live now:
        # migration 0078 gave `unresolved_phrase` a `job_domain_id` column and widened its
        # unique index, and the api emits `skill.phrase_unresolved_v2` for that scope rather
        # than relaxing v1's `domain_id: string` (CLAUDE.md §3).
        #
        # Refuse locally rather than spend a round trip earning a 400 — and refuse rather
        # than substitute: writing the `jd_*` id into the LEGACY-slug `domain_id` column
        # would mix two id spaces and corrupt every per-domain reader of the queue.
        if not exactly_one_skill_scope(domain_id, job_domain_id):
            logger.info(
                "skill_store record_unresolved refused: need exactly one of "
                "domain_id / job_domain_id",
                extra={
                    "extra": {
                        "has_domain_id": domain_id is not None,
                        "has_job_domain_id": job_domain_id is not None,
                    }
                },
            )
            return
        # OMITTED, not sent as null: `RecordUnresolvedDtoSchema` marks both `.optional()`
        # and refines on `=== undefined`, so an explicit null both fails the string parse
        # and reads as "supplied" to the refine — a 400 on a body that meant well.
        scope: dict[str, str | None] = (
            {"job_domain_id": job_domain_id}
            if job_domain_id is not None
            else {"domain_id": domain_id}
        )
        try:
            resp = self._client.post(
                f"{self._base}/internal/skills/unresolved",
                headers=self._headers,
                json={"phrase": phrase, **scope, "lang": lang},
            )
            if resp.status_code >= 300:
                raise RuntimeError(f"HTTP {resp.status_code}")
        except Exception as exc:  # swallow — a lost queue row must not fail the turn
            logger.warning(
                "skill_store record_unresolved failed (miss not recorded)",
                extra={
                    "extra": {
                        "error": type(exc).__name__,
                        "canonical_scope": job_domain_id is not None,
                    }
                },
            )


def skill_store_configured(settings: Settings) -> bool:
    """Is the FORK-B-1 seam wired? THE SINGLE DEFINITION, deliberately.

    Extracted so that anything reporting on the seam answers with the factory's own
    predicate rather than a second copy of it. A drifted copy is worse than no report at
    all: it would tell an operator the store is live while :func:`get_skill_store` hands
    the canonicalizer the inert one. Never returns the values — only whether both are set.
    """
    return bool(settings.backend_api_url and settings.skills_internal_token)


def get_skill_store(settings: Settings) -> SkillCanonicalStore:
    """The FORK-B-1 store factory. Returns the :class:`HttpSkillStore` only when the seam
    is fully configured (api url + the SCOPED skills token); otherwise the inert
    :class:`NullSkillStore` — so a half-configured deployment degrades to the status quo
    (raw phrase kept, nothing recorded) instead of erroring."""
    if skill_store_configured(settings):
        # Narrowed for the type checker: `skill_store_configured` already proved both are
        # non-empty, but it returns a bool rather than the values.
        assert settings.backend_api_url is not None
        assert settings.skills_internal_token is not None
        return HttpSkillStore(settings.backend_api_url, settings.skills_internal_token)
    return NullSkillStore()
