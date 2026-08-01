# CI DB-Gate Enablement Report — 2026-08-01

**PR:** [#538](https://github.com/RVM-BEYOND-PRIVATE-LIMITED/badabhai-platform/pull/538) — **MERGED to `main` 2026-08-01 09:46 UTC** as merge commit `9ac6deb`, on owner instruction. Remote and local branches deleted.
**Merge note:** branch protection reported `REVIEW_REQUIRED` and the PR author cannot self-approve, so the merge used `gh pr merge --admin` (admin override of the required-review gate). `ci-required` was green at merge time; no status check was bypassed, only the human-review requirement.
**Post-merge verification:** CI run [30694398359](https://github.com/RVM-BEYOND-PRIVATE-LIMITED/badabhai-platform/actions/runs/30694398359) on `main` — **success**; the gates executed there too (`✓ boost-fences (4 tests)`, `✓ rank-parity (5 tests)`, `Test Files 2 passed (2)`).
**Scope:** CI configuration only. No production code, no feature flag, no deploy workflow, no migration against any real database.

---

## 1. What was changed

One file, three commits, additive only.

| File:line | Commit | Change |
|---|---|---|
| [.github/workflows/ci.yml:294-335](../../.github/workflows/ci.yml#L294-L335) | `a572cc0` | New step **"Matching V1 DB gates (rank parity + boost fences)"** in the existing `e2e` job, placed after `Apply migrations` / `Seed alpha jobs` and before the API boots. Sets `RUN_DB_TESTS: "1"` **at step level**, runs the two suites, and guards that they actually executed. |
| [.github/workflows/ci.yml:36-40](../../.github/workflows/ci.yml#L36-L40) | `66043c4` | Added `.github/workflows/ci.yml` to the `e2e` path filter — without it, a workflow edit skips the job it edits. |
| [.github/workflows/ci.yml:319-335](../../.github/workflows/ci.yml#L319-L335) | `40b5a52` | Dropped the `--` that was swallowing the vitest file filter; replaced the suite-wide guard with per-file assertions + an exact file-count check. |

**No Postgres service container had to be added.** The `e2e` job already provisions `pgvector/pgvector:pg16` + Redis ([ci.yml:196-221](../../.github/workflows/ci.yml#L196-L221)) and applies the **full journal-driven migration chain 0000–0059 from scratch on every run** ([ci.yml:286-287](../../.github/workflows/ci.yml#L286-L287)). I verified `_journal.json` contains `0052_match_vocabulary` … `0059_boost_tiers_widened`, so the ephemeral CI database gets the complete Matching V1 schema. **This is fully decoupled from the un-applied production 0052–0059 train** — nothing in this change reads, references, or depends on any deployed database's migration state.

Both suites are self-sufficient against a bare migrated DB: each seeds its own PII-free fixtures (synthetic `enc:`/`hash:` markers, never a real phone) and deletes them in `afterAll`; `boost-fences` additionally upserts its own `skill` row. Neither needs the API process, which is why the step runs before the API boots.

---

## 2. Confirmation the suites now run and pass

From the **step log** of run [30694094388](https://github.com/RVM-BEYOND-PRIVATE-LIMITED/badabhai-platform/actions/runs/30694094388), not from the check mark:

```
$ vitest run rank-parity boost-fences
 ✓ src/match/boost-fences.test.ts (4 tests) 95ms
 ✓ src/match/rank-parity.test.ts  (5 tests) 103ms

 Test Files  2 passed (2)
      Tests  9 passed (9)
```

All 9 previously-skipped tests **executed and passed** against real Postgres:
- **rank-parity (5)** — the SQL `ORDER BY` in `MatchFeedRepository.listCandidates` vs `rankKeyCompare`, over 16 fixtures covering the tier-with-floor CASE, the inclusive 36-month boundary, `NULLS LAST`, NULL snapshots, and complete ties.
- **boost-fences (4)** — boost never passes the skill gate; boost permutes order only; boost never touches the candidate list; plus the structural no-boost-column scan.

**Nothing failed once enabled.** No newly-executing test surfaced a defect — which is itself worth stating, since it means the SQL and the TypeScript comparator genuinely agree today.

### Baseline, for contrast (what CI was doing before)

Measured locally on `main` before the change:

```
 ↓ src/match/boost-fences.test.ts (4 tests | 4 skipped)
 ↓ src/match/rank-parity.test.ts  (5 tests | 5 skipped)
 Test Files  2 skipped (2)
      Tests  9 skipped (9)
```
…and vitest exited **0**. That is the vacuous pass this change removes.

### Other jobs unaffected

| Job | Result | Evidence |
|---|---|---|
| `ci-required` (branch-protection gate) | **pass** | 2s aggregator |
| `Node (lint / typecheck / test / build)` | **pass** (40s) | Unchanged. The invariant A/B property tests still run there. The two gate files **still skip** in this job (`↓ … 5 skipped` / `↓ … 4 skipped`), proving `RUN_DB_TESTS` did not leak. |
| `E2E` onboarding suite | **pass**, unchanged | 169 passed / 37 skipped, same as before |
| `Deploy to AWS Lightsail`, `Build & Push Docker Image` | skipping | Untouched; unchanged from before |
| ai-service, gitleaks, semgrep, dependency audit | skipping (path-gated) | Untouched |

E2E wall time went **2m25s → 1m19s** after the filter fix.

---

## 3. Zero production / deploy-path impact

- Diff touches **only** `.github/workflows/ci.yml`; no `apps/`, no `packages/`, no `infra/`.
- `MATCH_V1_ENABLED` is not referenced, set, or flipped anywhere in the change.
- `staging-cd.yml`, `staging-demand-verify.yml`, `build-and-push-image`, `deploy-lightsail` are untouched.
- The only database written is the job's own throwaway service container. No `DATABASE_URL` secret is read; the job's `DATABASE_URL` is the hardcoded `localhost:5432/badabhai_test`.
- `RUN_DB_TESTS` is set in exactly one place — verified by parsing the compiled YAML: `RUN_DB_TESTS at: e2e > Matching V1 DB gates (rank parity + boost fences)`.
- No secrets added.

---

## 4. Findings

### 4.1 The brief's third suite does not exist (scope correction)

The task described *three* skipped suites; there are **two**. `apps/api/src/match/match-feed.repository.test.ts` only *mentions* `RUN_DB_TESTS` in a comment describing this gap — it is structural-only (compiles the SQL with `PgDialect`, asserts on text and bound params) and has always run in CI. The real-database `job_reach ⋈ job_postings` feed path it cannot cover **is** exercised by `boost-fences.test.ts` via `repo.listFeed`, which this PR arms. So all three concerns in the brief are covered by arming the two files that are actually gated.

### 4.2 Two bugs this change found in itself

Both are the same failure class the task exists to close — a green check that proves nothing. Reporting them rather than quietly fixing them, since they say something about the CI design:

**(a) The e2e job skipped the change that edits it.** The first push went green with e2e **skipped**: the path filter listed `apps/api/**`, `packages/**`, `tests/**`, lockfiles and `turbo.json`, but not `.github/workflows/**`. A change to the e2e job could not run the e2e job, so any edit to it shipped unvalidated. Fixed by adding the workflow to the filter. **Trade-off to accept:** every `ci.yml` edit now spins up the e2e job (~1.5–2.5 min + two service containers).

**(b) `pnpm --filter X test -- <filter>` silently ran the entire suite.** pnpm forwards the `--` verbatim, so the step executed `vitest run -- rank-parity boost-fences`; vitest ignored the filters and reran **215 files / 2820 tests** (~67s), duplicating the `node` job. The gates did run inside that, but the original guard ("at least one test passed") was then satisfiable by ~2800 unrelated tests — it would no longer have detected `RUN_DB_TESTS` going missing. Fixed by dropping the `--` and asserting **per file**.

Both guards were validated against real captured vitest output in three states before pushing: armed (passes), unarmed/skipped (fails with the right message), broken-filter (fails with the right message). A guard I hadn't seen fail would have been worth nothing here.

### 4.3 Pre-existing: main pushes that don't touch `apps/ai-service` never deploy

Surfaced by comparing the post-merge run to the previous main run. **Not caused by this change** — verified by reading the conditions — but worth raising because it is a live deploy-path defect.

- `build-and-push-image` is `if: github.event_name == 'push' && github.ref == 'refs/heads/main'` with `needs: [node, ai-service, e2e]` ([ci.yml:341-343](../../.github/workflows/ci.yml#L341-L343)).
- `ai-service` is `if: needs.changes.outputs.ai-service == 'true'` — path-gated to `apps/ai-service/**`.
- GitHub **skips** a job when any job in its `needs` was skipped (absent `always()`). So whenever a main push does not touch `apps/ai-service`, `ai-service` skips → `build-and-push-image` skips → `deploy-lightsail` skips.

Evidence: the merge of #537 touched `apps/ai-service`, and that run built + deployed (both `success`). This merge touched only `ci.yml`, and both jobs were `skipped`. **Consequence: an API-only or packages-only merge to main produces no image and no deploy** — almost certainly unintended. This change neither caused nor worsened it (before the change, a `ci.yml`-only push skipped `e2e` as well, with the same skipped outcome downstream).

Out of scope to fix here (deploy configuration was explicitly off-limits). Likely fix is `if: always() && ...` plus explicit per-need result checks on `build-and-push-image`.

### 4.4 Noticed but deliberately NOT touched

Per instruction, flagged rather than acted on:

1. **`docs/registers/tech-debt-register.md:141` (TD122)** still describes these two files as skipping in CI. Now stale. One-line follow-up.
2. **The 2026-08-01 matching-engine audit report** (`docs/reports/matching-engine-verification-2026-08-01.md`) lists this as its #2 critical issue — now closed. That report is **untracked** in the working tree and will be lost if the tree is cleaned; it is not part of this PR.
3. **Residual coverage gaps from that audit remain open** and are unaffected by this change: no Postgres-level test of the `ON CONFLICT` snapshot freeze (E16), no apply→edit→re-read no-reorder test, and the misleading comment at `apps/api/src/match/match-apply.service.test.ts:367` claiming `rank-parity.test.ts` owns that proof (it does not).
4. **The production Matching V1 train (0052–0059 + D1–D6) and `MATCH_V1_ENABLED` remain untouched**, exactly as scoped.

---

## 5. Diff

```diff
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -32,6 +32,11 @@ jobs:
               - 'pnpm-workspace.yaml'
               - 'turbo.json'
               - 'apps/ai-service/**'
+              # The job's own definition. Without this, a change to the e2e job — its
+              # service containers, its migration steps, or the Matching V1 DB gates
+              # below — skips the very job it edits, so the edit ships unvalidated.
+              # A workflow file can obviously affect the workflow.
+              - '.github/workflows/ci.yml'
@@ -291,6 +296,46 @@ jobs:
       - name: Seed alpha jobs
         run: pnpm --filter @badabhai/db db:seed:jobs
 
+      - name: Matching V1 DB gates (rank parity + boost fences)
+        env:
+          RUN_DB_TESTS: "1"
+        run: |
+          set -eo pipefail
+          pnpm --filter @badabhai/api run test rank-parity boost-fences 2>&1 | tee db-gates-raw.log
+          sed -e 's/\x1b\[[0-9;]*m//g' db-gates-raw.log > db-gates.log
+
+          for f in rank-parity boost-fences; do
+            line=$(grep -E "src/match/${f}\.test\.ts" db-gates.log | head -1 || true)
+            if [ -z "$line" ]; then
+              echo "::error::${f}.test.ts did not run at all — the vitest file filter matched nothing."
+              exit 1
+            fi
+            case "$line" in
+              *skipped*)
+                echo "::error::${f}.test.ts SKIPPED — RUN_DB_TESTS is not reaching vitest, so this gate would have passed vacuously."
+                exit 1
+                ;;
+            esac
+          done
+
+          if ! grep -qE 'Test Files +2 passed \(2\)' db-gates.log; then
+            echo "::error::Expected exactly the 2 gate files to run — the vitest file filter is not reaching vitest."
+            grep -E 'Test Files|      Tests ' db-gates.log || true
+            exit 1
+          fi
+
       - name: Start API and run the Phase 1 E2E suite
```

(Explanatory comments elided here for readability; they are in the file and in the PR diff.)
