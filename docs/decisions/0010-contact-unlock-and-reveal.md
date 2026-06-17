# ADR-0010: Contact Unlock + Reveal — the routed-disclosure monetization spine (Phase-0 design)

- **Status:** **ACCEPTED — human/RVM sign-off 2026-06-15 (Prakash).** Build of the
  non-payment streams (DB → events → API → payer UI) is **authorized to start once the
  F-1/F-2 build-blocker controls + tests are pinned** (see §Phase-0 security review). The
  **real-payment-gateway** portion is a **separate human-gated escalation in progress** (see
  the Sign-off resolutions below) — no real-money code, keys, or spend until the provider +
  staging-first plan are confirmed. The six decisions were signed off with the refinements
  recorded in **§Sign-off resolutions (2026-06-15)** immediately below; where a resolution
  refines a decision section (notably Decision 1 pricing, Decision 4 caps, Decision 5
  payments), **the resolution is authoritative.**
- **Build status (2026-06-17): Stream A is BUILT, end-to-end wired, and VERIFIED.** The
  DB → events → API → ops/payer UI streams are merged (`c41bf60` + the F-2 deadlock fixes
  `a110fdc`/`1bf0dec`; web unlock/reveal UI + pricing top-up `8f23fe6`/`754e79d`). An
  independent bb-security-review returned **PASS (alpha posture), no must-fix**: all 9
  non-tradeable invariants upheld; F-1/F-2 + BC-1…BC-8 controls present with tests; **T2-a**
  structurally closed by the per-`(payer_id, worker_id)` unique index (a payer only ever sees
  its own row); **T2-c** timing confirmed an OFF launch gate (reveal returns the neutral body,
  not a 404). `lint`/`typecheck`/`test`/`build` green. **All launch gates remain OFF and
  tracked:** `PayerAuthGuard` (TD33/LC-1), real payments (TD34/LC-5), retention/erasure
  (TD35/LC-3), real telephony + raw-phone reveal + production DPDP copy + timing-normalization
  (LC-4/LC-6/LC-2/LC-7). The two threat-model §6 *static* regression guards (BC-8 sole-writer
  test, BC-5 single-decrypt-site test) are runtime/convention-covered today and logged as
  **TD39**. Real money / real provider / per-payer auth / production legal copy remain
  **human-gated** (§STOP).

---

## Sign-off resolutions (2026-06-15) — authoritative over the decision sections where they differ

1. **Pricing / grant model (Decision 1) — REFINED.** Workers/applicants are **never charged**
   and have **no cap** on how many jobs they apply to. The **payer side is charged** — "payer"
   = an **employer OR an agent**, whoever performs the unlock. The model is a **credit pack**
   (NOT subscription, NOT hybrid): **₹1000 → unlock 10 profiles**, **₹2000 → unlock 25 profiles**.
   Granularity is **per-candidate-profile** (an unlock reveals that candidate's profile + resume
   + routed contact), **not** per-(worker, job). A **14-day window** applies (pay again to unlock
   more after it lapses). This **resolves Open-Question Q2.** → The data model's credit unit is a
   "profile-unlock credit"; packs (10@₹1000, 25@₹2000) are **config-driven**; one credit = one
   candidate profile unlocked; pack/credit validity = 14 days.
2. **Payments (Decision 5) — REAL GATEWAY, ESCALATION IN PROGRESS.** The maintainer chose a
   **real payment gateway** (not mock-only). Per CLAUDE.md §7 and the task's hard rule, this is
   **human-gated**: provider selection, key handling (staging-first, never committed), and spend
   guardrails must be confirmed **before any real-money code**. Until then: the `PaymentGateway`
   seam + `PAYMENTS_ENABLE_REAL=false` **mock credit** path is the code default and is what the
   non-payment build uses; the real credit-pack purchase flow is built only after the escalation
   resolves, **staging-first**.
3. **Worker-protection caps (Decision 4) — CONFIG-DRIVEN, numbers decided at build.** The single
   fail-closed chokepoint is unchanged; the specific limits are configuration set when the stream
   is built (not hard-coded), so they can be tuned without a migration.
4. **Decisions 0 (jobs/payer reconciliation: evolve-not-replace), 2 (in-app relay default;
   raw reveal NEVER in alpha), 3 (separate `employer_sharing` DPDP consent), 6 (additive
   PII-free data model + v1 event family) — APPROVED as recommended.**
5. **Build authorization:** the non-payment streams may start once **F-1 and F-2** controls +
   their tests are pinned (already folded into this ADR). Real telephony provider, real payment
   keys/spend, raw-phone reveal, and production DPDP copy remain **hard escalations**.
- **Date:** 2026-06-15
- **Phase:** Phase-2 (Contact Unlock + Reveal is BadaBhai's north-star monetization
  event). This ADR draws the contract so the build, when authorized, stays inside the
  invariants.
- **Author:** system-architect agent (architecture + contract). Threat model: deferred to
  security-engineer. Pricing/legal/provider calls: deferred to the human/RVM.
- **Relates / builds on:**
  - **ADR-0009 (alpha swipe-to-apply)** — the live `jobs` + `applications` tables, the
    `ConsentGuard` (`apps/api/src/auth/consent.guard.ts`), and `WorkerAuthGuard`. Unlock
    builds **on** these; it does **not** mutate the ADR-0006/0009 `feed.*`/`application.*`
    payloads.
  - **PR #42 / `feat/jobs-entity-lifecycle` (GATED)** — the richer Phase-2 `jobs` entity
    (opaque `payer_id`, pay bands, `posting_fee`, boost, lifecycle, 6 `job.*` events). It
    **collides** with the alpha `jobs` table. This ADR includes the **canonical
    jobs/payer reconciliation** as a sub-decision (§Decision 0). It does **not** merge #42.
  - **ADR-0004 (PII-at-rest + RLS)** — raw phone/full name live ONLY in `workers`,
    encrypted at rest; new tables ride the service-role posture and join the RLS backlog
    (TD20 spine lock).
  - **CLAUDE.md §2 invariants 1, 2, 5, 6, 7, 8** and **§8 deferred list.**

---

## Context

Contact Unlock is the **one feature in the entire product that deliberately discloses a
worker's contact channel to a paying third party.** Everything else in BadaBhai is built
to keep raw PII inside the `workers` row (invariant 2) and away from the LLM path
(invariants 2, 3). Unlock is the exception — which makes it **the single highest-risk PII
path in the system** and the one that most needs a written, human-gated contract *before*
a line of code exists.

The discipline this ADR enforces, restated up front so it governs every decision below:

1. **Routed, not raw.** The default reveal is a **masked/proxy channel** (a routing token
   resolved server-side at the moment of contact), **never** the worker's raw phone. The
   raw phone is read from `workers` **only** at the final routed-reveal step, server-side,
   and is **never** written into `unlocks`, any event payload, `ai_jobs`, `audit_logs`, or
   any log line (invariant 2).
2. **Consent is a separate, explicit gate.** Disclosure to a payer is a *different
   purpose* from profiling. It needs its own DPDP consent purpose and lawful basis, and it
   is a **fail-closed** gate before any reveal (invariant 6). The taxonomy already reserves
   the hook: `CONSENT_PURPOSES` in `@badabhai/types` carries `// "employer_sharing" is
   intentionally Phase 2+ and not enabled in Phase 1.`
3. **The LLM never touches this path.** Unlock is pure deterministic CRUD + events +
   server-side routing. No profiling, no scoring, no ranking, no decisioning (invariants
   3, 4). The `pseudonymize.py` fail-closed gate is irrelevant here only because **no LLM
   call exists on this path at all** — and none may ever be added.
4. **Real payments and real telephony are human-gated like real LLM/OTP keys.** Alpha is
   **mock/credits only**. Real provider keys or real spend → **STOP and escalate**
   (CLAUDE.md §7). The seams are designed so a real provider slots in later behind a flag,
   mirroring the `AI_ENABLE_REAL_CALLS` gating pattern (invariant 5).

**Verified facts this design rests on (confirmed against the repo, 2026-06-15):**

- The alpha `jobs` table is **lean** (`packages/db/src/schema.ts` ~L547): `id`, `trade_key`
  (`$type<TradeKey>()`), `title`, `city`, `area` (nullable), `status` (`$type<JobStatus>()`,
  `'open'|'closed'`), `created_at`, `updated_at`. **No `payer_id`, no pay, no employer
  PII, no lifecycle.** `applications` (~L565) is PII-free: `id`, `job_id` (FK), `worker_id`
  (FK — the only join to identity), `action`, `reason`, `source_surface`, `rank`, with a
  `(worker_id, job_id)` unique index and a `reason`-only-on-skip CHECK.
- The gated #42 `jobs` (on `feat/jobs-entity-lifecycle`, ADR file
  `docs/decisions/0009-job-entity-and-lifecycle.md` — **NOT on main**, so it does **not**
  collide with this ADR's number) is **richer**: opaque `payer_id` (UUID, **no FK, no
  `payers` table** — "faceless rails"), role slugs, city-centroid geo, travel/experience/pay
  bands, `vacancy_count`, stamped `applicant_quota`, `posting_fee`, `boost_tier` + window,
  lifecycle `draft → active ⇄ paused → closed`, and 6 `job.*` events. Its routes sit behind
  `InternalServiceGuard` because **there is no payer auth yet** — the same gap unlock faces.
- The event spine: payloads are PII-free, ids/enums/counts only
  (`packages/event-schema/src/payloads.ts`); the registry pins one current `version` per
  event name (`registry.ts`); the actor enum **already includes `payer`** ("an
  employer/staffing customer (Phase 2+)") and the subject enum **already includes `job`**
  (`enums.ts`). Adding a `payer`/`unlock`/`contact`/`payment` event domain + subject is the
  same additive move ADR-0006 made for `feed`/`application`.
- `EventsService.emit({ event_name, actor, subject, payload, idempotencyKey?, correlationId,
  requestId })` (`apps/api/src/events/events.service.ts`) dedupes on `idempotencyKey`
  (TD18). `consent.service.ts` is the reference: it keys `consent.accepted` on the *record*
  id so a legitimate re-consent is not blocked.
- `worker_consents` (`schema.ts` ~L85) is **append-only** (`purposes: jsonb<ConsentPurpose[]>`,
  `consentVersion`, `acceptedAt`, `revokedAt`); the `ConsentGuard` reads the *latest* row and
  fails closed if it is missing or revoked. `CONSENT_PURPOSES` = `["profiling",
  "resume_generation", "communication", "model_training"]` with `employer_sharing` reserved.
- Raw PII lives ONLY in `workers` (`phoneE164` = AES-256-GCM ciphertext, `phoneHash` = keyed
  HMAC, `fullName` nullable/unused). `PiiCryptoService` already exists for the
  encrypt/decrypt/hash boundary.

---

## Decision

Define — **for sign-off, not for build** — the smallest honest **Contact Unlock + routed
Reveal** spine that: (a) discloses only a **routed/masked** channel by default; (b) is
gated by a **separate disclosure consent**; (c) enforces **worker-protection caps** at a
single fail-closed chokepoint; (d) runs on **mock credits** in alpha with a real-gateway
seam behind a flag; and (e) emits a **new PII-free event family** keyed by ids only, with
the raw phone touched **only** at the final routed-reveal step.

The **fail-closed disclosure ordering** is the architectural heart of the whole feature
and governs every endpoint:

```
  payer authn/authz (seam, §Decision 6.3)
        ↓  fail closed
  [1] DISCLOSURE CONSENT gate   — worker has active, unrevoked employer_sharing consent?  (§D3)
        ↓  fail closed                                no → neutral "unavailable" (no oracle)
  [2] WORKER-PROTECTION CAPS    — within per-worker reveal/payer caps for the window?      (§D4)
        ↓  fail closed                                no → neutral "unavailable" (no oracle)
  [3] PAYMENT / CREDIT          — credit available + debited (mock in alpha)?              (§D5)
        ↓  fail closed                                no → payment_required, nothing granted
  [4] GRANT                     — write `unlocks` row (status=granted, expiry, token REF)  (§D6)
        ↓
  [5] ROUTED REVEAL            — server resolves routing token → routed channel ONLY.      (§D2)
                                 Raw phone read from `workers` HERE, server-side, ONCE,
                                 returned to the payer as a MASKED/PROXY destination,
                                 NEVER persisted, NEVER logged, NEVER in an event.
```

Every gate **fails closed**: any error, ambiguity, or missing precondition denies the
reveal and discloses nothing. Raw PII is in scope at exactly **one** step ([5]) and never
leaves it as raw.

---

### Decision 0 (sub-decision) — Canonical jobs / payer entity (reconcile #42 with the alpha)

**REQUIRES HUMAN / RVM SIGN-OFF — not assumed.**

Unlock is meaningless without a job posted by *someone who pays*. The alpha `jobs` table
has **no payer**; #42's `jobs` has an opaque `payer_id`. We must pick the canonical shape.

**Recommendation: the alpha lean `jobs` table *evolves into* the #42-style entity by
purely additive columns — it is not replaced.** Specifically:

- Keep the **alpha `jobs` table and its `id`** as the canonical job identity (events and
  `applications.job_id` already point at it; the audit spine already references it). Do
  **not** create a second jobs table.
- Adopt #42's **opaque `payer_id` (UUID, NO FK, NO `payers` table, NO employer PII —
  "faceless rails")** as the additive seller column on the canonical `jobs`. A job becomes
  the billable object an opaque payer posts. `payer_id` is **never** an employer name and
  **never** resolves to identity in any event or log.
- Treat #42's lifecycle (`draft → active ⇄ paused → closed`), pay bands, `posting_fee`,
  boost, and the 6 `job.*` events as the **canonical richer shape** the alpha grows toward
  — but they are **out of scope for unlock** and ride #42's own (gated) decision. Unlock
  only needs: a job exists, it has a `payer_id`, and it (optionally) scopes an unlock.
- The alpha `jobs.status` (`'open'|'closed'`) is a **subset** of #42's lifecycle; the
  migration that lands #42 widens the enum additively (`open` maps to `active`). That is
  #42's migration to own, not this ADR's.

**Why evolve-not-replace:** replacing `jobs` would orphan the alpha `applications` FK and
the already-emitted `feed.*`/`application.*` events that carry `job_id`, violating
invariant 8 (backward compatibility). Additive columns keep the audit spine intact.

**Trade-off / risk:** this ADR depends on a `payer_id` existing on `jobs`. If #42 lands
first, unlock consumes it directly. If unlock is authorized before #42, unlock must add the
`payer_id` column itself (additive) — flagged as **migration ordering** in §Risks. Either
way, **payments, the `payers` table, payer auth, lifecycle, and boost remain #42's / a
later decision's scope, not unlocked here.**

---

### Decision 1 — Unlock + pricing model (resolves Open-Question Q2)

**REQUIRES HUMAN / RVM SIGN-OFF — not assumed.** This is the pricing call; it also feeds
the PRD + cost model. Architecture can recommend a *shape*; the price points and the
business model are RVM's.

**Recommendation (leanest alpha-appropriate): per-unlock CREDITS, granted at
per-(worker, job) granularity.**

What **one unlock grants**, precisely:

- **Scope:** the **routed contact channel of ONE worker, in the context of ONE job** the
  payer posted (the `(payer_id, worker_id, job_id)` tuple). Per-(worker, job), **not**
  per-worker-globally. Rationale: a payer who unlocks a worker for "CNC Operator, Pune"
  has a relationship scoped to *that opening*; unlocking the same worker for a different
  job is a separate intent (and a separate worker-protection event — see §D4). Global
  per-worker unlock would let one payment fan a worker's contact across unrelated postings,
  which both under-prices the value and weakens worker protection.
- **Duration:** the unlock is valid for a **bounded window** (`expires_at`, recommend
  **14 days** for alpha) after which the routed channel is no longer resolvable for that
  payer without a new unlock. A short window keeps the proxy-mapping surface small and
  forces re-consent-checking on re-contact.
- **Contact attempts:** within the window, a **bounded number of routed contact attempts**
  (recommend **≤ 3** routed reveals/attempts per unlock for alpha) — enough to actually
  reach a worker, capped to prevent a single unlock becoming unlimited harassment. Each
  attempt re-checks the consent gate and the caps (§D2, §D4): an unlock is *permission to
  attempt*, not a standing right to spam.

**Granularity decision restated:** **per-(worker, job)** unlock. (Per-application — i.e.
keyed on a specific `applications` row — is a viable tightening if the team wants unlock to
require a prior worker *apply* to that job; that is a stronger worker-protection stance and
is noted as an open question, OQ-D below.)

**Alternatives considered:**
- *Subscription tiers* (flat monthly, N unlocks included): better revenue predictability,
  but premature for alpha — there is no payer base to tier, no usage data to price, and it
  couples pricing to a payer-account model that does not exist yet. Defer.
- *Hybrid* (subscription + overage credits): the likely *eventual* model, but it is a
  superset of credits; ship credits first, add the subscription wrapper later without
  changing the unlock primitive. The credit ledger below is designed so a subscription
  grant is just "a batch of credits issued on a schedule."

**Why credits win for alpha:** the unlock primitive (debit 1 credit → grant 1 unlock) is
the *atom* every richer model decomposes into. Building it first means subscriptions/hybrid
become a crediting *policy* on top, never a re-architecture.

---

### Decision 2 — Routed contact (masked/proxy by default; raw never in alpha)

**REQUIRES HUMAN / RVM SIGN-OFF — not assumed** (specifically: choosing/funding a real
telephony provider is human-gated like real payment/LLM keys).

**Recommendation: the default and ONLY alpha reveal is a ROUTED/MASKED channel resolved
server-side from a routing-token reference. The raw phone is NEVER revealed in alpha.**

**Routing mechanism — candidates (named, not selected; selection + funding is human-gated):**
1. **Call/SMS masking via a proxy-number provider** (e.g. an Exotel/Knowlarity/Twilio-style
   masked-number or virtual-number product): the payer dials/texts a proxy number that the
   provider bridges to the worker's real number, which the payer never sees.
2. **In-app relay** (BadaBhai-mediated messaging/callback): the payer contacts the worker
   *through* BadaBhai; no number is disclosed in either direction. Highest privacy, most
   build; viable as the alpha default precisely because it needs **no external telephony
   provider** and therefore no human-gated provider key.
3. **Time-boxed proxy alias** (a short-lived routed handle that expires with the unlock
   window) — a thin wrapper over (1) or (2).

**Alpha recommendation:** default to the **in-app relay (candidate 2)** as the
*architecturally-safe alpha reveal* because it discloses **no number at all** and needs **no
external provider** — so alpha can ship the full consent → caps → grant → reveal spine
end-to-end without touching a human-gated telephony key. The masked-number provider
(candidate 1) is the **production** routed channel and is **explicitly human-gated** (real
provider key + spend) exactly like real payment/LLM keys.

**Data needed (PII-free in the spine):** a **routing-token reference** — an opaque id
(`routing_token_ref`, a UUID) stored on the `unlocks` row that points at a server-side
routing **mapping**. The mapping `(routing_token_ref → worker_id, channel kind, expiry)` is
resolved **server-side only**, at reveal time, to look up the worker's raw phone from
`workers` (or to open the in-app relay). **The raw phone, the proxy number, and the relay
destination NEVER appear in `unlocks`, in any event payload, in `ai_jobs`, in `audit_logs`,
or in any log line.** `routing_token_ref` is an opaque pointer, not a contact.

> **Where the raw phone lives in the flow:** read from `workers.phoneE164` (decrypted via
> `PiiCryptoService`) **only** inside the reveal handler, **only** to hand the
> provider/relay a routing instruction, then discarded. It is never returned raw to the
> payer in alpha (the payer gets a proxy/relay handle), and never serialized anywhere.

**Is raw reveal EVER allowed?** **Not in alpha.** Post-alpha, a raw-phone reveal could be
considered ONLY behind **additional, separate, explicit worker consent** ("I allow my
direct number to be shared," distinct from "I allow employers to contact me") **plus** a
team decision **plus** the security threat model — and even then it would be a distinct,
higher-tier consent purpose, not a default. **Default: routed-only in alpha; raw never in
alpha.** (Logged as OQ-E.)

---

### Decision 3 — Consent-for-disclosure (DPDP)

**REQUIRES HUMAN / RVM SIGN-OFF — not assumed** (the lawful-basis framing and the
user-facing copy are a legal call; production DPDP legal copy is a launch gate, CLAUDE.md
§8).

**Recommendation: a NEW, SEPARATE consent purpose `employer_sharing`, captured distinctly
from profiling, enforced as a fail-closed gate before any reveal.**

- **The consent artifact:** add `"employer_sharing"` to `CONSENT_PURPOSES` in
  `@badabhai/types`. **The hook already exists** — the enum literally reserves it:
  `// "employer_sharing" is intentionally Phase 2+ and not enabled in Phase 1.` This is the
  cleanest possible extension: it rides the existing append-only `worker_consents` table
  (`purposes: jsonb<ConsentPurpose[]>`), the existing `consent.accepted` event (no payload
  change — `purposes` is already an array), and the existing `ConsentGuard` pattern.
- **Distinct from profiling consent:** `employer_sharing` is a *separate purpose string*,
  granted in a *separate, explicit* worker action (a clear "allow employers/payers to
  contact you" toggle, not bundled into the profiling acceptance). A worker can have
  `profiling` consent but **not** `employer_sharing` — and must then be **undiscoverable for
  unlock** (the payer sees a neutral "unavailable," §D4). Bumping `CURRENT_CONSENT_VERSION`
  when the disclosure copy is introduced is recommended so the new purpose is captured under
  versioned, auditable copy.
- **Where captured:** in the worker app, as an explicit, revocable opt-in surface (its UX is
  the mobile/frontend stream's job, not this ADR's). It writes a new `worker_consents` row
  via the existing consent path with `employer_sharing` in `purposes`.
- **Fail-closed gate before reveal:** introduce a **disclosure-consent check** — a *purpose-
  scoped* sibling of `ConsentGuard` (recommend `assertWorkerConsentedFor(workerId,
  "employer_sharing")`, reading the latest `worker_consents` row and requiring the purpose
  present **and** `revokedAt IS NULL`). It is **step [1]** of the disclosure ordering and
  **fails closed**: no active `employer_sharing` consent → no reveal, and the payer sees a
  neutral "unavailable" (never "this worker has not consented" — that would leak the
  worker's choice; see §D4 no-oracle rule). Revocation is immediate: a revoked
  `employer_sharing` consent makes future reveals fail closed even within an unlock's
  window.

**Lawful basis:** disclosure of contact to a payer is processing for a **distinct purpose**
under DPDP and requires its **own** consent + notice. The exact lawful-basis wording and the
production notice copy are **deferred to the human/legal track** (CLAUDE.md §8 production
DPDP copy is a launch gate). This ADR fixes only the *architecture*: a separate purpose,
versioned, append-only, fail-closed, revocable.

> **Coordination note (legal-later):** the disclosure consent copy must land with the
> production DPDP legal copy stream before any real (non-mock) payer disclosure. Flagged as
> a launch gate, not designed here.

---

### Decision 4 — Worker-protection caps (single fail-closed chokepoint)

**REQUIRES HUMAN / RVM SIGN-OFF — not assumed** (the exact cap numbers are a
product/trust-and-safety call; the *mechanism* is architecture).

**Recommendation: per-worker rate caps on reveals/contacts per time window, enforced at ONE
chokepoint every unlock passes through, fail-closed when exceeded, surfaced to the payer as
a neutral "unavailable."**

- **The chokepoint:** a single server-side `UnlockGuardService` (the only path that can
  grant an unlock or resolve a reveal). Both the unlock *request* and each routed *reveal
  attempt* go through it (step [2] of the ordering). **There is no bypass** — no other code
  path may write an `unlocks` row or resolve a `routing_token_ref`. (Mirrors the AI
  gateway's single-chokepoint spend-cap design, TD27.)
- **Starting caps (recommended for alpha, all tunable):**
  - **Max reveals per worker per day:** `N = 5`.
  - **Max distinct payers per worker per week:** `M = 10`.
  - **Max routed contact attempts per unlock:** `≤ 3` (from §D1).
  These are derived from the cap state in the `unlocks`/event spine (count of granted
  reveals in the window), not a separate counter, so they cannot drift out of sync.
- **Fail-closed when exceeded:** over a cap → the unlock/reveal is **denied**. Nothing is
  granted, no credit is debited (the cap check is **before** payment, step [2] precedes step
  [3]), and no routing token resolves.
- **What the payer sees (no-oracle rule):** when a worker is capped (or has not given
  disclosure consent, or does not exist), the payer receives a **single neutral
  "unavailable"** response — **never** "capped," "over limit," "not consented," or anything
  that leaks the worker's behaviour or choices. The response is *indistinguishable* across
  "no consent," "capped," and "unknown worker," so a payer cannot probe a worker's state.
  This is an architectural requirement on the API contract (§D6), not a UI nicety.

**Why a single chokepoint:** caps that are enforced in multiple places drift and leak; one
chokepoint that *every* grant and reveal must traverse is the only way to guarantee
fail-closed protection and a consistent neutral response.

---

### Decision 5 — Payments boundary (mock/credits in alpha; real gateway behind a flag)

**REQUIRES HUMAN / RVM SIGN-OFF — not assumed.** **DEFAULT: MOCK / CREDITS-ONLY in alpha.**

> **HARD STOP:** **Real payment-provider keys or real money movement → STOP and escalate to
> the human (CLAUDE.md §7).** This ADR does **not** design assuming real keys and does
> **not** authorize a real gateway. Alpha is mock credits only.

- **Alpha mechanism:** a **mock credit ledger.** A payer has a credit balance (`payer_credits`)
  granted by an internal/ops action (no real money). An unlock **debits one credit** at step
  [3]. If balance is insufficient → `payment_required`, nothing granted. The "payment" in
  alpha is a **ledger debit**, not a gateway charge.
- **The seam (mirrors `AI_ENABLE_REAL_CALLS`):** a single `PaymentGateway` interface with a
  flag, e.g. `PAYMENTS_ENABLE_REAL = false` (default). The mock implementation debits the
  ledger. A real implementation (Razorpay/Stripe-style, **human-gated**) would authorize +
  capture a real charge behind the same interface and the same `payment.*` events. **The
  unlock flow does not know or care which implementation is wired** — it calls
  `gateway.authorizeAndDebit(...)` and reads back success/failure. Real keys + real spend are
  added only behind the flag, staging-first, with explicit human sign-off — exactly the
  invariant-5 pattern.
- **Idempotency:** the debit is keyed on the unlock request idempotency key (§D6) so a
  retried request never double-charges/double-debits.

---

### Decision 6 — Data model + events + guards

**REQUIRES HUMAN / RVM SIGN-OFF — not assumed** (this is the contract that the
database-architect + backend-engineer would implement *after* sign-off + threat model).

#### 6.1 Minimal data model (additive, PII-FREE — ids + enums + a routing-token REFERENCE only)

All tables follow `schema.ts` conventions (uuid PK `gen_random_uuid()`, `timestamptz`,
status as `text` + `$type<...>()`), are **additive only**, and **join the RLS backlog
(TD20)** like the alpha tables. **No table below stores a phone, name, proxy number, or any
PII** — the only join to identity is `worker_id` (FK into `workers`, where PII already lives,
RLS-locked), exactly as `applications` does today.

**`unlocks` — one routed-contact grant. PII-FREE.**

| column              | type                                                    | notes |
| ------------------- | ------------------------------------------------------- | ----- |
| `id`                | uuid PK                                                 | the opaque `unlock_id` in events |
| `payer_id`          | uuid NOT NULL                                           | opaque payer ref (faceless rails — **NO FK, NO PII**); same shape as #42 |
| `worker_id`         | uuid NOT NULL → FK `workers.id`                         | the ONLY identity join; PII stays in `workers` |
| `job_id`            | uuid (nullable) → FK `jobs.id`                          | per-(worker, job) scope (§D1); nullable allows a future per-worker variant without a new table |
| `status`            | text `$type<UnlockStatus>()`                            | `requested \| granted \| revealed \| expired \| denied`; default `requested` |
| `deny_reason`       | text `$type<UnlockDenyReason>()` (nullable)            | INTERNAL only — `no_consent \| capped \| payment_required \| unknown_worker`; **never returned to the payer** (no-oracle, §D4); null unless `status='denied'` |
| `routing_token_ref` | uuid (nullable)                                         | opaque pointer to the **server-side** routing mapping (§D2); **NOT a contact**; null until granted |
| `reveal_count`      | integer NOT NULL default 0                              | routed contact attempts used (cap ≤ 3, §D1/§D4) |
| `granted_at`        | timestamptz (nullable)                                  | set at step [4] |
| `expires_at`        | timestamptz (nullable)                                  | grant window end (§D1, ~14d) |
| `created_at`        | timestamptz default `now()`                             | |
| `updated_at`        | timestamptz default `now()`                             | |

- **Idempotency / natural key:** `uniqueIndex` on `(payer_id, worker_id, job_id)` so a
  retried unlock for the same tuple does not create a duplicate grant or double-debit
  (last-state-wins on the row; the *audit history* of every attempt lives in events).
- **CHECK:** `deny_reason IS NULL OR status = 'denied'` (mirrors the `applications` reason
  CHECK pattern).
- **The routing mapping itself** (`routing_token_ref → worker_id, channel kind, expiry`)
  lives in a **server-side-only** store. Whether that is a dedicated `unlock_routing` table
  (PII-free: a token id → `worker_id` + channel enum + expiry; **no phone**) or the proxy
  provider's own mapping is an implementation detail for the engineer + threat model — the
  contract requirement is only that **the phone is resolved at reveal time and never
  persisted in the token record.** Recommend a thin PII-free `unlock_routing` table for
  alpha (token id, `unlock_id` FK, channel enum, expiry) so the in-app relay needs no
  external provider.

**`payer_credits` — mock credit balance (amounts + ids only; NO money movement in alpha).**

| column        | type                              | notes |
| ------------- | -------------------------------- | ----- |
| `id`          | uuid PK                          | |
| `payer_id`    | uuid NOT NULL                    | opaque payer ref (no FK/PII) |
| `balance`     | integer NOT NULL default 0       | unlock credits available |
| `created_at`  | timestamptz default `now()`      | |
| `updated_at`  | timestamptz default `now()`      | |

- `uniqueIndex` on `(payer_id)` — one balance row per payer.

**`credit_ledger` — append-only credit movements (amounts + ids only).**

| column          | type                                            | notes |
| --------------- | ----------------------------------------------- | ----- |
| `id`            | uuid PK                                          | |
| `payer_id`      | uuid NOT NULL                                    | opaque |
| `delta`         | integer NOT NULL                                 | `+` grant (ops/mock), `-` unlock debit |
| `reason`        | text `$type<CreditReason>()`                     | `grant \| unlock_debit \| refund` |
| `unlock_id`     | uuid (nullable) → FK `unlocks.id`                | set for `unlock_debit`/`refund` |
| `created_at`    | timestamptz default `now()`                      | |

- Append-only (the balance is a materialization of the ledger; ledger is the truth).
- **No currency, no gateway charge id, no PAN/UPI — alpha is mock.** A real gateway (behind
  the flag, human-gated) would add an opaque `provider_charge_ref` later, additively.

> **Privacy confirmation:** across all four tables the only identity reference is
> `unlocks.worker_id` (FK into `workers`). `payer_id` is opaque (no PII, no FK). No phone,
> name, proxy number, or contact string exists in any column. `routing_token_ref` is an
> opaque pointer resolved server-side. **No new PII surface is created** — the raw phone is
> read transiently at reveal and never stored here.

#### 6.2 New event family (PII-FREE, keyed by ids ONLY, all v1 — does NOT mutate ADR-0006/0009)

New `EVENT_DOMAINS`: `unlock`, `contact`, and (for the mock model) `payment`. New
`SUBJECT_TYPES`: `unlock` (and reuse `worker`/`job`). The `payer` actor already exists.
**Authored via the `event-schema-change` skill — VERSION (v1), never mutate a shipped
payload.** Every payload below carries **ids + enums + counts only** — **the revealed
contact / proxy number / relay destination NEVER appears in any payload or log.**

| event                  | domain    | subject        | payload (v1) — ids/enums/counts ONLY | idempotencyKey |
| ---------------------- | --------- | -------------- | ------------------------------------ | -------------- |
| `unlock.requested`     | `unlock`  | `unlock`/`id`  | `{ unlock_id, payer_id, worker_id, job_id\|null }` | `unlock.requested:{unlock_id}` |
| `unlock.granted`       | `unlock`  | `unlock`/`id`  | `{ unlock_id, payer_id, worker_id, job_id\|null, expires_at }` | `unlock.granted:{unlock_id}` (once-only) |
| `unlock.denied`        | `unlock`  | `unlock`/`id`  | `{ unlock_id, payer_id, worker_id, job_id\|null, reason: enum(no_consent\|capped\|payment_required\|unknown_worker) }` — **internal audit only; the reason is NOT echoed to the payer** | unkeyed (each attempt audited) |
| `unlock.cap_exceeded`  | `unlock`  | `worker`/`id`  | `{ payer_id, worker_id, cap: enum(daily_reveals\|weekly_payers\|attempts_per_unlock), window: enum(day\|week\|unlock) }` | unkeyed |
| `contact.revealed`     | `contact` | `unlock`/`id`  | `{ unlock_id, payer_id, worker_id, channel: enum(in_app_relay\|proxy_number), reveal_count }` — **channel KIND only; NEVER the number/destination** | unkeyed (each reveal is a distinct event) |
| `payment.authorized`   | `payment` | `unlock`/`id`  | `{ unlock_id, payer_id, amount_credits, real_call: bool=false }` (mock=credit hold) | `payment.authorized:{unlock_id}` |
| `payment.captured`     | `payment` | `unlock`/`id`  | `{ unlock_id, payer_id, amount_credits, real_call: bool=false }` (mock=ledger debit) | `payment.captured:{unlock_id}` |
| `payment.failed`       | `payment` | `unlock`/`id`  | `{ unlock_id, payer_id, reason: enum(insufficient_credits\|gateway_error), real_call: bool=false }` | unkeyed |

- Field shapes mirror the existing payloads: `unlock_id`/`payer_id`/`worker_id`/`job_id` are
  `uuidSchema` (`job_id` nullable/defaulted), enums have safe defaults, `expires_at` is
  `isoDateTimeSchema`, `amount_credits` is a non-negative int, `real_call` defaults `false`
  (mirrors `AiCostRecordedPayload.real_call`). **No free-text field exists anywhere** — every
  reason is an enum, exactly like `application.skipped.reason`.
- **`real_call: false`** on every `payment.*` event in alpha is the *honest* value (no real
  gateway ran) and is the audit flag that lets ops prove no real money moved — the direct
  analogue of `AiCostRecordedPayload.real_call`/`ai.spend_cap_exceeded`.
- **No payload of ADR-0006/0009 (`feed.*`, `application.*`) is touched.** This is purely
  additive to the registry, exactly as ADR-0006 added `feed`/`application`. Invariant 8 holds.

#### 6.3 API contract — routes → events, guards, DTOs, idempotency, fail-closed ordering

New module `apps/api/src/unlocks/` (standard `controller → service → repository + dto(zod) +
module`). The `UnlockGuardService` (the §D4 chokepoint) is the only writer of `unlocks` and
the only resolver of `routing_token_ref`.

**The payer-auth seam (NEW — flag the gap).** **There is NO payer auth today** (the gated
#42 observed the same and used `InternalServiceGuard` as the interim posture). Architecture
recommendation for alpha: **payer-facing unlock routes sit behind `InternalServiceGuard`
(the fail-closed shared-secret seam)** — i.e. only the backend/ops holder of the secret can
exercise unlock on a payer's behalf — **until a real payer identity/authz seam is designed.**
A genuine `PayerAuthGuard` (per-payer identity, authz to a `payer_id`) is a **new seam and a
launch gate** (ties #42's R15 / per-payer-authz gap and Q-payer below). **No payer-facing
production surface ships on `InternalServiceGuard` alone** — that is an interim alpha
posture, explicitly flagged.

```
POST /unlocks
  Purpose: a payer requests to unlock a worker's routed contact for a job.
  Guard: InternalServiceGuard (interim — payer-auth seam is a launch gate, see above)
  Body (Zod): { payer_id: uuid, worker_id: uuid, job_id?: uuid | null,
                idempotency_key?: string }   // payer_id is the authorized payer (from PayerAuth later)
  FAIL-CLOSED ORDERING (UnlockGuardService, each gate denies + reveals nothing on failure):
    [1] disclosure consent  -> assertWorkerConsentedFor(worker_id,"employer_sharing")
                               fail -> status=denied, deny_reason=no_consent (INTERNAL),
                                       emit unlock.denied; RESPONSE = neutral "unavailable"
    [2] worker caps         -> UnlockGuardService cap check (daily reveals / weekly payers)
                               fail -> status=denied, deny_reason=capped (INTERNAL),
                                       emit unlock.cap_exceeded + unlock.denied;
                                       RESPONSE = neutral "unavailable" (NO oracle)
    [3] payment/credit      -> PaymentGateway.authorizeAndDebit (mock ledger debit)
                               fail -> status=denied, deny_reason=payment_required,
                                       emit payment.failed + unlock.denied;
                                       RESPONSE = { status: "payment_required" }
    [4] grant               -> write unlocks row (status=granted, routing_token_ref,
                               expires_at); emit unlock.requested (at entry) + payment.authorized
                               + payment.captured + unlock.granted
  Idempotency: unique (payer_id, worker_id, job_id) + idempotency_key on the debit ->
               a retried request returns the SAME grant, never a second debit.
  Response (granted):   { unlock_id: uuid, status: "granted", expires_at, reveal_endpoint }
  Response (unavailable): { status: "unavailable" }   // identical for no_consent / capped / unknown_worker
  Response (no credit):  { status: "payment_required" }
  NOTE: the response NEVER contains a phone, proxy number, or the deny_reason enum.

POST /unlocks/:unlockId/reveal
  Purpose: resolve the routed channel for a granted unlock (a contact attempt).
  Guard: InternalServiceGuard (interim payer-auth) — must own the unlock's payer_id
  Param: unlockId (ParseUUIDPipe) -> 404 if unknown (no oracle)
  FAIL-CLOSED ORDERING (UnlockGuardService):
    - unlock exists, status=granted, not expired, reveal_count < cap   (else neutral "unavailable")
    - RE-CHECK disclosure consent [1] (revocation is immediate)        (else neutral "unavailable")
    - RE-CHECK per-unlock attempt cap [2]                              (else neutral "unavailable")
    - [5] ROUTED REVEAL: server resolves routing_token_ref -> opens in_app_relay
          (alpha) / requests proxy_number (provider, human-gated). The raw phone is read
          from workers.phoneE164 (PiiCryptoService) HERE, server-side, ONCE, handed to the
          relay/provider, and DISCARDED. reveal_count++; emit contact.revealed (channel KIND only).
  Response: { unlock_id, channel: "in_app_relay" | "proxy_number", relay_handle | proxy_ref }
  CRITICAL: relay_handle / proxy_ref is a ROUTED, MASKED destination — NEVER the raw phone.
            The raw phone is NEVER in the response, the event, or any log.

GET /unlocks  (ops read)
  Guard: InternalServiceGuard
  Response (Zod): { unlocks: Array<{ unlock_id, payer_id, worker_id, job_id|null, status,
                    reveal_count, granted_at, expires_at, created_at }> }
  PII-FREE projection — worker_id only, NO name/phone, NO routing token resolved.

GET /payers/:payerId/credits  (ops read)
  Guard: InternalServiceGuard
  Response: { payer_id, balance }   // amounts + id only

POST /payers/:payerId/credits  (ops/mock grant — NO real money)
  Guard: InternalServiceGuard
  Body (Zod): { delta: int>=1, reason: "grant" }
  Behaviour: append credit_ledger (+delta, reason=grant), bump payer_credits.balance.
  NOTE: alpha mock top-up ONLY. A real purchase flow is human-gated (§D5) and not built here.
```

**Endpoint → event map (every important endpoint emits a validated event, invariant 1):**

| Endpoint                       | Events emitted (in order)                                                  |
| ------------------------------ | -------------------------------------------------------------------------- |
| `POST /unlocks` (granted)      | `unlock.requested` → `payment.authorized` → `payment.captured` → `unlock.granted` |
| `POST /unlocks` (no consent)   | `unlock.requested` → `unlock.denied`(no_consent)                           |
| `POST /unlocks` (capped)       | `unlock.requested` → `unlock.cap_exceeded` → `unlock.denied`(capped)       |
| `POST /unlocks` (no credit)    | `unlock.requested` → `payment.failed` → `unlock.denied`(payment_required)  |
| `POST /unlocks/:id/reveal`     | `contact.revealed` (or `unlock.cap_exceeded` + neutral fail)               |
| `POST /payers/:id/credits`     | (mock top-up — ledger row; a `payment.*` event is optional for ops audit)  |

---

## EXPLICITLY OUT — hard boundary (do not drift)

This ADR designs a **routed Contact Unlock contract and nothing else.** The following are
**OUT** and touching any of them requires a new team decision (and, where noted, a hard
human stop):

- **No Reach ranking / scoring / matching.** Unlock does not rank, sort, or recommend
  workers. The `@badabhai/reach-engine` is NOT called. Which worker a payer unlocks is the
  payer's choice (or a later, separately-decided surface), never a model's.
- **No real telephony provider in alpha.** Real masked-number/proxy provider keys + spend →
  **STOP and escalate** (human-gated like real LLM/OTP keys). Alpha = in-app relay only.
- **No real payment provider / real money in alpha.** Mock credit ledger only. Real gateway
  keys or real spend → **STOP and escalate** (CLAUDE.md §7). The `PaymentGateway` seam is
  designed for a later, flag-gated, human-approved real implementation.
- **No raw-phone reveal in alpha.** Routed/masked channel only. Raw reveal is post-alpha,
  behind a *separate* higher-tier consent + a team decision + the threat model (OQ-E).
- **No employer PII anywhere.** `payer_id` is opaque (no FK, no `payers` identity table, no
  employer name) — "faceless rails." A structured payer/employer record is a later, separate
  concern.
- **No bulk / scrape / list-unlock.** Unlock is one `(payer_id, worker_id, job_id)` at a
  time, behind caps. No "unlock all applicants," no export of contacts, no enumeration. The
  caps + no-oracle responses are the anti-scrape spine (a fuller PROTECT/anti-scraper design
  is deferred with the Reach Engine).
- **No LLM anywhere near this path.** Pure deterministic CRUD + events + server-side
  routing. No profiling, scoring, canonicalization, or decisioning touches unlock
  (invariants 3, 4 trivially held — there is no model call on this path, and none may be
  added).
- **No payer console / payer self-serve / payer auth UI** beyond the interim
  `InternalServiceGuard` seam. A real `PayerAuthGuard` is a launch gate (§6.3, Q-payer).
- **No #42 merge.** This ADR reconciles the *canonical jobs/payer shape* (§Decision 0) but
  does not adopt #42's lifecycle, pay bands, `posting_fee`, boost, or `job.*` events — those
  remain #42's / a later decision's scope.

---

## Backward-compatibility + migration-shape note (additive; migration is a LATER stream)

- **Additive only.** New tables (`unlocks`, `payer_credits`, `credit_ledger`, optional
  `unlock_routing`) + new FKs (`unlocks.worker_id → workers`, `unlocks.job_id → jobs`,
  `credit_ledger.unlock_id → unlocks`) + light CHECKs + unique indexes. **One additive
  column** (`jobs.payer_id`, opaque, nullable) IF #42 has not already added it (§Decision 0).
  **No existing column is altered or dropped** → invariant 8 held.
- **Event compat:** purely additive registry entries (new `unlock`/`contact`/`payment`
  domains + the `unlock` subject + the `payer` actor that already exists). **No shipped
  payload is mutated.** All new payloads are v1.
- **Consent compat:** adding `"employer_sharing"` to `CONSENT_PURPOSES` is additive (the
  enum reserved it); the `consent.accepted` payload (`purposes: array`) is unchanged.
- **Rollback story:** drop the new tables child-first (`credit_ledger` → `unlock_routing` →
  `unlocks` → `payer_credits`); revert the additive `jobs.payer_id` column if this ADR added
  it. All new tables are unreferenced by Phase-1 tables, so rollback touches no Phase-1 data;
  already-emitted unlock/contact/payment events persist independently in the `events` spine.
- **The actual migration is its own stream** (database-architect, via `safe-db-migration`),
  authored only **after** sign-off + the security threat model — not here.

---

## Risks / open questions to log (for the human — NOT written to registers here)

- **OQ-A (Q2 resolution / pricing):** the credits-vs-subscription-vs-hybrid call + the price
  points are RVM's. This ADR recommends per-(worker, job) credits as the alpha *shape*;
  confirming it would **resolve open-question Q2**.
- **OQ-B (payer auth seam):** there is no payer identity/authz today. Alpha rides
  `InternalServiceGuard` (interim, like #42). A real `PayerAuthGuard` is a **launch gate**
  (ties #42 R15 / per-payer-authz). Decide the alpha posture and own the gap.
- **OQ-C (routing provider):** the production routed channel (masked-number provider) is
  **human-gated** (real key + spend). Alpha = in-app relay (no provider). Provider selection
  + funding is a later human call.
- **OQ-D (unlock granularity tightening):** should unlock *require a prior worker apply* to
  that job (per-application, not just per-(worker, job))? Stronger worker protection; a
  product call.
- **OQ-E (raw reveal, post-alpha):** if raw-phone reveal is ever wanted, it needs a
  *separate* higher-tier consent + a team decision + the threat model. Default: never in
  alpha.
- **OQ-F (caps numbers):** `N=5` reveals/day, `M=10` payers/week, `≤3` attempts/unlock are
  *recommended* starting caps — a trust-and-safety call to confirm.
- **R-1 (migration ordering):** unlock depends on `jobs.payer_id`. If #42 lands first, unlock
  consumes it; else unlock adds it additively. Sequence the streams to avoid two PRs adding
  the same column.
- **R-2 (RLS, TD20):** `unlocks`/`payer_credits`/`credit_ledger`/`unlock_routing` ride the
  service-role posture today; add them to the [rls-plan](../../infra/supabase/rls-plan.md)
  when RLS lands (cross-link TD4/TD20, R1/R15). `unlocks.worker_id` references the RLS-locked
  `workers`.
- **R-3 (DPDP legal copy):** the `employer_sharing` consent notice copy must land with the
  production DPDP legal-copy stream before any non-mock disclosure — a **launch gate**
  (CLAUDE.md §8).
- **R-4 (scope-creep pressure):** "unlock" invites ranking, payer console, bulk export, raw
  reveal — all OUT. The §"EXPLICITLY OUT" section is the live mitigation; reviewers enforce it.
- **THREAT MODEL (DONE):** the PII-disclosure threat model is written —
  [docs/security/contact-unlock-threat-model.md](../security/contact-unlock-threat-model.md)
  (assets, trust boundaries, T1–T10, non-tradeable invariants, before-BUILD / before-LAUNCH
  conditions). Its bb-security-review verdict is **CONCERNS — Phase-0 sign-off may proceed;
  BUILD is blocked until the controls below are pinned + their tests specified.** No finding
  requires re-architecting; each is closable by pinning a control in this contract.

---

## Phase-0 security review — controls mandated before build (fold-in from the threat model)

These amend the contract above. **F-1 and F-2 are hard BUILD-BLOCKERS** (a build could comply
with the prose above and still leak / fail open). The DB → events → API streams are NOT
authorized until F-1 and F-2 are resolved in this contract and their tests specified.

- **F-1 [BUILD-BLOCKER] — `payment_required` is a free consent oracle.** The ordering
  `consent → caps → payment` with a *distinct* `payment_required` response lets a **zero-credit**
  payer learn a worker consented-and-uncapped (vs the neutral "unavailable" they'd get at
  consent/caps). **AMENDMENT:** a balance/credit precondition is checked **first**, worker-state-
  independent — OR insufficient-credits collapses into the **identical neutral response**. A
  zero-credit payer must not distinguish any worker state. *Test:* zero-credit payer gets a
  byte-identical response for a consented-uncapped vs a non-consented worker.
- **F-2 [BUILD-BLOCKER] — cap check must be atomic.** Counting granted reveals prevents drift,
  not the race; K concurrent requests can each read "under cap" and all grant. **AMENDMENT:** the
  cap-check-and-write is one atomic transaction (`SELECT … FOR UPDATE` / advisory lock on
  `worker_id`). *Test:* N parallel unlock/reveal for one worker never exceed the cap.
- **F-3 — single neutral-response constructor (no oracle).** The neutral set must also cover
  *already-unlocked / owned-by-another-payer*, and `POST /unlocks/:id/reveal` must return the
  **neutral body** (not a bare 404) for unknown/expired/over-cap/revoked. One constructor →
  byte-identical body + status across every deny branch. Timing-normalization is an alpha
  residual / launch gate. *Test:* table-driven byte-identical-response across all deny states.
- **F-4 — routing-token contract.** `routing_token_ref` = 122-bit UUIDv4, **server-internal
  only, never in any response or event**; the payer-facing `relay_handle`/`proxy_ref` is a
  *separate*, expiring, non-reversible handle; the mapping record is schema-proven phone-free.
  *Test:* the token never appears in a response/event; the handle is non-reversible and expires.
- **F-5 — phone touched only at reveal, provably un-logged.** `PiiCryptoService.decrypt` is
  called only at step [5]; the value is never returned, emitted, logged, or put in an exception
  message; all failures map to the neutral path. **Controls:** a lint/grep gate (no `decrypt(`
  outside the reveal handler) + review-checklist item. *Tests:* a sentinel-phone full-reveal test
  asserts it appears in no event/response/`ai_jobs`/`audit_logs`; a provider-error-carrying-phone
  test asserts it never reaches a response/log; a schema test that no unlock-family table has a
  phone/name/contact column.
- **F-6 — debit + grant atomic + mock honesty.** `[3]+[4]` in one transaction (no
  debit-without-grant / grant-without-debit on partial failure); `balance >= 0` CHECK; idempotent
  debit (retry → one debit / one grant); `PAYMENTS_ENABLE_REAL=false` with a fail-closed config
  assertion mirroring `assertPiiCryptoConfig`; all `payment.*` carry `real_call: false` in alpha.
- **F-7 [LAUNCH GATE] — payer-auth gap.** Under `InternalServiceGuard` there is no per-payer
  identity, so "reveal only if you own the unlock's `payer_id`" is **unenforceable** and must not
  be assumed-enforced in alpha. **No production payer surface ships on the shared secret** —
  `PayerAuthGuard` (with a horizontal-authz test: payer A cannot act on payer B's `payer_id`) is
  a hard launch gate.

**Human-gated escalations (surface at sign-off):** real telephony/proxy provider; real payment
keys/spend; raw-phone reveal; production DPDP copy for `employer_sharing`; `PayerAuthGuard`
before any client-facing payer surface.

---

## STOP — sign-off required before ANY implementation

**This is a design artifact. Nothing here is built or authorized.** Before a single line of
unlock code, migration, or register edit:

1. **The six decisions (0–6) require explicit human/RVM sign-off** — each is marked
   "REQUIRES SIGN-OFF — not assumed." They are the maintainer's/RVM's calls (pricing,
   routing provider, consent/lawful-basis framing, caps, payments posture, canonical jobs).
2. **The security-engineer PII-disclosure threat model must be authored and pass** — unlock
   is the highest-risk PII path in the product.
3. **Real telephony or real payment keys/spend → STOP and escalate** (CLAUDE.md §7). Alpha
   is in-app-relay + mock-credits only.
4. Only then are the implementation streams (DB → events → API, behind the gates) handed to
   the engineer agents, each honouring the fail-closed ordering and the no-PII-in-events/logs
   guarantees fixed above.

**Do not proceed past this line without recorded human sign-off.**

---

## Related

- ADR-0009 (alpha swipe-to-apply — the live `jobs`/`applications`/`ConsentGuard`/`WorkerAuthGuard` this builds on)
- ADR-0006 (Reach foundation — the `feed.*`/`application.*` contracts + `job` subject + `payer` actor; this ADR does NOT mutate them)
- ADR-0004 (PII-at-rest + RLS — raw phone/name in `workers` only; new tables ride the service-role posture + RLS backlog)
- PR #42 / `feat/jobs-entity-lifecycle` `docs/decisions/0009-job-entity-and-lifecycle.md` (the richer Phase-2 jobs/payer entity — reconciled in §Decision 0, NOT merged)
- `packages/event-schema/src/{payloads,registry,enums,envelope}.ts` (the event contract this extends additively)
- `packages/db/src/schema.ts` (`jobs` ~L547, `applications` ~L565, `workers` ~L64, `worker_consents` ~L85)
- `apps/api/src/auth/consent.guard.ts` (the consent-gate pattern the disclosure gate mirrors), `apps/api/src/common/guards/internal-service.guard.ts` (the interim payer-auth seam), `apps/api/src/consent/consent.service.ts` (the emit + idempotency reference)
- `packages/types/src/index.ts` (`CONSENT_PURPOSES` — already reserves `employer_sharing`)
- CLAUDE.md §2 invariants 1, 2, 5, 6, 7, 8; §8 deferred list
- Open-question **Q2** (unlock pricing — this ADR's Decision 1 recommends the resolution)
