# Owner Tasks — daily board

One executable day per task. Owner mapping is **PROPOSED** (confirm in [DECISION_LOG.md](DECISION_LOG.md)/standup).
Do not overload: one primary task per developer per day.

> Roster: **Prakash Kantumutchu** (Tech Lead + CEO/decision owner), **Divyanshu Pant** (Backend/AI/OTP), **Rishi Ojha** (Android/Flutter).
> Utkarsh Bhadauriya — removed from team 2026-06-29. Do not assign tasks to Utkarsh.

> ⚠️ **Process:** a concurrent session in this working tree deleted untracked files today.
> Use one session per working tree; commit work-in-progress; don't run parallel sessions on the same checkout.

---

## 2026-07-23 — agency KYC gate + payout ledger + earnings shipped (mock + gated)

> **State:** `main` @ `ed3c872` (#508, 0 open PRs). **49 migrations** (0000–0048; **0048 —
> agency_kyc/agency_payout_accruals/agency_payout_requests — applied by owner 2026-07-23**),
> **34 ADRs** (0022 now has 2 amendments). Full detail: [DAILY_TRACKER.md](DAILY_TRACKER.md) top entry.
> _(The entries below this one run only to #408/#425 — #409–#507 are not individually logged here;
> see MEMORY.md / DAILY_TRACKER.md for the sessions in that gap.)_

**PR #506** — worker/agency referral attribution wired (closes TD48). **PR #507** — payer-web
login-fix evidence (TD110 Paid, TD111 logged). **PR #508** — the agency supply-money loop
(ADR-0022 Amendment 2): owner ratified `25%×₹40/unlock, 90d, ₹500` in writing; built **MOCK +
`AGENCY_PAYOUTS_ENABLED`-OFF** (every KYC/earnings/payout route 404s until flipped — no financial
PII collected). Security review: 6 findings, 0 Crit/High, 2 fixed in-PR, 4 logged fix-before-flip
(single-agency-ownership needs a product ruling). Owner action needed: none to ship; a
first-touch-vs-last-touch call is owed before `AGENCY_PAYOUTS_ENABLED` is ever flipped.

---

## 2026-07-18 (EVENING) — B1 CLOSED; alpha IN PROGRESS; Phase 2 UNBLOCKED

> **State:** HEAD `1811494`. **B1 CLOSED** (owner-attested). Staging live, 0042+0043 applied, R27 triaged, real OTP (Fast2SMS), resume download verified. `docs/qa/evidence/staging/` not yet captured — B1 rests on owner attestation. Alpha is now IN PROGRESS (not NO-GO). Phase 2 (internal RVM pilot) is UNBLOCKED.

> ⚠️ **TD81 OPEN (P1):** ai-service is absent from the staging compose file — chat + profile extraction on staging are MOCKED while `/health` 200s. Real profiling is not provable on staging until this is resolved.

### Prakash — P1: full alpha GO (newly unblocked)
- Resolve TD81: add ai-service to staging compose OR make mock LOUD in `/health` so QA knows what they're testing.
- Run gate 1 (payer-company) + gate 2 (agency) + gate 5 (RBAC/admin smoke) on staging — all newly unblocked.
- Capture artifacts: `/health` output + events-chain export + clean logcat → `docs/qa/evidence/staging/` (cheap; closes attestation gap).
- Phase 2 kickoff: team-restricted staging bug-bash, real OTP capped, PIN throttle fast-follows (PR-#168) before PIN on real handsets.

### Divyanshu — P1: R28 + R31 + TD81
- **R28**: `GET /workers/:id/profile` returns decrypted worker name unauthenticated (bounded: box not public; arms on exposure). Add `InternalServiceGuard`; strip `resumeText`/`resumeJson.name`.
- **R31**: `PUT/GET /pricing/catalog` unauthenticated (bounded: `PAYMENTS_ENABLE_REAL=false`; fix before real payments).
- **TD81**: ai-service not in staging compose — add it or make mock LOUD in `/health`.

### Rishi — Gate 4 OTP-safety half + Phase 2 prep
- Run gate 4 on staging: wrong-code neutrality, breaker at cap=0, kill-switch, no-phone/no-code log scan.
- Capture clean logcat + staging artifacts (closes B1 attestation gap).
- Phase 2 prep: PIN unlock flow on staging handset once PR-#168 throttle fast-follows land.

### All — post-B1
- TD61: Flutter CI pin bump (3.27.4→3.35.7 + payer-app CI gate). DevOps + Rishi.
- TD81: ai-service staging compose. DevOps.
- Move ~70 repo-scope secrets into env scope (WA-6..10).
- R28 + R31: fix before Phase 3 external traffic.

---

## 2026-07-18 (MORNING) — CD pipeline GREEN; P0 = STAGING-SECRETS-1 only (+14d slip)

> **State:** HEAD `085e2f6` (#408). **45 migrations** (0000–0044; **0042 + 0043 apply-before-deploy**). **34 ADRs** (0001–0033). 2,465 TS tests green. CD pipeline BUILT and VERIFIED GREEN (CD-0..CD-5, ephemeral GITHUB_TOKEN login). Repo is PUBLIC. **OTP REAL-ONLY.** TD62 consent-routing RESOLVED (#240, 2026-07-15). 10 owner rulings codified (#387). Since 07-15: ADR-0031 deletion grace (#400), ADR-0032 profile photo (#340/#402), ADR-0033 skills-overlap (.15, #394), CD hardening, phone separator + danda fix (#392/#397), chunked STT D-2 (#395), gated test-login D-3 (#391), live pricing D-6 (#393), B-3/B-4/B-5 (#385/#392), alerts fixes (#403–#405), guard fixes (#407/#408).

> ⚠️ **R27 residual:** box was running on public dev secrets + throwaway Postgres. Treat every session/PII minted there as compromised. CD now deploys clean — but the box must be re-provisioned with fresh secrets.

### Prakash — P0 CRITICAL: STAGING-SECRETS-1 (owner-only, ~half day, non-delegable)
The CD pipeline exists and is verified green. The **only remaining gate** is secrets provisioning.
1. **STAGING-SECRETS-1**: real secrets into the GitHub `staging` Environment — generated fresh (NEVER from `.env`). **Include `CORS_ALLOWED_ORIGINS`** (TD72a — omitting silently blocks every browser call while `/health` 200s).
2. Apply migration **0042** then **0043** — both apply-before-deploy (0042 breaks extraction; 0043 breaks credits).
3. Triage R27 box: stop dev-secret API + throwaway Postgres; decide volume fate.
4. Deploy → `/health` 200. Set `RESUME_RENDER_ENABLED=true` + WeasyPrint; decide `PAYER_LOGIN_METHOD`.
5. OTP-7: Fast2SMS creds + team allowlist activation.
6. Also: **SECRET-1** (10 min) — restrict Google API key in Google Console.
- See [ROADMAP.md](ROADMAP.md) critical path for full ordered list.
- **Re-forecast: if SECRETS-1 lands today → B1 closes ~07-21/22.**

### Divyanshu — P1: R28 + R31 (bounded but armed on exposure)
- **R28**: `GET /workers/:id/profile` returns decrypted worker name unauthenticated. Fix: add `InternalServiceGuard` to list/getProfile/setName + strip `resumeText`/`resumeJson.name`. (Bounded: box not public + no real worker names yet; arms on first external traffic.)
- **R31**: `PUT/GET /pricing/catalog` completely unauthenticated — anyone reaching API can rewrite payer billing rates. Fix: add auth guard. (Bounded: `PAYMENTS_ENABLE_REAL=false`; fix before real payments.)
- **TD81**: ai-service is not in the staging compose file — staging degrades to mocked AI while `/health` 200s. Either add it to compose or make the mock status LOUD in `/health` before staging is handed to QA/Rishi for B1.

### Rishi — Prep B1 (gated on Prakash's staging + OTP-7)
- `flutter analyze && flutter test` locally (Flutter 3.35.7 required — local toolchain at 3.27.4 is stale, TD61).
- Prep REAL-mode build (`--dart-define=USE_MOCKS=false --dart-define=API_BASE_URL=https://<staging-api>`).
- When `STAGING_API_BASE_URL` + OTP-7 confirmed: REAL OTP to allowlisted phone → onboarding → chat → profile → PDF download → 4 evidence artifacts to `docs/qa/evidence/staging/`.

### All — post-SECRETS-1
- **TAX-9 versioning/re-tag** (migration 0039 applied 2026-07-15; #232): no follow-on work required unless retag runner is exercised.
- **RVM vernacular ratification DONE** (22/22 aliases RATIFY-1, 2026-07-16). Remaining: flip `SKILL_CANONICALIZE_ENABLED` on staging post-B1.
- **ADR-0031 prod endpoint** (§7-gated) — activate after staging is stable.
- **TD61**: Flutter CI pin bump (3.27.4 → 3.35.7 + payer-app CI gate). Owner: DevOps + Rishi.
- **Move ~70 repo-scope secrets into env scope** (WA-6..10) — after SECRETS-1.

---

## 2026-07-18 — 🎉 B1 CLOSED · staging P0 CLEARED · **alpha is now in progress, not blocked**

> **State:** `main` @ `5a12cae` (#425). 45 migrations (0000–0044, **0042+0043 applied**), 34 ADRs.
> **Owner-attested 2026-07-18:** staging live · R27 box triaged · **real OTP** · **resume download working**
> · **B1 CLOSED**. Overall ~85% · Alpha ~78% · Release ~38%. Flutter: team on **3.35** (CI pins 3.35.7).

### QA / Prakash — **P1: run the three untouched alpha gates** (shortest path to a full GO)
Staging is up, so these are now just work. None has ever run on real infra:
- **Gate 1 — payer company:** signup/login → dashboard → post job → pause/resume → applicants → unlock →
  reveal → wallet/ledger → capacity → plan/boost. Expect: faceless, mock credits move, routed handle only.
- **Gate 2 — agency:** agent login → vacancy → invite → faceless referrals → **company blocked from agency routes**.
- **Gate 5 — RBAC / admin smoke:** owner vs recruiter, agent vs employer, fail-closed server-side; ADMIN-3a/3b/3c.
- **Gate 4 safety half:** wrong-code neutral · breaker at cap=0 · kill-switch · log scan shows **no phone/code**.
- Capture into `docs/qa/evidence/staging/` and index in [QA_EVIDENCE.md](QA_EVIDENCE.md).

### Prakash — **P1 decision: [TD81](../registers/tech-debt-register.md)** (owner-only)
The `ai-service` is **not in the compose file** — staging runs **mocked AI behind a 200 `/health`**.
Choose: **(a)** add an `ai-service` service + set `AI_SERVICE_URL=http://ai-service:8000` (TD67's token then
becomes genuinely 3-sided), or **(b)** accept mocked-AI staging and make it **LOUD** in `/health`.
**Settle before anyone validates real profiling or flips `AI_ENABLE_REAL_CALLS` anywhere shared.**

### Rishi — **P2: capture the staging artifacts (T7)** + Flutter PATH
- Next REAL-mode run: save `/health` 200 output, the staging `events` chain, a clean logcat, and the
  `resume.downloaded` row → `docs/qa/evidence/staging/`. Closes the attestation gap permanently.
- Confirm `where flutter` resolves **3.35.7** (match the CI pin exactly), then run
  `flutter analyze && flutter test` for **both** worker-app and payer-app.

### Divyanshu — **P2: the two red/never-run automated gates**
- **T1 — ai-service `pytest` is RED locally** (2 failed, 389 passed): [`tests/conftest.py`](../../apps/ai-service/tests/conftest.py)
  predates the TAX surfaces and doesn't neutralize `skill_canonicalize_enabled` or the embedding allowlist,
  so **a unit test fired a real Gemini embedding call** (`skill_embedding provider HTTP 400`). Real-spend
  risk on any dev machine with a real `.env`. **Also confirm CI is actually green** — the "pytest ✅" claim
  predates the TAX series.
- **T3 — e2e has never run here:** `pnpm db:migrate` locally + `RUN_E2E=1` (10 suites skipped), and enable
  `RUN_E2E` on staging.

### All — Phase 2 (internal RVM pilot) is **UNBLOCKED**
Was due week of 2026-07-07. Can start once gates 1/2/5 pass. Keep every real-provider flip OFF
(`AI_ENABLE_REAL_CALLS`, `PAYMENTS_ENABLE_REAL`, `MESSAGING_ENABLE_REAL`) — **[R30](../registers/risks-register.md)
still gates the AI flip** (word-split phone bypass, open by design).

---

## 2026-07-15 — TAX-7 merged; staging STILL P0 (11 days past deadline)

> **State:** HEAD `548acd4` (#231 docs sync). 39 migrations (0000–0038, **0038 applied**). ADR-0030 P1+P2 COMPLETE (TAX-0..8 merged). kPersistentAuth ON (PR #201). FE wiring CLOSED (PR #194). No open PRs. **OTP is REAL-ONLY** — `SMS_PROVIDER: z.literal("fast2sms")`; `SMS_PROVIDER=console` fails boot. Staging requires Fast2SMS creds.

### Prakash — P0 CRITICAL: staging (11 days past deadline)
- **Provision Lightsail/EC2** → Docker + WeasyPrint + `RESUME_RENDER_ENABLED=true` → `staging` GitHub Environment + secrets.
- **Critical env change vs old runbook:** set `NODE_ENV=staging` (NOT `development`) + `SMS_PROVIDER=fast2sms` (NOT `console`). Set `FAST2SMS_API_KEY` + DLT params — the API **won't boot without them**.
- Push → run **39 migrations** (0000–0038) → `/health` 200 → activate OTP-7 (capped, team allowlist only).
- See [staging-service-deploy-runbook.md](../ops/staging-service-deploy-runbook.md) (updated 2026-07-15 — Mode A is DEPRECATED).
- Evidence: `docs/qa/evidence/staging/2026-07-15-health.txt`.

### Divyanshu — ~~P1: TD62 kPersistentAuth consent-routing fix~~ DONE 2026-07-15
- **RESOLVED** on `fix/td62-consent-routing-and-payer-fastfollows` (production-residuals PR C).
- Seam shipped: additive `consent_accepted` on `/auth/otp/verify` + `/auth/pin/verify` (not `GET /workers/me` — the verify responses are where the client routes from); tri-state client parse (null = old server, pass-through); `router.dart` authenticated arm gates on a definitive `false`; ConsentCubit releases the gate on accept-success.

### Rishi — Prep B1 real-handset run (gated on Prakash's staging)
- `flutter analyze && flutter test` locally.
- Prep REAL-mode build (`--dart-define=USE_MOCKS=false --dart-define=API_BASE_URL=https://<staging-api>`).
- When `STAGING_API_BASE_URL` arrives: onboarding→chat→profile→PDF download → 4 evidence artifacts.
- **Note:** OTP is REAL (SMS to your number via Fast2SMS — no `dev_otp`). You need to be on the team allowlist.

### All
- **TAX-9 P3 versioning/re-tag** (ADR-0030): pick up when staging P0 is cleared.
- **RVM vernacular ratification** (skill-vernacular-ratification-packet.md): human gate, owner decision.
- **ADR-0031 deletion grace**: Prakash+Akshit sign-off pending.
- **TD61 CI pin bump** (Flutter 3.27.4→3.35.7 + payer-app CI gate): DevOps + Rishi.

---

## 2026-07-09 — Alpha recovery (staging PAST DEADLINE — execute now)

> **State:** 16 PRs merged (Jun 30–Jul 8), everything built. Alpha B1 deadline was Jul 4 — SLIPPED 5 days. Staging is the only P0. FE wiring (FE-1..FE-7) is parallelizable. `origin/main` HEAD: `a143a7d`.

### Prakash — P0 CRITICAL: staging
- **Provision Lightsail/EC2 TODAY** → Docker + WeasyPrint + `RESUME_RENDER_ENABLED=true` → `staging` GitHub Environment + all secrets → push → run 36 migrations → `/health` 200 → activate OTP-7 (capped, team-only). Keep AI/payments/WhatsApp OFF.
- **Publish `STAGING_API_BASE_URL` to team the moment it's live.**
- Evidence: `docs/qa/evidence/staging/2026-07-09-health.txt` + `-smoke.txt`.

### Divyanshu — P1: FE wiring batch (parallelizable — no staging needed)
- `git checkout main && git pull` + fresh-migrate local DB (drop/recreate local scoop DB; 14 e2e fails = stale schema).
- Per [WEB_ALPHA_TASKS.md](WEB_ALPHA_TASKS.md): **FE-1** masked-résumé, **FE-2** pause/resume, **FE-4** quota, **FE-5** credit ledger, **FE-3** plan/boost net-new UI, **FE-7** kill stale comments + drop mock-store.
- Gate: `pnpm --filter @badabhai/payer-web test` green + local click-through per wave.

### Rishi — B1 handset (gated on staging)
- Flutter analyze + test locally. Prep REAL-mode env + clean-logcat procedure. Confirm Applied Jobs tab calls `GET /workers/me/applications` (#173).
- When `STAGING_API_BASE_URL` arrives: real handset REAL-mode → onboarding→chat→profile→resume PDF → 4 evidence artifacts. **Do NOT flip `kPersistentAuth` ON** (LAUNCH-GATED per #176).

_Alpha done = all 6 gate scripts in [TEST_MATRIX.md](TEST_MATRIX.md) pass → B1 CLOSED._

---

## 2026-07-03 — Alpha final push (deadline 2026-07-04)

Everything is built (ADR-0026, ADMIN, A/B batch #173–#180, B5 org/Team #182–#186 all on `main`, 36 migrations). **The only thing between ~74%-built and alpha is staging.** Three parallel tracks; evidence-gated.

### Prakash — P0: staging (the whole deadline rides on this)
- **Provision Lightsail/EC2 TODAY** → Docker + WeasyPrint + `RESUME_RENDER_ENABLED=true` → `staging` GitHub Env + secrets → CD fires → run migrations (36, incl. 0035) → `/health` 200 → activate OTP-7 (capped, team-only). Keep AI/payments/WhatsApp/`MEMBER_INVITES_ENABLE_REAL` OFF.
- **Publish `STAGING_API_BASE_URL` to Rishi the moment it's up.** Commit the tracker.
- Evidence: `docs/qa/evidence/staging/2026-07-03-health.txt` + `-smoke.txt`.
- **If not up today → alpha slips to ~07-07/08.** This is the escalation.

### Divyanshu / FE — Web alpha wiring (NOT staging-blocked — do now)
- `git checkout main && git pull` first (local stale). Then, per [WEB_ALPHA_TASKS.md](WEB_ALPHA_TASKS.md): **FE-1** masked-résumé → `POST /payer/resume-disclosures`; **FE-2** pause/resume → `/pause`+`/resume`; **FE-4** quota → `/quota`; **FE-5** credit history → `GET /payer/credits/ledger`; **FE-3** plan/boost net-new UI → `/plan`+`/boost`; **FE-7** kill stale "no route yet" comments + drop the mock-store fallback.
- Each: mock→live through the typed Zod seam; `pnpm --filter @badabhai/payer-web test` green + a local click-through (needs local DB fresh-migrate — Task C).

### Rishi — B1 handset (gated on Prakash's staging)
- Now: pull main; `flutter analyze && flutter test`; prep REAL-mode build + clean-logcat procedure + PDF-open verification. Confirm Applied Jobs tab calls the merged `GET /workers/me/applications` (A1).
- When `STAGING_API_BASE_URL` lands: run B1 on a real handset → capture the 4 missing artifacts (staging health, `events` export, clean logcat, PDF-open + `resume.downloaded`).
- **Do NOT flip `kPersistentAuth` ON** — the WorkerAuthGuard slide/re-mint consent-gate launch-gate is still open ([[pr176-consent-on-resume]]); run B1 with OTP each time.

_Definition of alpha done: all 6 gate scripts in [TEST_MATRIX.md](TEST_MATRIX.md) pass with evidence → B1 CLOSED. Real-provider gates stay OFF._

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
