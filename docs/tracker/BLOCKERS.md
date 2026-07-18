# Blockers

Classification: **P0** blocks alpha/runtime proof · **P1** blocks an important flow (workaround exists) ·
**P2** quality (can ship alpha with a note) · **P3** polish/future.
**Never mark a P0 done without proof.**

## Progress-cap impact

| Blocker | Type | Sev | Blocks | Task progress now | Max until resolved | Owner | Decision needed? |
| ------- | ---- | --- | ------ | ----------------: | -----------------: | ----- | ---------------- |
| ~~**Staging not deployed**~~ ✅ **RESOLVED 2026-07-18** — staging live, `0042`+`0043` applied, R27 box triaged, **real OTP**, **B1 CLOSED** (owner-attested, [QA_EVIDENCE](QA_EVIDENCE.md)). Open 19 days; cost 14 days of schedule | Infra | ~~P0~~ **CLEARED** | — | — | — | Prakash | No |
| **[TD81](../registers/tech-debt-register.md) — staging runs MOCKED AI behind a 200 `/health`** (the `ai-service` is absent from [`docker-compose.yml`](../../docker-compose.yml)) | Infra/AI | **P1** | Any "real profiling verified on staging" claim; chat + profile-extraction proof | AI-service staging proof 0% | — | Owner + DevOps | **Yes** — deploy the service, or make the mock LOUD in `/health` |
| **Remaining alpha gates never run on staging** — payer-company (1), agency (2), RBAC/admin smoke (5), OTP-safety half (4) | QA | **P1** | Full alpha GO | Alpha ~78% | 90% | QA + Prakash | No — newly unblocked, just needs running |
| **Staging artifacts uncaptured** — `docs/qa/evidence/staging/` does not exist; B1 rests on owner attestation, not files | Process | **P2** | Reproducible proof for a later verifier | n/a | — | Rishi/QA | No — capture on next run |
| Ops `/unlocks*` surface retire — blocked on ADMIN-4..8 + headless payer mint (LC-1 residual, TD33/TD50). **Note:** payer-facing unlock/reveal is ALREADY `PayerAuthGuard`-protected (`payer-unlocks.controller.ts:41`, PR #110/#119). Only the ops internal surface remains. | Backend/Security | **P1** | Ops unlock retire | 72% | 82% | Divyanshu + security | Blocked on ADMIN-4..8 |
| Admin PII-reveal (3b) — process cadence not yet operational (R24/OQ-7) — D4 DECIDED | Security/Process | **P2** | Treating reveal as production-ready | 78% | 90% | Prakash | No — establish weekly review cadence |
| E2E local: 14 fails (stale local scoop DB — missing ADR-0026 tables; `db:migrate` blocked by 42P07) | Technical | **P2** | Local e2e proof | n/a | — | Divyanshu | No (drop/recreate local DB; local-only) |
| Resume PDF render — D5 DECIDED: `RESUME_RENDER_ENABLED=true` + WeasyPrint on staging | Product/Infra | **P1** | Alpha B1 PDF download (B1 now requires PDF per D5) | 75% | 90% | Prakash (infra) | No — decided 2026-06-29 |
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
| **FE wiring batch (FE-1..FE-7)** — all mock shims replaced with live API calls | **2026-07-10** | #194 (`feat(payer-web): final mock→live seams + missing-caller pages, no mock fallback left`) |
| Sign-up / login bug (`payer_type NOT NULL` drift) | **2026-06-30** | `ca83b51` (migration 0032 + root-env loader) |
| **TD62 `kPersistentAuth` consent-routing gap (P1 HIGH)** — never-onboarded worker routed to shell, not `/consent` | **2026-07-15** | `fix/td62-consent-routing-and-payer-fastfollows` (additive `consent_accepted` on `/auth/otp/verify` + `/auth/pin/verify`; tri-state client parse; router consent gate; ConsentCubit release) |

## Blockers by category

**Technical:** e2e 14 local fails (stale local scoop DB — drop/recreate to fix; local-only). Build green: lint ✅ / typecheck ✅ / test ✅ / build ✅ on `origin/main` `085e2f6` (#408) — **2,465 tests / 23 tasks**. TD62 consent-routing RESOLVED 2026-07-15 (#240). TD81: ai-service missing from compose file (staging mocks AI silently — P1 warning, deploy it or make mock LOUD in `/health`).
**Product:** PDF render required for alpha (D5 — `RESUME_RENDER_ENABLED=true` + WeasyPrint in compose); worker-app mock tabs (polish, Phase-2). `PAYER_LOGIN_METHOD` must be set on staging (base dev value is MOCK `whatsapp` — payer login dead on box until set).
**Backend/API:** Ops `/unlocks*` LC-1 residual (InternalServiceGuard retire blocked on ADMIN-4..8). R28 OPEN: `GET /workers/:id/profile` returns decrypted worker name unauthenticated (bounded: box not public, no real names; arms on exposure). R31 OPEN: `PUT/GET /pricing/catalog` unauthenticated (bounded: `PAYMENTS_ENABLE_REAL=false`). Payer-facing routes ARE PayerAuthGuard-protected — not a payer blocker.
**Frontend:** FE wiring batch (FE-1..FE-7) CLOSED by PR #194. Worker-app mock tabs (polish, Phase-2). TD62 RESOLVED 2026-07-15.
**Legal:** DPDP production consent copy + erasure (LEGAL_GATE); real-money payments; admin PII-reveal process cadence.
**Infra:** ✅ **Staging LIVE 2026-07-18** — STAGING-SECRETS-1 cleared, 0042+0043 applied, R27 triaged, real OTP active, B1 owner-attested. **TD81 still open (P1):** ai-service absent from compose → chat/profile-extraction on staging are mocked while `/health` 200s.
**Env/secrets:** staging GitHub Environment provisioned ✅. See [ENV_AND_SECRETS_TRACKER.md](ENV_AND_SECRETS_TRACKER.md).

## ✅ P0 CLEARED 2026-07-18 — alpha now IN PROGRESS

**B1 CLOSED (owner-attested 2026-07-18):** staging live, 0042+0043 applied, R27 triaged, real OTP (Fast2SMS), resume download verified. Cost: 14 days slip.

**Note:** `docs/qa/evidence/staging/` was not written — B1 rests on owner attestation rather than captured artifacts (`/health` output, events-chain export, clean logcat). Not a challenge to the result; capture on next run (cheap).

**Remaining path to full alpha GO (all newly unblocked):**
1. **TD81** — deploy ai-service into staging compose, or make mock LOUD in `/health` (P1; blocks "real profiling proven on staging")
2. Run gate 1 — payer-company click-through on staging
3. Run gate 2 — agency click-through on staging
4. Run gate 4 (OTP-safety half) — wrong-code neutrality, breaker at cap=0, kill-switch, no-phone/no-code log scan
5. Run gate 5 — RBAC + admin ops smoke
6. Capture staging artifacts → `docs/qa/evidence/staging/`
7. All 6 alpha-gate scripts pass with evidence → **Full alpha GO**

---
_Update the cap columns whenever a blocker is cleared; move resolved rows to a "Resolved" section with the clearing evidence + date._
