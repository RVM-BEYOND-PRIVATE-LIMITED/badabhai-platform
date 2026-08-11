# Testing, CI, Local Dev & Production Readiness

**Status:** COMPLETE (audited 2026-08-11, dimension re-run after the usage-limit interruption).
**Method:** evidence-based static analysis; every claim carries a `file:line` citation.
**Findings feed** `GAP_REGISTER.md`. Coverage caveats: `AUDIT_STATUS.md`.

---

# Testing, CI, Local Development, and Production Readiness — payer-web (Company + Agency personas) and its apps/api payer/agency surface

## Executive summary
The payer/agency surface is heavily unit-tested and structurally untested. Below the seam the numbers are strong: 102 colocated test files across `apps/api/src/{payer-portal,payers,agency,unlocks,match,referrals,job-postings,pricing,posting-plans,disclosures,reach,messaging}` carrying ~1,330 `it()` cases, plus 83 payer-web test files carrying 875 `it()` cases. Above the seam there is nothing: zero HTTP requests are made against `/payer/*` or `/payer/agency/*` by any test that runs, in CI or locally. All four payer-touching e2e suites are hard `describe.skip` (`payer-tenancy.e2e.test.ts:93`, `payer-capacity.e2e.test.ts:106`, `phase1-flow.e2e.test.ts:70`, `swipe-to-apply.e2e.test.ts:80`) and `contact-unlock.e2e.test.ts:155` is gated behind `E2E_UNLOCK_SUITE`, which `ci.yml` never sets. The stated blocker is real and verified: the `dev_otp` echo exists nowhere in `apps/api/src` (one comment, zero code), so `tests/e2e/helpers/payer-session.ts:96` is dead — it asserts on a field the API no longer returns — and `POST /auth/test-login` (`apps/api/src/auth/auth.controller.ts:138`) is worker-only. There is no payer test-login seam, and `referral-round-trip.e2e.test.ts:29` names that absence as the reason a whole test leg was abandoned. Not one browser test exists anywhere in the repo (`@playwright/test` appears only as Next's optional peer at `pnpm-lock.yaml:2828`), and payer-web's `.tsx` tests walk the React element tree rather than rendering, explicitly catching and skipping hook-using client components (`credits/page.test.tsx:105-112`) — so no `"use client"` handler is ever executed. The tests do assert behaviour rather than source text (only 7 of 83 files use `readFileSync`, ~17 of 875 cases), but they assert it against mocks that encode the current bugs: `org-roles.test.ts:99-107` asserts the STUB comment is present, and `credits/page.test.tsx:37` mocks `requireOwner` to admit — so the suite is green while `/credits` and `/team` 404 for every real user. On CI: `ci-required` is the only required check on `main` (verified via the branch-protection API), the `node` job has no path filter so payer-web is linted/typechecked/unit-tested/`next build`-ed, and the `e2e` job's path filter (`ci.yml:41-53`) omits `apps/payer-web` entirely — a payer-web-only PR can go green with no behavioural gate. security-scan and supabase-checks are 100% advisory (`continue-on-error` on every job), gitleaks is schedule-only, and neither workflow is in `ci-required`. payer-web is built by no packaging step and deployed by no workflow: there is no Dockerfile, no `vercel.json`, no compose service, no reference in `staging-cd.yml` (which explicitly skips the Next apps) — it has no path to production at all. Locally the documented recipe (`README.md:101-103`, `cp .env.example .env`) boots the API but leaves payer login impossible: `EMAIL_PROVIDER=zeptomail` with placeholder credentials satisfies the boot presence check and then fails at send time, and every OTP is rolled back. A working path does exist — Mailpit is wired in `docker-compose.yml` (`pnpm mail:up`, ports 1025/8025) and `EmailNotificationService.sendViaSmtp` (`email-notification.service.ts:220-250`) is the real production transport — but it is documented nowhere, and `README.md:127-158` does not mention payer-web or port 3002 at all. Production readiness has one hard blocker beyond hosting: migrations are still not applied by the deploy pipeline (`ci.yml:907-916`, CD-2 held), and `/health` checks connectivity only, so a deploy against an unmigrated database boots green and 500s on every real endpoint. Every ops runbook the deploy path cites — `docs/rollback-guide.md`, `docs/ops/staging-service-deploy-runbook.md`, `docs/ops/otp-real-send-staging-runbook.md`, `docs/observability-runbook.md` — is absent from `main`. There is no backup tooling, no metrics, no alerting, and no log destination beyond stdout.

> Audit dimension: **Testing · CI · Local Development · Production Readiness** for the payer/agency surface.
> Scope: `apps/payer-web` (both personas), `apps/api/src/{payer-portal,payers,agency,unlocks,match,referrals,job-postings,pricing,posting-plans,disclosures}`, `tests/e2e`, `.github/workflows`, `docker-compose*.yml`, `packages/config/src/server.ts`.
> Every claim below was read from the file cited. Nothing was inferred from a name.

---

# 1. TESTING

## 1.1 Inventory — what exists, by test kind

### 1.1.1 `apps/api` payer/agency test census (measured)

| Directory | Test files | `it()` cases |
|---|---:|---:|
| `apps/api/src/payer-portal` | 16 | 148 |
| `apps/api/src/payers` | 10 | 90 |
| `apps/api/src/agency` | 13 | 171 |
| `apps/api/src/unlocks` | 13 | 192 |
| `apps/api/src/match` | 17 | 314 |
| `apps/api/src/referrals` | 11 | 134 |
| `apps/api/src/posting-plans` | 4 | 71 |
| `apps/api/src/reach` | 6 | 72 |
| `apps/api/src/job-postings` | 2 | 65 |
| `apps/api/src/messaging` | 6 | 39 |
| `apps/api/src/disclosures` | 2 | 24 |
| `apps/api/src/pricing` | 2 | 10 |
| **Payer/agency subtotal** | **102** | **1,330** |
| Whole `apps/api` | 278 | — |

### 1.1.2 What those tests actually are

There are **five** kinds in this repo, and the payer surface uses four of them. It uses none of the fifth.

| Kind | Present? | Representative evidence | What it proves / cannot prove |
|---|---|---|---|
| **(i) Handler/controller-level** | Yes, but **direct instantiation, not HTTP** | `payer-unlocks.controller.test.ts:51` — `new PayerUnlocksController(unlocks as never, disclosureRate as never)` | Proves handler logic and that no client `payer_id` is trusted. Does **not** exercise routing, guards, `ZodValidationPipe`, interceptors, filters, or serialization. |
| **(ii) Service unit tests, mocked repos** | Yes, dominant | `agency.service.test.ts`, `payer-org-members.service.test.ts`, `unlocks.service.test.ts`, `agency-payout.service.test.ts` | Business rules against fakes. A SQL/`ON CONFLICT`/`ORDER BY` claim can only be shown as *present*, never *evaluated*. |
| **(iii) SSR render smoke (payer-web)** | Yes, 41 `.tsx` files | `credits/page.test.tsx:126-129` — `const tree = (await CreditsPage()) as ReactElement; collect(tree)` | Walks the returned element tree. Only 2 of 83 files use `renderToStaticMarkup` (`components/ds/display-link.test.tsx:2`, `ds.stories.test.tsx:4`). |
| **(iv) Source-text / static guards** | Yes, small | `unlocks-static-guards.test.ts:39-45` (sole-writer + single-decrypt scans); `payer-api.test.ts:962-988`; `org-roles.test.ts:99-107` | Author-time conventions. 7 of 83 payer-web files read source; ≈17 of 875 cases. |
| **(v) Metadata authz-contract** | Yes | `apps/api/src/common/guard-contract.test.ts` (530 lines); `agency-role-authz.test.ts:36-62` | Proves `@UseGuards`/`@PayerRoles` metadata is attached to the classes it lists. Does not prove Nest *invokes* them on a request. |
| **HTTP/integration (supertest or `Test.createTestingModule`)** | **NO — none, anywhere** | `grep supertest apps/api/src` → 0 hits. 6 files mention `Test.createTestingModule` and **all six say they cannot use it** (`app.module.graph.test.ts:22`: "this repo's vitest does not emit `design:paramtypes`") | — |

### 1.1.3 payer-web test census (measured)

| Metric | Value |
|---|---|
| Test files | 83 (41 `.tsx`, 42 `.ts`) |
| `it()` cases | 875 |
| Files reading their own source (`readFileSync`) | 7 — `payer-api.test.ts`, `auth/org-roles.test.ts`, `app/assetlinks.test.ts`, `lib/assetlinks.test.ts`, `ink-parity.test.tsx`, `ds.stories.test.tsx`, `agency-b5-layout.css.test.ts` |
| Approx. source-text `it()` cases | ~17 (≈**2%**) |
| Coverage thresholds | **none** — `apps/payer-web/vitest.config.ts` has no `coverage` block at all |
| Test environment | `environment: "node"` (`vitest.config.ts:9`) — no DOM |

**Verdict on "do they assert behaviour or source text?": behaviour, overwhelmingly.** The premise that these are source-text tests is wrong and should be corrected in any downstream register. `payer-api.test.ts` (988 lines, 37 cases) stubs global `fetch` and asserts the *outbound request body* and the *mapped response* — e.g. `payer-api.test.ts:118` `expect(JSON.stringify(body)).not.toMatch(/payer_id/)`, `:146` `expect(JSON.stringify(res)).not.toMatch(/\+?\d{7,}/)`, `:562` posting lifecycle drops `orgLabel`/`description`. `team/actions.test.ts` (97 lines) drives the real Server Actions with the auth gate and seam mocked and asserts the neutral-404 throw, the validation rejection, and the forwarded payload. `credits/actions.test.ts` is 293 lines of the same shape.

**But the mocks encode the bugs.** Two measured examples:
- `credits/page.test.tsx:36-38` mocks `requireOwner` and defaults it to **admit**. Every one of that file's ~20 cases passes. In production `getOrgRole()` hard-returns `"recruiter"` (`lib/auth/org-roles.ts:46-56`) so `requireOwner()` calls `notFound()` and the page is a 404 for every real user. The test suite cannot see this by construction.
- `lib/auth/org-roles.test.ts:99-107` is a `describe` block titled *"org-role seam carries the wire-to-Divyanshu STUB TODO (source)"* that asserts `/STUB/`, `/Divyanshu/`, `/XB-A/` appear in `org-roles.ts`. The test **requires the stub to stay**. Fixing the P0 breaks this test.

### 1.1.4 Source files with **no** colocated test (payer/agency)

| File | Guarded? | Note |
|---|---|---|
| `apps/api/src/agency/agency-invites.controller.ts` | `@UseGuards(PayerAuthGuard)` + `@PayerRoles('agent')` | Partly covered indirectly by `agency-role-authz.test.ts` + `agency-invites-batch.test.ts` |
| `apps/api/src/agency/agency-jobs.controller.ts` | same | same |
| `apps/api/src/agency/agency-workers.controller.ts` | same | service is tested; controller is not |
| `apps/api/src/agency/agency-invites.repository.ts` | n/a | no test |
| `apps/api/src/agency/agency-jobs.repository.ts` | n/a | no test |
| `apps/api/src/agency/agency-workers.repository.ts` | n/a | no test |
| `apps/api/src/agency/agency-payout.repository.ts` | n/a | money ledger writer, no test |
| `apps/api/src/disclosures/resume-disclosure.controller.ts` | `InternalServiceGuard` (`:28`) | no test |
| `apps/api/src/disclosures/resume-disclosure.repository.ts` | n/a | no test |
| `apps/api/src/payer-portal/job-posting-chat/job-posting-chat.repository.ts` | n/a | no test |

### 1.1.5 The authz contract has a hole

`apps/api/src/common/guard-contract.test.ts` is the repo's single source of truth for "which guards protect every route" (`:52-61`). It imports **50** controllers. There are **62** `*.controller.ts` files on disk. It has **no completeness assertion** — the only structural check (`:479-487`) verifies that every *listed* route names a real handler, never that every controller is listed.

Payer/agency controllers **absent from the contract** (all verified to carry guards today, so this is a regression-net gap, not a live hole):

| Controller | Route base | Guards actually applied |
|---|---|---|
| `payer-portal/payer-job-postings.controller.ts` | `payer/job-postings` (`:65`) | `PayerAuthGuard` (`:66`) — **the core posting CRUD** |
| `payer-portal/payer-org-members.controller.ts` | `payer/org/members` (`:33`) | `PayerAuthGuard, PayerOrgRoleGuard` (`:34`) + `@OrgRoles("owner")` (`:46`, `:59`) |
| `payer-portal/payer-org-invites.controller.ts` | `payer/org/invites` (`:17`) | `PayerAuthGuard` (`:18`) |
| `payer-portal/payer-disclosure.controller.ts` | `payer/resume-disclosures` (`:36`) | `PayerAuthGuard` (`:37`) |
| `payer-portal/job-posting-chat/job-posting-chat.controller.ts` | `payer/job-posting-chat` (`:38`) | `PayerAuthGuard` (`:39`) |
| `payers/payer-account.controller.ts` | `payer` — `GET/PATCH /payer/me` (`:18`) | `PayerAuthGuard` (`:19`) |
| `disclosures/resume-disclosure.controller.ts` | root (`:27`) | `InternalServiceGuard` (`:28`) |

Deleting `@UseGuards` from any of these seven ships silently green.

## 1.2 Critical payer/agency workflows with ZERO coverage of any kind

| # | Workflow | Coverage today |
|---|---|---|
| W1 | **Signup → email OTP → session mint → cookie set → portal renders** | None end-to-end. `payer-auth.service.test.ts` mocks the channel; `login/actions.test.ts` mocks the seam. No test ever produces a real `bb_payer_token`. |
| W2 | **The complete unlock money loop over `/payer/*`** (credits → `POST /payer/unlocks` → debit → `POST /payer/unlocks/:id/reveal` → relay handle) | None. `contact-unlock.e2e.test.ts` exercises the **ops** `/unlocks` + `/payers/:id/credits` (`InternalServiceGuard`) routes only — see `:185`, `:200`, `:239` — and is skipped in CI regardless. |
| W3 | **Cross-payer tenancy over HTTP** (payer A cannot read payer B) | `payer-tenancy.e2e.test.ts` exists and is exactly this test. `describe.skip` at `:93`. Only `payer-scope.test.ts` (unit, fake db) survives. |
| W4 | **Capacity enforcement in the enforced posture** (advisory-lock atomicity) | `payer-capacity.e2e.test.ts:142-238` — `describe.skip` at `:106`. The file's own header (`:16-22`) says the unit suite mocks `lockPayer`, so the race is *only* verifiable here. |
| W5 | **Razorpay real checkout** (order → browser → verify → credit) | Signature/webhook units exist (`razorpay-signature.test.ts`, `razorpay-webhook.controller.test.ts`). The browser leg (`credits/razorpay-checkout.test.ts`) never runs a browser. No end-to-end. |
| W6 | **Org invite → email → accept-link → member activation** | `payer-org-invites.controller.test.ts` + `member-invite.mailer.test.ts` are unit-only. The single-use token round trip is never driven. |
| W7 | **Agency invite mint → QR/WhatsApp share → `/i/:code` landing → attribution** | `referral-round-trip.e2e.test.ts:26-40` **explicitly abandons the mint leg**: "minting an agent session needs a payer login, the `dev_otp` echo is gone, and there is no payer equivalent of `/auth/test-login`". It seeds a synthetic code and starts at the click. |
| W8 | **Agency KYC → payout request → ledger** | Unit only (`agency-kyc.service.test.ts`, `agency-payout.service.test.ts`); `AGENCY_PAYOUTS_ENABLED` is off by default so the surface is inert anyway. |
| W9 | **Any client-side interaction in payer-web** — form submit, `useState`, `onClick`, theme toggle, Razorpay script | **Structurally impossible today.** See §1.4. |
| W10 | **`/credits` and `/team` reachability for a real user** | Never tested with the real `getOrgRole`; the gate is mocked open. |

## 1.3 Is there ANY real HTTP request against the payer surface? — No. Confirmed.

`grep '/payer/' tests/e2e/*.ts`, excluding the two hard-skipped payer suites, returns exactly **one hit** and it is a comment (`referral-round-trip.e2e.test.ts:27`).

**Suite-by-suite gate status** (`RUN_E2E=1` is set at `ci.yml:321`):

| Suite | Gate | Runs in CI? | Touches `/payer/*`? |
|---|---|---|---|
| `payer-tenancy.e2e.test.ts` | `describe.skip` (`:93`) | No | Yes (dead) |
| `payer-capacity.e2e.test.ts` | `describe.skip` (`:106`) | No | Yes (dead) |
| `phase1-flow.e2e.test.ts` | `describe.skip` (`:70`) | No | No |
| `swipe-to-apply.e2e.test.ts` | `describe.skip` (`:80`) | No | No |
| `contact-unlock.e2e.test.ts` | `skipIf(!RUN_UNLOCK)`, `RUN_UNLOCK = RUN && E2E_UNLOCK_SUITE === "1"` (`:155`) | **No** — `E2E_UNLOCK_SUITE` is set nowhere in `ci.yml` | ops routes only |
| `phase1-onboarding.e2e.test.ts` | `skipIf(!RUN)` (`:126`) but its one real case is `it.skip` (`:142`) | Shell runs, body skipped | No |
| `events-idempotency`, `profile-idempotency`, `profiling-voice-spine`, `referral-round-trip`, `resume-signed-url`, `rls-spine` | `skipIf(!RUN)` | Yes | No |

**Stated blockers, verified:**

1. **The `dev_otp` echo is gone.** `grep dev_otp apps/api/src` returns exactly one hit and it is a comment (`payer-auth.service.test.ts:99`: "Real-only: the response is the neutral `{ status, resend_in_seconds }` only — no dev_otp echo"). `payer-tenancy.e2e.test.ts:86-92` states the reason directly. `SMS_PROVIDER` is `z.literal("fast2sms")` (`packages/config/src/server.ts:409`) so no mock value even parses.
2. **`tests/e2e/helpers/payer-session.ts` is dead code.** Line 96 reads `signup.json?.dev_otp` and lines 97-100 assert it is truthy. That field no longer exists on any response. The helper's own docstring (`:77-79`) still claims the API "echoes the one-time code back as `dev_otp`". No running suite imports it — only `payer-capacity` and `payer-tenancy`, both skipped.
3. **`POST /auth/test-login` is worker-only.** `apps/api/src/auth/auth.controller.ts:138`, gated by `TestLoginGuard` (`auth/test-login.guard.ts`), fail-closed in `assertAuthConfig` (`server.ts:1475-1489`: refuses to boot outside `development|test|staging`, refuses without a ≥32-char token). It mints a **worker** session for a phone in the reserved `+9100000XXXXX` range. `tests/e2e/README.md` states this plainly: *"`tests/e2e/helpers/payer-session.ts` is a **separate** gap: it mints a PAYER session and still assumes a payer `dev_otp` echo; the D-3 seam is worker-only and does not unblock it."*
4. **A second, deeper blocker exists for the unlock suite (TD129).** `contact-unlock.e2e.test.ts:130-154` documents it from a measured CI run: after the OTP blocker was routed around, 6 of 8 tests failed with `permission denied for table workers` / `for table events` — migration 0004 `FORCE RLS` + `REVOKE ALL` locks those tables and the e2e API role cannot read them. That is a security-boundary decision, not a test fix.

## 1.4 Browser / E2E tests for payer-web — none, confirmed

- `grep -r "playwright|cypress|@testing-library|jsdom|happy-dom|puppeteer" **/package.json` → **0 hits**.
- `pnpm-lock.yaml:2828` is the only `@playwright/test` mention and it is `next@15.5.19`'s **optional peer dependency** — not installed.
- `apps/payer-web/vitest.config.ts:9` pins `environment: "node"`. There is no DOM.

**Consequence, precisely.** `credits/page.test.tsx:100-121` shows the mechanism: the walker expands function components one level, and

```
if (typeof el.type === "function") {
  try { rendered = Fn(el.props); }
  catch { rendered = el.props && "children" in el.props ? el.props.children : null; }
```

with the comment *"A hook-using client child (CreditsPanel) throws outside React → fall back to walking its children prop."* So every `"use client"` component's body is **caught and skipped**. Nothing verifies that a button submits, that a form posts to the right Server Action, that the Razorpay checkout script loads, that an error state renders after a failed action, or that the theme toggle writes its cookie. `apps/payer-web/src/components/unlock/unlock-ux.test.tsx`, `login/login-form.test.tsx`, `team/team-manager.test.tsx` and the other interactive-component tests all run under this constraint.

## 1.5 Proposed TEST MATRIX — the minimum to call the payer + agency surface verified

### Tier 0 — the harness (nothing else is buildable without it)

| ID | Item | Where | Status | Detail |
|---|---|---|---|---|
| **H1** | **Payer test-login seam** — `POST /payer/test-login`, mirroring `apps/api/src/auth/test-login.guard.ts` | new, in `apps/api/src/payer-portal/` | **DOES NOT EXIST** | Must mint a real `PayerSessionService` session (signed JWT **plus** the `payer_session:<sid>` Redis record — `payer-session.ts:9-11` warns a hand-rolled JWT is rejected by `PayerAuthGuard.validateAndTouch`). Reuse the exact D-3 posture: neutral 404 while `PAYER_TEST_LOGIN_ENABLED` is off, neutral 401 on a wrong `x-test-login-token`, `assertPayerAuthConfig` refusal to boot outside `development|test|staging` or with a <32-char token, a `TEST_LOGIN_MAX_PER_DAY`-style daily cap, and a **reserved synthetic email domain** (the payer analogue of `+9100000XXXXX` — e.g. only `*@e2e.badabhai.invalid` is mintable) so the seam can never mint a session for a real payer. Should accept `role: employer\|agent` and `org_role: owner\|recruiter` so agency and org-RBAC suites can both use it. **This is a CLAUDE.md §7 / owner decision; `tests/e2e/README.md` already records it as "the open §7 decision".** |
| **H2** | Rewrite `tests/e2e/helpers/payer-session.ts` onto H1 | `tests/e2e/helpers/payer-session.ts:81-113` | dead today | Drop the `dev_otp` assertion; one call. |
| **H3** | Grant the e2e API role read access to the locked `workers`/`events` spine, **or** move the payer suites to fixtures that avoid them | migration 0004 posture / `ci.yml` e2e job | TD129, open | Without this, un-skipping `contact-unlock` only re-creates red (`contact-unlock.e2e.test.ts:132-140`). |
| **H4** | Add `@playwright/test` + one project targeting `http://localhost:3002` | new `apps/payer-web/playwright.config.ts` | absent | Chromium-only is enough for alpha. |
| **H5** | Add a `coverage` block with thresholds to `apps/payer-web/vitest.config.ts` | file has none | absent | Baseline at the measured number, never below. |

### Tier 1 — API integration (real Nest HTTP, no browser)

Run against the `ci.yml` e2e job's migrated Postgres + Redis with the API process started, exactly like the existing `e2e` step (`ci.yml:572-596`).

| ID | Test | Asserts |
|---|---|---|
| **A1** | Un-skip `payer-tenancy.e2e.test.ts` on H1/H2 | Payer A cannot list/read/reveal payer B's unlocks; denial bodies are byte-identical to the not-found case (no oracle); the PII key sweep at `:38-46` holds |
| **A2** | Un-skip `payer-capacity.e2e.test.ts`, both postures | Advisory-lock atomicity under M>N concurrent `buyPlan`; pause-at-limit; oldest-paid-first auto-resume; shadow-mode default |
| **A3** | Posting CRUD over HTTP — `POST/GET/PATCH /payer/job-postings`, `/close`, `/pause`, `/resume`, `/quota-topup` | `PayerAuthGuard` fires; `ZodValidationPipe` rejects a body `payer_id`; another payer's posting id returns a neutral 404, never 403 |
| **A4** | Vertical authz over HTTP | An `employer` Bearer on every `/payer/agency/*` route → 403; an `agent` Bearer → 200. Today only the metadata is checked (`agency-role-authz.test.ts`), never the wire |
| **A5** | Org-RBAC over HTTP | A `recruiter` session on `POST /payer/org/members` → 403 via `PayerOrgRoleGuard`; an `owner` → 201. Also: a payer with no active membership → 403 (`payer-org-role.guard.ts:82`) |
| **A6** | Full unlock money loop over `/payer/*` | credits → request → debit → reveal returns a routed relay handle and **never** a phone; double-reveal is idempotent; insufficient balance is a neutral deny |
| **A7** | Org invite round trip | mint → single-use token → `acceptOrgInvite` → member active; replay of the same token → rejected; `MEMBER_INVITE_MAX_PER_ORG` enforced |
| **A8** | Rate-limit fail-closed proofs | `PAYER_DISCLOSURE_MAX_PER_HOUR`, `PAYER_REACH_MAX_PER_HOUR`, `AGENCY_INVITE_MINT_MAX_PER_HOUR`, `PAYER_AUTH_MAX_PER_IP_PER_HOUR` — each caps, and each **denies** (never uncaps) when Redis is unreachable |
| **A9** | Signup → OTP → session, with Mailpit as the transport | `EMAIL_PROVIDER=smtp` pointed at Mailpit; read the code from the Mailpit REST API (`http://localhost:8025/api/v1/messages`); complete `login/verify`. **This is the only design that tests the real production email code path** rather than a double |

### Tier 2 — payer-web unit/SSR (extend what exists)

| ID | Test | Asserts |
|---|---|---|
| **U1** | `getOrgRole` against a **real** session carrying an org-role claim | Replaces the STUB-comment assertion at `org-roles.test.ts:99-107`, which must be deleted, not adapted |
| **U2** | `/credits` and `/team` with the **unmocked** `requireOwner` | An owner renders; a recruiter 404s. Today `credits/page.test.tsx:37` mocks the gate open |
| **U3** | Zod parity: every payer-web wire schema vs its `apps/api` DTO | `payerMeWireSchema` ↔ `PayerMeSchema` (`payer-account.dto.ts:17`) — the docstring at `:15` claims parity; nothing enforces it |
| **U4** | `payer-http.ts` failure modes | 401 → session cleared and redirect; 5xx → the retry/error boundary; malformed JSON → fail closed, never a partial render |

### Tier 3 — browser E2E (Playwright, on H4)

| ID | Journey |
|---|---|
| **E1** | Employer: sign up → OTP from Mailpit → dashboard → create posting → applicant feed → unlock → reveal |
| **E2** | Agency: sign up as `agent` → agency dashboard → mint invite → QR/WhatsApp share → `/i/:code` landing |
| **E3** | Org-RBAC in the browser: an owner sees `/credits` + `/team`; a recruiter gets 404 on both **and the nav omits them** |
| **E4** | Credits mock top-up: balance increments, ledger row renders, low-balance nudge appears below threshold |
| **E5** | Session lifecycle: logout clears `bb_payer_token`; an expired token redirects to `/login` |
| **E6** | Accessibility + theme: light/dark toggle persists across reload (the `bb_theme` cookie path in `lib/config.ts:126-150`) |

### Tier 4 — CI wiring for the above

| ID | Change | File |
|---|---|---|
| **C1** | Add `apps/payer-web/**` to the `e2e` path filter | `ci.yml:41-53` |
| **C2** | Add a `payer-web-e2e` job (build → `next start -p 3002` → API → Playwright) and put it under `ci-required`'s `needs:` | `ci.yml:603-613` |
| **C3** | Arm `PAYER_TEST_LOGIN_ENABLED` + token in the e2e job env, next to `TEST_LOGIN_ENABLED` | `ci.yml:335-358` |
| **C4** | Add `E2E_UNLOCK_SUITE: "1"` once H3 lands | `ci.yml` e2e env |
| **C5** | Add a **completeness** assertion to `guard-contract.test.ts`: enumerate `*.controller.ts` on disk and fail on any not in `CONTRACT` | `apps/api/src/common/guard-contract.test.ts` |

---

# 2. CI

## 2.1 Workflow map

| Workflow | Trigger | Blocking? | Touches payer-web? |
|---|---|---|---|
| `ci.yml` | push/PR → `main` | **Yes** — `ci-required` | Yes, via the `node` job only |
| `security-scan.yml` | PR → `main`, weekly cron | **No** — `continue-on-error: true` on all 3 jobs | scans `apps/**` (advisory) |
| `supabase-checks.yml` | push/PR on `packages/db/**` | **No** — `continue-on-error: true` on both assertion steps | No |
| `staging-cd.yml` | `workflow_dispatch` only | n/a — **inert** (guard exits 0 when secrets are missing) | **No — explicitly skips the Next apps** |
| `worker-app.yml` / `payer-app.yml` | `workflow_call` from `ci.yml` | Yes when path-filtered in | No (Flutter) |
| `staging-demand-verify.yml`, `cleanup-issues-prs.yml` | — | No | No |

## 2.2 `ci.yml` job-by-job (what a payer-web-only PR actually passes)

| Job | `if:` gate | Runs on a payer-web-only PR? | What it does for payer-web |
|---|---|---|---|
| `changes` | always | Yes | Computes filters. **There is no `payer-web` filter output** — outputs are `ai-service`, `e2e`, `worker-app`, `payer-app` (`ci.yml:17-21`) |
| `node` | **none — no `if:`, no `needs:`** (`ci.yml:97-99`) | **Yes, always** | `pnpm lint` (eslint incl. the payer-web DS token rule, `eslint.config.mjs:95`); `pnpm lint:oxlint` over `apps/payer-web/src` (`ci.yml:147`); `pnpm typecheck`; `pnpm test -- --coverage`; `pnpm build` → `next build` for payer-web |
| `ai-service` | `changes.ai-service` | No → `skipped` | — |
| `ai-service-image` | `changes.ai-service` | No → `skipped` | — |
| `e2e` | `changes.e2e` — filter = `apps/api/**`, `packages/**`, `tests/**`, lockfile, `pnpm-workspace.yaml`, `turbo.json`, `apps/ai-service/**`, `.github/workflows/ci.yml` (`ci.yml:41-53`) | **No → `skipped`. `apps/payer-web` is not in the filter.** | — |
| `worker-app` / `payer-app` | path-filtered | No → `skipped` | — |
| `ci-required` | `always()`, `needs: [changes, node, ai-service, ai-service-image, e2e, worker-app, payer-app]`; fails only on `failure`/`cancelled` (`ci.yml:610-613`) | Yes | Green when `node` is green and everything else is skipped |
| `build-and-push-image` | `push && refs/heads/main` | post-merge | Builds **`badabhai-api`** and **`badabhai-ai-service`** only |
| `deploy-lightsail` | `push && refs/heads/main` | post-merge | Deploys those two images only |

### The answer, stated plainly

**A payer-web-only change passes:** ESLint (incl. the no-raw-hex/px design-system rule), oxlint, `tsc --noEmit`, its own 875 vitest cases, and `next build`.
**It does NOT pass:** any e2e job (skipped by path filter, and there are no payer e2e suites anyway), any coverage threshold (payer-web configures none), any browser test (none exist), any blocking security scan (all advisory), any deploy or packaging step (none exists).
**Can `ci-required` be green while payer/agency behaviour is untested? Yes — that is the normal case today.** It is green whenever `node` is green, and `node` has no behavioural gate above the mocked-seam unit tests.

## 2.3 Branch protection — measured

`GET repos/RVM-BEYOND-PRIVATE-LIMITED/badabhai-platform/branches/main/protection` returns:

```json
{"checks":[{"app_id":15368,"context":"ci-required"}],"contexts":["ci-required"],"strict":true}
```

`ci-required` is the **only** required status check. `security-scan` and `supabase-checks` are separate workflows and cannot be reached by `needs:` — they are invisible to branch protection. (This is the exact gap `ci.yml:70-85` documents having already been hit once for the Flutter jobs on PR #711.)

## 2.4 Is payer-web built or deployed by ANY workflow?

- **Built:** yes, incidentally — `pnpm build` (`ci.yml:198`) → `turbo run build` → `next build` in `apps/payer-web`. Output goes to `.next/**` (`turbo.json:10`) and is discarded with the runner.
- **Packaged:** **no.** `find . -name "Dockerfile*"` → `apps/api/Dockerfile`, `apps/ai-service/Dockerfile`. Nothing else.
- **Hosting config:** **none.** No `vercel.json`, no `netlify.toml`, no `*.tf`. `next.config.mjs` is 9 lines with no `output: "standalone"`, no `headers()`, no CSP, no `images` config.
- **Compose:** `grep payer-web docker-compose*.yml` → **0 service definitions** (one unrelated comment at `docker-compose.staging.yml:113`).
- **Deployed:** **no workflow deploys it.** `deploy-lightsail` pulls `badabhai-api` + `badabhai-ai-service` only (`ci.yml:808-815`). `staging-cd.yml` builds `pnpm --filter "@badabhai/api..." build` with the comment *"skip the Next.js apps"*.

**How would it reach production today? It would not.** There is no artifact, no host, no config, and no pipeline. This is a genuine missing capability, not a flag-gated one.

## 2.5 Security tooling posture

| Scanner | Where | Trigger | Blocking? | In `ci-required`? |
|---|---|---|---|---|
| **gitleaks** (full history) | `security-scan.yml` `secret-scan` job | **`if: github.event_name == 'schedule'` — weekly cron only, never on a PR** | No (`continue-on-error: true`) | No |
| **semgrep OSS** (`p/default,p/typescript,p/python,p/secrets`) | `security-scan.yml` `sast` job | schedule OR `apps/**`/`packages/**`/`tests/**` changed | No (`continue-on-error: true`) | No |
| **pnpm audit** (`--audit-level high`) | `security-scan.yml` `dependency-audit` | schedule OR `pnpm-lock.yaml` changed | No (`continue-on-error: true`) | No |
| **migration drift** (`drizzle-kit generate` + `git diff`) | `supabase-checks.yml` | `packages/db/**` | No (`continue-on-error: true`) | No |
| **migration sequence** (unique/contiguous/journal) | `supabase-checks.yml` | `packages/db/**` | No (`continue-on-error: true`) | No |

Every non-`ci.yml` gate in this repo is advisory. The flip-to-blocking criteria are written down in `security-scan.yml:21-32` and have not been met.

---

# 3. LOCAL DEVELOPMENT

## 3.1 Verified prerequisites

| Tool | Required | Verified on this machine |
|---|---|---|
| Node | `>=20` (`package.json` `engines`) | v25.9.0 |
| pnpm | `11.5.2` pinned (`package.json` `packageManager`) | 11.5.2 |
| Docker Desktop | for Postgres + Redis + Mailpit | — |
| Postgres image | `pgvector/pgvector:pg16` (`docker-compose.yml`) — plain `postgres:16` **will not work** (`CREATE EXTENSION vector` in migration 0001) | — |

## 3.2 The fail-closed env set (derived from every `assert*Config` in `packages/config/src/server.ts`, called at `apps/api/src/main.ts:31-38`)

With `NODE_ENV=development`, **all** of `DATABASE_URL`, `REDIS_URL`, `API_PORT`, `JWT_SECRET`, `PII_*`, `PIN_PEPPER`, `ADMIN_JWT_SECRET` have working dev defaults (`server.ts:71-72`, `:265`, `:298`, `:476`, `:808`). Only two groups are **hard-required in every environment**:

| Group | Vars | Guard | Note |
|---|---|---|---|
| **Fast2SMS** | `FAST2SMS_API_KEY`, `FAST2SMS_SENDER_ID`, `FAST2SMS_DLT_TEMPLATE_ID` | `assertAuthConfig` (`server.ts:1442-1448`) — *"required in EVERY environment"* | Any non-empty placeholder satisfies it. Worker OTP is unused by the payer portal. |
| **Payer email** (because `PAYER_LOGIN_METHOD` defaults to `email_otp`, `server.ts:429`) | `EMAIL_PROVIDER=zeptomail` (default) ⇒ `ZEPTOMAIL_API_TOKEN` + `ZEPTOMAIL_MAIL_AGENT` + `EMAIL_FROM_ADDRESS`; `EMAIL_PROVIDER=smtp` ⇒ `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` + `EMAIL_FROM_ADDRESS` | `assertPayerAuthConfig` → `emailProviderBlockedReason` (`server.ts:1537-1560`, `:1587-1591`) | **Presence-only.** Placeholders boot the process and then fail at send time. |

## 3.3 THE LOCAL LOGIN PROBLEM — and its exact fix

**The documented recipe leaves payer login impossible.** `README.md:101-103` says `cp .env.example .env`. That file ships `EMAIL_PROVIDER=zeptomail` (`.env.example:131`) with `ZEPTOMAIL_API_TOKEN=replace-with-real-zeptomail-token` (`:135`) and `ZEPTOMAIL_MAIL_AGENT=replace-with-real-mail-agent` (`:136`). Those are non-empty, so `emailProviderBlockedReason` returns `null` and the API boots cleanly. Then:

1. `POST /payer/login/request` → `PayerOtpService` reserves a code → `ZeptoMailEmailLoginChannel.deliver` (`zeptomail-email-login-channel.ts:26-35`) → `EmailNotificationService.send` → `fetch` to `https://api.zeptomail.in/v1.1/email` with a fake token → 4xx → `EmailRejectedError` (`email-notification.service.ts:180-182`).
2. The channel re-throws opaquely, `PayerOtpService` **rolls back the reserved code** (`payer-login-channel.ts:31-32`: *"a failed send must leave no dangling code"*).
3. The Server Action returns the neutral `NEUTRAL_SEND_ERROR` (`login/actions.ts:38`) — no diagnostic reaches the developer.

There is **no dev echo, no console provider, no mock arm**: `EMAIL_PROVIDER` is `z.enum(["zeptomail","smtp","auto"])` (`server.ts:521`), `login/actions.ts:38-40` says *"The code is NEVER returned to the client"*, and `.env.example`'s `DEV_QUICK_LOGIN` is dead (§3.5).

**The fix already exists in the repo and is documented nowhere.** `docker-compose.yml` ships a **Mailpit** service under the `mail` / `api` profiles (`pnpm mail:up`), SMTP on `127.0.0.1:1025` and a web UI on `127.0.0.1:8025`, with `MP_SMTP_AUTH_ACCEPT_ANY=1`. Its inline comment states the design intent exactly: *"The API takes its ordinary `EMAIL_PROVIDER=smtp` path, nodemailer really connects, and the message is really delivered — it is just delivered HERE. So the thing being verified is the production code path, not a test double."* And `EmailNotificationService.sendViaSmtp` (`email-notification.service.ts:220-250`) sets `secure: port === 465`, so port 1025 correctly negotiates plaintext.

**Severity:** this is a **P1 documentation/DX defect**, not a P0 capability gap — the path works, it is simply undiscoverable. It becomes a P0 for *automated* E2E verification, because no test can drive it without either the Mailpit REST API or the missing payer test-login seam (§1.5 H1).

### The smallest fix
1. Set in `.env`: `EMAIL_PROVIDER=smtp`, `SMTP_HOST=localhost`, `SMTP_PORT=1025`, `SMTP_USER=dev`, `SMTP_PASS=dev`, `EMAIL_FROM_ADDRESS=otp@badabhai.local`.
2. Run `pnpm mail:up`; read the code at `http://localhost:8025`.
3. Add exactly that to `README.md` and `apps/payer-web/README.md`. Add `EMAIL_PROVIDER=smtp`/Mailpit guidance to `.env.example` next to line 131.

## 3.4 The verified step-by-step recipe (Windows, from a clean checkout)

```powershell
# ── 0. Prereqs: Node >= 20, pnpm 11.5.2 (corepack enable), Docker Desktop running.

# ── 1. Install
cd C:\path\to\badabhai-platform
pnpm install --frozen-lockfile

# ── 2. Env  (repo root .env — apps/api auto-loads it via loadRootEnv, and
#            packages/db/drizzle.config.ts:8 loads ../../.env explicitly)
Copy-Item .env.example .env
#   Then EDIT .env:
#     NODE_ENV=development
#     DATABASE_URL=postgresql://badabhai:badabhai@localhost:5432/badabhai
#     REDIS_URL=redis://localhost:6379
#     EMAIL_PROVIDER=smtp          # <-- CHANGE from zeptomail (see §3.3)
#     SMTP_HOST=localhost
#     SMTP_PORT=1025
#     SMTP_USER=dev
#     SMTP_PASS=dev
#     EMAIL_FROM_ADDRESS=otp@badabhai.local
#     # FAST2SMS_* placeholders from the template are fine (boot presence check only)

# ── 3. Infra: Postgres + Redis + Mailpit
pnpm db:up            # docker compose up -d postgres redis
pnpm mail:up          # docker compose --profile mail up -d mailpit
#   Windows note: if a host Postgres already owns 5432 the compose one is shadowed —
#   use docker-compose.e2e.yml (publishes 5433) and repoint DATABASE_URL.
#   infra/docker/postgres-init/00-supabase-roles.sql pre-creates anon/authenticated/
#   service_role on first boot; without it migration 0004 dies with role "anon" does not exist.

# ── 4. Build workspace packages to dist/ FIRST (README.md:237 troubleshooting)
pnpm build            # turbo: topological; also runs next build for payer-web

# ── 5. Schema: 74 migrations, 0000..0073
pnpm db:migrate

# ── 6. Reference data the interview reads on every turn (order matters)
pnpm --filter @badabhai/db db:seed:domains --apply
pnpm --filter @badabhai/db db:normalize:aliases --apply
pnpm --filter @badabhai/db db:seed:packs --apply
pnpm --filter @badabhai/db db:seed:jobs
pnpm --filter @badabhai/db db:seed:match:vocabulary --apply   # only writer of match_config
#   NOTE: --apply is REQUIRED on this family — every script is DRY-RUN by default
#   (ci.yml:424-430 documents a real green-but-seeded-nothing incident).

# ── 7. THE PAYER/AGENCY FIXTURE — the only seed that creates login-able payers
pnpm --filter @badabhai/db db:seed:reach
#   Small profile: $env:SEED_WORKERS=40; $env:SEED_PAYERS=8; $env:SEED_POSTINGS=12; $env:SEED_JOBS=12
#   Seeded logins are seed-payer-0001@reach.test.invalid … (Mailpit accepts any recipient)

# ── 8. Run (two terminals)
pnpm --filter @badabhai/api dev            # nest start --watch -> http://localhost:3001/health
pnpm --filter @badabhai/payer-web dev      # next dev -p 3002  -> http://localhost:3002
#   payer-web needs apps/payer-web/.env.local (Next does NOT read the repo-root .env):
#     PAYER_API_URL=http://localhost:3001
#     NEXT_PUBLIC_API_URL=http://localhost:3001
#     NEXT_PUBLIC_ENVIRONMENT=development
#     PAYER_DEV_ORG_ROLE=owner     # REQUIRED to reach /credits and /team (dev/test only)

# ── 9. Log in
#   http://localhost:3002/login  ->  sign up, or use a seeded email
#   Read the one-time code at http://localhost:8025
```

**Ports:** api `3001` (`server.ts:808`), payer-web `3002` (`apps/payer-web/package.json` `dev`), ai-service `8000` (optional — absent means the API degrades to its safe mock), ops console `3000`, adminer `8080`, Mailpit `1025`/`8025`.
**Optional:** the AI service is not needed for any payer/agency flow.

## 3.5 Env-var table — payer/agency surface

### 3.5.1 apps/api (all read via `packages/config/src/server.ts`)

| Var | Default | Required? | In root `.env.example`? | Notes |
|---|---|---|---|---|
| `NODE_ENV` | — | yes | ✅ `:11` | `development` keeps every dev-default guard happy |
| `DATABASE_URL` | `postgresql://badabhai:badabhai@localhost:5432/badabhai` (`:71`) | no | ✅ `:16` | |
| `REDIS_URL` | `redis://localhost:6379` (`:72`) | no | ✅ `:17` | sessions, OTP store, every rate cap |
| `API_PORT` | `3001` (`:808`) | no | ✅ `:357` | |
| `JWT_SECRET` | dev default (`:27`) | non-dev only | ✅ `:81` | signs **both** worker and payer sessions |
| `PII_HASH_PEPPER` / `PII_ENCRYPTION_KEY` | dev defaults (`:20-21`) | non-dev only | ✅ `:74-75` | must match the seeds' values or email lookup fails |
| `FAST2SMS_API_KEY` / `_SENDER_ID` / `_DLT_TEMPLATE_ID` | none | **YES, every env** (`:1442`) | ✅ `:117-119` | placeholders OK for payer work |
| `PAYER_LOGIN_METHOD` | `email_otp` (`:429`) | no | ❌ **MISSING** | selects the login channel |
| `EMAIL_PROVIDER` | `zeptomail` (`:521`) | no | ✅ `:131` | **set to `smtp` locally** |
| `ZEPTOMAIL_API_TOKEN` / `_MAIL_AGENT` | none | yes if provider=zeptomail | ✅ `:135-136` | |
| `SMTP_HOST` / `_PORT` / `_USER` / `_PASS` | none | yes if provider=smtp | ✅ `:140-143` (blank) | Mailpit: `localhost`/`1025`/any/any |
| `EMAIL_FROM_ADDRESS` | none | yes for **either** provider | ✅ `:148` | must parse as `z.string().email()` |
| `PAYER_DISCLOSURE_MAX_PER_HOUR` | `30` (`:434`) | no | ❌ **MISSING** | fail-closed on Redis error |
| `PAYER_REACH_MAX_PER_HOUR` | `60` (`:459`) | no | ❌ **MISSING** | |
| `PAYER_AUTH_MAX_PER_IP_PER_HOUR` | `20` (`:438`) | no | ❌ **MISSING** | |
| `PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY` | `2000` (`:451`) | no | ✅ `:157` | `0` = kill-switch |
| `AGENCY_INVITE_MINT_MAX_PER_HOUR` | `60` (`:465`) | no | ❌ **MISSING** | |
| `AGENCY_PAYOUTS_ENABLED` | `false` (`:731`) | no | ❌ **MISSING** | gates the agency money surface |
| `CAPACITY_ENFORCEMENT_ENABLED` | `false` (`:671`) | no | ❌ **MISSING** | shadow mode by default |
| `MATCH_V1_ENABLED` | `false` (`:780`) | no | ❌ **MISSING** | |
| `MEMBER_INVITES_ENABLE_REAL` | `false` (`:557`) | no | ✅ `:166` | mock mailer default |
| `MEMBER_INVITE_ACCEPT_URL` | none | yes if the above is true | ✅ `:170` | |
| `MEMBER_INVITE_MAX_PER_ORG` | `25` (`:573`) | no | ✅ `:173` | |
| `PAYMENTS_ENABLE_REAL` + `PAYMENTS_PROVIDER_KEY`/`_SECRET` + `RAZORPAY_WEBHOOK_SECRET` | `false` / none | all three if flag on | ✅ `:237-240` | `assertPaymentsConfig` |
| `PIN_PEPPER` | dev default (`:298`) | non-dev only | ❌ **MISSING** | |
| `ADMIN_JWT_SECRET` | dev default (`:476`) | non-dev; must ≠ `JWT_SECRET` | ❌ **MISSING** | |
| `CORS_ALLOWED_ORIGINS` | `""` (`:832`) | non-dev | ❌ **MISSING** | deny-all if unset outside dev |
| `TRUST_PROXY_HOP_COUNT` | `0` (`:815`) | no | ❌ **MISSING** | feeds every per-IP cap |
| `TEST_LOGIN_ENABLED` / `TEST_LOGIN_TOKEN` / `TEST_LOGIN_MAX_PER_DAY` | `false` / none / 200 (`:336-337`) | no | ❌ **MISSING** | worker-only seam |
| `INTERNAL_SERVICE_TOKEN` | none | for ops routes | ✅ `:64` (commented out) | |
| `SESSION_TTL_DAYS` | `30` (`:269`) | no | ✅ `:83` | |

### 3.5.2 apps/payer-web

| Var | Read at | Default | Status |
|---|---|---|---|
| `PAYER_API_URL` | `lib/server-config.ts:63` | `http://localhost:3001` | **LIVE** — and **absent from the root `.env.example`** |
| `PAYMENTS_ENABLE_REAL` | `lib/server-config.ts:55` | `false` | LIVE (read flag; the boot-throw was removed — see `:10-16`) |
| `AGENCY_SUPPLY_ENABLED` | `lib/server-config.ts:60` | `false` | LIVE (labels a parked module only) |
| `PAYER_POSTING_FREE_THROUGH_LAUNCH` | `lib/pricing-config.ts:57` | `true` | LIVE |
| `PAYER_DEV_ORG_ROLE` | `lib/auth/org-roles.ts:50` | unset | LIVE, **dev/test only** — the sole way to reach `/credits`+`/team` locally. **Undocumented in both `.env.example` files and both READMEs.** |
| `PAYER_THEME` / `NEXT_PUBLIC_PAYER_THEME` | `lib/config.ts:128` | `system` | LIVE, undocumented in `.env.example` |
| `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_ENVIRONMENT` | `@badabhai/config/public` | — | LIVE |
| `NEXT_PUBLIC_SITE_URL` | `batch-invite-panel.tsx:86`, `qr-invite.tsx:66`, `session-cookie.ts:31` | browsing origin | LIVE |
| `NEXT_PUBLIC_SHORT_LINK_BASE` | `lib/invite-landing.ts` | `https://app.badabhai.in` | LIVE |
| `NEXT_PUBLIC_WORKER_APP_ID` | `lib/invite-landing.ts` | `com.badabhai.workerapp` | LIVE |
| `NEXT_PUBLIC_ENABLE_AGENCY_*` (6) | `lib/config.ts:86-95` | portal `true`, rest `false` | LIVE |
| **`PAYER_AUTH_MODE`** | — | — | **DEAD** — only `apps/payer-web/.env.example:47` + `README.md:58` |
| **`PAYER_SESSION_SECRET`** | — | — | **DEAD** — `.env.example:54` + `README.md:60` |
| **`DEV_QUICK_LOGIN`** | — | — | **DEAD** — `.env.example:52`; `apps/api/src/auth/test-login.guard.ts:20` explicitly says the D-3 seam is *"NOT a resurrection of DEV_QUICK_LOGIN"* |

### 3.5.3 Documentation drift (both directions)

**Documented but gone from code:** `PAYER_AUTH_MODE`, `PAYER_SESSION_SECRET`, `DEV_QUICK_LOGIN` — plus `apps/payer-web/README.md:37-40` describes `src/lib/mock-store.ts` and `src/lib/auth/mock-provider.ts`, **neither of which exists** (`ls apps/payer-web/src/lib` and `.../lib/auth` confirm: only `http-provider.ts`, `index.ts`, `org-roles.ts`, `roles.ts`, `session-cookie.ts`, `types.ts`). The same README labels postings, top-up, and masked-resume as *"WAITING (mock)"* (`:22-32`) when `payer-api.test.ts:962-988` asserts the exact opposite — that no mock path remains. `README.md:56` also states `PAYMENTS_ENABLE_REAL` **"must be false — boot fails closed if true"**, directly contradicted by `server-config.ts:10-16`.

**Required/used by code but absent from `.env.example`:** `PAYER_API_URL`, `PAYER_DEV_ORG_ROLE`, `PAYER_LOGIN_METHOD`, `PIN_PEPPER`, `ADMIN_JWT_SECRET`, `ADMIN_MFA_REQUIRED`, `ADMIN_TOTP_ISSUER`, `CORS_ALLOWED_ORIGINS`, `TRUST_PROXY_HOP_COUNT`, `AGENCY_PAYOUTS_ENABLED`, `CAPACITY_ENFORCEMENT_ENABLED`, `MATCH_V1_ENABLED`, `PACE_ENABLED`, `ADMIN_PII_REVEAL_ENABLED`, `AUTH_ROLLING_TIERS_ENABLED`, `TEST_LOGIN_*`, `PAYER_DISCLOSURE_MAX_PER_HOUR`, `PAYER_REACH_MAX_PER_HOUR`, `PAYER_AUTH_MAX_PER_IP_PER_HOUR`, `AGENCY_INVITE_MINT_MAX_PER_HOUR`.

**`README.md:127-158` ("Running Each App") lists API, AI service, ops console (3000), and the Flutter worker app. It does not mention `apps/payer-web` or port 3002 at all** — the portal this audit is about has no run instructions in the repo's front door.

## 3.6 Seed data — what actually populates the portal

| Script | Creates | Usable for the payer portal? |
|---|---|---|
| `db:seed` (`packages/db/src/seed.ts`) | **Nothing.** `:20` logs *"No seed data defined yet (Phase 1 placeholder). Nothing inserted."* | No |
| **`db:seed:reach`** (`seed-reach-pool.ts`) | ~50 `payers` (≈60% `employer` / 40% `agent`, `:357`) each with `payer_credits` + `payer_capacity` + `posting_plans`; 500 `workers` + `worker_profiles` + `worker_consents` (incl. `employer_sharing`); 100 `job_postings`; 100 `jobs` | **YES — the only one.** Writes real `emailEnc` + `emailHash` (`:584-585`), so `seed-payer-0001@reach.test.invalid` … can complete a real email-OTP login (Mailpit accepts any recipient). `ensureSoloOrg` runs at login/verify (`payer-auth.service.ts:148`) and provisions the payer as org **owner** (`payer-orgs.repository.ts:78-84`). |
| `db:seed:demand` | 1 worker + profile + consents, 1 open `job_posting`, 1 credited `payer_credits` row | Partial — **creates no `payers` row**, so that payer id cannot log in |
| `db:seed:jobs` | ADR-0009 `jobs` catalogue (PII-free) | Needed for the reach/applicant feed |
| `db:seed:domains` + `db:normalize:aliases` + `db:seed:packs` | Occupation catalogue + question packs | Required — the interview fails closed without the universal pack |
| `db:seed:match:vocabulary` | `MATCH_SKILLS` + `skill_related` + **the single active `match_config` row** | Required; no migration inserts into `match_config` |
| `db:seed:skills`, `db:seed:questionnaire` | reference data | Optional |
| Verifiers (read-only): `db:verify:packs`, `db:verify:domains`, `db:verify:reach`, `db:verify:match-v1`, `db:verify:demand` | — | Useful post-seed sanity checks |

---

# 4. PRODUCTION READINESS

## 4.1 apps/api — how it reaches production

| Stage | Mechanism | Evidence |
|---|---|---|
| Image build | `docker/build-push-action` on `push:main`, context `.`, `apps/api/Dockerfile` → `ghcr.io/<repo>/badabhai-api:{main, sha-<short7>}` | `ci.yml:623-687` |
| ai-service image | same job, context `apps/ai-service` | `ci.yml:695-728` |
| Deploy | `appleboy/ssh-action` (SHA-pinned) into an AWS **Lightsail** box; `git pull origin main`; GHCR login with the ephemeral `GITHUB_TOKEN`; disk reclaim; `compose pull` + `up -d --no-deps` for redis → ai-service → api | `ci.yml:731-982` |
| Image pinning | Immutable `sha-<short7>`; `DOCKER_METADATA_SHORT_SHA_LENGTH: "7"` pinned on both images | `ci.yml:654`, `:808-815` |
| Runtime | `docker-compose.yml` + `docker-compose.staging.yml`, `--profile api`; every prod secret is a fail-loud `${VAR:?}` | `docker-compose.staging.yml` |
| Container | `USER node`, `CMD ["node","apps/api/dist/main.js"]`, `ENV NODE_ENV=production`. **No `HEALTHCHECK` instruction.** | `apps/api/Dockerfile:32,50-51` |
| Environment | GitHub `environment: staging` — *"if the owner rules this box is PRODUCTION, rename AND add a required reviewer"* | `ci.yml:743-747` |

## 4.2 apps/payer-web — how it would reach production

**It cannot.** No Dockerfile, no `output: "standalone"` in `next.config.mjs`, no `vercel.json`/`netlify.toml`/Terraform, no compose service, no workflow step. Nothing beyond a `next build` whose output dies with the CI runner. See §2.4.

`next.config.mjs` is 9 lines: `reactStrictMode: true` and `eslint.ignoreDuringBuilds: true`. There is **no `headers()` function**, so no CSP, HSTS, `X-Frame-Options`, `Referrer-Policy`, or `Permissions-Policy` would ship with a deployed portal.

## 4.3 Migrations in the deploy pipeline — NOT applied

`ci.yml:907-916`, inside the deploy script, verbatim:

```
# TODO(CD-2, held: 0031 human sign-off + D1): migrations-in-pipeline would
# run HERE — after the image pull, BEFORE the new code boots (CLAUDE.md §2
# ordering: migrations never run after the code that assumes them). Held
# pending owner sign-off on migration 0031 ...
# NOTE (CD-3 scope): the /health gate below checks CONNECTIVITY only
# (SELECT 1 + Redis PING) — a fresh, UNMIGRATED DATABASE_URL still boots
# and 200s while every real endpoint 500s. Until CD-2 lands, applying
# migrations MANUALLY (owner, after 0031 sign-off) is a required pre-step
```

Confirmed against `apps/api/src/health/health.controller.ts:71`: `const healthy = checks.database === "up" && checks.redis === "up"`. Nothing checks schema version. Migration count is **74** (`0000`..`0073`).

`staging-cd.yml` *does* run `pnpm db:migrate` before the deploy trigger — but that workflow is `workflow_dispatch`-only and its guard exits 0 as a no-op until a human wires the `staging` GitHub Environment secrets.

## 4.4 Health checks, rollback, secrets, CORS, logging, backups

| Concern | What exists | What does not |
|---|---|---|
| **Health** | `GET /health` — active `SELECT 1` + Redis `PING`; 200/503; body carries only `up`/`down` per dependency. Deploy gates on it: 30×2s for api (`ci.yml:967-981`), 15×2s for ai-service (`:944-958`). | No readiness-vs-liveness split; **no schema-version check**; `deletion_sweep` and `ai_service` are informational and deliberately do not gate (`health.controller.ts:29-56`). No Dockerfile `HEALTHCHECK`. **No health probe for payer-web** (it has no deployment). |
| **Rollback** | Immutable `sha-<short7>` tags; the prune keeps 72h of tags as rollback targets (`ci.yml:844-846`); procedure = export `API_IMAGE` + `AI_SERVICE_IMAGE` and re-run compose up. | **`docs/rollback-guide.md` is cited four times in `ci.yml` (`:662`, `:807`, `:814`, `:845`) and DOES NOT EXIST on `main`.** No automated rollback; no post-deploy smoke beyond `/health`. No DB rollback story (down-migrations are not generated). |
| **Secrets** | 12 secrets bridged runner→box via `env:` + `envs:` (`ci.yml:764-786`); `${VAR:?}` fail-loud interpolation; `docker logout` on every exit path via `trap`; explicit warnings against `debug: true`/`allenvs: true` (`:761-763`). | No rotation policy, no vault, no audit of who can read the `staging` environment. `staging-cd.yml`'s guard rejects a `DATABASE_URL` still pointing at compose-internal postgres — good — but nothing equivalent guards the Lightsail path. |
| **CORS** | `app.enableCors({ origin: resolveCorsOrigins(config) })` (`main.ts:94`); permissive in dev, explicit allow-list outside dev, **deny-all if `CORS_ALLOWED_ORIGINS` is unset** (`server.ts:874-883`). Supplied as a deploy secret (`ci.yml:776`). | **No payer-web origin is registered anywhere in the repo** — there is no payer-web domain because there is no payer-web deployment. Strictly, payer-web needs no CORS entry (it calls the API only server-side through `payer-http.ts`), but the moment any browser call is added, this becomes a silent breakage. |
| **Logging** | `StructuredLogger("api")` JSON to stdout with `request_id`/`correlation_id` (`main.ts:58-60`); the `events` table is the durable audit spine. | **No log destination.** No shipping, no retention, no search. `infra/monitoring/README.md` is explicit: *"TODO (later): metrics (Prometheus/OpenTelemetry), dashboards, alerting."* Langfuse is placeholder-only. **`docs/observability-runbook.md`, cited by `health.controller.ts:39`, does not exist.** |
| **Backups** | **Nothing.** `grep -ri "backup\|pg_dump\|pitr" --include=*.md --include=*.yml .` returns zero relevant hits. | No dump schedule, no PITR config, no restore drill, no retention policy — for a database holding encrypted worker PII under DPDP. |
| **Runbooks** | `infra/supabase/{README,migration-plan,rls-plan,storage-buckets,local-dev}.md` exist. | **Missing on `main`:** `docs/rollback-guide.md`, `docs/ops/staging-service-deploy-runbook.md`, `docs/ops/otp-real-send-staging-runbook.md`, `docs/observability-runbook.md`, `docs/resume-pdf-render-local.md`. `docs/` on `origin/main` contains exactly 5 files (verified with `git ls-tree -r origin/main -- docs`). |

## 4.5 Environment posture summary

| Environment | API | payer-web | Migrations | OTP |
|---|---|---|---|---|
| **Local dev** | works; dev-default secrets; Mailpit path undocumented | works (`next dev -p 3002`) | manual `pnpm db:migrate` | Mailpit (once configured) |
| **CI e2e** | boots with dummy Fast2SMS/ZeptoMail creds (`ci.yml:365-370`); worker `TEST_LOGIN_ENABLED=true` | never started | fresh chain every run | none reachable for payers |
| **Lightsail ("staging")** | deployed from `main` | **not deployed** | **NOT applied by the pipeline** | real Fast2SMS + ZeptoMail |
| **`staging-cd.yml` host** | inert (guard no-ops) | explicitly skipped | applied when wired | real, OTP-7 human-gated |
| **Production** | does not exist as a distinct target | does not exist | — | — |

---

# 5. Prioritised remediation order

1. **P0** Decide and build payer-web's deployment target (§2.4). Nothing else about production readiness matters until an artifact exists.
2. **P0** Land CD-2: apply migrations before the new code boots, and add a schema-version assertion to `/health` (§4.3).
3. **P0** Build the payer test-login seam (§1.5 H1) — it unblocks A1–A9 and E1–E6 in one move. Owner ruling required.
4. **P0** Fix `getOrgRole` (add `org_role` to `PayerMeDto`/the session claim — the backend already resolves it at `payer-orgs.repository.ts:95-99`), then **delete** `org-roles.test.ts:99-107` and unmock `requireOwner` in `credits/page.test.tsx`.
5. **P1** Document the Mailpit local-login path in `README.md` + `apps/payer-web/README.md`; add `apps/payer-web` to "Running Each App".
6. **P1** Purge the dead vars and stale claims from `apps/payer-web/.env.example` and `README.md`; add the ~20 missing vars to the root `.env.example`.
7. **P1** Add the `guard-contract.test.ts` completeness assertion and enrol the 7 missing payer/agency controllers.
8. **P1** Add coverage thresholds to `apps/payer-web/vitest.config.ts`; add `apps/payer-web/**` to the `e2e` path filter.
9. **P1** Write `docs/rollback-guide.md` and the three other runbooks the deploy path already cites.
10. **P1** Establish backups (dump schedule + one restore drill) before any real payer data lands.
11. **P2** Flip gitleaks to PR-triggered and blocking; then semgrep; then `supabase-checks`.
12. **P2** Add security headers to `next.config.mjs`; add a `HEALTHCHECK` to `apps/api/Dockerfile`.
