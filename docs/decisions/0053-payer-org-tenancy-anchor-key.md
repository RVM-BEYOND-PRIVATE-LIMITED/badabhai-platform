# ADR-0053: Payer org tenancy — the org's anchor payer is the tenant key (PAY-DB-01)

- **Status:** **Accepted — owner rulings 2026-10-08 (§11).** The owner (Prakash) accepted the tenancy key
  and every decision except O-8, as recommended (PR #2136 comment, 2026-10-08). O-8, arming `shadow` and
  then `on` in production, stays the owner's call after the Phase 3 checklist. **The signature on the
  foot is blank and awaits the owner.** History: org-as-tenant ruled 2026-08-11 (`DATABASE_AUDIT.md`
  line 9); start ordered 2026-10-07; proposed 2026-10-07.
- **Date:** 2026-10-07 (proposed) · 2026-10-08 (owner rulings)
- **Owner:** Prakash (Backend Platform). Architecture: Chief Software Architect.
- **Tracking:** `PAY-DB-01` (P0), `GAP-AUTHZ-01`, `GAP-FE-01` in
  [`GAP_REGISTER.md`](../payer-agent/GAP_REGISTER.md). Phased plan, predicate inventory, census SQL and
  test strategy: [`ORG_TENANCY_PLAN.md`](../payer-agent/ORG_TENANCY_PLAN.md).
- **Amends:** [ADR-0027](0027-payer-org-members-and-shared-org-tenancy.md) D1. The **model** stays the
  same: the org is the tenant, and members share postings, candidates, credits and pipeline. The
  **mechanism** changes: no `org_id` columns (see §4 and §12). This ADR also answers ADR-0027 open
  questions 1–4 (§2, §6, §3.5, §9).
- **Relates:** [ADR-0010](0010-contact-unlock-and-reveal.md) D4 (worker-protection caps) ·
  [ADR-0013](0013-monetization-and-config-driven-pricing-engine.md) (credits, coupons) ·
  [ADR-0016](0016-payer-hiring-capacity.md) (capacity) ·
  [ADR-0019](0019-self-serve-payer-portal.md) Decision C (the `payer-scope.ts` chokepoint) ·
  [ADR-0022](0022-agency-supply-portal.md) (vertical role) ·
  [ADR-0037](0037-payer-lifecycle-and-suspension.md) (suspension cascade) ·
  [ADR-0050](0050-agency-inventory-v1-twin.md) §4.5 (twin ownership = the source's) ·
  [ADR-0004](0004-pii-at-rest-and-rls.md) (RLS).
- **Contract:** no migration, and no column added, dropped or renamed. No API request or response
  shape changes, and no event schema changes. One new env var, `PAYER_ORG_TENANCY_MODE`
  (`off` | `shadow` | `on`, default `off`).
- **Number:** 0053 was the next free number on `origin/main` at `c9b1237a`. No open PR, remote
  branch or local worktree claimed 0053 when this was written. If another PR merges 0053 first,
  this ADR takes the next free number. Nothing else references the number yet.

---

## 1. Context

**Facts on `main` (`c9b1237a`):**

- Every payer already has an org row. Migration `0035` backfilled a solo `payer_orgs` row for each
  existing payer (root = that payer) plus an `active` `owner` membership.
  `PayerOrgsRepository.ensureSoloOrg` (`payer-orgs.repository.ts:52`) re-asserts this at signup and
  test-login (`payer-auth.service.ts:94`, `:314`).
- `payer_orgs.root_payer_id` is `NOT NULL`, unique (`payer_orgs_root_payer_id_uq`), and
  `ON DELETE RESTRICT` (`packages/db/src/schema/payer.ts:95-116`). No code path updates it. Org and
  root are therefore **1:1 and immutable**.
- 15 payer business tables are keyed only by the individual login's id: 12 tenant-owned tables and
  3 agency-money tables (§4). That id sits in `payer_id`, or in `inviter_payer_id` /
  `agency_payer_id` / `agent_payer_id`. No business read is org-scoped (`DATABASE_AUDIT.md` §3).
- `PayerOrgRoleGuard` resolves the org for team management only. It picks the most recently
  accepted active membership (`payer-orgs.repository.ts:93-101`).
- **Consequence (the P0):** an invited teammate resolves to the inviting org, but every business read
  still filters on their own `payer_id`. They see zero postings, credits, candidates and unlocks.

**Two constraints shape the design:**

1. **Migrations are applied to production by hand, and a merge to `main` deploys code with no
   migration step.** Drizzle's bare `select()` and `.returning()` name every model column. Any new
   column on these tables is therefore apply-before-deploy, or every read of the table returns 500
   (`DATABASE_AUDIT.md` §5.1; the `0132` header). A design that needs new columns on 12 hot tables
   couples every phase to a manual production step.
2. **A partial tenancy switch is the worst outcome** (`GAP_REGISTER.md` open question 1). Postings
   that are org-scoped while credits stay payer-scoped give a recruiter silent failed purchases, which
   is worse than an empty page.

## 2. Decision summary

1. **The org is the tenant.** Each authenticated payer acts within exactly one org per request, their
   **acting org** (§3.2).
2. **The tenant key is the acting org's anchor**, `payer_orgs.root_payer_id`. It is stored in the
   payer-reference columns that already exist. **No `org_id` column is added.** Because org and anchor
   are 1:1 and immutable, an `org_id` column can be derived exactly from the anchor later (§9), so this
   choice closes off no future option. This answers ADR-0027 Q1: the
   dedicated `payer_orgs` row stays, and its anchor is the key.
3. **One resolver decides the key.** `PayerTenantScope` comes from one function and is passed down.
   Repositories accept only its branded `TenantKey`, never a raw id from a body, path or JWT claim.
4. **One switch flips it.** `PAYER_ORG_TENANCY_MODE=off` resolves the key to the login itself, which
   is today's behaviour exactly. `on` resolves it to the acting org's anchor. Every predicate goes
   through the resolver, so the flip is a single switch and can never be partial (constraint 2).
5. **The org wallet is the anchor's existing wallet row.** No money moves at any phase (§6).
6. **Nothing is backfilled.** Every existing row is already keyed by its creator, and the creator is
   the anchor of their own solo org. Rows stay in the tenant they were created in (§9).

## 3. Tenancy model

### 3.1 Vocabulary (also the naming rule for new code)

| Term | Meaning | Where it lives |
|---|---|---|
| **Org** | the tenant | `payer_orgs` row |
| **Anchor** | the org's founding payer; the tenant key | `payer_orgs.root_payer_id` |
| **Member** | a payer login linked to an org with an `org_role` | `payer_members` |
| **Actor** | the authenticated login making this request | `req.payer.id` |
| **Solo org** | the single-member org every payer owns from signup | `payer_orgs` where root = the payer |
| **Team org** | an org with at least one member besides its anchor | — |

**Standard from this ADR on:** on a payer-surface business table, a column named `payer_id` (or
`inviter_payer_id`, `agency_payer_id`, `agent_payer_id`) holds the **tenant key**. The acting login,
when a table needs it, goes in a column named `actor_payer_id` or `created_by`. It is never a second
`payer_id`. `job_postings.created_by` already follows this rule.

### 3.2 Acting-org resolution (resolves ADR-0027 Q3, together with §3.5)

For actor `P` in mode `on`:

- **R1:** read `P`'s `active` memberships, joined to their org (id, anchor, `status`) and to the
  anchor's `payers` row (`status`, `role`).
- **R2 (team wins):** if exactly one membership is in an org whose anchor is not `P`, that is the
  acting org. Otherwise the acting org is `P`'s solo org.
- **R3 (fail closed):** more than one team membership returns a neutral 403 and an error log. Rule A1
  (§3.5) prevents new cases.
- **R4 (heal, then fail closed):** if `P` has no active membership at all, call `ensureSoloOrg(P)`
  once (idempotent, the existing login pattern) and re-resolve. If that still fails, return 403.
- **R5 (org liveness):** if the acting org's `status` ≠ `active`, return 403. When `P` is not the
  acting org's anchor, if the anchor's `payers.status` ≠ `active`, return 403 (O-6, ruled
  2026-10-08). `P`'s own status is judged by `PayerAuthGuard`, not here.
  *Amended 2026-10-08 (PR #2155; a correction to keep the owner's solo-identity ruling — **pending the owner's own confirmation**, a P3 entry criterion):* as first written, R5
  checked the anchor's status on every acting org, including a solo org, whose anchor is `P`.
  Login resolves the org **before** a first-time payer is activated (`PayerAuthService.testLogin`
  and `verifyLogin` resolve the org, then call `payers.activate`), so in `on` every first login was
  refused and got a session with no org claim. That broke solo identity (§5.3: "a payer with no
  team is unaffected").
- **R6 (vertical role):** if `P`'s `payers.role` ≠ the anchor's role, return 403 (O-9, ruled 2026-10-08).
- **R7:** a resolve error is a 403, never an allow.

In mode `off`, the tenant key is `P` and the resolver never fails a request. It still reports the org
it would choose, for logging and `GET /payer/me`.

`PayerOrgRoleGuard`, the session org claim and `GET /payer/me` must use the **same** choice function,
so the Team page and the data scope can never disagree. In mode `off` the choice function keeps
today's tie-break (most recently accepted).

### 3.3 What a member can do (ADR-0027 D3, restated against today's rulings)

| Capability | Owner (anchor) | Recruiter | Basis |
|---|---|---|---|
| Read the org's postings, applicants, Candidates inbox, unlocks, disclosures, credits, ledger, capacity | ✅ | ✅ | D3 |
| Create, edit, close, pause and resume postings; buy plans, boosts and quota top-ups | ✅ | ✅ | D3 (+ `@PayerRoles("employer")`, #1885) |
| Unlock, reveal, relay, resume disclosure (spends the org wallet) | ✅ | ✅ | D3 |
| Buy credits or capacity (credits the org wallet) | ✅ | ✅ | owner ruling 2026-10-07 (#2109) |
| Invite, list and remove members | ✅ | ❌ list-self only | D3, `@OrgRoles("owner")` |
| Agency KYC, earnings and payout requests | ✅ | ❌ (O-5, ruled) | flag-gated off today |
| AI posting-chat drafts | own only | own only | O-7 (member-private, ruled) |

The JWT `org_id` / `org_role` claim stays a **display hint** (`payer-session-org-claim.ts`). It never
decides scope or role.

### 3.4 Individual payers

A payer with no team **is** a single-member org that already exists. In mode `on` their tenant key
equals their own id, so nothing about them changes. This identity is the property that makes every
Phase 2 PR safe (§5.3).

### 3.5 Membership invariants enforced at invite accept

Phase 1 adds these checks to `PayerOrgMembersService.accept`. Each refusal is a neutral 409 with no
new event, matching the existing pattern that emits only on success. **A1–A3 were accepted by the owner
on 2026-10-08.**

- **A1:** a payer who already holds an active **team** membership cannot accept a second one. This
  resolves ADR-0027 Q3 with its recommended default: one org per member. Multi-org is a later ADR.
- **A2:** the anchor of a team org (any non-removed member besides itself) cannot accept another
  org's invite. Accepting would strand the team without an owner (D3 guardrail).
- **A3 (O-9, ruled):** the invitee's `payers.role` must equal the anchor's role. An employer login cannot
  act inside an agency org, and an agent login cannot act inside an employer org (GAP-FE-06 split).

## 4. Scoping key per table

| Class | Table | Tenant-key column | After the flip |
|---|---|---|---|
| **A — tenant-owned** | `job_postings` | `payer_id` (nullable; NULL = ops or a twin) | org-scoped; `created_by` = actor |
| | `jobs` (agency) | `payer_id` (nullable) | org-scoped |
| | `posting_plans`, `posting_boosts` | `payer_id` | org-scoped |
| | `payer_capacity` | `payer_id` (unique) | one allowance per org |
| | `unlocks` | `payer_id`; unique `(payer_id, worker_id)` | one unlock per (org, worker) |
| | `resume_disclosures` | `payer_id`; unique `(payer_id, worker_id, job_posting_id)` | per org |
| | `payer_credits` | `payer_id` (unique) | **the org wallet** (§6) |
| | `credit_ledger` | `payer_id` | the org wallet's ledger |
| | `payment_orders` | `payer_id` | the wallet credited; stamped at intent |
| | `agency_invites` | `inviter_payer_id` (FK) | org roster |
| | `referral_links` (agent kind) | `agent_payer_id` (FK) | no live writer today (`mintLink` has no caller); same rule when wired |
| **A — agency money** | `agency_kyc`, `agency_payout_requests`, `agency_payout_accruals` | `payer_id` / `agency_payer_id` | org-level, owner-only (**O-5**, ruled); behind `AGENCY_PAYOUTS_ENABLED` (off) |
| **B — member-private** | `payer_job_posting_chat_sessions`, `…_messages`, `payer_form_drafts` | `payer_id` = **actor** | unchanged (O-7); publish writes the posting under the tenant key |
| **C — via parent** | `applications`, `job_reach`, `job_reach_widen` (posting) · `unlock_routing`, `relay_messages` (unlock) · the in-flight applicant-stage table (posting) | none | follows the parent |
| **D — out of scope** | `payers`, `payer_orgs`, `payer_members` · the four modelled GAP-DB-21 tables (`agency_profiles`, `employer_profiles`, `payer_capabilities`, `payer_member_invites`; zero consumers) · `pricing_catalog`, `match_config`, `events`, `audit_logs` | — | — |

**Rule for the in-flight applicant-stage table (branch `feat/api-applicant-stages`):** authorize
through the posting-ownership chokepoint (`getOneForPayer` / `findOwnedJobRef`). Do not add a
`payer_id` scope column. If the table records who moved a stage, name that column `actor_payer_id`.
Built this way, it becomes org-scoped at the flip with no change of its own.

## 5. Ownership checks — one resolver

### 5.1 Contract

Backend Platform owns the file layout. The shape is fixed here:

```ts
declare const tenantKeyBrand: unique symbol;
/** The acting org's anchor (payer_orgs.root_payer_id). Constructible ONLY by the resolver (§5.2 rule 2). */
export type TenantKey = string & { readonly [tenantKeyBrand]: true };

export interface PayerTenantScope {
  readonly actorPayerId: string;       // events' envelope actor, created_by, rate limits, member-private rows
  readonly tenantKey: TenantKey;       // EVERY tenant-row predicate and every tenant-row stamp
  readonly orgId: string | null;       // null only in `off` when no org row resolves
  readonly orgRole: OrgRole | null;
  readonly mode: "off" | "shadow" | "on";
}

resolve(actorPayerId: string): Promise<PayerTenantScope>;
```

### 5.2 Rules

1. **Resolve once per request, at the service entry point.** Tenancy is business logic (CLAUDE.md §4),
   so it is never resolved in a controller or a repository. The scope object is passed down. It is
   never re-resolved inside a transaction.
2. **Repositories take `TenantKey`, not `string`,** for every tenant-row predicate and stamp. A typed
   body, path or JWT value cannot reach a predicate, because only the resolver produces the type:
   its one constructor is private to `payer-tenant-scope.ts`, and `payer-tenancy.static.test.ts`
   fails on any type assertion to `TenantKey` / `PayerTenantScope` / `ActingOrgChoice` (or an alias
   or interface built on one) elsewhere, and on any import of `chooseActingOrg` outside the resolver
   service. The brand is a compile-time device: a value typed `any` assigns to it without a cast,
   and the lint config has no type-aware `no-unsafe-argument`. A type predicate (`x is TenantKey`),
   an assertion function (`asserts x is TenantKey`) or a generic helper whose return type is
   inferred (`launder<T>(x: unknown): T`) also mints one with no visible cast; the static test does
   not see these yet (closing the first two is Phase 2 work). Inputs therefore reach payer
   services only as Zod-parsed DTOs and the session id, and Phase 2 review must keep it so.
3. **Writes stamp the tenant key** into the tenant-key column. Actor columns get the actor.
4. **Trusted internal routes that take a payer id** (`InternalServiceGuard`: `/unlocks`,
   `/payers/:payerId/credits`, `/job-postings/:id/plan` and `/boost`, `/resume-disclosures`) pass that id through
   **the same resolver**. They never accept a tenant key or an org id as input.
5. **Rate limiters stay keyed by actor.** Abuse controls are per principal. Worker-protection caps
   are per tenant (O-3).
6. **`payer-scope.ts`** (`assertPayerOwns`, `assertOwnedRows`, `readOwnedById`) is retyped to compare
   a row's tenant-key column with `scope.tenantKey`. It remains the only "may this tenant touch this
   row" function, with the same no-oracle responses.
7. **Out of scope by design:** admin repositories (`admin-*.repository.ts`) address payers literally
   by id. Ops intent there is "this account". Admin money writes are covered in §6.

### 5.3 Modes

| Mode | Tenant key | Served behaviour | Purpose |
|---|---|---|---|
| `off` (default) | actor | identical to today | every Phase 2 PR merges here as a provable no-op |
| `shadow` | actor (served) | identical to today | also runs the `on` resolution, catching errors, and logs `{actor, would_key, would_differ, outcome, ms}` with no PII. Proves the resolver against production data before it decides anything. |
| `on` | acting org's anchor | org tenancy | the fix |

`PAYER_ORG_TENANCY_MODE` lives in `packages/config` and has **one reader**, the resolver. A test
pins this. Arming it in production means setting the `production` environment secret and
redeploying, which is an owner action (O-8).

**Solo identity:** for every payer who is not a non-anchor member of a team org, `resolve(P).tenantKey`
in `on` equals `P`. The flip therefore changes behaviour **only** for team members. Census C1
(plan §6) counts exactly that population before the flip.

### 5.4 Performance budget

- **Resolver cost:** at most one indexed round trip per tenant-touching request
  (`payer_members_member_payer_id_idx`, then primary-key joins).
- **Gate for `on`:** in `shadow`, the resolver's own p95 must be ≤ 5 ms, and the p95 of `/payer/*`
  tenant routes must not regress by more than 5 ms against the `off` baseline.
- **Later optimisation:** fold the resolver into `PayerAuthGuard`'s existing per-request
  `findAuthFacts` read. Not required.

## 6. Credits and wallet semantics (resolves ADR-0027 Q2)

- **W1 (O-1, ruled 2026-10-08):** an org has **one wallet**, the anchor's existing `payer_credits` row.
  Any member spends from it and any member's purchase credits it, per D3 and the 2026-10-07 ruling.
  Because the wallet row already belongs to the anchor, **no balance moves at any phase.**
- **Concurrency:** members spending concurrently debit one row through the existing atomic
  `tryDebit` (`UPDATE … WHERE balance >= n`, `unlocks.repository.ts:488`), so overdraw is impossible.
  The capacity advisory lock (`posting-plans.repository.ts:50`) becomes per tenant, which serialises
  org capacity correctly.
- **Ledger:** `credit_ledger.payer_id` = the wallet (tenant key). The reconciliation invariant stays
  the same: `payer_credits.balance = Σ credit_ledger.delta` per `payer_id`. It holds across the flip
  **and across a rollback**, because wallet and ledger always carry the same key. Who spent is on
  the event envelope (§7).
- **Payment orders are stamped at intent.** `payment_orders.payer_id` = the tenant key when the order
  is created. Settlement (webhook or verify) credits that wallet and never re-resolves. The
  `expectedPayerId` check (`payment-gateway.ts:275`) compares with `scope.tenantKey`, so any member
  of the org may verify the org's order. An order created before the flip settles into the wallet it
  was created for.
- **Free tier:** the signup grant goes to the new payer's own solo wallet. This is unchanged, keyed
  per account (`free_tier_grant:<payerId>`). Inviting more people cannot farm free credits into a
  team wallet.
- **A joining member's personal balance (O-2, ruled 2026-10-08):** it stays in their solo wallet. It is not visible
  while they act in the team, and becomes visible again if they are removed. Nothing is merged
  automatically.
  This is live today: since #2109 and #2110, a member can buy credits, and those credits land on
  their own `payer_id` wallet. Purchases made before the flip are therefore exactly the balances
  O-2 governs. Census C5 sizes them.
- **Admin grants:** `POST /admin/payers/:id/credits` stays literal and credits the wallet keyed by
  that id. Ops target the anchor to credit an org. Follow-up for admin-web: show the anchor next to
  the member.
- **Worker-protection caps (O-3, ruled 2026-10-08):** "max distinct payers per worker per week" (ADR-0010 D4) counts
  distinct `payer_id`. After the flip that means distinct **orgs**. The per-unlock reveal-attempt cap
  becomes shared by the team.
- **Coupons (O-4, ruled 2026-10-08):** `couponUsage` counts `coupon.redeemed` by payload `payer_id`
  (`posting-plans.repository.ts:290-299`). Under §7 that becomes per org.

## 7. Events

- **No event schema is mutated, versioned or added.** No payload changes shape.
- **Meaning, stated once:**
  - On a **tenant business event**, the envelope `actor.actor_id` is the acting login, and the
    payload's payer-reference fields (`payer_id`, `inviter_payer_id`, `agency_payer_id`,
    `viewer_payer_id`) carry the **tenant key**. Tenant business events are the agency `job.*`
    events (`job.created`, `job.updated`, `job.closed`; added 2026-10-08, PR #2167), the `job_posting.*`
    purchase/boost/plan events, `unlock.*`, `payment.*`, `coupon.redeemed`, `capacity.purchased`,
    `posting_plan.*`, `payer.credits_exhausted`, `profile.viewed_v2`, `agency_invite.*`,
    `agency_kyc.*` and `agency_payout.*`.
  - Every historical event has actor = tenant. In mode `off` every value is unchanged.
  - **Person-level events** keep the person: `payer.*` lifecycle and auth events,
    `payer.account_updated`, `payer_member.*` and `job_posting_chat.*` (member-private).
  - `job_posting.created` already carries `created_by` (the actor) and no `payer_id`.
- **Why no `org_id` field:** the acting org at time `t` can be derived exactly from the spine, using
  `payer_member.accepted` / `.removed` and rule R2. A versioned `_v2` that carries `org_id` is
  deferred until a consumer needs it (TD155).
- **No new business action is introduced.** Joining a team already emits `payer_member.accepted`.
  An accept refusal is a denial, not a state change. The flag flip is configuration.

## 8. RLS posture

Unchanged. Every table remains `ENABLE` + `FORCE` + `REVOKE` with zero policies, and the API connects
as `BYPASSRLS`. Tenant isolation remains **application-layer only**: the resolver plus the typed
predicates. No table or column is added, so no RLS statement is owed.

The anchor key is RLS-ready. A later policy would be `payer_id = current_setting('app.tenant_key')::uuid`
under a non-`BYPASSRLS` role, with a per-transaction `SET LOCAL`. That policy remains the open GA
gate (ADR-0004 / TD4) and is not part of this program.

## 9. Backfill (resolves ADR-0027 Q4)

**None.** Every existing tenant row's key is its creator. Every creator is the anchor of their own
solo org (0035 backfill plus `ensureSoloOrg`), and before this ADR every payer acted only within that
org. Every row is therefore already in the correct tenant. The born-where rule follows: **a row stays
in the tenant it was created in. Nothing is ever re-homed.** A row whose key names no `payers` row
(legacy opaque ids) stays unreachable, as it is today.

**If `org_id` columns are ever wanted** (multi-org, ownership transfer, or RLS by org), the backfill
is exact and needs no judgement:

```sql
UPDATE <t> SET org_id = o.id FROM payer_orgs o WHERE o.root_payer_id = <t>.<tenant_key_col>;
```

## 10. Backward compatibility

- **Schema:** no column added, dropped or renamed. No constraint or index changes, because the
  existing unique keys already become per-org at the flip. The program has no migration, so no phase
  depends on the owner applying SQL first (constraint 1).
- **API:** request and response shapes are byte-identical. A response field that echoes the caller
  (for example `GET /payer/credits` → `payer_id`) stays the caller. A field that describes a row's
  owner (for example a posting's `payer_id`) carries the stored tenant key. No client compares those
  fields (grep of `apps/payer-web/src`).
- **Session / JWT:** unchanged.
- **Events:** §7.
- **Old and new builds:** both run against the same database in any order.

## 11. Owner decisions — ruled 2026-10-08

**Owner rulings, 2026-10-08 (Prakash; recorded on PR #2136):**

- **Tenancy key: ACCEPTED.** `payer_orgs.root_payer_id`, the founder's payer id (§2). No migration.
  One flag, `PAYER_ORG_TENANCY_MODE` (`off` / `shadow` / `on`, default `off`).
- **O-1 and O-2: ACCEPTED.** One org wallet, the founder's credits row, which every member spends from
  and tops up. A member's pre-team personal balance stays in their personal account, with no automatic
  merge.
- **O-3, O-4, O-5, O-6, O-7, O-9, and invite refusals A1–A3: ACCEPTED as recommended.**
- **O-10 (owner ruling 2026-10-08, relayed on PR #2167): RULED.** When a teammate publishes a
  posting, it carries the org founder's company name (the anchor's `payers.org_name_enc`), and
  the teammate is recorded as the creator (`created_by`, event actor). See the O-10 row below.
- **O-8 is not ruled.** Arming `shadow`, then `on`, in production stays the owner's call after the
  Phase 3 checklist (plan §5).

**Effect on phases:** no owner decision blocks P1, P2a, P2b, P2c or P2d any more. P1 ships A1–A3
together. P3's owner actions wait only on O-8.

| # | Decision | Recommendation | Ruling 2026-10-08 | Was blocking |
|---|---|---|---|---|
| **O-1** | The org wallet is the anchor's existing wallet; every member spends from it; every member's purchase credits it | **Yes.** It is what D3 says, and nothing moves | ACCEPTED | Merge of P2b |
| **O-2** | A joining member's own pre-team rows and balance stay in their solo tenant (born-where); no automatic merge | **Yes.** Reversible. Census C5 sizes it; it can be non-zero because members have been able to buy onto their own wallet since #2109 | ACCEPTED | The flip, only if C5 is non-zero |
| **O-3** | Worker-protection caps count distinct **orgs** after the flip, not logins; a team shares the per-unlock reveal attempts | **Yes.** The cap protects the worker from distinct *companies*. Counting logins would need a new column and would cap a team at fewer companies | ACCEPTED | Merge of P2b |
| **O-4** | Coupon `perPayerLimit` becomes per org | **Yes.** Mock money today (`GAP-PAY-05`) | ACCEPTED | Merge of P2c |
| **O-5** | Agency KYC, earnings and payouts are org-level and **owner-only** (`@OrgRoles("owner")`) | **Yes.** KYC describes the legal entity | ACCEPTED | Merge of P2d; must also be decided before `AGENCY_PAYOUTS_ENABLED` flips |
| **O-6** | Suspending an org's anchor (ADR-0037) blocks the whole org: resolver R5 reads the anchor's `payers.status` for every member who is not the anchor, so each of them gets a 403 on tenant routes; the anchor's own login is blocked by `PayerAuthGuard`, as before. No new write and no new event; the existing cascade already suspends the org's inventory because it keys on `payer_id`. Suspending a non-anchor member blocks only that login. *(R5 wording amended 2026-10-08, §3.2: the anchor-status check never applies to the anchor themself.)* | **Yes** | ACCEPTED | The flip (R5 behaviour) |
| **O-7** | AI posting-chat drafts stay member-private | **Yes.** Current behaviour; the published posting is shared | ACCEPTED | Nothing |
| **O-8** | Arm `shadow`, then `on`, in production (secret plus redeploy) | after the P3 checklist | **Open**: owner's call after the P3 checklist | P3 |
| **O-9** | A member's vertical role must equal the anchor's role (A3, R6). The alternative is members acting under the anchor's role | **Must match** for now: fail-closed and reversible. Revisit if agencies hit it | ACCEPTED (P1 ships A3) | A3 in P1 (P1 ships A1 and A2 without it) |
| **O-10** | A teammate's posting carries the org FOUNDER's company name (`org_label` from the anchor's `payers.org_name_enc`), not the teammate's own signup name; the teammate stays the creator (`created_by`, event actor) | — (raised in review of PR #2167) | **RULED by the owner 2026-10-08** (relayed on PR #2167) | Nothing. The AI chat publish ships it in P2a; the manual form's prefill (client-side from `GET /payer/me`) is on the P2 checklist (plan §3.1) |

## 12. Alternatives considered

1. **`org_id` columns on 12+ tables (ADR-0027 D1 as written, `IMPLEMENTATION_PLAN.md` 3.2).**
   Rejected for now:
   - It needs an apply-before-deploy migration on hot tables, which couples phases to a manual
     production step.
   - It needs a backfill, a dual-write window, and replacement unique indexes.
   - After a rollback, the money is no longer reconcilable: ledger rows written in `on` carry the
     actor's `payer_id` while the debit hit another wallet.
   - It buys nothing that is needed today. Ownership transfer, multi-org and RLS by org are not
     ruled.
   - It stays fully available later: §9 derives it exactly.
2. **Predicate by membership join** (`payer_id IN (active members)`). Rejected. A member's postings
   would vanish when they are removed, and the query cost grows with every membership.
3. **Scope from the JWT `org_id` claim.** Rejected. The claim is a hint that can be up to 30 days
   stale, and authority must come from the per-request database read.
4. **Flip without a flag.** Rejected. Rollback would need a deploy, and there would be no shadow
   proof.

## 13. Consequences

- **Positive:**
  - The P0 is fixed with zero schema change.
  - The flip is one switch, so a partial state cannot exist.
  - Money stays consistent across flip and rollback.
  - Unique keys, caps, capacity locks, the worker feed's company interleave key
    (`match-feed.repository.ts:203`, `COALESCE(jp.payer_id, …)`) and the ADR-0037 inventory cascade
    all become per-org automatically, because they already key on `payer_id`.
- **Costs and debt (TD155):**
  - `payer_id` now means "tenant anchor", not "the login who acted". A team member's actions keep
    attribution only on the event envelope and on `job_postings.created_by`.
  - A payer-visible "who on my team did this" feature would need additive `actor_payer_id` columns
    (Phase 4).
  - Org ownership transfer is closed off until `org_id` exists. D3 already forbids removing the
    anchor, and `ON DELETE RESTRICT` already forbids deleting it.
- **Risks:**
  - **A missed call site.** A write keyed by the actor in `on` strands the row under the member.
    Mitigation: the `TenantKey` brand, plus the architecture test T5 (plan §5) whose allowlist must
    be empty before the flip, plus a hand check of the call sites T5 cannot see (plan §5 lists
    them; an empty allowlist alone is not proof of completeness).
  - **Accept-rule race** (risk register R65): A1/A2 are check-then-write. Fail-closed (R3) and
    counted by census C2/C3; closing it is a P3 entry criterion.
  - **Stranded personal data** (O-2): sized by census C5 (rows) and C5b (credits) before the flip.
  - **Event meaning** (§7): every emitter is reviewed per PR by `code-reviewer`.
- **Rollback:** set the mode back to `off` and redeploy. Rows a member wrote in `on` remain under the
  anchor. The owner still sees them, and the member returns to the pre-ADR empty view. No data repair
  is needed.

## 14. Rollout

Plan: [`ORG_TENANCY_PLAN.md`](../payer-agent/ORG_TENANCY_PLAN.md).

- **P1:** resolver, mode flag, invite refusals A1–A3, census script, red tests. No behaviour change.
- **P2a–P2d:** predicate switch, one domain per PR. Each is a no-op in `off`.
- **P3:** completeness gate, census, then `shadow`, then `on`. Arming each mode is the owner's call (O-8).
  Until P3 the deploy preflight refuses `on` (risk R66, added 2026-10-08 by the security review of
  PR #2167): `on` before every predicate is converted would be the partial switch of §1
  constraint 2. **The P3 PR lifts the preflight refusal.**
- **P4 (deferred):** actor columns, `org_id` plus RLS.

Required gates per phase are listed in the plan.

---

```
Accepted 2026-10-08. The tenancy key (payer_orgs.root_payer_id, no migration, PAYER_ORG_TENANCY_MODE) and
decisions O-1 to O-7 and O-9, with invite refusals A1 to A3, are the owner's rulings of 2026-10-08
(PR #2136). O-8, arming shadow and then on in production, remains the owner's call after the Phase 3 checklist.
Signed: ______________________ (product owner)          Date: ____________
```
