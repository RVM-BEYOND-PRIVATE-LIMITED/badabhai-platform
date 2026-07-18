# Skills

17 reusable, checklist-driven procedures for building BadaBhai. Each is a Claude
Code skill (`bb-<name>/SKILL.md`) with a fixed shape: **Goal · Inputs · Process ·
Checklist · Expected Output · Failure Conditions.**

All skills are **`bb-`-prefixed** to avoid shadowing Claude Code built-ins
(notably `/code-review` and `/security-review`). The BadaBhai versions add
platform-specific invariants (events, no-PII, fail-closed) on top of the general
practice.

| Skill | Used by (agent) | Workflow stage |
| ----- | --------------- | -------------- |
| [bb-feature-planning](./bb-feature-planning/SKILL.md) | Product Manager | Requirements |
| [bb-architecture-review](./bb-architecture-review/SKILL.md) | System Architect | Architecture |
| [bb-database-design](./bb-database-design/SKILL.md) | Database Architect | Database |
| [bb-api-design](./bb-api-design/SKILL.md) | Backend Engineer | APIs |
| [bb-ui-review](./bb-ui-review/SKILL.md) | Frontend / Mobile | Implementation |
| [bb-testing](./bb-testing/SKILL.md) | QA Engineer | Testing |
| [bb-security-review](./bb-security-review/SKILL.md) | Security Engineer | Security review |
| [bb-performance-optimization](./bb-performance-optimization/SKILL.md) | Performance Engineer | Performance review |
| [bb-scalability-analysis](./bb-scalability-analysis/SKILL.md) | System / Performance | Architecture / Perf |
| [bb-deployment](./bb-deployment/SKILL.md) | DevOps Engineer | Deployment |
| [bb-monitoring](./bb-monitoring/SKILL.md) | DevOps / Performance | Monitoring |
| [bb-code-review](./bb-code-review/SKILL.md) | Code Reviewer | Code review gate |
| [bb-debugging](./bb-debugging/SKILL.md) | Debugging Engineer | (any — defects) |
| [bb-root-cause-analysis](./bb-root-cause-analysis/SKILL.md) | Debugging / Security | (post-incident) |
| [bb-refactoring](./bb-refactoring/SKILL.md) | Refactoring Engineer | (any — cleanup) |
| [bb-documentation](./bb-documentation/SKILL.md) | Technical Writer | Documentation |
| [bb-prune-merged-branches](./bb-prune-merged-branches/SKILL.md) | Repo maintainer | Cleanup / branch hygiene |

Every skill's checklist re-asserts the BadaBhai invariants where relevant: **no
PII to an LLM, fail-closed pseudonymization, a validated event per important
action, typed contracts at boundaries.** A skill "fails" if it proceeds past a
violated invariant.
