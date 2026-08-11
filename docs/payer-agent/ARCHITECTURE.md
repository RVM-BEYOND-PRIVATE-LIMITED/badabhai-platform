# Architecture — Payer + Agency Surface

**Status:** COMPLETE. Every claim below was read from the repository.
See `AUDIT_STATUS.md` for what was *not* audited.

---

## 1. The headline correction

> **There is no separate "Agent Web Application."**

There is exactly **one** Next.js portal — `apps/payer-web` (port 3002) — and it serves both
personas. The persona is the **account role** on the signed session:

```ts
// apps/payer-web/src/lib/auth/types.ts
export type PayerRole = "employer" | "agent";
```

`employer` = a company. `agent` = an agency using the *same* demand loop as a company.
Agency-specific pages are a plain path segment, `(portal)/agency/*` — not a route group, not a
separate app, not a separate deployment.

**Owner ruling (2026-08-11):** keep the single role-scoped app. This audit therefore reports
two *registers* (Payer / Agency) over one codebase.

### Two independent role dimensions

| Dimension | Values | Source | Decides |
|---|---|---|---|
| **Account role** | `employer` \| `agent` | `payers.role`, via the signed session | Which product surface + labels |
| **Org role** | `owner` \| `recruiter` | `payer_members.org_role` | What a member may do inside their org |

The org role is **not yet on the session** — see the P0 in §6.

---

## 2. Monorepo shape

```
apps/
  api          NestJS 11 + Drizzle + BullMQ      :3001   the single backend
  payer-web    Next 15 App Router + React 19     :3002   EXTERNAL payer portal (Company + Agency)
  web          Next 15                           :3000   INTERNAL ops console (/ops/*)
  admin-web    Next 15                           :3003   INTERNAL admin portal
  ai-service   Python / FastAPI                  :8000   the single LLM call boundary (DB-free)
  worker-app   Flutter                                   worker mobile app
  payer-app    Flutter                                   Company + Agency mobile app
packages/      config db types validators event-schema ai-contracts pricing
               match-engine reach-engine reach-learn taxonomy profiling-lexicon
tests/e2e      @badabhai/e2e — Vitest E2E suite
```

`apps/ai-service` and both Flutter apps are deliberately **outside** the pnpm workspace
(`pnpm-workspace.yaml`).

### No shared frontend packages — three-way duplication

There is **no `packages/ui`, no shared API client, and no shared contracts package.** Each Next
app carries its own copy:

| Concern | payer-web | admin-web |
|---|---|---|
| HTTP client | `src/lib/payer-http.ts` | `src/lib/admin-http.ts` |
| Wire contracts | `src/lib/contracts.ts` | `src/lib/entities.ts`, `events.ts` |
| Design system | `src/components/ds/` (24 primitives) | its own copy |

`apps/admin-web` has **zero** workspace dependencies by design. This is the single largest
maintainability liability on the web side and the prerequisite for any future app split.

There is **no Tailwind anywhere in the repo.** The DS is CSS custom properties
(`apps/payer-web/src/styles/tokens.css`, 545 lines) + `.bb-*` component classes
(`ds-components.css`, 559 lines) + `globals.css` (4,099 lines), with typed React wrappers.
`eslint.config.mjs:79-121` bans raw hex and `px` literals in payer-web and admin-web sources.

> **Note:** `tokens.css:3` cites `docs/design/BadaBhai Design System/` as its source of truth.
> **That directory does not exist in the repository.** The tokens have no upstream.

---

## 3. Backend module map (payer/agency relevant)

`apps/api` registers 62 controllers / ~190 routes and sets **no global prefix** — every path
below is the literal URL.

| Module | Controllers | Prefix |
|---|---|---|
| `payer-portal/` | payer-auth, payer-capacity, payer-disclosure, payer-job-postings, payer-org-invites, payer-org-members, payer-pricing, payer-reach, payer-unlocks, job-posting-chat | `payer`, `payer/*` |
| `payers/` | payer-account | `payer` |
| `agency/` | agency-jobs, agency-invites, agency-workers, agency-payouts, agency-kyc-ops | `payer/agency`, `ops/agency-kyc` |
| `match/` | match-skills | `payer/match` |
| `unlocks/` | unlocks (internal), razorpay-webhook | root, `payments/razorpay` |
| `job-postings/`, `posting-plans/`, `pricing/`, `reach/`, `pace/`, `events/`, `disclosures/` | internal twins of several payer routes | various |

### Duplicate surfaces (internal twin ↔ payer-authed)

Four capabilities exist **twice**, once behind `InternalServiceGuard` and once behind
`PayerAuthGuard`:

| Capability | Internal route | Payer route |
|---|---|---|
| Job postings | `/job-postings/*` | `/payer/job-postings/*` |
| Credits | `/payers/:payerId/credits` | `/payer/credits` |
| Unlocks | `/unlocks/*` | `/payer/unlocks/*` |
| Capacity | `/payers/:payerId/capacity` | `/payer/capacity` |
| Pricing catalog | `GET`/`PUT /pricing/catalog` | `GET /payer/pricing/catalog` |

**Whether the two paths share a service and enforce identical state-machine rules was NOT
audited** (dimension 16). If they diverge, an ops action can create a state the payer path
forbids. This is tracked as `GAP-XC-05`.

---

## 4. Frontend data layer

The seam is **server-only and singular**:

```
RSC page / Server Action
  → apps/payer-web/src/lib/payer-api.ts        (domain seam, ~1440 lines, "server-only")
    → apps/payer-web/src/lib/payer-http.ts     (the ONLY fetch, "server-only")
      → Authorization: Bearer <jwt from httpOnly cookie bb_payer_token>
        → apps/api
```

Properties verified by reading `payer-http.ts`:

- `import "server-only"` — the JWT never enters the client bundle.
- API base is `PAYER_API_URL` (**not** `NEXT_PUBLIC_*`) — the browser never learns the API origin.
- **Never sends a client-supplied `payer_id`**; the backend derives it from `req.payer.id`.
- Every response is `schema.parse(...)`'d — a contract drift is a **hard throw**, not a silent
  `undefined`. This makes dimension 11 (contract parity) a P0-class risk area.
- `cache: "no-store"` on every request — no caching layer anywhere.

**Mocks are gone.** `src/lib/mock-store.ts` and `src/lib/auth/mock-provider.ts` were deleted;
`payer-api.test.ts:966` actively asserts the source no longer references them.
`lib/auth/index.ts:15` returns the HTTP provider unconditionally.

Mutations are Next **Server Actions** (`app/**/actions.ts`), not route handlers — there is no
`route.ts` anywhere in the app, and **no `middleware.ts`**. Route protection is per-layout /
per-page RSC gating.

> A Server Action is a public POST endpoint. The page-level gate does **not** protect it. Whether
> each action re-derives the session server-side was **NOT audited** — `GAP-XC-01`, the single
> highest-priority open question in this audit.

---

## 5. Request pipeline (apps/api)

| Stage | Where | Note |
|---|---|---|
| 9 fail-closed config asserts | `main.ts:31-38` | refuses to boot on half-configured real paths / dev secrets outside dev |
| Razorpay raw-body middleware | `main.ts:78` | scoped to one path so no other body is retained in memory |
| trust-proxy hop count | `main.ts:84-89` | a hop **count**, never blanket `true` |
| global exception filter | `main.ts:91` | |
| CORS allow-list | `main.ts:94` | deny-all if `CORS_ALLOWED_ORIGINS` unset outside dev |
| **global guard** | — | **none.** No `APP_GUARD`. Every route's posture is an explicit `@UseGuards` |
| **global ValidationPipe** | — | **none.** `useGlobalPipes` is never called |

**Validation is opt-in per parameter** via `ZodValidationPipe`
(`common/pipes/zod-validation.pipe.ts`), applied as `@Body(new ZodValidationPipe(Schema))`.
This is a sound pattern, but it means **any route that omits the pipe has zero input
validation**. Enumerating the omissions across the payer/agency surface was **NOT audited**
(`GAP-XC-03`).

---

## 6. Tenancy — the structural P0

Three layers were designed; only two exist.

| Layer | Mechanism | State |
|---|---|---|
| Vertical (which route class) | `PayerRoleGuard` + `@PayerRoles("agent")` | **Live** |
| Org RBAC (which org action) | `PayerOrgRoleGuard` + `@OrgRoles("owner")` | **Live, but only on `/payer/org/members`** |
| Horizontal (which rows) | `payers/payer-scope.ts` — app-layer only | **Live, app-layer only** |

### Row-level security is a lockout, not isolation

Every one of the 65 tables carries `ENABLE` + `FORCE ROW LEVEL SECURITY` + `REVOKE ALL` from
`PUBLIC`/`anon`/`authenticated`/`service_role`. **There is not one `CREATE POLICY` in the
repository.** With FORCE and zero policies, every non-`BYPASSRLS` role is denied everything —
this is a Supabase Data-API lockout.

The API deliberately bypasses it: `database/database.module.ts:11-21` connects as a `BYPASSRLS`
role. There is **no per-request DB session context** — the only `SET LOCAL` calls in the
codebase are planner tuning (`hnsw.ef_search`, `pg_trgm.word_similarity_threshold`), not
security.

**All tenant isolation is therefore application-layer only.** `payer-scope.ts:1-15` states this
itself and names DB-enforced RLS as an open GA gate.

### The org tenancy hole (P0 — `PAY-DB-01`)

`org_id` exists on **exactly one table in the entire schema**: `payer_members`
(`packages/db/src/schema/payer.ts:133`). All 19 payer-owned business tables — `unlocks`,
`payer_credits`, `credit_ledger`, `posting_plans`, `job_postings`, `payment_orders`, the agency
tables, the chat tables — are scoped **only** by the individual login's `payer_id`.
`payer_orgs.root_payer_id` is written by `ensureSoloOrg` and **never read as a data-access
scope**.

Consequently an invited recruiter holds their own `payers.id`, and every business read returns
their own empty tenant.

> **The Team feature is not "stubbed in the frontend." It is unrepresentable at the data layer.**
> `apps/payer-web/src/lib/auth/org-roles.ts:46-56` hard-returns `"recruiter"` outside dev, so
> `requireOwner()` 404s and `/credits` + `/team` are unreachable for every real user. **Fixing
> that stub first would expose empty pages, not working ones.** The data model must be settled
> before the gate is opened. See `DATABASE_AUDIT.md` ambiguity 1 for the three options and the
> recommended ruling.

---

## 7. Test, CI and deploy posture

| Surface | Tests | Note |
|---|---|---|
| `apps/api` | 278 colocated `*.test.ts` | coverage floor 75/75/73/75 |
| `apps/payer-web` | 83 files, unit/SSR only | `renderToStaticMarkup`; **no coverage threshold** |
| `tests/e2e` | 12 suites | all env-gated; **4 are hard `describe.skip`** including `payer-tenancy`, `phase1-flow`, `payer-capacity` |
| `tests/contract`, `tests/security` | **empty** — README only | |

**There is no Playwright, Cypress, or testing-library anywhere in the repository.** There are
zero browser tests and zero live HTTP tests against the payer surface.

CI (`.github/workflows/ci.yml`): the `node` job has **no path filter**, so payer-web is linted
(incl. the DS token gate), oxlinted, typechecked, unit-tested and `next build`-ed on every PR.
The `e2e` job does **not** list `apps/payer-web`. `ci-required` is the only required check.

> **`apps/payer-web` is never built or deployed by any workflow.** `staging-cd.yml:172`
> explicitly skips the Next.js apps. There is no hosting configuration for the portal.
> How it reaches production is an open question — `GAP-XC-06`.

---

## 8. Feature flags gating the surface

All use `booleanFromString` and default **OFF** (`packages/config/src/server.ts`).

| Flag | Effect when off (the default) |
|---|---|
| `AGENCY_PAYOUTS_ENABLED` | neutral **404** on the entire agency money surface (KYC, earnings, payouts) |
| `PAYMENTS_ENABLE_REAL` | neutral 404 on `/payer/credits/order` + `/verify`; mock gateway bound |
| `MATCH_V1_ENABLED` | swaps the **source** of the worker feed / payer candidate list |
| `CAPACITY_ENFORCEMENT_ENABLED` | shadow mode — computes but never pauses |
| `MEMBER_INVITES_ENABLE_REAL` | mock mailer; the invite accept token never leaves the process |
| `AI_ENABLE_REAL_CALLS` | all LLM calls mocked |

Per the owner's alpha ruling, `AGENCY_PAYOUTS_ENABLED` and `PAYMENTS_ENABLE_REAL` staying OFF is
**intentional, not a defect** — but each carries an *honest-UI* obligation, tracked in the gap
register.

The payer-web mirror flags (`NEXT_PUBLIC_ENABLE_AGENCY_*`, `src/lib/config.ts:86-93`) are
**label-only** — they do not gate a code path except `agencyPortalEnabled`.
