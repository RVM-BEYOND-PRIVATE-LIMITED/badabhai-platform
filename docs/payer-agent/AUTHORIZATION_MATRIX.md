# Authorization Matrix — Payer + Agency

**Status:** Model + guard inventory COMPLETE. **Per-route IDOR/BOLA verification NOT AUDITED**
(dimension 9) — the single most important remaining gap in this audit.

---

## Four principals, four independent credentials

| Principal | Session store | JWT secret | `typ` claim | Redis namespace |
|---|---|---|---|---|
| Worker | `auth/session.service.ts` | `JWT_SECRET` | — | `session:<sid>` |
| **Payer** | `payers/payer-session.service.ts` | `JWT_SECRET` | `"payer"` | `payer_session:<sid>` |
| Admin | `admin/admin-session.service.ts` | **`ADMIN_JWT_SECRET`** | `"admin"` | `admin_session:<sid>` |
| Internal service | shared header secret | — | — | — |

Horizontal isolation between principals is by secret + `typ` + namespace, asserted by tests.

---

## Guards on the payer/agency surface

| Guard | File | Enforces | Failure mode |
|---|---|---|---|
| `PayerAuthGuard` | `payers/payer-auth.guard.ts:83` | Bearer JWT → session; **also re-reads `{role,status}` from the `payers` row every request** | 401 missing row; **403** if `status !== "active"` |
| `PayerRoleGuard` | `payers/payer-role.guard.ts:50` | `@PayerRoles(...)` metadata | 403 — **but a NO-OP when metadata is absent** ⚠️ |
| `PayerOrgRoleGuard` | `payers/payer-org-role.guard.ts:65` | resolves the caller's single ACTIVE `payer_members` row → `req.payerOrg` | 403, **fail-closed** on no membership or resolve error |
| `AgencyPayoutsEnabledGuard` | `agency/agency-payouts-enabled.guard.ts:14` | `AGENCY_PAYOUTS_ENABLED` | neutral **404** |
| `InternalServiceGuard` | `common/guards/internal-service.guard.ts:26` | constant-time compare of `x-internal-service-token` | **deny-all when the secret is unset** |

### The asymmetry that matters

| Guard | Missing metadata means… |
|---|---|
| `AdminRolesGuard` | **403 — fails closed** |
| `PayerRoleGuard` | **passes — fails OPEN** ⚠️ |
| `ConsentGuard` | passes (pre-V9 behaviour) |

> A forgotten `@RequireAdminRole` denies everyone. A forgotten `@PayerRoles` **silently widens
> the route to any authenticated payer.** This is documented and intentional, but it is a live
> footgun — and `GAP-FE-06` records one route family (`/payer/job-postings/*`) that has no
> `@PayerRoles` today, so an `agent` session can reach the employer surface.

---

## Effective guards by route family

| Route family | Guards | Role gate |
|---|---|---|
| `POST /payer/{signup,login/request,login/verify}` | — | public, IP-capped |
| `/payer/me`, `/payer/refresh`, `/payer/logout` | `P` | any active payer |
| `/payer/credits/*`, `/payer/unlocks/*` | `P` | any active payer — **no Owner gate** ⚠️ |
| `/payer/job-postings/*` | `P` | **none** ⚠️ `GAP-FE-06` |
| `/payer/capacity`, `/payer/pricing/catalog`, `/payer/reach/*`, `/payer/match/*` | `P` | any active payer |
| `/payer/job-posting-chat/*` | `P` | any active payer |
| `GET /payer/org/members` | `P`,`ORG` | any active org member |
| `POST /payer/org/members`, `DELETE /payer/org/members/:id` | `P`,`ORG` | **`@OrgRoles("owner")`** |
| `/payer/agency/*` | `P`,`R` | **`@PayerRoles("agent")`** (class level) |
| `/payer/agency/{kyc,earnings,payouts}` | `P`,`R`,`PE` | agent + flag → else neutral 404 |
| `/ops/agency-kyc/*` | `I` | internal service token |

### The Owner gap on money

> **`GAP-AUTHZ-01` (P1 — pending dimension 9).** `@OrgRoles("owner")` is applied **only** to
> `/payer/org/members`. The frontend's own model says billing/wallet is Owner-only
> (`org-roles.ts:16`), and `/credits` is gated by `requireOwner()` in the UI — but
> `/payer/credits` and `/payer/unlocks` carry **only `PayerAuthGuard`** on the backend.
>
> If a Recruiter ever obtains a session, the frontend 404 is **cosmetic**: `curl` with their JWT
> reaches the org's money endpoints directly. This is latent today only because `getOrgRole()`
> means no one is ever an Owner and, per `PAY-DB-01`, credits are scoped to the individual
> `payer_id` rather than the org — so there is no shared balance to spend yet. **It becomes a
> live P0 the moment org tenancy lands.** Fix the backend gate in the same change as the
> migration, never after.

---

## Row-level scoping

`apps/api/src/payers/payer-scope.ts` provides:

- `assertPayerOwns(authPayerId, rowPayerId)` → flat 403, no existence oracle
- `assertOwnedRows(...)` for list reads
- `readOwnedById(...)` → fetch then assert; `undefined` → neutral 404

Org-scoped writes bind to `req.payerOrg.orgId`, **never** a body value. Org repo reads carry
`eq(payerMembers.orgId, orgId)` in the WHERE.

**Which routes actually call these was NOT audited.** Every `:id` route on the payer surface is
an unverified IDOR candidate until dimension 9 runs. The file header itself
(`payer-scope.ts:1-15`) states that DB-enforced RLS remains an open GA gate.

---

## Database-level authorization: none

All 65 tables: `ENABLE` + `FORCE ROW LEVEL SECURITY` + `REVOKE ALL` from `PUBLIC`/`anon`/
`authenticated`/`service_role`. **Zero `CREATE POLICY` statements repo-wide.** The API connects
as a `BYPASSRLS` role and sets no per-request session context.

This is a **Data-API lockout**, not tenant isolation. Risk posture:

- A leaked Supabase `anon`/`service_role` key exposes **nothing** — every Data-API role is
  revoked. This is a genuine strength.
- A bug in any application-layer WHERE clause is **the entire boundary**. There is no second
  line of defence. Any missing `payer_id` predicate is a direct cross-tenant read.

---

## Frontend gates (defence in depth only)

| Gate | File | Behaviour |
|---|---|---|
| `requirePayer()` | `lib/auth/index.ts:25` | `redirect("/login")` |
| `requireAgent()` / `requireEmployer()` | `lib/auth/roles.ts:37,42` | **neutral `notFound()`** |
| `requireOwner()` / `requireRecruiter()` | `lib/auth/org-roles.ts:64,78` | **neutral `notFound()`** |

The neutral-404 discipline is consistently applied: a Recruiter cannot learn that an Owner-only
route exists. Cookie `bb_payer_token` is `httpOnly`, `sameSite: "lax"`, `secure` computed by
`shouldUseSecureCookie()` (`session-cookie.ts:24`). **No localStorage/sessionStorage anywhere.**

CSRF posture on Server Actions relies on Next 15's built-in origin check — **not independently
verified** (dimension 9).
