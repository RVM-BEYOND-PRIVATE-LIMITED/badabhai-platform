# @badabhai/payer-web — external self-serve payer portal

**Status:** ADR-0019 **Phase 1 — MOCK + STAGING-ONLY.** Not for open external GA.
A `bb-security-review` PASS on this surface is required before merge (E-R1).

This is a **distinct external app** (public origin), separate from the internal ops
console (`apps/web`) — ADR-0019 Decision A. Three principals stay separate: worker,
**payer**, ops. This app talks only to the payer-scoped surface; it never reaches the
ops console's privileged data access.

## The demand loop (status 2026-10-07)

1. **Login (LIVE)** — `PayerAuth` seam (`src/lib/auth/`). Phase-1 LIVE mode is `api`:
   the backend payer-auth OTP routes (`/payer/login/request` → `/payer/login/verify`)
   mint a payer JWT stored in an httpOnly server cookie. `mock` stays as a local/test
   fallback. A third-party IdP/MFA is B-R1 (a separate human gate).
2. **Dashboard (LIVE)** — credits (`GET /payer/credits`), unlocks (`GET /payer/unlocks`)
   and postings (`GET /payer/job-postings`), read side by side (`getDashboard`).
3. **Post a job (LIVE)** — a company posts through `POST /payer/job-postings`
   (employer-only, #1885); an agency posts agency jobs through `POST /payer/agency/jobs`.
4. **Applicants (LIVE)** — one posting's feed, reached from that posting:
   `GET /payer/reach/jobs/:jobId/applicants` — faceless ranked rows (opaque id, rank and
   match signals). No name/phone/employer.
5. **Candidates (LIVE, #2121)** — `/candidates`, a top-level rail item for both personas:
   every applicant across the payer's own postings, newest first, filterable by posting —
   `GET /payer/reach/applicants` (#2116). Same faceless cards and the same unlock as
   Applicants; it shares the per-payer hourly reach cap with the per-posting feed.
6. **Unlock (LIVE)** — `POST /payer/unlocks`; no-oracle neutral on any deny cause.
7. **Reveal (LIVE)** — `POST /payer/unlocks/:id/reveal` → a **routed relay handle**
   (opaque, expiring) — **never a raw phone**.
8. **Masked résumé (LIVE)** — `POST /payer/resume-disclosures` (`payer-api.ts`).
9. **Credits (LIVE, mock money)** — `/credits` is open to **every** signed-in member, Owner
   or Recruiter (owner ruling 2026-10-07; `requirePayer()` on the page and all three actions,
   #2110). With `PAYMENTS_ENABLE_REAL` off a purchase is the mock top-up `POST /payer/credits`;
   on, it is Razorpay via `POST /payer/credits/order` + `/verify`. The confirm step shows the
   price that will be charged and sends it as `expected_price_inr`; if the price changed the
   API answers `409 price_mismatch` and nothing is bought (#2101, #2112). Credits land on the
   member's own `payer_id` wallet — there is no org-shared wallet until org tenancy
   (`PAY-DB-01`).
10. **Team (LIVE, owners only)** — `/team` invite/remove is `requireOwner()`; the org role is
    `GET /payer/me` `orgRole` (#2110). A recruiter gets a neutral 404 and no Team item.

## Architecture seams

- `src/lib/auth/` — the **PayerAuth seam**. `http-provider.ts` is the LIVE backend
  payer-auth driver; `mock-provider.ts` is the local fallback; the seam is selected by
  `PAYER_AUTH_MODE`.
- `src/lib/payer-http.ts` — server-only typed transport to the payer-authed API: reads
  the payer JWT from the httpOnly cookie, sends `Authorization: Bearer`, validates every
  response with Zod. **Never sends a client `payer_id`** (the token carries identity).
- `src/lib/payer-api.ts` — the **data seam**. Every surface calls the payer-authed API; the
  old in-memory mock store is deleted, so nothing here fabricates data.
- `src/lib/pricing-config.ts` — pure readers over the catalog products the caller passes in.
- `src/lib/live-catalog.ts` — the LIVE catalog fetch (D-6: `GET /payer/pricing/catalog`);
  `DEFAULT_CATALOG` is only the documented fetch-failure fallback (pages render a subtle
  "cached pricing" note — the server still enforces real prices at charge time).

## Env

| Var                                          | Where  | Default                 | Notes                                                                         |
| -------------------------------------------- | ------ | ----------------------- | ----------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`                        | client | `http://localhost:3001` | public, safe to ship                                                          |
| `NEXT_PUBLIC_ENVIRONMENT`                    | client | `development`           | public                                                                        |
| `NEXT_PUBLIC_ENABLE_AGENCY_PORTAL`           | client | `true`                  | public flag; gates the agency DEMAND sections on `/dashboard`. `false` hides them (the rest of the dashboard still renders). NOTE: **unset** = on; set-but-not-`true` (incl. empty) = off |
| `NEXT_PUBLIC_ENABLE_AGENCY_SUPPLY`           | client | `false`                 | public flag; parked supply-side shell (off)                                   |
| `NEXT_PUBLIC_ENABLE_AGENCY_KYC`              | client | `false`                 | public flag; parked (off)                                                     |
| `NEXT_PUBLIC_ENABLE_AGENCY_PAYOUTS`          | client | `false`                 | public flag; parked (off)                                                     |
| `NEXT_PUBLIC_ENABLE_AGENCY_BULK_UPLOAD`      | client | `false`                 | public flag; parked (off)                                                     |
| `NEXT_PUBLIC_ENABLE_AGENCY_OUTCOME_TRACKING` | client | `false`                 | public flag; parked (off)                                                     |
| `PAYER_AUTH_MODE`                            | server | `api`                   | `api` (LIVE backend payer-auth) or `mock` (local fallback); other = B-R1 gate |
| `PAYER_API_URL`                              | server | `http://localhost:3001` | server-side API base                                                          |
| `PAYER_SESSION_SECRET`                       | server | dev fallback            | HMAC key for the mock session cookie                                          |
| `PAYMENTS_ENABLE_REAL`                       | server | `false`                 | read flag (not a boot check): unset/other ⇒ `false` ⇒ mock top-up; `true` ⇒ Razorpay checkout. Flipping it is a human-gated, staging-first decision (`src/lib/server-config.ts`) |
| `PAYER_POSTING_FREE_THROUGH_LAUNCH`          | server | `true`                  | free-posting launch flag                                                      |

No server secret is ever read in a Client Component (`src/lib/server-config.ts` imports
`server-only`).

## Commands

```bash
pnpm --filter @badabhai/payer-web dev        # localhost:3002
pnpm --filter @badabhai/payer-web typecheck
pnpm --filter @badabhai/payer-web test
pnpm --filter @badabhai/payer-web build
```
