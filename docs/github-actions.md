# GitHub Actions Reference

**Citation note (honesty, per this reconstruction batch's own standard):** no live code cites a
specific procedure "from `docs/github-actions.md`" the way `docs/observability-runbook.md §7` or
`docs/rollback-guide.md` are cited — the only citations of this exact path are
`.claude/agents/devops-engineer.md`'s ownership-mandate list and this repo's own audit documents
analyzing that mandate (`docs/audit/16_OBSERVABILITY_AUDIT.md`, `docs/audit/24_RISK_REGISTER.md`
R46). There is no lost prose to recover here. What follows is reconstructed directly from the 8
workflow files that exist on `origin/main` today plus `docs/audit/12_CICD_AUDIT.md`'s independent
classification (cross-checked against the files themselves, not taken on faith) — an accurate
reference, not a transcript of a deleted document.

## Workflow inventory (8 files, `.github/workflows/`)

| File | Trigger | Blocking? | What it does |
|---|---|---|---|
| `ci.yml` | `push`/`pull_request` → `main` | **Yes — `ci-required` is the sole required check on `main`** | Lint/typecheck/test/build, ai-service pytest/ruff, E2E onboarding, Flutter gates, SAST, dependency audit, Docker build+push, Lightsail deploy, worker APK build+release |
| `worker-app.yml` | `workflow_call` only (called from `ci.yml`) | Yes, via `ci.yml`'s `worker-app` job | Flutter `analyze` + `test` for `apps/worker-app`, pinned Flutter 3.35.7/Dart 3.9.2 |
| `payer-app.yml` | `workflow_call` only (called from `ci.yml`) | Yes, via `ci.yml`'s `payer-app` job | Same as above for `apps/payer-app` |
| `sast.yml` | `workflow_call` (called from `ci.yml` per-PR **and** `security-scan.yml` weekly) | Yes on the `ci.yml` call | Semgrep OSS (`p/default`, `p/typescript`, `p/python`, `p/secrets`) |
| `dependency-audit.yml` | `workflow_call` (same dual-caller pattern) | Yes on the `ci.yml` call | `pnpm audit --audit-level high` |
| `supabase-checks.yml` | `push`/`pull_request` on `packages/db/**` | **No** (`continue-on-error: true` on both assertion steps — see "Non-blocking gates" below) | Migration-drift + migration-sequence checks (schema.ts vs. committed migrations) |
| `security-scan.yml` | `schedule` only (Sunday 02:30 UTC) | N/A (nothing to block — no PR is open on a schedule run) | Weekly whole-tree gitleaks (secret scan, full git history), plus weekly calls into `sast.yml`/`dependency-audit.yml` for whole-tree coverage |
| `staging-cd.yml` | `workflow_dispatch` only | N/A (manual, guarded-inert by default) | Persistent-staging build→migrate→deploy→smoke — see `docs/ops/staging-service-deploy-runbook.md` |
| `cleanup-issues-prs.yml` | `schedule` (weekly) + `workflow_dispatch` | N/A | Closes completed/superseded/stale issues+PRs — GitHub metadata only, no code, no deploy |

`staging-demand-verify.yml` **was retired** on 2026-08-13 (commit `03ca68f2`, `#830`,
BL-16/R41) — its guard only checked that required secrets were non-empty, never that
`DATABASE_URL` pointed at a genuinely disposable database, and it shared the `staging`
Environment's `DATABASE_URL` secret with `deploy-lightsail`'s own production target. If that
demand-loop proof is needed again, it must be rebuilt with a positive-match guard or a fully
separate GitHub Environment — not simply re-added.

## The `ci-required` pattern (why some jobs live in `ci.yml` and not their own file)

`ci-required` is the **only required status check on `main`**. Branch protection can `needs:` a
job only within the same workflow file — it cannot reach a job defined in a separate workflow
file. This repo learned that gap the hard way (measured live, not theorized):

- **#711**: `Worker app (analyze / test)` FAILED on a real analyzer error while `ci-required`
  PASSED, because the Flutter job was a standalone workflow at the time.
- **#763 and #768**: SAST went red twice in one day (a real `new RegExp` finding, a dynamic regex
  in the migration parser) while `security-scan.yml`'s copy of the job — the only copy that
  existed then — sat beside a green `ci-required`. Both were caught by a human reading the
  Checks tab, not by the gate.

The fix, applied three times for the same reason (`worker-app`/`payer-app` in #718, `sast` in
#773, `dependency-audit` in #788/#792): convert the job to a `workflow_call` reusable and invoke
it **from `ci.yml`**, so it becomes a direct `needs:` entry of `ci-required` and a red run
actually blocks a merge. `ci-required` itself is `if: always()` and passes only when every job in
its `needs:` list is `success` **or** legitimately `skipped` (a path-filtered job that didn't need
to run) — `failure`/`cancelled` fail it.

## Path filtering (`dorny/paths-filter`, the `changes` job)

`ci.yml`'s first job (`changes`) computes which of `ai-service` / `e2e` / `worker-app` /
`payer-app` / `sast` / `deps` changed, and every downstream job gates on one of those booleans.
**A path filter must include the workflow file that defines the gate itself** — every filter in
this repo explicitly lists its own trigger file (e.g. the `e2e` filter includes
`.github/workflows/ci.yml`) for exactly this reason, stated in the file's own comment: "without
this, editing the job's own definition — its service containers, its migration steps — skips the
very job it edits, so the edit ships unvalidated." Verify any new path-gated job follows the same
rule before trusting its green check.

## Non-blocking gates (deliberately, for now)

- **`supabase-checks.yml`'s two jobs** (`migration-drift`, `migration-sequence`) both carry
  `continue-on-error: true` on their assertion step. The workflow's own header states the
  intended lifecycle: "flip to blocking once a clean baseline has held for a few PRs." As of this
  reconstruction they are still non-blocking — verify current status with
  `git log -p -- .github/workflows/supabase-checks.yml` or read the file directly before assuming
  either has flipped. **Separately**, `docs/audit/24_RISK_REGISTER.md` R43 (re-verified,
  independent of the `continue-on-error` question above) found this workflow disabled at the
  GitHub *platform* level for roughly a month via `gh api ... "state":"disabled_manually"` — a
  YAML file can look live to a reader while GitHub itself is not running it at all. Confirm both
  the YAML's own gate posture **and** the platform-level enabled/disabled state before trusting
  this check either way.
- **`security-scan.yml`'s `secret-scan` job** carries `continue-on-error: true`. Per that file's
  own comment, this became **more** load-bearing, not less, after an owner decision on
  2026-08-12 removed the local pre-commit secret-guard hook pairing — gitleaks here is now "the
  ONLY mechanical check standing between a committed secret and the remote." Flip-to-blocking
  criterion: zero findings on a full-history run, or a committed `.gitleaks.toml` allowlist for
  every justified hit.

## Two-caller pattern for security scanners (`sast`, `dependency-audit`)

Both run twice, deliberately, with different scope:

| Caller | Scope | Blocking? |
|---|---|---|
| `ci.yml` (per PR) | Diff-scoped (`sast` passes `baseline-ref`); `dependency-audit` scans the whole tree but is path-gated on the lockfile | Yes, required |
| `security-scan.yml` (weekly) | Whole-tree, no baseline | No `continue-on-error` on the schedule (nothing to block; a red run is a signal to act on) |

The split exists because Semgrep's `p/*` rulesets are fetched from the registry at scan time —
the OSS CLI cannot pin ruleset content the way an engine version is pinned (the engine itself
**is** pinned by container digest in `sast.yml`). A whole-tree scan on the PR gate would fail the
first PR to run after any upstream ruleset change on a finding it did not introduce — precisely
the "always-red gate nobody trusts" failure mode this repo names explicitly in its own comments
(`#737`). The weekly run keeps the whole-tree guarantee without putting it on someone's unrelated
PR.

## Action/image pinning convention

Every third-party action and container image in every workflow is pinned by **commit SHA or
image digest**, with a version number in a trailing comment (e.g.
`actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7`,
`semgrep/semgrep@sha256:bdf70... # 1.171.0`) — never a mutable tag or branch. `pnpm/action-setup`
is deliberately called **without** a `version:` input, so `package.json`'s
`packageManager: pnpm@11.5.2` field stays the single source of truth for the pnpm version across
every job (a `version:` input would conflict and produce `ERR_PNPM_BAD_PM_VERSION`).

## Concurrency groups

`ci.yml`: `ci-${{ github.ref }}`, `cancel-in-progress: true` — a new push to the same branch/PR
cancels the previous run. `supabase-checks.yml`, `security-scan.yml` follow the same
per-ref-cancel pattern. `staging-cd.yml`: `staging-cd` (a single fixed group, not per-ref) with
`cancel-in-progress: false` — two manual dispatches queue rather than race or cancel each other,
appropriate for a workflow that mutates a real (if disposable) database.

## What this reference does not cover

The exact step-by-step of any one workflow's job (see `docs/release-checklist.md` for the release
sequence and `docs/ops/staging-service-deploy-runbook.md` for the staging-CD sequence, both
reconstructed in full elsewhere in this same batch); repository-level branch-protection
configuration (which check names are marked required — that lives in GitHub settings, not in a
workflow file, and was not independently re-verified for this reconstruction).
