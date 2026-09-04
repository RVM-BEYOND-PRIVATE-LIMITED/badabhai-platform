BUILD RULES — read fully before doing anything.

SOURCE OF TRUTH, in order of authority. Every entry is in this repository and can be
opened. If you are citing something you cannot open, you are guessing. Every file named
anywhere in this document is written as a repo-root-relative path, and CI fails if one of
them does not resolve -- scripts/check-authority-paths.mjs:

  1. docs/decisions/*.md -- the ADRs, and ONLY those whose Status line reads Accepted.
     A Proposed ADR decides nothing:
     docs/decisions/0028-international-occupation-taxonomy-adoption.md is Proposed and
     states outright that it "produces no code, schema, or migration".
     The newest Accepted ADR wins over an older one on the same subject.
     CITE THE FILE PATH, NEVER THE BARE NUMBER. The historical documents in
     docs/reference/ use "ADR-0035" and "ADR-0036" for entirely different documents
     than docs/decisions/ does, so a bare number is ambiguous by construction.
     Governing matching, ranking and feed visibility today:
     docs/decisions/0036-matching-algorithm-v1.md (Accepted 2026-07-31), which retires
     the weighted engine and its 35/20/15/15/10/5 ledger (:7, :17), TD42 (:7, :83),
     PACE and `hot` (:97, :99), and ADR-0006's sort-never-block (:34).

  2. docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md -- rulings R1 to R7, and ONLY
     where the "Signed (RVM / CEO): ...  Date: ..." line under that ruling is filled
     in. The worksheet says it itself: "A recommendation is not a ruling." An unsigned
     ruling is a HALT, not a default you get to pick (see NEVER DO, last item).

  3. The code at the HEAD commit given to you -- the authority on what EXISTS.

  4. PARKED.md -- defects already found and deliberately not fixed, with file and line.
     Read it before reporting something as new, and before "fixing" something that was
     left alone on purpose.

  5. Binding at all times, and not overridden by a phase brief:
     CLAUDE.md              the engineering contract -- ownership, privacy, events
     docs/agent/README.md   the two-session BUILD-then-CHECK protocol
     docs/agent/CHECK_RULES.md  the rules a CHECK session runs under

INTENT AND FACT ARE DIFFERENT QUESTIONS. Confusing them is what produced the phase
briefs' errors. An ADR is the authority on what the platform SHOULD do; the code is the
authority on what it CURRENTLY does. So:

  - Code contradicts a signed ADR      -> the CODE is wrong. HALT and report it, with
                                          file and line. Do not amend the ADR to match
                                          the code. Do not quietly follow the code.
  - A brief contradicts the code       -> the BRIEF is wrong. A phase brief is an
                                          instruction, never an authority. Report it
                                          with file and line, and correct the brief.
  - docs/reference/ contradicts an ADR -> THE ADR WINS, always.

NOT AUTHORITIES. docs/reference/ holds historical snapshots, committed so they can be
audited rather than obeyed:
  docs/reference/BadaBhai_MVP_Matching_and_Posting_Execution_Spec_2026-09-01.md
  docs/reference/BadaBhai_MASTER_CONTEXT_2026-07-23.md
  docs/reference/BadaBhai_Role_Taxonomy_Master_2026-08-09.md
  docs/reference/BADABHAI-CODEBASE-INTELLIGENCE-REPORT.md
The first two were items 1 and 2 of this list until 2026-09-04, and NEITHER WAS IN THE
REPOSITORY -- no agent could read what it was told to obey, so nothing forced the phase
briefs written from them to reconcile against docs/decisions/. That is how a spec dated
2026-09-01 came to order work that ADR-0036 had retired on 2026-07-31. Each file now
carries a header naming the claims in it that are already superseded. Read the header
before the body.

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
