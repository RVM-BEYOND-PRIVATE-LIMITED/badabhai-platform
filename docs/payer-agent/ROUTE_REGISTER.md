# Route Register — apps/payer-web

**Status:** Route + gate + Server Action inventory COMPLETE. Per-route UX states (empty/error/
success), form validation, and pagination **NOT AUDITED** (dimension 13).

25 `page.tsx` files. No `route.ts` handlers anywhere. **No `middleware.ts`** — protection is
per-layout / per-page RSC gating.

**Gate legend:** `requirePayer()` → redirect `/login` if no session ·
`requireAgent()` / `requireEmployer()` / `requireOwner()` → **neutral `notFound()` (404)** on
mismatch, never a 403 oracle (`lib/auth/roles.ts:37,42`, `lib/auth/org-roles.ts:64,78`).

---

## Public routes

| URL | File | Gate | Notes |
|---|---|---|---|
| `/` | `app/page.tsx` | — | redirects `/dashboard` or `/login` |
| `/login` | `app/login/page.tsx` | — | two-step OTP; signup sets the persona role here |
| `/i/[code]` | `app/i/[code]/page.tsx` | — | referral landing (Android App Link target) |
| `/i/[code]/desktop` | `app/i/[code]/desktop/page.tsx` | — | desktop fallback + QR |

## Shared portal — company **and** agency (`requirePayer()` at `(portal)/layout.tsx:34`)

| URL | File | Extra gate | Backend calls |
|---|---|---|---|
| `/dashboard` | `dashboard/page.tsx` | role-aware: agents also render `agent-sections.tsx` (re-asserts `requireAgent()`) | credits, postings, agency summary |
| `/profile` | `profile/page.tsx` | — | ⚠️ see `GAP-FE-02` |
| `/account` | `account/page.tsx` | — | `GET`/`PATCH /payer/me` |
| `/postings` | `postings/page.tsx` | — | `GET /payer/job-postings` |
| `/postings/new` | `postings/new/page.tsx` | — | `POST /payer/job-postings`, match skills/preview |
| `/postings/ai/new` | `postings/ai/new/page.tsx` | — | job-posting-chat ×5 |
| `/postings/[id]` | `postings/[id]/page.tsx` | — | `GET /payer/job-postings/:id` |
| `/postings/[id]/edit` | `postings/[id]/edit/page.tsx` | — | `PATCH /payer/job-postings/:id` |
| `/postings/[id]/applicants` | `postings/[id]/applicants/page.tsx` | — | reach applicants → unlock → reveal |
| `/plans` | `plans/page.tsx` | — | pricing catalog (display only) |
| `/capacity` | `capacity/page.tsx` | — | `GET`/`POST /payer/capacity` |
| `/team/accept` | `team/accept/page.tsx` | `requirePayer()` only — invitee may be a Recruiter | `POST /payer/org/invites/accept` |

## Owner-only (`requireOwner()`)

| URL | File | Reachable today? |
|---|---|---|
| `/credits` | `credits/page.tsx` | 🔴 **NO — 404 for every real user** |
| `/team` | `team/page.tsx` | 🔴 **NO — 404 for every real user** |

> **`GAP-FE-01` (P0).** `getOrgRole()` hard-returns `"recruiter"` outside dev
> (`lib/auth/org-roles.ts:46-56`), so `requireOwner()` always 404s in staging/production. Both
> pages are fully built and their backend routes are wired and correctly guarded.
> `portal-nav.tsx` **still links to them**, so the user's own navigation leads to a not-found —
> a dead-link UX defect layered on the functional one.
>
> **Do not fix this by opening the gate.** Per `PAY-DB-01`, `org_id` exists on no business
> table; opening the gate yields empty pages instead of 404s. Sequence: settle tenancy →
> migrate → open the gate.

## Agency-only (`requireAgent()`)

| URL | File | State |
|---|---|---|
| `/agency/dashboard` | `agency/dashboard/page.tsx` | legacy `redirect("/dashboard")` |
| `/agency/jobs/[jobId]` | `agency/jobs/[jobId]/page.tsx` | LIVE |
| `/agency/workers` | `agency/workers/page.tsx` | LIVE (faceless) |
| `/agency/referrals` | `agency/referrals/page.tsx` | LIVE; supply/KYC/payouts panels 404 in alpha |
| `/agency/qr` | `agency/qr/page.tsx` | LIVE — printable QR poster |
| `/agency/revenue` | `agency/revenue/page.tsx` | **PARKED** — "Coming soon", renders no data |
| `/agency/bulk-upload` | `agency/bulk-upload/page.tsx` | **DEAD BY DESIGN** — honest refusal |

`requireEmployer()` exists in `roles.ts:42` but **no page uses it** — there are zero
company-exclusive routes. Company is the default/shared surface.

---

## Error & loading boundaries — sparse

Repo-wide, only **five** boundary files exist for 25 pages:

```
app/error.tsx            app/global-error.tsx      app/not-found.tsx
app/(portal)/error.tsx   app/(portal)/loading.tsx
```

> **`GAP-FE-03` (P2).** There is exactly **one** `loading.tsx` (portal-level) and **one**
> route-segment `error.tsx` (portal-level). No individual route — including the slow ones
> (`/postings/[id]/applicants`, which triggers the unindexed rank sort of `PAY-DB-04`, and the
> AI chat) — has its own loading skeleton or error boundary. Every failure in any portal page
> collapses to the same generic portal-level error screen, and every navigation shows the same
> generic portal-level fallback.

## Session expiry behaviour

`payer-http.ts:61` throws `PayerUnauthorizedError` on 401. That error is caught in **exactly one
place** — `lib/auth/http-provider.ts:134`, inside `currentSession()`, which returns `null` so the
layout redirects to `/login`.

Every **other** call site — every page data read and every Server Action — lets it propagate.
Combined with `GAP-PAY-01` (`POST /payer/refresh` is never called), the behaviour on a hard
refresh of a deep route with an expired cookie is: **the portal error boundary, not a redirect to
login.** Tracked as `GAP-FE-04` (P1). Not confirmed against a running app.

---

## Server Actions — 15 files, 33 exported actions

A Server Action is a **public POST endpoint**; the page gate does not protect it. Verified gate
usage per file:

| File | Actions | Explicit gate |
|---|---|---|
| `login/actions.ts` | 3 | `payerAuth()` |
| `capacity/actions.ts` | 1 | `requirePayer()` |
| `credits/actions.ts` | 3 | `requireOwner()` |
| `team/actions.ts` | 3 | `requireOwner()` + `requirePayer()` |
| `agency/dashboard/{invite,batch-invite,jobs}-actions.ts` | 6 | `requireAgent()` |
| `agency/referrals/supply-actions.ts` | 2 | `requireAgent()` |
| `account/actions.ts` | 1 | **none** |
| `postings/actions.ts` | 4 | **none** |
| `postings/new/actions.ts` · `match-actions.ts` | 2 | **none** |
| `postings/[id]/edit/actions.ts` | 1 | **none** |
| `postings/[id]/applicants/actions.ts` | 3 | **none** |
| `postings/ai/new/actions.ts` | 4 | **none** |

### Verdict on the ungated 15: **not an authentication hole**

Read of `postings/actions.ts` in full confirms the pattern is sound and deliberate:

1. Input is zod-validated at the action boundary (`postingIdSchema = z.string().uuid()`).
2. The action delegates to `payer-api.ts` → `payer-http.ts`, which reads the httpOnly cookie and
   throws `PayerUnauthorizedError` when there is no token — an anonymous caller cannot proceed.
3. The backend re-derives the payer from the JWT and `payer-scope.ts` asserts row ownership,
   returning a **neutral not-found** for another tenant's posting.
4. The client supplies **only** the posting id, never a payer id (documented at
   `postings/actions.ts:14-23`).

Two genuine residual risks remain, both narrower than "missing auth":

> **`GAP-FE-05` (P2 — defence in depth).** Authentication on these 15 actions is *transitive*,
> resting on the cookie read inside the seam. A future refactor that adds a non-`payerFetch` code
> path to any of them silently removes the only check. A one-line `await requirePayer()` at the
> top of each makes the guarantee local and explicit.

> **`GAP-FE-06` (P1 — cross-role access, open question).** None of the employer posting actions
> asserts a role, **and** `/payer/job-postings/*` carries no `@PayerRoles` on the backend — where
> `PayerRoleGuard` is a documented **no-op without metadata**. An `agent` session can therefore
> drive the employer posting surface directly. Agencies have their own `/payer/agency/jobs`
> surface, so this is either intentional overlap or an omission. **Needs an owner ruling** — it
> determines whether agency vacancies and employer postings share one table and one quota.

> **`GAP-FE-07` (P1 — money idempotency).** `topUpQuotaAction` (`postings/actions.ts:74`) spends
> credits and has no idempotency key at the action layer. The code comments at `:83-88` show the
> author reasoning carefully about not inviting a retry *after* the charge commits, but nothing
> prevents a double-submit from issuing two charges. Whether the backend dedupes was not audited;
> `credit_ledger_idempotency_key_uq` exists (`payer.ts:287-339`) — confirm it is populated on
> this path.
