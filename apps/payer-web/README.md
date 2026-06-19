# @badabhai/payer-web — external self-serve payer portal

**Status:** ADR-0019 **Phase 1 — MOCK + STAGING-ONLY.** Not for open external GA.
A `bb-security-review` PASS on this surface is required before merge (E-R1).

This is a **distinct external app** (public origin), separate from the internal ops
console (`apps/web`) — ADR-0019 Decision A. Three principals stay separate: worker,
**payer**, ops. This app talks only to the payer-scoped surface; it never reaches the
ops console's privileged data access.

## The demand loop

1. **Mock login** — swappable `PayerAuth` seam (`src/lib/auth/`). Phase 1 ships only
   the `mock` provider (httpOnly HMAC-signed session cookie). A real IdP (B-R1, OPEN)
   replaces `mock-provider.ts` alone.
2. **Dashboard** — the payer's own postings, credit balance, unlock history.
3. **Post a job** — free-through-launch (surfaced from a config flag, never a hardcoded ₹0).
4. **Applicant feed** — faceless, banded: opaque id + trade + experience band + city +
   skills. No name/phone/employer.
5. **Unlock** — spend a mock credit; no-oracle neutral response on any deny cause.
6. **Masked resume reveal** — masked initials ("R\*\*\*\*\* K."), no phone, no raw name.
7. **Credit top-up** — MOCK ledger only; packs from config; no real payments.

## Architecture seams

- `src/lib/auth/` — the **PayerAuth seam** (the single module a real IdP swaps in).
- `src/lib/payer-api.ts` — the **data seam**. Every call resolves the payer from the
  SERVER-HELD session (never a client param) and validates outputs against the Zod
  contracts in `src/lib/contracts.ts`.
- `src/lib/mock-store.ts` — in-memory, payer-scoped mock data. **Why mock:** the backend
  has no payer-scoped route group bound to `PayerAuthGuard` yet (the existing
  unlock/disclosure/posting-plan controllers sit behind `InternalServiceGuard` and take
  `payer_id` from the body; `PayersModule` is not in `AppModule`). Swapping to the real
  API is a `payer-api.ts`-only change — the contracts already match the wire shapes.
- `src/lib/pricing-config.ts` — prices sourced from `@badabhai/pricing` `DEFAULT_CATALOG`.

## Env

| Var | Where | Default | Notes |
|-----|-------|---------|-------|
| `NEXT_PUBLIC_API_URL` | client | `http://localhost:3001` | public, safe to ship |
| `NEXT_PUBLIC_ENVIRONMENT` | client | `development` | public |
| `PAYER_AUTH_MODE` | server | `mock` | only `mock` authorized in Phase 1 (B-R1) |
| `PAYER_API_URL` | server | `http://localhost:3001` | server-side API base |
| `PAYER_SESSION_SECRET` | server | dev fallback | HMAC key for the mock session cookie |
| `INTERNAL_SERVICE_TOKEN` | server | unset | interim guard secret (server-only) |
| `PAYMENTS_ENABLE_REAL` | server | `false` | **must be false** — boot fails closed if true |
| `PAYER_POSTING_FREE_THROUGH_LAUNCH` | server | `true` | free-posting launch flag |

No server secret is ever read in a Client Component (`src/lib/server-config.ts` imports
`server-only`).

## Commands

```bash
pnpm --filter @badabhai/payer-web dev        # localhost:3002
pnpm --filter @badabhai/payer-web typecheck
pnpm --filter @badabhai/payer-web test
pnpm --filter @badabhai/payer-web build
```
