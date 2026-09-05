STATUS: **ALREADY BUILT — this is a RE-POINT, not a build.** Every billable object, the
no-gateway pack purchase, the ledger, the free tier, the debit-on-unlock, the `denied` state
and the masked résumé all ship today, and the file-and-line evidence is below. **Read WHAT
YOU MUST NOT REBUILD before anything else.** One half of the flow as described is BLOCKED on
an unsigned owner ruling — see THE CREDIT QUESTION — and a session that answers it by
building is a full stop.

PHASE E3 — the credit and the unlock reach the candidate search. Nothing new is minted.

WHY THIS BRIEF LEADS WITH A WARNING. The last phase briefed as a build in this repository
(PX) was already implemented, and its brief carried three factual errors. The measurement for
this one says the same thing louder: E3's stated deliverables are shipped. If you find
yourself creating a credit table, a pack purchase route or a résumé disclosure, stop — you
are rebuilding a working system, and the second copy is the defect.

WHAT YOU MUST NOT REBUILD. All of this is live at HEAD.

  - **A pack credits the account with NO gateway, and it is the DEFAULT.**
    `POST /payer/credits` (apps/api/src/payer-portal/payer-unlocks.controller.ts:143)
    resolves the pack from config and mock-purchases it with no money taken. The real
    gateway path (`POST /payer/credits/order`, `:205`) answers a NEUTRAL 404 while
    `PAYMENTS_ENABLE_REAL` is off, and the two are mutually exclusive BY CONSTRUCTION so
    that turning real payments on cannot leave a free-credit route beside the paywall — the
    reasoning is at `:134-142`. This is exactly "clicking a pack credits the account
    directly, no gateway", and it already works.
  - **Idempotent under retry**, scoped to the session payer (`:157`), with a 409 on a
    duplicate in flight rather than a guessed balance, and the reason it is a 409 rather than
    an optimistic answer is written out at `:167-176`.
  - **The balance and the append-only ledger**: `payer_credits`
    (packages/db/src/schema/payer.ts:266) with a never-negative CHECK (`:280`), and
    `credit_ledger` (`:287`) as the source of truth.
  - **A free tier of 50 credits at signup**, exactly once under retry, enforced by the
    database rather than by the caller (apps/api/src/match/free-tier.service.ts:7-22).
  - **Credits decrement on unlock, and caps precede payment**, in one transaction under a
    per-worker advisory lock. The fail-closed ordering is written out at
    apps/api/src/unlocks/unlocks.service.ts:67-78: credit precondition, then the
    `employer_sharing` consent gate, then the ADR-0031 deletion freeze, then the worker caps,
    then payment and grant together.
  - **A `denied` unlock state** with an internal-only reason that never crosses the HTTP
    boundary (packages/db/src/schema/payer.ts:239-241, CHECK at `:261`).
  - **The masked résumé, end to end.** `POST /payer/resume-disclosures`
    (apps/api/src/payer-portal/payer-disclosure.controller.ts:52) → the payer-web action
    (apps/payer-web/src/app/(portal)/postings/[id]/applicants/actions.ts:77) → the rendered
    card. There is NO gap between an unlock and a payer seeing a résumé.
  - **A credits page** with live-catalog packs
    (apps/payer-web/src/app/(portal)/credits/page.tsx:47).

BUILD THESE THREE. That is the whole phase.

  1. PUT THE BALANCE AND THE PACKS BESIDE THE SEARCH RESULTS. Read the balance from
     `GET /payer/credits` (apps/api/src/payer-portal/payer-unlocks.controller.ts:105) —
     the same read the applicants page already does through the dashboard. Link to the
     existing `/credits` page for the purchase; do NOT add a second purchase surface.
     DECOUPLE THE TWO READS. A failure fetching the balance must never blank the candidate
     list. The applicants page already does this deliberately and is the pattern to copy
     (apps/payer-web/src/app/(portal)/postings/[id]/applicants/page.tsx:22-42): the list is
     the page's primary content, the balance is an affordance signal, and each gets its own
     try/catch and its own degraded state.

  2. REUSE THE UNLOCK COMPONENTS FROM THE BARREL. apps/payer-web/src/components/unlock/index.ts
     already says what to do, in its own words: *"the ONE implementation of the contact
     unlock + reveal surfaces, used by the applicant feed AND ANY FUTURE PAYER SURFACE.
     Import these from this barrel — never the component internals."* You are that future
     payer surface. `RoutedContactCard`, `MaskedResumeCard`, `ConfirmSpendDialog` and
     `UnlockResultToast` all come from there.
     KEEP THE THREE BEHAVIOURS THE APPLICANT PAGE ALREADY HAS, because they are not
     decoration (apps/payer-web/src/app/(portal)/postings/[id]/applicants/applicant-actions.tsx:32, :41, :45):
     confirm-on-spend on the FIRST unlock per row; ONE neutral "unavailable" state with
     identical copy for capped / unknown / no-consent / already-unlocked, so the UI is not
     an oracle; and Call/WhatsApp DISABLED until a routed relay handle exists.

  3. CALL THE EXISTING ROUTES, ADD NONE. `POST /payer/unlocks`
     (apps/api/src/payer-portal/payer-unlocks.controller.ts:66),
     `POST /payer/unlocks/:unlockId/reveal` (`:87`), `POST /payer/resume-disclosures`
     (apps/api/src/payer-portal/payer-disclosure.controller.ts:52). Each already binds the
     payer to the verified session and never to a body value. If a route seems to be missing,
     you are on the wrong surface — re-read this brief's WHAT YOU MUST NOT REBUILD.

THE CREDIT QUESTION — UNSIGNED. HALT; do not resolve it by building.
The flow as described says a payer "unlocks a profile and sees the FULL profile and the
résumé". Three things are true today and each contradicts a piece of that:
  (i)   a credit buys a ROUTED CONTACT, not a profile — the reveal wires an in-app relay
        (apps/api/src/unlocks/unlocks.service.ts:409) and returns no profile;
  (ii)  the résumé is FREE by signed decision — *"Resume download is FREE but is a PII
        DISCLOSURE"* (packages/db/src/schema/payer.ts:500-502) — and rides the consent-and-caps
        spine, not the credit spine. It does not even require an unlock;
  (iii) the résumé is MASKED to initials at render
        (apps/api/src/disclosures/resume-disclosure.service.ts:235), and there is NO
        full-profile view anywhere in this repository to reveal.
Changing (i) or (ii) amends ADR-0010 and ADR-0013 C.3. Changing (iii) is a §2 privacy call on
raw PII egress. All three are owner acts. **Build to the SHIPPED meaning — a credit buys a
routed contact, the résumé is free and masked — and put the question in your report.**

NEVER DO, each a full stop:
  - Write to `unlocks`, `unlock_routing`, `payer_credits` or `credit_ledger` from anywhere
    but `UnlockService`. That single-writer property is structural, not stylistic — its own
    docblock states it (apps/api/src/unlocks/unlocks.service.ts:60-65: *"the ONLY writer …
    no other module imports `UnlocksRepository`"*), and it is what makes the fail-closed
    ordering impossible to bypass. A new module that reads the balance directly from the
    table has already broken it.
  - Unmask a résumé, or return a full profile, without the ruling above.
  - Add a payment screen or an in-app purchase to any Flutter app
    (docs/agent/BUILD_RULES.md:29). Payments are web-only (CLAUDE.md §12).
  - Add a second credit-purchase route, or a second pack catalog. The catalog is served
    live at `GET /payer/pricing/catalog` and an ops price edit must show without a rebuild.
  - Surface a deny reason to a payer. Every deny returns a byte-identical neutral body at a
    constant HTTP status, on purpose, and the enum is compile-time barred from the response
    type. Rendering "why" would make the UI the oracle the API refuses to be.

DO NOT TOUCH: apps/ai-service, the profiling orchestrator, the chat service, the trade form
question flow, `pack_answers`, the worker conversational path. Also out of scope:
`PAYMENTS_ENABLE_REAL`, the Razorpay routes, pricing values, and the unlock cap numbers
(changing those is an ADR-0010 amendment plus a new value in a closed enum, not a build).

NOTHING HERE CAN BE PROVEN AGAINST REAL SUPPLY OR REAL MONEY. The workers on the live
database are testers (owner ruling R-E4, 2026-09-05) and `PAYMENTS_ENABLE_REAL` is off, so
every purchase is a mock. Every check for this phase runs against SEEDED LOCAL DATA and says
so in its own text.

INVARIANT: the disclosure chokepoint stays single — nothing outside `apps/api/src/unlocks/`
imports `UnlocksRepository`, and every credit movement this phase's surface can cause still
passes the consent and cap gates before payment. TRUE AT HEAD. Keeping it true through a new
surface is the phase.
