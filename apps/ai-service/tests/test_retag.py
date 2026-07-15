"""ADR-0030 / TAX-9 offline re-tag plan tests (`pytest -k retag`).

Locked properties:
- chain resolution to the TERMINAL id (A→B→C ⇒ A and B both map to C, hops counted),
- cycles are fail-safe: every id on the cycle is DROPPED (never re-tagged),
- substitution de-duplicates first-seen (the canonicalize_labels rule),
- untouched rows are NEVER listed (no dedup-only rewrites),
- SG-5: every output id is an input id or a crosswalk terminal — nothing invented,
- determinism, caps, endpoint round trip.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.ai.retag import plan_retag, resolve_crosswalk
from app.contracts import (
    RetagCrosswalkEntry,
    RetagPlanInput,
    RetagRow,
)
from app.main import app


def xw(*pairs: tuple[str, str]) -> list[RetagCrosswalkEntry]:
    return [RetagCrosswalkEntry(deprecated_id=a, replaced_by=b) for a, b in pairs]


def row(ref: str, ids: list[str]) -> RetagRow:
    return RetagRow(row_ref=ref, skill_ids=ids)


def plan(crosswalk, rows):
    return plan_retag(RetagPlanInput(crosswalk=crosswalk, rows=rows))


class TestRetagCrosswalk:
    def test_single_edge_resolves(self):
        resolved, dropped = resolve_crosswalk({"skill_old": "skill_new"})
        assert resolved == {"skill_old": ("skill_new", 1)}
        assert dropped == []

    def test_chain_resolves_to_terminal_with_hops(self):
        resolved, dropped = resolve_crosswalk({"a": "b", "b": "c"})
        assert resolved == {"a": ("c", 2), "b": ("c", 1)}
        assert dropped == []

    def test_cycle_drops_every_member_fail_safe(self):
        resolved, dropped = resolve_crosswalk({"a": "b", "b": "a", "x": "y"})
        assert "a" not in resolved and "b" not in resolved
        assert dropped == ["a", "b"]
        assert resolved["x"] == ("y", 1)

    def test_self_cycle_dropped(self):
        resolved, dropped = resolve_crosswalk({"a": "a"})
        assert resolved == {}
        assert dropped == ["a"]


class TestRetagPlan:
    def test_substitutes_and_dedupes_first_seen(self):
        out = plan(
            xw(("skill_old", "skill_new")),
            [row("r1", ["skill_new", "skill_old", "skill_other"])],
        )
        (c,) = out.changes
        assert c.after == ["skill_new", "skill_other"]  # old→new deduped onto the earlier new

    def test_untouched_rows_are_not_listed_even_with_internal_dupes(self):
        out = plan(
            xw(("skill_old", "skill_new")),
            [row("r1", ["skill_a", "skill_a"]), row("r2", ["skill_b"])],
        )
        assert out.changes == []
        assert out.rows_in == 2 and out.rows_changed == 0

    def test_chain_applies_terminal_not_intermediate(self):
        out = plan(xw(("a", "b"), ("b", "c")), [row("r1", ["a"]), row("r2", ["b"])])
        assert [c.after for c in out.changes] == [["c"], ["c"]]

    def test_cyclic_ids_left_untouched_in_rows(self):
        out = plan(xw(("a", "b"), ("b", "a")), [row("r1", ["a", "b", "z"])])
        assert out.changes == []
        assert out.dropped == ["a", "b"]

    def test_sg5_never_invents_an_id(self):
        crosswalk = xw(("old1", "new1"), ("old2", "new2"))
        rows = [row("r1", ["old1", "keep"]), row("r2", ["old2", "old1"])]
        out = plan(crosswalk, rows)
        allowed = {"old1", "old2", "keep", "new1", "new2"}
        for c in out.changes:
            assert set(c.after) <= allowed
            # And specifically: only input ids or crosswalk terminals.
            for skill_id in c.after:
                assert skill_id in {"keep", "new1", "new2"}

    def test_deterministic_resolved_order(self):
        out1 = plan(xw(("b", "t"), ("a", "t")), [])
        out2 = plan(xw(("a", "t"), ("b", "t")), [])
        assert [r.model_dump() for r in out1.resolved] == [r.model_dump() for r in out2.resolved]

    def test_caps_enforced(self):
        with pytest.raises(ValidationError):
            RetagPlanInput(crosswalk=xw(*[(f"d{i}", "t") for i in range(1001)]), rows=[])
        with pytest.raises(ValidationError):
            RetagRow(row_ref="r", skill_ids=[f"s{i}" for i in range(101)])


class TestRetagEndpoint:
    def test_round_trip(self):
        client = TestClient(app)
        resp = client.post(
            "/skills/retag-plan",
            json={
                "crosswalk": [{"deprecated_id": "skill_old", "replaced_by": "skill_new"}],
                "rows": [
                    {"row_ref": "11111111-1111-1111-1111-111111111111", "skill_ids": ["skill_old"]},
                    {"row_ref": "22222222-2222-2222-2222-222222222222", "skill_ids": ["skill_x"]},
                ],
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["rows_in"] == 2
        assert data["rows_changed"] == 1
        assert data["changes"][0]["after"] == ["skill_new"]
        assert data["resolved"] == [
            {"deprecated_id": "skill_old", "terminal_id": "skill_new", "hops": 1}
        ]
