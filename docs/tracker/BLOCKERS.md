# Blockers

Classification: **P0** blocks alpha/runtime proof · **P1** blocks an important flow (workaround exists) ·
**P2** quality (can ship alpha with a note) · **P3** polish/future.
**Never mark a P0 done without proof.**

## Progress-cap impact

| Blocker | Type | Sev | Blocks | Task progress now | Max until resolved | Owner | Decision needed? |
| ------- | ---- | --- | ------ | ----------------: | -----------------: | ----- | ---------------- |
| Staging not deployed/wired (no `API_BASE_URL`) — **D1 DECIDED: Lightsail/EC2, implementation pending** | Infra | **P0** | Worker-app B1 handset run; all staging proof; alpha gate | Alpha 55% | 90% | Prakash (D1✅ D2✅) | No — decided 2026-06-29 |
| `posting-plans` `/plan` + `/boost` are UNGUARDED money routes (IDOR) — **D3 DECIDED: guard this week** | Backend/Security | **P1** | Capacity/posting-plans phase; any prod payer surface | 55% (capacity) / 30% (this task) | 80% | Divyanshu (fix in progress) | No — decided 2026-06-29 |
| Unlock/Reveal + capacity ride `InternalServiceGuard` + body `payer_id` (LC-1, TD33/TD50) | Backend/Security | **P1** | Unlock/Reveal prod readiness | 70% | 80% | Divyanshu + security | D3a — PayerAuthGuard before prod (decided) |
| Admin PII-reveal (3b) — process conditions not yet operational (R24/OQ-7) — **D4 DECIDED: Prakash owns weekly review, 1-yr retention confirmed** | Security/Process | **P2** | Treating reveal as production-ready | 75% | 90% | Prakash | No — decided 2026-06-29; establish cadence |
| E2E (143) only runnable in CI (needs real PG+Redis) | Technical/Infra | **P2** | Local e2e proof; faster verification | n/a | — | DevOps/QA | No (run scoop PG+Redis) |
| Resume PDF render — **D5 DECIDED: PDF required for alpha** (`RESUME_RENDER_ENABLED=true` on staging; install WeasyPrint) | Product/Infra | **P1** | Alpha B1 PDF download | 72% | 90% | Prakash (infra task) | No — decided 2026-06-29 |
| `format:check` — 469 files unformatted | Quality | **P2** | none (not a CI gate) | n/a | — | any dev | No (`pnpm format`) |
| Worker-app tabs mock (profile-tab/notifications/settings) | Frontend | **P2** | Worker app polish | 25–45% | 75% | Flutter dev | No |
| Payer Team-RBAC + Account-edit are stubs (no API) | Frontend/Backend | **P2** | Team mgmt, profile edit | 45–55% | 75% | Divyanshu | No |
| **Shared-tree concurrent-session file loss** (untracked tracker files deleted by a parallel commit) | Process/Infra | **P2** | Tracker durability | n/a | — | Prakash/team | No (commit tracker; 1 session/tree) |
| Dark-theme parity / formal a11y unverified | Design | **P3** | DS polish | UNKNOWN | — | design-engineer | No |
| `ruff`/`flutter` not installed locally | Tooling | **P3** | local AI-lint / Flutter run | n/a | — | each dev | No (CI covers) |

## Blockers by category

**Technical:** e2e needs infra; format drift. (Build is green: lint ✅ / typecheck ✅ / test ✅ / build ✅ on `0635aee`.)
**Product:** PDF render required for alpha (D5 decided — install WeasyPrint on staging instance + set `RESUME_RENDER_ENABLED=true`); worker-app alpha scope (which tabs are alpha vs Phase-2).
**Backend/API:** posting-plans unguarded (P1); unlock/reveal LC-1; org-member API + account-edit endpoints missing.
**Frontend:** worker-app mock tabs; payer team/account stubs.
**Legal:** DPDP production consent copy + erasure (LEGAL_GATE); real-money payments; admin PII-reveal process conditions.
**Infra:** **staging not deployed (P0)**; security-scan still advisory; no DR plan; no cost doc; shared-tree session hazard.
**Env/secrets:** staging GitHub Environment + secrets not created (gates staging CD); see [ENV_AND_SECRETS_TRACKER.md](ENV_AND_SECRETS_TRACKER.md).

## P0 — single alpha gate · Deadline: **Friday 2026-07-04**
**D1 DECIDED (2026-06-29): AWS Lightsail or EC2. Alpha deadline: 2026-07-04.**
Staging CD is built and green — it needs a host + GitHub Environment + secrets to activate. Once Prakash provisions the instance and publishes `STAGING_API_BASE_URL`, the CD pipeline fires and B1 becomes attemptable. D2 (real OTP) approved — activate per runbook after `/health` 200. D5 (PDF render) required — WeasyPrint install + `RESUME_RENDER_ENABLED=true`. Ref: [registers/alpha-capstone-fixlist.md](../registers/alpha-capstone-fixlist.md).

**B1 sprint (Mon–Fri this week):**
- Mon–Tue: Provision Lightsail/EC2 → Docker/WeasyPrint → GitHub Environment + secrets → CD fires → `/health` 200
- Tue: Activate OTP-7 (Fast2SMS + ZeptoMail caps) → real OTP send verified
- Wed: Rishi — real handset REAL-mode build against staging API → onboarding→chat→profile→resume PDF
- Thu: Payer company gate + agency gate on staging; admin ops smoke
- Fri: All 6 alpha-gate scripts in [TEST_MATRIX.md](TEST_MATRIX.md) pass with evidence → B1 CLOSED

---
_Update the cap columns whenever a blocker is cleared; move resolved rows to a "Resolved" section with the clearing evidence + date._
