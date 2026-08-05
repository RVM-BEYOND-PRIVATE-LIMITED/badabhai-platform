"""RAG job-domain matching — retrieve, let the model pick, then re-validate in code.

WHAT THIS REPLACES. Nothing, and that is the point: there was no way to answer "what
trade is this worker in?" for a trade nobody had hand-written a question pack for. The
deterministic engine had seven role families compiled into Python, and everyone else fell
into ``generic``. The catalog (``job_domain`` / ``job_domain_alias``, seeded from
ISCO-08) is a few hundred selectable occupations with thousands of aliases, and this
module is how a worker's own words reach one of them.

THE THREE STEPS, AND WHY EACH IS SEPARATE.

  1. RETRIEVE (deterministic, no model). Embed the worker's own trade words and take the
     top-K nearest aliases from the catalog. This bounds the answer space before any
     model is involved: the model can only ever choose from what the vector search
     found.
  2. PICK (the model, and ONLY here). Cosine similarity alone is not enough — "lathe
     operator" and "lathe machine maintenance fitter" sit close together and mean
     different jobs, and a worker who says "kharad ka kaam, gears banata hun" needs
     someone to weigh two signals against a list. That judgement is what the model is
     for. It is also all it does.
  3. RE-VALIDATE (deterministic again). Whatever comes back is checked against the
     shortlist by id. A model that invents an id, or names a real domain that was not
     retrieved, is rejected outright — not corrected, rejected — and the profile stays
     unmatched.

INVARIANT #4 HOLDS, and this is the part worth being precise about. The model is
CLASSIFYING, not deciding: it picks which catalog row describes the worker. It does not
rank the worker, score them against a job, accept or reject them, or influence who sees
them. The matched domain is a descriptive label on a profile, exactly like the canonical
role id the extraction pass already assigns; the Reach Engine's ranking remains
deterministic and untouched.

UNMATCHED IS A REAL, ACCEPTABLE OUTCOME. Below the floor, no candidates, the model
declines, the seam is down, or the flag is off — each returns UNMATCHED with a distinct
reason, and none of them guesses. A worker with no domain is a worker we describe less
precisely; a worker with the WRONG domain is a worker we describe falsely, and that is
worse. The reason codes exist so the two are told apart in the data.

PRIVACY. The query text is built from the extracted profile's trade/skill/machine
phrases and passed through ``embed_text``, which pseudonymizes fail-closed before the
provider call (SG-2). The catalog itself is public reference data with no worker content
in it, so the retrieval leg carries nothing to leak.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Protocol

import httpx

from ..config import Settings
from ..contracts import JobDomainMatchStatus
from ..logging_config import get_logger

logger = get_logger("profiling.domain_match")

# Match statuses. These are the SAME closed vocabulary as the `job_domain_match_status`
# CHECK constraint on `worker_profiles` (packages/db/src/schema/worker.ts) — the column is what
# ops and the learn layer read, so a value invented here would be rejected at write time.
MATCHED_AUTO = "matched_auto"
MATCHED_LLM = "matched_llm"
UNMATCHED_BELOW_FLOOR = "unmatched_below_floor"
UNMATCHED_LLM_DECLINED = "unmatched_llm_declined"
UNMATCHED_DEGRADED = "unmatched_degraded"

_TIMEOUT = httpx.Timeout(5.0, connect=2.0)
_TOKEN_HEADER = "x-skills-internal-token"
# The api DTO caps k at 1..50 — clamp here too, so a mis-set DOMAIN_MATCH_TOP_K can
# never turn every lookup into a silent 400 -> [] -> UNMATCHED-everything.
_K_MIN, _K_MAX = 1, 50


@dataclass(frozen=True)
class DomainCandidate:
    """One retrieved catalog row. The LABEL is what the model reads; the ID is the answer."""

    job_domain_id: str
    label: str
    score: float


@dataclass
class DomainMatch:
    """The outcome. ``job_domain_id`` is non-None only on a MATCHED status."""

    #: Typed against the contract's closed vocabulary rather than `str`, so inventing a
    #: sixth code here is a type error at author time instead of a CHECK-constraint
    #: violation at the end of an async pipeline.
    status: JobDomainMatchStatus
    job_domain_id: str | None = None
    score: float | None = None
    #: The shortlist, for observability — ids + scores only, never worker text.
    considered: list[str] = field(default_factory=list)


class DomainStore(Protocol):
    """The retrieval seam. Implemented over HTTP because the ai-service has no DB
    driver and ``job_domain_alias`` is RLS-locked; the api runs the query."""

    def nearest_domains(self, query_vector: list[float], k: int) -> list[DomainCandidate]: ...


class NullDomainStore:
    """The inert store used when the seam is not configured. Returns nothing, so the
    match degrades to UNMATCHED rather than erroring — a half-configured deployment
    must not fail a worker's extraction."""

    def nearest_domains(self, query_vector: list[float], k: int) -> list[DomainCandidate]:
        return []


class HttpDomainStore:
    """``DomainStore`` over the api's ``POST /internal/domains/nearest`` route.

    Mirrors :class:`~app.ai.skill_store.HttpSkillStore` deliberately — same scoped
    credential, same short timeout, same fail-open posture. Slow is as good as down
    here: we degrade, we do not wait.
    """

    def __init__(self, base_url: str, token: str):
        self._base = base_url.rstrip("/")
        self._headers = {_TOKEN_HEADER: token}
        self._client = httpx.Client(timeout=_TIMEOUT)

    def nearest_domains(self, query_vector: list[float], k: int) -> list[DomainCandidate]:
        try:
            resp = self._client.post(
                f"{self._base}/internal/skills/nearest-domains",
                headers=self._headers,
                json={"vector": query_vector, "k": max(_K_MIN, min(_K_MAX, k))},
            )
            if resp.status_code != 200:
                raise RuntimeError(f"HTTP {resp.status_code}")
            out: list[DomainCandidate] = []
            for c in resp.json().get("candidates") or []:
                did, label, score = c.get("job_domain_id"), c.get("label"), c.get("score")
                if isinstance(did, str) and isinstance(label, str):
                    if isinstance(score, (int, float)):
                        out.append(DomainCandidate(did, label, float(score)))
            return out
        except Exception as exc:  # fail OPEN to UNMATCHED — never block extraction
            logger.warning(
                "domain_store nearest_domains failed (degrading to UNMATCHED)",
                extra={"extra": {"error": type(exc).__name__}},
            )
            return []


def get_domain_store(settings: Settings) -> DomainStore:
    """The store factory. Returns :class:`HttpDomainStore` only when the seam is fully
    configured; otherwise the inert :class:`NullDomainStore`, so a half-configured
    deployment degrades to "no domain" instead of erroring."""
    if settings.backend_api_url and settings.skills_internal_token:
        return HttpDomainStore(settings.backend_api_url, settings.skills_internal_token)
    return NullDomainStore()


# ---------------------------------------------------------------------------
# The query
# ---------------------------------------------------------------------------

#: Ordered by how much each says about the TRADE. A trade phrase alone is the strongest
#: signal; machines disambiguate ("lathe" + "gears" is different from "lathe" + "pipes");
#: skills fill in when the worker never named their trade at all, which is common —
#: "main setting karta hun, drawing padh leta hun" is a job description without a title.
_QUERY_MAX_TERMS = 12
_QUERY_MAX_CHARS = 400


def build_query_text(
    *,
    trade: str | None,
    skills: list[str] | None = None,
    machines: list[str] | None = None,
) -> str:
    """The retrieval query, in the worker's OWN vocabulary.

    NOT a prose summary, and that is a deliberate choice against the obvious design. An
    embedding of "The worker is a 28-year-old with five years of experience who prefers
    Pune and expects 25,000 rupees" is dominated by the biography; the two words that
    identify the trade are a rounding error in it. Salary, city, availability and
    experience are all excluded here for exactly that reason — they matter enormously to
    the resume and not at all to which occupation this is.

    Returns "" when there is nothing trade-shaped to search on, which the caller reads
    as "do not spend an embed call".
    """
    terms: list[str] = []
    seen: set[str] = set()
    for group in (trade, *(machines or []), *(skills or [])):
        for raw in [group] if isinstance(group, str) else []:
            term = " ".join(str(raw or "").split())
            key = term.lower()
            if not term or key in seen:
                continue
            seen.add(key)
            terms.append(term)
            if len(terms) >= _QUERY_MAX_TERMS:
                break
        if len(terms) >= _QUERY_MAX_TERMS:
            break
    return ", ".join(terms)[:_QUERY_MAX_CHARS]


# ---------------------------------------------------------------------------
# The pick
# ---------------------------------------------------------------------------

_PICK_SYSTEM = """You classify a worker's trade against a fixed occupation catalog.

You will be given the worker's own words describing their work, and a numbered shortlist
of catalog occupations. Choose the ONE that best describes what this worker actually
does for a living.

RULES
- Answer with an id from the shortlist, exactly as written. Never invent an id.
- If none of them genuinely describes this worker, answer null. A wrong match is worse
  than no match — do not stretch to fill the slot.
- Judge the WORK, not the seniority, the pay, or how skilled they sound.
- The worker's words may be Hinglish, misspelled, or a regional term for the trade.
  Read them for meaning, not spelling.

Reply with a single JSON object and nothing else:
{"job_domain_id": "<id from the list, or null>", "confidence": <0.0-1.0>}"""


def _pick_prompt(query_text: str, candidates: list[DomainCandidate]) -> list[dict[str, str]]:
    listing = "\n".join(
        f'{i + 1}. id="{c.job_domain_id}" — {c.label}' for i, c in enumerate(candidates)
    )
    return [
        {"role": "system", "content": _PICK_SYSTEM},
        {
            "role": "user",
            "content": f"Worker's own words:\n{query_text}\n\nShortlist:\n{listing}",
        },
    ]


def _parse_pick(raw: str) -> tuple[str | None, float]:
    """Read the model's answer. Anything unreadable is a DECLINE, never a guess."""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1] if "\n" in text else text
        text = text.rsplit("```", 1)[0].strip()
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return None, 0.0
    if not isinstance(data, dict):
        return None, 0.0
    did = data.get("job_domain_id")
    conf = data.get("confidence")
    score = float(conf) if isinstance(conf, (int, float)) else 0.0
    return (did if isinstance(did, str) and did else None), max(0.0, min(1.0, score))


async def match_domain(
    query_text: str,
    *,
    store: DomainStore,
    settings: Settings,
    router,  # AIRouter — untyped to avoid an import cycle through app.ai.router
    embed,  # Callable[[str, Settings], EmbeddingResult] — injected for testability
    user_ref: str | None = None,
    real_call_allowed: bool = True,
) -> DomainMatch:
    """Resolve ``query_text`` to one catalog domain, or return an honest UNMATCHED.

    Never raises. Every failure mode — flag off, empty query, blocked pseudonymization,
    seam down, nothing above the floor, an unreadable or hallucinated pick — lands on a
    distinct UNMATCHED reason. Extraction must never fail because a classification did.
    """
    if not settings.domain_match_enabled:
        return DomainMatch(status=UNMATCHED_DEGRADED)
    if not query_text.strip():
        # Nothing trade-shaped was extracted. Do not spend an embed call to search for
        # a worker we know nothing about yet.
        return DomainMatch(status=UNMATCHED_DEGRADED)

    # SG-2: pseudonymize + embed, fail closed. A blocked query still holds whatever
    # residual PII blocked it, so it must not be embedded OR retried in the clear.
    emb = embed(query_text, settings)
    if emb.blocked or emb.vector is None:
        logger.warning("domain match blocked by pseudonymize gate")
        return DomainMatch(status=UNMATCHED_DEGRADED)

    candidates = store.nearest_domains(emb.vector, settings.domain_match_top_k)
    if not candidates:
        return DomainMatch(status=UNMATCHED_DEGRADED)

    considered = [c.job_domain_id for c in candidates]
    top = max(candidates, key=lambda c: c.score)

    # THE FLOOR IS A PRE-FILTER, NOT A TIE-BREAK. If the best alias in the whole catalog
    # is this far from the worker's words, the shortlist is noise and asking a model to
    # choose from it would produce a confident answer to an unanswerable question — the
    # exact failure that puts a cook in "Metal Working Machine Tool Setter".
    if top.score < settings.domain_match_floor:
        logger.info(
            "domain match below floor",
            extra={"extra": {"top": round(top.score, 4), "floor": settings.domain_match_floor}},
        )
        return DomainMatch(status=UNMATCHED_BELOW_FLOOR, considered=considered)

    # A single overwhelming candidate needs no model. Cheaper, deterministic, and
    # reproducible — and it is recorded as `matched_auto` so the two paths stay
    # distinguishable in the data rather than being quietly merged.
    runner_up = max((c.score for c in candidates if c is not top), default=0.0)
    clear_winner = (
        top.score >= settings.domain_match_auto_floor
        and top.score - runner_up >= settings.domain_match_auto_margin
    )
    if clear_winner:
        return DomainMatch(
            status=MATCHED_AUTO,
            job_domain_id=top.job_domain_id,
            score=round(top.score, 6),
            considered=considered,
        )

    # REUSE the masked text the embed already produced, rather than pseudonymizing the
    # same string a second time. `embed_text` returns it precisely so callers do not
    # re-run the gate, and it makes the two legs PROVABLY see the same string.
    #
    # Re-calling `pseudonymize(query_text).text` here would have been the subtle bug: on
    # a blocked result pseudonymize does NOT return an empty string — for the
    # residual-digit path it returns the PARTIALLY masked text with the offending run
    # still in it. Reading `.text` without checking `.blocked` would therefore hand a
    # provider exactly the content that tripped the gate. It happens to be unreachable
    # today because the embed above already returned on `emb.blocked`, but that is an
    # upstream accident, not a gate in front of this call — and invariant #3 asks for the
    # latter. `emb.text` is non-None here by construction: `emb.blocked` is False.
    raw, _meta = await router.run(
        "domain_match",
        messages=_pick_prompt(emb.text or "", candidates),
        # The router never raises; its mock path must therefore be a valid DECLINE
        # rather than a guess, so an unreachable provider leaves the profile unmatched.
        mock_response='{"job_domain_id": null, "confidence": 0.0}',
        real_call_allowed=real_call_allowed,
        user_ref=user_ref,
    )
    picked_id, confidence = _parse_pick(raw)

    if picked_id is None:
        return DomainMatch(status=UNMATCHED_LLM_DECLINED, considered=considered)

    # RE-VALIDATION. The pick must be one of the ids we actually sent. A model naming a
    # real-but-not-retrieved domain is rejected exactly like one naming a fabricated
    # domain: in both cases the answer did not come from the retrieval, so it did not
    # come from the evidence.
    match = next((c for c in candidates if c.job_domain_id == picked_id), None)
    if match is None:
        logger.warning(
            "domain match rejected a hallucinated id",
            extra={"extra": {"shortlist": len(candidates)}},
        )
        return DomainMatch(status=UNMATCHED_LLM_DECLINED, considered=considered)

    # The recorded score is the RETRIEVAL similarity, not the model's self-reported
    # confidence. One is measured, the other is asserted; only the measured one belongs
    # in a column that later analysis will threshold on.
    return DomainMatch(
        status=MATCHED_LLM,
        job_domain_id=match.job_domain_id,
        score=round(match.score, 6),
        considered=considered,
    )
