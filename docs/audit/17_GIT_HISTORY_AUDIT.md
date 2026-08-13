# 17 — Git History Forensics

Scope: use Git history as supporting evidence for later dead-code/duplication judgments, not
as a sole reason for any deletion. Nothing in this document authorizes removing anything.

## Headline facts

```text
Branch audited        : origin/main
HEAD at audit time     : 44ac03c0 ("fix(deploy): wire ZEPTOMAIL_API_URL through compose and
                          the CI secrets bridge", #819)
Total commits           : 611 (610 at initial recon + 1 landed before branching, see
                          BRANCH_BASELINE.md drift note)
Repo history span       : 2026-06-26 → 2026-08-13 (~48 days)
Tags                    : 0
Local branches          : 106 (incl. main)
Remote branches         : 28 (origin/*) + 6 refs on a separate `pr` remote
```

Zero tags and 106 local branches for a 48-day-old repo indicates the team does not use Git
tags for releases (deployment likely tracks commit SHAs or a separate release mechanism —
verify in Batch 2's CI/CD audit) and branches are created liberally and rarely pruned locally.

## Largest bulk-change commits (non-merge, ≥100 files touched)

Found via `git log --no-merges --shortstat`, sorted by files-changed. These are the commits
most likely to have introduced the duplication/dead-code patterns this audit is chartered to
find, so future Batch-2 dead-code work should treat file provenance from these commits as a
starting hypothesis, not a conclusion.

| Files changed | +/- | Commit | Subject | Date | Note |
|---|---|---|---|---|---|
| 1,133 | +179,376 / -0 | `29e65fd5` | "feat(payer-web): DS3.1 — re-skin the agency dashboard on the design system" | 2026-06-26 | **This is the earliest reachable commit on `main`.** A 1,133-file, 0-deletion commit as the *first* commit, carrying a narrow feature-sounding subject line, is strong evidence the visible Git history was squashed/re-initialized at this point rather than reflecting true project origin. Treat anything "since the beginning of history" claims in future audits with that caveat — there is no earlier history to inspect. |
| 444 | +0 / -54,122 | `eb151468` | "Removed the stale docs folder (#589)" | 2026-08-05 | The docs purge — see below. |
| 221 | +21,391 / -191 | `f6b7471c` | "feat(flutter): worker-app backend wiring + new role-aware payer-app (Company/Agency) (#189)" | — | Matches known history: introduced `apps/payer-app` wholesale. |
| 143 | +10,560 / -2,166 | `5370c8d6` | "feat(worker-app): Desi Vernacular Pop alpha — chat-first profiling + 4-tab shell (mock-backed) (#153)" | — | Initial worker-app UI shell. |

No commit in the top bracket looks like an unreviewed/accidental bulk change — each corresponds
to a known, named PR. No evidence of force-pushed history rewriting beyond the single squash
point at `29e65fd5`.

## The docs purge — `eb151468` / PR #589 (2026-08-05)

The single most consequential event for *this* audit's scope: 444 files deleted in one commit,
almost entirely under `docs/`:

- All 38 ADRs (`docs/decisions/ADR-0001` … `ADR-0038`)
- `docs/tracker/` (16 files — `PROJECT_STATUS.md`, `ROADMAP.md`, `DAILY_TRACKER.md`,
  `RISK_REGISTER.md`, `ENV_AND_SECRETS_TRACKER.md`, `TEST_MATRIX.md`, `RELEASE_READINESS.md`,
  `DECISION_LOG.md`, and others)
- `docs/bible/`, `docs/security/`, `docs/ai/`, `docs/api/`, `docs/specs/`, `docs/reports/`,
  `docs/design/`, `docs/schema/`

Two artifacts were selectively restored afterward: `docs/registers/risks-register.md`
(restored 2026-08-12, currently maintained, 30 entries) and `docs/architecture/overview.md`
(rewritten 2026-08-08, deliberately narrowed to the worker-profiling path only — its own text
says "not a whole-platform overview"). A single ADR file
(`docs/adr/ADR-0038-deterministic-occupation-interview.md`) was briefly re-added on 2026-08-07
then removed again on 2026-08-07/08 as "orphaned" (`6381137e`). `docs/architecture/overview.md`
still links to that now-nonexistent file (lines 5 and 261) — a dead link.

**This audit does not attempt to reconstruct the purged content.** Its charter is to document
the system as it exists *today*; the purge itself is recorded here as historical evidence and
flagged in the Executive Summary as a `CLAUDE_MD_REVIEW_REQUIRED`-adjacent gap (the platform
currently has zero ADRs on record despite pervasive `ADR-00xx` references throughout code
comments and configs — e.g. ADR-0013, 0017, 0019, 0025, 0031–0033, 0038 — which is itself a
documentation-hygiene finding for the backlog, not something to silently patch over).

## Prior forensic-audit art

`docs/payer-agent/` (19 files, most recently touched 2026-08-11) is a genuine, non-trivial
forensic audit in the same spirit as this one, but scoped to the payer/agency surface only. Its
own `AUDIT_STATUS.md` self-reports 7 of 17 planned dimensions complete and explicitly avoids
fabricating a completion percentage for the rest. This audit treats that directory as prior art
to reference and reconcile with (see the Risk Register), not to duplicate or overwrite.

## What was NOT investigated in this pass

Full `git blame`/rewrite-frequency analysis per file (which files are repeatedly rewritten),
reverted-feature detection, and AI-bulk-change fingerprinting are Batch-2-adjacent and were not
run here — this document covers the headline branch/tag/bulk-commit facts needed to support
Batch 1's dead-code and duplication findings.
