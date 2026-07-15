"""Offline skill re-tag planning (ADR-0030 / TAX-9) — PURE COMPUTE, dry-run first.

When a skill is deprecated with a successor (``skill.replaced_by`` — the crosswalk),
already-stored rows (``worker_profiles.skills``, ``job_postings.skill_ids``) still carry
the deprecated id. TAX-9 discipline: ids are immutable/never reused (SG-5), so change is
expressed as **status transition + crosswalk + OFFLINE re-tag** — never a live-path
rewrite. This module computes the re-tag PLAN:

- **Crosswalk resolution:** ``replaced_by`` chains (A→B→C) resolve to the TERMINAL id.
  A cycle (A→B→A) is fail-safe: every id in it is DROPPED from the plan (reported in
  ``dropped`` — those rows keep their current ids until a human fixes the corpus).
- **Substitution:** each row's ids are mapped through the resolved crosswalk;
  results are de-duplicated in first-seen order (the ``canonicalize_labels`` rule).
  A row appears in ``changes`` only if its ids actually change.
- **SG-3/SG-5:** the plan never invents an id — every output id is either an untouched
  input id or a crosswalk terminal supplied by the caller (the db-side runner reads both
  from the ``skill`` table on the owner connection; the ai-service stays DB-free).

``row_ref`` is an opaque row uuid — no PII enters or leaves this computation. The
db-side runner (``packages/db/src/retag-skills.ts``) applies the plan (``--apply``)
after a human reads the dry-run report.
"""

from __future__ import annotations

from ..contracts import (
    RetagChange,
    RetagPlanInput,
    RetagPlanOutput,
    RetagResolvedEntry,
)


def resolve_crosswalk(
    entries: dict[str, str],
) -> tuple[dict[str, tuple[str, int]], list[str]]:
    """Resolve every deprecated id to its TERMINAL successor: ``{deprecated_id:
    (terminal_id, hops)}``. Ids on a cycle are dropped (fail-safe — no re-tag), returned
    sorted for determinism."""
    resolved: dict[str, tuple[str, int]] = {}
    dropped: set[str] = set()
    for start in entries:
        path: list[str] = []
        seen: set[str] = set()
        cur = start
        cyclic = False
        while cur in entries:
            if cur in seen:
                cyclic = True
                break
            seen.add(cur)
            path.append(cur)
            cur = entries[cur]
        if cyclic:
            dropped.update(path)
            continue
        # cur is now terminal (not a crosswalk key). hops counts edges from each node.
        for i, node in enumerate(path):
            resolved[node] = (cur, len(path) - i)
    for d in dropped:
        resolved.pop(d, None)
    return resolved, sorted(dropped)


def plan_retag(inp: RetagPlanInput) -> RetagPlanOutput:
    """Compute the re-tag plan. Deterministic; no side effects; never invents an id."""
    entries = {e.deprecated_id: e.replaced_by for e in inp.crosswalk}
    resolved, dropped = resolve_crosswalk(entries)

    changes: list[RetagChange] = []
    for row in inp.rows:
        after: list[str] = []
        touched = False
        for skill_id in row.skill_ids:
            mapped = resolved.get(skill_id)
            new_id = skill_id if mapped is None else mapped[0]
            if new_id != skill_id:
                touched = True
            if new_id not in after:
                after.append(new_id)
        if touched and after != list(row.skill_ids):
            changes.append(
                RetagChange(row_ref=row.row_ref, before=list(row.skill_ids), after=after)
            )

    return RetagPlanOutput(
        resolved=[
            RetagResolvedEntry(deprecated_id=k, terminal_id=v[0], hops=v[1])
            for k, v in sorted(resolved.items())
        ],
        dropped=dropped,
        changes=changes,
        rows_in=len(inp.rows),
        rows_changed=len(changes),
    )
