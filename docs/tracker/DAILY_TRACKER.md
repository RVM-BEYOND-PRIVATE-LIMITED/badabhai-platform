# Daily Tracker

Newest day on top. Copy the template block each working day. Every % move needs a
[QA_EVIDENCE.md](QA_EVIDENCE.md) row.

---

# Daily Tracker — 2026-07-15

## BadaBhai Progress Snapshot
- **No % moves** (cap rule: no staging/handset evidence added today)
- **P0: 1** (staging past deadline) · Owner queue grew: migration 0038 apply · vernacular ratification (Q-A/Q-B) · SR-1 step-7 activation env · **Q14** (off-wedge résumé raw phrases — product)

## Merged today
| PR | What |
| -- | ---- |
| #225 | **TAX-5**: floor calibrated 0.82→0.75 on REAL vectors — precision 1.000; recall 0.800 ORACLE vs **0.350 shipped anchor-path** (both pinned by `pytest -k wedge`); 22 vernacular aliases PROPOSED (RVM gate) |
| #226 | **TAX-6**: job side shares the skill id space (`skill_phrases`/`skill_ids`, migration 0038 — APPLY PENDING); review M1/M2/M3 fixed (parallel-bounded canonicalize, widened RANK lock, outage backfill retry) |
| #227 | **TAX-8**: off-wedge résumé guard locked (canonicalization can't raise into résumés); raw-phrase gap → Q14 |

## Notes
- Root-caused yesterday's "CI dispatch stall": #226 went CONFLICTING after #225 merged — GitHub silently skips PR workflows when the merge ref can't build. Not a billing/incident issue.
- ADR-0030 series now: TAX-0..6 + TAX-8 DONE; TAX-7 (growth loop) in build; TAX-9 P3.

---

# Daily Tracker — 2026-07-14

## BadaBhai Progress Snapshot
- **Overall Project: 75%** · **Alpha Readiness: 58%** · **Release Readiness: 29%** — **NO % moves** (code breadth grew again, but the evidence posture is unchanged: no staging, no handset proof; the cap rule holds)
- **P0: 1** (staging PAST DEADLINE — 10 days) · **P1: 2** (TD62 consent-routing before handset GA; unlock/reveal LC-1 residual)
- **Decisions:** D9 (ADR-0030 accepted) + D10 (fork-B runner) DECIDED 2026-07-14 — see [DECISION_LOG](DECISION_LOG.md)

## Merged since 2026-07-10 (code catch-up — verification posture unchanged)
| PRs | What landed |
| --- | ----------- |
| #193–#196 | ai-contracts parity tests; payer-web all-seams-live (LC-1 closed on main); interview-kit read routes; worker self profile-summary |
| #197–#199 | auth throttle residuals (TD25 trust-proxy, TD60 per-phone OTP daily cap); voice pipeline end-to-end (ADR-0029, mock STT, DORMANT until bucket); register sync |
| #201–#202 | worker-app kPersistentAuth ON (W1) + payer P1/P2/P3/P5 REAL mode; TD61/TD62 logged |
| #203–#210 | AI cost/persona series: PERSONA-1/2 (bada-bhai voice + {{worker_name}} seam), COST-2 (prompt caching), COST-3 (stateless turns), COST-4 (templated questions, LLM-skip straight path) |
| #211–#215 | **ADR-0030 skills taxonomy TAX-0..4**: ADR accepted; skill/skill_alias/unresolved_phrase (migration 0037, applied); curated ESCO/O\*NET/NCO corpus + `db:seed:skills`; mock-default embeddings (pseudonymize-first); `canonicalize_skill` floor-gated (flag OFF, TD65) |
| #216–#218 | worker-app liberal jobs feed (concurrent session); TAX-5..9 roadmap pinned; **CI-1** Node-24 action bumps + Dependabot (0 deprecation annotations verified) |
| #219 (open) | fork-B embed runner + `POST /embeddings/skill-alias` — in adversarial review |

## Blockers
- **P0 staging unchanged** — nothing above adds runtime proof; the alpha gap remains verification + staging, not code.
- New launch gates logged: **TD64** (embed spend outside SpendLedger — precondition for the §7 staging embed run) · **TD65** (SKILL_CANONICALIZE_ENABLED stays OFF until staging verify + TAX-5 calibration).

---

# Daily Tracker — 2026-07-10

## BadaBhai Progress Snapshot
- **Overall Project: 75%** · **Alpha Readiness: 58%** · **Release Readiness: 29%**
- Payer Web 78% · Worker App 69% · Backend/API 84% · OTP/Auth/Security 80% · Agency 70% · AI-Service 80% · Infra/Staging 45% · Docs/Process 85%
- **P0: 1** (staging PAST DEADLINE) · **P1: 2** (FE wiring, LC-1 unlock/reveal) · **Decisions Needed: 0**

## Progress Movement
| Area | Yesterday | Today | Change | Reason |
| ---- | --------: | ----: | -----: | ------ |
| Worker App | 67% | 69% | **+2%** | PR #189 merged: A1 applied-jobs + A3 referral + A4 delete wired real; emulator run audited ([QA_EVIDENCE 2026-07-10](QA_EVIDENCE.md)) |
| Overall Project | 75% | 75% | 0 | +0.4 weighted from Worker App — rounds to 75% |
| Alpha Readiness | 58% | 58% | 0 | Evidence refreshed (60 shots) but emulator+local, not handset+staging — B1 families unchanged |
| Infra/Staging | 45% | 45% | 0 | **Staging STILL not deployed — 6 days past deadline** |

## Developer Progress
| Developer | Assigned | Status | Blocker |
| --------- | -------- | ------ | ------- |
| Prakash | Staging provisioning (P0 — past deadline) | OVERDUE | AWS instance not provisioned |
| Divyanshu | FE wiring batch FE-1..FE-7 | READY | Local DB stale (fresh migrate first) |
| Rishi | B1 handset run when staging lands; payer-app real-seam verification | WAITING | Needs `STAGING_API_BASE_URL` |

## What moved today
- **PR #189 merged** — worker-app backend wiring (A1 applied-jobs, A3 referral, A4 DPDP delete, resume reuse, error-UX sweep) + **NEW role-aware Flutter payer-app** (Company + Agency, 14 screens, mock/real seam). Client-only; 1 HIGH (empty referral link) fixed pre-merge.
- **PR #190 merged** — `docs/qa/evidence/b1` refreshed: 60 PNGs from the 2026-07-09 emulator session replace the 9 JPEGs.
- **All 60 screenshots audited** (10-reader visual audit) → indexed in [QA_EVIDENCE.md](QA_EVIDENCE.md) + flow map in [`docs/qa/evidence/README.md`](../qa/evidence/README.md). Worker-app local wiring proven; payer-app confirmed mock-mode UI evidence.
- **Stranded tracker re-score recovered** — the 2026-07-09 re-score commit (`ba625ab`, 72→75%) was committed on the old ai-service fix branch and never reached main; cherry-picked onto this docs branch.
- **Zod↔Pydantic parity fix** (invariant #7) on branch `fix/ai-contracts-zod-pydantic-parity`: `AICallMetadata` diagnostics trio + `WorkerProfileDraft.canonical_role_id` mirrored into `packages/ai-contracts`; gates green. Awaiting merge decision.

## What did NOT move
- **Staging (P0)** — still not provisioned; every B1 family (staging /health, events chain, clean logcat, PDF-open) still missing.
- **B1 verdict** — PARTIAL/NO-GO unchanged: emulator ≠ handset, local ≠ staging.
- Payer-app real-seam verification — screenshots are mock-mode; live payer API round-trip unproven.

## Evidence-hygiene follow-ups (from the audit)
- Tester's real phone visible in 4 committed shots → redact/re-shoot next capture.
- Payer unlocked-candidate screen shows a raw phone (dummy) → align with ADR-0010 in-app relay before real data.
- "Razorpay" checkout copy while payments are mock → soften copy.
- Payer-app mock credits toast/balance bug (199→2199 vs "+1,000").

## Tests run today
- ai-contracts: build ✅ · 10 tests ✅ · eslint ✅ · api typecheck ✅ · 30 consuming api tests ✅ (parity branch). No staging tests possible.

## Decisions needed
- None new. Staging execution (P0) remains the only gate.

## Tomorrow's target
- **Prakash:** staging `/health` 200 → evidence row. Only gate to B1.
- **Rishi:** re-shoot evidence with masked test number once staging lands (real handset).
- **Divyanshu:** FE wiring FE-1..FE-5 against local API.

---

# Daily Tracker — 2026-07-09

## BadaBhai Progress Snapshot
- **Overall Project: 75%** · **Alpha Readiness: 58%** · **Release Readiness: 29%**
- Payer Web 78% · Worker App 67% · Backend/API 84% · OTP/Auth/Security 80% · Agency 70% · AI-Service 80% · Infra/Staging 45% · Docs/Process 85%
- **P0: 1** (staging PAST DEADLINE) · **P1: 2** (FE wiring, LC-1 unlock/reveal) · **Decisions Needed: 0**

## Progress Movement
| Area | Last Snapshot (Jun 30) | Today | Change | Reason |
| ---- | ---------------------: | ----: | -----: | ------ |
| Overall Project | 72% | 75% | **+3%** | 16 PRs merged Jun 30–Jul 8 |
| Backend/API | 80% | 84% | **+4%** | A-batch (#173–#176) + B-batch (#177–#180) + B5 org API (#182–#184) + ai-service (#187) |
| Payer Web | 74% | 78% | **+4%** | B5 Team wired (#186); plan/boost (#179); pause/resume (#178); quota (#180); ledger (#177) |
| OTP/Auth/Security | 78% | 80% | **+2%** | PIN throttle hardened (#175); consent-on-resume (#176) |
| Agency | 68% | 70% | **+2%** | B5 org structure + payer invites (#185) |
| AI Service | 75% | 80% | **+5%** | Retry storm fixed (#187); Hinglish city aliases; rich→legacy mapper; ADR-0028 |
| Docs/Process | 80% | 85% | **+5%** | ADR-0027 (#181) + ADR-0028 (#188); tracker files added |
| Worker App | 67% | 67% | 0 | No new code; 9 MOCK screenshots; B1 staging-blocked |
| Infra/Staging | 45% | 45% | 0 | **Staging STILL not deployed — PAST deadline 2026-07-04** |
| Alpha Readiness | 57% | 58% | **+1%** | MOCK screenshots added; but 0 staging/handset proof |

## Developer Progress
| Developer | Assigned | Status | Blocker |
| --------- | -------- | ------ | ------- |
| Prakash | Staging provisioning (P0 — past deadline) | OVERDUE | AWS instance not provisioned |
| Divyanshu | FE wiring batch FE-1..FE-7 (executable now, no staging needed) | READY | Local DB stale (fresh migrate first) |
| Rishi | Flutter analyze/test; B1 handset when staging lands | WAITING | Needs `STAGING_API_BASE_URL` |

## What moved (tracker sync — based on git log review, commits Jun 30–Jul 8)
- **16 PRs merged** (#173–#188 + signup fix): A-batch, B-batch, B5 org-tenancy, AI-service storm fix, ADR-0028.
- **LC-1 CLOSED for money routes** — plan/boost now payer-authed (#179). Unlock/reveal LC-1 still open.
- **RT-1 CLOSED** — posting-plans IDOR resolved (#174 + #179).
- **B5 org-tenancy fully shipped** — payer_orgs, payer_members, PayerOrgRoleGuard, invite accept, Team page wired (#182–#186, ADR-0027).
- **AI-service retry storm fixed** — transport failure reason surfaced, Hinglish city aliases, rich→legacy canonical mapper (#187, security PASS, ruff✅ pytest✅).
- **ADR-0028 accepted** — international occupation taxonomy, TD56/TD57 registered (#188).
- All tracker files (BLOCKERS, PROJECT_STATUS, ROADMAP, RISK_REGISTER, OWNER_TASKS, DAILY_TRACKER) updated to current state.

## What did NOT move
- **Staging (P0)** — STILL not provisioned. Deadline was Jul 4 — now 5 days overdue.
- **FE wiring (FE-1..FE-7)** — all endpoints live, payer-web still calls mock shims.
- **B1 evidence** — 9 MOCK screenshots only; no staging health, no logcat, no PDF, no staging events.

## Tests run today
- Tracker sync only. Last known: `pnpm test` ✅ (1289/1289 api) · `ruff` ✅ · `pytest` ✅ (per PR #187).

## Decisions needed
- None. D1–D8 all closed.

## Tomorrow's target
- **Prakash:** Staging `/health` 200 → evidence in `docs/qa/evidence/staging/`. This is the only gate.
- **Divyanshu:** FE wiring FE-1..FE-5 (masked-résumé, pause/resume, quota, credit history, plan/boost UI) against local API.
- **Rishi:** When staging URL arrives → B1 real handset → 4 evidence artifacts in `docs/qa/evidence/b1/`.

---

# Daily Tracker — 2026-06-30

## BadaBhai Progress Snapshot
- **Overall Project: 72%** · **Alpha Readiness: 57%** · **Release Readiness: 28%**
- Payer Web 74% · Worker App 67% · Backend/API 80% · OTP/Auth/Security 78% · Agency Demand 68% · Infra/Staging 45%
- **P0: 1** · **P1: 1** · **Decisions Needed: 0**

## Progress Movement
| Area | Yesterday | Today | Change | Reason |
| ---- | --------: | ----: | -----: | ------ |
| Overall Project | 72% | 72% | 0 | Evidence verified, but no staging event/logcat proof yet |
| Alpha Readiness | 57% | 57% | 0 | `docs/qa/evidence/b1` screenshots are present; B1 still needs staging events + clean logcat + PDF-open proof |
| Docs/Process | 80% | 82% | +2 | Evidence folder is now canonical and documented; 200% owner board added |

## Developer Progress
| Developer | Assigned Today | Status | Blocker |
| --------- | -------------- | ------ | ------- |
| Prakash | Provision staging, wire secrets, `/health`, OTP-7 prep, WeasyPrint/PDF enablement | ACTIVE | AWS host + staging secrets |
| Divyanshu | Guard posting-plans `/plan` + `/boost`, add tests, record evidence | ACTIVE | None |
| Rishi | Run Flutter analyze/test, prepare real-mode handset build, attempt B1 if staging lands | ACTIVE | Needs `STAGING_API_BASE_URL` |

## What moved today
- Verified `docs/qa/evidence/b1` contains 9 screenshots.
- Added `docs/qa/evidence/README.md` as the canonical artifact index.
- Updated [QA_EVIDENCE.md](QA_EVIDENCE.md), [TEST_MATRIX.md](TEST_MATRIX.md), [PROJECT_STATUS.md](PROJECT_STATUS.md), [ROADMAP.md](ROADMAP.md), and [OWNER_TASKS.md](OWNER_TASKS.md) to use the evidence folder.
- Issued the **200% Mode — 2026-06-30** task board in [OWNER_TASKS.md](OWNER_TASKS.md).

## What did NOT move
- B1 is **not GO**: screenshots exist, but staging events, clean logcat, and PDF-open proof are still missing.
- No progress percentage moved from screenshots alone.

## Tests run today
- Not run; docs/evidence verification only.

## Decisions needed
- None. D1-D8 are already closed.

## Today’s target
- Prakash: staging `/health` 200 evidence in `docs/qa/evidence/staging/`.
- Divyanshu: posting-plans guard evidence in `docs/qa/evidence/backend/`.
- Rishi: Flutter analyze/test plus real-mode B1 evidence under `docs/qa/evidence/b1/` if staging lands.

---

# Daily Tracker — 2026-06-29

## BadaBhai Progress Snapshot
- **Overall Project: 69%** · **Alpha Readiness: 55%**
- Payer Web 74% · Worker App 62% · Backend/API 77% · OTP/Auth/Security 70% · Agency Demand 68% · Infra/Staging 45%
- **P0: 1** · **P1: 2** · **Decisions Needed: 6**

## Progress Movement
| Area | Yesterday | Today | Change | Reason |
| ---- | --------: | ----: | -----: | ------ |
| Overall Project | — | 69% | baseline | First evidence-based audit (Phases 1–4 run) |
| Alpha Readiness | — | 55% | baseline | Strong unit coverage; **zero staging/handset proof**; B1 NO-GO |
| Payer Web | — | 74% | baseline | 517 tests green; flows live; Team/Account stubs |
| Worker App | — | 62% | baseline | Core path real+tested; B1 handset run not done |
| Backend/API | — | 77% | baseline | 1141 tests green; ADMIN-3b committed clean; posting-plans IDOR |
| Infra/Staging | — | 45% | baseline | Staging CD inert/unwired |

## Developer Progress
| Developer | Assigned Main Tasks | Yesterday | Today | Change | Blocker |
| --------- | ------------------- | --------: | ----: | -----: | ------- |
| Prakash | Payer Web / Agency Demand / staging decisions | — | 74% / 68% | baseline | D1 staging, D2 OTP-7 |
| Divyanshu | Backend / OTP / posting-plans guard | — | 77% | baseline | posting-plans IDOR (P1) |
| Utkarsh | Payer Web UI / Resume web | — | 74% | baseline | Team/Account stubs |
| Flutter dev | Worker App alpha | — | 62% | baseline | B1 handset (needs staging) |
| QA / reviewer | e2e + click-throughs | — | n/a | baseline | e2e needs local PG+Redis |
| Founder/CEO | D1/D2/D5 decisions | — | n/a | baseline | spend + alpha date |

## What moved today
- Tracker stood up; full read-only audit completed (Phases 1–4).
- ADMIN-3b committed + merged by a concurrent session (`0635aee` → `14378c0` #164); re-verified branch green (lint+typecheck+test+build).
- **Payer/Agency go-live + Android API delivered:** verified API-surface workflow (17 agents) → [PAYER_WEB_GO_LIVE_PLAN.md](PAYER_WEB_GO_LIVE_PLAN.md) + [Android API reference](../api/payer-agency-api-reference.md). Headline: payer mobile auth works today via Bearer.
- **Worker-auth ADR-0026 workstream registered** ([WORKER_AUTH_ADR0026.md](WORKER_AUTH_ADR0026.md)) — Divyanshu, Phase 2+3 in progress; **conflict surfaced ([D7](DECISION_LOG.md)): Argon2id+KMS vs the accepted scrypt+env**.

## What did NOT move (and why)
- Nothing on real infra — **no staging exists yet** (D1 open).
- posting-plans IDOR still open (P1).

## ⚠️ Incident note
- A **concurrent session in the same working tree** committed ADMIN-3b mid-audit and **deleted 7 untracked tracker files** (re-created). Mitigation: one session per tree; commit the tracker for durability. Logged in [QA_EVIDENCE.md](QA_EVIDENCE.md) + [BLOCKERS.md](BLOCKERS.md).

## Tests run today
- `pnpm test` ✅ (api 1141, payer-web 517) · `pnpm build` ✅ · `pnpm lint` ✅ (0 err, 1 warn) · `pnpm typecheck` ✅ (23/23) · `pytest` ✅ · e2e ⏭️ skipped (no infra) · flutter ⚠️ not installed. Full detail: [QA_EVIDENCE.md](QA_EVIDENCE.md).

## Decisions needed
D1 staging deploy · D2 OTP-7 activation · D3 money-route auth · D4 ADMIN-3b process conditions · D5 resume render · D6 RLS deferral. See [DECISION_LOG.md](DECISION_LOG.md).

## What will move tomorrow (targets)
- Backend → 79%: add a guard to `posting-plans` (closes the open IDOR). Evidence: guard test + api suite green.
- Infra → 55%: stand up local PG+Redis, run e2e (143) green locally.
- Worker app pre-stage: `flutter analyze && test` locally + emulator mock run (pre-B1).

---

## Template (copy for the next day)
```
# Daily Tracker — YYYY-MM-DD
## BadaBhai Progress Snapshot
- Overall: XX% · Alpha: XX% · [per-phase…] · P0:n · P1:n · Decisions:n
## Progress Movement
| Area | Yesterday | Today | Change | Reason |
## Developer Progress
| Developer | Assigned | Yesterday | Today | Change | Blocker |
## What moved / didn't move / why
## Tests run (link QA_EVIDENCE rows)
## Decisions needed
## Tomorrow's target %
```
