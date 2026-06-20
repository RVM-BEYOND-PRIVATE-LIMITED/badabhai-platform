# ADR-0016: Per-payer hiring capacity — active-vacancy cap, auto-pause, auto-resume

- **Status:** **Accepted — PHASE-0 decisions human-signed 2026-06-17 (G0 + D1; posture D5 added
  2026-06-17).** Build **LANDED additively** on `feat/payer-capacity` (commit `491bf49`, PR #77) as
  Phase-2 monetization work under the [ADR-0014](0014-phase-1-schema-foundation-stable.md)
  additive-only policy — **enforcement is INERT by default (D5)**. Real recurring billing, a
  production payer surface, and a `job_postings`→reach bridge remain out / escalations (see
  §Escalations). *(Consolidated here from the standalone ADR PR #76, which is closed in favor of #77 so
  the decision record and the code ship together.)*
- **Date:** 2026-06-17
- **Phase:** Phase-2 alpha-gate (strictly additive; mock payments only)
- **Builds on / amends:**
  - [ADR-0013](0013-monetization-and-config-driven-pricing-engine.md) — the config-driven pricing
    engine + paid posting plans/boost; this ADR **adds** a `capacity` product kind + a per-payer
    capacity entitlement (additive; ADR-0013's catalog/resolve contract is unchanged).
  - [ADR-0010](0010-contact-unlock-and-reveal.md) — its §Decision-1 deferral of subscriptions
    (*"NOT subscription, NOT hybrid; ship credits first"*) is **KEPT, not reopened** (D1 below).
  - [ADR-0012](0012-ops-job-postings-banded-stored-only.md) — `job_postings`; this ADR does **not**
    amend its `draft|open|closed` lifecycle (the additive `paused` state lives on `posting_plans`).
  - [ADR-0014](0014-phase-1-schema-foundation-stable.md) — additive-only change policy (G0).
  - Reuses the [ADR-0010 F-2](0010-contact-unlock-and-reveal.md) advisory-lock atomic check-and-write
    discipline and the `payment.*` mock-payment pattern.

---

## Context

The monetization layer prices things a payer **buys** (posting plans, boost, contact-unlock credit
packs) but caps **nothing** about how many **active vacancies** an opaque payer may run at once.
Product wants: when a payer exceeds their allowed active-vacancy count, **pause** further hiring
activity; **auto-resume** when they buy more capacity / upgrade.

**Verified ground truth (main @ 2026-06-17):**
- `@badabhai/pricing` `postingTier` grants `{validityDays, applicantVisibilityQuota}` only — no
  capacity/subscription. Catalog is ops-editable rows validated by Zod; `resolvePrice()` is pure.
- `posting_plans` carries the opaque `payer_id` (no FK), `tier standard|pro`,
  `status draft|active|expired`, `applicant_visibility_quota` (+ atomic `applicants_viewed_count`).
  `job_postings` carries `vacancy_band` (a **BAND**: `1|2-5|6-10|11-25|25+`), `status
  draft|open|closed`, `created_by` (opaque) — **no `payer_id`, no paused.** `payer_id` is **only** on
  the plan.
- Activation chokepoint = `PostingPlansService.buyPlan` → resolves price → **mock** payment
  (`PAYMENTS_ENABLE_REAL=false`, `real_call` stamped) → `insertPlan({status:"active"})` → emits
  `payment.*` + `job_posting.purchased`. No per-payer aggregation / advisory lock today.
- Reach serving binds `JOB_SOURCE = JobsTableJobSource` over the **`jobs`** entity (ADR-0009/0015).
  There is **no `JobPostingsJobSource`** on main; ADR-0012/TD37 confirm `job_postings` is a separate
  entity with **no bridge** into reach. So `job_postings` **do not surface in reach today.**

---

## Decisions (PHASE-0)

### G0 — Schedule gate → **PROCEED ADDITIVELY** (signed 2026-06-17)
ADR-0014 made the schema **additive-only, not a hard freeze**, and explicitly continues *"Phase-2
additive monetization/reach tables."* This work is purely additive (one new enum value + one new
table + a new catalog product kind + new v1 events) → permitted under that policy with this ADR. No
hard-freeze waiver required.

### D1 — Model → **CAPACITY ADD-ON (quota), NOT a subscription** (signed 2026-06-17)
A payer buys/upgrades a **capacity entitlement** = a `max_active_vacancies` allowance (a "capacity
pack"). This is the credits/packs model ADR-0010 §Decision-1 already endorsed (*"a subscription grant
is just a batch of credits"*), so **ADR-0010's subscription deferral is KEPT, not reopened.** One-time
**mock** purchase/upgrade; **no recurring billing.** A true recurring subscription remains deferred
(it would reopen ADR-0010 + require real recurring billing — an RVM + real-payment escalation).

### D2 — "Active vacancy" basis → **count POSTINGS with an active plan, keyed on opaque `payer_id`**
An **active vacancy** = a `job_postings` row that has an **active `posting_plan` for that
`payer_id`**. Because `vacancy_band` is a coarse band (its int expansion — lower/upper/midpoint — is
arbitrary), capacity counts **postings, not band-expanded openings.** Predicate (faceless, opaque
`payer_id` only, no identity FK):

```
active_vacancies(payer_id) =
  COUNT(*) FROM posting_plans
  WHERE payer_id = :payer
    AND status = 'active'
    AND (expires_at IS NULL OR expires_at > now())
```

### D3 — "Paused" state + the atomic chokepoint
- The additive **`paused`** state lives on **`posting_plans.status`** (`draft|active|expired` →
  **`+paused`**) — the entity that holds `payer_id` and the capacity relationship. **Not** on
  `job_postings` (no `payer_id`; amending the ADR-0012 lifecycle has a larger blast radius).
- The **single atomic chokepoint** is `PostingPlansService.buyPlan` activation, under a
  **`pg_advisory_xact_lock` on `payer_id`** (ADR-0010 F-2 discipline — count-and-write in one
  transaction, never read-then-write). If activating this plan would make `active_vacancies > allowed`,
  the plan is written **`paused`** instead of `active`, and a `posting_plan.paused` event is emitted.
  **(Whether it actually pauses is gated by the enforcement flag — see D5; by default it does not.)**
- **What "paused" enforces TODAY** (the honest, in-scope effects):
  1. it is **not** counted as an active vacancy, and
  2. it **does not consume applicant-view quota** (the `posting_plans` view chokepoint treats a
     non-active plan as not serving).
- **Reach-exclusion is MOOT today (flagged).** The task brief asked that a paused posting stop
  surfacing in reach View A/B — but **reach serves `jobs`, not `job_postings`**, and there is no
  bridge. So there is nothing to exclude from reach today. If a `job_postings`→reach bridge is ever
  built, "exclude non-active plans" must be honored **at that mapper** — tracked as a follow-up
  (§Consequences), **not** built here.

### D4 — Capacity product + auto-resume
- Add a **`capacity` product kind** to the `@badabhai/pricing` catalog (discriminated union),
  tiers granting **`maxActiveVacancies`** (ops-editable, Zod-validated, fail-closed, **no hardcoded
  numbers**) — additive to the existing `posting|boost|credit_pack` union.
- A faceless **`payer_capacity`** entitlement row holds the payer's current allowance: opaque
  `payer_id` (no FK), `max_active_vacancies`, source `tier`, validity window. (A payer with no row
  uses a config-default allowance — ops-editable, fail-closed.)
- **Buy/upgrade = mock payment** (reuse `buyPlan`'s mock + `payment.*`) → raises
  `max_active_vacancies` → **auto-resume**: recompute the cap and flip `paused→active` up to the new
  allowance in a **deterministic order** (oldest `paid_at` first) under the same `payer_id` advisory
  lock, emitting `posting_plan.resumed` per resumed plan.

### D5 — Enforcement posture: INERT/SHADOW by default (signed 2026-06-17)

**The build shipped `CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES=1`, which would ENFORCE by
default** — a payer with no capacity row would be capped at 1 active plan, silently pausing
their 2nd posting. **The human chose to make enforcement OPT-IN instead.**

A new config flag **`CAPACITY_ENFORCEMENT_ENABLED` (boolean, default `false`)** gates **only**
whether `buyPlan` actually transitions an over-cap plan to `paused`:

- **Default = inert / shadow.** The chokepoint **still computes** the would-pause decision
  under the per-payer advisory lock (it counts active vacancies, reads the allowance, and
  evaluates `activeNow + 1 > allowed`), but the plan stays **`active`** — nothing is paused.
  The would-pause is recorded as a **PII-FREE structured LOG line** (ids/counts/codes only)
  **plus a `wouldPause` flag** on the `buyPlan` result. No spine event is emitted for a
  shadow decision.
- **`CAPACITY_ENFORCEMENT_ENABLED=true` → enforce.** Only then does an over-cap plan get
  written `paused` and a `posting_plan.paused` event emitted. Auto-resume on `buyCapacity` is
  unaffected (it only ever flips already-paused plans back, so it is a no-op while nothing is
  paused).
- The flag uses `booleanFromString` (not `z.coerce.boolean`, whose `"false"`/`"0"` coerce to
  `true`) so a falsey string stays OFF — fail-safe to inert, consistent with
  `AI_ENABLE_REAL_CALLS` / `PAYMENTS_ENABLE_REAL`.

**Why shadow is OFF-SPINE (a log + a result flag, NOT an event):**

- `action.recorded` is **worker-scoped** (it requires a `worker_id` + a worker `action_type`)
  → it **cannot** represent a payer/system capacity decision. Misusing it would put a
  non-worker decision on a worker-scoped event.
- `posting_plan.paused` asserts a **REAL pause** (it carries `reason: capacity_exceeded` and
  the consumers treat it as "this plan no longer serves"). Emitting it for a non-pause would
  break **event↔state honesty** (an event that asserts a state the DB does not hold).
- The guardrails forbid a new event / a payload change for this. Hence **shadow = log + the
  `wouldPause` result flag**, deliberately off the audit spine.
- **One-event upgrade path (a FUTURE decision, NOT built now):** IF spine-level shadow
  analytics are later wanted (e.g. to measure how often the cap *would* bite before flipping
  it ON), that needs **ONE new additive v1 event** — e.g. `capacity.evaluated`
  `{ payer_id, active_now, allowed, would_pause }` (PII-free) — authored via
  `event-schema-change`. That is a separate ADR; until then shadow stays log-only.

**Rationale (why default to inert):** in alpha the caller is `InternalServiceGuard` with a
**spoofable** `payer_id` (a shared service secret, no per-payer proof), so the cap is
**ADVISORY** until `PayerAuthGuard` lands (LC-1 / TD33). Silently pausing real employers'
postings while the cap is only advisory is the kind of surprise §7 forbids — so enforcement
is **deferred to a deliberate config flip**, paired with `PayerAuthGuard`. This is consistent
with §7 (no posture that unexpectedly pauses employers in alpha).

### New events (v1, PII-free — ids/enums/counts only; VERSION, never mutate)
- `capacity.purchased` — `{ payer_id, tier, max_active_vacancies, price_inr, real_call }`
- `posting_plan.paused` — `{ plan_id, job_posting_id, payer_id, reason: "capacity_exceeded" }`
- `posting_plan.resumed` — `{ plan_id, job_posting_id, payer_id, reason: "capacity_restored" }`
- Reuse `payment.authorized` / `payment.captured` for the capacity purchase.

> Naming note: events are `posting_plan.*` (not the brief's `job_posting.*`) because the `paused`
> state lives on `posting_plans` — the subject is the plan.

---

## Invariants held

- **Faceless / no PII** — capacity is aggregated by **opaque `payer_id`** only; `payer_capacity` has
  no FK and no identity; every new event is ids/enums/counts. "Employer entity" stays a dead decision.
- **Event-first** — activation-paused, capacity-purchase, and auto-resume each emit a validated event.
  *(A shadow would-pause is NOT a state change — nothing pauses — so it correctly emits no spine event;
  D5.)*
- **Additive / backward-compatible** — one new nullable-friendly enum value on `posting_plans.status`,
  one new table (`payer_capacity`), one new catalog product kind, one new optional config flag; **no
  shipped column/event/payload mutated** (ADR-0014 / invariant 8).
- **Atomic, no cap-bypass** — the cap check + plan write is one advisory-locked transaction (ADR-0010
  F-2), so N concurrent activations for one payer can never exceed the cap (when enforcement is ON).
- **Mock payments only** — `PAYMENTS_ENABLE_REAL=false`; `real_call` stamped honest.

## Security caveat (documented, not assumed enforced)
Under `InternalServiceGuard` the `payer_id` is **client-supplied → spoofable** by the shared-secret
holder, so the per-payer cap is **ADVISORY until `PayerAuthGuard` (LC-1)**. **No production payer
surface ships on the shared secret.** Enforcement is **inert by default** (D5) precisely so the
advisory cap never silently pauses an employer in alpha. (Cross-ref TD33 / TD43.)

## Escalations (human-gated — STOP)
- **Real recurring billing / true subscription** → reopens ADR-0010 + real payments → RVM + real-payment STOP.
- **Production payer surface** → needs `PayerAuthGuard` (LC-1 / TD33) — the cap is advisory until then.
- **Flipping `CAPACITY_ENFORCEMENT_ENABLED=true`** → a deliberate product gate (pairs with
  `PayerAuthGuard`); do not enable in a way that unexpectedly pauses employers in alpha (§7).
- **`job_postings`→reach bridge** (to make "paused" affect reach) → separate ADR.

## Consequences / follow-ups (logged as tech-debt — TD43)
- Capacity cap is **advisory** until `PayerAuthGuard` (TD33 / LC-1).
- Enforcement is **inert by default** (D5); flipping it ON is a deliberate product gate paired with
  `PayerAuthGuard`. Until then the cap is shadow-only (logged, not enforced).
- Spine-level shadow analytics (how often the cap *would* bite) would need one additive v1 event
  (`capacity.evaluated`) — a future decision, not built now.
- "Paused excludes from reach" is **moot until a `job_postings`→reach bridge** exists; if built, the
  bridge mapper must skip non-active plans (new follow-up TD).
- `payer_capacity` joins the RLS backlog (TD20) like the other faceless monetization tables.
- Band→openings counting (vs postings) is deliberately deferred (D2); revisit only if product needs
  opening-level capacity.

## Build plan (additive; routed to existing agents) — **BUILT 2026-06-17**
1. **database-architect** — `posting_plans.status += 'paused'` (additive CHECK update); new
   `payer_capacity` table (opaque `payer_id`, `max_active_vacancies`, tier, window); additive
   migration `0019` + rollback; RLS backlog. ✅
2. **backend-engineer** — `capacity` product kind in `@badabhai/pricing` (ops-editable, fail-closed);
   the atomic per-payer chokepoint in `buyPlan` (advisory lock, pause-at-cap); the capacity
   purchase/upgrade flow with auto-resume; new v1 events; reuse `payment.*` (mock); the D5
   enforcement flag (`CAPACITY_ENFORCEMENT_ENABLED`, default OFF / shadow). ✅
3. **qa-engineer** — N-concurrent-activation never exceeds the cap (atomic, M > pool size);
   pause-at-limit; auto-resume on purchase/upgrade; shadow vs enforce; faceless/no-PII; events
   emitted; deterministic resume order. ✅
4. **security-engineer** — faceless aggregation; the PayerAuthGuard advisory caveat; mock only. ✅ PASS
5. **code-reviewer + technical-writer** — additive-only; registers updated; this ADR's status → built.
   ✅ (code-review M1 in-lock pool read folded in.)

> **Landed** as commit `491bf49` (+ the D5 shadow flag) on `feat/payer-capacity`, PR #77; full gate
> green (typecheck / api tests / lint / build); security PASS + code-review folded. Consolidated from
> PR #76 (closed in favor of #77 so the decision and the code review together).
