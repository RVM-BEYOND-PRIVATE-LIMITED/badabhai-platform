# Blockers

Classification: **P0** blocks alpha/runtime proof · **P1** blocks an important flow (workaround exists) ·
**P2** quality (can ship alpha with a note) · **P3** polish/future.
**Never mark a P0 done without proof.**

## Progress-cap impact

| Blocker | Type | Sev | Blocks | Task progress now | Max until resolved | Owner | Decision needed? |
| ------- | ---- | --- | ------ | ----------------: | -----------------: | ----- | ---------------- |
| **Staging not deployed — PAST 2026-07-04 deadline** (no `API_BASE_URL`; no `/health` proof) | Infra | **P0 CRITICAL** | Worker-app B1 handset run; all staging proof; alpha gate | Alpha 58% | 90% | Prakash | No — D1✅ decided; execution missing |
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
**Infra:** **staging not deployed (P0 CRITICAL — PAST deadline 2026-07-04, +14 days)**. CD pipeline EXISTS and is GREEN (CD-0..CD-5). Sole remaining gate = STAGING-SECRETS-1 (real secrets into GitHub `staging` Environment). R27 box: was running dev secrets + throwaway Postgres — treat all sessions/PII as compromised; triage before new deploy.
**Env/secrets:** staging GitHub Environment real secrets NOT set (STAGING-SECRETS-1); must include `CORS_ALLOWED_ORIGINS` (TD72a — omitting silently blocks every browser call while `/health` reports healthy). See [ENV_AND_SECRETS_TRACKER.md](ENV_AND_SECRETS_TRACKER.md).

## P0 — single alpha gate · Deadline: **SLIPPED — was 2026-07-04, +14 days. Re-forecast: B1 ~07-21/22 if SECRETS-1 lands 07-18**

**D1 DECIDED (2026-06-29): AWS Lightsail/EC2. CD pipeline BUILT and VERIFIED GREEN (CD-0..CD-5). P0 narrowed from "no pipeline" to "no secrets".**

> ⚠️ **OTP is REAL-ONLY** (`SMS_PROVIDER: z.literal("fast2sms")` — `console` fails boot). Staging requires **Fast2SMS creds** before anyone can log in. **45 migrations** (0000–0044) — **apply 0042 + 0043 BEFORE deploy** (0042 breaks extraction INSERTs; 0043 breaks every credit purchase). The staging smoke script was rewritten (#391, D-3 gated test-login with synthetic `+9100000XXXXX` phones).

> ⚠️ **Two things will make staging lie even after green:** (1) **TD81** — ai-service is NOT in the compose file; staging degrades to mocked AI while `/health` 200s; (2) **R30** — word-split phone bypasses pseudonymize (honest negative, gates `AI_ENABLE_REAL_CALLS`).

**Remaining critical path (strictly ordered — steps 1–3 are owner-only, non-delegable):**
1. Prakash: **STAGING-SECRETS-1** — real secrets into GitHub `staging` Environment (generated fresh, NEVER from `.env`). **Include `CORS_ALLOWED_ORIGINS`** (TD72a). ~half a day.
2. Prakash: Apply migration **0042** then **0043** — both apply-before-deploy.
3. Prakash: Triage the R27 box — stop dev-secret API + throwaway Postgres; decide volume fate.
4. Deploy → `/health` 200 (connectivity gate only — an unmigrated DB still 200s, hence step 2 first). Set `RESUME_RENDER_ENABLED=true` + WeasyPrint; decide `PAYER_LOGIN_METHOD`.
5. **OTP-7** — Fast2SMS creds + team allowlist. No mock path exists — without this nobody can log in.
6. Rishi: REAL-mode handset build against staging → onboarding→chat→profile→PDF → 4 evidence artifacts to `docs/qa/evidence/staging/`.
7. All 6 alpha-gate scripts in [TEST_MATRIX.md](TEST_MATRIX.md) pass with evidence → B1 CLOSED.

---
_Update the cap columns whenever a blocker is cleared; move resolved rows to a "Resolved" section with the clearing evidence + date._
