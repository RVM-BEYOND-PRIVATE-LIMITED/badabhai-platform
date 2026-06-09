---
name: bb-refactoring
description: Improve the structure of existing BadaBhai code without changing behavior — reduce duplication, clarify names, tighten types, pay down logged tech debt. Keep it separate from feature changes. Use when code is hard to change safely.
---

# Skill: Refactoring

**Goal.** Make code easier to change while keeping behavior identical and the
invariants intact.

**Inputs.** The target code + its tests; the
[tech-debt register](../../../docs/registers/tech-debt-register.md); the
surrounding conventions and shared packages.

**Process.**
1. Confirm coverage: existing tests pin the current behavior. If thin, add
   characterization tests first (with QA).
2. Make the structural change: reduce duplication, clarify names, tighten types
   (remove `any`), extract reuse into the right package.
3. Keep it behavior-preserving — run the tests before and after; they must stay
   green with no change in outcomes.
4. Keep the refactor **separate from any feature change** for clean review/rollback.
5. If paying down a debt item, mark its register row **Paid** with the PR.

**Checklist.**
- [ ] Behavior unchanged; tests green before and after.
- [ ] Characterization tests added first where coverage was thin.
- [ ] No public contract / event payload / behavior change smuggled in.
- [ ] Pseudonymization boundary untouched (or Security looped in).
- [ ] Result is simpler, not just different.
- [ ] Tech-debt register updated if applicable.

**Expected Output.** A small, behavior-preserving structural improvement with green
tests and any tech-debt row marked Paid.

**Failure Conditions.** Behavior changes under the "refactor" label; mixed with a
feature change; refactoring untested code without adding tests; touching the
privacy boundary unreviewed.
