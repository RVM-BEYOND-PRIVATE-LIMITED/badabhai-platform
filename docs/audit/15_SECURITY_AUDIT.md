# 15 — Security Posture Audit (Platform-Wide)

**Method.** Evidence-based static review of `apps/api`, `apps/ai-service`, `packages/db`,
`packages/config`, `packages/event-schema`, `infra/supabase`, and the compose/CI deploy path.
[`docs/registers/risks-register.md`](../registers/risks-register.md) (36 rows, R1–R36) and
[`docs/payer-agent/SECURITY_AUDIT.md`](../payer-agent/SECURITY_AUDIT.md) (21 findings,
PAY-SEC-01..21) were read first — this document supplements rather than restates them, and
covers what those two don't: worker auth, the admin ops portal, ai-service, RLS platform-wide,
and secrets/CORS/rate-limiting outside the payer scope. Read-only; nothing was changed.

**Result: no Critical or High finding requiring escalation.** Two Medium/Low process-coverage
gaps are new (F1, F2); everything else either confirms an existing risks-register row is
current, or confirms a prior fix has not regressed.

## 1. Authentication

Four independent, isolated session principals, each with its own JWT secret/audience/Redis
namespace — verified no cross-principal token acceptance:

- **Worker**: OTP login (`apps/api/src/auth/otp.service.ts`) → `worker-auth.guard.ts`. Real
  SMS only (Fast2SMS DLT, no mock/console fallback). PIN unlock (device-bound, ADR-0026) —
  `POST /auth/pin/verify` is deliberately unguarded because the refresh token in the body *is*
  the credential (matches R25's design).
- **Payer**: email OTP — fully covered by the payer-agent audit's §6/§8; not re-derived here.
- **Admin**: `admin-auth.guard.ts` — the 4th principal (R24). Bearer JWT, `typ:"admin"`
  audience-pinned, own Redis namespace, 401 fail-closed. Rolling half-life re-mint via
  `x-session-token`, mirroring worker/payer.
- **Internal service-to-service**: `InternalServiceGuard` and the narrower `SkillsInternalGuard`
  both fail closed on an unconfigured secret and use `timingSafeEqual` with a length-mismatch
  short-circuit.

Test-login bypass seams (`test-login.guard.ts`, `payer-test-login.guard.ts`) are env-gated
(default off, refuses to arm outside dev/test/staging) **and** re-check `length >= 32` at
request time even if the boot-time assertion were bypassed — both correctly implement the
TD67 "never arm vacuously on an empty-string secret" lesson.

## 2. Authorization / RBAC

**TD67 (`AI_INTERNAL_TOKEN`) re-verified, CONFIRMED FIXED, no regression.**
`apps/ai-service/app/config.py:379` — `min_length=16` fails Pydantic validation at *startup*
construction, not request time, so the historical "empty token arms the gate vacuously" bug
class cannot recur. Both `docker-compose.yml` and `docker-compose.staging.yml` declare
`AI_INTERNAL_TOKEN` as a valueless pass-through (not `${VAR:-}`), because a `:-` default would
hand the container `""`, which is fatal at boot on both the Zod and Pydantic sides — the same
"declared-empty is not unset" class fixed elsewhere in this codebase, applied correctly here.

**Residual (not new, documented as deliberate)**: with `AI_INTERNAL_TOKEN` unset — the default
in every committed compose file, dev *and* staging — ai-service has zero auth on every route
except `/health`. Contained by exactly one control: the published port is loopback-only
(`"127.0.0.1:8000:8000"` in both compose files), so the gateway is reachable only from the api
container over the compose network. This is a single control with no defense-in-depth if the
deploy topology ever changes (e.g. a future k8s deployment that doesn't preserve loopback-only
binding). See **F3** below.

**F1 (new) — `guard-contract.test.ts` coverage gap extends beyond the payer audit's PAY-SEC-06.**
That audit found 6 payer/agency controllers missing from the "single source of truth" guard
test. Measured platform-wide: **17 of 62** controller files are not imported into that test.
The 6 already named are a subset; **11 are new**, including 4 admin controllers
(`admin-directory`, `admin-entities`, `admin-finance`, `admin-kill-switch`) whose guards were
individually verified correct in code right now — this is a regression-risk finding (no net
catches a future dropped `@UseGuards`), not a live vulnerability. Full list of the 11 new ones:

| Controller | Guards (verified in code) | Sensitivity |
|---|---|---|
| `admin/admin-directory.controller.ts` | `AdminAuthGuard, AdminRolesGuard` | Admin — who holds admin access |
| `admin/admin-entities.controller.ts` | same | Admin — faceless entity reads |
| `admin/admin-finance.controller.ts` | same | Admin — credit ledger/payment orders |
| `admin/admin-kill-switch.controller.ts` | same, `super_admin`-only | Admin — platform kill-switch |
| `auth/devices.controller.ts` | `WorkerAuthGuard` | Worker push-token registration |
| `auth/pin.controller.ts` | Per-route (correct; `verify`/`reset/*` deliberately credential-in-body per R25) | Worker PIN |
| `profiling/profiling.controller.ts` | `WorkerAuthGuard, ConsentGuard` | Worker — LLM-led interview |
| `disclosures/resume-disclosure.controller.ts` | `InternalServiceGuard` | Ops — masked résumé grants |
| `occupation/occupation.controller.ts` | `SkillsInternalGuard` | Internal skills seam |
| `interview-kit/interview-kits.controller.ts` | None — deliberate, PII-free static content, per-IP rate-limited (TD24 precedent) | Benign by design |
| `referrals/referral-resolver.controller.ts` | None — deliberate, public no-oracle redirect, per-IP rate-limited | Benign by design |

Severity **Medium** (the 4 admin controllers are the concerning subset — R24's design calls
for a regression net on the admin surface specifically). **New — not in the risks register or
the payer audit.** Recommend extending PAY-SEC-06's fix to cover these 11 as well.

The most sensitive admin route, `POST /admin/workers/:id/reveal-contact` (R24's "single most
sensitive route in the system") **is** already in the guard-contract test, and its 8 documented
controls (flag-gated default-off, reason-required, audit-before-decrypt, per-admin rate cap,
single-subject, no-oracle) are implemented as documented.

`AdminRolesGuard` is genuinely deny-by-default on every branch (no capability metadata → 403;
missing `req.admin` → 401; unlisted capability → 403). `admin-web`'s client-side capability
check is correctly non-enforcing UX only, derived from the server's `GET /admin/me` response —
it does **not** repeat payer-web's PAY-SEC-02 stub-that-hard-denies bug.

## 3. Secrets handling

`optionalSecret()` (`packages/config/src/server.ts:63-65`) correctly maps the "compose declares
an empty-string default" failure mode to `undefined`. Currently applied to
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` and, per this branch's own recent commit `f2bf373e`,
`ZEPTOMAIL_API_URL/TOKEN/MAIL_AGENT` + `EMAIL_FROM_ADDRESS`. Every other secret-shaped field
uses `.min(N).optional()`/`.min(N).default(DEV_*)` instead, which achieves the same
fail-closed-on-empty-string property by a different mechanism. No field was found that is
neither `optionalSecret`-wrapped nor min-length-guarded.

`.env.example` files (root, ai-service, payer-web) are placeholder-only and explicitly document
which vars are secret vs. safe-to-expose. A repo-wide grep for committed secret-shaped strings
found only Firebase Android API keys in both apps' `google-services.json` — standard practice
for Firebase Android apps (restricted by package name + SHA-1, not secrecy), **Low/informational
(F4)**, not scored as a leak, though GCP-console API restriction was not independently verified.
No secret value found logged anywhere in `apps/api` or `apps/ai-service`.

## 4. CORS

Fails closed platform-wide: dev reflects request origin; outside dev, an explicit allow-list;
empty list → deny all. Never a `*` wildcard. This is `apps/api`-global middleware, so the payer
audit's "correct, fails closed" verdict already covers the whole API surface including worker
routes — not re-scored here.

## 5. Rate limiting

No global throttler — deliberately per-route, Redis-backed, fail-closed on Redis down (429, not
uncapped). Confirmed caps: worker OTP (hourly + daily + platform-wide kill-switch), admin auth
and PII-reveal, resume/interview-kit/photo/referral-click. Payer/agency-side gaps (money routes,
chat) are already fully catalogued in the payer audit's PAY-SEC-07 — cited, not re-derived.

## 6. AI privacy / pseudonymization boundary

**Single enforced gateway, confirmed.** Every ai-service router that constructs an LLM prompt
calls `pseudonymize()` before any provider call and checks `.blocked` — verified across every
router with an LLM path. No router reaches a provider client with unpseudonymized text.
`pseudonymize()` fails closed on non-string input, oversize input (>20,000 chars), any
exception, and a residual-long-digit-run safety net. The original↔token mapping is
function-local, never persisted or returned.

Known heuristic gaps (**R2**, regex/gazetteer nature; **R30**, separator/word-split phone
bypass; **R32**, uncued own-name leak) are all already tracked in the risks register, all
**ACCEPTED AT LAUNCH by a signed 2026-08-01/2026-08-12 owner ruling**, all still **NOT FIXED**,
gated only by `AI_REAL_CALLS_KILL_SWITCH`. This audit re-verified the ruling is present and
current — no drift found.

`/voice/transcribe` correctly returns raw worker PII in its own response by design (the worker
needs their own words back) — this must never be relayed further downstream unmasked; nothing
found that does so.

## 7. RLS

Measured platform-wide (not just the payer audit's 64-table subset): all **65** Drizzle-defined
tables have a matching `ENABLE ROW LEVEL SECURITY` migration statement — zero gaps.
**`CREATE POLICY` count remains 0** platform-wide. This confirms **R1** is accurate and current:
ENABLE+FORCE+REVOKE is a Data-API lockout (a leaked `anon`/`service_role` key exposes nothing),
not per-tenant row filtering — the application role (documented BYPASSRLS requirement) is the
only enforcement layer. Not a new finding.

## 8. Payment / payout flows

`PAYMENTS_ENABLE_REAL`, `AGENCY_PAYOUTS_ENABLED`, `MESSAGING_ENABLE_REAL`, `PUSH_ENABLE_REAL`,
`AI_ENABLE_REAL_CALLS` are all boolean, default false. None of the five are wired through the
CI secrets bridge or set in the staging compose file — they can only be armed by a direct
box-env action, never by a deploy. Confirms **R17** (payments mock-only) and the agency-payout
gate remain unarmed and are not newly exposed by anything on this branch.

## 9. Admin / internal endpoint exposure

Every `InternalServiceGuard`/`SkillsInternalGuard`-protected route (26 controllers) fails
closed on an unconfigured secret; every `AdminAuthGuard`/`AdminRolesGuard`-protected route is
deny-by-default on missing capability metadata. The two deliberately-public routes found
(`interview-kits`, `referral-resolver`) are PII-free by construction and rate-limited, matching
the R36 precedent. No unauthenticated route carrying PII or a business-mutating write was found
beyond what R22/R23/R36 already track.

## Findings summary

| # | Finding | Severity | Status |
|---|---|---|---|
| F1 | `guard-contract.test.ts` omits 17 of 62 controllers (11 beyond PAY-SEC-06's 6, incl. 4 admin controllers) — all correctly guarded today, no regression net | Medium | **New** — recommend a risks-register row or extending PAY-SEC-06's remediation |
| F2 | `docs/legal-later` (cited by R4 and `.claude/agents/system-architect.md` as where DPDP legal-copy placeholders live) does not exist in the repo | Low–Medium | **New** — same dead-doc class as R2/R30/R32's already-broken `docs/ai/pseudonymization.md` link; R4's "structural placeholder" claim currently has no reviewable artifact |
| F3 | ai-service has zero auth by default in every environment (dev + staging), contained only by loopback-only port bind | Informational | Confirmed-not-regressed; deliberate + documented; loosely related to R27 |
| F4 | Firebase Android API key committed in both `google-services.json` files | Low/informational | Standard practice; GCP-side API restriction not independently verified |

No Critical or High finding. Every other area checked (RLS, CORS, payments/payout gating, TD67,
the pseudonymization boundary) **confirms an existing risks-register row is current** — see
[24_RISK_REGISTER.md](24_RISK_REGISTER.md) for the reconciled register including F1/F2 as new
entries.
