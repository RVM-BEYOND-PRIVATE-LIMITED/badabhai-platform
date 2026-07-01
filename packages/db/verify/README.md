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

### Prod-apply notes (migration-review advisories — non-blocking at alpha volume)

`0034` is safe as-authored for alpha data volume. For a future **large live table**, harden the
apply so it doesn't block reads/writes:

- **`SET NOT NULL`** on the 7 tables takes `ACCESS EXCLUSIVE` + a full-table validation scan. On a
  large table prefer the expand pattern: add a `NOT VALID` CHECK `(org_id IS NOT NULL)` →
  `VALIDATE CONSTRAINT` (only `SHARE UPDATE EXCLUSIVE`) → then `SET NOT NULL` (PG ≥12 skips the
  rescan using the validated constraint).
- **`CREATE UNIQUE INDEX`** takes a write lock for the build. For prod prefer
  `CREATE UNIQUE INDEX CONCURRENTLY` — but that **cannot** run inside the migration transaction /
  `--> statement-breakpoint` batching, so it must be a separate out-of-transaction step.
- Run `pnpm --filter @badabhai/db db:verify:org-id` against staging **immediately post-apply**.

### ⚠️ For the author of the NEXT increment (the payer_id→org_id predicate flips)

`org_id` is intentionally **nullable in the Drizzle model** (insert back-compat) while the DB has it
`NOT NULL` on the 7 tables + the two `*_org_id_when_payer_chk` CHECKs — a deliberate
model-vs-DB drift. A future `pnpm db:generate` will therefore **diff the model (nullable, no CHECK)
against the DB and MAY re-emit `SET NOT NULL` / re-add-or-drop the CHECKs**. When you author the
flip increment, either add `.notNull()` to the 7 tables' model at that point, or hand-reconcile
(delete) any spurious re-emitted `SET NOT NULL` / CHECK statements before committing.
