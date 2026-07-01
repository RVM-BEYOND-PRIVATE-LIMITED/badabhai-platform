# Owner Tasks — daily board

One executable day per task. Owner mapping is **PROPOSED** (confirm in [DECISION_LOG.md](DECISION_LOG.md)/standup).
Do not overload: one primary task per developer per day.

> Roster: **Prakash Kantumutchu** (Tech Lead + CEO/decision owner), **Divyanshu Pant** (Backend/AI/OTP), **Rishi Ojha** (Android/Flutter).
> Utkarsh Bhadauriya — removed from team 2026-06-29. Do not assign tasks to Utkarsh.

> ⚠️ **Process:** a concurrent session in this working tree deleted untracked files today.
> Use one session per working tree; commit work-in-progress; don't run parallel sessions on the same checkout.

---

## 200% Mode — 2026-06-30

Goal for today: convert the B1 sprint from "screenshots exist" to "runtime proof
exists." Evidence artifacts go in [`docs/qa/evidence/`](../qa/evidence/), then get
indexed in [QA_EVIDENCE.md](QA_EVIDENCE.md). No one gets credit for a verbal update.

### Prakash Kantumutchu — P0 command center

**Primary outcome by EOD:** public staging URL with `/health` green, or a written
blocker with the exact failing step and owner.

1. Stand up AWS Lightsail/EC2 staging.
   - Install runtime dependencies, Redis access, and WeasyPrint.
   - Set `RESUME_RENDER_ENABLED=true`.
   - Keep `AI_ENABLE_REAL_CALLS=false`, `PAYMENTS_ENABLE_REAL=false`,
     `MESSAGING_ENABLE_REAL=false`, `CAPACITY_ENFORCEMENT_ENABLED=false`.
2. Create/verify the GitHub `staging` Environment secrets.
   - Required: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `PII_ENCRYPTION_KEY`,
     `PII_HASH_PEPPER`, `INTERNAL_SERVICE_TOKEN`, `STAGING_API_BASE_URL`.
   - OTP-7 after health: Fast2SMS + ZeptoMail only for team allowlisted recipients.
3. Run and capture:
   - `GET https://<staging-api>/health`
   - staging smoke output
   - migration status
4. Evidence to save:
   - `docs/qa/evidence/staging/2026-06-30-health.txt`
   - `docs/qa/evidence/staging/2026-06-30-smoke.txt`
   - screenshot of the successful GitHub staging run, if available.
5. Update:
   - [QA_EVIDENCE.md](QA_EVIDENCE.md)
   - [TEST_MATRIX.md](TEST_MATRIX.md)
   - [BLOCKERS.md](BLOCKERS.md)
6. **Commit the tracker** (5 min). `docs/tracker/*` + `docs/api/*` + `docs/qa/evidence/*` are
   currently **uncommitted on `main`** and a sign-up/login fix (`ca83b51`) just went straight
   to main — the tracker is one `git clean`/checkout from being lost. Commit it so it's durable.

**Do not spend time on:** new features, cosmetic UI, real AI, real payments, real
WhatsApp, production data.

### Divyanshu Pant — P1 security closer

**Primary outcome by EOD:** posting-plans money route is no longer unauthenticated.

1. Guard `posting-plans` `/plan` and `/boost`.
   - Minimum alpha fix: add `InternalServiceGuard`.
   - Better fix if scoped cleanly: payer-authed route with session-derived payer id.
   - Do not let a public/body `payer_id` be trusted without a guard.
2. Add tests:
   - unguarded request denied,
   - guarded/internal request succeeds,
   - important event still emits and validates,
   - no raw PII in event/log payloads.
3. Run:
   - `pnpm --filter @badabhai/api test`
   - `pnpm typecheck`
   - `pnpm lint`
4. Evidence to save:
   - `docs/qa/evidence/backend/2026-06-30-posting-plans-guard.txt`
5. Update:
   - [QA_EVIDENCE.md](QA_EVIDENCE.md)
   - [BLOCKERS.md](BLOCKERS.md)
   - [TEST_MATRIX.md](TEST_MATRIX.md)

**Queue after the guard (in priority order — pick what fits the day, don't overload):**
1. **`GET /me/applications`** — PR #172 shipped the worker-app Applied Jobs tab but it **404s in real builds** until this endpoint exists. Small, worker-authed, unblocks Rishi's Applied tab for the B1 run. (Consent-gated; PII-free projection.)
2. **Consent-bypass fix (gate-ON §6)** — the §6 consent-bypass **MUST be fixed before `kPersistentAuth` is flipped ON** (mobile persistent auth). Not strictly B1-blocking (B1 can run with OTP each time), but it gates Phase-2 persistent auth — do it before Rishi enables PIN persistence.
3. **Regression test for the sign-up/login bug** (`ca83b51`) — that fix went **straight to main with no PR/test**. Add a regression test so it can't silently come back; confirm it didn't regress the OTP path.
4. **First PR-#168 PIN throttle fast-follow** (cycle-0 flush reset OR `/pin/reset` OTP-cap bypass).

**Note on posting-plans (D3):** PR #171 already **annotated** `/plan` + `/boost` as ops-only / not payer-surface (LC-1/TD33 audit recorded). Confirm with Prakash whether the alpha bar is "annotation-only (ops routes, payer-web never calls them)" or "add `InternalServiceGuard` now." If guard: proceed as above. `PayerAuthGuard` stays the prod gate (D3a).

### Rishi Ojha — Android proof runner

**Primary outcome by EOD:** real-mode build is ready, and if staging is live, B1 is
attempted on a real handset.

1. Pull latest `main`, then run:
   - `flutter analyze`
   - `flutter test`
2. Build real mode:
   - `--dart-define=USE_MOCKS=false`
   - `--dart-define=API_BASE_URL=https://<staging-api>`
3. If staging is not live yet:
   - verify mock/emulator smoke,
   - write the exact B1 run checklist,
   - confirm the screenshots already in `docs/qa/evidence/b1` still match current app.
4. If staging is live:
   - run B1 on real handset: login -> OTP -> consent -> name -> chat -> profile ->
     resume -> Download PDF.
   - capture clean logcat.
   - give Prakash/Divyanshu worker id + timestamp for event export.
5. Evidence to save:
   - screenshots under `docs/qa/evidence/b1/`
   - `docs/qa/evidence/b1/2026-06-30-logcat-clean.txt`
   - `docs/qa/evidence/b1/2026-06-30-worker-events.json`
   - `docs/qa/evidence/b1/2026-06-30-pdf-open.jpeg`

**Do not spend time on:** voice/STT, notifications, job-detail real endpoint,
settings polish, or new tabs until B1 evidence is complete.

### Team rule for today

The board is evidence-gated: task is not done until the artifact exists under
`docs/qa/evidence/` and the tracker row points to it.

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
- **EOD output:** staging URL live + `/health` 200 artifact in [`docs/qa/evidence/`](../qa/evidence/) and index row in [QA_EVIDENCE.md](QA_EVIDENCE.md).

### Divyanshu Pant
- **Priority:** P1 (security)
- **Context:** `posting-plans` `/plan` + `/boost` have **no auth guard** (IDOR/money-theft). Documented interim, but open.
- **Task:** Add `@UseGuards(InternalServiceGuard)` to `posting-plans.controller.ts` (alpha interim, matching `unlocks`); add a guard test. (Full `PayerAuthGuard` + drop body `payer_id` is the LC-1 follow-up, D3a.)
- **Why it matters:** Closes an open money-theft vector before any payer surface.
- **Files:** `apps/api/src/posting-plans/posting-plans.controller.ts`, `posting-plans.dto.ts`, new `*.controller.spec.ts`.
- **Acceptance:** unguarded request → 401/403; guarded request → works; `pnpm lint && typecheck && test` green for api.
- **Tests:** controller guard spec + existing posting-plans suite.
- **Do not touch:** payment realness (keep mock); pricing config.
- **Dependencies:** none. **EOD output:** PR-ready diff + green api suite artifact in [`docs/qa/evidence/`](../qa/evidence/) and index row in [QA_EVIDENCE.md](QA_EVIDENCE.md).
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
- **Dependencies:** D1 staging URL (Prakash) for REAL handset run. **EOD output:** analyze/test output + emulator/handset screenshots in [`docs/qa/evidence/`](../qa/evidence/) and index row in [QA_EVIDENCE.md](QA_EVIDENCE.md).

### QA / reviewer
- **Priority:** P1
- **Context:** E2E (143) only run in CI; not proven locally. Local infra unblocks fast verification.
- **Task:** Stand up local Postgres + Redis (scoop, no Docker — see project memory: local-dev-run-setup), run `RUN_E2E=1 pnpm --filter @badabhai/e2e test` and record pass/fail.
- **Why it matters:** Local e2e proof raises confidence before staging.
- **Acceptance:** e2e suite runs (not skipped); pass count recorded; any failure triaged.
- **Do not touch:** real providers (e2e uses fakes). **EOD output:** e2e counts in [`docs/qa/evidence/`](../qa/evidence/) + [QA_EVIDENCE.md](QA_EVIDENCE.md) + [TEST_MATRIX.md](TEST_MATRIX.md).

### All decisions closed — no open decisions remaining
> D1–D8 all decided 2026-06-29. Alpha deadline: **Friday 2026-07-04**.
> D5: PDF render required — install WeasyPrint + `RESUME_RENDER_ENABLED=true`.
> D6: RLS deferred confirmed for alpha; finalize before production (Phase 6).

---
_Re-issue this board each day; carry unfinished tasks forward with a reason. Confirm the owner mapping before relying on it._
