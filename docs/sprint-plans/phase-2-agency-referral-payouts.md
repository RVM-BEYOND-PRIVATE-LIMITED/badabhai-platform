# Spec stub (PARKED) — Agency Referral Funnel + Payouts

> **Status: PARKED — Phase-2 fast-follow. CAPTURE ONLY, nothing built.** Building this
> in alpha breaches CLAUDE.md §8 (deferred scope: payouts, payments, agency flows). This
> is a stub to make the work schedulable later, not a commitment.
> **Owners (when scheduled):** product-manager (model) · backend (ledger/attribution) ·
> security + legal (KYC/DPDP, real money). **This doc changes no code and no schema.**

## Intended model

Agencies/agents refer candidates into the funnel; a referral that **converts** (a paid
unlock / placement attributable to that referral) inside the **attribution window** earns
the referrer a **payout**. Proposed parameters (product to ratify before build):

| Parameter          | Proposed value                             | Notes                                                                             |
| ------------------ | ------------------------------------------ | --------------------------------------------------------------------------------- |
| Attribution window | **90 days**                                | from referral → conversion; first-touch vs last-touch is an open product decision |
| Payout share       | **25%** of the attributable revenue        | applied to the unlock/placement revenue                                           |
| Payout floor/flat  | **₹500**                                   | confirm whether ₹500 is a floor, a cap, or a flat per-conversion fee              |
| KYC                | **required** before any payout is released | no payout to an un-KYC'd agency                                                   |

## Data it will need (new, additive — design at build time)

- **Referral attribution record:** opaque `referrer_agency_id`, referred subject ref,
  source/channel, timestamp; the conversion link (which `unlock`/placement it maps to).
- **Payout ledger (money OUT — distinct from the credit ledger, which is credits IN):**
  payout amount, status, attributable-revenue basis, `provider_payout_ref`.
- **Agency KYC records (PII — bank/PAN/GST):** a NEW high-sensitivity PII surface; must
  live behind the same encryption + RLS discipline as `workers` (ADR-0004), never in
  events/`ai_jobs`/`audit_logs`/logs.

## KYC / DPDP + real-payout implications (human + legal gated)

- **Real money leaves the platform** → human-gated escalation (CLAUDE.md §7) + the same
  `PAYMENTS_ENABLE_REAL`-style flag/secret-store discipline as inbound payments (TD34).
- **KYC = new sensitive PII** (financial identity) → DPDP consent/purpose, retention, and
  a legal review are prerequisites, not afterthoughts.
- Payout events must keep `real_call` honest and carry **no raw bank/PII** in the payload.

## Dependencies (hard — cannot start before these)

- The **unlock / credit ledger spine** ([ADR-0010](../decisions/0010-contact-unlock-and-reveal.md))
  — referral conversion attaches to an unlock; payout share derives from unlock revenue.
- **Real payments** ([TD34](../registers/tech-debt-register.md)) — payouts presuppose a
  real, signed-off payment provider (you cannot pay out mock money).
- **Per-payer / per-agency identity** ([TD33](../registers/tech-debt-register.md)
  `PayerAuthGuard`) — attribution + payout authz need real agency identity, not the
  interim shared-secret guard.

## UN-DEFER TRIGGER (all must be true before we build)

1. Phase-2 monetization is live: **real inbound payments shipped** (TD34 closed) **and**
   real per-payer/agency identity exists (TD33 closed).
2. Product has **ratified** the attribution model + payout parameters (window/share/floor).
3. **Legal + DPDP sign-off** on agency KYC collection, retention, and payout terms.
4. A human authorizes **real outbound money movement** (CLAUDE.md §7).

## Alpha confirmation

**Alpha ships WITHOUT this.** No referral funnel, no attribution, no payouts, no KYC in
alpha. Cross-links: [ADR-0010](../decisions/0010-contact-unlock-and-reveal.md),
[ADR-0013](../decisions/0013-monetization-and-config-driven-pricing-engine.md),
[future-improvements.md](../registers/future-improvements.md),
[tech-debt TD39](../registers/tech-debt-register.md).

## Note — frontend DEMAND shell shipped (does NOT un-defer this spec)

The agency **DEMAND** shell shipped in `apps/payer-web` (route `(portal)/agency/dashboard`):
an agency (`agent` payer) gets a read-only, faceless dashboard reusing the SHARED payer
DEMAND loop (post/manage vacancies, faceless reach summary, credits). See
[docs/frontend/agency-portal.md](../frontend/agency-portal.md) and
[docs/product/agency-portal-scope.md](../product/agency-portal-scope.md).

**Update (2026-06-22, #127 — ADR-0022 demand-slice BACKEND landed):** the payer-authed
agency BACKEND now exists — a `PayerRoleGuard` + `@PayerRoles('agent')` vertical-authz
gate over a `payer/agency` module with agent-only job CRUD over `jobs.payer_id`, a faceless
invite mint (`POST /invites`, opaque code only), an aggregate-only k-anon `GET /referrals/summary`,
and applicants reusing `/payer/reach/jobs/:jobId/applicants` (new faceless `agency_invites`
table, migration 0024; new PII-free `job.*`/`agency_invite.*` events). So "no payer-authed
agency endpoint exists / agency jobs are mock-only / PayerRoleGuard not built" is no longer
true. **This does NOT un-defer this spec:** #127 builds the additive DEMAND slice only — the
consent-gated attribution seam ships INERT (no caller, [TD48](../registers/tech-debt-register.md)),
and payouts/KYC/attribution-model remain PARKED behind the un-defer triggers below. The
payer-web FRONTEND is HELD pending reconciliation with the parallel agency frontend (#123/#107).

**Payouts and KYC remain fully PARKED.** The demand shell ships **no schema**, **no
financial-PII UI**, no referral funnel, no attribution, no payout ledger/math, and no KYC
form. The dashboard's KYC / Payouts cards are **disabled informational placeholders** gated
on `NEXT_PUBLIC_ENABLE_AGENCY_KYC` / `_PAYOUTS` (both default OFF) — flipping a flag on only
re-labels the card and builds nothing. The legal/product decisions above are unchanged; the
UN-DEFER TRIGGER still governs when this spec may be built.
