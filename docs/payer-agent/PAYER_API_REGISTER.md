# Payer API Register

**Status:** Route inventory + wiring COMPLETE. Per-endpoint *implementation quality*
(validation coverage, IDOR scoping, events, tests) **NOT AUDITED** — see `AUDIT_STATUS.md` dims 8–9.

**Method:** routes read from `@Controller`/`@Get`/`@Post` decorators in `apps/api/src`.
Wiring proved in **both directions** by extracting every backend path literal referenced anywhere
in `apps/payer-web/src` and diffing against the controller inventory.

**Guard legend:** `P` = `PayerAuthGuard` · `ORG` = `PayerOrgRoleGuard` · `—` = public (no guard).
`PayerAuthGuard` is also the lifecycle gate: it re-reads `{role,status}` from the `payers` row on
**every** request, so a suspended payer is 403'd immediately, not at next login
(`payers/payer-auth.guard.ts:83`).

---

## Auth & account

| Route | Guards | Frontend consumer | Wiring |
|---|---|---|---|
| `POST /payer/signup` | — | `lib/auth/http-provider.ts` ← `login/actions.ts` | ✅ wired |
| `POST /payer/login/request` | — | `http-provider.ts` | ✅ wired |
| `POST /payer/login/verify` | — | `http-provider.ts` | ✅ wired |
| `POST /payer/logout` | `P` | `(portal)/logout-action.ts` | ✅ wired |
| `GET /payer/me` | `P` | `http-provider.ts` `currentSession()` | ✅ wired |
| `PATCH /payer/me` | `P` | `(portal)/account/actions.ts` | ✅ wired |
| **`POST /payer/refresh`** | `P` | **NONE** | 🔴 **BACKEND EXISTS — FRONTEND NOT CONNECTED** |

> **`GAP-PAY-01` (P1).** The payer session-refresh endpoint exists and is never called. Combined
> with the fact that `isPayerUnauthorized` is caught in exactly **one** place —
> `lib/auth/http-provider.ts:134`, inside `currentSession()` — a token that expires mid-session
> propagates an unhandled throw out of every page and Server Action, hitting the nearest error
> boundary instead of redirecting to `/login`. The cookie `maxAge` is set from the API's
> `expires_in_seconds` (`session-cookie.ts:14`), so the session simply dies at that horizon.
> Evidence: `payer-http.ts:61`, `http-provider.ts:134`, absence of any `/payer/refresh` literal
> in `apps/payer-web/src`.

## Credits, payments & unlocks

| Route | Guards | Frontend consumer | Wiring |
|---|---|---|---|
| `GET /payer/credits` | `P` | `payer-api.ts` → `/credits`, `/dashboard` | ✅ wired |
| `POST /payer/credits` (mock top-up) | `P` | `credits/actions.ts` | ⚠️ wired — **ungated, see `GAP-PAY-04`** |
| `GET /payer/credits/ledger?limit=50` | `P` | `lib/credit-history.ts` | ✅ wired |
| `POST /payer/credits/order` | `P` | `credits/razorpay-checkout.ts` | ⚙️ wired, **flag-gated 404** |
| `POST /payer/credits/verify` | `P` | `credits/actions.ts` | ⚙️ wired, **flag-gated 404** |
| `GET /payer/unlocks` | `P` | `payer-api.ts` | ✅ wired |
| `POST /payer/unlocks` | `P` | `postings/[id]/applicants/actions.ts` | ✅ wired |
| `POST /payer/unlocks/:unlockId/reveal` | `P` | `applicants/actions.ts` | ✅ wired |

Both `/order` and `/verify` return a **neutral 404** unless `PAYMENTS_ENABLE_REAL`
(`payer-unlocks.controller.ts:164,198`). Per the alpha ruling this is correct; the open item is
whether the UI says so honestly (`GAP-XC-04`).

> ### `GAP-PAY-04` (P0 — **fix before flipping `PAYMENTS_ENABLE_REAL`**)
>
> **The mock credit-grant path is not mutually exclusive with the real one.** `realPaymentsLive`
> gates exactly two routes — `/credits/order` (`:164`) and `/credits/verify` (`:198`). It does
> **not** gate `POST /payer/credits` (`:129-139`), which goes straight to
> `PaymentGateway.purchasePackMock` (`payment-gateway.ts:166`) and grants the pack's credits +
> appends the ledger with `realCall: false`. There is no `PAYMENTS_ENABLE_REAL` check and no
> `NODE_ENV` check on that route. It is also **uncapped** — the two rate-limit calls in that
> controller (`:68`, `:89`) are on unlock and reveal, not on the grant.
>
> **Today, under the alpha ruling, this is working as designed** — money is mock, credits are
> meant to be mock-purchasable. It is not a live revenue defect.
>
> **The moment `PAYMENTS_ENABLE_REAL` flips ON it becomes a payment bypass**: real Razorpay
> checkout goes live at `/credits/order` while `/payer/credits` stays open beside it, granting
> the same credits for free to any authenticated payer, unthrottled.
>
> **Scope note, to avoid overstating it:** credits gate unlocks, and unlocks *are* hourly
> rate-capped per payer (`payer-unlocks.controller.ts:68,89`). So this bypasses the **paywall**,
> not the PII throttle — worker contacts cannot be harvested faster than the existing cap allows.
>
> **Required work:** gate `POST /payer/credits` on `!realPaymentsLive` (mirroring `:164`) so the
> mock and real paths are mutually exclusive by construction, and add a per-payer cap. The same
> pattern must be checked on `…/:id/plan`, `…/:id/boost`, `…/:id/quota-topup` and
> `POST /payer/capacity`, which the audit reports grant paid entitlements through the same
> unconditionally-live mock path.
>
> **Test:** with `PAYMENTS_ENABLE_REAL=true`, `POST /payer/credits` must 404; with it false, it
> must succeed. Both rows, not just the deny row.

**Money integrity (verified in the DB audit, `PAY-DB-09`):** the debit path is sound —
`unlocks.repository.ts:368-375` performs an atomic conditional decrement, and
`unlocks.service.ts:244,265-270` pairs the balance mutation with the ledger append inside one
transaction. `payer_credits_balance_nonneg_chk` backstops it. What is missing is a
**reconciliation invariant**: nothing asserts `balance = SUM(ledger.delta)`, and there are zero
triggers repo-wide.

## Job postings

| Route | Guards | Frontend consumer | Wiring |
|---|---|---|---|
| `POST /payer/job-postings` | `P` | `postings/new/actions.ts` | ✅ wired |
| `GET /payer/job-postings` | `P` | `postings/page.tsx` | ✅ wired |
| `GET /payer/job-postings/:id` | `P` | `postings/[id]/page.tsx` | ✅ wired |
| `PATCH /payer/job-postings/:id` | `P` | `postings/[id]/edit/actions.ts` | ✅ wired |
| `POST /payer/job-postings/:id/close` | `P` | `postings/actions.ts` | ✅ wired |
| `POST /payer/job-postings/:id/pause` | `P` | `postings/actions.ts` | ✅ wired |
| `POST /payer/job-postings/:id/resume` | `P` | `postings/actions.ts` | ✅ wired |
| `POST /payer/job-postings/:id/quota-topup` | `P` | `postings/actions.ts` | ✅ wired |
| **`POST /payer/job-postings/:id/plan`** | `P` | **NONE** | 🔴 **NOT CONNECTED** |
| **`POST /payer/job-postings/:id/boost`** | `P` | **NONE** | 🔴 **NOT CONNECTED** |

> **`GAP-PAY-02` (P1).** Explicit plan-purchase and boost endpoints exist (201, with coupon-cap
> enforcement in `posting-plans.repository.ts:286-297`) and have **no caller in `payer-web`**.
> `/plans` renders the catalog and capacity tiers but offers no purchase path to these routes.
> Whether a plan is instead attached implicitly at posting creation was **not audited** — resolve
> before classifying this as missing revenue capability vs dead backend code.
>
> Related DB defect `PAY-DB-10` (P2): `posting_plans` has **no unique constraint at all**, so a
> posting can carry N simultaneously-active paid plans. The repository already concedes this
> (`posting-plans.repository.ts:225-227`: *"if a posting somehow carries more than one active
> plan…"*), and `countActivePlansForPayer` counts them **all** toward the capacity cap — so one
> posting with two plans consumes two vacancy slots.

## Discovery, capacity, pricing, disclosure

| Route | Guards | Frontend consumer | Wiring |
|---|---|---|---|
| `GET /payer/reach/jobs/:jobId/applicants` | `P` | `postings/[id]/applicants/page.tsx` | ✅ wired |
| `GET /payer/match/skills` | `P` | `postings/new/match-actions.ts` | ✅ wired |
| `POST /payer/match/reach-preview` | `P` | `postings/new/match-actions.ts` | ✅ wired |
| `GET /payer/capacity` · `POST /payer/capacity` | `P` | `capacity/actions.ts` | ✅ wired |
| `GET /payer/pricing/catalog` | `P` | `lib/live-catalog.ts` | ✅ wired — **fails open** |
| `POST /payer/resume-disclosures` | `P` | `applicants/actions.ts` | ✅ wired |
| `GET /payer/resume-disclosures` | `P` | unconfirmed | ⚠️ UNCLASSIFIED |

`live-catalog.ts` **fails open** to a compile-time `DEFAULT_CATALOG` when the catalog read
fails, surfacing a "cached pricing" note. Display-only — prices are re-resolved server-side at
charge time. Correct posture, but it means a catalog outage is invisible except for a small note.

The applicant list is the core employer read and carries a **P2 performance defect**
(`PAY-DB-04`): `applications_rank_idx` is a 7-column partial index built expressly for this
query, but the `ORDER BY` cannot use it — the leading key is a runtime-parameterised `CASE`, keys
2–3 are wrapped in `COALESCE`, and `created_at DESC` emits `NULLS FIRST` against an index column
declared `DESC NULLS LAST`. Every read sorts the posting's full applied set before `LIMIT 500`.

## AI job-posting chat (ADR-0035)

| Route | Guards | Frontend consumer | Wiring |
|---|---|---|---|
| `POST /payer/job-posting-chat/session` | `P` | `postings/ai/new/actions.ts` | ✅ wired |
| `POST /payer/job-posting-chat/message` | `P` | `postings/ai/new/actions.ts` | ✅ wired |
| `GET /payer/job-posting-chat/sessions` | `P` | `postings/ai/new` | ✅ wired |
| `GET /payer/job-posting-chat/sessions/:id/messages` | `P` | `postings/ai/new` | ✅ wired |
| `POST /payer/job-posting-chat/sessions/:id/publish` | `P` | `postings/ai/new/actions.ts` | ✅ wired |

Behaviour with `AI_ENABLE_REAL_CALLS` off, or with `ai-service` unreachable, was **NOT audited**.
Note `ai.service.ts:402-415` degrades most calls to an in-process mock, but `profilingOpening` /
`profilingRespond` / `parse` explicitly have **no** mock fallback.

## Org / team

| Route | Guards | Frontend consumer | Wiring |
|---|---|---|---|
| `GET /payer/org/members` | `P`,`ORG` (any member) | `lib/org-members.ts` | ✅ wired — **page unreachable** |
| `POST /payer/org/members` | `P`,`ORG` `@OrgRoles("owner")` | `team/actions.ts` | ✅ wired — **page unreachable** |
| `DELETE /payer/org/members/:id` | `P`,`ORG` `@OrgRoles("owner")` | `team/actions.ts` | ✅ wired — **page unreachable** |
| `POST /payer/org/invites/accept` | `P` | `team/accept/accept-invite.tsx` | ✅ wired |

> **`GAP-PAY-03` (P0).** The backend org surface is correctly built and correctly guarded — org
> is resolved per request from `payer_members`, never from the JWT or body
> (`payer-org-role.guard.ts:65`), and writes bind to `req.payerOrg.orgId`. But the **frontend can
> never reach it**: `getOrgRole()` hard-returns `"recruiter"` outside dev
> (`org-roles.ts:46-56`), so `requireOwner()` → `notFound()` and `/team` + `/credits` are 404s
> for every real user, while `portal-nav.tsx` still links to them.
>
> **This is the symptom, not the disease.** Per `PAY-DB-01`, `org_id` exists on no business
> table, so even with the gate opened a recruiter would see an empty tenant. Sequencing matters:
> settle the tenancy model → migrate → then open the gate. See `DATABASE_AUDIT.md` ambiguity 1.

---

## Coverage summary

| | Count |
|---|---|
| Payer routes inventoried | **38** |
| Verified wired to `payer-web` | **33** |
| Backend exists, frontend not connected | **3** (`/payer/refresh`, `…/plan`, `…/boost`) |
| Wired but flag-gated to 404 in alpha | **2** (`/credits/order`, `/credits/verify`) |
| Frontend calls a nonexistent backend route | **0** — no orphan frontend paths |
| Implementation quality classified | **0** — dimension 8 did not run |

**No frontend path lacks a backend route.** The reverse direction is where the gaps are.
