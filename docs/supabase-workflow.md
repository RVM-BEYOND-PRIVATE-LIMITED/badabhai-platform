# Supabase + Migration Workflow

> Operating doc for how schema changes flow from Drizzle into Supabase Postgres, and
> the discipline around it. This page **consolidates and links** the detailed plans in
> [`infra/supabase/`](../infra/supabase/) — it does not duplicate them. Read the linked
> files for the runbooks; read this for the rules and the "who/when".
>
> Authoritative invariants live in [CLAUDE.md](../CLAUDE.md) §2 and §6. Schema/ownership
> facts live in [`.claude/project-memory.md`](../.claude/project-memory.md) and
> [`.claude/team-memory.md`](../.claude/team-memory.md). When this doc and those conflict,
> the memory files + CLAUDE.md win — fix this page.

---

## 1. Source of truth: Drizzle, not Supabase

The schema is authored **once** in Drizzle and applied to Postgres (local docker or a
Supabase project). There is exactly one source of truth:

- **Schema:** [`packages/db/src/schema.ts`](../packages/db/src/schema.ts).
- **Migrations:** generated SQL in [`packages/db/migrations/`](../packages/db/migrations/),
  tracked by `migrations/meta/_journal.json`.
- **Drizzle Kit config:** [`packages/db/drizzle.config.ts`](../packages/db/drizzle.config.ts)
  (`dialect: postgresql`, `out: ./migrations`, `strict: true`; loads the repo-root `.env`
  for `DATABASE_URL`).

**Generated Supabase TypeScript types are N/A for this repo.** We use Drizzle's inferred
row types as the primary types throughout the services; we do **not** run
`supabase gen types` as part of the normal flow. (It exists as an _optional_ aid only —
see [`infra/supabase/migration-plan.md`](../infra/supabase/migration-plan.md) — and is
never the schema authority.)

---

## 2. The canonical change flow

```bash
# 1. Edit the schema
#    packages/db/src/schema.ts   (add column/index/table — additive, backward-compatible)

# 2. Generate a migration (NO DB connection needed — diffs schema.ts -> SQL)
pnpm db:generate
#    => pnpm --filter @badabhai/db db:generate => drizzle-kit generate

# 3. REVIEW the emitted SQL before it lands
#    packages/db/migrations/00NN_*.sql   (read every line; this is what runs on prod later)

# 4. Apply it to DATABASE_URL (local docker or a Supabase project)
pnpm db:migrate
#    => drizzle-kit migrate
```

Root scripts (`package.json`): `db:generate`, `db:migrate`, `db:up` / `db:down`
(docker compose Postgres+Redis). Package scripts (`packages/db/package.json`):
`db:generate`, `db:migrate`, `db:studio`, `db:seed`, `db:seed:questionnaire`,
`db:seed:jobs`.

**Step 3 is not optional.** The reviewer for any DB PR reads the generated SQL, not just
the schema diff. Drizzle can emit table rewrites, default backfills, and `NOT NULL` adds
that look harmless in `schema.ts` but lock or rewrite a table in Postgres.

Full runbook + the Drizzle↔Supabase-CLI fork: [`infra/supabase/migration-plan.md`](../infra/supabase/migration-plan.md).
Local DB options (docker / local Supabase / remote project): [`infra/supabase/local-dev.md`](../infra/supabase/local-dev.md).
Folder overview: [`infra/supabase/README.md`](../infra/supabase/README.md).

---

## 3. Migration naming + sequencing (collision discipline)

Migrations are **forward-only and numerically sequential**: `0000_*.sql` … `00NN_*.sql`.
Two developers (Prakash, Divyanshu — see [`.claude/team-memory.md`](../.claude/team-memory.md))
both author migrations against the **shared** `packages/db/` package, so number
collisions are the main hazard.

Rules:

1. **Check the latest number first.** Before `pnpm db:generate`, look at the highest
   `00NN_*.sql` in [`packages/db/migrations/`](../packages/db/migrations/) **and** the
   last entry in `migrations/meta/_journal.json`. The current latest on `main` is
   **`0017_melodic_pretty_boy`** — so the next number is **`0018`**.
   > TODO(verify): `.claude/team-memory.md` still says "latest 0015 / next 0016" — that
   > section is stale (the directory already has 0016 and 0017). Trust the directory +
   > `_journal.json`, not the memory note, and update the memory note in the same PR.
2. **Never reuse or duplicate a number.** Two PRs that both create `0018_*.sql` will both
   pass in isolation and collide on merge — the journal hashes won't line up and one
   branch's migration silently won't apply. Rebase and renumber before merge.
3. **Coordinate across owners.** `packages/db/` is jointly owned. Divyanshu owns the
   reach/jobs/postings/unlock tables; Prakash owns the core worker/auth/events/profiles
   tables. Ping the other owner before generating a migration that touches a shared or
   cross-domain table. (Ownership map: [`.claude/team-memory.md`](../.claude/team-memory.md).)
4. **Don't hand-edit a migration after it's applied anywhere shared.** Drizzle records a
   hash in the journal; editing applied SQL desyncs every other environment. Fix forward
   with a new migration.
5. **Naming.** Drizzle auto-names migrations (`00NN_<random_slug>.sql`). A few here were
   hand-named for intent (`0003_harden_workers_pii`, `0004_workers_force_rls_revoke`,
   `0009_spine_rls_revoke`). Hand-naming is fine for security/RLS migrations where the
   slug should be self-documenting; keep the `00NN_` prefix and the journal `tag` in sync
   with the filename.

---

## 4. Environment rules: local vs staging vs prod

`DATABASE_URL` selects the target. See [`infra/supabase/local-dev.md`](../infra/supabase/local-dev.md)
for the three local options (docker-compose Postgres — simplest; local Supabase stack —
needs Docker; remote Supabase project).

| Environment  | `DATABASE_URL` target                                        | Who applies                                       | Notes                                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local**    | docker-compose Postgres (`db:up`) or local Supabase          | the developer                                     | `db:generate` + `db:migrate` freely; throwaway data.                                                                                                                                                                          |
| **CI / e2e** | `pgvector/pgvector:pg16` service container (`badabhai_test`) | [`ci.yml`](../.github/workflows/ci.yml) `e2e` job | Fresh DB each run; full migration chain re-applied from `0000`, which _also validates every migration on every PR_. Pre-creates Supabase roles `anon`/`authenticated`/`service_role` so the REVOKE migrations apply.          |
| **Staging**  | linked Supabase project conn string                          | human-gated, staging-first                        | Real-LLM / OTP / payment gates flip here **first**, never prod-first (CLAUDE.md §2.5, team-memory env-gates). Apply via `pnpm db:migrate` or `supabase db push` — pick **one** authority per environment, never double-apply. |
| **Prod**     | prod Supabase project                                        | **sign-off required**                             | Never apply a migration to prod without review + a rollback note. Destructive prod migrations → escalate (§7).                                                                                                                |

Hard rules:

- **Tests NEVER touch staging or prod.** The e2e suite runs against a disposable CI
  Postgres container (`badabhai_test`) only. There is no path from `pnpm test` /
  `pnpm --filter @badabhai/e2e test` to a real Supabase project, and there must not be —
  do not point `DATABASE_URL`/`E2E_DATABASE_URL` at a shared DB.
- **Backend connects as the Supabase service role today (TD4).** In Phase 1 the NestJS
  API is the only client and uses the service role (effectively `BYPASSRLS`). This is a
  known, _paying-down_ tech-debt item (TD4 in [`.claude/project-memory.md`](../.claude/project-memory.md)
  and [`.claude/team-memory.md`](../.claude/team-memory.md)), and it is a **DevOps/Security
  gate before production** — least-privilege app role + finalized RLS must land first.
- **One migration authority per environment.** Either Drizzle owns history _or_ the
  Supabase CLI does — see [`infra/supabase/migration-plan.md`](../infra/supabase/migration-plan.md).
  Don't mix them for the same environment.

---

## 5. RLS: planned, not finalized — and how it's tested

RLS is **not finalized in Phase 1** and is a Security-owned escalation, not a free
schema change. The plan (per-table policy matrix, `current_worker_id()` mapping, the
"enable before any direct-client access" checklist) lives in
[`infra/supabase/rls-plan.md`](../infra/supabase/rls-plan.md). Background:
[ADR-0004](decisions/0004-pii-at-rest-and-rls.md).

What **is** enforced today is the **REVOKE spine**: every application table revokes all
grants from the PostgREST Data-API roles (`anon` / `authenticated` / `service_role`), so
`worker_id`, correlation ids, and the encrypted-PII linkage are unreachable with any
Supabase client key. `workers` was locked in `0003`/`0004`; the rest of the spine in
`0009`; `jobs`+`applications` in `0012`.

**RLS / REVOKE-spine test plan:** the regression lives in
[`tests/e2e/rls-spine.e2e.test.ts`](../tests/e2e/rls-spine.e2e.test.ts) (TD20). It is the
gate that proves the lock is real, and it is **self-policing**:

- It reconciles a static locked-table list against the **live** `public` schema
  (`pg_tables`) _and_ the Drizzle `schema` model count — so a new `pgTable` that ships
  **without** a REVOKE lock **fails this suite** instead of being silently skipped.
- It asserts `has_table_privilege` is false for SELECT **and** INSERT/UPDATE/DELETE
  (a table that revoked only SELECT but kept a write grant fails here).
- It runtime-checks a `SET ROLE anon -> SELECT -> 42501` denial, plus a
  backend-can-still-read sanity so the lock never breaks the app.

**Implication for any new table:** if you add a `pgTable`, you must also add its REVOKE
lock in the same migration, or `rls-spine.e2e.test.ts` goes red. Coordinate the policy
shape with Security; do **not** invent RLS policies ad hoc.

---

## 6. Storage buckets are out-of-band (not a Drizzle migration)

Supabase Storage buckets are **deliberately not** in the Drizzle migration chain. The
chain also runs against plain Postgres (docker / `pgvector` in CI), which has **no
Supabase `storage` schema** — a migration touching `storage.buckets` would break
`pnpm db:migrate` there.

So buckets are provisioned **directly against the Supabase project**, idempotently, via
[`infra/supabase/storage-buckets.sql`](../infra/supabase/storage-buckets.sql)
(runbook + verification: [`infra/supabase/storage-buckets.md`](../infra/supabase/storage-buckets.md)).
The local stack mirrors them declaratively in [`supabase/config.toml`](../supabase/config.toml)
under `[storage.buckets.*]`. Keep the SQL, the `config.toml` block, and the runbook in sync.

- `worker-resumes` — **PRIVATE**; PDFs contain the worker's real name; read only via
  short-TTL signed URL minted by the backend (service role). Launch gate R13 / TD5 /
  [ADR-0007](decisions/0007-resume-render-node-boundary.md).
- `interview-kits` — **PRIVATE**; per-trade (PII-free) but still signed-URL-only.
- `worker-conversations` / `voice-notes` — same private model, provisioned later when
  their feature gates close (R10).

Do **not** add an `anon`/`authenticated` SELECT policy on `storage.objects` for these
buckets — privacy is deny-by-default + service-role-only reads.

---

## 7. Drift gate: `supabase-checks.yml`

The drift gate **ships** as [`.github/workflows/supabase-checks.yml`](../.github/workflows/supabase-checks.yml)
(Phase-4, alongside secret-scan / SAST / dependency-audit in
[`security-scan.yml`](../.github/workflows/security-scan.yml)). It is **path-filtered** to
`packages/db/**`, uses **no database and no secrets**, and is **non-blocking** today
(advisory `continue-on-error`) — flip to blocking after a clean baseline.

Purpose: catch **schema drift** — the failure mode where someone edits `schema.ts` but
forgets to run `pnpm db:generate` (or commits a hand-edited migration), so the committed
migrations no longer reproduce the declared schema.

The two jobs (operator detail in [`docs/github-actions.md`](github-actions.md) §4):

1. **`migration-drift`** — runs `pnpm --filter @badabhai/db db:generate` (a pure schema
   **diff**; `drizzle.config.ts` defaults `DATABASE_URL`, so no DB connection is made) and
   asserts `git diff --exit-code -- packages/db/migrations` is clean. A non-empty diff ⇒
   `schema.ts` changed without a committed migration ⇒ **drift**.
2. **`migration-sequence`** — a static Node check that the `00NN_` prefixes are unique +
   contiguous and that `meta/_journal.json` agrees (the collision guard for §3).

This complements the existing [`ci.yml`](../.github/workflows/ci.yml) `e2e` job, which
re-applies the **full** chain from `0000` on every PR (so a broken/ordering-bad migration
fails CI) and runs `rls-spine.e2e.test.ts` (a new table without its lock fails). Those
prove the migrations _run_; `supabase-checks.yml` proves they're _in sync_ with `schema.ts`
— the "schema.ts edited but no migration generated" gap neither e2e check catches.

---

## 8. Destructive migrations: escalate, never auto-run

A migration is **destructive/irreversible** if it drops a column/table in use, drops or
narrows a type, removes a constraint relied on, rewrites a large table, or otherwise
cannot be cleanly rolled back. These are an **escalation**, not a routine PR
(CLAUDE.md §7; backward-compat invariant §2.8).

- **Default to additive.** Add columns/indexes/tables; never mutate a shipped event
  payload or drop an in-use column. Need to remove something? Use
  **expand → migrate → contract** across multiple releases (add new, dual-write/backfill,
  switch reads, then drop in a later, separately-reviewed migration).
- **Every migration is reversible or has a written data plan.** A non-trivial change
  ships with a rollback note in the PR (how to undo, and what happens to data).
- **Never auto-apply a destructive migration to a shared/remote DB.** Stop and get human
  sign-off. CI's fresh-DB e2e run does **not** count as validation for a destructive prod
  change — it never sees prod data.
- Migration-mechanics conventions (status columns as `text`, `CHECK` constraints added in
  follow-ups, partial/hot-query indexes, `events` partitioning if volume grows) are
  tracked in [`infra/supabase/migration-plan.md`](../infra/supabase/migration-plan.md).

---

## 9. Quick checklist for a DB PR

Mirrors [CLAUDE.md §6](../CLAUDE.md) for the DB-specific items:

- [ ] Edited `packages/db/src/schema.ts` (source of truth) — change is **additive /
      backward-compatible**.
- [ ] Checked the latest `00NN` in `packages/db/migrations/` **and** `_journal.json`;
      new migration uses the next free number (no duplicate).
- [ ] Ran `pnpm db:generate` and **read every line** of the emitted SQL.
- [ ] New table ⇒ added its REVOKE lock in the same migration (else
      `rls-spine.e2e.test.ts` fails). RLS policy shape coordinated with Security.
- [ ] New hot query path ⇒ added an index.
- [ ] No raw PII anywhere except `workers` (LLM input / events / `ai_jobs` /
      `audit_logs` / logs carry ids/hashes only).
- [ ] Storage change ⇒ updated `infra/supabase/storage-buckets.sql` **and**
      `supabase/config.toml`, not a Drizzle migration.
- [ ] Rollback note in the PR; destructive change ⇒ **escalated** + signed off.
- [ ] Coordinated with the other `packages/db/` owner if the table is shared/cross-domain.
- [ ] Updated `.claude/project-memory.md` / `.claude/team-memory.md` (table count,
      latest migration number) in the same PR.
