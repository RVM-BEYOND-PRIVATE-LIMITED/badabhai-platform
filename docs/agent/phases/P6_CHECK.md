PHASE-ID: P6
INVARIANT: supply eligibility is resolved in ONE method that both the offer read and
`assertBoostSupply` call, agreeing on every branch — below floor, at floor, floor <= 0,
unreadable count. Non-supply refusals (B-R3, price) are out of its scope.

EXPECTED ARTIFACTS: one shared supply-eligibility method in
apps/api/src/posting-plans/posting-plans.service.ts called by BOTH `assertBoostSupply` and
`getPostingStats`; an additive `PostingStats` field; a `weekly_payers` twin of the cap pinning
test in apps/api/src/unlocks/unlocks.service.test.ts.
If these do not exist, VERDICT is FAIL, reason "phase not built". Stop there.

Do these and paste raw output for each:
1. `grep -rn "boostSupplyFloor" apps/api/src/posting-plans/ apps/api/src/payer-portal/ apps/api/src/match/`.
   The comparison `reachTotal >= cfg.boostSupplyFloor` must appear EXACTLY ONCE, inside the
   shared method, and `assertBoostSupply` must contain no floor comparison at all. A second
   comparison site, or the identifier read outside that method, is a FAIL. The `<= 0` disable
   check inside the method is expected; `supply_floor:` in the payload (:569) and the message
   (:582) are not comparisons.
2. `pnpm --filter @badabhai/api run test posting-plans.service`. A NEW describe must drive
   `getPostingStats` through the same `make()` helper. Required, each paired with `buyBoost`:
   make({ boostSupplyFloor: 25, reachTotal: 4 }) → field false AND buyBoost rejects (:375);
   make({ boostSupplyFloor: 25, reachTotal: 25 }) → field true AND insertBoost called once (:398);
   make({ boostSupplyFloor: 7, reachTotal: 6 }) → field false (a hardcoded 25 goes RED here; no
   grep catches it). ABSENCE of these cases is the FAIL — the suite already passes at HEAD.
3. Branch parity, same suite: make({ boostSupplyFloor: 25, reachThrows: true }) → field TRUE and
   insertBoost called once (:404); make({ boostSupplyFloor: 0, reachTotal: 0 }) → field true AND
   countReachForPosting NOT called (:411). Opposite postures on either branch is a FAIL.
4. `pnpm --filter @badabhai/api run test payer-job-postings.controller`. The new key must appear
   in the `GET /payer/job-postings/:id` body (controller :115-121). Absent from BOTH that body
   and the list body is a FAIL — nothing an offer surface can read was built. Then the recorded
   list-route choice: either the key is null on list rows, or the reach count is ONE call for N
   rows (assert the mock's call count with 3 postings).
5. `pnpm --filter @badabhai/api run test unlocks.service`. Confirm the `weekly_payers` case
   asserts `txMethods.tryDebit` was never called and the `unlock.cap_exceeded` payload carries
   cap "weekly_payers" / window "week" (unlocks.service.ts:996). Then MUTATE: move the whole cap
   block, unlocks.service.ts:234-241, below the debit at :244 and re-run. BOTH cap tests must go
   RED (other cases may also move; only these two decide it). Green means they certify nothing.
   Revert the edit.
6. `grep -rn "unlock\|capped\|deny_reason" apps/api/src/match/match-candidates.service.ts apps/api/src/match/match-feed.repository.ts apps/api/src/reach/reach.service.ts apps/api/src/reach/reach.repository.ts`.
   The one expected hit is the doc comment at match-candidates.service.ts:11. Any hit inside a
   WHERE, join, or filter is a FAIL — a capped worker must still appear.
