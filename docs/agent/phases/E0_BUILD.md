STATUS: FIRST IN THE E-CHAIN, ahead of E1 (owner ruling, 2026-09-05). ITEM 0 IS DONE AND
DID NOT WAIT: filed as issue #1430 (payer-web, the frontend owner's layer) with the exact
replacement copy, 2026-09-05.
Two questions in this brief are UNSIGNED and each HALTs the build: the free-text question
(§THE LEAK THIS CHANNEL HAS BY CONSTRUCTION) and the consent question (item 3). BOTH ARE
WRITTEN UP, COSTED, AND AWAITING A SIGNATURE in docs/decisions/E0_RELAY_DECISION_2026-09.md
(sections A and B) — read it before asking again; do not pick a sensible-looking default.
THAT NOTE'S SECTION C IS A THIRD, UNSIGNED CONDITION ON THIS PHASE and it is not one of the
two HALTs: it measures what a worker experiences when a payer opens a relay (no notification,
no context, no working exit) and recommends three additions without which this phase should
not ship. Read it before building item 1.

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
     direction, a body, and timestamps. The body is worker-visible text — see the leak
     section below before you decide what may go in it.

  3. A PAYER SEND ROUTE AND A WORKER READ/REPLY ROUTE. `PayerAuthGuard` on one,
     `WorkerAuthGuard + ConsentGuard` on the other — the pairs every sibling surface uses.
     Register both controllers in apps/api/src/common/guard-contract.test.ts, which imports
     every controller in apps/api and asserts its guard chain, and write a module boot test
     (apps/api/src/match/match.module.boot.test.ts is the pattern) — a bad module edge fails
     BOOT while typecheck, lint and unit tests all pass.
     HALT — UNSIGNED: does `employer_sharing` authorise MESSAGING a worker, or only
     DISCLOSING his routed contact to a payer? The enum's docblock says it "gates whether a
     worker's routed contact may be disclosed to a paying party"
     (packages/types/src/index.ts:26-31), which is the disclosure and arguably not the
     conversation. `communication` is transactional (OTP), and `whatsapp_messaging` exists
     precisely because messaging over a third party needed its own basis. Adding a NINTH
     purpose is a NEVER-DO (docs/agent/BUILD_RULES.md:28). So the answer is either "the
     existing purpose covers it" or "an owner act" — and it is not yours. ASK.
     BOTH READINGS ARE ALREADY COSTED in docs/decisions/E0_RELAY_DECISION_2026-09.md §A,
     including the finding that decides the DEADLINE rather than the answer: no worker holds
     `employer_sharing` today, so a re-consent of the whole base is already owed by E4, and a
     ninth purpose is nearly free if it lands in E4's notice and expensive if it lands after.

  4. THE EVENTS. A message sent and a message read are business actions. PII-FREE: opaque
     ids, a direction enum, counts — never the body, never a name, never a phone. Follow the
     spine's existing discipline; `contact.revealed` is the sibling.

  5. AN IN-APP NOTIFICATION WHEN A MESSAGE ARRIVES, through the surface that already exists
     (`GET /workers/me/notifications`). Not push — see OUT OF SCOPE.
     The Flutter screens are apps/worker-app and apps/payer-app and are therefore the MOBILE
     owner's (CLAUDE.md §6). Raise the issue with the route and payload shapes; do not open a
     `.dart` file.

THE LEAK THIS CHANNEL HAS BY CONSTRUCTION — HALT, UNSIGNED, and read it before designing
item 2's body column. The entire point of the routed relay is that the payer never learns
the worker's phone number. A free-text channel between them defeats that in one message: the
payer types "send me your number" and the worker types it back. Nothing in the schema, the
guards or the events can prevent that, because both parties are legitimate and the text is
the product.
Three shapes exist and the choice is the OWNER'S:
  (a) Free text, and accept that out-of-band exchange happens. Honest, simplest, and it means
      the no-disclosure property is a default rather than a guarantee — which changes what we
      may promise a worker.
  (b) Free text with an outbound scan that blocks or redacts number-shaped strings. Note the
      known trap before proposing it: a charset cannot say "not an identifier", and every
      prior attempt at this class of filter in this repository has been measured leaky.
  (c) Structured messages only — a closed set of templates. Preserves the property
      completely and may be too rigid to be used at all.
DO NOT PICK ONE. All three are costed in PRODUCT terms as well as privacy terms in
docs/decisions/E0_RELAY_DECISION_2026-09.md §B — which also corrects two things in the framing
above: the property is asymmetric by DIRECTION (a payer volunteering his own number breaks
nothing the worker was promised), and shape is largely solved while intent is not.

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
FALSE AT HEAD only vacuously: no message can cross at all, because nothing resolves the
handle. Making it true, and keeping it true, is the phase.
