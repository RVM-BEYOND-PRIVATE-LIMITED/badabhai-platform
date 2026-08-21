# Supabase / Drizzle Workflow

**Citation note:** no live code cites a specific procedure "from `docs/supabase-workflow.md`" —
the only citations of this exact path are `.claude/agents/devops-engineer.md`'s
ownership-mandate list and this repo's audit documents analyzing it
(`docs/audit/16_OBSERVABILITY_AUDIT.md`, `docs/audit/24_RISK_REGISTER.md` R46). This document is
reconstructed from `.github/workflows/supabase-checks.yml`'s own comments, `supabase/config.toml`,
and the still-existing (pre-CI, Phase 1) planning docs under `infra/supabase/` — this is the
**CI-aware layer on top of those older docs**, not a replacement for them. Where `infra/supabase/`
already documents something well (migration mechanics, storage bucket provisioning, local-dev
options), this file cross-references rather than duplicates.

## Source of truth: Drizzle, not the Supabase CLI

Schema is authored **once**, in `packages/db/src/schema.ts`. Migrations are **generated**, never
hand-written, into `packages/db/migrations/*.sql` by `drizzle-kit generate`. `DATABASE_URL` may
point at local Docker Postgres or a real Supabase project's connection string — either way, the
same Drizzle migration chain is what's authoritative. See `infra/supabase/migration-plan.md` for
the full dev loop and the (optional, not required today) alternative of letting the Supabase CLI
own migration history instead.

```bash
# 1. Edit packages/db/src/schema.ts
pnpm db:generate            # pure diff, no DB connection — writes new SQL + updates the meta journal
# 2. Review the generated SQL in packages/db/migrations/*.sql
pnpm db:migrate             # applies to $DATABASE_URL (local docker or a real Supabase project)
```

## The CI gate this loop must satisfy (`supabase-checks.yml`)

Two DB-discipline checks, triggered on `push`/`pull_request` touching `packages/db/**`, that need
**no live database and no Supabase project** — they protect "Drizzle is source of truth"
structurally:

1. **`migration-drift`** — re-runs `drizzle-kit generate` against the committed `schema.ts` and
   fails if it produces a diff (`git diff --exit-code -- packages/db/migrations`). This is what
   catches "I edited `schema.ts` and forgot to commit the generated migration."
2. **`migration-sequence`** — a pure Node script (no install beyond `actions/setup-node`) that
   asserts every migration filename is `NNNN_<tag>.sql`, prefixes are unique and contiguous
   `0000..N` with no gaps or duplicates, and every file is registered at the matching `idx` in
   `packages/db/migrations/meta/_journal.json`. This is the ordering guarantee behind "migrations
   never run after the code that assumes them" (CLAUDE.md §10) — a duplicate or out-of-order
   prefix is caught here, in CI, rather than surfacing as an apply-order surprise later.

**Both assertion steps currently carry `continue-on-error: true`** — the workflow's own comment
states the intended lifecycle: non-blocking until a clean baseline holds for a few PRs, then flip.
Confirm current status by reading the file directly (or `git log -p`) before assuming either has
flipped one way or the other — do not assume from this document.

**Separately verify the workflow is actually enabled at the GitHub platform level.** A YAML file
present in the tree can still be `disabled_manually` via `gh api
repos/.../actions/workflows` — this exact thing happened to `supabase-checks.yml` for roughly a
month (`docs/audit/24_RISK_REGISTER.md` R43) with no visible sign in the file itself. A green (or
even absent) check for this workflow is not proof it ran; confirm via the GitHub Actions UI or
`gh api` for the workflow's own enabled/disabled state.

**Relationship to `ci.yml`'s `e2e` job**: `e2e` already **applies** the full migration chain from
scratch against a throwaway pgvector Postgres on every relevant PR — that proves the migrations
*run*. `supabase-checks.yml` is the complement — it proves they're *in sync with `schema.ts`* and
*well-ordered*, with no database at all. Neither duplicates or weakens the other.

## Supabase-specific role handling

Migrations `0003`/`0004` `REVOKE` grants from Supabase's `anon`/`authenticated`/`service_role`
roles — these roles exist by default on a real Supabase project but **not** on a plain Postgres
image (local Docker, or `ci.yml`'s `e2e` job's throwaway container). Any workflow that migrates a
non-Supabase Postgres from scratch must pre-create them (idempotently) first — see `ci.yml`'s
"Create Supabase-compatible roles" step (`ci.yml` §e2e job) for the exact `CREATE ROLE ... NOLOGIN`
pattern this repo already uses.

## Row Level Security — current status (verify before relying on this)

Per `docs/audit/24_RISK_REGISTER.md` R1 (re-verified independently for that audit, not merely
carried forward): **0 `CREATE POLICY` statements exist anywhere in the migration chain, across
all 65 tables** — RLS is not finalized platform-wide. `infra/supabase/rls-plan.md` documents the
intended per-table plan and states plainly why this is currently acceptable: in Phase 1 the
NestJS backend connects with the Supabase **service role** and is the only client touching these
tables — no untrusted client connects directly. `payers` (migration `0020`) is the one table
already `ENABLE`+`FORCE ROW LEVEL SECURITY`+`REVOKE ALL`'d, so it is deny-by-default today even
without a `CREATE POLICY`. Designing and authoring RLS policies is a Backend Platform +
Architect decision (CLAUDE.md §5/§7) — this document only describes the CI/workflow surface
around it, and does not itself decide when policies land.

## Storage buckets — provisioned out-of-band, not by a Drizzle migration

Supabase Storage object ACLs are **not** covered by RLS on Postgres tables — bucket creation and
policy is a separate, manual step via `infra/supabase/storage-buckets.sql`, run against the
Supabase dashboard/CLI directly, not through `pnpm db:migrate`. See
`infra/supabase/storage-buckets.md` for the full bucket list and privacy requirements (every
bucket referenced in `.env.example` — `RESUMES_BUCKET`, `INTERVIEW_KIT_BUCKET`,
`VOICE_NOTES_BUCKET`, `WORKER_PHOTOS_BUCKET` — must be created **private**; an empty bucket env
var means the feature is dormant, not that the bucket doesn't need to be private once created).

## Local development without a Supabase project

`supabase/config.toml` at the repo root configures a **local** Supabase stack
(`supabase start`, API on `:54321`, Postgres on `:54322`) for anyone who wants the full Supabase
toolchain locally — `major_version = 17`, matching the target project. This is optional: the
day-to-day dev loop (`pnpm db:up` → docker-compose Postgres/Redis → `pnpm db:migrate`) needs
neither the Supabase CLI nor Docker's `supabase start` stack. See
`infra/supabase/local-dev.md` for the documented local-dev options and the root `README.md` /
`start-dev.sh` for the no-Docker path.

## What this document does not cover

The RLS policy design itself (Backend Platform + Architect own authoring;
`infra/supabase/rls-plan.md` records the plan); Storage bucket policy content (see
`infra/supabase/storage-buckets.md`); linking a real Supabase project for the first time (see
`infra/supabase/README.md`'s "Linking a project" section — unchanged by this reconstruction);
whether `supabase-checks.yml` has since flipped to blocking or been re-enabled at the platform
level (verify directly — this document deliberately does not assert a point-in-time answer that
would go stale).
