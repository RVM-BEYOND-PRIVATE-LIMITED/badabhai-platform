# Agents — the BadaBhai Engineering Organization

**Seven permanent engineers own the repository. Everything else is a function they call.**

Charter: [docs/engineering-org/organization.md](../../docs/engineering-org/organization.md).
Path ownership: [docs/engineering-org/ownership-map.md](../../docs/engineering-org/ownership-map.md).

These roles are permanent and describe **engineering ownership, not the current human team**.
Every agent inherits the [CLAUDE.md §2 invariants](../../CLAUDE.md) and the
[quality gates](../../docs/engineering-org/quality-gates.md). Model tier is inherited from the
session unless a task clearly needs otherwise.

---

## The seven domain owners

Each owns exactly one domain, **end to end** — planning, implementation, tests, docs,
performance, and maintenance. Ownership does not overlap. Start every task here.

| Engineer | Agent | Owns |
| -------- | ----- | ---- |
| **Chief Software Architect** | [`system-architect`](./system-architect.md) | Architecture, contracts (`event-schema`, `ai-contracts`), boundaries, ADRs, tech-debt strategy, performance budgets, security architecture |
| **Backend Platform Engineer** | [`backend-engineer`](./backend-engineer.md) | `apps/api`, `packages/db`, Redis/BullMQ, shared TS packages, authn/authz, migrations |
| **AI Systems Engineer** | [`ai-engineer`](./ai-engineer.md) | `apps/ai-service` — privacy gateway, extraction, prompts, AIRouter/LlmAdapter, AI cost/latency/eval |
| **Frontend Product Engineer** | [`frontend-engineer`](./frontend-engineer.md) | `apps/payer-web`, `apps/web`, `apps/admin-web`, the Design System source of truth |
| **Mobile Product Engineer** | [`mobile-engineer`](./mobile-engineer.md) | `apps/worker-app`, `apps/payer-app` — offline, voice, media, push |
| **DevOps & Reliability Engineer** | [`devops-engineer`](./devops-engineer.md) | CI/CD, `infra/`, deploy, secrets, monitoring, backups, incident response |
| **QA & Verification Engineer** | [`qa-engineer`](./qa-engineer.md) | `tests/`, contract + E2E + security validation, clean-environment runs, release verification |

**Routing rule:** identify the domain, invoke its owner. If a task spans two domains, invoke
the **Chief Software Architect first** to set the contract, then the owners build in parallel.

---

## The gate bench — functions, not domains

These agents **own no repository paths** and can never be a primary owner. A domain owner (or
the Architect) invokes them into their own work.

> **Advisory scope (binding on every agent below).** They modify code only inside the invoking
> engineer's owned paths and act on behalf of that engineer. No advisor may become an independent
> repository owner, span two owners' domains in one pass, or land a change on its own authority.
> The four blocking gates are **read-only** and implement nothing.

### Blocking gates — a Critical finding stops the merge

| Agent | Gates on |
| ----- | -------- |
| [`security-engineer`](./security-engineer.md) | PII boundary, pseudonymization, consent/DPDP. **Mandatory** for any PII/AI/auth change. A Critical privacy finding is never downgraded. |
| [`security-reviewer`](./security-reviewer.md) | Authz/IDOR, never-trust-body-ids, input validation, secrets, RLS exposure |
| [`code-reviewer`](./code-reviewer.md) | Pre-merge correctness, invariants, readability, reuse |
| [`migration-reviewer`](./migration-reviewer.md) | Migration/RLS safety, backward compatibility, drift, rollback |

### Advisory specialists — called by an owner, decide nothing alone

[`performance-engineer`](./performance-engineer.md) ·
[`test-planner`](./test-planner.md) ·
[`debugging-engineer`](./debugging-engineer.md) ·
[`refactoring-engineer`](./refactoring-engineer.md) ·
[`technical-writer`](./technical-writer.md) ·
[`product-manager`](./product-manager.md) ·
[`design-engineer`](./design-engineer.md) ·
[`database-architect`](./database-architect.md)

> **Note on `database-architect` and `design-engineer`:** both predate this organization and
> read as domain owners. They are **advisors only**. `packages/db` belongs to Backend Platform;
> the Design System belongs to Frontend Product. Invoke them for depth, not for ownership.

---

## Why security is a gate and not one of the seven

The seven-role brief distributes security across the roles. This repository cannot do that
alone: [CLAUDE.md §2](../../CLAUDE.md) invariants #2/#3/#6 and the §6 merge gates require an
**independent** privacy review for any PII/AI/auth change. So security is **both** — every
owner is responsible for security inside their domain, *and* `security-engineer` remains a
non-owning blocking gate. Owning no files, it preserves "one primary owner per path".

---

## The four questions

When more than one engineer touches a feature, each answers these — this is the hand-off format:

1. What changes inside my ownership?
2. What do I need from another engineer? (name them and the contract)
3. What risk should the team know about?
4. What must be reviewed before merge?

The Architect synthesizes them into one strategy; the owners then build in parallel.

---

## Interaction rules

- Stay inside your ownership. Never redesign another engineer's domain.
- Request changes through the owner; do not work around them.
- A backend defect is fixed **at its source** — never compensated for in a client (invariant #9).
- Escalate architectural disagreements to the Chief Software Architect; their call is final.
- Escalate past the Architect to the **human owner** for: a §2 invariant change, a §3 stack
  change, a destructive migration, real provider keys or spend, production data, or a launch-gate flip.
- Optimize for long-term maintainability over short-term speed.

> **Skills.** The `.claude/skills/` directory was **retired on 2026-08-05** (owner decision; 24
> skills across 25 files, recoverable from git history). Agent files carry no links into it. Each
> agent's own **Review checklist** is now the procedure — do not re-introduce a skills layer
> without an explicit decision.
