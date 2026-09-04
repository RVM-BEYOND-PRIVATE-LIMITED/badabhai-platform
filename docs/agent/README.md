# How to run an agent session

Two sessions per phase. Build, then check. Always separate. Always fresh.

## 1. Get the commit id

    git fetch origin
    git rev-parse origin/main
    git rev-parse HEAD

If the last two differ, stop. Rebase or state the delta explicitly in the session
opener. A phase built on a stale local branch collides with work already merged.

## 2. Build session — open a NEW session, send this:

    Read docs/agent/BUILD_RULES.md and docs/agent/phases/P1_BUILD.md.
    Follow both for this whole session.
    HEAD is <paste commit id>.

Replace P1 with whichever phase. That is the only thing you change.

## 3. Check session — open ANOTHER NEW session, send this:

    Read docs/agent/CHECK_RULES.md and docs/agent/phases/P1_CHECK.md.
    Follow both for this whole session.
    HEAD is <paste commit id>.

The check agent must never see the build session. That is the entire point.

## 4. Result

The check agent writes docs/qa/evidence/P1/VERDICT.md.
PASS means move on. FAIL means fix it and check again with a fresh agent.

## Order

**P0–P12 ARE CLOSED (2026-09-05), superseded by the E-chain**
(docs/decisions/E_CHAIN_DESIGN_2026-09.md). Do not start any P-phase. Every P*_BUILD.md and
P*_CHECK.md carries its own closure block naming what, if anything, that phase dropped.

TWO EXCEPTIONS, reopened by owner ruling and both STANDALONE — neither is part of the
E-chain and neither blocks it:
  P9  the verification visibility gate. Ruled a GATE, unbuilt, and an unverified posting is
      visible to every worker today. Sequenced AFTER E2 — it was "after E4" until the
      2026-09-05 reordering; it follows the chain, not one phase of it.
  P8  job-posting drafts and checkpoints — and the home of ADR-0035 Amendment 1, which names
      that brief by path.

THE LIVE CHAIN, corrected 2026-09-05 (owner ruling — E0 moved AHEAD of E4; see below):

  #1425 → E0 → E4 → E1 → E2,  then P9.   E3 is already built.

  #1425 is a PREREQUISITE, not a phase — it is open, and until it lands a completed trade form
      derives zero `worker_skill` rows, so E2 has no supply to search.
  E0  The relay. A credit currently buys a handle that resolves to nothing. Its item 0
      (correcting live, false payer-facing copy) did NOT wait: raised as issue #1430,
      2026-09-05. Its two rulings are SIGNED (docs/decisions/E0_RELAY_DECISION_2026-09.md
      §A, §B); what gates it now are the THREE BLOCKING CONDITIONS in E0_BUILD.md, above the
      phase title. E0 does not ship with two of three.
  E4  Worker opt-out — the findability half. It carries the DPDP notice copy for
      `employer_sharing` AND for the ninth, messaging purpose ruled in on 2026-09-05.
  E1  The posting form asks once, and every answer reaches the row.
  E2  Candidate search. BLOCKED until ADR-0040 is signed and until E4 and #1425 land —
      before those, a correct E2 returns zero rows.
  E3  Credits and unlock — a RE-POINT of shipped surfaces, not a build.

WHY E0 MOVED IN FRONT OF E4. Ruling R-E3 originally put E4 first, so a visible-by-default
worker would have an exit before a contact channel existed. That premise measured false:
`wants` appears zero times in apps/api/src/unlocks/unlocks.service.ts, so E4's opt-out ends
findability and leaves an already-granted unlock live for its remaining 14 days. E0-after-E4
would still have landed messages on workers who could not stop them. The exit R-E3 wanted is
now E0's conditions C-2 and C-3.

## Before every phase

1. Did the last VERDICT.md say PASS? If not, do not start the next phase.
   NOTE: docs/qa/evidence/P0/VERDICT.md is FAIL and does NOT gate the E-chain. It gated the
   P-chain, which is closed; P0_CHECK is now structurally unpassable because the owner signed
   two rulings on a worksheet that check requires to be unsigned. The E-chain starts clean.
2. Re-run git rev-parse HEAD. Use the new number.
3. Read PARKED.md. Anything now blocking becomes a ruling, not a quiet fix.
4. Did any of R1–R7 get answered? If so, update BUILD_RULES.md. R1 and R4-d are SIGNED;
   R7 is the one the E-chain waits on (worksheet:794), and ADR-0040 carries it.
5. Fresh session. Never continue an old one.
