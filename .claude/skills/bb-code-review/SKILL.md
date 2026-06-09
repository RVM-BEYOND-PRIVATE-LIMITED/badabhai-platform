---
name: bb-code-review
description: Review a BadaBhai diff before merge for correctness and the platform invariants (events, no-PII, typed contracts, repo/service split, readability, reuse). Use at the Code review gate. Complements the built-in /code-review with BadaBhai-specific invariants.
---

# Skill: Code Review

**Goal.** Catch correctness bugs and invariant violations before `main`, and keep
the codebase consistent — the single-reviewer gate for a small team.

**Inputs.** The diff; the PR description + template; the relevant contracts
(events, DTOs, schema) and the surrounding conventions.

**Process.**
1. Understand the intent; read the diff for correctness, edge cases, error
   handling.
2. Check the invariants: important endpoints emit a validated event; **no PII in
   events/logs/LLM input**; pseudonymization stays fail-closed; Zod/Pydantic at
   boundaries; no `any`; repository/service separation respected.
3. Check quality: reads like the surrounding code; no dead/commented-out code; no
   duplication that should be reused from a shared package.
4. Confirm tests exist for new behavior and the PR template is honestly filled.
5. Rank findings by severity; approve only when the invariants genuinely hold.

**Checklist.**
- [ ] Correct, with edge cases and errors handled.
- [ ] Events emitted where required; no PII in events/logs/LLM input.
- [ ] Validation at boundaries; no `any`; repo/service split intact.
- [ ] Reads like surrounding code; no dead code/duplication.
- [ ] Tests cover the new behavior; PR template honest.
- [ ] `pnpm lint/typecheck/test/build` (and pytest/ruff) green.

**Expected Output.** Approve / request-changes with specific, file:line findings
ranked by severity.

**Failure Conditions.** Approving with an unaddressed invariant violation; vague
non-actionable findings; missing a PII leak or a skipped event; rubber-stamping
without reading the diff.
