STATUS: PARTLY CLOSED. Item 1 (contact caps) is SHIPPED — its build is deleted, and the old
invariant is already true at HEAD. Item 2 is the whole of this phase. It is buildable at HEAD:
the floor lives in `match_config`, which is on main, so it does NOT depend on PR #1387.
PHASE-ORDER GATE: docs/agent/README.md:47 requires the previous VERDICT to be PASS, and
docs/qa/evidence/ holds only P0 and PX. Ask the owner to lift it before you start.

PHASE P6 — the boost supply gate at the offer.

1. CONTACT CAPS — ALREADY BUILT. Do not build them.
   unlocks.service.ts:234 checks the caps and returns BEFORE the credit debit at :244, in one
   transaction under a per-worker advisory lock. A capped request writes `deny_reason='capped'`
   and emits `unlock.cap_exceeded` then `unlock.denied`.
   The numbers are env config (packages/config/src/server.ts:1098-1099): 5 reveals per worker
   per rolling 24 HOURS, 10 DISTINCT PAYERS per rolling 7 days. They are ADR-0010's RECOMMENDED
   alpha starting caps, tunable without a migration (0010-contact-unlock-and-reveal.md:47-49,
   :372-374); OQ-F — the trust-and-safety call to tune them — is OPEN. This phase does not
   touch them.
   Do NOT add a cap DIMENSION. A 30-day window needs a new UNLOCK_CAP_KINDS value
   (packages/event-schema/src/payloads.ts:1325) AND a new UNLOCK_CAP_WINDOWS value (:1330).
   disclosures/resume-disclosure.service.ts:403-413 reads the SAME two knobs. Do not touch it.

   THE ONE THING OWED: the pinning test covers only the daily cap
   (unlocks.service.test.ts:290-296, asserting `tryDebit` was never called). Write the
   `weekly_payers` twin: setup({ consentPurposes: ["employer_sharing"], payers: 10 }).
   Nothing else in item 1. A worker at cap MUST still appear in employer lists — do not add a
   cap predicate to any candidate reader.

2. BOOST SUPPLY AT THE OFFER — this is the build.
   The SALE is already gated. `assertBoostSupply` (posting-plans.service.ts:541-585) reads
   `match_config.boost_supply_floor` (default 25, packages/match-engine/src/config.ts:61),
   counts `job_reach` for the POSTING, emits `job_posting.boost_refused` and throws, all before
   any payment event. ADR-0036 §7 (0036-matching-algorithm-v1.md:87) specifies that layer.
   KEEP IT. This phase adds a read; it removes nothing.

   No POSTING-SCOPED boost offer read exists. posting-plans.controller.ts has only
   `POST :id/plan` and `POST :id/boost`; the payer path is the same two POSTs
   (payer-job-postings.controller.ts:177, :194). The one payer GET returning the boost product
   is `GET /payer/pricing/catalog` (payer-pricing.controller.ts:46) and it carries no
   job_posting_id — OUT OF SCOPE, do not change its shape.

   - Extract the decision out of assertBoostSupply into ONE private method answering "does this
     posting clear the floor", carrying BOTH of assertBoostSupply's branches: floor <= 0 →
     eligible (:548), and an unreadable `job_reach` → eligible, FAILS OPEN (:551-559).
     assertBoostSupply must then hold NO floor comparison of its own — it calls the method and
     refuses. Two copies of `reachTotal >= floor` is the failure this phase exists to prevent.
   - Surface it as an ADDITIVE field on `PostingStats` (posting-plans.service.ts:130-135, built
     by getPostingStats at :159), which the payer already reads through `enrich`
     (payer-job-postings.controller.ts:74-84). Never rename or drop an existing field.
   - PostingStats is documented as honest numbers only, "NO fabricated figure" (:122-128). If
     the value is not computed for a row it is null there — never a defaulted true/false.
     `enrich` runs PER ROW on the list route (:104-111); a per-row reach count is N queries.
     Batch it to ONE call, or return null on list rows and the real value on `GET :id`. Write
     down which you chose.
   - Backend only. The payer-web affordance is a separate frontend issue (CLAUDE.md §6). Do NOT
     add a payment screen to a Flutter app (BUILD_RULES:29) — the payer-app's boost button was
     deliberately removed (payer-app/lib/features/jobs/presentation/jobs_screen.dart:661).

The floor is config, never a constant in code.

Put the new tests in posting-plans.service.test.ts and unlocks.service.test.ts — the node suite,
no database. The CI DB-gate loop's directory alternation (.github/workflows/ci.yml:1431) lists
neither `src/posting-plans` nor `src/unlocks`, so a DB-gated file there would not be gated.

INVARIANT: supply eligibility for a boost is resolved in exactly ONE place — the offer read and
`assertBoostSupply` reach it through the SAME method, over `match_config.boost_supply_floor` and
the same `job_reach` count, and agree on every branch: below floor, at floor, floor <= 0, and an
unreadable count. It says nothing about non-supply refusals (B-R3, an unresolvable price).
