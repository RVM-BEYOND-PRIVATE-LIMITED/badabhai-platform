PHASE-ID: P6
INVARIANT: no credit is ever taken for an unlock that breaks a cap.

EXPECTED ARTIFACTS: cap enforcement at the unlock request path with a denial reason
code and event, and a boost offer gate reading a floor from config.
If these do not exist, VERDICT is FAIL, reason "phase not built". Stop there.

Do these checks and paste raw output for each:
1. Seed a worker who already has 5 unlocks in the last 7 days. Try a 6th.
   Confirm: denied, reason code present, event emitted, AND the credit balance is
   UNCHANGED. Query the balance before and after. Any deduction is a FAIL.
2. Repeat separately for the 30-day cap.
3. Confirm the capped worker STILL APPEARS in the employer candidate list.
   If they disappear, that is a FAIL.
4. RACE CONDITION: fire two unlock requests at the same time at a worker sitting at
   4 of 5. Exactly one must succeed. Both succeeding is a FAIL.
5. Create a job in a role and radius with a reach count below the floor.
   Confirm boost is not OFFERED at all — check the response payload, not just the
   purchase endpoint. If it is offered and then rejected at purchase, that is a FAIL.
   It is gated at the wrong layer.
6. Confirm the caps and floor come from config. Hardcoded 5 or 15 is a FAIL.
