# Branch Baseline — Forensic Audit Batch 1

Recorded at the start of the audit, before any documentation was written, per the audit's
pre-flight requirement to capture initial Git state.

```text
AUDIT_START_TIME   = 2026-08-13 (session date; exact time not machine-recorded)
MAIN_HEAD          = 44ac03c09155670ab089323248f7e0132f630de6
                      "fix(deploy): wire ZEPTOMAIL_API_URL through compose and the CI
                       secrets bridge (#819)"
MASTER_HEAD        = N/A — no branch named `master` exists locally or on `origin`
                      (verified via `git branch -a` and `git ls-remote --heads origin`,
                       106 local + 28 remote refs scanned, zero matches, case-insensitive)
AUDIT_BRANCH       = docs/forensic-audit-batch1, created from origin/main @ 44ac03c0
WORKING_TREE       = clean (no staged/unstaged/untracked files) at audit start
```

## Branch strategy note

The audit brief that triggered this work assumed a two-branch model: `master` as a controlled
implementation/verification branch, `main` as the protected production source of truth,
promoted via PR only after developer sign-off. That model does not describe this repository.

- `master` does not exist, locally or on `origin`.
- `main` is this repository's only long-lived branch. The team's actual, current workflow —
  confirmed by recent history and by `CLAUDE.md` (§14, "Merged Means On main") — is short-lived
  `feat/`/`fix/`/`docs/` branches merged directly into `main` via a single required approving
  review, not a staged `master → main` promotion.
- Per explicit user decision, this audit follows the repository's real workflow: a normal
  feature branch (`docs/forensic-audit-batch1`) off `main`, reviewed and merged into `main`
  directly. There is no separate `master` branch to promote into.

## Repository state at audit start

```text
Total commits on main        : 610 (as of the original baseline read; +1 after fetch, see below)
Repo age (main)               : ~48 days (earliest commit 2026-06-26 → 2026-08-13)
Local branches                : 106 (including main)
Remote-tracking branches      : 28 (origin/*) + a separate `pr` remote (pr/703, 704, 705,
                                 709, 709b, 711 — used for reviewing PRs)
Tags                          : 0
```

**Drift note:** the initial reconnaissance read `main` at `454dd5c` (610 commits). A
`git fetch origin main` performed immediately before branching for this audit showed `main`
had advanced by one merge — `44ac03c0`, PR #819 ("wire ZEPTOMAIL_API_URL through compose and
the CI secrets bridge") — landing between reconnaissance and branch creation. This audit
branches from the **fresh** `44ac03c0`, not the stale `454dd5c` reading, consistent with the
project's standing "Merged Means On main" discipline: always verify against a freshly fetched
`origin/main`, never trust an earlier snapshot.

## Long-lived / non-topic branches observed (besides main)

`mainverify`, `jul31-design-rebase`, `m704-rebase`, `oie-p8`, `oie-phase-9-reconcile`,
`pr796-check`, `rescue/interview-1-followup`, and a series of version-checkpoint branches
(`v668`, `v669`, `v669-on-main`, `v673-on-main` … `v690-fix`). These are recorded here as raw
evidence only — no classification or deletion recommendation is made in Batch 1. Individual
branch-by-branch classification (merged / stale / active-PR / safe-to-delete) is scoped to
Batch 2 (`13_GITHUB_BRANCH_AUDIT.md`), not this document.

## What this document is NOT

This is a point-in-time snapshot for audit provenance, not a live branch registry. Before
acting on any fact here (especially `MAIN_HEAD`), re-verify against current `origin/main` —
per this repo's own recent history, it moves.
