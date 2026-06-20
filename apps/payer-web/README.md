# @badabhai/payer-web

Self-serve **Company / Agency payer web app** (Next.js App Router) — the SEPARATE,
public-origin client from ADR-0019 Decision A. Distinct from the internal ops
console (`@badabhai/web`). Phase 1 is a **mock + staging-only** skeleton that closes
the R16 / LC-1 PayerAuthGuard loop with a real client.

## Pages

| Route        | Purpose                                                           |
| ------------ | ---------------------------------------------------------------- |
| `/`          | landing — sign-in CTA or "go to dashboard" if a session exists   |
| `/auth`      | role-aware signup (Company / Agency) + OTP/invite login          |
| `/dashboard` | authenticated — own credit balance + own unlocks                 |

## What it talks to (real payer endpoints)

- `POST /payer/signup` · `POST /payer/login/request` · `POST /payer/login/verify` · `POST /payer/logout`
- `GET /payers/:id/credits` (`:id` is the **session** payer) · `GET /unlocks`

The Bearer **payer session token** is held client-side only (`localStorage`). Every
authenticated response is read for a rolling **`x-session-token`** header and, when
present, the stored token is replaced.

## Run

```bash
pnpm --filter @badabhai/payer-web dev        # http://localhost:3002
pnpm --filter @badabhai/payer-web build
pnpm --filter @badabhai/payer-web typecheck
```

## Config & privacy

| Env var                   | Default                 | Notes                                  |
| ------------------------- | ----------------------- | -------------------------------------- |
| `NEXT_PUBLIC_API_BASE_URL`| `http://localhost:3001` | API origin the SPA calls               |
| `NEXT_PUBLIC_ENVIRONMENT` | `development`           | shown in the footer (label only)       |

- **No server secret ever reaches this app.** It reads only `NEXT_PUBLIC_*` and holds
  only the payer's own Bearer token. No `JWT_SECRET`, service-role, or API secret.
- **Renders only the authenticated payer's own data.** The `:payerId` path is taken
  from the session identity, never a user input. Tenant isolation is enforced
  server-side (`PayerAuthGuard` + `assertPayerOwns`).
- **Mock + staging only.** `PAYMENTS_ENABLE_REAL=false`; no real payment UI. A credit
  "pack" purchase is a mock action at most and is currently omitted.
- **No worker PII.** The only PII handled is the payer's own login email.
