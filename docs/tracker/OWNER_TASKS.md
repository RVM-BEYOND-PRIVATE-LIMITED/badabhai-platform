# Owner Tasks — daily board

One executable day per task. Owner mapping is **PROPOSED** (confirm in [DECISION_LOG.md](DECISION_LOG.md)/standup).
Do not overload: one primary task per developer per day.

> Roster: **Prakash Kantumutchu** (Tech Lead + CEO/decision owner), **Divyanshu Pant** (Backend/AI/OTP), **Rishi Ojha** (Android/Flutter).
> Utkarsh Bhadauriya — removed from team 2026-06-29. Do not assign tasks to Utkarsh.

> ⚠️ **Process:** a concurrent session in this working tree deleted untracked files today.
> Use one session per working tree; commit work-in-progress; don't run parallel sessions on the same checkout.

---

## B1 Sprint — 2026-06-29 → 2026-07-04 · Alpha deadline: **Friday 2026-07-04**

### Prakash Kantumutchu
- **Priority:** P0
- **Context:** D1 DECIDED (AWS Lightsail/EC2) + D2 DECIDED (real OTP approved). The decision is made — the task is now purely execution.
- **Task:** Provision Lightsail or EC2 instance → install Docker/compose + **WeasyPrint** (required for PDF resume, D5 decided) → wire staging-cd: create `staging` GitHub Environment + add all secrets from [ENV_AND_SECRETS_TRACKER.md](ENV_AND_SECRETS_TRACKER.md) + set `RESUME_RENDER_ENABLED=true` → push to trigger CD → verify `/health` 200 → activate OTP-7 real-send per [otp-real-send-staging-runbook.md](../ops/otp-real-send-staging-runbook.md).
- **Why it matters:** Every alpha proof gate (B1 handset, payer flow, OTP, events) is blocked on this single step.
- **Files/modules:** `.github/workflows/staging-cd.yml`, [ops/staging-service-deploy-runbook.md](../ops/staging-service-deploy-runbook.md), [ENV_AND_SECRETS_TRACKER.md](ENV_AND_SECRETS_TRACKER.md).
- **Acceptance:** staging-cd guard step passes; public `https://<host>/health` returns 200 with DB+Redis green.
- **Tests:** `pnpm staging:smoke` against the public URL.
- **Do not touch:** real-provider gates (keep AI/payments/WhatsApp OFF); production data.
- **Secondary:** Establish the weekly `admin.pii_viewed` audit-stream review cadence (D4 — Prakash is the named owner); once operational, enable ADMIN-3b on staging.
- **EOD output:** staging URL live + `/health` 200 screenshot in [QA_EVIDENCE.md](QA_EVIDENCE.md).

### Divyanshu Pant
- **Priority:** P1 (security)
- **Context:** `posting-plans` `/plan` + `/boost` have **no auth guard** (IDOR/money-theft). Documented interim, but open.
- **Task:** Add `@UseGuards(InternalServiceGuard)` to `posting-plans.controller.ts` (alpha interim, matching `unlocks`); add a guard test. (Full `PayerAuthGuard` + drop body `payer_id` is the LC-1 follow-up, D3a.)
- **Why it matters:** Closes an open money-theft vector before any payer surface.
- **Files:** `apps/api/src/posting-plans/posting-plans.controller.ts`, `posting-plans.dto.ts`, new `*.controller.spec.ts`.
- **Acceptance:** unguarded request → 401/403; guarded request → works; `pnpm lint && typecheck && test` green for api.
- **Tests:** controller guard spec + existing posting-plans suite.
- **Do not touch:** payment realness (keep mock); pricing config.
- **Dependencies:** none. **EOD output:** PR-ready diff + green api suite in [QA_EVIDENCE.md](QA_EVIDENCE.md).
- **Note on ADR-0026:** Phase 1–5 are now ALL merged (PRs #162, #167, #168, #169, #170 — 2026-06-29). D7 (scrypt vs Argon2id) was resolved by the merged code — verify the implementation matches the ADR before enabling on staging.

### ~~Utkarsh Bhadauriya~~ — REMOVED from team 2026-06-29. Do not assign.

### Rishi Ojha (Android / Flutter)
- **Priority:** P1 (staging being set up — pre-stage B1 now)
- **Context:** Worker-app has 9 PRs of auth + UI work merged today. Staging is being provisioned. Pre-stage the B1 handset run now so it can be attempted the moment D1 is live.
- **Task:** Run `flutter analyze && flutter test` locally; verify MOCK build boots end-to-end (`--dart-define=USE_MOCKS=true`) on an emulator through the full onboarding→resume flow; document exact REAL-mode env (`API_BASE_URL`, OTP creds) needed for B1.
- **Why it matters:** B1 is the alpha gate — the moment Prakash publishes the staging URL, Rishi runs the real handset flow.
- **Files:** `apps/worker-app/` (no source changes needed).
- **Acceptance:** analyze clean (or issues listed); mock onboarding→resume on emulator completes; B1 prerequisite checklist written.
- **Tests:** `flutter test` (46 files). **Do not touch:** default `USE_MOCKS=false`; do not commit real keys.
- **Dependencies:** D1 staging URL (Prakash) for REAL handset run. **EOD output:** analyze/test output + emulator screenshot in [QA_EVIDENCE.md](QA_EVIDENCE.md).

### QA / reviewer
- **Priority:** P1
- **Context:** E2E (143) only run in CI; not proven locally. Local infra unblocks fast verification.
- **Task:** Stand up local Postgres + Redis (scoop, no Docker — see project memory: local-dev-run-setup), run `RUN_E2E=1 pnpm --filter @badabhai/e2e test` and record pass/fail.
- **Why it matters:** Local e2e proof raises confidence before staging.
- **Acceptance:** e2e suite runs (not skipped); pass count recorded; any failure triaged.
- **Do not touch:** real providers (e2e uses fakes). **EOD output:** e2e counts in [QA_EVIDENCE.md](QA_EVIDENCE.md) + [TEST_MATRIX.md](TEST_MATRIX.md).

### All decisions closed — no open decisions remaining
> D1–D8 all decided 2026-06-29. Alpha deadline: **Friday 2026-07-04**.
> D5: PDF render required — install WeasyPrint + `RESUME_RENDER_ENABLED=true`.
> D6: RLS deferred confirmed for alpha; finalize before production (Phase 6).

---
_Re-issue this board each day; carry unfinished tasks forward with a reason. Confirm the owner mapping before relying on it._
