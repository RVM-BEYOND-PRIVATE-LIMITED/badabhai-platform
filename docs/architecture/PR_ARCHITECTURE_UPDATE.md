# PR Architecture Update — Checklist

A lightweight checklist so the architecture documentation this audit produced stays true as the
codebase changes, instead of drifting the way `docs/architecture/overview.md` and the risk
register did before the 2026-08-05 docs purge (see
[`docs/audit/17_GIT_HISTORY_AUDIT.md`](../audit/17_GIT_HISTORY_AUDIT.md)). This is a
recommendation for reviewers and authors to apply manually — it does not modify
`.github/` configuration or add a CI gate; that decision belongs to whoever owns CI/CD
(see `docs/audit/12_CICD_AUDIT.md`, Batch 2).

## When a PR should update architecture docs

| If your PR... | ...update |
|---|---|
| Adds, removes, or moves a top-level app, package, or infra component | [`docs/audit/01_SYSTEM_BOUNDARY.md`](../audit/01_SYSTEM_BOUNDARY.md) |
| Adds/removes an edge between components (new external provider, a queue becoming a separately-deployed worker, a new frontend calling a different backend) | [`API_ROUTE_MAP.md`](API_ROUTE_MAP.md) + [`API_ROUTE_MAP.mmd`](API_ROUTE_MAP.mmd) |
| Adds, removes, or changes auth on an API route | [`docs/audit/03_API_INVENTORY.md`](../audit/03_API_INVENTORY.md) (per-route detail lives here, not in the route map) |
| Adds or drops a database table, or changes RLS posture | `docs/audit/09_DATABASE_AUDIT.md` (Batch 2) |
| Adds or removes an environment variable | `docs/audit/10_ENVIRONMENT_AUDIT.md` (Batch 2) |
| Adds, removes, or changes a CI workflow | `docs/audit/12_CICD_AUDIT.md` (Batch 2) |
| Introduces or resolves a duplication the audit flagged | [`docs/audit/07_DUPLICATION_AUDIT.md`](../audit/07_DUPLICATION_AUDIT.md) — mark the item resolved, don't delete the row (history is the value, same convention as the risk register) |
| Removes a file this audit flagged as a dead-code candidate | [`docs/audit/06_DEAD_CODE_AUDIT.md`](../audit/06_DEAD_CODE_AUDIT.md) — mark it removed with the PR number, don't delete the row |
| Identifies a new security-relevant finding | Append a row to [`docs/registers/risks-register.md`](../registers/risks-register.md) directly (that register, not a new audit doc — see [`docs/audit/24_RISK_REGISTER.md`](../audit/24_RISK_REGISTER.md) for why this audit didn't fork a second one) |

## What does NOT need an update

Routine feature work that doesn't change a component boundary, an API contract, a table shape,
an env var, or a CI workflow — i.e. most day-to-day PRs. This checklist exists to catch the PRs
that change the *shape* of the system, not to add ceremony to every PR.

## Suggested PR template addition (not applied to `.github/` by this audit)

```markdown
## Architecture impact (skip if none)
- [ ] Changed a system component/boundary → updated 01_SYSTEM_BOUNDARY.md
- [ ] Changed an API route/edge → updated API_ROUTE_MAP.{md,mmd} and/or 03_API_INVENTORY.md
- [ ] Changed a DB table/RLS policy → updated 09_DATABASE_AUDIT.md
- [ ] Added/removed an env var → updated 10_ENVIRONMENT_AUDIT.md
- [ ] Added/removed/changed a CI workflow → updated 12_CICD_AUDIT.md
- [ ] Resolved a flagged dead-code/duplication item → marked it resolved (not deleted) in the relevant audit doc
- [ ] New security-relevant finding → added a row to docs/registers/risks-register.md
```

Whoever owns `.github/` PR templates (see `docs/audit/12_CICD_AUDIT.md`, Batch 2, for current
CI/PR tooling ownership) can decide whether to wire this into `.github/pull_request_template.md`
— this audit only proposes the checklist, per its own read-only charter.

## Why this matters here specifically

This platform lost 444 documentation files in one commit
([`eb151468`](https://github.com/RVM-BEYOND-PRIVATE-LIMITED/badabhai-platform/commit/eb151468),
2026-08-05) partly because the documentation wasn't treated as something individual PRs were
responsible for keeping current — it accumulated separately from the code until it was judged
"stale" as a whole and removed wholesale. A per-PR update habit, even an unenforced one, is
cheaper than a second audit.
