"""`/profile/extract` — the S3-C read switch, and the miss it finally records.

THE SWITCH IS THE REQUEST SHAPE, not a flag: `phase-9-s3-deployment-plan.md` defines it as
*which field the caller populates*. So there is nothing here to toggle and nothing to unwind
— `job_domain_id` present selects Path A (candidates through `job_domain_skill`), absent
leaves Path B (the configured legacy slug), and the second case is every caller today.

WHY THIS FILE IS THE ONE THAT MATTERED. The seam below `/profile/extract` was S3-C-ready on
both ends and pinned in the middle: `canonicalize_labels` accepted `job_domain_id`, the api's
`/internal/skills/unresolved` accepted it, migration 0078 gave `unresolved_phrase` the column
— and `ProfileExtractionInput` had no such field while `record_unresolved` had no such
parameter. Flipping the switch would have dropped every Path A miss before it reached the one
table built to catch misses, which is also the table the S3-D abort thresholds are derived
from. The last two assertions in this file are that circle closing.

Zero network, zero database: the store is a fake and the extraction runs in mock mode.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import main as app_main
from app.config import Settings
from app.contracts import ProfileExtractionInput
from app.routers import profile as profile_router

JOB_DOMAIN = "jd_welding"
TRANSCRIPT = "I know cnc programming and setting"


class RecordingStore:
    """Records the SCOPE of every search and every miss. Both methods carry the
    keyword-only `job_domain_id`, i.e. a store written after the cutover."""

    def __init__(self, candidates: list[tuple[str, float]] | None = None) -> None:
        self.candidates = candidates or []
        self.searches: list[dict[str, object]] = []
        self.unresolved: list[dict[str, object]] = []

    def nearest_aliases(self, domain_id, query_vector, k, *, job_domain_id=None):
        self.searches.append({"domain_id": domain_id, "job_domain_id": job_domain_id})
        return self.candidates

    def record_unresolved(self, phrase, domain_id, lang, *, job_domain_id=None):
        self.unresolved.append(
            {"phrase": phrase, "domain_id": domain_id, "job_domain_id": job_domain_id}
        )


def _client(monkeypatch, store: RecordingStore, **overrides) -> TestClient:
    enabled = Settings(skill_canonicalize_enabled=True, **overrides)
    monkeypatch.setattr(profile_router, "settings", enabled)
    monkeypatch.setattr(profile_router, "get_skill_store", lambda s: store)
    return TestClient(app_main.app)


def _extract(client: TestClient, **extra) -> dict:
    resp = client.post("/profile/extract", json={"transcript": TRANSCRIPT, **extra})
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# 1. The contract
# ---------------------------------------------------------------------------
def test_the_field_defaults_to_absent_so_every_existing_caller_is_unchanged():
    assert ProfileExtractionInput(transcript=TRANSCRIPT).job_domain_id is None


def test_an_empty_job_domain_id_is_REJECTED_rather_than_treated_as_absent():
    """`exactly_one_skill_scope` tests PRESENCE, not truthiness — deliberately, so that a
    caller who means "this domain" and passes a slug owning no aliases gets an honest
    UNRESOLVED. That same rule makes `""` dangerous here: it would read as a supplied
    canonical scope, scope Path A to nothing, and file every miss under an empty id. The
    bound rejects it at the contract instead, matching the Zod mirror's `.min(1)`."""
    with pytest.raises(ValueError):
        ProfileExtractionInput(transcript=TRANSCRIPT, job_domain_id="")


# ---------------------------------------------------------------------------
# 2. The switch selects the path
# ---------------------------------------------------------------------------
def test_omitting_job_domain_id_leaves_the_legacy_scope_byte_identical(monkeypatch):
    """Path B, and the assertion is on the SCOPE PAIR rather than on the slug alone: the
    regression that matters is not "the wrong slug" but "a canonical scope leaked onto a
    caller that never asked for one"."""
    store = RecordingStore()
    default_slug = Settings().skill_canonicalize_default_domain

    _extract(_client(monkeypatch, store))

    assert store.searches
    assert all(s == {"domain_id": default_slug, "job_domain_id": None} for s in store.searches)


def test_supplying_job_domain_id_scopes_the_whole_pass_to_path_a(monkeypatch):
    """Path A. `domain_id` is None on every search, not the configured default — exactly-one
    scope is what `canonicalize_skill` requires, and sending both would refuse every label
    before its embed."""
    store = RecordingStore()

    _extract(_client(monkeypatch, store), job_domain_id=JOB_DOMAIN)

    assert store.searches
    assert all(s == {"domain_id": None, "job_domain_id": JOB_DOMAIN} for s in store.searches)


def test_the_switch_does_not_touch_the_RAG_domain_match_pass(monkeypatch):
    """`job_domain_id` scopes canonicalization and nothing else. The `DOMAIN_MATCH_ENABLED`
    pass DECIDES the worker's trade, so handing it the answer would make its output a
    restatement of the request — and `job_domain_match` must stay a measurement."""
    store = RecordingStore()

    body = _extract(_client(monkeypatch, store), job_domain_id=JOB_DOMAIN)

    # The flag is off, so the pass did not run at all — and it stays null rather than being
    # back-filled from the request.
    assert body["job_domain_match"] is None


# ---------------------------------------------------------------------------
# 3. THE MISS — the reason this wiring is a blocker and not a nicety
# ---------------------------------------------------------------------------
def test_a_path_a_miss_on_the_extract_path_is_recorded_under_its_job_domain_id(monkeypatch):
    """THE CIRCLE CLOSING. Before this wiring a Path A miss on `/profile/extract` produced
    nothing anywhere: `record_unresolved` had no `job_domain_id` parameter and `_safe_record`
    hard-returned on a null legacy domain. Flipping the read switch would therefore have made
    every Path A failure invisible in `unresolved_phrase` — the table built to catch failures,
    and the source of the volume signal the S3-D abort thresholds are derived from."""
    store = RecordingStore(candidates=[])  # nothing in this domain's vocabulary yet

    _extract(_client(monkeypatch, store), job_domain_id=JOB_DOMAIN)

    assert store.unresolved, "a Path A miss must reach the queue"
    for row in store.unresolved:
        assert row["job_domain_id"] == JOB_DOMAIN
        assert row["domain_id"] is None, "a jd_* id must never reach the legacy slug column"


def test_a_legacy_miss_on_the_extract_path_is_recorded_exactly_as_before(monkeypatch):
    """The regression pin for the only path reachable in production today."""
    store = RecordingStore(candidates=[])
    default_slug = Settings().skill_canonicalize_default_domain

    _extract(_client(monkeypatch, store))

    assert store.unresolved
    for row in store.unresolved:
        assert row["domain_id"] == default_slug
        assert row["job_domain_id"] is None


def test_a_path_a_match_still_lands_only_vector_assigned_ids_in_the_profile(monkeypatch):
    """SG-3 under the canonical scope: the id came from the store's closed set, and the raw
    label never becomes an id."""
    store = RecordingStore(candidates=[("skill_program_editing", 0.95)])

    body = _extract(_client(monkeypatch, store), job_domain_id=JOB_DOMAIN)

    assert "skill_program_editing" in body["profile"]["skills"]
    assert "program editing" not in body["profile"]["skills"]
    assert store.unresolved == []


# ---------------------------------------------------------------------------
# 4. Observability — a trace that names the WRONG path is worse than no trace
# ---------------------------------------------------------------------------
class _RecordingObservation:
    def update(self, **fields):
        return None


class _RecordingTracer:
    def __init__(self) -> None:
        self.tasks: list[dict] = []

    def task(self, **kwargs):
        self.tasks.append(kwargs)

        class _Ctx:
            def __enter__(self_inner):
                return _RecordingObservation()

            def __exit__(self_inner, *exc):
                return False

        return _Ctx()


def _trace_input(monkeypatch, store: RecordingStore, **extra) -> dict:
    tracer = _RecordingTracer()
    client = _client(monkeypatch, store)
    monkeypatch.setattr(profile_router, "get_tracer", lambda: tracer)
    _extract(client, **extra)
    batch = [t for t in tracer.tasks if t.get("task_type") == "skill_canonicalization_batch"]
    assert len(batch) == 1
    return batch[0]["input"]


def test_the_trace_names_the_canonical_scope_when_that_is_what_ran(monkeypatch):
    """It used to report `settings.skill_canonicalize_default_domain` unconditionally. On a
    canonical-scoped pass that is not merely incomplete — it is affirmative evidence for the
    wrong path, which is the failure mode an operator cannot recover from by looking harder."""
    traced = _trace_input(monkeypatch, RecordingStore(), job_domain_id=JOB_DOMAIN)

    assert traced["job_domain_id"] == JOB_DOMAIN
    assert traced["domain_id"] is None


def test_the_trace_still_names_the_legacy_slug_on_the_legacy_path(monkeypatch):
    traced = _trace_input(monkeypatch, RecordingStore())

    assert traced["domain_id"] == Settings().skill_canonicalize_default_domain
    assert traced["job_domain_id"] is None


def test_the_trace_carries_a_count_and_never_a_label(monkeypatch):
    """PII posture, unchanged by the cutover: the batch trace carries the number of labels
    and two catalog ids, never the labels themselves."""
    traced = _trace_input(monkeypatch, RecordingStore(), job_domain_id=JOB_DOMAIN)

    assert isinstance(traced["labels"], int)
    assert set(traced) == {"labels", "domain_id", "job_domain_id"}
