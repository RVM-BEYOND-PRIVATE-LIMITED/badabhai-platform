# @badabhai/payer-web — external self-serve payer portal

**Status:** ADR-0019 **Phase 1 — MOCK + STAGING-ONLY.** Not for open external GA.
A `bb-security-review` PASS on this surface is required before merge (E-R1).

This is a **distinct external app** (public origin), separate from the internal ops
console (`apps/web`) — ADR-0019 Decision A. Three principals stay separate: worker,
**payer**, ops. This app talks only to the payer-scoped surface; it never reaches the
ops console's privileged data access.

## The demand loop (LIVE vs WAITING)

1. **Login (LIVE)** — `PayerAuth` seam (`src/lib/auth/`). Phase-1 LIVE mode is `api`:
   the backend payer-auth OTP routes (`/payer/login/request` → `/payer/login/verify`)
   mint a payer JWT stored in an httpOnly server cookie. `mock` stays as a local/test
   fallback. A third-party IdP/MFA is B-R1 (a separate human gate).
2. **Dashboard** — LIVE credits (`GET /payer/credits`) + LIVE unlocks (`GET
/payer/unlocks`); postings are still **WAITING** (mock — no payer-authed endpoint).
3. **Post a job (WAITING)** — mock; `posting-plans` is `InternalServiceGuard`. ESCALATE.
4. **Applicant feed (LIVE)** — `GET /payer/reach/jobs/:jobId/applicants`: faceless ranked
   rows (opaque id + rank/score/hot + signal reasons). No name/phone/employer. (The
   banded taxonomy labels are not yet in this projection — ESCALATE.)
5. **Unlock (LIVE)** — `POST /payer/unlocks`; no-oracle neutral on any deny cause.
6. **Reveal (LIVE)** — `POST /payer/unlocks/:id/reveal` → a **routed relay handle**
   (opaque, expiring) — **never a raw phone**.
7. **Masked resume (WAITING)** — mock preview; `resume-disclosures` is
   `InternalServiceGuard`. ESCALATE.
8. **Credit top-up (WAITING)** — MOCK ledger only; packs from config; no real payments.

## Architecture seams

- `src/lib/auth/` — the **PayerAuth seam**. `http-provider.ts` is the LIVE backend
  payer-auth driver; `mock-provider.ts` is the local fallback; the seam is selected by
  `PAYER_AUTH_MODE`.
- `src/lib/payer-http.ts` — server-only typed transport to the payer-authed API: reads
  the payer JWT from the httpOnly cookie, sends `Authorization: Bearer`, validates every
  response with Zod. **Never sends a client `payer_id`** (the token carries identity).
- `src/lib/payer-api.ts` — the **data seam**. LIVE surfaces call the real API; WAITING
  surfaces (postings, top-up purchase, masked resume) keep a clearly-flagged mock path.
- `src/lib/mock-store.ts` — in-memory, payer-scoped mock for the WAITING surfaces only.
- `src/lib/pricing-config.ts` — pure readers over the catalog products the caller passes in.
- `src/lib/live-catalog.ts` — the LIVE catalog fetch (D-6: `GET /payer/pricing/catalog`);
  `DEFAULT_CATALOG` is only the documented fetch-failure fallback (pages render a subtle
  "cached pricing" note — the server still enforces real prices at charge time).

## Env

| Var                                          | Where  | Default                 | Notes                                                                         |
| -------------------------------------------- | ------ | ----------------------- | ----------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`                        | client | `http://localhost:3001` | public, safe to ship                                                          |
| `NEXT_PUBLIC_ENVIRONMENT`                    | client | `development`           | public                                                                        |
| `NEXT_PUBLIC_ENABLE_AGENCY_PORTAL`           | client | `true`                  | public flag; gates the agency DEMAND surface (set `false` to roll back)       |
| `NEXT_PUBLIC_ENABLE_AGENCY_SUPPLY`           | client | `false`                 | public flag; parked supply-side shell (off)                                   |
| `NEXT_PUBLIC_ENABLE_AGENCY_KYC`              | client | `false`                 | public flag; parked (off)                                                     |
| `NEXT_PUBLIC_ENABLE_AGENCY_PAYOUTS`          | client | `false`                 | public flag; parked (off)                                                     |
| `NEXT_PUBLIC_ENABLE_AGENCY_BULK_UPLOAD`      | client | `false`                 | public flag; parked (off)                                                     |
| `NEXT_PUBLIC_ENABLE_AGENCY_OUTCOME_TRACKING` | client | `false`                 | public flag; parked (off)                                                     |
| `PAYER_AUTH_MODE`                            | server | `api`                   | `api` (LIVE backend payer-auth) or `mock` (local fallback); other = B-R1 gate |
| `PAYER_API_URL`                              | server | `http://localhost:3001` | server-side API base                                                          |
| `PAYER_SESSION_SECRET`                       | server | dev fallback            | HMAC key for the mock session cookie                                          |
| `PAYMENTS_ENABLE_REAL`                       | server | `false`                 | **must be false** — boot fails closed if true                                 |
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
