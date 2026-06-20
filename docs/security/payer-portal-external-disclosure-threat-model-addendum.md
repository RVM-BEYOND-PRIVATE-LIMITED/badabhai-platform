# PII-Disclosure Threat Model — Self-serve Payer Portal (ADR-0019 Decision E) — ADDENDUM

> **Addendum to** [contact-unlock-threat-model.md](contact-unlock-threat-model.md) **and**
> [resume-disclosure-threat-model-addendum.md](resume-disclosure-threat-model-addendum.md).
> Those model disclosure to a **trusted ops actor** (via `InternalServiceGuard`). This re-runs
> the model for the **new actor self-serve introduces: an untrusted, authenticated, possibly
> ADVERSARIAL external payer.** Required as the **hard pre-build gate** for any external
> disclosure surface (ADR-0019 Decision E / E-R1). The base models' methodology, assets, trust
> boundaries, non-tradeable invariants, and F-1…F-7 controls apply **verbatim** unless
> overridden here. **Design-level — a `bb-security-review` PASS against the built surface is
> still required before merge.**

> **BUILD STATUS (2026-06-20, ADR-0019 Phase 1, PR `feat/r16-lc1-payer-auth-close`) — XB-A…XB-H
> SATISFIED + TESTED on the realized surface; `bb-security-review` PASS.** The CANONICAL `/unlocks`
> + `/payers/:payerId/credits` surface ([`apps/api/src/unlocks/unlocks.controller.ts`](../../apps/api/src/unlocks/unlocks.controller.ts))
> is now behind **`PayerAuthGuard`**, replacing the **`InternalServiceGuard` interim seam** (which
> trusted a body/param `payer_id` under a shared secret — "payer owns the row" was unenforceable
> there, the very gap §2/XT3/XB-A close). `payer_id` is the verified session; `assertPayerOwns`
> blocks cross-payer credit purchase/read (XB-A); reveal/`getOwn` are no-oracle; the per-payer
> **XB-G** cap runs before the chokepoint. The interim parallel **`/payer/unlocks` controller was
> RETIRED** — one self-serve disclosure surface, no body `payer_id` anywhere. Horizontal-authz is
> a build-blocker test ([`unlocks.controller.test.ts`](../../apps/api/src/unlocks/unlocks.controller.test.ts)).
> Still **MOCK + STAGING-ONLY** (`PAYMENTS_ENABLE_REAL=false`); XL-A…XL-E (DB-RLS / DPDP-DPA /
> real-payment controls / pen test / abuse monitoring) remain the human-gated open-GA bar.

## 0. The actor change — why this addendum exists

| | Ops-run (today) | Self-serve (ADR-0019) |
|---|---|---|
| **Actor** | trusted ops user, `InternalServiceGuard` (shared secret) | **untrusted external payer**, `PayerAuthGuard` (own account) |
| **Identity** | none — `payer_id` is opaque; ops can act as any payer (RR-A) | **real per-payer identity** — actions bound to one `payer_id` |
| **Intent** | assumed benign | **assume adversarial** (scrape, farm, fraud, lateral access) |
| **Surface** | internal origin, no external auth | **public origin, external auth, self-serve payments** |

The disclosure *mechanics* (consent → caps → grant → masked reveal, no-oracle, no-bulk) are
**unchanged and reused**. What changes is the **threat actor**: every control must now hold
against someone actively trying to break it.

## 1. Reused unchanged (must hold against an attacker)
- **routed-not-raw** — contact reveal stays a routed channel; raw phone never disclosed (base
  T?, LC-6 default never-in-alpha).
- **masked employer resume** — masked initials, **no phone**, rendered from the name-free
  `sourceProfileSnapshot`; real name read once server-side, never logged/evented (resume
  addendum B-G). **An external payer sees the same masked artifact as ops.**
- **`employer_sharing` consent gate** precedes any disclosure; fail-closed; neutral on absence.
- **shared per-worker disclosure cap** — atomic, single chokepoint; one "PII disclosed to
  payers" budget across unlock + resume so a worker can't be harvested by splitting SKUs.
- **no-oracle** — consent/cap/unknown-worker are indistinguishable to the payer; `deny_reason`
  INTERNAL-only.
- **no bulk / list export** — one disclosure per request, behind the chokepoint.
- **PII-free events** — `unlock.*`/`contact.*`/`resume.disclosed`/`payment.*` carry the FACT +
  opaque ids only; never bytes/name/link/payer-PII.

## 2. New threats (the deltas this addendum exists for)

### XT1 — Authenticated scrape / mass harvest
A *real* payer account iterates the faceless candidates page (ADR-0011) and requests a
disclosure for every worker. **Controls:** (a) **shared per-worker cap** (payer-independent) —
the load-bearing backstop; (b) **no-bulk** (one at a time); (c) **no-oracle** candidates page
(faceless feed leaks no existence/consent before disclosure); (d) **per-payer rate cap** on the
disclosure endpoint — **now enforceable against a real identity** (`PayerAuthGuard`), closing
base RR-A for the external surface. **MUST hold + tested.**

### XT2 — Account farming (the new structural threat)
An attacker creates many payer accounts to multiply **per-payer** caps/rate-limits and defeat
per-payer throttling. **Controls:** (a) the **per-WORKER shared cap is payer-count-independent**
— it bounds total disclosure of any one worker no matter how many payer accounts exist (the
structural backstop); (b) **onboarding friction** — payment-method / KYC-lite binding raises the
cost of spinning up accounts; (c) abuse monitoring on disclosure velocity. **The per-worker cap
is non-tradeable precisely because per-payer controls are farmable.**

### XT3 — Horizontal authorization (tenant crossing)
Payer A tries to read/act on payer B's jobs/credits/unlocks/disclosures, or to disclose under
B's `payer_id`. **Controls:** ADR-0019 Decision C (app-layer tenant chokepoint now; **DB RLS at
launch**) + `PayerAuthGuard` binding every action to the caller's own `payer_id`. **Build-blocker
test:** payer A ↔ payer B horizontal-authz (base LC-A / ADR-0010 F-7) across **every** payer
endpoint, including the disclosure path.

### XT4 — External auth attack surface (new)
Credential stuffing, session theft, account takeover, password reset abuse — classes the
internal ops console never faced. **Controls:** standard auth hardening on the chosen provider
(ADR-0019 B-R1) — rate-limited login, secure session/cookie flags, MFA-capable, no user
enumeration on login/reset (a no-oracle analogue for accounts). A taken-over payer account is
still bounded by the per-worker cap (XT2 backstop) and discloses only masked artifacts.

### XT5 — Payment fraud / webhook spoofing (new, self-serve real money)
A client forges a "payment success" or posts a fake capture webhook to mint credits.
**Controls (ADR-0019 Decision D):** capture confirmed only by a **signature-verified** webhook
(never a client callback); **server-side amount** (pricing engine, never client-supplied);
**idempotent** capture/grant; reconciliation job. Stolen-card/chargeback abuse → the
consumer-protection posture (D-R1) + Razorpay risk tooling. **No real-money code until the human
gate (E-R2).**

### XT6 — Disclosure link as oracle / reuse / replay (reaffirmed for external)
The masked-resume signed URL stays **non-reversible, expiring, single-grant-scoped, never
logged** (resume addendum RT5 / base T3). A revoked/expired grant must not serve; re-request
after revoke is denied neutrally. An external attacker gets no extra power here — reaffirmed.

## 3. Residuals (acceptable for staged build, tracked) + conditions

**Residuals (documented):**
- XR-A — **RLS staging:** until DB-enforced RLS lands (ADR-0019 C launch gate), tenant isolation
  is the **app-layer chokepoint** — acceptable for **closed beta only**, never open external GA.
- XR-B — **erasure of a delivered (masked) doc:** irreducible technically; legal/contractual
  (base RT2 / LC-3) — smaller now (masked initials, no phone).
- XR-C — **account-farming residual:** per-payer controls are farmable; the per-worker cap is the
  backstop; onboarding friction (XT2-b) reduces but doesn't eliminate it — accepted + monitored.

**MUST hold at BUILD (mandated + tested):**
- XB-A — `PayerAuthGuard` binds every payer action to the caller's own `payer_id`; horizontal-authz
  test (payer A ↔ B) across **all** payer endpoints incl. disclosure (XT3).
- XB-B — shared per-worker disclosure cap, atomic at the single chokepoint, **payer-independent**
  (XT1/XT2 backstop); no second writer.
- XB-C — one neutral response (no-oracle) on the candidates page and the disclosure endpoint;
  `deny_reason` never returned (XT1).
- XB-D — no bulk/list disclosure endpoint exists (XT1).
- XB-E — masked employer artifact only (initials, no phone, no full name); golden render test
  (resume addendum B-G).
- XB-F — disclosure events carry the FACT only; PII-free test (no bytes/name/link/payer-PII).
- XB-G — per-payer rate cap on the disclosure endpoint (XT1), enforced against the real identity.
- XB-H — auth hardening: no user-enumeration oracle on login/reset; rate-limited; secure session
  (XT4).

**MUST clear at LAUNCH (human-gated, open external GA):**
- XL-A — **DB-enforced RLS** for payer-owned tables (ADR-0019 C / coordinate ADR-0004 / Q5) — the
  hard upgrade external access forces; closes XR-A.
- XL-B — production DPDP `employer_sharing` notice + **payer DPA** covering a delivered (masked)
  artifact (base LC-2/LC-3).
- XL-C — real-payment controls (signed webhook, server-side amount, idempotency, reconciliation)
  reviewed + a human gate on keys/spend (XT5 / E-R2).
- XL-D — pen test of the external auth + tenancy + disclosure surface.
- XL-E — abuse/velocity monitoring + account-farming posture (XT2) operational.

## 4. Verdict

With §1's reused controls **and** §2's new controls (XB-A…XB-H) **mandated and tested**, the
self-serve disclosure surface may be built and exercised in **closed beta** (app-layer tenancy,
mock payments). The actor change from trusted-ops to adversarial-external is absorbed because the
**load-bearing controls are actor-independent**: the masked artifact, the **per-worker shared
cap**, no-oracle, and no-bulk bound the disclosure regardless of who the payer is or how many
accounts they hold. **Open external GA and any real money remain human-gated** (XL-A…XL-E). This
addendum is the **ADR-0019 E-R1 pre-build gate**; a `bb-security-review` PASS against the built
external surface is required before merge.
