# ADR-0019: Self-serve payer portal — ops-run → EXTERNAL self-serve (Phase-0 design)

- **Status:** **ACCEPTED (maintainer sign-off 2026-06-18) — Phase-0 design signed; PHASE 1
  AUTHORIZED.** Decisions A–E and the **invariant-#2 payer-PII extension (B-R2)** are accepted
  (see § SIGN-OFF below). The Phase-0 STOP is cleared. **Still binding:** Phase 1 is **mock +
  staging-only** (no real payments, no open external); a **`bb-security-review` PASS on the
  realized code** is required before any payer-facing surface merges; **real Razorpay
  keys/spend (D / E-R2) and open external GA (Phase 4) remain separate HUMAN gates.** This ADR
  draws the contract for the move from *ops-run, faceless `payer_id`* to *external,
  authenticated, self-serve payers*. **Phase-2 — NOT alpha-gate.**
- **Date:** 2026-06-18
- **Phase-1 BUILD STATUS (2026-06-20, PR `feat/r16-payer-auth-wiring`):** the Decision-B
  identity slice is **built + security-reviewed (bb-security-review + independent
  security-engineer PASS on XB-A…XB-H)**, MOCK + STAGING-ONLY. Shipped: `PayerAuthGuard`
  wired into `AppModule`; a NEW `/payer/*` route group (signup + login [email-OTP default /
  WhatsApp-mock / inert-Supabase channel seam, `PayerSessionService`] + refresh/logout +
  the payer-self disclosure routes reusing the `UnlockService` chokepoint with session-
  derived `payer_id`, XB-A); the **XB-G** per-payer disclosure cap; **XB-H** auth hardening
  (no user-enumeration, per-IP + per-account caps, signed/revocable/rolling session,
  `assertPayerAuthConfig` fail-closed boot); and the PII-free `payer.*` event domain
  ([R16](../registers/risks-register.md) LC-1 satisfied for the payer-self surface;
  [TD33](../registers/tech-debt-register.md) paying down).
- **Phase-1 BUILD STATUS (2026-06-20, PR2 `feat/r22-payer-reach-view`):** the **payer-self
  REACH view** is built + security-reviewed (bb-security-review + independent authz-review PASS;
  [reach threat-model addendum](../security/payer-reach-view-threat-model-addendum.md)). The
  `jobs`↔`job_postings` fork was resolved (decision-ready synthesis): the reach view serves the
  payer's OWNED seeded `jobs` (`jobs.payer_id`, the only payer-owned + reach-rankable +
  applicant-bearing entity) via a NEW guarded `GET /payer/reach/jobs/:jobId/applicants` —
  additive, **NO** `jobs`↔`job_postings` bridge (ADR-0012's "no bridge" stands), reusing the
  `ReachService` ranking + the faceless projection + the existing `feed.shown` event (payer
  actor). Ownership is a no-oracle identical-404 read; reach stays **information-only** (no
  quota/credit/payment); scrape-bounded by a per-payer reach cap. Closes [R22](../registers/risks-register.md)
  for the EXTERNAL surface (the ops `/reach/*` unauth posture is unchanged, one-principal-per-route).
  **Deferred:** the **monetization↔reach bridge** (`job_postings`/quota → reach) is a SEPARATE
  future ADR (TD37), and the `apps/payer-web` skeleton (Decision A). **Still human-gated launch
  gates (unchanged):** DB-enforced RLS (XL-A / Phase 2), real payments (Phase 3 / TD34),
  production DPDP/DPA copy, pen test — open external GA (Phase 4) remains blocked.

## SIGN-OFF (2026-06-18) — maintainer: ACCEPTED

> The maintainer accepted decisions A–E and the phased plan. Recorded here as the Phase-0
> sign-off (mirrors the ADR-0013 § SIGN-OFF pattern). Where a resolution conflicts with the
> body, the resolution wins.

- **A — Surface: ACCEPTED.** Build a **new external app `apps/payer-web`** (Next.js, public
  origin); do **not** add external auth to the internal `apps/web` ops console.
- **B — Identity/Auth: ACCEPTED.** Net-new `payers` account + `PayerAuthGuard` (builds the
  deferred LC-1/TD33); three distinct principals (worker/payer/ops). **B-R2 ACCEPTED — the
  invariant-#2 extension stands:** payer/employer B2B contact PII is a new class, stored in
  `payers` under the **ADR-0004 at-rest discipline** (encryption at rest + keyed-hash lookup +
  RLS/REVOKE) and **never** in events/`ai_jobs`/`audit_logs`/logs/LLM input; `payer_id` stays
  the only token in events.
- **C — Tenancy/RLS: ACCEPTED.** Two-axis isolation; app-layer tenant chokepoint + a
  horizontal-authz build-blocker test first; **DB-enforced RLS is the open-GA launch gate**
  (resolves the payer half of Q5; coordinate with ADR-0004). External access stays
  staging/closed-beta until DB RLS lands.
- **D — Real payments: ACCEPTED as designed, default MOCK.** Razorpay hosted-checkout + signed
  webhook + server-side amount + idempotent capture behind `PAYMENTS_ENABLE_REAL=false`. **Real
  keys/spend remain a HARD human gate (E-R2 / LC-5 / TD34)** — NOT cleared by this sign-off.
- **E — External disclosure: ACCEPTED.** The
  [external-disclosure addendum](../security/payer-portal-external-disclosure-threat-model-addendum.md)
  is the pre-build gate; its XB-A…XB-H controls are build-blockers; a `bb-security-review` PASS
  on the built surface is required before merge.

**What this sign-off authorizes:** the **Phase 1** streams (`payers` model + `PayerAuthGuard` +
app-layer tenant chokepoint + horizontal-authz tests + `apps/payer-web` skeleton + the
addendum's disclosure controls), **mock payments, staging-only**, each behind the
security-review gate. **What it does NOT authorize:** real payment keys/spend (Phase 3), DB-RLS
sign-off specifics (land with ADR-0004), or open external GA (Phase 4) — all separate gates.
- **Author:** system-architect (architecture + contract) + **security-engineer (MANDATORY —
  this opens an external, untrusted trust boundary)** + product-manager (surface + onboarding).
  backend-engineer / database-architect / frontend-engineer **consulted** (build streams, after
  sign-off).
- **Companion (this set):**
  [payer-portal-external-disclosure-threat-model-addendum.md](../security/payer-portal-external-disclosure-threat-model-addendum.md)
  — Decision E, the disclosure threat model re-run for the untrusted external payer actor
  (MANDATORY pre-build gate, mirrors the ADR-0013 → resume-disclosure-addendum pattern).
- **Builds on / reconciles (verified against the repo, 2026-06-18):**
  - **[ADR-0010 — Contact Unlock + Reveal](0010-contact-unlock-and-reveal.md)** — the
    routed-disclosure spine, the opaque `payer_id` "faceless rails", `InternalServiceGuard` as
    the **interim** payer seam, and **`PayerAuthGuard` as a declared LAUNCH GATE (F-7 / LC-1 /
    TD33)**. This ADR is the decision that **builds `PayerAuthGuard`** and gives `payer_id` a
    real account.
  - **[ADR-0013 — Monetization + Pricing Engine](0013-monetization-and-config-driven-pricing-engine.md)**
    + **[ADR-0016 — Per-payer hiring capacity](0016-payer-hiring-capacity.md)** — the paid
    products (`posting_plans`/`posting_boosts`/`resume_disclosures`/`payer_credits`/
    `credit_ledger`/`payer_capacity`), the `PaymentGateway` seam + `PAYMENTS_ENABLE_REAL=false`,
    **Razorpay documented-but-DISABLED (TD34 / LC-5 / E-R2)**, and the **advisory `payer_id`
    until PayerAuthGuard (TD43)**. This ADR makes those surfaces externally reachable and
    self-served.
  - **[ADR-0004 — PII at rest + RLS](0004-pii-at-rest-and-rls.md)** + **[rls-plan.md](../../infra/supabase/rls-plan.md)**
    + **Q5** — the REVOKE + `BYPASSRLS` posture, `workers` FORCE-RLS, and the **OPEN** "auth
    identity → row" mapping. External self-serve makes RLS a **hard requirement**, not a
    backlog item; this ADR designs the **payer** tenancy half and coordinates the `workers`
    half with ADR-0004.
  - **[resume-disclosure-threat-model-addendum](../security/resume-disclosure-threat-model-addendum.md)**
    — the employer-facing resume is **identity-MASKED** (masked initials, no phone); caps +
    no-oracle + no-bulk are load-bearing. Decision E re-runs this for an **adversarial external
    payer**.
  - **CLAUDE.md §2 invariants 1, 2, 4, 5, 6, 7, 8; §3 locked stack; §7 escalation; §8 deferred
    (employer posting/unlock/payments, finalized RLS, real payment providers, production DPDP).**

---

## Context

Every paid surface today is **ops-run**: a human in ops acts *on behalf of* a payer through
`InternalServiceGuard` (a shared internal secret), and `payer_id` is **opaque faceless rails**
— no account, no FK, no PII, no login (ADR-0010/0013/0016). The product goal now is **external
self-serve**: an employer or agent signs in to **their own portal**, posts/boosts jobs, tops up
credits, views their faceless applicant lists, and downloads masked resumes — **without ops in
the loop**.

This is not a feature; it is a **new trust boundary**. It introduces, for the first time:
an **untrusted external principal** with a durable account, a **second class of PII** (payer/
employer B2B contact data), **multi-tenant isolation** as a correctness-and-safety requirement,
**self-serve real money**, and an **adversarial actor on the disclosure path**. Several controls
that prior ADRs explicitly deferred as *launch gates* (`PayerAuthGuard`/LC-1, real payments/
LC-5, finalized RLS/Q5, production DPDP/DPA copy) become **hard pre-launch requirements here** —
the portal is precisely the consumer that flips them.

**Disciplines that govern every decision (restated):** workers are never charged and worker PII
never leaves its boundary (the masked, consented, capped disclosure chokepoint is the *only*
path to any worker identity); the disclosure ordering and no-oracle rule are non-tradeable;
real payment keys/spend are human-gated; additive-only; no LLM anywhere on this path.

This ADR fixes the architecture **before any code**, exactly as ADR-0010/0013/0017/0018 did.

---

## Decision — overview

| # | Decision | Headline |
|---|----------|----------|
| **A** | **Surface** | **A NEW external app `apps/payer-web`** (Next.js, public origin) — **NOT** a section of the internal `apps/web` ops console. Do not bolt external auth onto the ops trust boundary. |
| **B** | **Payer identity + auth** | A net-new **`payers` account** model + **`PayerAuthGuard`** (the deferred LC-1). Three distinct principals — worker, **payer**, ops — never conflated. Payer/employer B2B PII is a **new PII class** with its own at-rest protection (an explicit, sign-off-gated extension of invariant #2). |
| **C** | **Tenancy / RLS** | Hard two-axis isolation: **payer↔payer** (a payer sees only their own rows) and **payer↔worker** (no raw worker PII, ever). App-layer tenant chokepoint built first + horizontal-authz tested; **DB-enforced RLS is a HARD launch gate** (resolves the payer half of Q5; coordinates ADR-0004 for the worker half). |
| **D** | **Real payments** | Self-serve top-up is designed behind the **existing `PaymentGateway` seam** + `PAYMENTS_ENABLE_REAL=false` default: Razorpay **hosted checkout + signed webhook + server-side amount + idempotent capture**. **Real keys/spend stay HUMAN-GATED (STOP);** mock remains the default. |
| **E** | **External disclosure** | Re-run the disclosure threat model for an **adversarial, authenticated external payer** (companion addendum). routed-not-raw, masking, **shared per-worker caps**, `employer_sharing` consent, no-oracle, no-bulk **must hold against an attacker**; per-payer caps become **enforceable** (real identity) but **account-farming** is the new threat the per-worker cap backstops. |

---

## Decision A — Surface: a NEW external app `apps/payer-web` (not a section of `apps/web`)

**REQUIRES SIGN-OFF — not assumed.**

`apps/web` is the **internal ops console** (CLAUDE.md §3/§4: "Next.js (internal only)") — it
reads workers/events/ai-jobs, runs behind ops trust, and has **no external auth**. Self-serve
payers are **untrusted external users**.

**Options weighed:**

| Option | What | Verdict |
|---|---|---|
| **(i) authenticated section inside `apps/web`** | add a `/payer/*` area + external auth to the ops console | **Rejected.** Collapses two trust boundaries into one origin/session/deploy: a bug in payer authz could expose ops-only views (workers/events/PII); the ops app's data access is privileged; one XSS/session flaw now spans both audiences. "Internal-only" is a property we'd be discarding silently. |
| **(ii) NEW app `apps/payer-web`** (Next.js, public origin, its own deploy) | a separate external front-end that talks to the API like the worker-app does | **RECOMMENDED.** Distinct trust boundary, distinct auth domain, distinct origin/CORS, distinct deploy. No code path from a payer session to an ops-only endpoint. Mirrors the existing split (worker-app is external; `apps/web` is internal). |

**Recommendation: (ii).** New `apps/payer-web` on the **locked stack** (Next.js — a new
*workspace app*, not a stack change, §3). It consumes the **public** API surface behind
`PayerAuthGuard` (Decision B) — **never** the ops console's privileged data access. The API
gains a **payer-scoped** route group distinct from the ops (`InternalServiceGuard`) group; an
endpoint is reachable by exactly one principal class. CORS/origin allow-list is per-app.

---

## Decision B — Payer identity + auth: a `payers` account + `PayerAuthGuard`

**REQUIRES SIGN-OFF — not assumed. Builds the deferred LC-1 launch gate.**

Today `payer_id` is an opaque UUID with no account. Self-serve needs a **real authenticated
account** that **owns** that `payer_id`.

### B.1 The account model (additive, new PII class)
- **`payers`** — the account behind the opaque `payer_id` (the existing `payer_id` on
  `posting_plans`/`unlocks`/`resume_disclosures`/`credit_ledger`/`payer_capacity` becomes the
  FK target — *backward-compatible*: those columns stay opaque UUIDs, now resolvable to an
  account). Holds the payer's **login identity + B2B contact** (org/display name, login email
  and/or phone, role = `employer | agent`, status). This is **employer/business contact PII —
  a NEW class distinct from worker PII.**
- **`payer_users`** (if one org has multiple logins) — optional; a later refinement. Alpha may
  be one login per `payer`.

> **⚠️ Invariant #2 extension — escalate.** Invariant #2 says *raw PII lives only in `workers`*.
> Payer accounts introduce **employer/business contact PII** (names, emails, phones of paying
> businesses). This is a **deliberate extension of the PII boundary model** and an architecture
> decision in its own right: payer PII is a **separate class**, stored in `payers` under the
> **same at-rest discipline as ADR-0004** (encryption at rest for contact fields, keyed hashing
> for login-lookup, RLS+REVOKE), and — like worker PII — **never** enters events / `ai_jobs` /
> `audit_logs` / logs / any LLM input. The `payer_id` stays the only token in events. **This
> extension requires explicit sign-off; do not treat payer PII as exempt from §2.**

### B.2 Auth — three principals, never conflated
- **`PayerAuthGuard`** (the deferred ADR-0010 F-7 / LC-1 / TD33): authenticates a payer and
  **authorizes every action to that payer's own `payer_id` only**. The horizontal-authz
  property is mandatory and **tested**: *payer A can never act on payer B's `payer_id`*
  (the exact test ADR-0010 F-7 / LC-A demands).
- **Distinct from** `InternalServiceGuard` (ops, may still act as any payer for support) and
  the worker session (worker-app). An endpoint declares exactly one principal class; there is
  no route reachable by two.
- **Mechanism (ratify — B-R1):** prefer the **locked stack** (Supabase Auth, already present)
  for the payer identity provider, with the API minting/validating a payer session and mapping
  `auth identity → payers.id` (the payer analogue of Q5's worker mapping). A bespoke
  email/OTP+password is the alternative. Either way, **secrets/keys for the provider are config,
  fail-closed**; no real provider is enabled by this ADR.

---

## Decision C — Tenancy / RLS: hard two-axis isolation (RLS is NOT optional here)

**REQUIRES SIGN-OFF — not assumed. Makes Q5 a hard requirement; coordinates ADR-0004.**

External untrusted users make isolation a **safety + correctness** requirement, not a backlog
item (ADR-0004 / rls-plan / Q5 were written for a Phase-1 world where *only the service-role
backend* connected).

### C.1 Two axes
- **payer ↔ payer (tenant isolation):** a payer sees ONLY their own `job_postings` /
  `posting_plans` / `posting_boosts` / `payer_credits` / `credit_ledger` / `unlocks` /
  `resume_disclosures` / `payer_capacity` — every row scoped by `payer_id = <authenticated
  payer>`.
- **payer ↔ worker (PII isolation):** a payer **never** reads the `workers` table or any raw
  worker PII. Worker identity reaches a payer ONLY through the **masked, consented, capped**
  disclosure chokepoint (ADR-0010/0013 + the resume-disclosure addendum). `workers` stays
  **FORCE-RLS + REVOKE** (ADR-0004), unchanged.

### C.2 Enforcement — layered, with DB RLS as the launch gate
| Layer | What | When |
|---|---|---|
| **App-layer tenant chokepoint** | a single `PayerScopedRepository`-class seam: every payer-facing query is filtered by the authenticated `payer_id`; no payer query bypasses it. Horizontal-authz integration test (payer A ↔ payer B) is a **build-blocker**. | **Built first** (mandatory before any payer logs in, even in staging). |
| **DB-enforced RLS** | real Postgres RLS policies keyed to the payer identity (`current_payer_id()` via a request-scoped `SET LOCAL` on a least-privilege connection, or a payer-scoped role) on all payer-owned tables — defense-in-depth so an app bug cannot cross tenants. | **HARD LAUNCH GATE** before open external GA (coordinate ADR-0004; resolves the **payer half of Q5**). |

> **The BYPASSRLS reality (ADR-0004):** the backend connects as a `BYPASSRLS` `postgres` role,
> so DB RLS today is *deny-by-default-via-REVOKE*, not policy-enforced per principal. Real
> per-payer DB RLS therefore needs either a **least-privilege payer connection/role** or a
> **request-scoped identity** (`SET LOCAL app.payer_id`) that policies read — a concrete design
> item to land **with** ADR-0004's worker mapping (Q5). Until DB RLS lands, the **app-layer
> chokepoint is the enforced control** and external access stays **staging/closed-beta only**.

### C.3 The rule
**No external payer is admitted to a shared environment on app-layer tenancy alone for GA.**
Closed beta on the tested app-layer chokepoint is acceptable; **open external self-serve is
gated on DB-enforced RLS** (this is the non-negotiable upgrade external access forces on Q5).

---

## Decision D — Real payments: design the enablement, default stays mock, real = human-gated

**REQUIRES SIGN-OFF — not assumed. DEFAULT MOCK. Real keys/spend → STOP (CLAUDE.md §7).**

> **HARD STOP:** real Razorpay keys or real money movement → escalate to the human. This ADR
> does **not** authorize a real gateway; it designs how it slots in.

Self-serve top-up is the first surface that **needs** real money (ops could fake credits; an
external payer cannot). It rides the **existing seam** (ADR-0010 §D5 / ADR-0013 E):
`resolvePrice (pricing engine) → quote → PaymentGateway.authorizeAndDebit → grant`, behind
`PAYMENTS_ENABLE_REAL=false` (default), with `real_call:false` in `payment.*` events until the
real path is enabled.

**Real Razorpay design (built only after the human gate):**
- **Hosted checkout** (Razorpay-hosted) — **no card data touches our servers** (PCI scope
  minimized); the client never sees a secret key.
- **Server-side amount** — the charge amount is **always** re-resolved by the pricing engine
  server-side; the client-supplied amount is never trusted.
- **Signed webhook** — capture is confirmed by a **signature-verified** Razorpay webhook
  (server trusts the webhook, not a client "success" callback); a spoofed/unsigned webhook is
  rejected (fail-closed). Webhook secret is config, human-gated.
- **Idempotent capture + grant** — one transaction keyed on the order/idempotency key; a
  replayed webhook or retried purchase never double-grants/double-charges (ADR-0010 F-6).
- **Reconciliation + audit** — `payment.authorized/captured/failed` (reused, PII-free) with
  `real_call:true` only on the real path; a reconciliation job matches gateway state to the
  ledger.
- **Consumer-protection posture (ratify — D-R1):** ADR-0013 set "no refunds" for ops-run; a
  **self-serve consumer** surface may need a refund/dispute/chargeback story (and GST invoicing)
  — flagged as a product+legal sub-decision, not assumed.

**Gates:** real provider keys (staging-first, never committed), the webhook secret, spend
guardrails, and a staging-first rollout are a **HARD human escalation** (E-R2 / LC-5 / TD34).

---

## Decision E — External disclosure: re-run the threat model for an adversarial payer

**REQUIRES SIGN-OFF + MANDATORY security-engineer. See the companion addendum (pre-build gate).**

The unlock/reveal + masked-resume disclosure path is today reachable only by **ops** (trusted,
via `InternalServiceGuard`). Self-serve makes it reachable by an **untrusted, authenticated,
potentially adversarial external payer**. The companion
[payer-portal-external-disclosure-threat-model-addendum](../security/payer-portal-external-disclosure-threat-model-addendum.md)
re-runs the model for that actor; headline deltas:

- **routed-not-raw, masking, `employer_sharing` consent, shared per-worker caps, no-oracle,
  no-bulk** — all must hold **against an attacker**, not just an honest ops user. These are
  re-affirmed non-tradeable.
- **Per-payer caps become ENFORCEABLE** — `PayerAuthGuard` gives a real identity, closing the
  ADR-0010 RR-A "ops can act as any payer" residual for the external surface.
- **NEW threat — account farming:** an attacker spins up many payer accounts to multiply
  per-payer caps. **Backstop: the per-WORKER shared disclosure cap is payer-count-independent**
  — it bounds total disclosure of any worker regardless of how many payer accounts exist. Plus
  **onboarding friction** (payment-method/KYC-lite binding) raises the cost of farming.
- **NEW surface — external auth** (credential stuffing, session theft, account takeover) and
  **payment fraud / webhook spoofing** (Decision D) — attack classes the internal ops console
  never had; standard auth hardening + signed webhooks are required.
- **Horizontal authz** (payer A → payer B's data) — Decision C + the F-7 test.

---

## EXPLICITLY OUT — hard boundary (do not drift)
- **No real payment provider / real money** until the human gate (Decision D / §7). Mock default.
- **No open external launch** until: `PayerAuthGuard` + horizontal-authz test, **DB-enforced
  RLS**, the external-disclosure addendum controls built+tested, production DPDP/DPA copy, and a
  security-engineer PASS. Closed beta on the app-layer chokepoint only.
- **No worker PII to a payer** beyond the masked/consented/capped chokepoint. `workers` stays
  FORCE-RLS+REVOKE; the masked employer resume (initials, no phone) is unchanged.
- **No payer PII in events / ai_jobs / audit_logs / logs / LLM input.** `payer_id` stays the
  only token; payer contact PII lives only in `payers`, ADR-0004-protected.
- **No ops/payer principal conflation.** Separate app, separate guard, separate origin; no
  endpoint reachable by two principal classes.
- **No bulk / scrape / list export** of resumes or contacts (ADR-0010/0013 anti-scrape spine).
- **No LLM, no ranking change** on this path (pricing is deterministic; the portal renders the
  faceless ADR-0011 lists + the masked disclosure chokepoint).
- **No mutation of a shipped payload/column.** Additive only (invariant 8): `payers`(+`payer_users`)
  tables, FK target for the existing opaque `payer_id`, `apps/payer-web`, payer-scoped route
  group, RLS policies — nothing existing is altered.

---

## Phased build plan (each phase STOPS at its gate)

| Phase | Scope | Gate to ENTER |
|---|---|---|
| **0 — this ADR set** | the ADR(s) + threat-model addendum + phased plan. **No code.** | — (you are here) |
| **1 — identity + tenancy (mock, staging-only)** | `payers` model (ADR-0004-protected PII) + `PayerAuthGuard` + **app-layer tenant chokepoint** + horizontal-authz tests; `apps/payer-web` skeleton (staging-only access); reuse **mock** payments; build+test the external-disclosure controls (B-A…B-G of the addendum). | **Human/RVM + security-engineer sign-off on A–E**; invariant-#2 extension (payer PII) accepted. |
| **2 — RLS + launch hardening** | **DB-enforced RLS** for payer-owned tables (coordinate ADR-0004 worker mapping / Q5); per-payer rate caps; production DPDP `employer_sharing` notice + payer **DPA**; security review + pen test. | Phase 1 merged + green; ADR-0004 RLS design landed. |
| **3 — real payments (HUMAN-GATED)** | Razorpay hosted checkout + signed webhook + server-side amount + idempotent capture + reconciliation, staging-first behind `PAYMENTS_ENABLE_REAL`; refund/dispute/GST posture (D-R1). | **HARD human gate**: real keys/spend/webhook secret (CLAUDE.md §7) + security PASS. |
| **4 — open external GA** | flip external access from closed-beta to open self-serve. | ALL launch gates green: DB RLS, PayerAuthGuard+authz test, disclosure addendum PASS, DPDP/DPA copy, real-payment sign-off (if charging), pen test. |

---

## Open ratifications (surface at sign-off)
- **A-R1** — surface: new `apps/payer-web` (recommended) vs a section of `apps/web` (rejected).
- **B-R1** — payer identity provider: Supabase Auth (recommended, locked stack) vs bespoke; one
  login per payer vs `payer_users` multi-user from day one.
- **B-R2 [ESCALATE]** — accept the **invariant-#2 extension** for payer/employer B2B PII (new
  class, ADR-0004-protected, never in events). This is an architecture change requiring explicit
  sign-off.
- **C-R1** — DB-RLS mechanism: least-privilege payer connection/role vs request-scoped
  `SET LOCAL` identity; land with ADR-0004 / Q5.
- **D-R1** — self-serve consumer protection: refunds/disputes/chargebacks + GST invoicing posture.
- **E-R1 [HARD PRE-BUILD GATE]** — the external-disclosure threat-model addendum is authored +
  passes before the external disclosure surface ships (companion doc).
- **E-R2 [HARD HUMAN GATE]** — real Razorpay keys/spend/staging-first (LC-5 / TD34).

---

## STOP — sign-off required before ANY implementation

**This is a design artifact. Nothing here is built or authorized.** Before a single line of
`apps/payer-web`, `payers`/`PayerAuthGuard`, tenancy, or payment code:

1. **Decisions A–E require explicit human/RVM sign-off** — especially the **surface (A)**, the
   **invariant-#2 payer-PII extension (B-R2)**, and the **RLS-as-launch-gate posture (C)**.
2. **The external-disclosure threat-model addendum must pass** (E-R1) — MANDATORY
   security-engineer; it widens the disclosure path to an adversarial actor.
3. **Real payment keys/spend (Razorpay) → STOP and escalate** (E-R2 / §7). Mock until then.
4. **No open external launch** until every Phase-4 gate is green.

**Do not proceed past this line without recorded human/RVM + security-engineer sign-off.**

---

## Related
- ADR-0010 (disclosure spine; `PayerAuthGuard`/`InternalServiceGuard`; F-7/LC-1) +
  [contact-unlock threat model](../security/contact-unlock-threat-model.md)
- ADR-0013 (pricing engine; `PaymentGateway`; Razorpay disabled) / ADR-0016 (payer capacity; TD43)
- ADR-0004 (PII-at-rest + RLS; the posture payer tenancy extends) + [rls-plan.md](../../infra/supabase/rls-plan.md) + Q5
- [resume-disclosure threat-model addendum](../security/resume-disclosure-threat-model-addendum.md) (masked employer resume)
- [payer-portal external-disclosure addendum](../security/payer-portal-external-disclosure-threat-model-addendum.md) (this ADR's companion)
- CLAUDE.md §2 invariants 1, 2, 4, 5, 6, 7, 8; §3 locked stack; §7 escalation; §8 deferred
