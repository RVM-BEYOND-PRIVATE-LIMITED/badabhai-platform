STATUS: BLOCKED — R1 IS UNSIGNED AND THE PHASE-ORDER GATE IS SHUT. Do not write a migration.
R1's signature line is blank dots at docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md:388, and
the `function` vocabulary is exactly what R1 decides — choosing it is BUILD_RULES:31, a full
stop. Separately, docs/agent/README.md:47 forbids starting until the previous VERDICT says
PASS; docs/qa/evidence/ holds only P0 (line 1 = FAIL) and PX. P1 and P2 have no VERDICT.
The correct outcome of a session today is HALT. Read the rest so the HALT report is specific,
then stop.

Corrected 2026-09-03 against the files this brief names. Statements that were wrong when issued
are removed, not annotated.

PHASE P3 — add function and collar_tier columns. PLAN MODE. Changes the database.

Show me the plan first. Today the plan is the HALT report.

Add to worker_skill — SINGULAR. The SQL table is "worker_skill"
(packages/db/migrations/0053_worker_skills_and_tenure.sql:59; packages/db/src/schema/match.ts:35).
The Drizzle export is `workerSkills`, which is what misleads people.
  function     NULLABLE
  collar_tier  NULLABLE
Add to job_postings — that plural IS correct (packages/db/src/schema/job.ts:62).
  function_required  NULLABLE
  collar_tier_min    NULLABLE

NOT AN ENUM. This repository has no Postgres enum type and never has — zero `create type`
across packages/db/migrations/0000-0098, case-insensitive. Text plus a TS `$type<...>()` union
is the stated convention (packages/db/src/schema/index.ts:7-9); the CHECK is the authority and
the union is its TypeScript view (packages/db/src/worker-feedback-schema.test.ts:271-273).
There is also no ALTER TYPE DROP VALUE, so an enum has no rollback path — which collides with
the rollback required below. Write each CHECK so NULL is permitted explicitly, the shipped shape
at worker-feedback-schema.test.ts:278-280:
  CHECK ("t"."col" IS NULL OR "t"."col" IN (...))

collar_tier_min is a MINIMUM over an ordered four-rung scale, and "min" over a text label is not
evaluable. The shipped ordered-nullable-scale pattern is an ordinal smallint with a nullable
range CHECK (packages/db/src/schema/occupation.ts:201-204). Both collar columns must use ONE
representation — a label in one table and an ordinal in the other needs a mapping that lives in
no file. Choose one for both, and say which.

READ THIS TWICE.
Do NOT fill old rows. Filling them invents data about real workers who never said it. Every
existing row backfills to NULL. Any DEFAULT, or any UPDATE that fills one of the four columns,
is a HALT. Whether a blank `function` should default to `operator` at CAPTURE time is R1
sub-question (iii) — worksheet:378-386, answer line blank. Carry it to the HALT report; do not
answer it. This is the migration-time form of a rule the table already enforces on every write:
apps/api/src/match/worker-skills.repository.ts:187-188 scopes the upsert with
`setWhere: eq(workerSkills.source, "derived_coarse")` under the comment "NEVER overwrite what a
worker or an ops human actually said."

VOCABULARY — transcribed in-repo at RVM_TAXONOMY_WORKSHEET_2026-09.md:38-56: nine function
values (43-44), `setter_programmer` PROPOSED and not locked (50), four collar tiers lowest to
highest (56). No TS constant for either exists on main (grepped COLLAR_TIER, collarTier,
FUNCTION_VALUES, setter_programmer under packages/ and apps/ — zero hits). Writing that constant
out IS the R1 settlement, so it is blocked with the rest of the phase. Cite in-repo files only.
A level is an attribute of one role, never a role of its own (BUILD_RULES:12).

MIGRATION NUMBER: main stops at 0098 and _journal.json ends at idx 98. 0099 is already claimed
by PR #1387 (0099_overrated_fantastic_four.sql on origin/p1-matching-catalog). Re-derive against
main at your HEAD.

SCOPE: ADR-0036:61 closes the rank key — "Nothing else may enter the rank". These four columns
are schema. Wiring one into ranking or visibility is a separate ruling, not this phase.

DELIVER — none of it reachable until R1 is signed.
 1. The migration FILE, its packages/db/migrations/meta/_journal.json entry, and its
    NNNN_snapshot.json. Generate all three with drizzle-kit generate; never hand-write the
    snapshot. The entry's `when` MUST exceed every earlier entry's or drizzle skips the file
    silently and permanently (packages/db/src/migration-adoption.test.ts:556-568); a file with
    no journal entry applies nothing at all. Rollback path in the same file. Prakash applies it
    (BUILD_RULES:21) — no db:push, no drizzle-kit migrate, no psql DDL.
 2. The Drizzle changes in packages/db/src/schema/match.ts and .../job.ts.
 3. A test under packages/db/src that READS THE MIGRATION FILE'S TEXT: it fails if a DEFAULT or
    a backfill UPDATE appears on any of the four columns, and pins each CHECK's value list
    against the `$type` union declared in (2). Pattern: worker-feedback-schema.test.ts:39 and
    276-283. No database needed. Without it CHECK_RULES:31 fails this phase.

INVARIANT: no existing row gets a value in any of the four new columns that it did not supply —
the migration adds all four with no DEFAULT and no backfill UPDATE, so every pre-existing row
is NULL.
