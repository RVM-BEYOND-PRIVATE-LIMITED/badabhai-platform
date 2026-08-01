# Matching V1 — migration + backfill runbook

**Owner of the run:** Divyanshu (migrations are applied **manually in production**).
**Author:** database-architect. **Ratified:** "Matching Algorithm V1", CEO, 2026-07-30.

This runbook is the operational contract for landing Matching V1 on the single shared
Supabase Postgres. It covers **8 migrations (0052 → 0059)**, then **6 data steps
(D1 → D6)**, then **one verifier**.

Every step below states: the exact command · a **verify SQL query with its expected
result** · a **rollback note** · an estimated duration · and whether it is **safe to
re-run** or **one-way**.

> **The single most important line in this document:** step **0056** contains the only
> irreversible decision in the train. Read [§7](#7-the-one-way-doors) before you start.

---

## 0. Pre-flight — do not skip

| # | Check | How | Must be |
|---|---|---|---|
| 0.1 | **Backup / snapshot confirmed** | Supabase Dashboard → Database → Backups. Take a fresh PITR restore point *and write down its timestamp*. | A restore point exists, taken **after** the last write and **before** step 0052. |
| 0.2 | You are on the intended database | `psql "$DATABASE_URL" -c "select current_database(), inet_server_addr();"` | The production database, deliberately. |
| 0.3 | Postgres ≥ 11 | `psql "$DATABASE_URL" -c "show server_version;"` | ≥ 11 (required for metadata-only `ADD COLUMN ... DEFAULT`). Supabase is ≥ 15. |
| 0.4 | Migration head is 0051 | see [§1.1](#11-confirm-the-current-head) | `0051_mighty_jigsaw` is the last applied. |
| 0.5 | Code is built | `pnpm install && pnpm build` | Green. `@badabhai/taxonomy` must carry the V1 exports (see [§8](#8-known-blockers--cross-package-dependencies)). |
| 0.6 | No deploy in flight | — | The API is **not** mid-deploy. Migrations land first, code second (§0.7). |
| 0.7 | **Deploy order understood** | — | **Apply 0052–0059 BEFORE deploying the Matching V1 API.** Every new column is nullable/defaulted, so the *current* API keeps working against the migrated DB — but the *new* API will not work against an unmigrated one, and a boost purchase 500s without 0059. |
| 0.8 | Maintenance window | — | Not required at current volume (see the durations below), but do it in a low-traffic hour anyway: steps 0052/0054/0056 take brief `ACCESS EXCLUSIVE` locks. |

### STOP if any of these is true

- The backup/restore point in 0.1 is **not** confirmed. → **Stop.** Nothing below is worth
  running without it.
- `select count(*) from applications where job_id is null;` returns **> 0 before you start**.
  → **Stop and escalate.** That means 0056 has already been applied and V1 applications
  exist; the rollback path for 0056 is already closed and you must not assume it is open.
- The migration head is not `0051_mighty_jigsaw`. → **Stop.** Reconcile the journal first;
  applying out of order will fail on a missing dependency (0054 references `jobs`, 0055
  references `job_postings` + `skill`, 0056 references `job_postings`).
- `pnpm build` fails on `@badabhai/api` with `applications.repository.ts` type errors. →
  That is **expected before the backend fix lands** (see [§8](#8-known-blockers--cross-package-dependencies)).
  It does **not** block the migrations — but it **does** block the API deploy in 0.7, so
  know which one you are doing.
- Any step's verify query returns something other than its expected result. → **Stop at
  that step.** Do not continue the train hoping a later step fixes it.
- A `db:*` script prints `DRY RUN` when you expected `APPLY`. → You forgot `--apply`.
  Nothing was written; that is the design.

### Durations

All estimates are for **current alpha volume**: order-of-thousands `workers`, low-thousands
`worker_profiles`, hundreds of `job_postings` / `jobs`, low-thousands `applications`.
They scale roughly linearly with row count. If any table has grown by 100×, re-read the
**LOCKS** note in each migration file header — it names the `CONCURRENTLY` / `NOT VALID`
split to use instead.

---

## 1. The migrations (0052 → 0059)

### 1.1 Confirm the current head

```bash
psql "$DATABASE_URL" -c "select count(*) as applied from drizzle.__drizzle_migrations;"
```

Drizzle records applied migrations in `drizzle.__drizzle_migrations(id, hash, created_at)`,
where `hash = sha256(<the migration file's exact bytes>)` and `created_at` is the `when`
value from `packages/db/migrations/meta/_journal.json`. **Expected before you start: 52
rows** (0000 … 0051).

### 1.2 How to apply — pick ONE path and stick to it

**Path A (RECOMMENDED) — let Drizzle apply and record them:**

```bash
cd packages/db
DATABASE_URL="<prod>" pnpm exec drizzle-kit migrate
```

This applies **all pending** migrations in journal order **and writes the bookkeeping
rows**. It is all-or-nothing per file.

**Path B (per-file, maximum control) — apply by hand:**

```bash
cd packages/db
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f migrations/0052_match_vocabulary.sql
```

> ⚠️ **Path B does NOT update `drizzle.__drizzle_migrations`.** A later `drizzle-kit
> migrate` would then try to re-apply the file and fail. If you use Path B you **must**
> record each file yourself, immediately after it succeeds:
>
> ```bash
> HASH=$(node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))" migrations/0052_match_vocabulary.sql)
> psql "$DATABASE_URL" -c "insert into drizzle.__drizzle_migrations (hash, created_at) values ('$HASH', 1785484721110);"
> ```
>
> The `created_at` values are the `when` fields from `meta/_journal.json`:
>
> | migration | `created_at` |
> |---|---|
> | `0052_match_vocabulary` | `1785484721110` |
> | `0053_worker_skills_and_tenure` | `1785484805203` |
> | `0054_job_postings_served_entity` | `1785484889292` |
> | `0055_job_reach` | `1785484952546` |
> | `0056_applications_v1_snapshot` | `1785485029597` |
> | `0057_match_config` | `1785485088201` |
> | `0058_payments_and_referral_bonus` | `1785485161707` |
>
> The hash must be computed from the **committed file bytes**. If you edit a migration
> file, the hash changes and the bookkeeping row is wrong.

---

### Step 0052 — match vocabulary

`packages/db/migrations/0052_match_vocabulary.sql`

**What it does:** adds `skill.kind` (`match_skill` | `attribute`, default `attribute`) and
`skill.industry_id` (default `ind_industrial_manufacturing`); creates `skill_related`
(TIER-2 adjacency); adds `skill_industry_kind_idx` and `skill_kind_chk`.

**Command**

```bash
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f packages/db/migrations/0052_match_vocabulary.sql
```

**Verify**

```sql
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name='skill' AND column_name IN ('kind','industry_id'))            AS new_cols,
  (SELECT count(*) FROM pg_tables WHERE tablename='skill_related')                  AS related_table,
  (SELECT count(*) FROM skill WHERE kind <> 'attribute')                            AS non_default_kind,
  (SELECT count(*) FROM skill WHERE industry_id IS NULL)                            AS null_industry;
```

**Expected:** `new_cols = 2`, `related_table = 1`, `non_default_kind = 0` (D1 sets these
later, not the migration), `null_industry = 0`.

**Re-run:** the file is **not** idempotent (`ADD COLUMN` without `IF NOT EXISTS`). Apply once.
**Rollback:** fully reversible, no data loss —
```sql
DROP TABLE "skill_related";
DROP INDEX IF EXISTS "skill_industry_kind_idx";
ALTER TABLE "skill" DROP CONSTRAINT IF EXISTS "skill_kind_chk";
ALTER TABLE "skill" DROP COLUMN IF EXISTS "kind";
ALTER TABLE "skill" DROP COLUMN IF EXISTS "industry_id";
```
**Duration:** < 1 s. Locks: two metadata-only `ADD COLUMN`s + one `ADD CONSTRAINT` that
scans `skill` (reference-sized).

---

### Step 0053 — worker skills + tenure

`packages/db/migrations/0053_worker_skills_and_tenure.sql`

**What it does:** creates `worker_skill` (the reach driver) and `worker_industry_tenure`.
Both `worker_id` FKs are **`ON DELETE CASCADE`**. Includes the hand-appended covering index
`worker_skill_reach_idx (skill_id) INCLUDE (worker_id, months_bucketed) WHERE wants`.

**Command**

```bash
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f packages/db/migrations/0053_worker_skills_and_tenure.sql
```

**Verify**

```sql
SELECT indexname, indexdef FROM pg_indexes
WHERE indexname = 'worker_skill_reach_idx';
```

**Expected:** exactly one row, and its `indexdef` **must contain `INCLUDE (worker_id,
months_bucketed)`**. If the `INCLUDE` is missing, the covering payload was lost — see
[§8](#8-known-blockers--cross-package-dependencies).

Also confirm the DPDP cascade is armed:

```sql
SELECT conrelid::regclass AS child, confdeltype
FROM pg_constraint
WHERE contype='f' AND confrelid='public.workers'::regclass
  AND conrelid::regclass::text IN ('worker_skill','worker_industry_tenure');
```

**Expected:** 2 rows, `confdeltype = 'c'` (CASCADE) on both.

**Re-run:** not idempotent (`CREATE TABLE`). Apply once.
**Rollback:** fully reversible; the data is 100 % re-derivable by re-running D2 —
```sql
DROP TABLE "worker_skill";
DROP TABLE "worker_industry_tenure";
```
**Duration:** < 1 s (no lock on any live table).

---

### Step 0054 — `job_postings` becomes the served entity

`packages/db/migrations/0054_job_postings_served_entity.sql`

**What it does:** adds 11 columns to `job_postings` (`industry_id`, `match_skill_ids`,
`reach_skill_ids`, `city`, `pay_min`, `pay_max`, `shift`, `needed_by`, `published_at`,
`boosted_until`, `source_job_id`), 3 indexes (`job_postings_feed_idx`,
`job_postings_reach_gin`, `job_postings_source_job_id_uq`) and 4 CHECKs mirroring `jobs`.
**`jobs` is not touched.**

**Command**

```bash
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f packages/db/migrations/0054_job_postings_served_entity.sql
```

**Verify**

```sql
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name='job_postings' AND column_name IN
     ('industry_id','match_skill_ids','reach_skill_ids','city','pay_min','pay_max',
      'shift','needed_by','published_at','boosted_until','source_job_id'))          AS new_cols,
  (SELECT count(*) FROM pg_indexes WHERE indexname IN
     ('job_postings_feed_idx','job_postings_reach_gin','job_postings_source_job_id_uq')) AS new_idx,
  (SELECT count(*) FROM job_postings WHERE match_skill_ids IS NULL
                                        OR reach_skill_ids IS NULL)                 AS null_jsonb;
```

**Expected:** `new_cols = 11`, `new_idx = 3`, `null_jsonb = 0` (both default to `'[]'`).

**Re-run:** not idempotent. Apply once.
**Rollback:** fully reversible **before D4 runs** — drop the 3 indexes, the 4 CHECKs, the FK
and the 11 columns (the exact statements are in the file header). **After D4 has run**,
undo D4 first (§4, step D4 rollback), or the worker feed goes empty.
**Duration:** ~1–5 s at current volume. The 3 `CREATE INDEX` + 4 `ADD CONSTRAINT`
statements take `ACCESS EXCLUSIVE` on `job_postings` and scan it.

---

### Step 0055 — `job_reach`

`packages/db/migrations/0055_job_reach.sql`

**What it does:** creates `job_reach` (the materialized reach set) with the hand-appended
covering index `job_reach_worker_idx (worker_id) INCLUDE (job_posting_id, match_tier,
matched_skill_id)`.

**Command**

```bash
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f packages/db/migrations/0055_job_reach.sql
```

**Verify**

```sql
SELECT indexdef FROM pg_indexes WHERE indexname = 'job_reach_worker_idx';
```

**Expected:** one row containing `INCLUDE (job_posting_id, match_tier, matched_skill_id)`.

**Re-run:** not idempotent. Apply once.
**Rollback:** fully reversible, zero data loss — `job_reach` is a rebuildable cache:
```sql
DROP TABLE "job_reach";
```
**Duration:** < 1 s.

---

### Step 0056 — applications snapshot ⚠️ **THE ONE-WAY DOOR**

`packages/db/migrations/0056_applications_v1_snapshot.sql`

**What it does:** drops `NOT NULL` on `applications.job_id`; adds `job_posting_id` + the
5 snapshot columns (`match_tier`, `skill_months`, `industry_months`, `last_worked_at`,
`engine_version`); adds 3 indexes and 3 CHECKs.

**Why it is urgent:** the snapshot records what the rank inputs *were* when a worker
applied. Those inputs move. **History not captured on day one is gone permanently.** Ship
this before the first V1 application, not after.

**Before applying, record the rollback window:**

```sql
SELECT count(*) AS must_be_zero FROM applications WHERE job_id IS NULL;
```

**Expected: `0`.** Write this down. While it stays `0`, the `NOT NULL` can be restored.

**Command**

```bash
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f packages/db/migrations/0056_applications_v1_snapshot.sql
```

**Verify**

```sql
SELECT
  (SELECT is_nullable FROM information_schema.columns
     WHERE table_name='applications' AND column_name='job_id')                      AS job_id_nullable,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name='applications' AND column_name IN
     ('job_posting_id','match_tier','skill_months','industry_months',
      'last_worked_at','engine_version'))                                           AS new_cols,
  (SELECT count(*) FROM pg_indexes WHERE indexname IN
     ('applications_worker_posting_uq','applications_applied_posting_idx',
      'applications_rank_idx'))                                                     AS new_idx,
  (SELECT count(*) FROM applications WHERE job_id IS NULL)                          AS orphan_rows;
```

**Expected:** `job_id_nullable = YES`, `new_cols = 6`, `new_idx = 3`, `orphan_rows = 0`
(no existing row is repointed — **coexist, never repoint**).

**Re-run:** not idempotent. Apply once.
**Rollback:** structurally reversible **only while `orphan_rows = 0`**. The full statement
list is in the file header; the last line is
`ALTER TABLE "applications" ALTER COLUMN "job_id" SET NOT NULL;` — it will fail the moment
one V1 application exists, and forcing it would mean **deleting real worker applications**.
**Duration:** ~1–5 s. `DROP NOT NULL` and the `ADD COLUMN`s are instant; the 3 index builds
and 3 constraint validations scan `applications`.

---

### Step 0057 — `match_config`

`packages/db/migrations/0057_match_config.sql`

**What it does:** creates `match_config` (single-active-row jsonb config, a clone of
`pricing_catalog`). **Seeds no values** — D1 does that.

**Command**

```bash
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f packages/db/migrations/0057_match_config.sql
```

**Verify**

```sql
SELECT (SELECT count(*) FROM pg_tables WHERE tablename='match_config')   AS tbl,
       (SELECT count(*) FROM match_config)                               AS rows_expected_zero;
```

**Expected:** `tbl = 1`, `rows_expected_zero = 0`.

**Re-run:** not idempotent. Apply once.
**Rollback:** fully reversible — `DROP TABLE "match_config";` (values are re-seedable by D1).
**Duration:** < 1 s.

---

### Step 0058 — payments + referral bonus

`packages/db/migrations/0058_payments_and_referral_bonus.sql`

**What it does:** creates `payment_orders` (with `UNIQUE (provider, provider_order_id)` —
**the payment idempotency key**) and `referral_bonus_accruals` (with
`UNIQUE (invited_worker_id)` — **the fraud rule's teeth**).

> **Creating `payment_orders` does not enable real money.** Real provider keys and spend
> stay a human-gated escalation (CLAUDE.md §7). This lands the constraint now so it is not
> bolted on after the first double-charge.

**Command**

```bash
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f packages/db/migrations/0058_payments_and_referral_bonus.sql
```

**Verify**

```sql
SELECT
  (SELECT count(*) FROM pg_indexes WHERE indexname='payment_orders_provider_order_uq')   AS pay_idem_key,
  (SELECT count(*) FROM pg_indexes WHERE indexname='referral_bonus_accruals_invited_uq') AS referral_rule,
  (SELECT count(*) FROM payment_orders)                                                  AS orders_zero,
  (SELECT count(*) FROM referral_bonus_accruals)                                         AS accruals_zero;
```

**Expected:** `pay_idem_key = 1`, `referral_rule = 1`, both counts `0`.

**Re-run:** not idempotent. Apply once.
**Rollback:** fully reversible **while both tables are empty** (they are on arrival) —
`DROP TABLE "payment_orders"; DROP TABLE "referral_bonus_accruals";`. Once real orders or
accruals exist, **do not drop** — those rows are the payment audit trail.
**Duration:** < 1 s.

---

### Step 0059 — boost tier widening ⚠️ **REQUIRED by the API wiring**

`packages/db/migrations/0059_boost_tiers_widened.sql`

**What it does:** widens the `posting_boosts.tier` CHECK constraint to accept the three
repriced boost codes — `boost_7` (₹499 / 7d), `boost_15` (₹999 / 15d), `boost_30`
(₹1799 / 30d), ADR-0036 §7 — alongside the historical `all_candidates`, which **stays**
(additive; every existing boost row carries it and the amounts live in
`packages/pricing/src/defaults.ts`, not the DB). No data step.

> **Do not skip this.** It landed AFTER the 0052–0058 train (commit `324e0c7`) and is,
> per its own header, *"the only DB change the Matching V1 API wiring needs beyond the
> 0052–0058 train."* The boost purchase path writes `tier='boost_7'|'boost_15'|'boost_30'`.
> Without 0059 the old constraint only permits `'all_candidates'`, so **every boost
> purchase fails with a CHECK violation the moment `MATCH_V1_ENABLED` is on.**

**Command**

```bash
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f packages/db/migrations/0059_boost_tiers_widened.sql
```

**Verify**

```sql
SELECT pg_get_constraintdef(oid) AS tier_check
FROM pg_constraint WHERE conname = 'posting_boosts_tier_chk';
```

**Expected:** the definition lists all four codes —
`CHECK ((tier IN ('all_candidates','boost_7','boost_15','boost_30')))`.

**Re-run:** not idempotent (plain `DROP`/`ADD CONSTRAINT`). Apply once.
**Rollback:** reversible **only while no row uses a new tier** — first confirm
`SELECT count(*) FROM posting_boosts WHERE tier <> 'all_candidates';` returns `0`, then
re-narrow the CHECK to `('all_candidates')` (full statement in the migration header).
**Duration:** < 1 s (brief `ACCESS EXCLUSIVE`; at 100× volume use the `NOT VALID` +
`VALIDATE CONSTRAINT` split described in the migration).

---

### 2. Post-migration gate — run before any data step

```sql
-- 2.1 all 7 new tables exist, RLS ENABLED + FORCED
SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relname IN ('skill_related','worker_skill','worker_industry_tenure','job_reach',
                    'match_config','payment_orders','referral_bonus_accruals')
ORDER BY 1;
```

**Expected:** 7 rows, `rls = t` and `forced = t` on every one.

```sql
-- 2.2 the Data-API roles hold NO privilege on any of them (REVOKE ALL)
SELECT c.relname, r.rolname, p.priv
FROM pg_class c
CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) r(rolname)
CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) p(priv)
WHERE c.relnamespace='public'::regnamespace
  AND c.relname IN ('skill_related','worker_skill','worker_industry_tenure','job_reach',
                    'match_config','payment_orders','referral_bonus_accruals')
  AND has_table_privilege(r.rolname, 'public.'||c.relname, p.priv);
```

**Expected: 0 rows.** Any row here is a spine leak — stop and fix before continuing.

```sql
-- 2.3 total public table count
SELECT count(*) FROM pg_tables WHERE schemaname = 'public';
```

**Expected: `53`** (46 before + 7). This is the number `tests/e2e/rls-spine.e2e.test.ts`
`LOCKED_TABLES` asserts against.

---

## 3. Data steps (D1 → D6)

### Common contract for every script below

- **Dry-run is the default.** Nothing is written until you pass `--apply`. Run each step
  once without it, read the counts, then re-run with it.
- **Production needs a second key.** With `NODE_ENV=production` set, every script refuses
  unless `MATCH_V1_PROD_CONFIRM=apply-matching-v1` is also set. If your ops shell does not
  set `NODE_ENV`, you do not need the token — but setting it is harmless and explicit.
- `DATABASE_URL` must be set. There is **no** localhost fallback.
- All scripts run from the repo root via `pnpm --filter @badabhai/db <script>`, or from
  `packages/db` via `pnpm <script>`.
- All logging is **ids + counts only**. No PII is read or printed by any of them.

```bash
export DATABASE_URL="<prod>"
export MATCH_V1_PROD_CONFIRM=apply-matching-v1     # only needed if NODE_ENV=production
cd packages/db
```

---

### D1 — seed the match vocabulary + config

**Depends on:** 0052, 0057. **Order:** must be first — D2/D3/D4/D5 all read it.

```bash
pnpm db:seed:match:vocabulary            # dry run — read the counts
pnpm db:seed:match:vocabulary --apply    # write
```

Upserts `MATCH_SKILLS` into `skill` with `kind='match_skill'`; re-tags everything else to
`kind='attribute'`; writes **both directions** of every `MATCH_SKILL_RELATION_PAIRS` entry
into `skill_related`; seeds the single active `match_config` row **only if absent**.

It **refuses to write** an asymmetric, self-, or attribute-kind relation, and asserts
symmetry against the live DB after writing.

**Verify**

```sql
SELECT
  (SELECT count(*) FROM skill WHERE kind='match_skill')                          AS match_skills,
  (SELECT count(*) FROM skill_related)                                           AS relations,
  (SELECT count(*) FROM skill_related WHERE skill_id = related_skill_id)         AS self_rels,
  (SELECT count(*) FROM skill_related r WHERE NOT EXISTS (
     SELECT 1 FROM skill_related m
     WHERE m.skill_id = r.related_skill_id AND m.related_skill_id = r.skill_id)) AS asymmetric,
  (SELECT count(*) FROM match_config WHERE is_active)                            AS active_config;
```

**Expected:** `match_skills` = the corpus size (non-zero); `relations` = **exactly 2× the
number of unordered pairs**; `self_rels = 0`; `asymmetric = 0`; `active_config = 1`.

**Safe to re-run:** ✅ yes, always. Row-level idempotent.
**Rollback:** `DELETE FROM skill_related;` + `UPDATE skill SET kind='attribute';` +
`DELETE FROM match_config;`. Nothing is destroyed that D1 cannot rebuild.
**Duration:** seconds.

---

### D2 — backfill worker skills + industry tenure

**Depends on:** 0053, D1.

```bash
pnpm db:backfill:worker-skills                                   # dry run
pnpm db:backfill:worker-skills --apply --batch-size=500          # write
```

Derives each worker's match skills from their **latest** `worker_profiles` row using the
coarse launch rule (role bridge ∪ attribute bridge; months = bucketed total experience;
`wants=true`; no stints; `source='derived_coarse'`), then rebuilds
`worker_industry_tenure` with the E8 clamp.

**It only ever writes/deletes `source='derived_coarse'` rows.** Interview- and
ops-authored rows are left exactly as they are — enforced at the DB by the upsert's
`WHERE source='derived_coarse'`.

**Resumable:** the run prints `resume cursor (--start-after)`. If it is interrupted:

```bash
pnpm db:backfill:worker-skills --apply --start-after=<the printed uuid>
```

**Verify**

```sql
SELECT
  (SELECT count(*) FROM worker_skill)                                    AS worker_skills,
  (SELECT count(DISTINCT worker_id) FROM worker_skill)                   AS workers_covered,
  (SELECT count(*) FROM worker_industry_tenure)                          AS tenure_rows,
  (SELECT count(*) FROM worker_skill ws JOIN worker_industry_tenure t
     ON t.worker_id=ws.worker_id AND t.industry_id=ws.industry_id
   WHERE ws.months_bucketed > t.calendar_months)                         AS clamp_violations,
  (SELECT count(*) FROM worker_skill WHERE months_bucketed % 6 <> 0)     AS unbucketed;
```

**Expected:** `clamp_violations = 0`; `unbucketed = 0` (with `month_bucket = 6`);
`workers_covered` ≤ the number of workers with a profile. A worker deriving **zero**
skills is legitimate (no `canonical_role_id`, no bridgeable attribute) — the script
prints that count; it means they reach nothing until the interview writes a skill.

**Safe to re-run:** ✅ yes, always — it re-derives from scratch and prunes stale rows.
**Rollback:** `DELETE FROM worker_skill WHERE source='derived_coarse';` +
`DELETE FROM worker_industry_tenure;`. Both are fully re-derivable.
**Duration:** ~1–5 min at current volume (one round-trip group per worker). Scales with
worker count; raise `--batch-size` if the log is chatty, not to go faster.

---

### D3 — backfill `job_postings` (published_at + proposed match skills)

**Depends on:** 0054, D1.

```bash
pnpm db:backfill:job-postings                    # dry run + writes the worklist
pnpm db:backfill:job-postings --apply            # write
```

Sets `published_at = created_at` for every non-draft posting that has none, and
**proposes** `match_skill_ids` for OPEN postings with none, by normalized keyword match of
`role_title` against the match-skill labels.

> **Anything it cannot resolve is LEFT EMPTY and printed to an ops worklist** — stdout plus
> `matching-v1-unresolved-postings.worklist.json` (override with `--worklist=<path>`).
> It never guesses. **An empty `match_skill_ids` means the posting reaches nobody.**
> Someone must resolve or close each one.

**Verify**

```sql
SELECT
  (SELECT count(*) FROM job_postings WHERE status <> 'draft' AND published_at IS NULL) AS missing_published,
  (SELECT count(*) FROM job_postings WHERE status='open'
     AND jsonb_array_length(match_skill_ids) = 0)                                      AS open_no_match,
  (SELECT count(*) FROM job_postings WHERE jsonb_array_length(match_skill_ids) > 0
     AND NOT (reach_skill_ids @> match_skill_ids))                                     AS reach_not_superset;
```

**Expected:** `missing_published = 0`; `reach_not_superset = 0`; `open_no_match` **must
equal the worklist length the script printed** — every one of those is an ops task, not a
silent failure.

**Safe to re-run:** ✅ yes. It only touches postings that are still empty (guarded by an
optimistic `jsonb_array_length(...) = 0` in the `WHERE`, so a concurrent ops edit wins).
**Rollback:** `UPDATE job_postings SET published_at = NULL WHERE ...;` and
`UPDATE job_postings SET match_skill_ids='[]', reach_skill_ids='[]' WHERE ...;` — scope
carefully, this also clears human edits if you are not selective.
**Duration:** seconds to a minute.

---

### D4 — cutover: convert legacy `jobs` → `job_postings`

**Depends on:** 0054, D1. **Without this the worker feed is EMPTY at flag flip.**

Two arguments are **required** because the script refuses to invent them:

```bash
pnpm db:convert:seed-jobs \
  --ops-actor=<uuid-of-the-ops-actor> \
  --org-label="Hiring Employer"                    # dry run

pnpm db:convert:seed-jobs \
  --ops-actor=<uuid-of-the-ops-actor> \
  --org-label="Hiring Employer" \
  --vacancy-band=1 \
  --apply
```

- `--ops-actor` becomes `job_postings.created_by`.
- `--org-label` — `job_postings.org_label` is `NOT NULL` and `jobs` is faceless by design
  (ADR-0009 §2), so there is nothing to derive it from. **It must not be a real employer
  name**; the script PII-checks it and refuses on a trip.
- `--vacancy-band` defaults to `1` (the most conservative band, because ADR-0016 capacity
  counts active vacancies and over-claiming is the harmful direction).

For each `jobs` row with `status='open'` it inserts a `job_postings` row (copying
role/city/pay/shift/needed_by/description, mapping `trade_key` → match skill, expanding
reach, `published_at = jobs.created_at`, `source_job_id = jobs.id`) and then closes the
`jobs` row — **inside one transaction per job.**

**Idempotency mechanism:** `job_postings.source_job_id` + `job_postings_source_job_id_uq`.
A re-run conflicts and does nothing.

**Existing `applications` rows are NOT repointed.** They keep pointing at the now-closed
`jobs` rows, forever.

**Verify**

```sql
SELECT
  (SELECT count(*) FROM jobs WHERE status='open')                                AS jobs_still_open,
  (SELECT count(*) FROM job_postings WHERE source_job_id IS NOT NULL)            AS converted,
  (SELECT count(*) FROM job_postings jp JOIN jobs j ON j.id = jp.source_job_id
   WHERE j.status <> 'closed')                                                   AS converted_but_open,
  (SELECT count(*) FROM job_postings WHERE source_job_id IS NOT NULL
     AND jsonb_array_length(match_skill_ids) = 0)                                AS converted_no_match,
  (SELECT count(*) FROM applications WHERE job_id IS NOT NULL)                   AS legacy_apps_intact;
```

**Expected:** `jobs_still_open = 0`; `converted` = the number of jobs that were open;
`converted_but_open = 0`; `converted_no_match = 0` (if not, a `trade_key` has no bridge —
the script names them; fix the taxonomy and re-run); `legacy_apps_intact` = unchanged from
before D4.

**Safe to re-run:** ✅ yes — a second run is a no-op.
**Rollback (data-level undo — do this BEFORE rolling back 0054):**

```sql
BEGIN;
UPDATE jobs SET status='open'
 WHERE id IN (SELECT source_job_id FROM job_postings WHERE source_job_id IS NOT NULL);
DELETE FROM job_postings WHERE source_job_id IS NOT NULL;
COMMIT;
```

⚠️ That `DELETE` cascades to `job_reach` and to any `applications` row that already carries
`job_posting_id` for a converted posting. **Check first:**
`SELECT count(*) FROM applications WHERE job_posting_id IN (SELECT id FROM job_postings WHERE source_job_id IS NOT NULL);`
If it is non-zero, you are deleting real V1 applications — **stop and escalate.**

**Duration:** seconds (one transaction per open job).

---

### D5 — materialize the reach sets

**Depends on:** 0055, D2, D3, D4.

```bash
pnpm db:materialize:reach                       # dry run — per-posting reach counts
pnpm db:materialize:reach --apply               # write
pnpm db:materialize:reach --apply --job-posting-id=<uuid>   # rebuild just one
```

Recomputes each open posting's `reach_skill_ids` (match ∪ `skill_related`), then runs the
③ statement per posting: best-tier-wins (`MIN`) and the skill that achieved the tier
(`ARRAY_AGG(... ORDER BY direct DESC, months DESC)[1]`). Deletes reach rows that no longer
qualify, in the same transaction.

**Verify**

```sql
SELECT
  (SELECT count(*) FROM job_reach)                                          AS reach_rows,
  (SELECT count(DISTINCT job_posting_id) FROM job_reach)                    AS postings_with_reach,
  (SELECT count(*) FROM job_postings jp WHERE jp.status='open'
     AND jsonb_array_length(jp.match_skill_ids) > 0
     AND NOT EXISTS (SELECT 1 FROM job_reach jr WHERE jr.job_posting_id=jp.id)) AS zero_reach_postings,
  (SELECT count(*) FROM job_reach WHERE match_tier NOT IN (1,2))            AS bad_tier,
  (SELECT count(*) FROM job_reach jr JOIN job_postings jp ON jp.id=jr.job_posting_id
   WHERE jr.match_tier = 1 AND NOT (jp.match_skill_ids @> to_jsonb(jr.matched_skill_id))) AS tier1_lies;
```

**Expected:** `bad_tier = 0`; `tier1_lies = 0`; `reach_rows > 0`. `zero_reach_postings`
**may legitimately be non-zero** (thin supply) — the script names every one; confirm each
is intended rather than a missing bridge.

**Safe to re-run:** ✅ yes, always — it is a rebuild, and the only self-correcting step in
the train. Run it again any time reach looks wrong.
**Rollback:** `TRUNCATE job_reach;` (or `DELETE FROM job_reach;`). Zero data loss — it is a
cache; re-running D5 rebuilds it exactly.
**Duration:** ~1 s per posting at current supply; total minutes for hundreds of postings.
Watch `reach_rows` — this is the widest table in the system.

---

### D6 — grant the free-tier credits

**Depends on:** 0057, D1 (for `free_unlock_credits`).

```bash
pnpm db:grant:free-tier                              # dry run
pnpm db:grant:free-tier --apply                      # write
pnpm db:grant:free-tier --apply --repair-balances    # also reconcile balance vs ledger
```

One `credit_ledger` `grant` row + a `payer_credits` balance top-up per existing payer,
keyed `free_tier_grant:<payerId>`. The existing
`credit_ledger_idempotency_key_uq` makes it **exactly-once**; the balance is bumped only
when the ledger insert actually inserted (read from `RETURNING`, never assumed), and both
writes share one transaction.

**Verify**

```sql
SELECT
  (SELECT count(*) FROM payers)                                                       AS payers,
  (SELECT count(*) FROM credit_ledger WHERE idempotency_key LIKE 'free_tier_grant:%') AS grants,
  (SELECT count(*) FROM credit_ledger WHERE idempotency_key LIKE 'free_tier_grant:%'
     AND delta <> 50)                                                                 AS wrong_amount,
  (SELECT count(*) FROM payer_credits pc
   WHERE pc.balance <> COALESCE((SELECT sum(cl.delta)::int FROM credit_ledger cl
                                 WHERE cl.payer_id = pc.payer_id), 0))                AS balance_divergence;
```

**Expected:** `grants = payers` (one per payer, no more); `wrong_amount = 0`;
`balance_divergence = 0`.

**Safe to re-run:** ✅ yes — the idempotency key guarantees no double credit.
**Rollback:** ⚠️ **this one moves money-equivalent state.** To undo:
```sql
BEGIN;
UPDATE payer_credits pc SET balance = pc.balance - cl.delta
  FROM credit_ledger cl
 WHERE cl.payer_id = pc.payer_id AND cl.idempotency_key = 'free_tier_grant:'||pc.payer_id;
DELETE FROM credit_ledger WHERE idempotency_key LIKE 'free_tier_grant:%';
COMMIT;
```
Do **not** run this if any payer has already spent the granted credits — the balance would
go negative and hit `payer_credits_balance_nonneg_chk`. Check first:
`SELECT count(*) FROM credit_ledger WHERE reason='unlock_debit' AND created_at > '<D6 run time>';`
**Duration:** seconds.

---

## 4. Final verification

```bash
pnpm --filter @badabhai/db db:verify:match-v1
```

Read-only. Exits **non-zero on any violation**. It checks: all 7 tables exist + row counts ·
`skill_related` symmetry · no self/attribute-kind relations · no orphan `match_skill_ids` ·
reach ⊇ match on every posting · zero-reach postings named · every `match_tier` ∈ (1,2) ·
every TIER-1 row really matched a posted skill · the E8 tenure clamp · exactly one active
`match_config` that parses · **and `EXPLAIN` on the feed / reach-driver / job_reach queries
plus a direct assertion that both `INCLUDE` payloads survived.**

**Expected:** `PASS — Matching V1 schema + data are consistent.` and exit code 0.

Warnings (`!`) do not block: zero-reach postings and postings with no match skills are real
operational states, not schema faults. **Failures (`✗`) block** — do not deploy over them.

Then re-run the spine guard in CI (or locally against a migrated DB):

```bash
RUN_E2E=1 pnpm --filter @badabhai/e2e test   # rls-spine.e2e.test.ts must be green
```

All 7 new tables are already registered in that test's `LOCKED_TABLES`; it asserts the
locked list equals the live schema **and** the Drizzle model (53 = 53 = 53).

---

## 5. Order of operations, at a glance

```
0.  BACKUP / restore point            ← STOP if not confirmed
1.  0052  match vocabulary
2.  0053  worker skills + tenure
3.  0054  job_postings served entity
4.  0055  job_reach
5.  0056  applications snapshot        ← ⚠️ ONE-WAY DOOR
6.  0057  match_config
7.  0058  payments + referral bonus
8.  0059  boost tier widening          ← REQUIRED by the API wiring (boost purchase 500s without it)
    §2  post-migration gate (RLS + REVOKE + table count)
9.  D1    db:seed:match:vocabulary     --apply
10. D2    db:backfill:worker-skills    --apply
11. D3    db:backfill:job-postings     --apply   → read the ops worklist
12. D4    db:convert:seed-jobs         --apply   ← feed continuity
13. D5    db:materialize:reach         --apply
14. D6    db:grant:free-tier           --apply
15.       db:verify:match-v1                     ← must exit 0
16.       deploy the Matching V1 API
```

D1 must precede D2/D3/D4/D5. D2/D3/D4 must precede D5. D6 is independent of D2–D5 and can
run any time after 0057 + D1.

---

## 6. Re-runnable vs one-way

| Step | Safe to re-run? | Notes |
|---|---|---|
| 0052–0059 | ❌ **No** | `ADD COLUMN` / `CREATE TABLE` / `ADD CONSTRAINT` without `IF NOT EXISTS`. Apply each once; the journal is the record. |
| D1 `seed:match:vocabulary` | ✅ Always | Row-level idempotent; self-repairing. |
| D2 `backfill:worker-skills` | ✅ Always | Re-derives + prunes; never touches human-authored rows. |
| D3 `backfill:job-postings` | ✅ Always | Only fills still-empty postings; a concurrent ops edit wins. |
| D4 `convert:seed-jobs` | ✅ Always | `source_job_id` UNIQUE makes a second run a no-op. |
| D5 `materialize:reach` | ✅ Always | A pure rebuild. Run it whenever reach looks wrong. |
| D6 `grant:free-tier` | ✅ Always | The ledger idempotency key guarantees exactly-once. |
| `verify:match-v1` | ✅ Always | Read-only. |

---

## 7. The one-way doors

There are exactly **three** irreversible things in this train. Everything else is a
rebuildable projection.

1. **`applications.job_id` losing `NOT NULL` (step 0056).** Restoring it requires
   `count(*) WHERE job_id IS NULL = 0`. From the first V1 application onward, that is only
   achievable by **deleting real worker applications**. Treat the constraint as gone the
   moment the API ships.

2. **The applications snapshot itself (step 0056).** `match_tier`, `skill_months`,
   `industry_months`, `last_worked_at`, `engine_version` are captured at decision time and
   the inputs move afterwards. **History not captured on day one is gone permanently.**
   This is *why* 0056 ships before the first V1 application, not after.

3. **D4's `jobs` → `closed` transition, in practice.** It is technically undoable (the SQL
   is above), but only until a V1 application lands on a converted posting. After that,
   undoing D4 deletes those applications.

Everything else — `worker_skill`, `worker_industry_tenure`, `job_reach`, `skill_related`,
`match_config`, `skill.kind` / `skill.industry_id`, `job_postings.match_skill_ids` /
`reach_skill_ids` — is fully rebuildable from the taxonomy + `worker_profiles` by re-running
D1/D2/D3/D5.

---

## 8. Known blockers & cross-package dependencies

**8.1 `@badabhai/api` will not build until the backend fix lands.**
Migration 0056 makes `applications.job_id` nullable, which surfaces **two** type errors in
`apps/api/src/applications/applications.repository.ts`:

- **line 181** — `upsertDecision` declares `Promise<Application & { inserted: boolean }>`
  but its `.returning({...})` projection lists only the pre-0056 columns, so it is now
  missing `jobPostingId`, `matchTier`, `skillMonths`, `industryMonths`, `lastWorkedAt`,
  `engineVersion`. *(This is a pre-existing fragility — any new `applications` column would
  have broken it. Fix: either widen the projection or narrow the declared return type.)*
- **line 224** — `findApplicationsByWorker` returns `ApplicationWithJob[]`, whose
  `jobId: string` no longer matches `string | null`. *(Fix: `jobId: string | null` on the
  interface at line 39, and handle the null at the render site.)*

**This does not block applying the migrations.** It blocks the API **deploy**. Land the
backend change with the Matching V1 API, not separately.

**8.2 `@badabhai/taxonomy` must export the V1 vocabulary.**
D1–D5 read `MATCH_SKILLS`, `MATCH_SKILL_RELATION_PAIRS`, `ROLE_TO_MATCH_SKILL`,
`ATTRIBUTE_TO_MATCH_SKILLS`, `TRADE_TO_MATCH_SKILL`. If the installed build lacks any of
them, the script **fails at startup** with the exact list of missing exports and writes
nothing. There is deliberately **no fallback corpus** — the scripts will not invent skill
ids. Run `pnpm build` first.

**8.3 The two `INCLUDE` payloads are hand-appended SQL.**
`worker_skill_reach_idx` (0053) and `job_reach_worker_idx` (0055) carry `INCLUDE (...)`
clauses that drizzle-kit 0.31 cannot model (same gap 0037 hit with `NULLS NOT DISTINCT`).
The Drizzle snapshot records the non-`INCLUDE` form; because name + key columns + `WHERE`
all match, a future `pnpm db:generate` leaves them alone. **Do not "fix" the drift by
regenerating** — you would silently drop the covering payload and turn both hot reads into
heap fetches. `db:verify:match-v1` check **H.include** asserts the payload is really there.

---

## 9. What was verified before this runbook shipped

- The **full migration chain 0001 → 0058 applied cleanly** to a throwaway PostgreSQL 18.4
  cluster (the local Postgres has no pgvector, so the four vector/HNSW statements in 0001 +
  0037 were shimmed; **every Matching V1 statement ran verbatim**).
- Resulting schema: **53 public tables**; all 7 new tables `RLS ENABLED + FORCED`; the
  Data-API roles hold **zero** privileges on any of them; both `INCLUDE` payloads present;
  all 16 new indexes and 17 new CHECK constraints created.
- Behaviour proven with fixtures on that cluster:
  - the ③ reach statement produced **TIER 1** for a worker holding a posted skill *and* a
    related one (E6 best-tier-wins) with `matched_skill_id` = the **direct** skill even
    though the related one had more months; **TIER 2** for a related-only worker; and
    **excluded** a `wants=false` worker. A second run was a no-op (idempotent).
  - `applications_worker_posting_uq` rejected a duplicate (worker, posting) — **E15**.
  - `applications_job_ref_chk` rejected a row with neither job reference.
  - `payment_orders_provider_order_uq` rejected a duplicate provider order — the payment
    idempotency key.
  - `referral_bonus_accruals_invited_uq` rejected a second inviter claiming the same
    referred worker — the fraud rule.
  - **DPDP:** ONE `DELETE FROM workers` erased that worker's rows from `worker_skill`,
    `worker_industry_tenure`, `job_reach`, `referral_bonus_accruals` **and** `applications`
    (all counts → 0). The existing hard-delete enumerates no table names, so **no deletion
    service change is required.** Deleting the *invited* worker also erased the inviter's
    accrual — the flagged consequence in the 0058 header, confirmed rather than assumed.
- **D5 `db:materialize:reach` was executed for real** against that cluster (it needs no
  taxonomy). Dry run planned 2 rows; `--apply` wrote 2, deleted 1 deliberately-stale row,
  and **repaired** a posting whose `reach_skill_ids` had been set to `[]`.
- **D6 `db:grant:free-tier` was executed for real**, twice: the first `--apply` wrote 2
  ledger rows + 2 balances; the second was a **complete no-op** (`already granted = 2`,
  `pending = 0`), and `--repair-balances` reported zero divergence. Exactly-once confirmed.
- **`db:verify:match-v1` was executed in both directions:** it FAILED with exit code **1**
  and named the two real gaps on a half-populated DB (`F.tenure_coverage`, `G.active_row`),
  then PASSED with exit code **0** once they were filled. Its `EXPLAIN` checks confirmed the
  planner really chooses `job_postings_feed_idx`, `worker_skill_reach_idx` and
  `job_reach_worker_idx`, and both `INCLUDE` payloads were confirmed present.
- **A real bug was found and fixed by that run:** Drizzle's `sql` template expands a bare
  JS array into a comma-separated placeholder list (a *record*), so the ③ statement's
  `${posted}::text[]` failed with `42846: cannot cast type record to text[]`. The arrays
  now go through `dsql.param(...)`, which binds one real Postgres array. The comment in
  `materialize-job-reach.ts` says so — do not simplify it back.

### NOT verified

- **Nothing has been applied to any shared, staging, or production database.** Everything
  above ran on a throwaway local cluster.
- **D1, D2, D3 and D4 have NOT been executed**, because they read the V1 taxonomy exports
  (§8.2), which do not exist yet on this branch. Their SQL shapes are reviewed and their
  guards are unit-safe, but treat the first real run of each as its first execution: **use
  dry-run mode first, every time.**
- The duration estimates are reasoned from row counts, **not measured** on production
  hardware.
