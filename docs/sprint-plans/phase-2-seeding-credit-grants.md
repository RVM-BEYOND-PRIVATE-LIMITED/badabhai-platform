# Spec stub (PARKED) — Seeding / Credit Grants (assisted-hiring stays a STUB)

> **Status: PARKED — Phase-2 fast-follow. CAPTURE ONLY, nothing built.** A self-serve or
> ops-driven granting flow is deferred scope (CLAUDE.md §8). This stub makes it
> schedulable later. **No code, no schema changes here.**
> **Owners (when scheduled):** product-manager (policy) · backend (grant flow + authz) ·
> security (abuse/audit).

## What "seeding" grants
"Seeding" = putting **credits into a payer's balance WITHOUT a purchase** — e.g.
promotional/trial credits, onboarding goodwill, or **assisted-hiring** (BadaBhai ops
running unlocks on a payer's behalf). The credit primitive already exists: the
`credit_ledger` movement-reason enum carries **`grant`** alongside `pack_purchase` /
`unlock_debit` / `refund` ([`schema.ts` CreditReason](../../packages/db/src/schema.ts)).
So the *ledger can already record a grant* — what is **missing (and deferred)** is the
**grant FLOW, the authz over who may grant, the policy/limits, and the audit/abuse
controls** around it.

## Who can grant (intended)
- **Ops/admin only** — never self-serve; a grant is money-equivalent value.
- Bounded by a per-grant / per-period **cap** and an explicit grantor identity in the
  audit spine (PII-free: opaque ids only), so seeding can't silently mint unlimited value.

## Why it's deferred
- Needs **real payer identity + authz** ([TD33](../registers/tech-debt-register.md)
  `PayerAuthGuard`) — a grant flow on the interim shared-secret guard has no real grantor
  identity and no horizontal-authz, i.e. unsafe to expose.
- Needs a **grant policy** (who, how much, expiry, reason taxonomy) + **abuse controls**
  (value-creation must be capped + audited) — product + security work, not yet scoped.
- **Assisted-hiring** (BadaBhai-operated hiring on an employer's behalf) is a **STUB in
  alpha** — the concept is not built; only the manual ops mock top-up exists
  ([TD34](../registers/tech-debt-register.md) mock credit path). No assisted-hiring
  workflow, SLA, or automation ships in alpha.

## Data it will need (additive — design at build time)
- A **grant policy/config** (caps, allowed reasons, expiry) and a **grantor audit trail**
  (opaque grantor id + reason on each `grant` ledger row). The ledger row itself already
  exists; the policy + authz + audit wrapper do not.

## UN-DEFER TRIGGER (all must be true before we build)
1. **TD33 closed** — real per-payer identity + authz (so a grantor is a real, authorized
   identity, not the shared secret).
2. Product has defined the **grant/seeding policy** (who may grant, caps, expiry, reasons)
   and security has signed off **abuse/audit** controls.
3. A concrete need exists (a real promo/trial or assisted-hiring program is greenlit) —
   we do not build a granting surface speculatively.

## Alpha confirmation
**Alpha ships WITHOUT a seeding/credit-grant flow, and assisted-hiring is a STUB** (not
built). The only alpha crediting path is the **manual ops MOCK top-up** (TD34); no
automated or self-serve grants exist. Cross-links:
[ADR-0010](../decisions/0010-contact-unlock-and-reveal.md),
[ADR-0013](../decisions/0013-monetization-and-config-driven-pricing-engine.md),
[future-improvements.md](../registers/future-improvements.md),
[tech-debt TD40](../registers/tech-debt-register.md).
