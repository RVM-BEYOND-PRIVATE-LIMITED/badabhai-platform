# Proposal — test-mode session-mint seam for HTTP e2e (ESCALATION: touches auth posture)

> Status: PROPOSAL — needs Prakash sign-off (auth-posture change, CLAUDE.md §7). Nothing here is built.

## The single root cause
Every principal's login is now REAL-ONLY: worker OTP = Fast2SMS SMS (dev echo removed, d2f228e),
payer login = ZeptoMail email OTP, admin login = email code + MFA. No test can complete a login
over HTTP, so these suites are hard-`describe.skip`: **contact-unlock, payer-tenancy,
payer-capacity, swipe-to-apply, phase1-flow** (+ phase1-onboarding's `it.skip`), and the D5
wishlist (unlock payer-isolation, org/team, agency, admin smoke) is equally blocked. The
`tests/e2e/helpers/payer-session.ts` helper still assumes a `dev_otp` echo that no longer exists.
In-process authz unit tests exist for all of these; the GAP is strictly the HTTP/guard/session layer.

## Options
**A (recommended) — gated test-mint endpoint.** `POST /test/sessions` guarded by
`TEST_SESSION_MINT_ENABLED` (default **false**, `booleanFromString` fail-safe) **AND**
`assertAuthConfig`-style boot guard: **refuses to boot with the flag on when `NODE_ENV=production`**
(mirrors the dev-JWT/PIN-pepper fail-closed pattern). Body `{ principal: worker|payer|admin, ... }`,
mints a real session via the existing SessionService paths (so tiers/refresh/device binding stay
exercised). Registered only when the flag is on (conditional module import — no dormant route in prod).
**B — OTP test-code seam.** A configured `OTP_TEST_CODE` accepted only when flag on + non-prod;
exercises MORE of the login path (issue/verify) but weakens the "real-only" invariant everywhere.
**C — status quo.** HTTP e2e stays skipped; coverage remains the manual OTP-7 staging runbook.

Recommendation: **A** — smallest surface, boot-fail-closed, keeps the real-only login untouched.

## What sign-off unlocks (in order)
1. Un-skip the 5 hard-skipped suites + fix `payer-session.ts` to use the seam.
2. New HTTP suites: unlock payer-isolation (payer-A ≠ payer-B over HTTP), org/team, agency, admin smoke.
3. API→ai-service cross-service e2e (also needs CI to start uvicorn — see below).

## Follow-up scope (D4c): staging e2e CI job — separate work item
No staging e2e workflow exists. Scope: a `staging-e2e.yml` on `workflow_dispatch` + nightly cron;
env = staging URL + staging secrets (GitHub environment w/ approval); runs the RUN_E2E suite against
staging with the seam flag ON (staging only, never prod); artifacts = junit + API logs. Depends on
the seam decision above. Estimated: 1 PR (workflow + docs), no app code.

## Also in-scope when the seam lands: e2e job starts ai-service
CI intentionally doesn't start FastAPI today (ci.yml:94-95 — API falls back to mock). The
cross-service assertion (extraction round-trip + pseudonymization fail-closed over HTTP) needs
uvicorn in the e2e job + `AI_SERVICE_URL` env. Keep `AI_ENABLE_REAL_CALLS=false` (mock LLM) — the
test asserts the TRANSPORT + pseudonymization boundary, not a real model.
