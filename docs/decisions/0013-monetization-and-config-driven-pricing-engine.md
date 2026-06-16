# ADR-0013: Employer/Agent Monetization + a config-driven Pricing Engine (Phase-0 design)

- **Status:** **ACCEPTED (2026-06-16)** — signed off by the maintainer with resolutions
  recorded in the **§ SIGN-OFF** block below. Implementation is authorized **behind the
  gates stated there** (mock-credits only; the resume-download threat-model addendum remains
  a hard pre-build gate; real Razorpay stays a STOP). The original six decisions are
  preserved below as the design history; where a resolution conflicts with the body, the
  resolution wins.
- **Date:** 2026-06-16
- **Phase:** **Phase-2** (employer/agent posting, booster, candidate search / resume
  download, and the pricing engine are all in CLAUDE.md §8 "Deferred — do not build in
  Phase 1 without an explicit decision"). This ADR draws the contract so the build, when
  authorized, stays inside the §2 invariants. **Phase-2 scope does not start on the basis
  of this document.**
- **Author:** system-architect agent (architecture + contract). Pricing numbers, the
  engine source-of-truth ratification, the real-payment go/no-go, and the resume-download
  threat model are explicitly deferred to the human/RVM and the security-engineer.
- **Builds on / reconciles (verified against the repo, 2026-06-16):**
  - **[ADR-0010 — Contact Unlock + Reveal](0010-contact-unlock-and-reveal.md)** +
    **[contact-unlock threat model](../security/contact-unlock-threat-model.md)** — the
    routed-disclosure spine: the fail-closed disclosure ordering (consent → caps →
    payment → grant → routed reveal), the `employer_sharing` DPDP consent gate, the
    per-worker caps chokepoint (`UnlockGuardService`), the `PaymentGateway` seam +
    `PAYMENTS_ENABLE_REAL=false`, the PII-free `unlock.*`/`contact.*`/`payment.*` event
    family, the no-oracle rule, and the F-1…F-7 / BC-1…BC-8 build-blockers. **This ADR
    REUSES that spine for resume download; it does not fork it.**
  - **[packages/db/src/credit-packs.ts](../../packages/db/src/credit-packs.ts)** — the
    existing config-driven contact-unlock packs (`PACK_10` ₹1000/10, `PACK_25` ₹2000/25,
    `UNLOCK_WINDOW_DAYS=14`). **This ADR absorbs these constants into the pricing engine.**
  - **[ADR-0012 — ops-created, banded, stored-only `job_postings`](0012-ops-job-postings-banded-stored-only.md)**
    — the merged `job_postings` entity (ops-created, `vacancy_band`, `draft→open→closed`,
    `job_posting.*` v1 events, RLS-locked, free-text never in events). **This ADR adds a
    paid PLAN additively on top of `job_postings`; it does NOT fork a new jobs entity and
    does NOT touch the alpha ADR-0009 `jobs` / `job.*` entity.**
  - **[ADR-0011 — Reach feed serving](0011-reach-feed-serving.md)** — the ranked
    applicant list (View A) + worker job feed (View B) over the RANK core, emitting
    `feed.shown`, faceless. **This ADR's "candidates page" / "applicant visibility" reuses
    ADR-0011's serving + `JobSource` port; it adds no ranking and no new feed event.**
  - **[ADR-0009 — alpha swipe-to-apply](0009-alpha-swipe-to-apply-seeded-jobs.md)** — the
    live seeded `jobs` + `applications`. Untouched here (distinct entity; coexistence per
    ADR-0012 §Coexistence).
  - **Event enums (verified):** `EVENT_DOMAINS` already includes `job_posting`, `unlock`,
    `contact`, `payment`; `SUBJECT_TYPES` already includes `job_posting`, `job`, `unlock`;
    `ACTOR_TYPES` already includes `payer` **and** `agent`. The new event domains this ADR
    proposes (`pricing`) are the only enum additions; the rest are additive payloads on
    existing domains/subjects.
  - **CLAUDE.md §2 invariants 1, 2, 4, 5, 6, 7, 8; §7 escalation; §8 deferred list.**

---

## SIGN-OFF (2026-06-16) — human/RVM: ACCEPTED with resolutions

> Where a resolution here conflicts with the original proposal body below, **the resolution
> wins** (the body is preserved as design history). Implementation is authorized behind the
> gates restated at the end of this block.

- **A — Pricing engine: APPROVED (hybrid).** Build the **entire config builder** — a typed
  `@badabhai/pricing` Zod schema + the deterministic resolve algorithm, with all values
  (prices, tiers, applicant-visibility quotas, validity/boost windows, discounts, offers,
  coupons) stored as **ops-editable DB catalog rows, Zod-validated on load, fail-closed**.
  The maintainer must be able to change prices/discounts/coupons without a code rewrite.
  **A-R1** hybrid confirmed; **A-R2** at-most-one-offer + at-most-one-coupon, documented
  precedence, never negative/free; **A-R3** ops-only edit surface. `credit-packs.ts` is
  absorbed (A.5).
- **B — Job-posting monetization: APPROVED.** Paid `posting_plans` (standard ₹1000/14d/10
  applicants · pro ₹2500/30d/30 views) + `posting_boosts` (₹1200/2d) additively on ADR-0012
  `job_postings`; applicant-visibility **quota** enforced at a single atomic chokepoint;
  opaque `payer_id` (employer OR agent); **B-R1** ops-created with opaque payer (b-i);
  **B-R2** no refunds; **B-R3** reject overlapping active boosts. Prices are **catalog rows**
  (editable), seeded with these values.
- **C — Resume download: CHANGED BY MAINTAINER → FREE (not a paid product).** Resume
  download is **given to the employer from the candidates side at NO charge** — there is
  **no resume-pack SKU, no credits, no payment** for it. The standalone candidate-search
  resume packs (₹1000/15, ₹2500/35) from the spec are **DROPPED**. **However, a downloaded
  resume still carries the worker's NAME (TD21) → it remains a PII DISCLOSURE** and keeps
  the **full ADR-0010 protection spine**: `employer_sharing` consent gate → per-worker caps
  → fail-closed ordering → grant → controlled disclosure → PII-free `resume.disclosed`
  event. **The only removed step is PAYMENT/credit-debit** (step [3] of C.2 becomes a no-op
  / is skipped). **C-R3 / R-1 — the resume-download threat-model addendum REMAINS A HARD
  PRE-BUILD GATE** (arguably more important without payment friction throttling volume; the
  addendum must pin: does swipe-to-apply imply `employer_sharing` consent or is a separate
  consent still required? default = still gated, fail-closed). **C-R1/C-R2:** caps are a
  **shared** per-worker disclosure ceiling across unlock + resume.
- **D — Events: APPROVED with one drop.** Keep `job_posting.purchased`,
  `job_posting.boosted`, `applicant.viewed`, `resume.disclosed`, `coupon.redeemed`,
  `pricing.changed`; **DROP `resume_pack.purchased`** (no paid resume packs). All v1,
  PII-free, version-never-mutate.
- **E — Payments: APPROVED, mock-only.** One `PaymentGateway` seam, mock credits / direct
  mock purchases, `PAYMENTS_ENABLE_REAL=false` default. **Razorpay: add the env requirements
  (config keys) to `.env.example` as documented, NOT-enabled config; do NOT wire or enable
  real calls.** Flipping real Razorpay (keys/spend/staging-first) stays a **STOP + human
  escalation** (E-R2). **E-R1:** posting/boost = direct purchase recorded in the ledger;
  contact-unlock stays credit packs.
- **F — Worker protection + DPDP: APPROVED, unchanged.** Workers never charged; resume
  disclosure keeps the full ADR-0010 protection chain (consent + caps + retention/erasure +
  DPDP copy launch gate) **even though it is now free**.

**Gates still in force for the build:** (1) the **resume-download threat-model addendum**
must be authored + pass before the resume-disclosure stream ships; (2) **no real
payment-provider keys/spend** — mock only, Razorpay env documented but disabled; (3)
additive-only, no PII in events/logs/LLM input, every important write emits a validated
event; (4) security review (security-engineer + bb-security-review) before merge.

---

## Context

The maintainer has specified the **revenue surface** for BadaBhai: a payer (an **employer
OR an agent** — the same opaque-payer model as ADR-0010) can **pay to post a job**, **boost
a job's reach**, and **buy candidate-resume access**. Four monetizable products, each with
tiers/quotas/windows, plus a cross-cutting directive: **do NOT hardcode prices** — build a
single, typed, centralized, *editable-without-a-code-rewrite* **pricing catalog** covering
**every** monetizable product **plus discounts, offers, and coupons**, and **absorb the
existing `packages/db/src/credit-packs.ts` constants into it.**

The product spec (prices are RVM's to ratify):

1. **Paid job posting** (employer OR agent pays):
   - **Standard:** ₹1000 / 14 days validity / 10 applicants visible.
   - **Pro:** ₹2500 / 30 days / 30 profile views.
   - "to view more candidates he pays more" → an **applicant-visibility QUOTA per posting**;
     viewing beyond the quota costs more.
2. **Booster:** ₹1200 / 2 days — makes the job visible to **all** candidates.
3. **Candidate search + resume download:** direct resume download — **₹1000 / 15
   candidates, ₹2500 / 35 resumes**; "relevant candidates' resumes shown in a candidates
   page" (= the ADR-0011 ranked feed). These pack sizes **differ** from ADR-0010's unlock
   packs (₹1000/10, ₹2000/25) → this ADR decides whether resume-download is a **separate
   product/credit-SKU** or a unification (Decision C; recommendation: separate SKU, shared
   disclosure spine).
4. **Cross-cutting:** the **pricing config-builder** — one typed catalog, prices/tiers/
   discounts/coupons changeable without a redeploy, Zod-typed, deterministic (no LLM),
   PII-free, auditable.

**The disciplines that govern every decision below (restated up front):**

- **Workers are NEVER charged** (ADR-0010 §Sign-off). All money is on the payer side.
  Workers are never a line item in the catalog.
- **A downloaded resume carries the worker's NAME (TD21) → it is a PII DISCLOSURE to the
  payer**, architecturally the *same class of event* as Contact Unlock's routed reveal. It
  **must** ride the ADR-0010 disclosure spine (consent gate → caps → payment → grant →
  controlled disclosure), and it **widens** the PII-disclosure surface (a full resume
  document vs a routed contact). **A security threat-model ADDENDUM to the ADR-0010 threat
  model is REQUIRED before this is built** (Decision C, flagged as a hard pre-build gate).
- **The pricing engine never decides anything an LLM would** — it is pure deterministic
  arithmetic over a typed catalog (invariant 4 trivially held; no model on this path, and
  none may be added). It is **PII-free** (prices, codes, ids, percentages — never a payer
  name or a worker identity).
- **Mock-credits / `PAYMENTS_ENABLE_REAL=false` is the alpha default** (invariant 5,
  ADR-0010 §D5). **Real Razorpay is the chosen provider but is a HARD human-gated
  escalation** (keys/spend, staging-first) — stated here, not assumed (Decision E).
- **Additive only** (invariant 8): new tables/columns/events, no mutation of a shipped
  payload or column. The unlock spine, `job_postings`, the reach serving layer, and
  `credit-packs.ts` consumers all keep working.

---

## Decision — overview

Define — **for sign-off, not for build** — six decisions:

| # | Decision | Headline |
|---|----------|----------|
| **A** | **Pricing Engine architecture** | **Hybrid: typed Zod schema (`@badabhai/pricing`) + DB-stored catalog values, validated-on-load, ops-editable, fail-closed.** The single source of truth for every price/tier/quota/window/discount/coupon. |
| **B** | **Job-posting monetization** | Additive `posting_plans` (+ booster) on top of ADR-0012 `job_postings`; visibility-quota enforcement; `draft → paid/active → expired` lifecycle. |
| **C** | **Resume download / candidate search** | **A DISTINCT product (separate resume-pack SKU) that REUSES the ADR-0010 disclosure spine** (consent + caps + fail-closed + PII-free events + credit debit). **Threat-model addendum REQUIRED before build.** |
| **D** | **Events** | New PII-free v1 events (`job_posting.purchased`, `job_posting.boosted`, `applicant.viewed`, `resume_pack.purchased`, `resume.disclosed`, `coupon.redeemed`, `pricing.changed`); reuse `payment.*` + the ADR-0010 disclosure events. Version, never mutate. |
| **E** | **Payments** | All four products flow through the **same** `PaymentGateway` seam + the pricing engine. Mock in alpha; **real Razorpay is human-gated** (staging-first, keys/spend). |
| **F** | **Worker protection + DPDP** | Workers never charged; resume download needs `employer_sharing` consent + caps + retention/erasure + DPDP copy launch gates (cross-ref ADR-0010 R-3/T10/RR-1…RR-4). Booster + applicant-visibility leak no worker PII beyond consent. |

---

## Decision A — Pricing Engine architecture (the headline)

**REQUIRES HUMAN/RVM SIGN-OFF — not assumed.** This is the maintainer's "no hardcoded
prices" directive made concrete. The **engine source-of-truth choice is the primary thing
to ratify.**

### A.1 Options weighed

| Option | What it is | Editable without redeploy? | Auditable | Type-safe | Verdict |
|---|---|---|---|---|---|
| **(i) typed config package** (`@badabhai/pricing` loaded at boot) | prices live in TS constants (like `credit-packs.ts` today) | **No** — a price change is a code change + redeploy | via git history only | yes (compile-time) | **Rejected as the sole mechanism** — directly violates "changeable without a code rewrite / ideally without a redeploy." It is, however, the right home for the *schema + the resolve logic*. |
| **(ii) DB-backed catalog** (`pricing_plans`/`discounts`/`coupons` tables, ops-edited) | prices are rows; ops edits them | **Yes** — edit a row, no deploy | via `pricing.changed` event + ops audit | **No** by itself — DB rows are untyped JSON until validated | **Rejected as the sole mechanism** — values can drift from any type, a bad row could yield a negative/garbage price. Needs a typed gate. |
| **(iii) HYBRID — typed Zod schema in `@badabhai/pricing` + DB-stored values, Zod-validated on load** | the *shape, invariants, and resolve algorithm* are typed code; the *values* (prices, tiers, quotas, windows, discounts, coupons) are DB rows loaded + **Zod-parsed at boot and on change**; an invalid row **fails closed** to the last-good catalog (or a typed default) and is rejected, never served | **Yes** — values are DB rows, editable via an ops surface, no redeploy | **Yes** — every change emits `pricing.changed` (Decision D) + ops audit | **Yes** — Zod validates every row against the typed schema on load; a row that would produce a negative/garbage/zero price is rejected | **RECOMMENDED** |

### A.2 Recommendation — **(iii) the hybrid**

A new package **`@badabhai/pricing`** owns the **typed schema + the deterministic resolve
algorithm** (pure functions, no I/O, no LLM, unit-testable in isolation — the
`@badabhai/reach-engine` discipline). The **values** live in DB catalog tables, edited via
an ops-only surface, **loaded + Zod-validated on boot and on every change**, with a
**fail-closed** posture: an invalid catalog row is rejected and the engine keeps serving the
last-known-good (or a typed safe default) — it **never** serves an unvalidated or negative
price.

**Why hybrid wins:** it is the only option that satisfies *both* halves of the directive —
**"don't hardcode"** (values are DB rows, ops-editable, no redeploy) **and** **typed +
deterministic + safe** (the schema and the math are code; Zod is the gate that makes
untyped DB values safe to serve). It mirrors the codebase's strongest pattern — a typed,
contract-free core (`@badabhai/reach-engine`) consumed behind a seam — and the
config-fail-closed pattern (`assertPiiCryptoConfig`, `PAYMENTS_ENABLE_REAL`,
`AI_ENABLE_REAL_CALLS`).

### A.3 What the engine MUST be (the contract)

1. **Single source of truth.** Every price, tier, applicant-visibility quota, validity
   window, boost window, resume-pack size, and contact-unlock pack resolves through this
   engine. No other module hardcodes a price. **`credit-packs.ts` is absorbed** (A.5).
2. **Covers all four products + discounts + offers + coupons:** job-posting tiers, booster,
   resume-download packs, contact-unlock packs; **percentage AND flat discounts**;
   **time-boxed offers** (a discount with a validity window); **coupon codes** (with
   validity window, total usage cap, per-payer usage limit, and an applicability scope —
   which products/tiers the coupon applies to).
3. **Zod-typed** end to end (TS). If the engine ever has a Python consumer, the contract is
   mirrored per invariant 7 — **but no Python consumer is planned** (payments + posting +
   resume serving are all NestJS; the engine has no AI-service caller). Flagged, not built.
4. **Deterministic, no LLM** — `resolvePrice(input) → quote` is pure arithmetic over the
   validated catalog. Same input + same catalog → same output. No model, no randomness
   (invariant 4).
5. **PII-free** — inputs/outputs are product codes, tier ids, `payer_id` (opaque), coupon
   codes, integer ₹ amounts, and percentages. **No payer name, no worker identity, no
   contact** ever enters the engine, the catalog tables, or the `pricing.*`/`coupon.*`
   events.
6. **Auditable** — every catalog/coupon change emits a PII-free `pricing.changed` event
   (Decision D) and is ops-audited; every coupon redemption emits `coupon.redeemed`.
7. **Fail-closed on money** — an invalid coupon, expired offer, over-limit coupon, or a
   catalog row that fails Zod **never** produces a discount, **never** a negative price,
   **never** a free product. Worst case is "full list price" or "unavailable," never
   "free/garbage."

### A.4 The resolve flow (deterministic, fail-closed)

```
requestedProduct + tier (+ optional couponCode) + payer_id (opaque)
        │
        ▼
[load] validated catalog (Zod-parsed; invalid rows already rejected, last-good served)
        │
        ▼
[1] base price ← catalog[product][tier].priceInr            (integer ₹; missing → "unavailable", never 0)
        │
        ▼
[2] applicable OFFERS ← active, in-window, scope-matching offers for (product,tier)
        │   (a time-boxed offer is a discount with from/until)
        ▼
[3] COUPON (if supplied) ← validate fail-closed:
        valid code? in validity window? under total usage cap? under per-payer limit?
        scope matches (product,tier)?  ─ any "no" → coupon IGNORED (no discount), NEVER an error price
        ▼
[4] apply discounts deterministically (documented precedence: offer then coupon, or
        best-of — RATIFY in A.6; percentage applied before flat, both clamped):
        finalInr = max( floorPriceInr, basePrice − discounts )      (floor ≥ 0; never negative)
        ▼
[5] QUOTE { product, tier, basePriceInr, discountInr, finalInr, couponApplied: bool,
           grantsOnPurchase: { …quota/window/credits per product… } }   ← PII-FREE
        │
        ▼
hand `finalInr` + `grantsOnPurchase` to PaymentGateway.authorizeAndDebit (mock in alpha, Decision E)
        │
        ▼
on capture success → grant the product entitlement (posting plan / boost / resume credits / unlock credits)
        ▼
emit coupon.redeemed (if a coupon applied) + the product's purchase event (Decision D)
```

- **Coupons/discounts fail closed:** invalid/expired/over-limit coupon → **no discount,
  full price**, the purchase still proceeds at list price (never blocked by a bad coupon,
  never discounted by it). A negative or zero computed price is impossible by the
  `max(floorPriceInr, …)` clamp + the Zod `>= 1` price invariant.
- **Idempotency:** the quote is pure (no side effect); the **debit + grant** is the
  side-effecting, idempotent step (Decision E), keyed like ADR-0010's debit so a retried
  purchase never double-charges/double-grants/double-redeems a coupon.

### A.5 Reconciling / absorbing `credit-packs.ts`

`packages/db/src/credit-packs.ts` (`PACK_10` ₹1000/10, `PACK_25` ₹2000/25,
`UNLOCK_WINDOW_DAYS=14`) becomes a **`contact_unlock` product in the catalog**, not a
separate constants file. Migration path (additive, non-breaking):

1. Seed the catalog's `contact_unlock` product with `pack_10`/`pack_25` rows mirroring the
   current constants **exactly** (₹1000/10, ₹2000/25, 14-day window) — same `code` values
   so existing `credit_ledger.pack_code` references stay valid (invariant 8).
2. `credit-packs.ts` is **kept as a thin re-export / typed default seed** for the catalog
   (so the engine has a known-good fallback if the DB catalog fails to load — the
   fail-closed last-resort), then its direct consumers are pointed at the engine. **No
   shipped value changes; no `credit_ledger` column changes.** This is a follow-up
   refactor, not a rewrite.
3. **Note the price-list reconciliation for resume packs (Decision C):** the spec's
   resume-download packs (₹1000/15, ₹2500/35) are a **different SKU** from the unlock packs
   (₹1000/10, ₹2000/25); they coexist as two distinct products in the one catalog. They are
   **not** merged into a single pack list (Decision C explains why).

### A.6 Open ratifications inside Decision A (surface at sign-off)

- **A-R1 — engine source-of-truth:** confirm **hybrid (iii)**. (Or downgrade to typed-only
  (i) for the very first alpha if "no redeploy" is deferred — but that contradicts the
  directive, so recommended **no**.)
- **A-R2 — discount precedence:** offer-then-coupon vs best-of-single vs stackable.
  **Recommend:** at most one offer + one coupon, applied in a documented order, never
  stackable beyond that, always clamped ≥ floor. RVM to confirm the policy.
- **A-R3 — who edits the catalog:** ops-only surface (no payer-facing pricing edit, ever).
  Recommend ops-only, behind `InternalServiceGuard` + audit, until a real admin-auth seam
  exists.

---

## Decision B — Job-posting monetization (additive on ADR-0012 `job_postings`)

**REQUIRES HUMAN/RVM SIGN-OFF — not assumed.**

**Recommendation: add a paid PLAN to a `job_postings` row additively — do NOT fork a new
jobs entity.** (The gated PR #42 jobs entity was closed/superseded; ADR-0012 §Coexistence
and ADR-0011's `JobSource` port are the live shape.) A `job_posting` becomes the billable
object a payer (employer OR agent) buys a plan on.

### B.1 Reconcile the actor: who owns a paid posting?

ADR-0012's `job_postings` is **ops-created** (`created_by` = opaque ops actor). The spec
wants an **employer/agent** to pay to post. Two reconciliations (RATIFY — B-R1):

- **(b-i, recommended for alpha):** keep `job_postings` ops-created; add an **opaque
  `payer_id`** (faceless rails, no FK, no PII — identical to ADR-0010's `payer_id`) to the
  *paid plan*, not to the posting's identity. Ops creates the posting on a payer's behalf
  (same interim posture as ADR-0010's `InternalServiceGuard` payer gap, T7); the plan
  records which opaque payer paid. **No employer entity, no payer self-serve** (both are
  CLAUDE.md §8 deferred / dead-decision).
- **(b-ii, later):** payer self-serve posting — requires `PayerAuthGuard` (ADR-0010 T7 /
  LC-1, a launch gate) and is **OUT** of this ADR.

### B.2 Additive data model (PII-FREE; values, not free-text)

All additive; follows `schema.ts` conventions; joins the RLS backlog (TD20) like the
unlock tables. **No employer/payer PII; `payer_id` opaque.**

**`posting_plans` — one paid plan attached to a `job_posting`.**

| column | type | notes |
|---|---|---|
| `id` | uuid PK | the opaque `plan_id` in events |
| `job_posting_id` | uuid NOT NULL → FK `job_postings.id` | the posting this plan paid for |
| `payer_id` | uuid NOT NULL | opaque payer (employer OR agent); faceless rails, **NO FK, NO PII** |
| `tier` | text `$type<PostingTier>()` | `standard \| pro` — **resolves price/quota/window from the pricing engine, never hardcoded** |
| `applicant_visibility_quota` | integer NOT NULL | stamped from the catalog at purchase (10 / 30); the cap on profiles viewable for this posting |
| `applicants_viewed_count` | integer NOT NULL default 0 | viewed against the quota; atomic increment (same race discipline as ADR-0010 F-2/T5-a) |
| `paid_at` | timestamptz (nullable) | set on capture |
| `expires_at` | timestamptz (nullable) | `paid_at + validity_days` (14 / 30 from the catalog) |
| `status` | text `$type<PostingPlanStatus>()` | `draft \| active \| expired` |
| `created_at` / `updated_at` | timestamptz | |

**`posting_boosts` — the booster (₹1200 / 2 days).**

| column | type | notes |
|---|---|---|
| `id` | uuid PK | opaque `boost_id` |
| `job_posting_id` | uuid NOT NULL → FK `job_postings.id` | |
| `payer_id` | uuid NOT NULL | opaque |
| `tier` | text `$type<BoostTier>()` | `all_candidates` (the spec's single tier today; extensible) — window + price from the catalog |
| `boost_starts_at` / `boost_ends_at` | timestamptz | the 2-day (catalog-driven) window |
| `status` | text `$type<BoostStatus>()` | `active \| expired` |
| `created_at` / `updated_at` | timestamptz | |

- **All numbers (quota 10/30, validity 14/30, boost 2 days, prices) come from the pricing
  engine at purchase time and are STAMPED onto the row** — so a later catalog change does
  not retroactively alter a paid plan (the row is the receipt of what was bought). This is
  the same "stamp the quota at purchase" discipline the gated #42 used.

### B.3 Lifecycle (`draft → paid/active → expired`)

```
job_posting (ADR-0012: draft → open → closed)   ← posting CONTENT lifecycle (unchanged)
        │ a payer buys a plan (pricing engine → PaymentGateway → grant)
        ▼
posting_plan: draft → active (paid_at set, expires_at = paid_at + validity)  → expired (window lapses)
        │ optional booster purchased
        ▼
posting_boost: active (2-day window) → expired
```

- The ADR-0012 `job_posting.status` (`draft/open/closed`) — the **content** state — is
  **unchanged and orthogonal** to the **plan** state. A plan can expire while the posting
  stays `open`; closing the posting does not refund a plan (refunds are OUT, B-R2).
- **Visibility-quota enforcement (the "view more candidates → pay more" rule):** viewing a
  candidate's profile against a posting decrements the quota at a **single chokepoint**
  (reuse/extend the ADR-0010 `UnlockGuardService` discipline — atomic check-and-increment,
  F-2/T5-a). When `applicants_viewed_count >= applicant_visibility_quota`, further views
  require a **new purchase** (a quota top-up SKU in the catalog) → resolve price → debit →
  raise the quota. **Each profile view that discloses PII is itself a disclosure** and
  rides Decision C's spine (see C — a "profile view" that reveals name/contact is the same
  disclosure class).

### B.4 Booster + visibility do not leak PII (Decision F cross-ref)

The booster makes a **job** "visible to all candidates" — that is a **worker-facing**
broadcast of a faceless job (ADR-0011 View B), **not** a disclosure of worker PII to the
payer. "Applicant visibility" to the payer is the ADR-0011 **faceless** applicant list
(opaque `worker_id`, rank, signals — **no name/contact**) until a per-applicant
**disclosure** (Decision C) is paid for and consented. **The quota counts disclosures, not
faceless impressions.**

### B.5 Open ratifications inside Decision B

- **B-R1:** posting actor — ops-created-with-opaque-payer (b-i) vs payer self-serve (b-ii,
  needs `PayerAuthGuard`, OUT). Recommend **b-i** for alpha.
- **B-R2:** refunds / proration on early close / expiry — recommend **none** in alpha
  (plan is a non-refundable receipt); confirm.
- **B-R3:** booster overlap (two boosts on one posting) — recommend reject overlapping
  active boosts; confirm.

---

## Decision C — Resume download / candidate search = PII DISCLOSURE (reuse ADR-0010 spine)

**REQUIRES HUMAN/RVM SIGN-OFF — not assumed. PLUS: a SECURITY THREAT-MODEL ADDENDUM IS A
HARD PRE-BUILD GATE (C-R3).**

A downloaded resume carries the worker's **NAME (TD21)** (and potentially other identifying
profile detail). **Handing a resume document to a payer is a PII disclosure to a paying
third party — the same class of action as ADR-0010's Contact Unlock reveal**, and a
**WIDER** surface (a full resume doc, not a single routed contact channel).

### C.1 The decision: SEPARATE product/SKU, SHARED disclosure spine (recommended)

Two sub-questions:

1. **Is "download resume" the SAME action as unlock-reveal?** → **No — distinct
   products/SKUs, but the SAME worker-protection CHOKEPOINT.**
2. **Does it reuse the ADR-0010 disclosure machinery?** → **Yes — fully.** Consent gate
   (`employer_sharing`), per-worker caps, fail-closed ordering, PII-free events, credit
   debit, no-oracle responses — **all reused, not re-implemented.**

**Why separate SKU, not unification of the packs:**

- The **pack economics differ** (₹1000/15 resumes & ₹2500/35 resumes vs ₹1000/10 & ₹2000/25
  unlocks) and the **entitlements differ** (a resume *document* vs a routed *contact
  channel*). Forcing one credit unit to mean both under-prices one and over-prices the
  other, and conflates two different disclosures in the ledger/audit.
- A worker may be willing to share a **resume** but not a **direct contact** (or vice
  versa) — keeping them distinct lets the consent + caps + audit reason about each
  disclosure separately (stronger worker protection, cleaner DPDP record of *what* was
  disclosed).
- **But the protection chokepoint MUST be shared** — both are "disclose worker PII to a
  payer," and a second, parallel disclosure path would be a bypass of the ADR-0010 caps +
  consent (exactly the T5-b "single structural writer" risk). So: **two SKUs, one
  `UnlockGuardService`-class chokepoint, one consent gate, one caps mechanism.**

### C.2 The disclosure ordering (reuse ADR-0010 §Decision-ordering verbatim, adapted)

```
payer authz (InternalServiceGuard interim; PayerAuthGuard = launch gate — ADR-0010 T7)
        ↓ fail closed
[0] BALANCE PRECHECK (resume credits) — worker-state-INDEPENDENT  (ADR-0010 F-1/T2-b: no consent oracle)
        ↓ fail closed → neutral "unavailable" / payment_required, identical regardless of worker
[1] DISCLOSURE CONSENT gate — worker has active, unrevoked employer_sharing consent?
        ↓ fail closed → neutral "unavailable" (no oracle)
[2] WORKER-PROTECTION CAPS — within per-worker disclosure caps for the window? (atomic — F-2/T5-a)
        ↓ fail closed → neutral "unavailable" (no oracle)
[3] PAYMENT / CREDIT — resume credit available + debited (mock in alpha)? (atomic debit+grant — F-6/T6)
        ↓ fail closed
[4] GRANT — record the disclosure (resume_disclosures row)
        ↓
[5] CONTROLLED RESUME DISCLOSURE — server renders/serves the resume doc to the payer.
        Worker PII (name etc.) read HERE, server-side, to compose the document.
        NEVER written into any event, ai_jobs, audit_logs, or log line (only the FACT is evented).
```

- **Reuses every ADR-0010 build-blocker control:** F-1 (balance precheck = no consent
  oracle), F-2 (atomic caps), F-3 (single neutral-response constructor), F-5 (PII touched
  at one step, never logged/evented), F-6 (atomic debit+grant), F-7 (payer-auth launch
  gate). These apply **identically** to resume disclosure.
- **Caps note:** resume disclosure caps may be the **same** per-worker disclosure caps as
  unlock, or a separate counter — **C-R2 to ratify**. Recommend: one **shared** per-worker
  "PII disclosed to payers" cap window (so a worker can't be both unlocked AND
  resume-downloaded past the protection ceiling by splitting across SKUs), with per-SKU
  sub-accounting in the ledger.

### C.3 Data model (additive, PII-FREE — the resume bytes are NEVER stored here)

**`resume_disclosures` — one resume-download grant. PII-FREE.**

| column | type | notes |
|---|---|---|
| `id` | uuid PK | opaque `disclosure_id` in events |
| `payer_id` | uuid NOT NULL | opaque (employer OR agent); no FK, no PII |
| `worker_id` | uuid NOT NULL → FK `workers.id` | the ONLY identity join; PII stays in `workers`/`generated_resumes` |
| `job_posting_id` | uuid (nullable) → FK `job_postings.id` | scope to a posting if downloaded from a candidates page; nullable for pure search |
| `resume_ref` | uuid (nullable) → FK `generated_resumes.id` | which resume artifact was disclosed (the artifact already exists; this is a pointer, **not** the bytes) |
| `status` | text `$type<DisclosureStatus>()` | `requested \| granted \| disclosed \| denied \| expired` |
| `deny_reason` | text `$type<DisclosureDenyReason>()` (nullable) | INTERNAL only — `no_consent \| capped \| payment_required \| unknown_worker`; **never returned** (no-oracle); CHECK `deny_reason IS NULL OR status='denied'` |
| `disclosed_at` / `expires_at` | timestamptz (nullable) | grant window (catalog-driven) |
| `created_at` / `updated_at` | timestamptz | |

- `uniqueIndex (payer_id, worker_id, job_posting_id)` for idempotent grant (mirrors
  `unlocks`).
- **The resume document bytes/PDF are NEVER stored in this table or any event** — they live
  in the existing `generated_resumes` artifact path; `resume_ref` is an opaque pointer; the
  payer-facing download is served at step [5] behind the chokepoint, expiring with the
  window (ADR-0010 T3-b "non-reversible expiring handle" discipline applies to the download
  link).

**Resume-pack credits** reuse the ADR-0010 **`payer_credits` / `credit_ledger`** ledger
shape with a **distinct SKU** (the resume packs ₹1000/15, ₹2500/35 are catalog products;
the ledger carries `pack_code` distinguishing resume packs from unlock packs). Whether
resume credits are a separate balance column/row or a `credit_type` discriminator on the
existing ledger is an implementation detail for the database-architect (C-R1) — recommend a
`credit_type` enum (`unlock \| resume`) on `payer_credits`/`credit_ledger` so one ledger
serves both, additively.

### C.4 THREAT-MODEL ADDENDUM — REQUIRED before build (hard gate)

**Building resume download WITHOUT a security threat-model addendum is forbidden.** The
ADR-0010 threat model covers a *routed contact*; a *full resume document* is a **strictly
larger disclosure** (name + full work history + possibly more identifying detail in one
artifact). The addendum (security-engineer, mirroring the ADR-0010 threat model) must, at
minimum, pin:

- **What exactly is in the disclosed resume** — confirm it carries name (TD21) and
  enumerate any other identifying fields; ensure nothing beyond what `employer_sharing`
  consent authorizes is in the doc.
- **The download-link contract** — non-reversible, expiring, single-grant-scoped, served
  only behind the chokepoint (ADR-0010 T3 analogue).
- **No-oracle for resume search** — the "candidates page" (ADR-0011 faceless feed) must
  **not** leak that a worker exists/consented before payment; the F-1 balance precheck +
  F-3 neutral constructor apply.
- **Bulk-download / scrape** — resume download is the highest scrape-value action in the
  product; the caps + no-oracle + no-bulk-export rules (ADR-0010 EXPLICITLY-OUT) are
  non-tradeable. The addendum must explicitly address mass resume harvesting.
- **Retention/erasure** — a disclosed resume given to a payer is outside our erasure
  reach; the DPDP retention/erasure story (ADR-0010 T10-a / LC-3) must extend to "what
  happens to a downloaded resume" (this is largely a legal/contractual control, flagged).

This addendum is listed in §Human-gated escalations and §STOP as a **before-BUILD**
condition, exactly as ADR-0010's threat model gated the unlock build.

### C.5 Open ratifications inside Decision C

- **C-R1:** resume credits — separate balance vs `credit_type` discriminator on the shared
  ledger. Recommend discriminator.
- **C-R2:** caps — shared per-worker disclosure cap across unlock+resume vs separate.
  Recommend **shared** ceiling.
- **C-R3 [HARD GATE]:** the resume-download threat-model addendum is authored + passes
  before build. **Non-negotiable.**

---

## Decision D — Events (PII-free, v1, additive; version never mutate)

**REQUIRES HUMAN/RVM SIGN-OFF — not assumed.**

New PII-free v1 events. **ids/enums/amounts/percentages ONLY — never a payer name, worker
identity, coupon-holder identity, the resume bytes, or any free text.** Authored via the
`event-schema-change` skill; **version, never mutate** (invariant 8). The `payer`/`agent`
actors and the `unlock`/`payment`/`job_posting` domains + `job_posting`/`job`/`unlock`
subjects **already exist** (verified). The **only new enum surface** is the `pricing` event
domain (+ a `pricing_plan` / `coupon` subject if desired).

| event | domain | subject | payload (v1) — ids/enums/amounts ONLY | idempotencyKey |
|---|---|---|---|---|
| `job_posting.purchased` | `job_posting` | `job_posting` | `{ plan_id, job_posting_id, payer_id, tier:enum(standard\|pro), applicant_visibility_quota:int, validity_days:int, price_inr:int, discount_inr:int, coupon_applied:bool, real_call:bool=false }` | `job_posting.purchased:{plan_id}` |
| `job_posting.boosted` | `job_posting` | `job_posting` | `{ boost_id, job_posting_id, payer_id, tier:enum(all_candidates), boost_days:int, price_inr:int, real_call:bool=false }` | `job_posting.boosted:{boost_id}` |
| `applicant.viewed` | `job_posting` | `worker` | `{ plan_id, job_posting_id, payer_id, worker_id, viewed_count:int, quota:int }` — a quota-consuming faceless view; **NO name/contact** | unkeyed (each view audited) |
| `resume_pack.purchased` | `payment` | `unlock` (or new `pricing_plan`) | `{ payer_id, pack_code:string, credits:int, price_inr:int, discount_inr:int, coupon_applied:bool, real_call:bool=false }` | `resume_pack.purchased:{ledger_id}` |
| `resume.disclosed` | `contact` | `unlock` (reuse) | `{ disclosure_id, payer_id, worker_id, job_posting_id\|null, resume_ref }` — the FACT of disclosure; **NEVER the resume bytes, name, or download link** | unkeyed (each disclosure audited) |
| `coupon.redeemed` | `pricing` (new) | `pricing_plan`/`coupon` | `{ coupon_code:string, payer_id, product:enum, tier:enum, discount_inr:int }` — code + amount; **no holder identity beyond opaque payer_id** | `coupon.redeemed:{coupon_code}:{payer_id}:{purchase_id}` |
| `pricing.changed` | `pricing` (new) | `pricing_plan`/`coupon` | `{ change_type:enum(plan\|discount\|coupon), entity_code:string, changed_fields:string[], changed_by:uuid (opaque ops actor) }` — **field KEYS only, never old/new VALUES** (mirrors `job_posting.updated`) | unkeyed |

Reuse ADR-0010's **`payment.authorized` / `payment.captured` / `payment.failed`** for the
money movement of **every** product (job-posting plan, booster, resume pack, unlock pack) —
they already carry `{ …_id, payer_id, amount_credits, real_call:bool }` and are
product-agnostic. **No ADR-0006/0009/0010/0011/0012 payload is mutated** — purely additive,
exactly as those ADRs added their families.

**Endpoint → event map (every important write emits a validated event, invariant 1):**

| Endpoint (illustrative; module placement is the engineer's call within house convention) | Events (in order) |
|---|---|
| `POST /job-postings/:id/plan` (buy a posting plan) | `payment.authorized` → `payment.captured` → `job_posting.purchased` (+ `coupon.redeemed` if coupon) |
| `POST /job-postings/:id/boost` (buy a booster) | `payment.authorized` → `payment.captured` → `job_posting.boosted` |
| `POST /job-postings/:id/applicants/:workerId/view` (quota-consuming faceless view) | `applicant.viewed` (→ `payment.*` only if a quota top-up was purchased) |
| `POST /resume-packs` (buy resume credits) | `payment.authorized` → `payment.captured` → `resume_pack.purchased` (+ `coupon.redeemed`) |
| `POST /resume-disclosures` (download a resume — Decision C spine) | `payment.captured` (credit debit) → `resume.disclosed` (or neutral deny → `unlock.denied`-style) |
| `PUT /ops/pricing/...` (ops edits catalog/coupon) | `pricing.changed` |

`feed.shown` (ADR-0011) is **reused unchanged** for the candidates-page impressions; **no
new feed event.**

---

## Decision E — Payments (one seam, mock in alpha, real Razorpay human-gated)

**REQUIRES HUMAN/RVM SIGN-OFF — not assumed. DEFAULT: MOCK / CREDITS-ONLY in alpha.**

> **HARD STOP:** **Real payment-provider keys or real money movement → STOP and escalate
> to the human (CLAUDE.md §7).** This ADR does NOT authorize a real gateway.

- **All four products flow through the SAME `PaymentGateway` seam** defined in ADR-0010
  §D5, behind the **same `PAYMENTS_ENABLE_REAL=false`** flag (default), and the **same
  pricing engine** (Decision A) computes the amount. A purchase is: `resolvePrice → quote →
  gateway.authorizeAndDebit(quote.finalInr, …) → grant entitlement`. The seam does not know
  or care which product it is charging for — it charges an amount and reports
  success/failure.
- **Alpha mechanism:** the mock credit ledger (ADR-0010 `payer_credits` / `credit_ledger`,
  extended with the `credit_type` discriminator from C.3 and a `pack_code`/`product` tag).
  Job-posting plans and boosters may either (a) debit credits, or (b) be a direct
  "purchase" that grants the plan and records a mock `payment.captured` with
  `real_call:false` — **E-R1 to ratify** (recommend: posting/boost are direct purchases
  recorded in the ledger; resume + unlock are credit packs, since the spec frames them as
  packs).
- **Real provider:** **Razorpay is the chosen provider** (maintainer's stated choice) **but
  it is a HARD human-gated escalation**: provider keys (staging-first, never committed),
  spend guardrails, and a staging-first rollout must be confirmed **before any real-money
  code**, exactly like ADR-0010 §Sign-off resolution 2 and invariant 5. Until then the mock
  path is the code default. A real implementation slots behind the unchanged
  `PaymentGateway` interface + the same `payment.*` events with `real_call` flipping to
  `true` only in the real path (the audit-honesty flag, ADR-0010 F-6/T6-c).
- **Idempotency + atomicity:** debit + grant in one transaction, keyed on the purchase
  idempotency key (ADR-0010 F-6/T6-a) — a retried purchase never double-charges,
  double-grants, or double-redeems a coupon.

**E-R1 (ratify):** posting/boost = direct purchase vs credit-debit. **E-R2 (HARD HUMAN
GATE):** the real-Razorpay go/no-go (keys, spend, staging-first).

---

## Decision F — Worker protection + DPDP

**REQUIRES HUMAN/RVM SIGN-OFF — not assumed** (the lawful-basis framing + production copy
are legal calls; CLAUDE.md §8 launch gate).

- **Workers are NEVER charged.** No worker appears as a payer or a line item in the
  catalog, the ledger, or any purchase event. (ADR-0010 §Sign-off.)
- **Resume download discloses PII → it needs the full ADR-0010 worker-protection chain:**
  the `employer_sharing` consent gate (Decision C, step [1]), per-worker caps (step [2],
  recommend a **shared** disclosure ceiling across unlock + resume, C-R2), retention/erasure
  (ADR-0010 T10-a / LC-3 — extended to "a downloaded resume is outside our erasure reach"),
  and the **production DPDP copy launch gate** (ADR-0010 R-3 / T10-b / LC-2). A worker with
  `profiling` consent but not `employer_sharing` is **undiscoverable** for resume download
  (neutral "unavailable," no-oracle).
- **The booster + applicant-visibility must not leak worker PII beyond consent.** "Visible
  to all candidates" is a **worker-facing** broadcast of a **faceless job** (no worker PII
  to the payer). "Applicant visibility" to the payer is the **faceless** ADR-0011 list
  (opaque `worker_id` + rank + signals) — **a name/contact/resume is disclosed only via the
  Decision C / ADR-0010 paid + consented disclosure**, never as a side effect of a plan or
  a boost. The **quota counts disclosures, not faceless impressions** (Decision B.4).
- **Cross-ref ADR-0010 R16–R21 / TD33–35 and the threat model's RR-1…RR-4, LC-1…LC-7** —
  every worker-protection residual and launch gate there applies identically to the resume
  disclosure surface (payer-auth gap, RLS, revoke-vs-disclose race, timing oracle, DPDP
  copy, retention).

---

## EXPLICITLY OUT — hard boundary (do not drift)

- **No real payment provider / real money in alpha.** Mock credits only.
  Razorpay keys/spend → **STOP and escalate** (E-R2 / CLAUDE.md §7).
- **No employer/payer entity, no payer self-serve, no payer console.** `payer_id` is
  opaque "faceless rails" (employer OR agent), no FK, no PII (dead-decision "No Employer
  entity," ADR-0012; ADR-0010 EXPLICITLY-OUT). Payer self-serve posting needs
  `PayerAuthGuard` (ADR-0010 T7 / LC-1) — a launch gate, OUT here.
- **No resume-download build before the threat-model addendum (C-R3).** Hard pre-build
  gate.
- **No raw-phone reveal** (ADR-0010 OQ-E / LC-6 default never-in-alpha) — unchanged;
  resume download discloses a **document**, still no raw phone unless ADR-0010's separate
  higher-tier consent path is later opened.
- **No Reach ranking change.** The candidates page reuses the ADR-0011 serving layer +
  unchanged RANK core; the pricing engine does **no** ranking and the booster does **no**
  re-ranking (it broadcasts a faceless job; PACE/PROTECT/LEARN remain Phase-2, ADR-0011
  OUT).
- **No LLM anywhere on this path.** Pricing is deterministic arithmetic; posting/boost/
  resume/payment are CRUD + events + the disclosure chokepoint. (invariants 3, 4 trivially
  held; none may be added.)
- **No bulk / scrape / list-download.** One disclosure at a time, behind caps + no-oracle
  (ADR-0010 anti-scrape spine; the threat-model addendum re-confirms it for resumes).
- **No coupon-holder PII / no payer-name marketing data.** Coupons are codes; the catalog
  and `pricing.*`/`coupon.*` events carry codes + amounts + opaque `payer_id` only.
- **No mutation of any shipped payload/column.** Additive only (invariant 8).

---

## Reconciliation of `credit-packs.ts` + backward-compatibility (additive)

- **`credit-packs.ts`** → absorbed as the `contact_unlock` product in the catalog (A.5),
  kept as a typed default-seed / fail-closed fallback; `pack_10`/`pack_25` codes + values
  preserved exactly; `credit_ledger.pack_code` references stay valid. **No value or column
  change.**
- **Additive only:** new package `@badabhai/pricing`; new catalog tables
  (`pricing_plans`/`discounts`/`coupons` or a single typed catalog table set — DB shape is
  the database-architect's call within the schema), new `posting_plans` / `posting_boosts`
  / `resume_disclosures` tables; an additive `credit_type`/`pack_code` discriminator on the
  existing `payer_credits` / `credit_ledger`; one new `pricing` event domain (+ optional
  `pricing_plan`/`coupon` subject); new v1 payloads. **No existing column altered/dropped,
  no shipped payload mutated** → invariant 8 held.
- **Rollback story:** drop the new tables child-first (`resume_disclosures` →
  `posting_boosts` → `posting_plans` → catalog tables), drop the `pricing` domain entries,
  revert the additive ledger discriminator, remove `@badabhai/pricing`. The unlock spine,
  `job_postings`, the reach serving layer, `credit-packs.ts` consumers, and all
  already-emitted events persist independently in the spine. No Phase-1 data touched.
- **Version strategy:** all new events ship **v1**; any later field change is a **new
  version**, never an in-place mutation (event-schema-change skill).
- **The actual migrations + code are their own streams** (database-architect via
  `safe-db-migration`; backend-engineer; the pricing-engine package), authored **only after
  sign-off + the resume threat-model addendum** — **not here.**

---

## Risks / open questions to log (for the human — NOT written to registers here)

- **OQ-1 [PRIMARY] — pricing-engine source-of-truth (A-R1):** confirm **hybrid (iii)**
  (typed `@badabhai/pricing` schema + DB-stored, Zod-validated, fail-closed values). This
  is the headline ratification.
- **OQ-2 — unify vs separate resume packs (C-R1/C-R2):** confirm resume download is a
  **separate SKU** (₹1000/15, ₹2500/35) sharing the ADR-0010 disclosure chokepoint, with a
  **shared** per-worker disclosure cap. Recommended.
- **OQ-3 — discount/coupon precedence + stacking (A-R2):** confirm at-most-one-offer +
  at-most-one-coupon, documented order, never negative.
- **OQ-4 — coupon abuse:** total usage cap + per-payer limit + validity window + scope are
  in the model; confirm the abuse posture (e.g. one redemption per payer per coupon) and
  that fail-closed = full price (never free).
- **OQ-5 — posting actor (B-R1):** ops-created-with-opaque-payer (alpha) vs payer
  self-serve (needs `PayerAuthGuard`, OUT). Recommend ops + opaque payer for alpha.
- **OQ-6 — posting/boost = direct purchase vs credit-debit (E-R1).** Recommend direct
  purchase for posting/boost; credit packs for resume + unlock.
- **OQ-7 — refunds/proration (B-R2), booster overlap (B-R3):** recommend none / reject
  overlap for alpha.
- **R-1 [HARD PRE-BUILD GATE] — resume-download threat-model addendum (C-R3):** required
  before any resume-disclosure build; it widens the ADR-0010 PII-disclosure surface.
- **R-2 [HARD HUMAN GATE] — real Razorpay (E-R2):** provider keys/spend/staging-first →
  STOP + human escalation. Mock-only until then.
- **R-3 — payer-auth gap (ADR-0010 R23 / T7 / `PayerAuthGuard`):** all paid surfaces ride
  `InternalServiceGuard` (interim, ops-only) in alpha; no client-facing payer surface ships
  on the shared secret. Launch gate, inherited from ADR-0010.
- **R-4 — RLS (TD20):** the new tables ride the service-role posture; add them to the
  rls-plan when RLS lands. The only identity joins are `resume_disclosures.worker_id` /
  `applicant.viewed.worker_id` → the RLS-locked `workers`.
- **R-5 — DPDP retention/erasure of a disclosed resume (ADR-0010 T10-a / LC-3):** a
  downloaded resume is outside our erasure reach — a legal/contractual control to land with
  the production DPDP copy.
- **R-6 — scope-creep pressure:** "monetization" invites employer entity, payer console,
  bulk export, ranking-for-pay — all OUT. The EXPLICITLY-OUT section is the live mitigation.
- **R-7 — quota-view atomicity:** the applicant-visibility-quota decrement and the resume
  caps reuse the ADR-0010 F-2/T5-a atomic check-and-write discipline; not optional.

---

## STOP — sign-off required before ANY implementation

**This is a design artifact. Nothing here is built or authorized.** Before a single line of
pricing-engine, posting-plan, booster, or resume-download code, migration, or register edit:

1. **Decisions A–F require explicit human/RVM sign-off** — each is marked "REQUIRES
   SIGN-OFF — not assumed." The pricing numbers are RVM's to ratify (the spec's prices are
   the proposal); the **engine source-of-truth (A-R1)**, **resume-pack unify-vs-separate
   (C)**, and **discount/coupon policy (A-R2)** are the architecture calls awaiting
   confirmation.
2. **The resume-download SECURITY THREAT-MODEL ADDENDUM must be authored and pass before
   the resume-disclosure stream is built** (C-R3 / R-1) — it widens the highest-risk PII
   path in the product.
3. **Real payment provider keys/spend (Razorpay) → STOP and escalate** (E-R2 / CLAUDE.md
   §7). Alpha is mock-credits only.
4. Only then are the implementation streams (`@badabhai/pricing` → DB → events → API,
   behind the gates) handed to the engineer agents, each honouring the fail-closed
   disclosure ordering, the no-oracle rule, the atomicity controls, and the
   no-PII-in-events/logs guarantees fixed above and inherited from ADR-0010.

**Do not proceed past this line without recorded human/RVM sign-off.**

---

## Related

- ADR-0010 (Contact Unlock + Reveal — the disclosure spine this REUSES for resume download) + [contact-unlock threat model](../security/contact-unlock-threat-model.md)
- ADR-0012 (ops-created banded `job_postings` — the entity this adds a paid plan to, additively)
- ADR-0011 (Reach feed serving — the faceless candidates page / applicant list this consumes; `JobSource` port)
- ADR-0009 (alpha swipe-to-apply `jobs`/`applications` — distinct entity, untouched)
- ADR-0006 (Reach foundation RANK core — unchanged; pricing/boost never rank)
- ADR-0008 / CLAUDE.md §3 (locked stack — a new framework/datastore would be a separate ADR; `@badabhai/pricing` is a workspace package, not a stack change)
- `packages/db/src/credit-packs.ts` (the existing config-driven unlock packs absorbed in A.5)
- `packages/event-schema/src/{enums,payloads,registry}.ts` (the event contract this extends additively; `payer`/`agent` actors + `unlock`/`payment`/`job_posting` domains already exist)
- `apps/api/src/common/guards/internal-service.guard.ts` (the interim payer-auth seam; `PayerAuthGuard` is a launch gate)
- CLAUDE.md §2 invariants 1, 2, 4, 5, 6, 7, 8; §7 escalation; §8 deferred list
```
