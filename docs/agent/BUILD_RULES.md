BUILD RULES — read fully before doing anything.

SOURCE OF TRUTH, in order of authority:
  1. BadaBhai_MVP_Matching_and_Posting_Execution_Spec_2026-09-01.md
  2. BadaBhai_MASTER_CONTEXT_2026-07-23
  3. The code at the HEAD commit given to you

If the code contradicts the spec, the CODE is wrong. Stop and report it.
Do not change the spec to match the code. Do not quietly follow the code.

DEAD IDEAS — do not use these, do not bring them back, do not cite them:
  - A separate skill_id for each level (e.g. "CNC Turner (Programmer)" as its own role)
  - The {Setting/Programming} family
  - A 7-role launch wedge (it is 4)
  - Letting an LLM produce canonical IDs
  - LiteLLM gateway, self-hosted BGE-M3, the 100-point precision matcher
  - The old 7-weight system with RVM-5
  - "Match acceptance rate" as the north-star metric

NEVER DO THESE. Each one is a full stop, not a decision you get to make:
  - Run a database migration. Write the file only. Prakash applies it.
    No db:push. No drizzle-kit migrate. No psql DDL. Not even "just to test".
    This is the step BETWEEN the build session and the check session: a CHECK that
    needs a live schema waits for Prakash to apply, it does not apply its own.
  - Weaken, skip, .skip, or delete a test so a suite goes green.
  - Change the reach weights 35/20/15/15/10/5.
  - Add any ranking input that money, RVM membership, or a demographic can influence.
  - Add anything to consent.purposes[].
  - Create an in-app-purchase product or any payment screen inside a Flutter app.
  - Let an LLM produce, choose, or approve a canonical ID.
  - Settle an open ruling (R1 to R7) by picking a sensible-looking default.

SCOPE. Your phase brief is the whole of your scope. If you find yourself editing a
file no line of the brief asked you to touch, that is a PARK or a HALT, not initiative.
Rewriting docs, tidying unrelated code, or "while I was here" changes are out of scope.

THREE OUTCOMES — every task ends in exactly one of these:
  PROCEED  It is in scope and nothing blocks it. Do it. Write down every default you chose.
  PARK     A real problem, but not your job now. Add it to PARKED.md with file and line.
           Do not fix it.
  HALT     You hit a NEVER DO item, an unsettled ruling, or a spec-versus-code conflict.
           Stop. Collect your questions. Wait for an answer.

QUESTIONS: save them all and ask once at the end. Do not send progress updates.

WHEN YOU FINISH, reply with exactly these five things:
  1. Files you changed, with full paths
  2. Every default you chose, and why
  3. Anything you parked
  4. The exact test command, and its raw output pasted unedited
  5. This phase's INVARIANT, and the file and line number where it is enforced in code

Saying "done" is not accepted. Cite a file and a line number or it did not happen.
