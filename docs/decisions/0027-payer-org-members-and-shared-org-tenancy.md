# ADR-0027: Payer org members — full shared-org tenancy + real email invites (on existing primitives)

- Status: **Accepted — BUILT + MERGED** (the full B5.1–B5.5 program: #182 db tenant
  foundation `payer_orgs`+`payer_members` (migration 0035) · #183 solo-org guarantee ·
  #184 member-management API + `PayerOrgRoleGuard` + MOCK invites · #185 invite ACCEPT +
  per-org cap + gated real invite email · #186 payer-web Team page wired)
- Date: 2026-07-01 (proposed) · 2026-07-02..07 (built, #182–#186) · header synced 2026-07-11
- Scope: `packages/db` (org tenant root + `payer_members` + `org_id` on payer-owned
  tables + backfill), `apps/api` payer surface (`apps/api/src/payers/*`,
  `apps/api/src/payer-portal/*`, the tenant chokepoint), `packages/event-schema`
  (new PII-free `org.*` / `payer_member.*` events), `packages/config` (invite +
  real-email env), and `apps/payer-web` (replace the `team/` + `org-roles` stubs). A
  multi-PR **program**, sequenced in §Rollout; this ADR is the decision of record and
  **gates the build**.
- Relates to: [ADR-0019](0019-self-serve-payer-portal.md) (payer portal + `PayerAuthGuard`),
  [ADR-0022](0022-agency-supply-portal.md) (payer `role` employer/agent + the session
  role-claim pattern + `assertPayerOwns` tenant chokepoint), [ADR-0013](0013-monetization-and-config-driven-pricing-engine.md)
  (credits/plans that become org-shared), [ADR-0026](0026-production-worker-auth-pin-and-tiered-sessions.md)
  (the session-claim + real-provider-gating precedent), TD21 (payer PII-at-rest
  encryption discipline), TD33/TD50/LC-1 (payer money-route auth). Invariants engaged:
  CLAUDE.md §2 (PII), §3 (locked stack), §5 (real-provider gating), §7 (typed
  contracts), §8 (back-compat), §7-escalation (real email provider + data backfill).

## Context

A payer is today a **single principal**: one `payers` row = one login = one owner of
its postings, unlocks, credits, reach, and disclosures. The tenant chokepoint is
`payer_id` in every payer-owned WHERE (`assertPayerOwns` / `*ForPayer`). The session
JWT already carries an optional `role` claim (`employer` | `agent`, ADR-0022) that
rides both the JWT and the Redis blob and is backward-compatible (absent → resolved
from the `payers` row). The payer-web `team/` page + `org-roles` (`owner` | `recruiter`)
are fully **stubbed** frontend-side, awaiting a backend; the org-role is currently a
dev-only env override that fails closed to `recruiter`. There is **no** org/membership
concept in the DB, no `org_id`, no `payer_members`, no `payer_member.*` events.

The owner has directed the **full team product**, not a lighter access layer:
1. **Full shared-org tenancy** — a payer org's members share the SAME postings,
   candidates, credits, and pipeline (data re-scoped from `payer_id` → `org_id`).
2. **Real email invites** — teammates are invited by real email (accept-link), reusing
   the ZeptoMail/SMTP channel already wired for payer OTP login (ADR-0019).

Both are large. (1) rewrites the tenant chokepoint across the entire payer surface and
requires a data backfill; (2) is a real outbound provider touching new external
recipients + a bearer accept-link token. This ADR fixes the design so each increment is
**backward-compatible and independently shippable**, and both escalations (§7) are
explicit.

## Decision

Build the full feature on the **primitives we already have** — the payer login seam,
the ZeptoMail channel, the ADR-0022 session-claim pattern, `PayerAuthGuard` +
`PayerRoleGuard`, the event spine, and the TD21 PII-encryption discipline — introducing
the smallest set of new tables/claims that make an org a first-class tenant.

### D1 — The org is the tenant root; every existing payer becomes a solo org (back-compat)

Introduce an **org** as the unit of data ownership. To avoid a big-bang rewrite:
- Add `org_id uuid` to the payer-owned tables (`job_postings`, `posting_plans`,
  `posting_boosts`, `unlocks`, `resume_disclosures`, `credit_ledger`, `payer_capacity`,
  … — the full list enumerated at build time from the `payer_id`-scoped set).
- **Backfill** each existing row's `org_id` from its `payer_id` (each current payer is
  its OWN single-member org; the org id may be the payer's own id or a fresh `payer_orgs`
  row keyed to it). After backfill, `org_id` is `NOT NULL`.
- The tenant chokepoint moves from `payer_id` → `org_id`. For a solo org this is
  **behaviorally identical** (the org has one member), so every existing test and flow is
  preserved; sharing only becomes observable once a second member joins.

`payer_members` (new): `{ id, org_id (FK payer_orgs), member_payer_id (FK payers,
nullable until accept), email_enc, email_hash, org_role, status, invited_by,
invite_token_hash, invited_at, accepted_at, removed_at }`. A single table carries the
invite→accept→remove lifecycle via `status ∈ {invited, active, removed}` (soft-delete for
audit); the events are the audit trail. **Members are their own `payers` login** linked to
an org — a member logs in normally and acts on the ORG's data, scoped by their `org_role`.

### D2 — Session gains `org_id` + `org_role`; a new `PayerOrgRoleGuard`

Extend the ADR-0022 claim pattern exactly: add optional `org_id` + `org_role`
(`owner` | `recruiter`) to the payer JWT **and** the Redis blob, backward-compatible
(absent → resolved from `payer_members`, defaulting the org-root payer to `owner`). Add
a `PayerOrgRoleGuard` + `@OrgRoles('owner')` decorator (mirrors `PayerRoleGuard`),
fail-closed (null/absent org_role is never privileged). `@CurrentPayer()` gains
`orgId` + `orgRole`.

### D3 — RBAC matrix (owner / recruiter)

| Capability | owner | recruiter |
| --- | --- | --- |
| Post / edit / close / pause / boost / top-up jobs | ✅ | ✅ |
| Search / reach / unlock / disclosure (org data) | ✅ | ✅ |
| Buy credits / capacity (org wallet) | ✅ | ✅ |
| **Invite / list / remove members** | ✅ | ❌ (list-self only) |
| Change a member's org_role | ✅ | ❌ |

Guardrails: the org-root owner cannot be removed; a sole owner cannot remove/demote
themselves (else the org is ownerless → escalate to ops). Member-management routes are
`@UseGuards(PayerAuthGuard, PayerOrgRoleGuard)` + `@OrgRoles('owner')`.

### D4 — Real email invites (reuse ZeptoMail), gated + staging-first

Invite = create a `payer_members` row (`status=invited`) with an opaque, single-use,
expiring **accept token** (only its **hash** stored; the raw token rides the emailed
accept-link ONLY, never persisted/logged/evented). Delivery reuses the existing
ZeptoMail/SMTP channel (already real for payer OTP), behind a new
`MEMBER_INVITES_ENABLE_REAL` flag, **staging-first** — the boot guard fails closed
without creds, mirroring the payer-login channel. Accept: the invitee follows the link,
authenticates (existing payer login/signup), and the token binds their `member_payer_id`
→ the org (`status=active`). Per-org invite-mint cap + per-email resend cap (fail-closed),
mirroring the OTP/disclosure caps.

### D5 — Events + PII

New v1 PII-free events (opaque ids + `org_role`/`status` enums + counts ONLY):
`org.created`, `payer_member.invited`, `payer_member.accepted`, `payer_member.removed`,
`payer_member.role_changed`. The **member email is PII** → `email_enc` (AES-GCM) +
`email_hash` (keyed HMAC) per TD21; it NEVER appears in an event, log, `ai_jobs`, or LLM
input. The **invite token** is a bearer secret → only its hash at rest, never evented/logged.

## Consequences

- **Positive:** a real team surface (invite/list/remove + shared org pipeline); the
  payer-web `team/` stubs light up; org-role finally rides a signed claim (closes the
  frontend dev-override gap); the tenant model generalizes cleanly for future org
  features. No stack change (§3 intact) — built on existing primitives.
- **Costs / risks:** the `org_id` re-scoping touches the whole payer surface (large
  surface area, many tests to re-baseline); the backfill migration is a data-shape change
  (additive + backward-compatible, but must be exactly-once and reversible); real email is
  a new outbound surface (external recipients + a bearer token) needing a dedicated
  security pass. **RLS is still service-role today** (TD4) — `org_id` scoping is enforced
  in the service/repository chokepoint, not RLS; the finalized-RLS plan must add `org_id`.
- **§7 escalations (explicit, owner-directed):** (a) **real email invites** — reuses the
  existing ZeptoMail provider but sends to NEW external recipients; enabled only via
  `MEMBER_INVITES_ENABLE_REAL` in staging first, with a security review of the accept-link
  token before any real send; (b) **the backfill** — additive/back-compat (solo-org
  default), never destructive, with a rollback path; applied to a shared/staging DB only
  after sign-off (never prod without §7).

## Rollout (sequenced — each its own reviewed PR; migration + security gates as marked)

- **B5.1 — Tenant foundation (DB).** `payer_orgs` + `payer_members` + additive `org_id`
  on the payer-owned tables + backfill (each payer → solo org) + indexes. Migration +
  rollback. *(migration-review gate)*
- **B5.2 — Tenant chokepoint.** Re-scope `assertPayerOwns`/`*ForPayer` reads/writes to
  `org_id`; behavior-preserving for solo orgs (re-baseline the payer suite). Session
  `org_id` claim wiring. *(security-review gate — IDOR/tenant isolation)*
- **B5.3 — Member management API.** `org_role` claim + `PayerOrgRoleGuard`; the
  invite/list/remove/role-change routes + `org.*`/`payer_member.*` events + email_enc/hash;
  MOCK invite path first (`MEMBER_INVITES_ENABLE_REAL=false`). *(security-review gate)*
- **B5.4 — Real email invites.** Wire the ZeptoMail invite template + accept-link token +
  caps; staging-first behind the flag. *(security-review gate — token + real-send; §7)*
- **B5.5 — Payer-web.** Replace the `team/` + `org-roles` stubs against the live API;
  design-system pass. *(ui-review gate)*

## Open questions (resolve during B5.1/B5.2)

1. Org root identity — a dedicated `payer_orgs` row vs `org_id = the root payer's id`
   (naming + FK ergonomics). Recommend a dedicated `payer_orgs` row (clean FK target,
   room for org-level fields: name, billing owner).
2. Shared **credit wallet** semantics — org-level ledger vs per-member sub-ledgers.
   Recommend org-level (a team shares one wallet); reconcile with ADR-0013 credit_ledger.
3. Whether a payer may belong to **multiple** orgs (agencies acting for many companies) —
   default **one org per member** for B5; multi-org is a later ADR if the agency model needs it.
4. Backfill mechanism — SQL data migration vs a one-shot idempotent backfill job
   (prod-guarded), consistent with `db:seed:*` conventions.
