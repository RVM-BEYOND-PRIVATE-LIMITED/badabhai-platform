# Blockers

Classification: **P0** blocks alpha/runtime proof · **P1** blocks an important flow (workaround exists) ·
**P2** quality (can ship alpha with a note) · **P3** polish/future.
**Never mark a P0 done without proof.**

## Progress-cap impact

| Blocker | Type | Sev | Blocks | Task progress now | Max until resolved | Owner | Decision needed? |
| ------- | ---- | --- | ------ | ----------------: | -----------------: | ----- | ---------------- |
| **Staging not deployed — PAST 2026-07-04 deadline** (no `API_BASE_URL`; no `/health` proof) | Infra | **P0 CRITICAL** | Worker-app B1 handset run; all staging proof; alpha gate | Alpha 58% | 90% | Prakash | No — D1✅ decided; execution missing |
| **FE wiring batch (FE-1..FE-7)** — 5 mock shims stale; payer-web still mock for: masked-résumé, pause/resume, quota, credit history; plan/boost net-new UI missing | Frontend | **P1** | Payer-web alpha click-through | 60% | 90% | Divyanshu / FE | No — endpoints live; see [WEB_ALPHA_TASKS.md](WEB_ALPHA_TASKS.md) |
| Unlock/Reveal rides `InternalServiceGuard` + body `payer_id` (LC-1, TD33/TD50) | Backend/Security | **P1** | Unlock/Reveal prod readiness | 72% | 82% | Divyanshu + security | D3a — PayerAuthGuard before prod |
| Admin PII-reveal (3b) — process cadence not yet operational (R24/OQ-7) — D4 DECIDED | Security/Process | **P2** | Treating reveal as production-ready | 78% | 90% | Prakash | No — establish weekly review cadence |
| E2E local: 14 fails (stale local scoop DB — missing ADR-0026 tables; `db:migrate` blocked by 42P07) | Technical | **P2** | Local e2e proof | n/a | — | Divyanshu | No (drop/recreate local DB; local-only) |
| Resume PDF render — D5 DECIDED: `RESUME_RENDER_ENABLED=true` + WeasyPrint on staging | Product/Infra | **P1** | Alpha B1 PDF download (B1 now requires PDF per D5) | 75% | 90% | Prakash (infra) | No — decided 2026-06-29 |
| `kPersistentAuth` OFF — WorkerAuthGuard slide/re-mint consent-gate LAUNCH-GATED (#176) | Security | **P2** | Persistent auth rollout | n/a | — | Divyanshu | No — close LAUNCH-GATE before enabling |
| Worker-app tabs mock (profile-tab/notifications/settings) | Frontend | **P2** | Worker app polish | 25–45% | 75% | Rishi | No |
| Account-edit FE wiring missing (`PATCH /payer/me` live; FE seam not wired) | Frontend | **P2** | Payer profile edit | 55% | 75% | Divyanshu | No |
| `format:check` — files unformatted | Quality | **P3** | none (not a CI gate) | n/a | — | any dev | No (`pnpm format`) |
| Dark-theme parity / formal a11y unverified | Design | **P3** | DS polish | UNKNOWN | — | design-engineer | No |

## Resolved / Closed Blockers

| Blocker | Resolved | PR / Evidence |
| ------- | -------- | ------------- |
| `posting-plans` `/plan`+`/boost` unguarded (IDOR) | **2026-07-01** | #174 (InternalServiceGuard) → #179 (PayerAuthGuard, LC-1 closed for money routes) |
| Worker self-serve `/me/applications` 404 (Applied Jobs tab) | **2026-07-01** | #173 |
| PIN throttle 4 deferred MEDIUM findings (PR #168) | **2026-07-01** | #175 (cycle-0 flush reset + /pin/reset per-IP cap) |
| Consent-bypass on session-resume path (§6 invariant) | **2026-07-01** | #176 (consent-on-resume, defense-in-depth) |
| B5 Team-RBAC + Org stubs (no API) | **2026-07-03** | #182–#186 (ADR-0027; payer_orgs + payer_members + PayerOrgRoleGuard + invite accept + Team wired) |
| AI-service retry storm (transport failures + city canonicalization) | **2026-07-08** | #187 (ADR-0028; ruff✅ pytest✅ security PASS) |
| Sign-up / login bug (`payer_type NOT NULL` drift) | **2026-06-30** | `ca83b51` (migration 0032 + root-env loader) |

## Blockers by category

**Technical:** e2e 14 local fails (stale local scoop DB — drop/recreate to fix; local-only). Build green: lint ✅ / typecheck ✅ / test ✅ (1289/1289) / build ✅ on `origin/main` `a143a7d`.
**Product:** PDF render required for alpha (D5 — install WeasyPrint on staging + `RESUME_RENDER_ENABLED=true`); worker-app mock tabs (polish, Phase-2).
**Backend/API:** unlock/reveal LC-1 (InternalServiceGuard + body payer_id — close before prod). Everything else merged.
**Frontend:** FE wiring batch (FE-1..FE-7) — 5 mock shims; plan/boost net-new UI. Worker-app mock tabs.
**Legal:** DPDP production consent copy + erasure (LEGAL_GATE); real-money payments; admin PII-reveal process cadence.
**Infra:** **staging not deployed (P0 CRITICAL — PAST deadline 2026-07-04)**; security-scan advisory; no DR plan; no cost doc.
**Env/secrets:** staging GitHub Environment + secrets not created; see [ENV_AND_SECRETS_TRACKER.md](ENV_AND_SECRETS_TRACKER.md).

## P0 — single alpha gate · Deadline: **SLIPPED — was 2026-07-04, now ASAP**
**D1 DECIDED (2026-06-29): AWS Lightsail or EC2.** Deadline slipped past 2026-07-04 — staging still not provisioned as of 2026-07-09. **Every day without staging is a day alpha slips further.** Nothing else is on the critical path — 16 PRs merged, all backend + frontend work complete, only staging + FE wiring remain.

**Remaining steps (execute immediately):**
1. Prakash: Provision Lightsail/EC2 → Docker + WeasyPrint → GitHub Environment + all secrets + `RESUME_RENDER_ENABLED=true` → push to trigger CD → run 36 migrations → verify `/health` 200 → activate OTP-7 (capped, team-only)
2. Divyanshu/FE: Complete FE wiring batch (FE-1..FE-7) against local API while staging is being set up
3. Rishi: When `STAGING_API_BASE_URL` arrives → real handset REAL-mode → onboarding→chat→profile→PDF download → clean logcat
4. All 6 alpha-gate scripts in [TEST_MATRIX.md](TEST_MATRIX.md) pass with evidence → B1 CLOSED

---
_Update the cap columns whenever a blocker is cleared; move resolved rows to a "Resolved" section with the clearing evidence + date._
