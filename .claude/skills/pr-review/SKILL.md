---
name: pr-review
description: Structured code review before merge — correctness, BadaBhai invariants (events, no-PII, typed contracts, repo/service split), never-trust-body-IDs, reuse, and tests. The playbook entry point for review; follows bb-code-review.
---

# Skill: PR Review

**Goal.** Be the single pre-merge gate for a lean team: block correctness bugs and invariant
violations, and keep the codebase consistent.

**Inputs.** The diff; the PR description + template; the contracts (events, DTOs, schema) and
surrounding conventions; the file risk classes in
[claude-working-guide](../../../docs/claude-working-guide.md).

**Process.**

1. Understand intent; read the diff for correctness, edge cases, error handling.
2. Invariants: important endpoints emit a validated event; **no PII** in events/logs/LLM input;
   pseudonymization fail-closed; Zod/Pydantic at boundaries; no `any`; repository/service split intact.
3. **Authorization:** the actor is derived from the session, **never** from a body-supplied
   worker/payer/company id (IDOR). Flag any handler that trusts `dto.*_id` for access.
4. Quality: reads like surrounding code; no dead/duplicated code; reuse shared packages.
5. Tests: new behavior has tests; privacy/event paths assert no-PII + emission; PR template honest.
6. Rank findings by severity; approve only when the invariants genuinely hold.

**Checklist.**

- [ ] Correct; edge cases + errors handled.
- [ ] Events emitted where required; no PII in events/logs/LLM input.
- [ ] No trust in body-supplied IDs for authorization.
- [ ] Validation at boundaries; no `any`; repo/service split intact.
- [ ] Reads like surrounding code; no dead code/duplication.
- [ ] Tests cover new behavior; `pnpm lint/typecheck/test/build` (+ ruff/pytest) green.

**Expected Output.** Approve / request-changes with specific file:line findings ranked by severity.

**Failure Conditions.** Rubber-stamping; missing a PII leak or a skipped event; approving an IDOR;
vague non-actionable findings.

**See also.** [`bb-code-review`](../bb-code-review/SKILL.md) · agent
[`code-reviewer`](../../agents/code-reviewer.md).
