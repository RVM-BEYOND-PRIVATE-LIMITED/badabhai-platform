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
