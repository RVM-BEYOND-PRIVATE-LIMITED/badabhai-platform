# E0 — the three questions that decide whether the relay is worth building

STATUS: **ALL THREE RULED — owner, 2026-09-05.** Each ruling is recorded at the head of its
own section, and each recommendation was accepted. Written 2026-09-05 for PR #1427; nothing
here is built. Item 0 (the false payer copy) went out as issue #1430 ahead of every ruling.

The rulings, in one place:
  **A** — `employer_sharing` authorises DISCLOSURE only. A ninth purpose is minted for
  messaging, NOW, in the notice copy E4 is already writing.
  **B** — templates for the payer's opening message, free text once the worker has replied.
  Intent stays unsolved and the ruling does not pretend otherwise.
  **C** — the three additions are CONDITIONS OF SHIPPING E0, not nice-to-haves. Any one of
  them proving harder than scoped is a HALT, not a trim.
  **Sequence, corrected by C:** #1425 → E0 → E4 → E1 → E2, then P9. E3 is built.

Every measurement below is against `origin/main` at `f72a7a79`. R-E4 applies: the workers on
the live database are testers, `employer_sharing` is requested by no client, and no worker has
ever received a relayed message. Nothing here has been proven against real supply.

---

## A. Does `employer_sharing` authorise MESSAGING, or only DISCLOSURE?

> **RULED 2026-09-05 — disclosure only; mint the ninth purpose NOW.** The recommendation
> below argued the opposite conclusion from the same evidence, and the owner ruled against it
> on the cost asymmetry: *"This is the `model_training` decision made deliberately a second
> time, and the cost asymmetry is not close."* The reasoning about the enum's house rule is
> preserved by ruling, because it is what a later session would otherwise re-derive. Proposed
> string: `employer_messaging`; the owner confirms the name. Minting it is an owner act
> (`docs/agent/BUILD_RULES.md:28`) and the array holds NINE members afterwards.

**Reading 1 — disclosure only.** The enum docblock says it "gates whether a worker's routed
contact may be **disclosed** to a paying party" (`packages/types/src/index.ts:26-31`).
Disclosure is one act; a conversation is another. On the text as written, this is the better
reading.

**Reading 2 — the routed contact includes the channel.** A routed contact exists only to be
contacted through. A worker told "a paying employer may be given a way to reach you" has been
told the thing that happens next.

### The precedent the narrow reading leans on does not support it

I framed this last turn as "`whatsapp_messaging` exists because messaging over a third party
needed its own basis," and let it point at Reading 1. Read closely, that is not what its
docblock says. It says: "**the worker's phone leaves to a third party (Meta)**, so this is
DISTINCT from transactional `communication`" (`packages/types/src/index.ts:33-39`). The
trigger is EGRESS, not messaging. Every split in this enum follows that rule —
`voice_processing` because the clip goes to Sarvam (`:56-63`), `agent_activity_visibility`
because a person the worker did not hire can watch him (`:40-55`).

The in-app relay has no third party and no egress. Nothing leaves. On the house rule that
actually governs this enum, it does not earn a split.

### What a ninth purpose costs — and why the usual answer inverts here

The gate is `purposes.includes("employer_sharing")` over the worker's LATEST unrevoked row
(`apps/api/src/unlocks/unlocks.service.ts:805-813`). A purpose absent from that array fails
closed, so a ninth purpose means every existing worker submits a new consent row. That is a
re-consent of the entire base — the `model_training` lesson, taken deliberately on day one
("adding it later would require re-consenting every existing worker", `:23-24`). Adding to
`consent.purposes[]` is also a NEVER-DO for any agent (`docs/agent/BUILD_RULES.md:28`): owner
act, full stop.

**But that cost is already sunk and un-run.** The worker app requests exactly three purposes
today — `profiling`, `resume_generation`, `voice_processing`
(`apps/worker-app/lib/features/consent/presentation/cubit/consent_cubit.dart:52-56`).
`employer_sharing` is not among them. **No worker on this platform has it.** Every worker must
be re-consented before candidate search returns a single row, and E4 is already blocked on
exactly that (the DPDP notice copy plus the `CURRENT_CONSENT_VERSION` bump, `E4_BUILD.md`
items 6-7).

So the real question is not whether a ninth purpose costs a re-consent. It is **whether the
answer lands in the notice that is being written anyway, or in a second one later.**

  - Decided now: one more sentence in copy that does not yet exist. Marginal cost ~zero.
  - Decided after E4's notice ships: a full second re-consent pass over a base that has by
    then opted in once. This is the `model_training` mistake, made on purpose the first time
    and by accident the second.

**THE WINDOW IS OPEN AND E4 CLOSES IT.** That is this decision's deadline, and it is the only
hard scheduling fact in this document.

### Recommendation (mine; the owner rules)

**Reading 2, conditional on the notice text.** Do not add a ninth purpose. Write the
`employer_sharing` notice sentence so it covers the channel explicitly — *a paying employer may
be given a routed way to contact you, may send you messages through it, and you can turn this
off* — and the eighth purpose authorises the channel because the worker was actually told it
does. Purpose limitation is set by the notice; this is the cheap half of the decision.

The failure mode to avoid is silent breadth: if the copy says only "your contact details may be
shared with employers" and the product then delivers a message thread, every consent row
records a claim about what the worker read that is false. That is precisely the defect
`CURRENT_CONSENT_VERSION`'s docblock refuses to commit (`packages/types/src/index.ts:79-95`).

If the owner prefers a ninth purpose for legal clarity, that is defensible — but it must be
decided **before** E4's notice ships, not after.

---

## B. The free-text leak

> **RULED 2026-09-05 — (c) for the payer's first message, (a) after the worker replies**, as
> recommended, with both framing corrections carried into `E0_BUILD.md`. The owner attached a
> condition to the record: **intent remains unsolved, and no shape constraint addresses it.**
> A later session must not read this ruling as closing both halves. `E0_BUILD.md` says so at
> the point of use.

The property is: the payer never learns the worker's phone number. A free-text channel defeats
it in one message — the payer types "send me your number", the worker types it back. No schema,
guard, or event can prevent that, because both parties are legitimate and the text is the
product. Two things to fix in the framing before the options:

**Direction is asymmetric.** The property protects the WORKER's number. A payer volunteering
their own ("call me on 98765…") bypasses the relay without breaking anything the worker was
promised. A filter that treats both directions alike blocks the benign half and reads as broken.

**Shape is largely solved; intent is not.** `_PHONE_RE` (`apps/ai-service/app/pseudonymize.py:243`)
handles digit runs including Devanagari numerals, and `apps/ai-service/app/spoken_digits.py`
handles "nau aath saat". Neither touches "mera number profile pe hai", "WhatsApp pe naam se
search karo", or 98765 in one message and 43210 in the next.

### (a) Free text, and accept out-of-band exchange happens

  - **Product:** costs nothing. Highest-usability channel of the three.
  - **Privacy:** the no-disclosure property becomes a DEFAULT, not a guarantee. That changes
    what the worker's notice may promise — cheap to say honestly now, expensive to retrofit.
  - **Second order:** conversations move off-platform, so the platform stops observing the
    outcome it is trying to sell.

### (b) Free text with an outbound number scan

  - **Product — the underestimated cost.** The false-positive surface is the product's own
    vocabulary: "8 saal", "12 logon ki team", "5 lakh", a pincode, "VMC 850", a UAN. The
    spoken-digit redactor already carries this scar in its docstring — it refuses to fire on
    one- or two-word digit runs because "do saal" and "char logon ki team" are ordinary speech,
    and a redactor that fired on them "would destroy exactly the answers this form exists to
    capture while looking like a privacy win."
  - **Privacy:** catches shape, never intent — so it ships the *appearance* of a guarantee. The
    notice can now be written to promise something the filter does not deliver, which is
    strictly worse than (a)'s honest default. Measured precedent: the name-gazetteer approach
    died at 487 probes / 348 leaks (`docs/ai/pseudonymization.md:87`).
  - **Build:** the working implementation lives in `apps/ai-service` — DO-NOT-TOUCH for this
    chain, and an HTTP hop away. Either re-implement in TS (a second, diverging copy of a
    privacy filter) or put a synchronous ai-service call in the send path, failing CLOSED, so
    an ai-service blip stops messaging entirely.

### (c) Structured templates only

  - **Privacy:** complete and provable. The body holds a template id plus a closed parameter
    set, so a leak is a compile error rather than a review miss — the same technique the reveal
    cards already use (`apps/payer-web/src/components/unlock/routed-contact-card.tsx:8-11`).
  - **Product — the deciding cost.** The payer's first message is templatable: *are you
    available, can you come Tuesday, what is your rate.* The worker's reply is not. A worker who
    cannot ask "where is the factory" stops opening the channel. **A dead channel is not a safe
    channel; it is a channel that made the credit worthless.**

### Recommendation (mine; the owner rules)

**(c) for the payer's first message, (a) for the thread once the worker has replied.**

The risk is not uniform across a thread. It concentrates at first contact, where the payer is a
stranger and the worker has no basis to judge them — and that is exactly the message that
templates best, so structuring it costs almost nothing and buys the worker a legible,
predictable first contact. After the worker replies — an affirmative act, by the party the
property protects — free text is what makes the channel worth having.

This is deliberately not (b): no filter, no false promise. The notice then says the true thing —
*messages here are not screened; do not share your number unless you want to.*

If the owner wants a single shape rather than two, take **(a)** over **(b)**. (b) costs the most
to build, breaks the product's own vocabulary, and buys a guarantee it cannot keep.

---

## C. What does the worker EXPERIENCE when a payer opens a relay?

> **RULED 2026-09-05 — the three additions are BLOCKING CONDITIONS on E0**, written into
> `E0_BUILD.md` above the phase title in the same position as E2's empty-result trap. E0 does
> not ship without all three; a builder finding any of them harder than scoped HALTs rather
> than trims.
> **This section also corrected the owner's own sequencing.** R-E3 put E4 first so that a
> visible-by-default worker had an exit before a contact channel existed; finding 3 falsifies
> that premise, because E4's exit does not reach a live unlock. Corrected sequence:
> **#1425 → E0 → E4 → E1 → E2, then P9.**
> Finding 1 — `profile.viewed` registered, templated and emitted by nothing — is ALSO PARKED
> separately as its own defect (`PARKED.md` P-019): it is the notification path C-1 needs, and
> it is half-built already.

Measured at HEAD. This section is not a HALT in E0's brief; it is here because the answers
decide whether E0 is worth building.

1. **No notification at all.** `profile.viewed` has a registered event
   (`packages/event-schema/src/registry.ts:517`) and a faceless notification template
   (`apps/api/src/notifications/notifications.dto.ts:165-172`) — and **nothing emits it**. A
   payer unlocks a worker today and the worker is never told.
   **CORRECTION, 2026-09-05, after the ruling.** I called this "the wiring is the missing
   line" here and in the PR comment. It is not. `ProfileViewedPayload` requires `job_id`
   (`packages/event-schema/src/payloads.ts:2145-2149`), while `unlocks.job_id` is NULLABLE
   (`packages/db/src/schema/payer.ts:235-236`) and the request DTO defaults it to null
   (`apps/api/src/unlocks/unlocks.dto.ts:23`) — so a search-driven unlock, which is E2's whole
   flow, cannot emit it as the contract stands. Closing that is an owner/architect act with
   three routes and real trade-offs; it is written up in `E0_BUILD.md` C-1 and parked as
   `PARKED.md` P-019. C-1 stands as a blocking condition; what changed is its price.
2. **No context, and the guard is deliberate.** The alerts feed structurally cannot name a
   counterparty: `apps/api/src/notifications/notifications.service.test.ts:320-326` fails any
   template copy matching `/\bemployer\b|\bcompany\b|\bpayer\b/i`, and `:121-128` asserts the
   event payload never reaches the output. `profile.viewed`'s copy is "Someone has viewed your
   profile", and its own comment calls that "the most this signal can say without revealing a
   counterparty identity."
3. **No opt-out — and worse than E4 states.** `setWants` throws
   (`apps/api/src/match/worker-skills.service.ts:157-165`); that is E4's item 1. But `wants`
   appears **zero times** in `apps/api/src/unlocks/unlocks.service.ts` — it is not in the
   fail-closed ladder (`:67-78`). **So even after E4 ships, a worker who turns every skill off
   keeps receiving messages from every payer who already unlocked him, for the remaining 14
   days.** Turning off findability does not turn off contact. This is new; it is not in
   `E4_BUILD.md`.
4. **The only exits are catastrophic.** `POST /consent/withdraw`
   (`apps/api/src/consent/consent.controller.ts:41`) is all-or-nothing: it revokes the whole
   latest consent row and calls `sessions.revokeAll`
   (`apps/api/src/consent/consent.service.ts:67-72`), so the worker loses profiling, resume
   generation and voice, and is logged out of every device. Otherwise: account deletion. There
   is no per-purpose withdrawal and no block or report affordance anywhere in the worker app.
5. **Nowhere to open it.** `apps/worker-app/lib/features/` holds 20 features and none is
   messages.

Shipped on top of HEAD, E0 gives a worker an unannounced message from an unnamed stranger with
no exit that does not also delete his profile. **That is a different product from the one he
consented into** — which is why section A's notice question and this section are the same
question wearing different clothes.

### Recommendation (mine; the owner rules)

Four items. The first three are cheap, and I would make them conditions of E0 shipping:

  - **Emit `profile.viewed` on unlock.** Event and template both already exist; what does not
    is a payload that fits a search-driven unlock (see the correction under finding 1). The
    worker learns he is being looked at *before* the first message rather than *by* it.
  - **A per-purpose exit for `employer_sharing`** — a "stop employer contact" switch that
    writes a new consent row without that purpose. This is what makes the notice's "you can
    turn this off" true, it is smaller than E4's clear-all, and it is the exit that matches the
    harm.
  - **Make `wants=false` / E4's clear-all close live unlocks' relay access** by adding the check
    to E0's use-time ladder. Without it, E4's exit does not exit (finding 3).
  - **Do NOT name the counterparty in the alert.** The guard in finding 2 is right. If a payer
    is identified at all it belongs inside the thread the worker chose to open — and *what a
    payer may be identified as* is its own owner ruling, not a copy detail.

Plainly: **without at least the first three, E0 should not ship.** The relay is not what makes
a credit worth something. The relay plus an exit is.

---

## What this document does not decide

  - What a credit buys, and whether the résumé stays free — DEFERRED by owner ruling until the
    relay resolves (`docs/decisions/RESUME_DISCLOSURE_DECISION_2026-09.md`).
  - The DPDP notice copy itself, and the `CURRENT_CONSENT_VERSION` bump — human/legal work,
    blocked in `E4_BUILD.md` items 6-7. Section A changes what that copy must say, not who
    writes it.
  - Message retention and DSAR erasure beyond matching the sibling tables — out of scope in
    `E0_BUILD.md`, and a new retention policy is an owner act.

## Signature

Owner decision A: ______________________  date: __________

Owner decision B: ______________________  date: __________

Owner decision C: ______________________  date: __________
