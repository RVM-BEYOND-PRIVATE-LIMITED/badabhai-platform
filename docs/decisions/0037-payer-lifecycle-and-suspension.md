# ADR-0037: The payer lifecycle — activation on OTP verify, and suspension that actually bites

- **Status:** Accepted — owner rulings 2026-08-02 (lifecycle, Decisions 1–4) and 2026-08-03 (Decisions 1–7 below).
- **Date:** 2026-08-03
- **Supersedes:** the 2026-07-17 owner ruling **"B-1 (payer verification gate): DEFERRED"** ([team-decisions.md](../registers/team-decisions.md)) — *"change this later when we move closer to absolute production; right now let it be."* That deferral is explicitly reversed here. `payers.status` is now read on every payer request.
- **Relates:** [ADR-0019](0019-self-serve-payer-portal.md) (the payer portal and `payers` table) · [ADR-0022](0022-agency-supply-portal.md) (agency = `payers.role='agent'`) · [ADR-0025](0025-admin-ops-portal.md) (ADMIN-3a governed admin actions, the suspend/reinstate routes) · [ADR-0010](0010-contact-unlock-and-reveal.md) (credits/unlocks, the money paths a suspension must stop) · TD37 (the two-job-entity split, which is why the inventory cascade writes to two tables)

## Context

`payers.status` shipped with ADR-0019 as a three-value column (`pending` / `active` / `suspended`) defaulting to `pending`. A code audit at HEAD `eac35e6a` established three facts about it.

**Nothing ever set it to `active`.** Signup inserts the row and never writes the column; `verifyLogin` mints a session and never writes the column. There is no `verified_at`, no `last_login_at`. Every payer in every environment was `pending`, indefinitely.

**Nothing ever read it.** `PayerAuthGuard` loaded the row only to resolve the vertical-authz `role`; the status it fetched was discarded. So all 55 payer routes were reachable regardless of status.

Those two facts made the third one inevitable: **`POST /admin/payers/:id/suspend` was simultaneously unreachable and unenforced.** Its repository write was guarded `WHERE status = 'active'`, which no row satisfied, so it returned 409 for 100% of real payers. And in the counterfactual where it had worked, it would have changed nothing — no request path consulted the column. The admin capability existed, was documented, was tested against mocks, and could not affect a single payer.

A fourth fact made suspension's blast radius wider than it looked. **`payers` is joined nowhere in the discovery path.** Not in the worker feed, not in reach, not in the jobs or applications repositories, not in the Matching-V1 feed. A payer's published jobs have no relationship to their account state, so even a working session-level suspension would have left their postings in the worker feed, recruiting and accepting applications indefinitely.

## Decision

### 1. The lifecycle

```
Created → Pending Verification → OTP Verified → Active → Suspended → Reinstated
```

Activation happens **immediately** on successful OTP verification. Admin approval is **not** part of the default lifecycle. Future compliance or KYC workflows may add business states, but they must be **additive** — they may not replace this lifecycle or insert a manual gate into it.

"Verification" here means **mailbox control, not business vetting.** The payer proved they receive mail at the address they signed up with. It is deliberately not a claim that the company is real, solvent, or entitled to hire — those are separate, later, and out of scope.

Implementation: `PayersRepository.activate()` is guarded `WHERE status = 'pending'` **in the WHERE clause**, so it is structurally incapable of resurrecting a suspended payer, and it returns a row only when it actually moved — which is what lets `payer.activated` be emitted exactly once per payer rather than on every login.

### 2. Suspension is enforced per request, not per session

`PayerAuthGuard` reads `{role, status}` on every request and 403s anything that is not `active`.

**Not cached in the session blob.** `PayerSessionService` writes that blob once at `create()` and only ever slides its TTL afterwards; the TTL itself slides to a fresh 30 days on *every* request with no absolute ceiling. A status cached there would be stale for the entire unbounded life of an active session — worse than no enforcement, because it would *look* like enforcement.

The cost is one PK-index lookup per guarded request, on a deliberately narrow two-column projection (`findAuthFacts`) — **not** `findById`, which is `select()` and would pull the encrypted contact ciphertext into guard scope on every request to read two scalars.

Suspension also revokes every live session immediately, via a new `payer_sessions:<payerId>` Redis index (sessions were keyed by `sid` alone, so enumerating a payer's sessions was previously impossible). Revocation runs **after** the transaction commits — Redis is not transactional with Postgres, and revoking inside would delete the sessions of a payer whose suspension then rolled back.

### 3. Reinstatement restores the prior state, never a fixed one

`payers.previous_status` is captured in-statement on suspend and restored on reinstate.

Reinstating to a hardcoded `active` would be a **backdoor activation**: suspend a never-verified payer, reinstate them, and they hold an active account without ever passing OTP. `COALESCE(previous_status, 'pending')` resolves the unknown case to the *less* privileged state.

### 4. Suspension freezes the payer's live inventory (owner ruling, 2026-08-03)

> *"A suspended payer cannot recruit through the platform in any way."*

Postings in `open` or `paused` move to a new **`suspended`** status, recording their prior state; reinstatement restores it exactly. Both job tables are swept — `job_postings` (the Matching-V1 served entity) and `jobs` (the legacy entity that still backs the worker feed and the agency surface, TD37).

**Why a status value rather than a join.** The alternative was to filter discovery on the owner's status. That puts a join on the hottest read in the system, and — decisively — it only protects the paths someone remembers to change. Moving the row out of `open` means every existing discovery query excludes it *with no edit at all*, because they all already filter `status = 'open'`: the worker feed, the apply-target lookup, the worker job-detail read, the reach candidate set, and the Matching-V1 feed join. A new discovery path written to the same convention inherits the behaviour for free.

**What is deliberately not swept.** `draft` (never discoverable — nothing to freeze) and `closed` (terminal, and the *payer's own decision* — sweeping it in would make reinstatement reopen jobs they had deliberately taken down).

**What is preserved.** `applications` rows are untouched: a worker who already applied keeps their history and their place. Only *discovery* stops. Conversations, audit trails and reporting are likewise untouched.

**The manual-close carve-out is enforced by the WHERE, not by a caller.** Reinstatement moves only rows that are still `suspended`, so a posting an admin force-closed during the suspension stays closed. `forceClosePosting` clears `previous_status` accordingly — required, not cosmetic, because `job_postings_previous_status_chk` rejects a non-suspended row that still carries one.

**Atomicity.** The cascade runs inside the same transaction as the status change. A payer must not end up barred from logging in while their jobs keep recruiting, nor the reverse.

### 5. OTP is not delivered to a suspended account, and the response is unchanged (owner ruling, 2026-08-03)

The API response and its timing stay **identical** regardless of account state (XB-H, no enumeration). Only *delivery* is suppressed, and the attempt is recorded. This preserves the security property while not paying to message a banned account.

### 6. A captured payment is never rejected (owner ruling, 2026-08-03)

The Razorpay webhook accepts, verifies, records and credits as designed even when the payer is suspended. Refusing to credit money the platform has already taken — with **no refund path anywhere in the codebase** — would be a worse outcome than crediting it. The suspension is enforced where it belongs: on *spending*, which is behind the guard. An ops alert is raised for review.

### 7. Privileged writes need a principal (owner ruling, 2026-08-03)

Ops endpoints that take `payer_id` from the request body are to be eliminated or refactored to run under an authenticated principal with actor identity, capability check, audit, reason and correlation id. **No privileged write may emit `actor_id: null`** unless it is a documented system process.

### 8. A suspended agency is frozen financially (owner ruling, 2026-08-03)

KYC progression, payout eligibility, referral rewards and agency operational actions all stop; historical records are preserved.

## Consequences

**A migration must be applied before the guard ships.** Because nothing ever set `active`, arming the guard against unmigrated data logs out **every existing payer** — and no test would catch it (the payer e2e suite is `.skip` and its `dev_otp` helper has no producer). Migration `0061` backfills `active` for exactly those payers with provable proof of verification: a `payer.session_started` event, which is emitted at one place only, after `otp.verify` succeeds. A payer who signed up but never completed an OTP login stays `pending` and must verify like anyone else. Suspended rows are untouched. Migration `0062` adds the inventory-cascade storage; it is expand-only and safe to apply ahead of the API build.

**Deploy order is expand → migrate → contract:** apply 0061 and 0062 first, then ship the API build. Rolling back means redeploying the previous API build, not reversing the backfill — the backfill cannot distinguish its own rows from ones activated later by a real verify.

**Five new events**, all v1: `payer.activated`, `payer.suspended`, `payer.reinstated` (each carrying both ends of the transition — recording only that "something happened" does not meet *audit every state transition*), plus `payer.inventory_suspended` / `payer.inventory_reinstated` carrying **counts, not ids** (a per-posting event would flood the spine on one admin click; the per-row truth is on the system-of-record). The cascade events are emitted even at zero, because a zero-count event is what distinguishes *"this payer had no live jobs"* from *"the cascade never ran"*.

**One money path is outside every guard.** `db:grant:free-tier` has no request and no principal, so the lifecycle can only be enforced in its query; it now excludes suspended payers. `pending` payers are deliberately still granted — a not-yet-verified signup is exactly who the free tier is for, and the credits are unspendable until they verify.

**Known gap.** `apps/payer-web` hardcodes `status: "active"` in its auth provider, so the portal cannot yet explain a lockout to a suspended payer; they see a generic failure. Tracked as a follow-up.

## Alternatives rejected

**Keep the deferral.** The register row was written as a tripwire for "closer to production". The audit showed the situation was worse than deferred enforcement: the platform shipped a *documented admin capability that could not work*, which is a correctness problem now, not a hardening problem later.

**Enforce in the service layer instead of the guard.** Would require touching 55 routes and would silently miss the 56th.

**Model the frozen state as `closed`.** Terminal and indistinguishable from the payer's own action — suspension would become unrecoverable and reinstatement could not tell what to restore.

**Filter discovery on a join to `payers`.** Rejected in §4: a join on the hottest read, protecting only the paths someone remembers to change.
