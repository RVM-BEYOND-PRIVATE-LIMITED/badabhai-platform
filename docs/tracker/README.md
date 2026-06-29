# BadaBhai Execution Tracker

This folder is the **daily control room** for BadaBhai. It is the single place to see
what is built, what works, what is broken, what is blocked, who does what today, and how
close we are to alpha — **with evidence, not guesses**.

> This tracker is **descriptive**, not authoritative for architecture. The contracts that
> *govern* the code are still [CLAUDE.md](../../CLAUDE.md) (invariants), the
> [ADRs](../decisions/), and the [registers](../registers/). This tracker **links** those —
> it does not duplicate or override them.

> ⚠️ **Shared-working-tree hazard (observed 2026-06-29):** a concurrent session committed
> ADMIN-3b mid-audit and **destroyed untracked tracker files**. Until the tracker is
> committed, treat these files as fragile. Avoid running two sessions in the same working
> tree; commit the tracker (with owner approval) for durability.

---

## Files & what each is for

| File | Purpose | Update cadence |
| ---- | ------- | -------------- |
| [PROJECT_STATUS.md](PROJECT_STATUS.md) | Weighted %-progress dashboard: overall / phase / main-task / final-task, with status + evidence | Every working day |
| [DAILY_TRACKER.md](DAILY_TRACKER.md) | Per-day movement: yesterday/today/blockers/decisions/tests + %-delta | Every working day |
| [ROADMAP.md](ROADMAP.md) | Phase 0→7 to paid launch: goal, in/out scope, gates, test gates, owner | On milestone change |
| [DECISION_LOG.md](DECISION_LOG.md) | Human decisions needed: options, recommendation, owner, deadline, safe default | When a decision is raised/resolved |
| [BLOCKERS.md](BLOCKERS.md) | P0–P3 blockers + **how each caps progress %** | When a blocker is found/cleared |
| [TEST_MATRIX.md](TEST_MATRIX.md) | Module × test-type × command × expected × current × owner | After each test run |
| [RELEASE_READINESS.md](RELEASE_READINESS.md) | Go/No-Go checklist for staging & production | Before any release decision |
| [OWNER_TASKS.md](OWNER_TASKS.md) | Per-developer 1-day task board with acceptance criteria | Every working day |
| [RISK_REGISTER.md](RISK_REGISTER.md) | Alpha-facing risk view → points at [registers/risks-register.md](../registers/risks-register.md) | On new risk |
| [ENV_AND_SECRETS_TRACKER.md](ENV_AND_SECRETS_TRACKER.md) | Required env per environment, secret vs public, status (no values) | On env change |
| [QA_EVIDENCE.md](QA_EVIDENCE.md) | Proof log: terminal output, test counts, manual notes, API checks | After each verification |

---

## The progress rule (read this before editing any %)

Progress is **weighted evidence**, never "code exists". Stages:

| % | Meaning |
| -: | ------- |
| 0 | Not started |
| 10 | Scope understood / accepted |
| 20 | Audit completed |
| 35 | Implementation started |
| 50 | Core implementation done |
| 65 | Integrated with real routes/APIs |
| 75 | Tests written/updated & passing |
| 85 | Local verification passed (runtime, not just unit tests) |
| 90 | Staging verification passed |
| 95 | Product/QA review passed |
| 100 | Accepted with evidence, no P0/P1 blockers |

**Hard caps (never override):**
- No tests / no verification evidence → **max 75%**
- Not verified in real/staging flow → **max 90%**
- Has a P0 blocker → **cap 60%**
- Has a P1 blocker → **cap 80%**
- Blocked by human/legal/product decision → record current %, set `Status: BLOCKED`, name the owner + decision.

**Rollup math:** `main_task = Σ(subtask% × weight)/Σweight`; `phase = Σ(main% × weight)/Σweight`;
`overall = Σ(phase% × weight)/Σweight`. Until weights are ratified, equal weight + label `WEIGHTS_PENDING`.

## Status labels (use consistently)
`NOT_STARTED · IN_PROGRESS · VERIFY · PARTIAL · BLOCKED · DONE · PARKED · DEAD · LEGAL_GATE · HUMAN_DECISION_NEEDED`

## How a developer updates this
1. End of day: update your rows in [OWNER_TASKS.md](OWNER_TASKS.md) + the %-cells in [PROJECT_STATUS.md](PROJECT_STATUS.md).
2. Paste real terminal output / screenshots into [QA_EVIDENCE.md](QA_EVIDENCE.md) — **a % move without evidence is invalid.**
3. New blocker → add a row in [BLOCKERS.md](BLOCKERS.md) with its progress cap + owner.
4. New decision needed → add to [DECISION_LOG.md](DECISION_LOG.md) with a safe default.
5. Add the day's summary to [DAILY_TRACKER.md](DAILY_TRACKER.md).

## Honesty rules (non-negotiable)
- If not tested → say **VERIFY**, not DONE.
- UI only → cap 50–65%. Backend exists but not wired → cap 50%. Wired but not tested → cap 75%.
- Tested locally but not staging → cap 85%. Staging passed but no product review → cap 90–95%.
- Never inflate. Never mark a P0 done without proof. Never hide a failing test.

---
_First created 2026-06-29 by the tracker/control-room session. Baseline audit evidence in [QA_EVIDENCE.md](QA_EVIDENCE.md)._
