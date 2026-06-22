# Agency portal (frontend) — DEMAND shell

> Internal frontend reference for the agency slice in `apps/payer-web`. The agency is
> an existing **payer with `role='agent'`** (ADR-0019) — there is NO separate agency
> entity or auth model. The DEMAND loop (post → browse faceless → unlock → credits) is
> SHARED by `employer` and `agent`; role differences are LABELS only.

## What shipped (build-now slice)

- **Route:** `(portal)/agency/dashboard` — a read-only, faceless agency dashboard.
  - First statement is `await requireAgent()` → an `employer` session gets a NEUTRAL
    `notFound()` (404), decided SERVER-side off the signed session (never a client hide).
  - Additionally gated on `NEXT_PUBLIC_ENABLE_AGENCY_PORTAL` (default ON); off → the
    route `notFound()`s.
- **Nav:** an "Agency dashboard" link in the `(portal)` layout for `role==='agent'` only
  (cosmetic; the real gate is `requireAgent` server-side). The existing parked
  "Referrals & payouts" link is kept.
- **Faceless guard:** `src/lib/assert-no-agency-pii.ts` — every payload crosses it at the
  render boundary (dev/test: throws on a forbidden key; prod: strips + warns with the key
  path only).
- **Feature flags:** `src/lib/config.ts` `agencyFlags()` — public `NEXT_PUBLIC_*` booleans
  only (no secrets), all fail-closed.

### Dashboard sections

| Section                                                                        | Source                                 | State                                                                  |
| ------------------------------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------- |
| Identity card (role "Agency", org label, account status)                       | `getAgencyAccount()` → `GET /payer/me` | **LIVE**                                                               |
| Credit balance                                                                 | `getCredits()` → `GET /payer/credits`  | **LIVE**                                                               |
| Contacts unlocked (count)                                                      | `getUnlocks()` → `GET /payer/unlocks`  | **LIVE**                                                               |
| Demand job summary (total/open/closed/paused/draft)                            | `getPostings()` (mock store)           | **MOCK** (preview-labelled)                                            |
| Jobs list/table (view·edit·pause·close)                                        | reuses `PostingsManager`               | **MOCK** (preview-labelled)                                            |
| Counts with no backend source (reached / eligible / consented / invite-intent) | —                                      | render `—` + "not available yet" (never fabricated)                    |
| Invite intent                                                                  | — (no agency invite API)               | **DISABLED** "Generate invite link (coming soon)" + consent-first copy |
| Parked module cards (KYC / Payouts / Bulk Invite Upload / Matching·Outcome)    | flags                                  | disabled, informational                                                |

## Parked / dead / deferred

- **KYC** — Parked: legal/DPDP sign-off required.
- **Payouts** — Parked: real payments + product-ratified params required.
- **Bulk Invite Upload** — Not available: consent violation (DEAD; never built).
- **Matching / Outcome Tracking** — Deferred by product lock.

Each is a disabled card tied to its flag (`NEXT_PUBLIC_ENABLE_AGENCY_{KYC,PAYOUTS,
BULK_UPLOAD,OUTCOME_TRACKING}`, all default OFF). A flag ON only re-labels the card; it
builds nothing. Building any of these is a STOP+escalate (CLAUDE.md §8).

## Faceless boundary

The agency sees ONLY: opaque worker IDs, counts, status enums, timestamps, and its OWN
org label. NEVER: worker name/phone/email/address, raw resume bytes, or unconsented data
(CLAUDE.md §2 #2 + #6). `assertNoAgencyPII()` is the last-line defence: even a regressed
backend payload carrying a forbidden key does not render — in prod the key is stripped, in
dev/test the build/test fails loudly. The error/warning carries the key PATH only, never a
value.

Jobs are **OPEN / CLOSED / PAUSED / DRAFT** only — there is NO hire-outcome / interview /
selected / hired stage (product-locked).

## Feature flags (public, `NEXT_PUBLIC_*`)

Documented in `apps/payer-web/.env.example`. Read via `agencyFlags()` (validated, cached),
never `process.env` directly in a component.

| Flag                                         | Default | Purpose                                         |
| -------------------------------------------- | ------- | ----------------------------------------------- |
| `NEXT_PUBLIC_ENABLE_AGENCY_PORTAL`           | `true`  | Gate the agency DEMAND shell. Off → routes 404. |
| `NEXT_PUBLIC_ENABLE_AGENCY_SUPPLY`           | `false` | SUPPLY (referral funnel) — Phase-2, CEO-gated.  |
| `NEXT_PUBLIC_ENABLE_AGENCY_KYC`              | `false` | KYC — legal/DPDP gate.                          |
| `NEXT_PUBLIC_ENABLE_AGENCY_PAYOUTS`          | `false` | Payouts — real-payments/product gate.           |
| `NEXT_PUBLIC_ENABLE_AGENCY_BULK_UPLOAD`      | `false` | Bulk invite upload — DEAD (consent).            |
| `NEXT_PUBLIC_ENABLE_AGENCY_OUTCOME_TRACKING` | `false` | Matching/outcome — deferred.                    |

## Route map

- `(portal)/agency/dashboard` — agency DEMAND dashboard (NEW).
- `(portal)/agency/referrals` — existing static PARKED supply note (kept).
- Shared DEMAND routes (both roles): `/dashboard`, `/postings`, `/postings/new`,
  `/postings/[id]/applicants`, `/capacity`, `/credits`.

## API dependencies

- **LIVE (payer-authed, Bearer only — XB-A):** `GET /payer/me`, `GET /payer/credits`,
  `GET /payer/unlocks`.
- **MOCK (no payer-authed endpoint yet):** job create/list/pause/close (the postings seam
  serves from the session-scoped mock store). ESCALATE to backend for payer-authed
  `GET/POST /payer/job-postings` + lifecycle/quota endpoints.
- **NON-FUNCTIONAL:** there is NO agency-callable invite API. `POST /invites` is
  WORKER-authed (mints a worker's OWN link). The invite control is therefore DISABLED — it
  generates no link and fakes no success.

## Testing checklist

- `requireAgent` admits an agent / 404s an employer; agency routes gated by
  `ENABLE_AGENCY_PORTAL` (`auth/roles.test.ts`, `dashboard.test.tsx`).
- `assertNoAgencyPII` throws (dev/test) / strips (prod) on a name/phone payload; passes on
  faceless data (`assert-no-agency-pii.test.ts`).
- Dashboard renders identity/summary; invite control is DISABLED and its copy contains the
  consent requirement; NO referral/payout/KYC/bulk input controls exist (negative test)
  (`dashboard.test.tsx`, `invite-panel.test.tsx`, `parked-modules.test.tsx`).
- Job-status map open/closed/paused/draft (`agency-summary.test.ts`).
- No-PII / horizontal-authz: a worker name/phone in a mocked payload is NOT rendered
  (`dashboard.test.tsx`).
- API-error normalization for the agency reads (`agency-reads.test.ts`).

## Gates

`pnpm turbo run typecheck lint test build --filter @badabhai/payer-web` green; all touched
code files `prettier --check` clean.
