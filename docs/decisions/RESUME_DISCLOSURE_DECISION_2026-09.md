# Decision note — what a credit buys, and whether the résumé stays free

**For:** Prakash (owner). **Date:** 2026-09-05. **SHA:** `f72a7a79`.
**Why this exists:** the E-chain design found the premise inverted. The flow as described has
the résumé **paid and full**; ADR-0013 C.3 has it **free and masked**. That is not a wiring
gap, so it is not a builder's call. **E2 and E3 wait on this.**
**Status: UNSIGNED. No brief has been written to any option below.**

---

## 1. The question you asked first: if the résumé stays free, what does a credit buy?

**A `relay_handle`.** That is the artifact, and it is the whole of it.

```
POST /payer/unlocks              → { ok: true, unlock_id, status: "granted", expires_at }
POST /payer/unlocks/:id/reveal   → { relay_handle, channel: "in_app_relay", expires_at }
```

`apps/api/src/unlocks/unlock-response.ts:52-57` types it and names it in its own words:
*"an opaque, non-reversible, expiring relay handle ONLY."* It is minted at
`apps/api/src/unlocks/unlocks.service.ts:435-438`, where the comment on the field reads
`// opaque, non-reversible, expiring — NOT a phone`.

So, precisely:

| A credit buys | A credit does **not** buy |
|---|---|
| One `unlock` grant per (payer, worker), idempotent | The worker's phone number |
| A routed in-app relay channel to that worker | The worker's name |
| A 14-day access window (`expires_at`) | The worker's profile |
| A bounded number of reveal attempts | The résumé |

**Read plainly: a credit buys the ability to start a conversation, for fourteen days,
without learning who you are talking to.** The name and the phone stay server-side; the raw
phone is decrypted at exactly one point, transiently, to wire the relay, and is never
returned, evented, logged or stored.

The résumé sits on a different spine entirely. `POST /payer/resume-disclosures` takes a
`worker_id` directly (`apps/api/src/payer-portal/payer-disclosure.controller.ts:52`) — **it
does not require an unlock at all**, and it costs nothing.

**The gap that follows, and it is the real argument for changing something.** A payer today
can read a candidate's masked résumé — the work history, the skills, the trade sheet — for
free, and pay only when they want to *talk*. The résumé is the thing that carries the
information a hiring decision is made on. We are giving away the evaluation and charging for
the introduction.

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
**Cost:** the monetisation gap in §1 stands — we charge for the introduction and give away the
evaluation. If the first paying employer reads résumés, shortlists, and contacts two people,
we have sold two credits for a service that did most of its work for free.
**Benefit:** it is the only option with zero privacy delta, zero ADR churn, and zero new
surface. It is also the only one that is *free to reverse* — nothing has been sold on it yet.

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
