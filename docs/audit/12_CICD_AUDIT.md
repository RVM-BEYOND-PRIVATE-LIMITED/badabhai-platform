# 12 — CI/CD Audit

Evidence-based inventory of every workflow under `.github/workflows/` (10 files, confirmed via `git ls-tree origin/main` — matches Batch 1's system-boundary count exactly), read in full, cross-checked against live GitHub state via `gh api` (branch protection, environments, secret names — never values, workflow run history). Where a claim depends on live platform state (not just the YAML), that is called out explicitly, because a workflow file's `on:` block is not proof of what actually executes.

**⚠️ Two findings in this document (F2, F4) describe live operational risk and are elevated into [22_REMEDIATION_BACKLOG.md](22_REMEDIATION_BACKLOG.md) at P0/P1 — read those before this summary table if you're triaging.**

## Summary table

| File | Trigger | Deploy target | Classification |
|---|---|---|---|
| `ci.yml` | push/PR(main) | GHCR images + AWS Lightsail | **KEEP** |
| `worker-app.yml` / `payer-app.yml` | `workflow_call` only | none (analyze/test gate) | **KEEP** |
| `sast.yml` / `dependency-audit.yml` | `workflow_call` only | none | **KEEP** |
| `security-scan.yml` | schedule (weekly) | none | **KEEP** — 1 LOW finding (F5, unpinned gitleaks tag) |
| `supabase-checks.yml` | push/PR on `packages/db/**` | none | **KEEP, but currently non-functional — F2 (disabled at platform level)** |
| `staging-cd.yml` | `workflow_dispatch` only | persistent staging host (not Lightsail) | **KEEP — verified genuinely inert today, F3** |
| `staging-demand-verify.yml` | `workflow_dispatch` only | whatever `DATABASE_URL` resolves to in `staging` | **KEEP, but re-scope urgently — F4, structurally NOT inert** |
| `cleanup-issues-prs.yml` | schedule + `workflow_dispatch` | none (GitHub metadata only) | **KEEP** |

No file is a DELETE or CONSOLIDATE candidate. The two strongest findings are about a workflow that **silently doesn't run** (F2) and a workflow whose **"inert by default" framing isn't backed by the current secret topology** (F4) — not about redundant workflows.

## Per-workflow detail

### `ci.yml` — the sole required gate + the sole active CD path

Push(main)/PR(main), concurrency-cancelled. This one file is simultaneously CI and the CD workflow for the always-on Lightsail box — no separate deploy file exists for that target. Jobs: `changes` (paths-filter driving every other job), `worker-app`/`payer-app` (call the reusables), `sast` (PR-diff-scoped), `deps-audit`, `node` (lint/oxlint/typecheck/vitest+coverage/pack+occupation gates/smoke self-test/build — **no path filter, always runs**), `ai-service`/`ai-service-image` (path-gated), `e2e` (full Postgres+Redis chain + the 4 `RUN_DB_TESTS` gates, path-gated), `ci-required` (the aggregator, `if: always()`), `build-and-push-image`/`deploy-lightsail` (push+main only, not required).

**Verified live**: last 8 push-to-main runs (2026-08-12→13) all show `deploy-lightsail` reaching `success` or `cancelled` (superseded, not failure) — the deploy path is exercised on every merge, not merely defined. **Migrations explicitly not yet run by this pipeline** — self-documented `TODO(CD-2, held: 0031 human sign-off + D1)`.

### `worker-app.yml` / `payer-app.yml` — Flutter gates

`workflow_call` only (deliberately removed standalone triggers per #718 — a standalone trigger meant `ci-required` couldn't `needs:` it, and PR #711 measured this gap for real: the Flutter gate failed while `ci-required` stayed green). `flutter analyze`+`flutter test`, blocking. Flutter 3.35.7/Dart 3.9.2 pinned explicitly, not `channel: stable` — the pin previously drifted to 3.27.4 and broke the gate once already (in-file comment is evidence of that prior incident). No deploy step of any kind (confirms Batch 1: no store-upload path in this repo).

### `sast.yml`

`semgrep scan` (OSS CLI, `p/default`+`p/typescript`+`p/python`+`p/secrets`), engine pinned by image digest but **rulesets fetched live from semgrep's registry and cannot be pinned by the OSS CLI** — self-documented residual risk (#774), mitigated by the two-caller split: per-PR (diff-scoped via `baseline-ref`, so a ruleset change doesn't fail an unrelated PR) and weekly whole-tree (catches ruleset drift + direct pushes to main).

### `dependency-audit.yml`

`pnpm audit --audit-level high`, fully deterministic (no live-fetched ruleset unlike SAST). Was `continue-on-error: true` reporting 18 high advisories on every lockfile-touching PR until #788/#792 cleared them via overrides and flipped it blocking. Confirmed clean.

### `security-scan.yml`

Schedule-only (`30 2 * * 0`) — the `pull_request` trigger was **removed** in `e9c901497` (2026-08-12, #788/#792/#804), confirmed via `git log` + live run history (post-commit runs show no `pull_request` event). Owns `secret-scan` (gitleaks, `continue-on-error: true`) directly, calls `sast`+`dependency-audit` whole-tree. Three schedule runs observed (07-26, 08-02, 08-09), all `success`, ~1–3h after the cron target (normal GH deferral); **the next Sunday postdates this audit**, so "the new schedule-only config still fires" is inferred, not directly verified.

**F5 (LOW)**: `secret-scan` runs `zricethezav/gitleaks:latest` — the **one unpinned image tag** in an otherwise consistently-SHA/digest-pinned pipeline (every other action/image, e.g. `actions/checkout@3d3c42e5…#v7`, `semgrep/semgrep@sha256:bdf70…`, carries a version comment). Contradicts this repo's own reproducibility convention. Lower severity because the job is advisory (`continue-on-error`) and schedule-only (no PR can be blocked by an unexpected gitleaks bump) — but a gitleaks release that changes detection behavior would silently change what this job flags with no version bump to review. **Recommend: pin to a digest, matching every other tool.**

### `supabase-checks.yml`

`migration-drift` (drizzle-kit generate + fail on diff) and `migration-sequence` (filename/journal consistency) — both `continue-on-error: true` pending "a clean baseline held for a few PRs."

**F2 (HIGH): this workflow is disabled at the GitHub platform level and has not run in a month.** `gh api repos/.../actions/workflows` reports `"state":"disabled_manually"` — **not visible from the YAML**, which has valid triggers and looks live to anyone reading it. Last run: `29310544745`, 2026-07-14. `git log --oneline --since="2026-07-16" -- packages/db/migrations/` shows **31 commits** advancing the migration chain through at least `0069`–`0073` in that window — **none exercised by either check**. The file itself was still touched **after** being disabled (`25cb1b46`, 2026-08-11, a dependency bump) — a dependency bump landing on a workflow nobody has seen succeed or fail in a month is exactly the "a pipeline only you can run, documented only in your head" failure mode this role exists to catch. NOT VERIFIED: who disabled it or why — no PR/issue/commit references it. **This is a one-click platform fix (Settings → Actions → Enable workflow), not a code change** — but until flipped, drift-vs-`schema.ts` and journal-consistency checks provide **zero** signal, silently; `ci.yml`'s `e2e` job proving the chain *applies* is the only live coverage.

### `staging-cd.yml`

`workflow_dispatch` only, targets a **hypothetical persistent staging host** (Render/Railway/Fly/Coolify/VM — "the human's choice"), explicitly **distinct from Lightsail** per its own header.

**F3 (verified, no action needed)**: manually triggered once, today (`run 31671605491`, `success`). Step-level inspection shows the wiring-check step succeeded and **every subsequent step was `skipped`** — confirms the guard correctly evaluated `wired=false` and no-op'd, live, not merely by reading the YAML. `STAGING_API_BASE_URL` and `STAGING_DEPLOY_HOOK_URL` are the **only** two secrets genuinely absent from both the `staging` GH Environment (11 secrets) and the 72 repo-level secrets — every other "required" secret already resolves via fallback. Worth naming precisely: the day this workflow stops being inert is the day someone adds `STAGING_API_BASE_URL` alone.

### `staging-demand-verify.yml`

`workflow_dispatch` only — migrate → seed swipe jobs → seed synthetic demand fixture → start API (`NODE_ENV=development`) → `pnpm db:verify:demand` → stop.

**F4 (HIGH — the most significant finding in this document): this workflow's "GUARDED / INERT BY DEFAULT" framing does not match its current, live secret topology, and it has already run for real once against credentials still live today.** The guard checks only that four named secrets are non-empty and that `DATABASE_URL`/`REDIS_URL` don't literally equal the compose-internal placeholder host — **no check that `DATABASE_URL` is a disposable, non-production database**, only a same-string-as-throwaway-default check. All four required secrets are present in the `staging` GH Environment **right now**. This is the **same** `staging` Environment and **same** `DATABASE_URL` secret name that `ci.yml`'s `deploy-lightsail` uses — and `docker-compose.staging.yml`'s own comment states this variable is "the real Postgres... never the compose-internal one," i.e. the database backing the currently-deployed, always-on Lightsail box (GitHub Environments hold exactly one value per secret name — `deploy-lightsail` and `staging-demand-verify` cannot read two different `DATABASE_URL`s while both bind `environment: staging`).

Not merely a paper risk: this workflow **already ran to completion, successfully**, on 2026-06-24 (`run 28089630074`) — every step including `Apply migrations` and `Seed demand fixture` reported `success`. That run landed within hours of the `staging` Environment first being created — plausible, likely-benign initial validation **at the time**. But nothing in the workflow has changed since, and the environment it wrote to is now confirmed to be "the real Postgres." **Net finding**: as of today, any collaborator with `workflow_dispatch` rights can re-run this workflow, and the guard will **not** stop it — it will run migrations, write a synthetic fixture, and boot an API instance against the same database secret backing the live system, directly contradicting the file's own instruction ("TARGET MUST BE A DISPOSABLE NON-PROD DB… Never point DATABASE_URL at production"). NOT VERIFIED (deliberately not checked, per this audit's rules): the actual `DATABASE_URL` value, or whether it currently points at the live Lightsail database specifically vs. some other real-but-non-production Postgres sharing the secret name — resolvable only by a human with legitimate secret access.

**Recommendation (escalation path, not for this audit to execute)**: either (a) provision a genuinely separate disposable database + a **separate** GH Environment before this workflow is ever run again, or (b) add a positive-match guard requiring `DATABASE_URL` to contain a disposable-DB marker, failing closed otherwise. This is the "any production data operation" class of decision this role must escalate, not fix unilaterally.

### `cleanup-issues-prs.yml`

Schedule (`0 0 * * 0`) + `workflow_dispatch` with a `dry_run` input. Closes issues/PRs that are completed-via-merge, superseded, or 90-day-stale-with-7-day-grace; exempts `priority-critical`/`blocked`/`security`/`epic`/`do-not-autoclose` labels. **Verified firing weekly as configured** (3 consecutive Sunday runs, all success). Lowest blast radius in the set — GitHub metadata only, no code, no deploy.

## Cross-cutting findings

### F1 — the GitHub Actions workflow registry doesn't match `git ls-tree origin/main`

`gh api repos/.../actions/workflows` lists **14 items** where `main`'s tree has exactly **10**. The extras: `_diag-fix-repro.yml`/`_diag-skip-repro.yml` (throwaway verification workflows from the `deploy-lightsail`/skip-propagation fix, confirmed absent from `main` — 404 on Contents API), `codeql.yml` (`state: active` but 404 on `main`, no history in this shallow clone — NOT VERIFIED when/why removed), and `dynamic/github-code-scanning/codeql` (GitHub's managed "default setup," **confirmed `not-configured`** via `gh api code-scanning/default-setup` — not a hidden gate, genuinely off). None require action; recorded so a future reader of the Actions UI doesn't mistake "14 workflows listed" for "14 workflows in this repo."

### No duplicated lint/test gates found

Checked specifically for two workflows running the same lint/test step on overlapping triggers. Found none — this repo already went through exactly that consolidation (`worker-app.yml`/`payer-app.yml`/`sast.yml`/`dependency-audit.yml` used to carry their own triggers, converted to `workflow_call` reusables across #718/#773/#774/#788/#792). The one remaining duplication (`sast`/`deps-audit` running both per-PR and weekly) is **deliberate and load-bearing** — each file's comments state why the weekly run is a coverage net, not redundant work.

### Documentation referenced by these workflows does not exist in the repository

Inline comments across `ci.yml`, `staging-cd.yml`, `staging-demand-verify.yml` cite 10 runbooks (`docs/rollback-guide.md` × 4 in `ci.yml` alone, `docs/ops/staging-service-deploy-runbook.md`, `docs/ops/otp-real-send-staging-runbook.md`, `docs/ops/bug2-staging-demand-deploy-runbook.md`, `docs/release-checklist.md`, `docs/github-actions.md`, `docs/observability-runbook.md`, `docs/environment-variables.md`, `docs/supabase-workflow.md`, `docs/pii-key-rotation-runbook.md`) — all removed by `eb151468` (2026-08-05, #589) and never recreated. `ci.yml` was edited as recently as today (`44ac03c0`, #819) and still references `docs/rollback-guide.md` at 4 lines. Direct gap against a "new environment can be stood up from the runbook alone" bar.

## Final classification table

| File | Classification |
|---|---|
| `ci.yml` | **KEEP** — sole required gate + sole active CD path, verified green and deploying live |
| `worker-app.yml` / `payer-app.yml` | **KEEP** — only path to gate Flutter in CI |
| `sast.yml` / `dependency-audit.yml` | **KEEP** — deterministic, documented mitigations |
| `security-scan.yml` | **KEEP** — legitimate weekly net; F5 (unpinned gitleaks) |
| `supabase-checks.yml` | **KEEP — re-enable at platform level (F2)** |
| `staging-cd.yml` | **KEEP** — verified inert today (F3) |
| `staging-demand-verify.yml` | **KEEP — re-scope secret source before next trigger (F4)** |
| `cleanup-issues-prs.yml` | **KEEP** — confirmed firing on schedule, lowest blast radius |

No file is DEPRECATE, DELETE CANDIDATE, or UNKNOWN. The two items needing action are platform-configuration items, not file-level CI structure changes.

---

**Files/evidence referenced**: all 10 `.github/workflows/*.yml` (read in full), `.github/CODEOWNERS`, `.github/dependabot.yml`, `docker-compose.staging.yml`, and live read-only `gh api` state (branch protection, the `staging` Environment + its 11 secret names, the repo's 72 secret names, the full workflow registry, `code-scanning/default-setup`, run/job history for all six schedule/dispatch-relevant workflows).
