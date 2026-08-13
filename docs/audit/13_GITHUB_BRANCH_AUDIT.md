# 13 — GitHub Branch Audit (origin)

Scope: every branch on the shared remote `origin`, classified for deletion safety. Local-only branches on the auditing workstation are out of individual scope — see the count at the bottom. **Classification only — no branch was deleted, created, or mutated.** All commands run were read-only (`git fetch origin --prune`, `git branch -r`, `git for-each-ref`, `gh pr list`, `gh api .../protection`); no `git push`, `git branch -d/-D`, or `gh pr merge` was executed.

```text
Audit run (UTC)      : 2026-08-13T07:08:36Z
origin branches       : 13 (12 topic branches + main; origin/HEAD is a symbolic pointer to
                         origin/main, excluded from the 13)
Separate `pr` remote  : 6 refs (pr/703, 704, 705, 709, 709b, 711) — distinct git remote used
                         for reviewing PRs, not part of origin, excluded per BRANCH_BASELINE.md
Local branches        : 108 total, 104 with no name-match on origin at all — not individually
                         classified (see note at end)
```

## Method note — `--merged` undercounts in this repo

The literal spec method (`git branch -r --merged origin/main`/`--no-merged`) checks **commit ancestry**. That check returned exactly **one** branch as merged: `origin/main` itself. Every other branch — including ten that are provably shipped — reported "not merged." **Expected, not a bug**: this repository squash-merges every PR (CLAUDE.md §14, "Merged Means On main" — "squash-merge collapses only the commits reachable from `headRefOid` at merge time"). A squash-merge writes a **new** commit onto `main`; the source branch's original commits are never literal ancestors of it, so ancestry-only `--merged` reports a squash-merged branch as unmerged forever, even years later. Relying on `git branch --merged` alone here would misclassify all ten already-shipped branches below as "keep" — a false negative letting real clutter accumulate indefinitely.

Each of the 12 non-`main` branches was cross-checked against `gh pr list --state merged --json headRefName,number,mergedAt,title` (300-PR window, covers the repo's entire ~48-day/611-commit history) and `gh pr list --state open`. Every branch resolved cleanly to exactly one of "has an open PR" or "has a merged PR" — no orphans found. The **"Merged?" column reports the PR-verified truth**, ancestry result shown for transparency.

## Summary counts

| Classification | Count |
|---|---|
| `KEEP_PROTECTED` | 1 (`main`) |
| `KEEP_ACTIVE_PR` | 2 |
| `SAFE_TO_DELETE` | 10 |
| `KEEP_UNMERGED_RECENT` / `KEEP_UNMERGED_STALE` | 0 / 0 |
| **Total origin branches** | **13** |

Zero branches fell into the unmerged buckets — once squash-merges are accounted for via `gh pr`, every non-`main`, non-open-PR branch on `origin` already has a merged PR. A clean result: no genuinely abandoned (never-landed, no-open-PR) branch sits on `origin` at audit time.

## Full branch table

| Branch | Merged (ancestry) | Merged (PR-verified) | Open PR | Last commit | Days stale | Classification |
|---|---|---|---|---|---|---|
| `main` | — | — | — | 2026-08-13 (Prakash Kantumutchu) | 0 | `KEEP_PROTECTED` |
| `feat/worker-job-search` | No | No | **#823** OPEN — "feat(worker-app): job search by title + city/state, Indeed-style (#822)" | 2026-08-13 (Rishi Ojha) | 0 | `KEEP_ACTIVE_PR` |
| `docs/forensic-audit-batch1` | No | No | **#821** OPEN — this same audit's Batch 1 | 2026-08-13 (Prakash Kantumutchu) | 0 | `KEEP_ACTIVE_PR` |
| `fix/793-storage-armed-without-credentials` | No | Yes — **#810**, merged 2026-08-12T09:48:27Z | No | 2026-08-12 | 1 | `SAFE_TO_DELETE` |
| `fix/login-shell-nav-rsc-and-storage-docs` | No | Yes — **#808**, merged 2026-08-12T09:22:49Z | No | 2026-08-12 | 1 | `SAFE_TO_DELETE` |
| `fix/payer-web-nav-rsc-and-guard-removal` | No | Yes — **#807**, merged 2026-08-12T09:07:53Z | No | 2026-08-12 | 1 | `SAFE_TO_DELETE` |
| `chore/788-pnpm-audit` | No | Yes — **#804**, merged 2026-08-12T08:23:55Z | No | 2026-08-12 | 1 | `SAFE_TO_DELETE` |
| `fix/interview-overlay-survives-parse-outage` | No | Yes — **#799**, merged 2026-08-12T07:34:05Z | No | 2026-08-12 | 1 | `SAFE_TO_DELETE` |
| `fix/agency-portal-flag-degrades` | No | Yes — **#795**, merged 2026-08-12T06:36:50Z | No | 2026-08-12 | 1 | `SAFE_TO_DELETE` |
| `chore/787-next-security` | No | Yes — **#790**, merged 2026-08-12T06:12:18Z | No | 2026-08-12 (Rishi Ojha) | 1 | `SAFE_TO_DELETE` |
| `fix/775-spoken-signal` | No | Yes — **#782**, merged 2026-08-12T06:07:39Z | No | 2026-08-12 (Rishi Ojha) | 1 | `SAFE_TO_DELETE` |
| `feat/700-review-correction` | No | Yes — **#780**, merged 2026-08-12T05:51:27Z | No | 2026-08-12 (Rishi Ojha) | 1 | `SAFE_TO_DELETE` |
| `feat/ai-chat-profiling` | No | Yes — **#583**, merged 2026-08-05T08:28:46Z | No | 2026-08-05 (divyuuu) | 8 | `SAFE_TO_DELETE` |

## Verification detail for the two `KEEP_ACTIVE_PR` branches

Both confirmed `state: OPEN`, `isDraft: false`, `mergeable: MERGEABLE`, both base off `main` (no stacked-PR chain currently on `origin`, so deleting nothing here cascades to another PR's base):

```json
{"baseRefName":"main","headRefName":"feat/worker-job-search","number":823}
{"baseRefName":"main","headRefName":"docs/forensic-audit-batch1","number":821}
```

`docs/forensic-audit-batch1` (#821) is this same forensic-audit effort's own Batch-1 branch — correctly `KEEP_ACTIVE_PR`, not a cleanup candidate, until #821 merges.

## `main` branch protection (context, not a finding)

```json
{"required_reviews": 1, "required_status_checks": ["ci-required"]}
```

Confirms the "1 required approving review + `ci-required` status check" protection already recorded in team memory — included as corroborating evidence, not a new finding.

## What this audit does NOT recommend

This document classifies; it does not delete. Before anyone deletes the 10 `SAFE_TO_DELETE` branches:

- All 10 have merged-PR provenance verified above (PR number + `mergedAt` timestamp) — deleting the branch ref loses no code, the squash commit is already on `main`.
- Deleting a remote branch does not delete its PR from GitHub's history — PR pages, review threads, and CI run logs remain intact and linkable after the branch ref is gone.
- This is a housekeeping action (`git push origin --delete <branch>` × 10), not a data or migration operation — but the human owner should still be the one to run or explicitly authorize the delete, since branch deletion is a remote mutation this read-only audit was not authorized to perform.

## Local branches (brief, out of individual scope)

```text
Local branches (this workstation)                   : 108
Local branches with no matching name on origin       : 104
```

104 of 108 local branches on this workstation have no corresponding branch on `origin` at all — consistent with [17_GIT_HISTORY_AUDIT.md](17_GIT_HISTORY_AUDIT.md)'s Batch 1 finding that "branches are created liberally and rarely pruned locally" (106 local branches recorded there on 2026-08-13 at audit start; 108 now, +2 from branches created since). Per this audit's scope, local-only branches are a lower-stakes, single-workstation concern and are not individually classified — a workstation-level `git branch --merged main | xargs git branch -d` cleanup is a separate, low-risk action any engineer can run against their own clone without touching `origin`.
