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

P0 first — it produces the RVM decision sheet, and rulings R1–R4 set permanent
skill_id numbers that can never be changed later.

Then two independent chains:
  Matching:  P1 → P2 → P3 → P4 → P5 → P6 → P7
  Posting:   P8 → P9 → P10 → P11 → P12
  PX runs alongside everything from day one.

## Before every phase

1. Did the last VERDICT.md say PASS? If not, do not start the next phase.
2. Re-run git rev-parse HEAD. Use the new number.
3. Read PARKED.md. Anything now blocking becomes a ruling, not a quiet fix.
4. Did any of R1–R7 get answered? If so, update BUILD_RULES.md.
5. Fresh session. Never continue an old one.
