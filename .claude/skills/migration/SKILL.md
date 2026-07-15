---
name: migration
description: Safe Supabase/Drizzle database migration workflow — Drizzle is the source of truth, Supabase CLI is tooling only. Naming, expand→migrate→contract, RLS, rollback, single shared Supabase DB discipline. Use during the Database stage; pairs with bb-database-design.
---

# Skill: Migration (Supabase / Drizzle)

**Goal.** Land a schema change that is correct, indexed, backward-compatible, RLS-safe, and
reversible — without ever applying an unreviewed or destructive migration to the shared Supabase DB
(the single `main` DB — the only one, so a mistake has no separate environment to catch it).

**Authority model (do not violate).**

- **Drizzle (`packages/db/src/schema.ts`) is the single source of truth.** Generate migrations from
  it; never hand-write SQL that drifts from the schema.
- **Supabase CLI is tooling only** (login / link / type-gen / lint / local stack). Do **not** use
  `supabase db push` as a second migration authority — it bypasses Drizzle.

**Inputs.** The data need; current schema + `packages/db/migrations`; query patterns; the
[RLS plan](../../../infra/supabase/rls-plan.md); the [migration plan](../../../infra/supabase/migration-plan.md).

**Process.**

1. Model the change in Drizzle; place PII only in `workers` (events / ai_jobs / audit_logs carry
   ids/hashes only).
2. `pnpm db:generate`; **read the emitted SQL** — confirm it matches intent and indexes every new
   query/filter/join path.
3. Classify safety: backward-compatible? If risky, use **expand → migrate → contract** (add new,
   backfill, switch reads, drop old in a later migration). Never drop/rename an in-use column in
   one step.
4. RLS: if a protected table is touched, update/confirm policies and the RLS test.
5. Write the **rollback** (revert code + data/migration considerations) in the PR.
6. Validate the full chain in **CI** (a throwaway per-run Postgres container, applied from scratch on
   every PR — never the real DB). Then apply to the **one Supabase DB** (the `main`, the only database)
   deliberately: backward-compatible, with a **backup + human sign-off** for anything risky — there is
   no second environment to catch a mistake.
7. Update schema docs / architecture log.

**Naming.** Keep Drizzle's generated `NNNN_name.sql` sequence; reconcile (don't renumber) on merge;
one logical change per migration.

**Checklist.**

- [ ] Modeled in Drizzle; migration generated (not hand-written); SQL reviewed.
- [ ] No PII outside `workers`; new query paths indexed.
- [ ] Backward-compatible, or expand→migrate→contract with a written data plan.
- [ ] RLS policies + test updated if a protected table changed.
- [ ] Rollback written; CI migration chain green; risky changes have a backup + sign-off before the shared DB.

**Expected Output.** Updated Drizzle schema, a reviewed migration, index/RLS decisions, and a
backward-compatibility + rollback note.

**Failure Conditions.** Hand-edited/drifted SQL; `supabase db push` as authority; destructive change
with no plan; PII outside `workers`; applying a risky migration to the shared Supabase DB without a backup + sign-off.

**See also.** [`bb-database-design`](../bb-database-design/SKILL.md) ·
[`bb-deployment`](../bb-deployment/SKILL.md) · agents
[`database-architect`](../../agents/database-architect.md),
[`migration-reviewer`](../../agents/migration-reviewer.md).
