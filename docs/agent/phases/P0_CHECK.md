PHASE-ID: P0
INVARIANT: the worksheet contains zero decisions. Only proposals.

EXPECTED ARTIFACT: docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md
If it does not exist, VERDICT is FAIL, reason "phase not built". Stop there.

Do these checks and paste raw output for each:
1. Check every function value in the sheet against the locked list plus
   setter_programmer. List any that are not in it.
2. Check every collar tier is one of the four allowed values.
3. Confirm every VERDICT and signature column is empty.
4. Confirm R1 to R7 each have at least two options and a stated later cost.
5. Confirm the three overlapping roles are named with their colliding aliases.
6. Confirm the 21-vs-22 count question and the Design domain question are both raised.

FAIL if any cell reads like a settled decision rather than a proposal.
