STATUS: CLOSED 2026-09-05 — superseded by the E-chain (docs/decisions/E_CHAIN_DESIGN_2026-09.md).
Do not build from this file without reopening the phase.

WHAT NO E-PHASE COVERS — dropped visibly, not quietly. Each survived an adversarial
refutation pass (already-ships / an-E-phase-covers-it / a-signed-ruling-deleted-it):
  - The `matching_catalog` table — migration, Drizzle schema, repository. Built on
    `origin/p1-matching-catalog` (a454fac0), whose PR #1387 is CLOSED AND UNMERGED
    (2026-09-04). No E-phase creates any taxonomy config table; ADR-0036 §8's
    `match_config` holds nine SCALARS and no taxonomy.
  - The publish-time validator that names the exact bad field, plus the versioned Zod
    catalog schema — i.e. this phase's INVARIANT, "an invalid catalog can never become
    the active one". Nothing on main validates a taxonomy blob.
  - Taxonomy as PUBLISHED CONFIG rather than a compiled constant — a role/family/domain
    registry an RVM sign-off can change without a deploy. E1 reads a compile-time
    constant instead, which is the opposite arrangement.

------------------------------------------------------------------------------
PHASE-ID: P1
INVARIANT: an invalid catalog can never become the active one.

EXPECTED ARTIFACTS: a matching_catalog migration file, Drizzle schema, a Zod schema
in packages/, a publish-time validator, and guarded read/publish endpoints.
If these do not exist, VERDICT is FAIL, reason "phase not built". Stop there.

Do these checks and paste raw output for each:
1. Run git diff. Confirm the migration is a file and was never executed.
   Search shell history for db:push, drizzle-kit migrate, or psql DDL.
   Any hit is a FAIL.
2. Against live Postgres, run \d matching_catalog. Confirm the "only one active row"
   rule is a real database constraint. If it is only checked in application code,
   that is a FAIL.
3. Hand-build four invalid catalogs:
     one with an adjacency edge pointing at an unknown role_id
     one with a multiplier of 1.4
     one with a role that has no family
     one with a function value not in the locked list
   Try to publish each. All four must be rejected, and each rejection must name the
   exact bad field. Any acceptance is a FAIL. An unhelpful message is worth reporting.
4. Confirm the seeded fixture has is_active = false.
5. Call the read and publish endpoints with no authentication. Both must refuse.
   Paste the curl commands and responses.
