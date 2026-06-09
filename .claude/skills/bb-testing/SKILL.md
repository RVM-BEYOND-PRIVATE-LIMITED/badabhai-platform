---
name: bb-testing
description: Decide and write the right tests for a BadaBhai change — unit, contract, e2e — with explicit assertions on event emission and the no-PII privacy guarantee. Use during the Testing stage.
---

# Skill: Testing

**Goal.** Verify a change the right amount at the right layer, and lock the privacy
and event invariants with explicit assertions.

**Inputs.** The change + acceptance criteria; the event registry and contracts;
existing test patterns (Vitest in TS packages, pytest in the AI service, the
[`tests/`](../../../tests/) contract/e2e/security suites).

**Process.**
1. Pick the layer: unit for logic, contract for boundaries, e2e for the
   worker-profiling happy path.
2. Cover the highest-risk paths first; include failure/edge cases.
3. Add **explicit assertions** that important endpoints emit the correct validated
   event, and that privacy-critical paths leak no PII (pseudonymization, payloads).
4. Keep tests deterministic (no real network/time/randomness leaking in).
5. Run the suite; confirm green; state what is and isn't covered.

**Checklist.**
- [ ] New behavior has a new test at the right layer.
- [ ] Event-emission asserted where required.
- [ ] Privacy paths assert no PII leaks; pseudonymization fail-closed tested.
- [ ] Failure/edge cases covered, not just the happy path.
- [ ] Deterministic and fast.
- [ ] Coverage gaps stated honestly.

**Expected Output.** New/updated passing tests, a short test plan, and an explicit
statement of remaining gaps.

**Failure Conditions.** Only happy-path tests; no event/privacy assertions; flaky
or non-deterministic tests; claiming a path is covered when it isn't.
