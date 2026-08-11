# Audit Status — Coverage Ledger

> This file exists so that **no gap is unknown**, including gaps in the audit itself.
> If a section below says NOT AUDITED, do not treat any statement about it anywhere in
> `docs/payer-agent/` as evidence. Re-run the dimension first.

**Audit date:** 2026-08-11
**Audited tree:** `feat/747a-spoken-digit-redaction` @ `b2a197e1` (0 ahead / 1 behind `origin/main`)
**Ship target set by owner:** Alpha — real users, mock money (`PAYMENTS_ENABLE_REAL` and
`AGENCY_PAYOUTS_ENABLED` remain OFF by design).
**Scope set by owner:** `apps/payer-web` + the `apps/api` payer surface + `packages/db`;
plus `apps/payer-app` (Flutter) and `apps/web` / `apps/admin-web` where they are the sole
consumer of a payer/agency capability.

---

> ## ✅ UPDATE 2026-08-11 — the audit is now COMPLETE (15 of 17 dimensions)
>
> The workflow was resumed after the usage limit reset, with the `.catch(() => null)` fix applied.
> **All 10 audit dimensions completed**, plus verifiers. The documents are published:
> `SECURITY_AUDIT.md`, `BUSINESS_FLOWS.md`, `STATE_MACHINES.md`, `API_CONTRACTS.md`,
> `ENTERPRISE_READINESS.md`, `TESTING_STRATEGY.md`, `PAYER_FEATURE_AUDIT.md`,
> `AGENT_FEATURE_AUDIT.md`, `ROUTE_REGISTER_FULL.md`.
>
> **Still not audited (2):** the Flutter `apps/payer-app` deep-dive and the `apps/web` /
> `apps/admin-web` sole-consumer audit — both supplementary explores died on the usage limit and
> were not part of the workflow. `API_CONTRACTS.md` carries a Flutter *cross-check* only.
>
> The table below is retained as the record of the interrupted first pass.

## Why this audit is partial

The audit was executed as a 12-agent parallel workflow. **1 of 12 agents completed.** The
remaining 11 were terminated mid-run when the account hit its weekly model-usage limit
(resets 2:30pm Asia/Calcutta). Two follow-up explore agents covering the Flutter and
ops/admin scope died the same way.

The terminated agents had already read extensively (600–800 KB of transcript each) but never
emitted structured output. Their partial transcripts were **deliberately not** mined for
findings: a half-finished read produces claims that look cited but were never verified, which
is exactly the failure mode this audit exists to prevent.

---

## Coverage by dimension

| # | Dimension | Status | Where it lives | Confidence |
|---|---|---|---|---|
| 1 | Repository / architecture map | **COMPLETE** | `ARCHITECTURE.md` | High — 3 independent explorations agreed |
| 2 | Backend endpoint inventory (routes + guards) | **COMPLETE** | `PAYER_API_REGISTER.md`, `AGENT_API_REGISTER.md` | High — read from controller decorators |
| 3 | Auth / RBAC model (principals, guards, capabilities) | **COMPLETE** | `AUTHORIZATION_MATRIX.md` | High |
| 4 | Frontend route inventory + gates | **COMPLETE** | `ROUTE_REGISTER.md` | High |
| 5 | Frontend data layer / seam inventory | **COMPLETE** | `ARCHITECTURE.md` §4 | High |
| 6 | **Database audit** | **COMPLETE** | `DATABASE_AUDIT.md` | High — 18 findings, all cited |
| 7 | Tests / CI / local dev inventory | **COMPLETE** | `LOCAL_SETUP.md`, `ARCHITECTURE.md` §7 | Medium-High — inventory only, no gap analysis |
| 8 | Per-endpoint **status classification** (complete/partial/missing/unwired) | ❌ **NOT AUDITED** | — | — |
| 9 | **Authorization deep-dive** (IDOR/BOLA per route, Server Action gates) | ❌ **NOT AUDITED** | — | — |
| 10 | **Business flow traces** (P1–P9, A1–A6) | ❌ **NOT AUDITED** | — | — |
| 11 | **API contract parity** (frontend Zod ↔ backend DTO) | ❌ **NOT AUDITED** | — | — |
| 12 | **State machines / lifecycle enforcement** | ❌ **NOT AUDITED** | — | — |
| 13 | **Enterprise readiness** (reliability, observability, perf, UX, a11y) | ❌ **NOT AUDITED** | — | — |
| 14 | **Error-handling matrix** | ❌ **NOT AUDITED** | partial — see GAP-XC-02 | — |
| 15 | Flutter `apps/payer-app` consumer audit | ❌ **NOT AUDITED** | — | — |
| 16 | `apps/web` / `apps/admin-web` sole-consumer audit | ❌ **NOT AUDITED** | — | — |
| 17 | Completeness critic (cross-dimension contradiction sweep) | ❌ **NOT RUN** | — | — |

**7 of 17 dimensions complete.** The completed set is the *structural* half — what exists and
how it is wired. The missing set is the *behavioural* half — whether it actually works, and
whether it is safe.

---

## What this means for the numbers

Any "% complete" figure for the Payer or Agency application would be **fabricated** at this
point, because dimension 8 (per-endpoint status classification) is exactly the dimension that
produces those numbers, and it did not run. `FINAL_AUDIT_REPORT.md` therefore reports counts
only for what was actually enumerated (routes, endpoints, tables) and explicitly refuses to
report completeness percentages.

---

## Resume procedure

The workflow script is saved and resumable. Completed agents replay from cache at zero cost;
only the failed ones re-run.

```
Workflow({
  scriptPath: "C:\\Users\\Prakash\\.claude\\projects\\C--Users-Prakash-Documents-GitHub-badabhai-platform\\98fba20b-e85a-4bcc-82f7-7494f565ea89\\workflows\\scripts\\payer-agent-e2e-audit-wf_4b76d4f5-033.js",
  resumeFromRunId: "wf_4b76d4f5-033"
})
```

Before resuming, apply this **fix to the script** (a real bug found in this run):

> The pipeline's stage 2 (`verify:*`) returns `agent(...).then(...)` directly. When a verify
> agent throws, the pipeline drops the **whole item** to `null` — so a *successful* finder's
> result is discarded along with its failed verifier. In this run `audit:database` succeeded but
> `verify:database` failed, and the database findings were nearly lost. Wrap stage 2's agent call
> in `.catch(() => null)` and return `{dimension, found, verification: null}` so a verifier
> failure degrades to "unverified" instead of destroying the finding.

Run order if resuming under a constrained budget — highest decision-value first:

1. `authz-security` (dimension 9) — the only dimension that can surface a shipping blocker
2. `business-flows` (dimension 10) — produces the "what will actually happen if I use it today" verdicts
3. `frontend-routes` (dimension 8, Server Action gates) — every Server Action is a public POST
4. `api-contracts` (dimension 11) — a Zod parse failure is a hard 500, not a soft degrade
5. `state-machines` (dimension 12)
6. the rest

---

## Standing caveats that apply to every document here

1. **`docs/` on `origin/main` contains exactly 5 files.** ADRs 0004, 0010, 0013, 0017, 0019,
   0022, 0025, 0026, 0027, 0030, 0034, 0035 are cited throughout the code but **have no file on
   main**. Several audit questions ("is this posture still intended?") cannot be resolved by
   reading the repository, only by an owner ruling. They are recorded as ambiguities, not
   findings.
2. **Nothing in the repo records which migrations are applied in any environment.** Statements
   about deploy-readiness are conditional on that unknown. See `DATABASE_AUDIT.md` ambiguity 4.
3. This audit read code. It did **not** run the applications, execute a request, or inspect a
   live database. Every finding is static-analysis grade until dimension 10 runs live.
