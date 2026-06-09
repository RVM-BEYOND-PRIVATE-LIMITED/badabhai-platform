# BadaBhai Engineering Organization

This directory defines **how we build BadaBhai** — the operating model that wraps
the codebase. It is deliberately thin: BadaBhai already has a locked stack, an
accepted infra ADR, an event-first architecture, and a privacy-by-construction
AI boundary. This layer adds the *people-and-process* scaffolding a 2–5 person
team needs to keep that foundation intact as the product grows.

> **Reading order for a new contributor:** root [`README.md`](../../README.md) →
> [architecture overview](../architecture/overview.md) → [ADR-0001](../decisions/0001-mvp-infra-decision.md)
> → [development workflow](./development-workflow.md) → [quality gates](./quality-gates.md)
> → the [registers](../registers/) for current state.

---

## What's here

| Area | Location | Purpose |
| ---- | -------- | ------- |
| **Agents** | [`.claude/agents/`](../../.claude/agents/) | 15 specialized engineering roles Claude can act as, each scoped to a slice of BadaBhai with explicit decision boundaries and escalation rules. |
| **Skills** | [`.claude/skills/`](../../.claude/skills/) | 16 reusable, checklist-driven procedures (review, design, debug, deploy, …). All namespaced `bb-*` to avoid shadowing Claude Code built-ins. |
| **Workflow** | [development-workflow.md](./development-workflow.md) | The path every change travels: idea → requirements → architecture → DB → API → build → test → security → performance → deploy → monitor. |
| **Quality gates** | [quality-gates.md](./quality-gates.md) | The non-negotiable checks before merge, calibrated for a small team (automation-first, one human reviewer). |
| **Registers** | [`docs/registers/`](../registers/) | Living memory: decisions, architecture, risks, tech debt, future work, open questions, team decisions. |

---

## Operating principles (inherited, non-negotiable)

These come from [ADR-0001](../decisions/0001-mvp-infra-decision.md), the
[architecture overview](../architecture/overview.md), and the root README. Every
agent and skill is bound by them:

1. **Event-first.** Every important endpoint emits an event that validates against
   [`@badabhai/event-schema`](../../packages/event-schema/). The `events` table is
   the spine and audit log.
2. **Privacy by construction.** The [pseudonymization gateway](../ai/pseudonymization.md)
   runs before *every* LLM call and **fails closed**. Phone, full name, address,
   employer names, and ID-doc tokens never reach an LLM. PII lives only in `workers`.
3. **LLMs assist, never decide.** AI helps profile, canonicalize, and explain. It
   **never ranks, rejects, or decides matches.** That is the (future) deterministic
   Reach Engine's job.
4. **API-first AI, gated.** No self-hosted LLM at launch. All model access goes
   through the LiteLLM adapter, behind `AI_ENABLE_REAL_CALLS` (default `false`).
5. **Typed contracts everywhere.** TypeScript strict + Zod (TS) and Pydantic
   (Python). Runtime validation at every boundary.
6. **DPDP + worker protection are launch gates,** not afterthoughts.
7. **Lean and reversible.** Optimize for a small team and clean seams (events,
   packages) over premature scale. Decisions should stay cheap to reverse.

If a task would violate one of these, the principle wins — escalate rather than
work around it.

---

## Current context (kept current — see registers for detail)

- **Product:** AI placement-team for blue/grey-collar India; first vertical is
  industrial manufacturing (CNC/VMC).
- **Phase:** 1 — Worker Profiling + Profile Generation. Employer posting, unlock,
  payments, Reach Engine ranking are Phase 2+.
- **Revenue model:** employers/agencies pay to **unlock** profiled candidates;
  workers are free. (Drives the deferred unlock/payments work.)
- **Team:** small (2–5). Process assumes automation-first checks + one human reviewer.
- **Immediate priority:** close the Phase-1 "next" items — move extraction/
  transcription to BullMQ jobs, real OTP provider, finalize Supabase RLS, real
  Sarvam STT, enable real LLM in staging.

---

## How to use this layer

- **As Claude (or a contributor):** before acting on a task, adopt the relevant
  **agent** persona for its boundaries, invoke the relevant **skill** for the
  procedure, then run the change through the **workflow** and clear the **gates**.
- **When a decision is made:** record it (ADR for heavyweight/architectural;
  [team-decisions](../registers/team-decisions.md) for lightweight).
- **When you take a shortcut:** log it in [tech-debt](../registers/tech-debt-register.md).
- **When you hit something unknown:** log it in [open-questions](../registers/open-questions.md).

The registers are the project's working memory. Keeping them current is part of
"done," not optional cleanup.
