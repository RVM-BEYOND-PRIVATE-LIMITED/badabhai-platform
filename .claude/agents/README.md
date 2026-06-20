# Agents

18 specialized engineering roles Claude can act as for BadaBhai. Each file is a
Claude Code subagent (frontmatter + a system prompt) scoped to a slice of the
platform, with explicit **decision boundaries** and **escalation rules** so no
agent quietly oversteps — especially around the privacy and event invariants.

Every agent inherits the [non-negotiable principles](../../docs/engineering-org/README.md#operating-principles-inherited-non-negotiable)
and operates inside the [development workflow](../../docs/engineering-org/development-workflow.md)
and [quality gates](../../docs/engineering-org/quality-gates.md). Model tier is
inherited from the session unless a task clearly needs otherwise.

| #   | Agent                                             | Owns                                           | Writes code?   |
| --- | ------------------------------------------------- | ---------------------------------------------- | -------------- |
| 1   | [system-architect](./system-architect.md)         | Seams, ADRs, phase boundary                    | Docs/ADRs only |
| 2   | [backend-engineer](./backend-engineer.md)         | NestJS API + shared TS packages                | Yes            |
| 3   | [frontend-engineer](./frontend-engineer.md)       | Next.js ops console                            | Yes            |
| 4   | [mobile-engineer](./mobile-engineer.md)           | Flutter worker app                             | Yes            |
| 5   | [database-architect](./database-architect.md)     | Drizzle schema + migrations                    | Yes (schema)   |
| 6   | [devops-engineer](./devops-engineer.md)           | CI/CD, infra, env/secrets, deploy              | Yes (infra)    |
| 7   | [security-engineer](./security-engineer.md)       | PII boundary, auth, RLS, DPDP                  | Review-only    |
| 8   | [qa-engineer](./qa-engineer.md)                   | Tests + test plans                             | Yes (tests)    |
| 9   | [performance-engineer](./performance-engineer.md) | Hot paths, queries, queueing                   | Review-only    |
| 10  | [ai-engineer](./ai-engineer.md)                   | AI service + privacy gateway                   | Yes            |
| 11  | [product-manager](./product-manager.md)           | Requirements, scope, PRDs                      | Docs only      |
| 12  | [technical-writer](./technical-writer.md)         | Docs + registers accuracy                      | Docs only      |
| 13  | [code-reviewer](./code-reviewer.md)               | Pre-merge review                               | Review-only    |
| 14  | [refactoring-engineer](./refactoring-engineer.md) | Behavior-preserving cleanup, tech-debt paydown | Yes            |
| 15  | [debugging-engineer](./debugging-engineer.md)     | Root cause + minimal fix                       | Yes            |
| 16  | [migration-reviewer](./migration-reviewer.md)     | Migration/RLS pre-merge review                 | Review-only    |
| 17  | [security-reviewer](./security-reviewer.md)       | Authz/IDOR/secrets pre-merge review            | Review-only    |
| 18  | [test-planner](./test-planner.md)                 | Coverage gaps + missing tests                  | Yes (tests)    |

**Review agents block on Critical findings within their scope:** code-reviewer
(correctness/invariants), security-engineer (privacy/PII/pseudonymization),
security-reviewer (authz/IDOR/secrets), and migration-reviewer (destructive/drift/RLS).
A Critical privacy finding is never downgraded.

Agents invoke the [`bb-*` skills](../skills/) for the actual procedures (e.g. the
Security Engineer runs `bb-security-review`; the Database Architect runs
`bb-database-design`).
