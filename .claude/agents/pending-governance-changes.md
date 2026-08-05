# Pending governance changes (blocked on this branch)

Remediation items that cannot be applied from `feat/generalized-profiling` because
their target files are not in this working tree. Each carries the exact replacement
text so it can be applied verbatim on a branch that has `docs/`.

**Owner:** chief-software-architect. **Apply on:** `main`, or on this branch once
`docs/` is restored. **Verify with:**

```bash
git grep -n -E '(ai|backend|frontend|mobile|devops|qa|security|performance|design|refactoring|debugging)-engineer|code-reviewer|security-reviewer|migration-reviewer|test-planner|system-architect|database-architect|product-manager|technical-writer' -- docs/
```

That command must return only historical prose in ADRs and registers — never a
dispatch table a session is told to act on.

---

## PG-1 — `docs/claude-working-guide.md` §6 dispatches to retired agents

**Why it is blocking-shaped:** CLAUDE.md §9 orders every session to read this guide
first and treat it as authoritative. Its §6 table names eight subagent types that no
longer exist, four of which have no 1:1 successor in the seven-role org.

**Current text on `main` (lines ~85–101):**

```markdown
## 6. Skill & agent map (playbook name → what this repo actually has)

The repo's `bb-*` skills and specialist agents already cover the generic playbook roles.
Use these — do not create duplicates:

| Need                               | Skill                                           | Agent                                       |
| ---------------------------------- | ----------------------------------------------- | ------------------------------------------- |
| Safe DB migration                  | `bb-database-design`                            | `database-architect`                        |
| Pre-merge code review              | `bb-code-review` (+ built-in `/code-review`)    | `code-reviewer`                             |
| Security / PII / RLS / IDOR        | `bb-security-review`                            | `security-engineer`                         |
| Observability / logging / alerts   | `bb-monitoring`                                 | `performance-engineer` (for hot paths)      |
| Release readiness & rollback       | `bb-deployment`                                 | `devops-engineer`                           |
| Missing unit/integration/E2E tests | `bb-testing`                                    | `qa-engineer`                               |
| API endpoint design                | `bb-api-design`                                 | `backend-engineer`                          |
| AI / pseudonymization path         | `bb-security-review` + `bb-architecture-review` | `ai-engineer` (mandatory near pseudonymize) |

Full lists: [.claude/skills/](../.claude/skills/) and [.claude/agents/](../.claude/agents/).
```

**Replace with:**

```markdown
## 6. Agent map (need → who owns it)

Seven permanent engineers, one technical domain each. Invoke the owner of the layer
you are in; do not create duplicates.

| Need                                        | Agent                         |
| ------------------------------------------- | ----------------------------- |
| Cross-service design, ADRs, contract shape  | `chief-software-architect`    |
| API endpoints, events, schema and migrations, shared packages | `backend-platform-engineer` |
| AI gateway, prompts, model routing, evals   | `ai-systems-engineer`         |
| Payer portal, ops console, design system    | `frontend-product-engineer`   |
| Flutter worker and payer apps               | `mobile-product-engineer`     |
| CI/CD, images, deploy, secrets, platform, observability | `devops-reliability-engineer` |
| Verification requirements, e2e, release verdict | `qa-verification-engineer` |

Cross-cutting concerns route to the domain that owns the code, with the architect
approving anything that changes a contract, a boundary or a §2 invariant:

| Concern                            | Route to                                                            |
| ---------------------------------- | ------------------------------------------------------------------- |
| Safe DB migration                  | `backend-platform-engineer` (architect approves the shape)          |
| Pre-merge code review              | the owning domain engineer (+ built-in `/code-review`)              |
| Security / PII / RLS / IDOR        | `chief-software-architect` (owns the §2 invariants and rules on them) |
| AI / pseudonymization path         | `ai-systems-engineer` + `chief-software-architect`                  |
| Observability / logging / alerts   | `devops-reliability-engineer` (architect sets the requirement)      |
| Release readiness & rollback       | `devops-reliability-engineer` + `qa-verification-engineer`          |
| Missing unit/integration/E2E tests | the owning domain engineer; `qa-verification-engineer` for cross-service |

Decision authority is four sentences: the architect approves architectural and
security decisions; the domain engineer owns the implementation; DevOps owns the
deployment, environment and CI configuration; QA defines the verification requirement
and verifies the behavior.

Full roster and the code-ownership map: [.claude/agents/README.md](../.claude/agents/README.md).
```

---

## PG-2 — `docs/claude-working-guide.md` read-order cites deleted memory files

Lines 9–11 list `.claude/project-memory.md` and `.claude/team-memory.md` as sources of
truth #2 and #3. Both are deleted in this working tree and staged for deletion.

**Replace the read-order block with:**

```markdown
Sources of truth, in read order:

1. [CLAUDE.md](../CLAUDE.md) — the operating contract (invariants, stack, gates, escalation).
2. [.claude/agents/README.md](../.claude/agents/README.md) — the engineering organization:
   who owns which path, decision authority, the seam map, and dated repository-state caveats.
3. [docs/registers/](registers/) — architecture log, risks, tech debt, open questions.
```

Then fix §1's "Read the three files above first" so it no longer points at the removed
memory files, and drop the `[.claude/skills/](../.claude/skills/)` link wherever it
appears — those skills are not present on any current branch.

---

## PG-3 — `docs/engineering-org/` predates the seven-role org

`docs/engineering-org/README.md`, `development-workflow.md` and `quality-gates.md` on
`main` describe the previous nineteen-agent organization, and
`docs/claude-working-guide.md` §5 links to two of them. They must either be rewritten
against the seven-role model or reduced to a pointer at
[.claude/agents/README.md](./README.md), which is now the single source of truth for
ownership, decision authority and the seam map.

---

## PG-4 — decide whether the `bb-*` skills return

`.claude/skills/` is tracked at `HEAD` and deleted in this working tree; its deletion
is staged with this org change. Every **dispatch** reference has been removed —
CLAUDE.md, the agent specs, the PR template, `ci.yml`, the harness hooks, `.gitignore`
and `.prettierignore` no longer point at a skill.

**Residual, deliberately left:** roughly fifteen application source files and app
READMEs still name `bb-security-review` / `bb-design-system` in comments. Those are
*historical provenance* — they record that a review happened on that code — not
instructions a session is told to act on, so they were out of scope for a remediation
that must not touch application code. Verify with:

```bash
git grep -n -E 'bb-(security-review|design-system)' -- apps packages
```

This is an open decision for the human owner, not a defect:

- **Drop them** — nothing further to do; the deletion is already staged.
- **Restore them** — recover with `git ls-tree HEAD -- .claude/skills/`, repoint each
  skill's agent references onto the seven current names, and add a `/.claude/skills/**`
  row to the ownership map in [README.md](./README.md) naming an owner.
