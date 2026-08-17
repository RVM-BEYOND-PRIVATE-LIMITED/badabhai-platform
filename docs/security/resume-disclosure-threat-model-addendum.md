# PII-Disclosure Threat Model — Resume Download (ADR-0013 Decision C) — ADDENDUM

> **Addendum to** [contact-unlock-threat-model.md](contact-unlock-threat-model.md). That
> model covers a *routed contact*; this covers **handing a payer a worker's RESUME
> DOCUMENT** — a **strictly larger** disclosure (name + full work history in one artifact).
> Required as the **hard pre-build gate** for the resume-disclosure stream (ADR-0013 C-R3 /
> R-1). The base model's methodology, assets, trust boundaries, non-tradeable invariants,
> and F-1…F-7 controls apply **verbatim** unless overridden here.

## DECISION (2026-06-16) — employer-facing resume is IDENTITY-MASKED

Two consumers, two views:

- **Worker's own copy** (worker-app `ResumePreview` / the worker's own export) keeps the
  worker's **real name** — TD21 stays, unchanged. This is the worker's own resume.
- **Employer-facing disclosure** (the new stream) is **identity-MASKED**: the name is
  reduced to **masked initials** (`Ramesh Kumar → "R***** K."`) and **no phone** appears
  (phone is already never on the resume; the contact channel is the **separate paid
  Contact-Unlock** step). The employer evaluates the trade profile **anonymously**; identity
  is revealed only by paying for the unlock — so the FREE masked resume *protects*, not
  undercuts, the unlock's value.

**Implementation seam:** the masked employer resume is rendered from the **name-free**
`sourceProfileSnapshot` (already stored, no PII) with `displayName = maskInitials(realName)`
computed **server-side at disclosure time** (reuse `ResumeRenderer`). The real name is read
once to derive the masked string, **never logged, never evented** (F-5 holds). Masked
initials are still personal data under DPDP (a partial-name fragment) — accepted by product
decision; do not expand the mask without a fresh consent tier + a threat-model revision.

This **reverses §0 delta #1 below** (the disclosed asset is no longer the real name) and
**resolves RT4 by construction**. Net effect: the employer disclosure is a trade-profile +
masked-initials artifact — far smaller blast radius than the base model assumed.

## 0. What's different from Contact Unlock (the deltas this addendum exists for)

1. ~~**Bigger disclosed asset.** A resume carries the worker's **real name (TD21)** plus full
   work history / trade detail — far more identifying than a single routed channel.~~
   **REVERSED by the 2026-06-16 decision above:** the employer-facing resume is
   **identity-masked** (masked initials, no phone), so the disclosed asset is a trade profile
   plus a masked-initials fragment — *smaller* than a routed contact channel, not larger. The
   real name stays on the worker's OWN copy only.
2. **It is FREE (ADR-0013 §SIGN-OFF C).** There is **no payment step** — so payment is *not*
   a throttle. **Caps + no-oracle + no-bulk become the PRIMARY anti-harvest controls**, not
   secondary. This is the single most important consequence: remove the money friction and
   the scrape-value of the endpoint goes up, so the volume controls must be stronger, not
   weaker.
3. **The artifact already exists** in `generated_resumes` (private bucket, TD24/ADR-0007,
   signed-URL only). This stream adds a **grant + a disclosure chokepoint**, not new storage.

Everything else — the `employer_sharing` consent gate, the per-worker caps, the fail-closed
ordering, the PII-free events, the no-oracle rule, the service-role/RLS posture — is **reused
unchanged** from the base model.

## 1. Adapted disclosure ordering (base model §Decision-ordering, payment removed)

```
payer authz (InternalServiceGuard interim; PayerAuthGuard = launch gate, base T7)
        ↓ fail closed
[0] BALANCE PRECHECK — N/A (FREE). The endpoint is gated on consent + caps only; there is no
        credit precheck, so the F-1 "no consent oracle before a cheap check" concern is met by
        making the FIRST observable step worker-INDEPENDENT (a uniform neutral response shape).
        ↓
[1] DISCLOSURE CONSENT — worker has an active, unrevoked `employer_sharing` consent?
        ↓ fail closed → neutral "unavailable" (no oracle; base T2/T4)
[2] WORKER-PROTECTION CAPS — within the per-worker disclosure cap for the window? (atomic
        check-and-write at the single chokepoint; base T5/F-2). SHARED ceiling with unlock
        (C-R2): one "PII disclosed to payers" budget so a worker can't be harvested past the
        ceiling by splitting across SKUs.
        ↓ fail closed → neutral "unavailable"
[3] PAYMENT — REMOVED (free). No debit, no ledger entry.
        ↓
[4] GRANT — record `resume_disclosures` (status granted→disclosed; idempotent per
        payer,worker,posting).
        ↓
[5] CONTROLLED DISCLOSURE — render the MASKED employer resume from the name-free
        `sourceProfileSnapshot` with `displayName = maskInitials(realName)` (per the
        2026-06-16 decision), then serve via a SHORT-TTL signed URL minted server-side (reuse
        TD24/R13 discipline): non-reversible, expiring, single-grant-scoped, never logged,
        never in an event. The real name is read ONCE only to derive the masked initials,
        server-side; the full name never lands on the employer artifact, a log, or an event.
        ↓
emit resume.disclosed — the FACT ONLY (disclosure_id, payer_id, worker_id, job_posting_id?,
        resume_ref). NEVER the bytes, the name, or the signed URL (base F-5).
```

## 2. Resume-specific threats (deltas; base T1–T10 otherwise apply)

### RT1 — Bulk harvest / scrape (THE headline risk now that it's free)
A payer iterates the candidates page and downloads every resume → mass PII exfiltration with
no payment friction. **Controls (mandated):** (a) the **shared per-worker disclosure cap**
(base F-2) bounds how often any one worker is disclosed; (b) **no bulk/list export** — one
disclosure per request, behind the chokepoint (base non-tradeable; ADR-0013 EXPLICITLY-OUT);
(c) **no-oracle** candidates page — the ADR-0011 faceless feed must not reveal that a worker
exists/consented before a disclosure (base T2; F-1/F-3 neutral constructor); (d) **per-payer
rate cap** on the disclosure endpoint (reuse the IP/worker rate-limit discipline, TD24/TD25).
A future real `PayerAuthGuard` (LC-1) makes per-payer caps enforceable against a real identity.

### RT2 — The downloaded document is outside our erasure reach (DPDP)
Once a resume PDF is on a payer's device it cannot be recalled. **Control:** this is largely a
**legal/contractual** control (DPA + the `employer_sharing` notice must state the payer's
obligations), tracked as a launch gate (base LC-2/LC-3, extended). Technically: keep the
signed-URL TTL short (no durable hosted copy), disclose the **minimum** authorized by consent,
and record every disclosure (`resume.disclosed` + `resume_disclosures`) so the DPDP audit can
answer *who received what*.

### RT3 — Consent scope confusion (does applying imply employer_sharing?)
Swipe-to-apply records an `application`, NOT `employer_sharing` consent. **Decision (fail-closed
default): NO — applying does NOT authorize a resume disclosure.** A separate, explicit
`employer_sharing` consent is required, exactly as for Contact Unlock (base T4). Revisiting this
(treating an application as scoped consent for *that* employer) is a **product + legal call**,
not an engineering default — flagged as an open question, default stays gated.

### RT4 — Over-disclosure (the doc carries more than consent authorized) — RESOLVED BY MASKING
**Resolved by the 2026-06-16 decision:** the employer artifact is rendered from the name-free
`sourceProfileSnapshot` with only **masked initials** for identity and **no phone** — so it
cannot carry the real name or contact even by accident. The full name is never bound into the
employer document. The addendum **forbids** adding the real name, raw phone, or address to the
**employer-facing** artifact without a fresh consent tier + a threat-model revision. (RT1's
scrape value drops accordingly: there is effectively no PII on the masked resume to harvest.)

### RT5 — Disclosure link as an oracle / reuse / replay
The signed URL must be **non-reversible, expiring, single-grant-scoped, and never logged**
(reuse base T3 for the routing handle, applied to the download link). A revoked/expired grant
must not serve; re-requesting after revoke is denied neutrally (base T4-a revoke-vs-disclose
residual window — kept to one short TTL).

## 3. Controls reused verbatim from the base model (must hold here too)
- **F-1** balance precheck = no consent oracle → adapted: the first observable step is
  worker-independent (uniform neutral response), since there is no balance step.
- **F-2** atomic per-worker caps at the single chokepoint (the SHARED disclosure ceiling).
- **F-3** one neutral-response constructor (no-oracle: consent/cap/unknown-worker all look
  identical to the payer; `deny_reason` is INTERNAL-only, CHECK-gated on the row).
- **F-5** PII touched at exactly one step (compose the doc), never logged/evented.
- **F-7** payer-auth launch gate (PayerAuthGuard) before any client-facing payer surface.
- All base **non-tradeable invariants** (§5): no raw PII in events/logs; no bulk export; no
  oracle; fail-closed.

## 4. Residuals (acceptable for build, tracked) + conditions

**Residuals (documented):**
- RR-A (payer auth): alpha rides `InternalServiceGuard`; ops can act as any `payer_id`.
  Contained: no client-facing payer surface ships; per-payer caps are best-effort until LC-1.
- RR-B (RLS not finalized): `resume_disclosures` rides the service role (R1/TD4/TD20); it is
  RLS+REVOKE-locked at the DB and joins the no-drift spine (migration 0016).
- RR-C (erasure of a delivered doc): irreducible technically; a legal/contractual control (RT2).

**MUST hold at BUILD (mandated + tested):**
- B-A: `employer_sharing` consent gate precedes disclosure; fail-closed; neutral on absence.
- B-B: shared per-worker disclosure cap, atomic at the single chokepoint; no second writer.
- B-C: one neutral response (no oracle); `deny_reason` never returned.
- B-D: signed-URL discipline — short TTL, server-minted, never logged, never evented.
- B-E: `resume.disclosed` carries the FACT only (no bytes/name/link); PII-free test asserts it.
- B-F: no bulk/list disclosure endpoint exists.
- B-G: the employer artifact is **identity-masked** — rendered from `sourceProfileSnapshot`
  with masked initials, **no full name, no phone**; the real name is read once to derive the
  mask and never logged/evented/bound into the document (2026-06-16 decision). Tested: a
  golden render asserts the full name does NOT appear and the masked form DOES.

**MUST clear at LAUNCH (human-gated):**
- LC-A: `PayerAuthGuard` + horizontal-authz test (base LC-1) before a real payer surface.
- LC-B: production DPDP `employer_sharing` notice + **payer DPA** covering a delivered resume
  (RT2; base LC-2/LC-3) — HUMAN/legal.
- LC-C: per-payer rate limiting tuned for the free endpoint (RT1) before a real payer surface.
- LC-D: resolve RT3 (does an application scope consent?) as a product+legal decision.

## 5. Verdict

With the controls in §1–§3 **mandated and tested**, the resume-disclosure stream may be built
in alpha as a **FREE, consented, capped, no-oracle, fact-only, identity-MASKED** disclosure
reusing the Contact-Unlock spine. The 2026-06-16 decision makes the employer artifact carry
**masked initials + no phone** (real name only on the worker's own copy), which *shrinks* the
disclosed asset and resolves RT4; **caps + no-oracle + no-bulk + masking (B-G)** are the
load-bearing controls and are non-tradeable here. Putting the real name/phone on the
**employer** artifact and any real payer surface remain human-gated (LC-A…LC-D). **This
addendum is the C-R3 pre-build gate; a `bb-security-review` PASS against the built endpoint is
required before merge.**
