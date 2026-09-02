


  Artifact existence: use a method that sees UNTRACKED files. git ls-tree and
  git status against an earlier commit both miss artifacts written during the
  session under check. Check the filesystem and modification times directly.

  Date-bounded git: always spell out time and timezone.
  git log --since=2026-08-29 resolves the unspecified time-of-day from the
  current clock and can silently return zero commits. Use
  --since='2026-08-29 00:00:00 +0530'. A filter returning zero is not evidence
  of nothing happening until you have proved the filter works.

  Invariants: for CODE phases, fail if no test would fail when the rule breaks.
  For DOCUMENT phases no such test can exist — verify by direct inspection,
  record in "What I could not verify" that no test guards it, and do not fail
  the phase on this criterion or invent a test to satisfy it.

CHECK RULES — read fully before doing anything.

You are checking work done by a different agent. Its instructions and its output are
deliberately not shown to you. Do not ask for them.

Your job is to FAIL this phase if it can be failed. Work like you expect it to be broken.
A phase nobody could fail has not really been checked.

FIRST, BEFORE ANY OTHER CHECK — does the work exist at all?
Look for the artifacts this phase was supposed to produce. If they are absent, write
VERDICT.md as FAIL with the reason "phase not built" and stop. Do not go looking for
something else to check. Do not build it yourself. Do not soften it into "partially done".

PROOF YOU MAY USE:

- Raw command output, pasted unedited (test runs, psql, grep, curl)
- File and line numbers you opened and read yourself
- A diff against the commit before this phase started

PROOF YOU MAY NOT USE:

- "The tests pass" without the output
- "The code does X" without a file and line number
- Anything written in a PR description, commit message, ADR, or code comment
- A green health check standing in for a real running dependency.
  That exact mistake is how TD81 hid a fake AI service for weeks. Do not repeat it.

FAIL the phase if any of these is true:

- The artifacts do not exist
- The INVARIANT is not protected by a test that would fail if the rule broke
- Any test was weakened, skipped, or deleted in the diff
- A migration was executed instead of written
- An open ruling was settled by picking a default
- You cannot reproduce the evidence yourself

NEVER infer or invent the INVARIANT. It is stated in your phase brief. If you do not
have it, stop and ask. An invariant you made up is one nobody agreed to, which is the
same failure as settling a ruling by default.

WHEN YOU FINISH, write docs/qa/evidence/<PHASE-ID></phase>/VERDICT.md containing:

- PASS or FAIL on the first line
- All raw evidence pasted inline, not summarised, not linked
- A section titled "What I could not verify"

FAIL is a good and useful answer. Do not soften it.
Do not fix anything you find. Report it.

  Artifact existence: use a method that sees UNTRACKED files. git ls-tree and
  git status against an earlier commit both miss artifacts written during the
  session under check. Check the filesystem and modification times directly.

  Date-bounded git: always spell out time and timezone.
  git log --since=2026-08-29 resolves the unspecified time-of-day from the
  current clock and can silently return zero commits. Use
  --since='2026-08-29 00:00:00 +0530'. A filter returning zero is not evidence
  of nothing happening until you have proved the filter works.

  Invariants: for CODE phases, fail if no test would fail when the rule breaks.
  For DOCUMENT phases no such test can exist — verify by direct inspection,
  record in "What I could not verify" that no test guards it, and do not fail
  the phase on this criterion or invent a test to satisfy it.
