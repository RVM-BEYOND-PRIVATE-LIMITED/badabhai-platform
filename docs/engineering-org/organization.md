# The BadaBhai Engineering Organization

**Status:** Organization of record. Supersedes the ad-hoc agent roster for questions of
**ownership**. Effective 2026-08-04.

This document defines the **permanent** engineering organization for this repository. It
describes long-lived *engineering roles*, not the current human team. People change; these
seven domains and their boundaries do not.

The organization is deliberately small: **seven engineers, each owning exactly one
technical domain, end to end.** Every path in the repository has exactly one primary owner
([ownership-map.md](./ownership-map.md)). No two engineers own the same thing.

---

## 1. The seven engineers

| # | Engineer | Agent | Domain | Owns code? |
| - | -------- | ----- | ------ | ---------- |
| 1 | **Chief Software Architect** | [`system-architect`](../../.claude/agents/system-architect.md) | Architecture, contracts, boundaries, ADRs | Contracts + docs only |
| 2 | **Backend Platform Engineer** | [`backend-engineer`](../../.claude/agents/backend-engineer.md) | `apps/api`, `packages/db`, Redis/BullMQ, data layer | Yes |
| 3 | **AI Systems Engineer** | [`ai-engineer`](../../.claude/agents/ai-engineer.md) | `apps/ai-service` — privacy gateway, routing, prompts | Yes |
| 4 | **Frontend Product Engineer** | [`frontend-engineer`](../../.claude/agents/frontend-engineer.md) | `apps/web`, `apps/payer-web`, `apps/admin-web` | Yes |
| 5 | **Mobile Product Engineer** | [`mobile-engineer`](../../.claude/agents/mobile-engineer.md) | `apps/worker-app`, `apps/payer-app` | Yes |
| 6 | **DevOps & Reliability Engineer** | [`devops-engineer`](../../.claude/agents/devops-engineer.md) | CI/CD, infra, deploy, observability, secrets | Yes (infra) |
| 7 | **QA & Verification Engineer** | [`qa-engineer`](../../.claude/agents/qa-engineer.md) | `tests/`, verification, release readiness | Yes (tests) |

Each is **full-stack inside their own domain** — planning, schema, implementation, tests,
docs, performance, and maintenance. None of them is a task executor; each is expected to
operate at Senior/Staff/Principal level and to say "no, here is the better design."

---

## 2. The gate bench (no file ownership)

The seven above are the only engineers who **own** repository paths. The remaining agents
in [`.claude/agents/`](../../.claude/agents/) are **functions**, not domains: they own no
files, cannot be a primary owner, and are invoked *by* a domain owner or by the Architect.

| Function agent | Role | Blocking? |
| -------------- | ---- | --------- |
| [`security-engineer`](../../.claude/agents/security-engineer.md) | PII / pseudonymization / DPDP gate | **Yes — blocking** |
| [`security-reviewer`](../../.claude/agents/security-reviewer.md) | Authz / IDOR / secrets review | **Yes — blocking** |
| [`code-reviewer`](../../.claude/agents/code-reviewer.md) | Pre-merge correctness + invariants | **Yes — blocking** |
| [`migration-reviewer`](../../.claude/agents/migration-reviewer.md) | Migration / RLS safety | **Yes — blocking** |
| `performance-engineer` · `test-planner` · `debugging-engineer` · `refactoring-engineer` · `technical-writer` · `product-manager` · `design-engineer` · `database-architect` | Advisory specialists a domain owner calls into their own work | No |

> **Advisory scope (binding on the whole bench).** They modify code only inside the invoking
> engineer's owned paths and act on behalf of that engineer. No advisor may become an independent
> repository owner, span two owners' domains in one pass, or land a change on its own authority.
> The four blocking gates are **read-only** and implement nothing: when a finding warrants a
> register entry, the gate states it and the owning engineer logs it.

> **Deliberate deviation, stated openly.** The seven-role brief has no Security Engineer —
> security is distributed across the roles ("security by default"). This repository cannot
> adopt that as-is: [CLAUDE.md §2](../../CLAUDE.md) invariants #2/#3/#6 and the §6 merge
> gates make an independent privacy review **mandatory** for any PII/AI/auth change. The
> resolution is that security is **both**: every one of the seven owns security inside their
> domain *and* `security-engineer` remains a non-owning blocking gate. Because it owns no
> files, the "one primary owner per path" rule is preserved.

---

## 3. Ownership rules

1. **One primary owner per path.** [ownership-map.md](./ownership-map.md) is the source of
   truth. If a new path has no owner, that is a bug — the Architect assigns one before merge.
2. **Stay in your domain.** Do not modify another engineer's paths. Request the change
   through them.
3. **Never redesign another domain.** You may state a requirement ("I need this field on the
   response"); you may not dictate their internals ("add this column to that table").
4. **Cross-domain work is parallel, not serialized through one engineer.** Each owner
   implements their own side against an agreed contract.
5. **Contracts are the Architect's.** `packages/event-schema` and `packages/ai-contracts`
   are cross-service contracts; changing one is an architecture action, not a feature action.
6. **Co-located tests belong to the domain owner.** Only cross-cutting suites under
   [`tests/`](../../tests/) belong to QA.
7. **Disagreements escalate to the Chief Software Architect**, whose call is final for
   architecture. Anything touching a §2 invariant, the locked stack, destructive migrations,
   real provider keys/spend, or production data escalates past the Architect **to the human
   owner**.

---

## 4. Collaboration model

Every engineer analyzes an incoming request from their own domain first and answers four
questions — this is the standard hand-off format between engineers:

1. **What changes inside my ownership?**
2. **What do I need from another engineer?** (name the engineer and the contract)
3. **What risk should the team know about?** (invariants, migrations, gates, blast radius)
4. **What must be reviewed before merge?** (which gate agents, which evidence)

The Chief Software Architect synthesizes these four answers from every participating
engineer into a single implementation strategy, then the owners build in parallel.

---

## 5. Feature lifecycle

```
Requirements
     ↓
Chief Software Architect  ── scope, boundaries, ADR if structural, contracts first
     ↓
Engineering Discussion    ── each owner answers the 4 questions
     ↓
Parallel Implementation   ── each owner builds inside their own paths
     ↓
Cross-Domain Review       ── owners review each other's seams; gate agents run
     ↓
QA Verification           ── cross-cutting suites, clean-environment run (invariant #10)
     ↓
Production Readiness      ── DevOps: deploy path, rollback, monitoring, secrets
     ↓
Merge
```

**Contracts precede implementation.** The event payload, the API shape, and the DB columns
are agreed *before* anyone writes code against them — otherwise two engineers build two
different products and discover it at integration.

**Merge bar** is [quality-gates.md](./quality-gates.md) + [CLAUDE.md §6](../../CLAUDE.md).
**Workstream bar** is the ten-point Definition of DONE in CLAUDE.md §6 — architectural and
security verification, mutation testing, clean-environment verification, DR, runbook,
rollback, performance, docs, production-readiness checklist. "All tests pass" is not DONE.

---

## 6. Engineering standards every engineer holds

SOLID · DRY · KISS · YAGNI · Clean Architecture · domain-driven boundaries · composition
over inheritance · high cohesion, low coupling · type safety at every boundary (Zod in TS,
Pydantic in Python) · observability by default · security by default · performance
awareness · maintainability over shortcuts.

Two repository-specific standards outrank personal preference:

- **A passing test is evidence only once you have seen it fail.** Mutate the guard, the
  lookup, and the error branch; report any mutation that survived.
- **A long-lived developer database is not evidence.** A feature is reproducible from an
  empty database via an executable runbook, or it is incomplete (invariant #10).

---

## 7. Where this fits

- **Invariants and merge gates:** [CLAUDE.md](../../CLAUDE.md) — outranks this document.
- **Decisions of record:** [docs/decisions/](../decisions/) (ADRs).
- **Path ownership:** [ownership-map.md](./ownership-map.md).
- **Process:** [development-workflow.md](./development-workflow.md) · [quality-gates.md](./quality-gates.md).
- **Agent definitions:** [`.claude/agents/`](../../.claude/agents/).
