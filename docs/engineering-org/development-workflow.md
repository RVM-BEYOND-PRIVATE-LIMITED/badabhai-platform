# Development Workflow

Every change to BadaBhai travels this path. It is scaled to the size of the
change — a typo fix skips most of it; a new event or table goes through all of
it. The point is not ceremony; it is that **nobody has to remember the privacy,
event, and migration rules** because the workflow and [quality gates](./quality-gates.md)
enforce them.

```
Idea → Requirements → Architecture → Database → APIs → Implementation
     → Testing → Security review → Performance review → Deployment → Monitoring
```

---

## Change sizing

Pick the lane first; it determines how much of the workflow applies.

| Lane | Examples | Required stages |
| ---- | -------- | --------------- |
| **Trivial** | docs, comments, copy, lint fix, dependency bump | Implementation → Testing (CI) → review |
| **Standard** | new endpoint, new screen, service/repo change, new event | All stages; lightweight architecture (a paragraph in the PR) |
| **Heavyweight** | new table/migration, schema/event-version change, new external provider, auth/RLS, anything touching the AI privacy boundary | All stages + an ADR + named security sign-off |

When unsure, treat it as the larger lane.

---

## Stages

### 1. Idea → 2. Requirements
- Owner: **Product Manager agent**.
- Output: a short problem statement — who is it for (worker / ops / future
  employer), what changes for them, how we'll know it worked. For anything beyond
  trivial, run the [`bb-feature-planning`](../../.claude/skills/bb-feature-planning/SKILL.md) skill.
- Gate to proceed: the change is in (or consciously expanding) the current phase
  scope. Phase 2 work (employer/unlock/payments/Reach Engine) is **not** started
  without an explicit decision logged in [team-decisions](../registers/team-decisions.md).

### 3. Architecture
- Owner: **System Architect agent**. Skill: [`bb-architecture-review`](../../.claude/skills/bb-architecture-review/SKILL.md).
- Confirm the change respects the seams: event-first, repository/service
  separation, the AI privacy boundary, typed contracts. Heavyweight changes get
  an [ADR](../decisions/).
- Output: a decision on where the change lives and which contracts it touches.

### 4. Database
- Owner: **Database Architect agent**. Skill: [`bb-database-design`](../../.claude/skills/bb-database-design/SKILL.md).
- Schema is authored in Drizzle (`packages/db/src/schema.ts`) — the source of
  truth. Generate the migration (`pnpm db:generate`), review the SQL, confirm
  it's backward-compatible (expand → migrate → contract for anything risky).
- **PII rule:** new PII columns belong only in `workers`. `events`, `ai_jobs`,
  and `audit_logs` carry ids/hashes only.

### 5. APIs
- Owner: **Backend Engineer agent**. Skill: [`bb-api-design`](../../.claude/skills/bb-api-design/SKILL.md).
- Contract first: Zod DTOs, repository/service split, DI. **Every important
  endpoint emits a validated event** from [`@badabhai/event-schema`](../../packages/event-schema/).
  New event? Register it in `registry.ts`, add the payload, add the test.

### 6. Implementation
- Owner: the relevant engineer agent (**Backend / Frontend / Mobile / AI**).
- Match the surrounding code: TS strict, no `any`, runtime validation at
  boundaries. AI changes go through the **AI Engineer agent** and must keep the
  pseudonymization gateway fail-closed.

### 7. Testing
- Owner: **QA Engineer agent**. Skill: [`bb-testing`](../../.claude/skills/bb-testing/SKILL.md).
- Unit + the relevant contract/e2e tests under [`tests/`](../../tests/). The
  privacy-critical paths (pseudonymization, event PII) get explicit assertions.
- CI runs `pnpm lint / typecheck / test / build`, plus `pytest`/`ruff` for the AI
  service. All must be green.

### 8. Security review
- Owner: **Security Engineer agent**. Skill: [`bb-security-review`](../../.claude/skills/bb-security-review/SKILL.md).
- Mandatory for heavyweight changes and anything touching auth, RLS, secrets,
  PII, or the AI boundary. Confirm: no raw PII in events/logs/LLM input, no
  secrets committed, fail-closed preserved.

### 9. Performance review
- Owner: **Performance Engineer agent**. Skill: [`bb-performance-optimization`](../../.claude/skills/bb-performance-optimization/SKILL.md).
- For changes to query patterns, hot paths, the chat/AI loop, or anything that
  will run per-worker at scale. Check N+1s, indexes, payload sizes, and that slow
  work (extraction, transcription) moves to BullMQ jobs rather than blocking.

### 10. Deployment
- Owner: **DevOps Engineer agent**. Skill: [`bb-deployment`](../../.claude/skills/bb-deployment/SKILL.md).
- Migrations applied before the code that needs them. Feature flags / env gates
  (`AI_ENABLE_REAL_CALLS`) default safe. Rollback path written in the PR.

### 11. Monitoring
- Owner: **DevOps / Performance agents**. Skill: [`bb-monitoring`](../../.claude/skills/bb-monitoring/SKILL.md).
- Structured logs with request id; events flowing; AI jobs observable (Langfuse
  placeholder today). Confirm the change is visible in ops before calling it done.

---

## Branch & PR mechanics

- Branch off `main` (never commit straight to `main`).
- One logical change per PR. Fill the [PR template](../../.github/pull_request_template.md)
  fully — its sections map onto these stages (DB impact, event impact, security/
  privacy, AI/LLM impact, rollback).
- Conventional commits (`feat(api):`, `fix(db):`, `test(e2e):`, `docs:`) — match
  the existing history.
- Merge only when the [quality gates](./quality-gates.md) are green.

## Definition of Done

A change is done when: code merged, tests green in CI, events emitting and
validating, docs/README touched where needed, registers updated (tech-debt /
decisions / open-questions as applicable), and the change is observable in ops.
