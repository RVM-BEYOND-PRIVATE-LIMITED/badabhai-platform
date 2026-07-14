# GitHub Actions (CI/CD)

> What runs on every PR to `main`, what blocks a merge, and how to read a red
> check. This is the operator's map of the pipeline — it links to the workflow
> YAML rather than restating it; the YAML is the source of truth.

CI is split across **four** workflows. Two are full-monorepo gates that run on
every PR (`ci.yml`, plus the path-filtered `worker-app.yml`); two are the
Phase-4 security/drift gates added alongside this doc (`security-scan.yml`,
`supabase-checks.yml`). There is **no deploy workflow yet** — see
[Deploy & rollback](#deploy--rollback-not-yet-wired).

| Workflow        | File                                                              | Trigger            | Path-filtered?             | Blocking?         |
| --------------- | ----------------------------------------------------------------- | ------------------ | -------------------------- | ----------------- |
| CI              | [`ci.yml`](../.github/workflows/ci.yml)                           | push + PR → `main` | no                         | yes               |
| Worker app      | [`worker-app.yml`](../.github/workflows/worker-app.yml)           | push + PR → `main` | yes (`apps/worker-app/**`) | yes               |
| Security scan   | [`security-scan.yml`](../.github/workflows/security-scan.yml)     | push + PR → `main` | no                         | **no — advisory** |
| Supabase checks | [`supabase-checks.yml`](../.github/workflows/supabase-checks.yml) | push + PR → `main` | yes (`packages/db/**`)     | **no — advisory** |

> Both Phase-4 workflows are **non-blocking** today (advisory `continue-on-error`) so a
> fresh false positive never red-X's the merge or the 2026-06-25 alpha cut. Each flips to
> blocking only after it holds a clean baseline — see the per-section flip criteria below
> and the headers of the YAML files.

---

## 1. `ci.yml` — TypeScript monorepo + AI service + E2E

**File:** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
**Trigger:** `push` and `pull_request` on `main`.
**Concurrency:** `ci-${{ github.ref }}` with `cancel-in-progress` — a new push to
the same ref cancels the older run.
**Blocking:** yes. All three jobs gate the merge.

pnpm is set up via `pnpm/action-setup@v6` with **no `version:`** — the
`packageManager` field in `package.json` (`pnpm@11.5.2`) is the single source;
pinning it twice triggers `ERR_PNPM_BAD_PM_VERSION`. Node is **22**.

### Jobs

- **`node` (lint / typecheck / test / build).** `pnpm install --frozen-lockfile`
  then `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build` (Turbo order).
  Mirrors the local gate in [`CLAUDE.md` §6](../CLAUDE.md).
- **`ai-service` (pytest / ruff).** Python 3.12, `working-directory:
apps/ai-service`, `pip install -r requirements-dev.txt`, then `ruff check .`
  and `pytest`. Runs on **every** PR (not path-filtered).
- **`e2e` (Phase 1 onboarding flow).** Real `pgvector/pgvector:pg16` Postgres +
  `redis:7` service containers. Drives the full journey
  login → consent → multi-turn interview → state persistence → AUTO extraction →
  `extraction_completed` → AI-metadata persistence → no-raw-phone → confirm →
  resume. The FastAPI AI service is **intentionally not started**: the API falls
  back to its safe mock (`real_call=false`), so the flow + its events complete
  offline. A regression here **fails the PR**.

### E2E job mechanics (the parts that bite)

- **Supabase roles.** Migrations `0003`/`0004` `REVOKE` from `anon` /
  `authenticated` / `service_role`, which don't exist on a plain image. The job
  pre-creates them idempotently before migrating; the RLS regression test then
  exercises `SET ROLE` denials.
- **Migrations + seed.** `pnpm --filter @badabhai/db db:migrate` applies the full
  chain from scratch (so migrations themselves are validated on every PR), then
  `db:seed:jobs` seeds the PII-free alpha job catalog the swipe-to-apply e2e reads.
- **Env knobs (CI-only, not real secrets):** `NODE_ENV=test`,
  `DATABASE_URL`/`REDIS_URL` to the service containers, `API_PORT=3001`,
  `RUN_E2E=1`, `OTP_MAX_SENDS_PER_HOUR=1000` (one shared CI egress IP would
  otherwise 429 the suite), and a throwaway `INTERNAL_SERVICE_TOKEN` so the
  `InternalServiceGuard` resume routes are reachable. None are production secrets.
- **Readiness:** the API is started in the background and polled on `/health` for
  up to 60s; if it exits during startup the job dumps `api.log` and fails.

### Reading a failure

- **`node` red.** Reproduce with `pnpm lint && pnpm typecheck && pnpm test &&
pnpm build`. If you see `@badabhai/*` resolution errors locally, run
  `pnpm build` first (Turbo dependency order) — see [`CLAUDE.md` §5](../CLAUDE.md).
- **`ai-service` red.** From `apps/ai-service`: `ruff check .` then `pytest`.
- **`e2e` red.** Open the failing run; the step tails the last 80 lines of
  `api.log` after the suite. Common causes: a migration that doesn't apply on a
  fresh DB, a new endpoint that doesn't emit its event, or raw PII leaking into
  an event/`ai_jobs` row (the privacy assertions fail closed).

---

## 2. `worker-app.yml` — Flutter (path-filtered, blocking)

**File:** [`.github/workflows/worker-app.yml`](../.github/workflows/worker-app.yml)
**Trigger:** `push` and `pull_request` on `main`, **filtered** to
`apps/worker-app/**` and the workflow file itself.
**Blocking:** yes (TD002 — this replaced the old non-blocking `worker-app` job in
`ci.yml`). A red check means do not merge. Unrelated PRs neither pay the Flutter
cost nor wait on it.

### Job

- **`analyze-test`.** Flutter is **pinned** (`subosito/flutter-action@v2`,
  `flutter-version: 3.27.4`, `channel: stable`, `cache: true`) so the analyzer
  ruleset (`flutter_lints` 5.x against the bundled Dart 3.6) is reproducible —
  bump deliberately, not implicitly. Steps: `flutter pub get` → `flutter analyze`
  (analyzer findings at error/warning/info all fail) → `flutter test`
  (the scaffold ships a runnable `test/widget_test.dart`, so the suite gates too).

### Reading a failure

From `apps/worker-app`: `flutter analyze && flutter test`. If the suite turns
flaky or starts needing an emulator, revisit the gate deliberately — do **not**
silently add `continue-on-error`.

---

## 3. `security-scan.yml` — secret-scan / SAST / dependency-audit (Phase 4)

**File:** [`.github/workflows/security-scan.yml`](../.github/workflows/security-scan.yml)
**Purpose:** close the gap that no secret-scan / SAST / dependency-audit gate
exists yet. Complements the agent-side fail-closed guard
([`.claude/hooks/guard-secrets.mjs`](../.claude/hooks/guard-secrets.mjs)) by
catching anything that reaches the repo or a PR diff.

**The three jobs** (all `continue-on-error: true` → advisory; all license-free):

- **`secret-scan` (gitleaks).** Official `zricethezav/gitleaks` Docker image over the
  **full git history** (`fetch-depth: 0`), `--redact` so no matched value hits the log.
  License-free — deliberately **not** `gitleaks/gitleaks-action`, whose v2 needs a paid
  GitHub-Org licence. Complements the agent-side fail-closed guard
  ([`.claude/hooks/guard-secrets.mjs`](../.claude/hooks/guard-secrets.mjs)).
- **`sast` (semgrep OSS).** `semgrep scan` in the `semgrep/semgrep` image with OSS rulesets
  (`p/default`, `p/typescript`, `p/python`, `p/secrets`) and **no `SEMGREP_APP_TOKEN`**.
- **`dependency-audit`.** `pnpm install --frozen-lockfile` then `pnpm audit --audit-level high`.

**Flip-to-blocking** (drop `continue-on-error` per job): secret-scan first, once a full run
is clean or a `.gitleaks.toml` allowlists the known `.env.example` placeholders; then
sast/dependency-audit once triaged to a clean baseline (or a tracked exception in
[`docs/registers/`](registers/)). The YAML header records the criteria.

### Reading a failure

- **secret-scan red.** Reproduce with the same image:
  `docker run --rm -v "$PWD:/repo" zricethezav/gitleaks detect --source=/repo --redact -v`.
  A real hit is a **rotate-and-purge incident** — never echo the value into a PR/log;
  rotate the credential, purge it from history, escalate per [`CLAUDE.md` §7](../CLAUDE.md).
- **sast red.** `semgrep scan --config p/default --config p/typescript --config p/python --config p/secrets`.
- **dependency-audit red.** `pnpm audit --audit-level high`; fix or track an exception.

---

## 4. `supabase-checks.yml` — schema/migration drift (Phase 4)

**File:** [`.github/workflows/supabase-checks.yml`](../.github/workflows/supabase-checks.yml)
**Purpose:** guard the Drizzle ↔ Supabase relationship. Drizzle
([`packages/db/src/schema.ts`](../packages/db/src/schema.ts)) is the **schema
source of truth** — _not_ Supabase generated types — so this gate's job is to
catch a `schema.ts` change that wasn't accompanied by a generated migration, and
to flag drift between the migration chain and the declared schema.

**Trigger:** push + PR to `main`, **path-filtered** to `packages/db/**` (and the workflow
file). **No database, no secrets** — both jobs are static / schema-only.

**The two jobs** (assertion steps `continue-on-error` → advisory):

- **`migration-drift`.** `pnpm --filter @badabhai/db db:generate` (a pure schema **diff** —
  `drizzle.config.ts` defaults `DATABASE_URL`, so no DB connection), then
  `git diff --exit-code -- packages/db/migrations`. A non-empty diff means `schema.ts`
  changed but the generated migration wasn't committed.
- **`migration-sequence`.** A pure Node check that `packages/db/migrations` filenames are
  uniquely + contiguously numbered (`0000…00NN`, no gaps/dupes) and that each is registered
  at the right `idx`/`tag` in `meta/_journal.json`.

This complements [`ci.yml`](../.github/workflows/ci.yml)'s `e2e` job, which **applies** the
full chain from scratch on every PR (proving the migrations _run_); this workflow proves
they're _in sync_ with `schema.ts` and well-ordered, with no DB.

**Flip-to-blocking:** drop the `continue-on-error: true` lines once a clean baseline holds —
a missing migration violates "migrations run **before** the code that assumes them."

### Reading a failure

- **`migration-drift` red.** Run `pnpm db:generate`, review the emitted SQL in
  [`packages/db/migrations/`](../packages/db/migrations), commit it, and ensure it lands
  **before/with** the dependent code. See [`docs/supabase-workflow.md`](supabase-workflow.md).
- **`migration-sequence` red.** A duplicate/out-of-order `00NN_` prefix or a journal
  mismatch — renumber/rebase so prefixes are contiguous and `_journal.json` agrees.

---

## Merge gates

Mirror of [`.github/pull_request_template.md`](../.github/pull_request_template.md)
and [`CLAUDE.md` §6](../CLAUDE.md). A PR merges only when every applicable gate is
green.

| Gate                                                               | Enforced by                                     | Blocking                   |
| ------------------------------------------------------------------ | ----------------------------------------------- | -------------------------- |
| `pnpm lint` / `typecheck` / `test` / `build`                       | `ci.yml` → `node`                               | yes                        |
| AI service `ruff check .` + `pytest`                               | `ci.yml` → `ai-service`                         | yes                        |
| Phase 1 E2E onboarding flow                                        | `ci.yml` → `e2e`                                | yes                        |
| Flutter `analyze` + `test` (on `apps/worker-app/**`)               | `worker-app.yml`                                | yes                        |
| No secrets / `.env` committed                                      | `security-scan.yml` secret-scan (+ agent guard) | advisory now → block first |
| SAST / dependency audit                                            | `security-scan.yml` sast + dependency-audit     | advisory (non-blocking)    |
| Schema ↔ migration in sync (no Drizzle drift)                      | `supabase-checks.yml`                           | advisory (non-blocking)    |
| No raw PII in LLM input / events / `ai_jobs` / `audit_logs` / logs | `ci.yml` e2e assertions + `/security-review`    | yes (e2e) + review         |
| Every important new endpoint emits a **validated** event           | `ci.yml` e2e + review                           | partial + review           |
| DB change is backward-compatible + has migration + rollback note   | review (PR template)                            | review                     |
| Event payload change versioned (not mutated)                       | review (PR template)                            | review                     |
| AI-contract parity (Zod ↔ Pydantic)                                | review (PR template)                            | review                     |
| Docs / registers updated                                           | review (PR template)                            | review                     |

"review" = enforced by the PR template + `/code-review` / `/security-review`, not
by a CI job. CI cannot prove backward compatibility or contract parity on its
own; those stay human-gated.

---

## Deploy & rollback (not yet wired)

There is **no deploy workflow** in this repo, by design:

- **Staging vs. prod separation is not wired.** The deploy target is unchosen,
  so there is no environment promotion, no `environment:` protection rules, and
  no secrets-manager binding yet (planned — TD10, before multi-env). CI today
  validates _buildability and correctness_, not delivery.
- **Production promotion + rollback are planned as manual
  `workflow_dispatch`** workflows — explicitly operator-triggered, never on
  push. They do not exist yet; do not infer one.
- The procedures they will encode are documented now:
  - [`docs/release-checklist.md`](release-checklist.md) — pre-promotion checklist (env
    gates default-safe, migrations applied **before** dependent code, real-provider flags
    reviewed).
  - [`docs/rollback-guide.md`](rollback-guide.md) — how to safely revert a release,
    including migration/data considerations.

### Safety rails that already hold without a deploy pipeline

Even pre-deploy, the boot guards in
[`packages/config/src/server.ts`](../packages/config/src/server.ts) keep the
gates fail-safe by default — see [`.env.example`](../.env.example) for the
variable names and intent (placeholders only, never values):

- `AI_ENABLE_REAL_CALLS` defaults **false** (real LLM traffic is off; pseudonymize
  still runs first regardless) — [`CLAUDE.md` §2.5](../CLAUDE.md).
- `RESUME_RENDER_ENABLED` defaults **false** (no PDF render without the binary).
- `PAYMENTS_ENABLE_REAL` defaults **false**.
- `SMS_PROVIDER=console` is dev-only; the API refuses to boot with it outside
  `development`/`test`.
- `INTERNAL_SERVICE_TOKEN` unset → ops/backend resume routes deny **all** callers
  (fail closed).
- PII crypto / auth / payments boot assertions (`assertPiiCryptoConfig`,
  `assertAuthConfig`, `assertPaymentsConfig`, `realAiCallsBlockedReason`) refuse
  to boot with dev defaults under `NODE_ENV=production`.

**Escalate before** enabling any real external provider in a shared environment,
before any production data operation, and on any DR / secrets-management gap —
per [`CLAUDE.md` §7](../CLAUDE.md).
