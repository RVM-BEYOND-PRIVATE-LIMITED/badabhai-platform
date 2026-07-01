# DB verifiers

Read-only assertion scripts that prove a migration's data invariants hold against a live
DB. They do **not** run in CI's default suite (they need a migrated DB + `DATABASE_URL`);
run them after `pnpm db:migrate` against the target DB.

## `0034_org_id_backfill` — ADR-0027 B5.x Increment 0

Proves migration `0034_wonderful_nico_minoru.sql` (additive `org_id` on the 9 payer-owned
tables) backfilled correctly and its constraints hold.

Asserts:

- **(a)** ZERO `NULL org_id` on the 7 `NOT NULL` tables (`unlocks`, `payer_credits`,
  `credit_ledger`, `posting_plans`, `posting_boosts`, `payer_capacity`,
  `resume_disclosures`).
- **(b)** every `org_id` = `payer_orgs.id WHERE root_payer_id = payer_id` (backfill is
  correct), across all 9 tables; and on the 2 nullable-payer tables (`job_postings`,
  `jobs`) a `NULL payer_id` (ops/seed) row keeps `NULL org_id`.
- **(c)** org-scoped uniqueness holds: no duplicate `(org_id, worker_id)` in `unlocks`,
  no duplicate `(org_id, worker_id, job_posting_id)` in `resume_disclosures`.

### Run

Two equivalent forms (run either):

```bash
# TS twin (uses the drizzle client; loads repo-root .env like the other db scripts):
DATABASE_URL=<db> pnpm --filter @badabhai/db db:verify:org-id

# Pure-SQL (psql; RAISEs on the first violation, exits non-zero):
DATABASE_URL=<db> pnpm --filter @badabhai/db db:verify:org-id:sql
#   or directly:
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f verify/0034_org_id_backfill.sql
```

### Note on results

At the time this was authored, **no `DATABASE_URL` was reachable in the build environment**
(`localhost:5432` was open but the loaded env carried no connection string), so these
assertions were **authored but not executed against real data — no results are claimed**.
Run one of the commands above against the migrated staging/local DB to get a real PASS/FAIL.

On an **empty** DB (no `payer_orgs`, no payer-owned rows), every assertion is vacuously true
— that is a genuine PASS (nothing to backfill), not a skipped check.
