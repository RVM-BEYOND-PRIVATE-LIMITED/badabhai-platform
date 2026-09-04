STATUS: CLOSED 2026-09-05 — superseded by the E-chain (docs/decisions/E_CHAIN_DESIGN_2026-09.md).
Do not build from this file without reopening the phase.

NOTHING SURVIVES THIS CLOSURE. Every deliverable is either shipped, deleted by a signed
ruling, or carried by an E-phase. Checked adversarially, not assumed.

The WORKSHEET is not closed by this. docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md
stays LIVE — R1 and R4-d are signed, six rulings are still open, and R7's blank slot at
:794 is E2's gate. Closing this phase retires the BRIEF, not the worksheet.
P0_CHECK is now structurally unpassable and that is the correct reason to close it: its
item 3 requires every signature column to be empty, and the owner signed two.

------------------------------------------------------------------------------
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
