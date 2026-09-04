# Decision note — what a credit buys, and whether the résumé stays free

**For:** Prakash (owner). **Date:** 2026-09-05. **SHA:** `f72a7a79`.
**Why this exists:** the E-chain design found the premise inverted. The flow as described has
the résumé **paid and full**; ADR-0013 C.3 has it **free and masked**. That is not a wiring
gap, so it is not a builder's call. **E2 and E3 wait on this.**
**Status: UNSIGNED. No brief has been written to any option below.**

---

## 1. The question you asked first: if the résumé stays free, what does a credit buy?

**An entitlement record, and a handle that nothing can dial.** I checked this twice, because
the answer is worse than I expected and it changes the decision.

### 1a. The chain, as it actually runs

```
POST /payer/unlocks             → debits 1 credit → { ok, unlock_id, status:"granted", expires_at }
POST /payer/unlocks/:id/reveal  → FREE, ≤3 attempts → { relay_handle, channel:"in_app_relay", expires_at }
```

The credit is spent at the **grant**, not the reveal — `debitOneCreditWithinTx`
(`apps/api/src/unlocks/unlocks.service.ts:244`, under the `[3] PAYMENT` comment at `:243`), atomic with the grant, one ledger row with
`reason: "unlock_debit"`. The window is **14 days** (`packages/db/src/credit-packs.ts:101`).
Reveals inside it are free, capped at 3 (`packages/config/src/server.ts:1135`).

### 1b. The `relay_handle` is inert, and the code says so

`wireInAppRelay` (`apps/api/src/unlocks/unlocks.service.ts:873-886`) decrypts the phone,
does **nothing with it**, and returns a fresh random string:

```ts
const phone = this.pii.decrypt(worker.phoneE164);
// In a real in-app relay this would register a server-side relay session keyed to
// `phone`. Alpha: we only need to PROVE the relay can be opened without disclosing
// the number. We deliberately do nothing reversible with `phone`.
void phone.length; // touch the value (relay-open stand-in); do NOT log/return it.
return `relay_${unlockId}_${randomUUID()}`;
```

**Nothing in this repository ever reads that handle back.** Every occurrence of
`relayHandle` / `relay_handle` / `routingToken` across `apps/api/src` and
`apps/payer-web/src` is a write, a type declaration, or a render: it is persisted at
`unlocks.repository.ts:288-300`, returned at `unlocks.service.ts:435`, and displayed as
monospace text at `apps/payer-web/src/components/unlock/routed-contact-card.tsx:36`. There
is no relay-resolution route, no proxy-number provider, and no messaging bridge from a payer
to a worker.

This is deliberate and documented — the docblock says the alpha only needs to prove the relay
*can* be opened. It is not a bug. But it means the honest statement of what a credit buys
today is:

| A credit buys | A credit does **not** buy |
|---|---|
| One `unlocks` row — a durable, audited entitlement | Any way to contact the worker **that works today** |
| A 14-day window and up to 3 reveals | The worker's phone number |
| An opaque string the payer can look at | The worker's name, profile, or résumé |

**And there is a copy problem sitting on top of it.** `routed-contact-card.tsx:30-32` tells
the payer *"Use it in-app to reach the candidate."* Nothing implements that. A paying employer
who follows that instruction finds no way to follow it. **That is worth fixing before a
credit is sold for money, and it is a bigger problem than the résumé question.** It is not in
scope for any E-phase and is not parked anywhere; flagging it here because it surfaced while
answering this one.

### 1c. Which makes the free-résumé asymmetry sharper, not softer

Meanwhile the **masked résumé is free, needs no credit, and needs no unlock at all** — the
request body is `worker_id` + optional `job_posting_id` and carries no `unlock_id`
(`apps/api/src/payer-portal/payer-disclosure.dto.ts:11-14`). payer-web *chooses* to couple
them client-side by requiring an `unlockId` before offering the button
(`apps/payer-web/src/app/(portal)/postings/[id]/applicants/actions.ts:77-90`), but the API
does not require it. A payer calling the API directly gets the résumé without ever spending
a credit.

So today: **the one artifact with real substance that a payer receives is the short-TTL
signed URL to the masked résumé PDF — and it is the one we do not charge for.** The credit
buys the record of a permission whose exercise is not yet built.

---

## 2. What the résumé actually is today

Free, masked, capped, and audited:

- **FREE by signed decision.** `packages/db/src/schema/payer.ts:500-502` — *"Resume download
  is FREE but is a PII DISCLOSURE — it rides the ADR-0010 consent+caps spine."*
- **MASKED to initials.** `apps/api/src/disclosures/resume-disclosure.service.ts:235` —
  `maskInitials(this.pii.decrypt(worker.fullName))`. The real name is read once, server-side,
  at render, and never leaves.
- **Consent-gated and capped, on the same budget as the unlock.** The fail-closed ordering is
  written out at `apps/api/src/disclosures/resume-disclosure.service.ts:53-63`:
  `[1] employer_sharing consent → [1b] deletion freeze → [2] SHARED worker cap → [3] payment
  — REMOVED (free) → [4] grant → [5] controlled disclosure`.
  **Note step [3]** (`:57`). Payment is not missing from this path; it was *taken out*. Option B is
  putting a designed-out step back, not building a new one.
- **The cap is shared with contact reveals** (`:49-50`, `:402`) — one per-worker budget spans
  both streams. So a payer cannot double a worker's exposure by using both surfaces.
- **No bulk route, by design** (`:66`, B-F anti-harvest): one (payer, worker, posting) per call.

---

## 3. The three options

### Option A — status quo. Résumé free and masked; a credit buys the relay handle.

**Changes:** nothing. E2 and E3 proceed as briefed today.
**ADRs amended:** none.
**Cost:** the monetisation gap in §1 stands, and §1b makes it worse than "we charge for the
introduction". We charge for a permission whose exercise is not built, and give away the
artifact that carries the value. A first paying employer who reads résumés and buys two
credits has paid for two rows and two strings.
**Benefit:** it is the only option with zero privacy delta, zero ADR churn, and zero new
surface. It is also the only one that is *free to reverse* — nothing has been sold on it yet.
And it is defensible as a deliberate hold: with the relay unbuilt, repricing anything is
premature.

### Option B — credit-gate the résumé; keep the masking.

**Changes:** restore step `[3] payment` in `ResumeDisclosureService`, on the existing debit
path, inside the existing transaction. The masking, the consent gate, the shared cap and the
neutral no-oracle body are all untouched.
**ADRs amended:** **ADR-0013 C.3** only — the clause that makes the download free. ADR-0010 is
untouched; this *extends* its credit spine rather than changing it.
**Cost, and it is a real one:** the shared cap means résumé and contact now compete for the
same per-worker budget, so a payer who spends credits reading résumés has fewer reveals left
on that worker. Pricing has to decide whether a résumé costs the same as a contact — they are
not obviously worth the same. Also: it makes the platform less useful before a payer has paid,
which is exactly the surface that converts a trial into a customer.
**Benefit:** the thing we charge for becomes the thing that carries the value. It is a
one-clause amendment with no privacy delta at all — the résumé a payer buys is the same
masked artifact they can read free today.
**Reversibility:** moderate. Making a paid thing free again is easy; the credits already spent
are the awkward part.

### Option C — a credit unlocks a full, unmasked profile plus the résumé.

This is the flow as described, and it is a different class of change from A and B.

**Changes:** a full-profile view that **does not exist anywhere** — no route, no DTO, no page —
plus removing the masking at `resume-disclosure.service.ts:235`, plus every guard that
currently makes a real name reaching a payer a compile error or a test failure.
**ADRs amended:** **ADR-0013 C.3** (free → paid) **and ADR-0010** (a credit's scope changes
from routed contact to identity) **and** a new decision recording raw-PII egress to a payer.
**Privacy — what §2 unmasking actually entails.** This is the part that must not be
underestimated:

- The masking is not a formatting step. The pipeline builds the résumé from a **name-free
  snapshot** and injects `displayName = maskInitials(realName)` at render
  (`resume-disclosure.service.ts:59-61`, `:235`). Unmasking means the real name enters an
  artifact that is then **uploaded to storage and served by a signed URL**. Today that URL
  points at bytes that contain no identity; under Option C it points at bytes that do.
  A short TTL bounds who can fetch it, not what it says.
- CLAUDE.md invariant 2 forbids raw PII in prompts, logs, events, audit records and analytics.
  The résumé path is already careful here — `resume.disclosed` carries *"the FACT only (ids +
  opaque `resume_ref`); NEVER the bytes, the name, or the signed URL"* (`:63-64`, and again at
  the emit site, `:369`). Unmasking
  does not change the event, but it does mean the object the event points at is now PII at
  rest, with its own retention and DSAR consequences.
- **There is a precedent for returning a real name, and it excludes this by its own terms.**
  `GET /workers/me/resume-fields` does decrypt and return `full_name`
  (`apps/api/src/workers/workers.service.ts:176-190`, `:198`) — but read the ruling it cites:
  *"a self-read of one's own name is not a cross-actor leak (§2 ruling recorded 2026-07-14,
  TD21) … returned to the owner over TLS only; it never enters an event, log, `ai_jobs`, or
  LLM input."* The property that made it safe is that the reader IS the subject. Option C is a
  **cross-actor** read, **persisted into an artifact**, and **served from storage** — it fails
  all three of the conditions that precedent rests on. Citing it as cover would be misreading
  it, and someone will try.
- It needs a `security-engineer` gate before merge, not after.

**Cost:** the largest build of the three, the only one with a real privacy delta, and the only
one that is **effectively irreversible** — once payers have seen names, taking that back is a
product regression they will feel. It also changes what we are able to promise workers, which
is a consent-copy question, not only an engineering one.
**Benefit:** it is the only option that matches the flow as you described it, and a payer who
can see a name before spending is a payer who wastes fewer credits.

---

## 4. Two things worth separating before you rule

**The price and the masking are independent.** Option B changes what a résumé costs and
changes nothing about privacy. Option C changes both at once. If the goal is to monetise the
evaluation, B does it; if the goal is to let a payer see *who* before they spend, only C does,
and that is a separate ask that happens to be bundled with it in the described flow.

**The relay comes first, whatever you rule.** §1b says the thing a credit buys does not
function. Whichever option you pick, pricing a résumé or a profile against a credit whose
existing benefit is inert is deciding the price of a bundle whose other half is missing. If
only one thing is built next, it should be the relay — not because the résumé question is
unimportant, but because it cannot be answered well until a credit is worth something.

**A fourth shape exists, and it is not recommended — stated so it is visibly considered
rather than missed.** Keep the résumé free, and make the *unlock* reveal the name alongside
the relay handle. It monetises identity without a new view, but it is Option C's privacy delta
with none of Option B's revenue, and it breaks `ContactRevealedResponse`'s stated contract
(`unlock-response.ts:52-57`) — the one place the codebase promises a payer gets a handle and
not an identity.

---

## 5. What each answer does to the briefs

| Ruling | Consequence |
|---|---|
| **A** | Nothing changes. E3 already briefed to the shipped meaning; E2 unblocked. |
| **B** | `E3_BUILD.md`'s THE CREDIT QUESTION resolves; add one build item (restore step [3]); ADR-0013 gets an amendment note. Pricing needs a résumé price. |
| **C** | E3 grows a full-profile view and stops being a re-point; a new ADR is needed; a security review gates it; the worker consent copy is revisited. **E3 becomes the largest phase in the chain, not the smallest.** |

---

```
Signed (CEO / Prakash): .......................  Date: .................
```
