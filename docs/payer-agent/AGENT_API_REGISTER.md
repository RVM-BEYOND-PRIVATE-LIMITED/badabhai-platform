# Agency (Agent) API Register

**Status:** Route inventory + wiring COMPLETE. Implementation quality **NOT AUDITED** (dims 8–9).

**Guard legend:** `P` = `PayerAuthGuard` · `R` = `PayerRoleGuard` · `PE` =
`AgencyPayoutsEnabledGuard` · `I` = `InternalServiceGuard`.

Every agency controller carries `@PayerRoles("agent")` at **class** level, so an `employer`
session is 403'd across the whole surface. Verified in `agency/agency-role-authz.test.ts`.

---

## Agency job postings (the demand loop)

| Route | Guards | Frontend consumer | Wiring |
|---|---|---|---|
| `POST /payer/agency/jobs` | `P,R` | `agency/dashboard/jobs-actions.ts` | ✅ wired |
| `GET /payer/agency/jobs` | `P,R` | `agency-jobs-manager.tsx` | ✅ wired |
| `GET /payer/agency/jobs/:jobId` | `P,R` | `agency/jobs/[jobId]/page.tsx` | ✅ wired |
| `PATCH /payer/agency/jobs/:jobId` | `P,R` | `jobs-actions.ts` | ✅ wired |
| `POST /payer/agency/jobs/:jobId/close` | `P,R` | `jobs-actions.ts` | ✅ wired |
| `POST /payer/agency/jobs/:jobId/pause` | `P,R` | `jobs-actions.ts` | ✅ wired |

> **Asymmetry (`GAP-AGY-01`, P2).** The agency job surface has **no `resume`** and **no
> `quota-topup`**, while the employer twin has both. An agency can pause a vacancy but has no
> documented way to un-pause it from its own surface. Whether this is intentional (agencies
> re-open by editing) or an omission is an **open product question** — the employer path proves
> the capability exists in the domain.

## Invites, referrals & attribution

| Route | Guards | Frontend consumer | Wiring |
|---|---|---|---|
| `POST /payer/agency/invites` | `P,R` | `agency/dashboard/invite-actions.ts` | ✅ wired |
| `POST /payer/agency/invites/batch` | `P,R` | `batch-invite-actions.ts` | ✅ wired |
| `GET /payer/agency/referrals/summary` | `P,R` | `referral-funnel.tsx` | ✅ wired |
| **`POST /payer/agency/invites/:code/click`** | `P,R` | **NONE** | 🔴 **NOT CONNECTED** |
| `POST /invites/:code/click` (public twin) | — | `lib/invite-landing.ts:153` | ✅ wired |

> **`GAP-AGY-02` (P1 — security/attribution).** Two click sinks exist for the same concept. The
> agent-gated one has no caller; the **public, unauthenticated** one
> (`messaging/messaging.controller.ts:79`, IP-capped only) is what the `/i/[code]` landing page
> actually calls. This is the **only** raw `fetch` in `payer-web` outside `payer-http.ts`.
>
> Because attribution counts drive the agency referral funnel — and, once
> `AGENCY_PAYOUTS_ENABLED` flips, **money** — an unauthenticated click sink is an
> attribution-inflation surface bounded only by an IP rate cap. Assess before payouts go live.
> Not yet traced end-to-end (dimension 10).

## Agency worker visibility

| Route | Guards | Frontend consumer | Wiring |
|---|---|---|---|
| `GET /payer/agency/workers` | `P,R` | `agency/workers/worker-activity-list.tsx` | ✅ wired |

The surface is designed **faceless**: `lib/assert-no-agency-pii.ts` wraps agency payloads and
`agency/dashboard` re-asserts `requireAgent()` before rendering. Whether the API response mapper
can leak PII was **NOT audited** (dimension 9).

## Money — KYC, earnings, payouts (flag-gated OFF in alpha)

| Route | Guards | Frontend consumer | Wiring |
|---|---|---|---|
| `POST /payer/agency/kyc` | `P,R,PE` | `agency/referrals/supply-actions.ts` | ⚙️ wired, **404 in alpha** |
| `GET /payer/agency/kyc` | `P,R,PE` | `kyc-panel.tsx` | ⚙️ wired, **404 in alpha** |
| `GET /payer/agency/earnings` | `P,R,PE` | `earnings-panel.tsx` | ⚙️ wired, **404 in alpha** |
| `POST /payer/agency/payouts` | `P,R,PE` | `payout-panel.tsx` | ⚙️ wired, **404 in alpha** |
| `GET /payer/agency/payouts` | `P,R,PE` | `payout-panel.tsx` | ⚙️ wired, **404 in alpha** |

`AgencyPayoutsEnabledGuard` returns a **neutral 404** when `AGENCY_PAYOUTS_ENABLED` is false
(the default) — so no KYC/PAN/bank PII can even be collected. **Per the owner's alpha ruling this
is correct behaviour, not a defect.**

The obligation it creates is *honesty*: `agency/referrals/page.tsx:191-193` renders a
"Payouts coming soon" inert card when `getAgencyEarnings()` returns `null` on the 404. That reads
correctly. What was **not** verified is whether any surface renders a **zero** rather than an
*unavailable* — a user must never be shown "₹0 earned" when the truth is "earnings are not
tracked yet." Tracked as `GAP-XC-04`.

### Ops-side KYC (internal, no self-serve path)

| Route | Guards | Consumer |
|---|---|---|
| `GET /ops/agency-kyc/pending` | `I` | `apps/web` `/ops/agency-kyc` |
| `POST /ops/agency-kyc/:payerId/verify` | `I` | `apps/web` |
| `POST /ops/agency-kyc/:payerId/reject` | `I` | `apps/web` |

DB defect `PAY-DB-18` (P3): `agency_kyc.verified_by` is declared as the verification audit column
and is **never written** on any path — `markVerified` sets only `status` + `verified_at`
(`agency-kyc.repository.ts:88-99`). The repository docstring admits this. Honestly-documented
forward scaffolding rather than a defect, but it means the KYC audit trail has no actor.

---

## Parked / deliberately dead surfaces

These render in the portal but have **no code path**, gated by label-only
`NEXT_PUBLIC_ENABLE_AGENCY_*` flags (`lib/config.ts:86-93`):

| Surface | File | Posture |
|---|---|---|
| `/agency/revenue` | `agency/revenue/page.tsx:25` | "Coming soon" badge — renders no session data |
| `/agency/bulk-upload` | `agency/bulk-upload/page.tsx` | **Honest dead end**: *"Not available: consent violation … it will not be built."* |
| Dashboard parked cards ×4 | `agency/dashboard/parked-modules.tsx:31` | KYC / Payouts / Bulk Upload / Outcome Tracking |
| `/agency/dashboard` | `agency/dashboard/page.tsx` | Pure `redirect("/dashboard")` (MERGE-1) — modules render inline on the shared dashboard |

The bulk-upload page is a **model** for how a parked surface should behave: it states plainly
that the feature will not be built and why. Contrast with `GAP-XC-04`.

---

## Coverage summary

| | Count |
|---|---|
| Agency routes inventoried | **20** (16 payer-authed + 3 ops + 1 public twin) |
| Verified wired | **14** |
| Flag-gated to 404 in alpha (by design) | **5** |
| Backend exists, frontend not connected | **1** (`invites/:code/click`) |
| Parked surfaces with no code path | **4** |
| Implementation quality classified | **0** — dimension 8 did not run |

---

## The agency data model (from the completed DB audit)

Agency tables carry a **real FK to `payers.id`** (`referral.ts:115-117,190-192,230-232,266-268`),
unlike the money/entitlement tables, which have none. `DATABASE_AUDIT.md` `PAY-DB-03` records
this split posture as an ambiguity requiring an owner ruling — the "faceless rails" rationale it
cites (ADR-0010 §Decision 0, *"NO payers table"*) is **no longer true**, and that ADR has no file
on `main` to re-read.

Three agency reads are **unbounded** (no `LIMIT`) — `PAY-DB-07`:
`AgencyJobsRepository.listOwned`, `AgencyKycRepository.listByStatus` (the ops queue),
`AgencyPayoutRepository.listRequests`. One-line fixes.
