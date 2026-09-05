STATUS: FIRST IN THE E-CHAIN — ahead of E4, E1 and E2 (owner ruling, 2026-09-05, CORRECTED
from the ruling of the same day that put E4 first; see WHY THE ORDER CHANGED). Its only
prerequisite is PR #1425.
ITEM 0 IS DONE AND DID NOT WAIT: issue #1430 (payer-web, the frontend owner's layer) carries
the exact replacement copy, filed 2026-09-05.
THE TWO QUESTIONS THAT HALTED THIS BRIEF ARE NOW RULED — consent (§A) and the free-text shape
(§B) of docs/decisions/E0_RELAY_DECISION_2026-09.md, owner, 2026-09-05. Both rulings are
written into the items below. What replaces them is not a question but a gate: the THREE
BLOCKING CONDITIONS immediately below, above the phase title on purpose.

================================================================================
THE THREE CONDITIONS. READ THIS BEFORE ANYTHING ELSE, INCLUDING THE REST OF THE STATUS.

**E0 DOES NOT SHIP WITHOUT ALL THREE.** They are not garnish on the relay; they are the half
of it that makes a relay something a worker consented into rather than something that happens
to him. Owner ruling, 2026-09-05, on the measurements in
docs/decisions/E0_RELAY_DECISION_2026-09.md §C.

IF ANY ONE OF THEM IS HARDER THAN SCOPED HERE, THAT IS A HALT, NOT A TRIM. Shipping the relay
with two of three is the failure this block exists to prevent, and it will present itself as
a reasonable scope call late in a session.

  C-1. THE WORKER IS TOLD HE WAS UNLOCKED — emit `profile.viewed` from the unlock path.
       The event is registered (packages/event-schema/src/registry.ts:517) and the faceless
       notification template already exists
       (apps/api/src/notifications/notifications.dto.ts:165-172). NOTHING EMITS IT. Without
       it, the worker's first knowledge that a stranger holds his contact is the stranger's
       message.
       THIS IS NOT THE ONE-LINE WIRING JOB IT LOOKS LIKE, and the correction is recorded
       here rather than left for you to hit mid-session. `ProfileViewedPayload` requires
       `job_id` (packages/event-schema/src/payloads.ts:2145-2149, NOT optional), while
       `unlocks.job_id` is NULLABLE — "optional job context (per-profile granularity, so
       nullable)", packages/db/src/schema/payer.ts:235-236 — and the request DTO defaults it
       to null (apps/api/src/unlocks/unlocks.dto.ts:23). An unlock with no posting attached
       therefore CANNOT emit this event as the contract stands, and a search-driven unlock is
       exactly the case with no posting attached.
       **THAT IS A HALT, AND IT IS THE ONE THIS CONDITION WILL ACTUALLY HIT.** Three routes
       exist and none is yours to pick:
         (i)   emit only when `job_id` is non-null. REJECT THIS ONE ON SIGHT even though it
               compiles: the workers it silently skips are precisely those found by search
               with no posting attached, which is the whole of E2's flow.
         (ii)  loosen `job_id` to nullable in the payload. CLAUDE.md §3 forbids mutating an
               event schema, and registry.ts:517 pins `version: 1`. The practical risk is nil
               — zero producers and zero consumers exist — but "nil risk" is an argument for
               the owner to weigh, not a licence.
         (iii) mint a distinct event for the unlock notification, with its own template.
       Collect it with your other questions. Do not settle it by building.
       DO NOT NAME THE COUNTERPARTY. `apps/api/src/notifications/notifications.service.test.ts:320-326`
       fails any template copy matching /\bemployer\b|\bcompany\b|\bpayer\b/i and `:121-128`
       asserts the payload never reaches the output. Both guards are correct and stay.
       The copy that ships is the one already written: "Someone has viewed your profile."

  C-2. A WORKER-FACING EXIT FROM EMPLOYER CONTACT, and it must not cost him anything else.
       Today the only exits are `POST /consent/withdraw` — all-or-nothing, and it also calls
       `sessions.revokeAll` (apps/api/src/consent/consent.service.ts:67-72), so the worker
       loses profiling, resume generation and voice AND is logged out of every device — or
       account deletion. Neither is an exit from messaging; both are exits from the product.
       BUILD ONE SWITCH that writes a new consent row omitting BOTH the disclosure purpose
       (`employer_sharing`) and the messaging purpose ruled in §A. One switch, not two: a
       worker who is disclosable but unmessageable sells a payer a credit for a handle that
       dials nothing, which is the exact defect this phase exists to close.
       THE TRAP, and it is the whole of the risk here. The new row's purposes must be
       DERIVED SERVER-SIDE from the latest row minus those two — never taken from the client.
       `ConsentService.accept` writes whatever array it is handed
       (apps/api/src/consent/consent.service.ts:25-46), so a screen that posts a hand-built
       list drops `profiling` the first time someone edits it, and consent rows are
       append-only. Route it through the consent module; do not add a second writer.
       The Flutter screen is the MOBILE owner's (CLAUDE.md §6): raise the issue, ship the
       route.

  C-3. THE EXIT REACHES UNLOCKS THAT ARE ALREADY LIVE. Add the check to the use-time ladder
       in item 1. A worker who leaves must stop receiving messages from payers who unlocked
       him BEFORE he left — otherwise "stop" means "stop in fourteen days"
       (packages/db/src/credit-packs.ts:101).
       THIS IS ALSO WHAT MAKES E4's OPT-OUT REAL. `wants` appears ZERO times in
       apps/api/src/unlocks/unlocks.service.ts — it is not in the fail-closed ladder
       (`:67-78`), so E4's `setWants(false)` and its clear-all end FINDABILITY and not
       CONTACT. That finding is why this phase now runs before E4 rather than after it.
================================================================================

WHY THE ORDER CHANGED. Ruling R-E3 originally put E4 first, so that a visible-by-default
worker had a working exit before a contact channel existed. C-3's measurement falsifies the
premise: E4's exit does not reach a live unlock, so E0-after-E4 still lands messages on
workers who cannot stop them. The corrected sequence is #1425 → E0 → E4 → E1 → E2, then P9
(owner ruling, 2026-09-05). The reasoning behind R-E3 is unchanged and is now served by C-2
and C-3 instead of by E4's position.

PHASE E0 — make the handle dial something.

WHY THIS PHASE EXISTS, AND WHY IT MOVED IN FRONT OF EVERYTHING. A payer spends a credit and
receives a `relay_handle`. Nothing in this repository can resolve it. `wireInAppRelay`
(apps/api/src/unlocks/unlocks.service.ts:873-886) decrypts the worker's phone, does
`void phone.length; // touch the value (relay-open stand-in)`, and returns
`relay_${unlockId}_${randomUUID()}`. Every other occurrence of `relayHandle` /
`relay_handle` / `routingToken` across apps/api/src and apps/payer-web/src is a WRITE, a TYPE
DECLARATION, or a RENDER — there is no resolution route, no messaging bridge, and no worker
inbox for a payer's message to land in.

That is deliberate and documented — the docblock says the alpha only needed to PROVE a relay
could be opened without disclosing the number, and it does prove it. It is not a bug. It is
an unfinished half, and the credit is charged for it.

ITEM 0 — LAND THIS FIRST, ON ITS OWN, BEFORE ANYTHING ELSE IN THIS BRIEF.
apps/payer-web/src/components/unlock/routed-contact-card.tsx:30-32 tells a paying employer:

    "Use it in-app to reach the candidate; it expires with your access window."

**That sentence is false today.** It is on a paid surface, and it is the only instruction a
payer is given after spending a credit. Correct it to describe what the handle actually is —
a reference to a granted, time-boxed access record — and to say the routed channel is not yet
open. Do NOT wait for the rest of this phase: the copy is wrong whether or not the relay
gets built, and a separate one-file commit stops the false promise today.
This is a payer-web change and therefore the FRONTEND owner's layer (CLAUDE.md §6), so it
was RAISED rather than edited: **issue #1430**, 2026-09-05, carrying the exact replacement
copy. Nothing is owed here by a build session — confirm the issue is still open, and if it
has been closed, confirm the string is gone from the file.

WHAT ALREADY EXISTS — do not rebuild any of it.
  - The entitlement and its lifecycle: `unlocks` (packages/db/src/schema/payer.ts:225), the
    14-day window (packages/db/src/credit-packs.ts:101), the reveal attempt cap
    (packages/config/src/server.ts:1135, default 3).
  - The routing row: `unlock_routing` (packages/db/src/schema/payer.ts:349-370) already
    stores `unlock_id`, a server-internal `routing_token` (unique index at :367), the
    `channel`, the `relay_handle`, and `expires_at`. **The join you need is already
    persisted.** You are not adding a routing table; you are adding a reader.
  - The fail-closed ladder the resolution must reuse rather than re-derive:
    apps/api/src/unlocks/unlocks.service.ts:67-78 — credit precondition, `employer_sharing`
    consent, ADR-0031 pending-deletion freeze, worker caps, then payment+grant.
  - A worker-facing IN-APP notification surface: `GET /workers/me/notifications`
    (apps/api/src/notifications/notifications.controller.ts:20, :27) with a `notifications`
    feature module in the Flutter app. That is the landing place for "someone messaged you"
    — and it is NOT push. See OUT OF SCOPE.

BUILD THE MINIMUM. Five items, and the word MINIMUM is load-bearing: this phase makes the
handle resolve, it does not build a messaging product.

  1. RESOLUTION, SERVER-SIDE, AND FAIL-CLOSED. One internal function: `relay_handle` →
     the `unlock_routing` row → the `unlocks` row → the worker. It re-checks, at use time and
     not only at grant time: the unlock is `granted`/`revealed`, `expires_at` is in the
     future, the caller OWNS the unlock, the worker still has `employer_sharing` consent
     unrevoked, and the worker is not pending deletion.
     EVERY FAILURE RETURNS THE SAME NEUTRAL BODY. A resolution route that distinguishes
     "expired" from "consent revoked" from "not yours" is a worker-state oracle, and it would
     defeat the no-oracle property the whole unlock path is built around
     (apps/api/src/unlocks/unlock-response.ts:1-23). Reuse `neutralUnavailable()`; do not
     write a second deny body.
     THE HANDLE IS THE ONLY THING THE PAYER HOLDS, so it is the only thing the route may take.
     Do NOT accept a `worker_id`, and do NOT return one.

  2. ONE MESSAGE TABLE. No payer↔worker message store exists — the two message tables in this
     repository are `chat_messages` (worker↔AI) and `payer_job_posting_chat_messages`
     (payer↔AI), and neither is this. Write the migration FILE only
     (docs/agent/BUILD_RULES.md:21); Prakash applies it. Number it after E1's — read
     packages/db/migrations/meta/_journal.json for the current maximum and never hand-set a
     `when`.
     THE ROW MUST NOT CARRY A PHONE, A NAME, OR AN EMPLOYER. It carries the unlock join, a
     direction, a body, and timestamps. THE BODY IS TWO-SHAPED under the §B ruling: a template
     id plus a closed parameter set for the payer's opening message, free text for everything
     after the worker's first reply. Model it so the opening shape cannot hold free text —
     a leak in the first message should be a compile error, not a review miss. Read the leak
     section below in full, including the two things the ruling does NOT settle.

  3. A PAYER SEND ROUTE AND A WORKER READ/REPLY ROUTE. `PayerAuthGuard` on one,
     `WorkerAuthGuard + ConsentGuard` on the other — the pairs every sibling surface uses.
     Register both controllers in apps/api/src/common/guard-contract.test.ts, which imports
     every controller in apps/api and asserts its guard chain, and write a module boot test
     (apps/api/src/match/match.module.boot.test.ts is the pattern) — a bad module edge fails
     BOOT while typecheck, lint and unit tests all pass.
     RULED, 2026-09-05 — A NINTH CONSENT PURPOSE, AND YOU ARE NOT THE ONE WHO MINTS IT.
     The question was whether `employer_sharing` authorises MESSAGING or only DISCLOSING the
     routed contact. The owner ruled: it authorises disclosure only, and messaging gets its
     own purpose, added NOW rather than later. Reasoning, preserved because it is the part a
     later session will want to re-litigate — the enum's house rule for splitting a purpose is
     EGRESS TO A THIRD PARTY, not messaging (`whatsapp_messaging` because the phone reaches
     Meta, `voice_processing` because the clip reaches Sarvam,
     packages/types/src/index.ts:33-39, `:56-63`). The in-app relay has neither, so on that
     rule it would NOT have earned a split. What decided it was the DEADLINE, not the reading:
     no worker holds `employer_sharing` today, E4 already owes a full re-consent, so the
     purpose costs one sentence in copy that does not yet exist if it lands now, and a second
     re-consent over an already-opted-in base if it lands later. That is the `model_training`
     decision (`:23-24`) taken deliberately a second time.
     WHAT THIS MEANS FOR YOU. Adding to `consent.purposes[]` is still a NEVER-DO
     (docs/agent/BUILD_RULES.md:28) and the ruling does not transfer it to you. The string is
     minted by the owner as a one-line addition to `CONSENT_PURPOSES` with its docblock;
     `employer_messaging` is the proposed name and the owner confirms it. Your gates key on
     it. If the string is not in `packages/types/src/index.ts` when you build, HALT — do not
     add it, and do not fall back to gating on `employer_sharing`.
     THE ARRAY MUST HOLD NINE MEMBERS WHEN THIS LANDS, not eight. `packages/validators`
     derives its zod enum from the same array (packages/validators/src/index.ts:88), so the
     type flows; nothing else needs editing.
     MINTING IT IS SAFE TO DO BEFORE THE NOTICE COPY EXISTS, and that is the house pattern
     rather than an exception: a purpose no client requests fails closed for every worker, so
     the routes stay shut until E4's copy ships and workers actually opt in. `employer_sharing`,
     `whatsapp_messaging`, `agent_activity_visibility` and `voice_processing` all held exactly
     that posture (packages/types/src/index.ts:71-73). Requesting it from a client is E4's
     work, and it must not happen before the copy — see E4_BUILD "THE ORDER THAT MATTERS".

  4. THE EVENTS. A message sent and a message read are business actions. PII-FREE: opaque
     ids, a direction enum, counts — never the body, never a name, never a phone. Follow the
     spine's existing discipline; `contact.revealed` is the sibling.

  5. AN IN-APP NOTIFICATION WHEN A MESSAGE ARRIVES, through the surface that already exists
     (`GET /workers/me/notifications`). Not push — see OUT OF SCOPE.
     The Flutter screens are apps/worker-app and apps/payer-app and are therefore the MOBILE
     owner's (CLAUDE.md §6). Raise the issue with the route and payload shapes; do not open a
     `.dart` file.

THE LEAK THIS CHANNEL HAS BY CONSTRUCTION — RULED 2026-09-05, and read all of it before
designing item 2's body column, including the two things the ruling does NOT settle. The
entire point of the routed relay is that the payer never learns the worker's phone number. A free-text channel between them defeats that in one message: the
payer types "send me your number" and the worker types it back. Nothing in the schema, the
guards or the events can prevent that, because both parties are legitimate and the text is
the product.
RULED, 2026-09-05: **(c) FOR THE PAYER'S FIRST MESSAGE, (a) FOR THE THREAD ONCE THE WORKER
HAS REPLIED.** The payer opens with a structured message from a closed template set — a
template id plus a closed parameter set in the body column, so a leak in the opening message
is a compile error rather than a review miss. After the worker has replied — an affirmative
act, by the party the property protects — the thread is free text both ways.
  Rejected: (b), an outbound number scan. It costs the most to build, it fires on the
  product's own vocabulary ("8 saal", "12 logon ki team", a pincode, "VMC 850"), and it buys a
  guarantee it cannot keep. The spoken-digit redactor already carries that scar in its own
  docstring (apps/ai-service/app/spoken_digits.py:19-22).

TWO THINGS THE RULING DOES NOT SETTLE, and a later session must not read it as settling them.

  (i) **INTENT REMAINS UNSOLVED, AND NO SHAPE CONSTRAINT ADDRESSES IT.** The ruling constrains
      the FORM of the opening message. It does nothing about "mera number profile pe hai",
      "WhatsApp pe naam se search karo", or a number split across two messages — and once the
      worker has replied, the thread is free text by design. Shape is largely a solved problem
      (apps/ai-service/app/pseudonymize.py:243 for digits, spoken_digits.py for "nau aath
      saat"); intent is not solved anywhere, by anyone, in this repository. Do not write copy,
      a docblock, an ADR or a check item that describes the channel as preventing disclosure.
      It reduces the opening surface. That is all it does.
  (ii) **THE PROPERTY IS ASYMMETRIC BY DIRECTION.** It protects the WORKER's number. A payer
      volunteering his own ("call me on 98765…") breaks nothing the worker was promised. Do
      not build a constraint that treats both directions alike — it blocks the benign half and
      is experienced as a broken product.

NEVER DO, each a full stop:
  - Return, log, event, or store the worker's phone. The ONLY decrypt on this path is
    apps/api/src/unlocks/unlocks.service.ts:878, and after this phase it should still be the
    only one. If your resolution needs the phone, you have built `proxy_number`, not the
    in-app relay — see OUT OF SCOPE.
  - Derive the handle from the phone. It is a fresh random uuid on purpose
    (apps/api/src/unlocks/unlocks.service.ts:885-886) precisely so it is not reversible.
  - Write to `unlocks`, `unlock_routing`, `payer_credits` or `credit_ledger` from outside
    `UnlockService`. That single-writer property is structural and is stated at
    apps/api/src/unlocks/unlocks.service.ts:60-65.
  - Charge a second credit to send a message, or to resolve a handle. What a credit buys is
    the DEFERRED question (docs/decisions/RESUME_DISCLOSURE_DECISION_2026-09.md) and this
    phase must not settle it by building a price.
  - Distinguish deny reasons to the payer. One neutral body, constant status.

OUT OF SCOPE — named so the phase cannot grow:
  - `proxy_number`. It is the production routed channel and is human-gated on a real
    telephony key and real spend (packages/db/src/schema/payer.ts:206-211). The type union
    keeps the value (apps/api/src/unlocks/unlock-response.ts:55); nothing in this phase makes
    it reachable.
  - PUSH notifications for messages. ADR-0034 scopes push to SECURITY ALERTS ONLY, with
    everything else "explicitly deferred" (docs/decisions/0034-worker-push-notifications.md:16-18).
    Item 5 is the IN-APP list, which is a different surface with a different ruling.
  - Attachments, media, read receipts, typing indicators, presence, unread badges beyond the
    existing notification surface, search over messages, and any AI in the channel.
  - Message retention and DSAR erasure BEYOND matching what the sibling tables already do.
    A new retention policy is an owner act.
  - The résumé/credit pricing question. Deferred by owner ruling until this phase lands.

DO NOT TOUCH: apps/ai-service, the profiling orchestrator, the chat service, the trade form
question flow, `pack_answers`, the worker conversational path. Note the collision risk: the
worker's AI chat and this relay are two different conversations, and `chat_messages` belongs
to the first. Do not extend it.

NOTHING HERE CAN BE PROVEN AGAINST REAL SUPPLY OR REAL USE. The workers on the live database
are testers (owner ruling R-E4, 2026-09-05), `employer_sharing` is requested by no client, and
no worker has ever received a relayed message. Every check for this phase runs against SEEDED
LOCAL DATA and says so in its own text.

INVARIANT: no message crosses between a payer and a worker without a live, unexpired,
consent-valid unlock joining them — re-checked at send time, not merely at grant time.
CONSENT-VALID means, after the §A ruling, BOTH the disclosure purpose (`employer_sharing`)
and the ninth messaging purpose, unrevoked at send time. C-2 and C-3 are what make the
re-check non-vacuous: without an exit the worker can reach, and without that exit reaching
unlocks already granted, "re-checked at send time" tests a condition nothing can change.
FALSE AT HEAD only vacuously: no message can cross at all, because nothing resolves the
handle. Making it true, and keeping it true, is the phase.
