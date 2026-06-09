---
name: bb-debugging
description: Systematically investigate a failing test or bug in BadaBhai — reproduce, isolate, fix minimally, and lock it with a regression test. Use when something is broken and the cause isn't obvious. Pair with bb-root-cause-analysis for deeper failures.
---

# Skill: Debugging

**Goal.** Convert a symptom into a confirmed cause and a minimal, tested fix —
without weakening any invariant.

**Inputs.** The symptom / stack trace / failing test; the code path; structured
logs (with request id); the `events` audit trail.

**Process.**
1. Reproduce deterministically — ideally capture it as a failing test.
2. Narrow the surface: bisect the path; use the event trail and logs to follow the
   request id; check the type/validation boundaries first.
3. Form a hypothesis for the root cause; confirm it by experiment, not assumption.
4. Apply the **minimal** fix that addresses the cause (not the symptom).
5. Add a regression test that fails before and passes after.
6. If it implies a risk or shortcut, log it in the registers.

**Checklist.**
- [ ] Deterministic reproduction exists.
- [ ] Root cause confirmed by evidence, not guessed.
- [ ] Fix is minimal and targets the cause.
- [ ] Regression test added (red→green).
- [ ] No test disabled, validation loosened, or boundary bypassed to pass.
- [ ] For privacy/AI failures: confirmed it failed *closed*; escalated if not.

**Expected Output.** Stated root cause, the minimal fix, a regression test, and any
register entry it implies.

**Failure Conditions.** Fixing the symptom not the cause; suppressing the failure
(skip/disable/loosen); guessing without reproduction; missing that a fail-open
occurred.
