---
name: bb-database-design
description: Design a schema or migration change in Drizzle (packages/db) safely — correct types, indexes, PII placement, and backward-compatible migrations on Supabase Postgres. Use during the Database stage before dependent code is written.
---

# Skill: Database Design

**Goal.** Produce a correct, indexed, backward-compatible schema change with the
PII boundary intact.

**Inputs.** The data need; the current Drizzle schema (`packages/db/src/schema.ts`,
the source of truth) and migrations; the 10 Phase-1 tables; the query patterns.

**Process.**
1. Model the change in Drizzle — tables, columns, types, constraints, relations.
2. Place PII correctly: direct PII (phone, full name, …) only in `workers`;
   `events`/`ai_jobs`/`audit_logs` get ids/hashes only.
3. Add indexes for every new query/filter/join path.
4. Generate the migration (`pnpm db:generate`); read the emitted SQL.
5. Assess safety: backward-compatible? expand→migrate→contract for risky changes?
   reversible, or a written data plan?
6. Note rollback + any tech-debt; update schema docs.

**Checklist.**
- [ ] No PII outside `workers`.
- [ ] New query paths are indexed.
- [ ] Migration generated from Drizzle (not hand-written) and SQL reviewed.
- [ ] Backward-compatible or has a written migration/rollback plan.
- [ ] Referential integrity / constraints correct.
- [ ] Schema docs / architecture log updated if shape changed.

**Expected Output.** Updated Drizzle schema, a reviewed migration file, index
decisions, and a backward-compatibility + rollback note.

**Failure Conditions.** PII placed outside `workers`; hand-edited migration that
drifts from the schema; destructive/irreversible change with no plan; missing
index on a hot path; applying to a shared DB without sign-off.
