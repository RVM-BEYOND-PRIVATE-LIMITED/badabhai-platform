# Matching V1 Migration Runbook

Reconstructed from `packages/db/migrations/0059_boost_tiers_widened.sql`'s own header,
`packages/db/src/match-v1-cli.ts`'s shared-guard doc comment, and the numbered `D<N>` header
comments in each Matching V1 script under `packages/db/src/` (ADR-0036). **This file's exact
original numbering/prose could not be recovered** — the live code cites it by path only, plus one
self-reference to "the doc's step ③" in `materialize-job-reach.ts` whose original step-numbering
scheme is lost with the file. What follows is reconstructed from the migration chain, the script
headers, and the go/no-go verifier's own check list — the underlying mechanism, not a transcript
of the original prose.

This runbook is a genuinely new discovery for this reconstruction batch: neither
`docs/audit/24_RISK_REGISTER.md` R46 nor `docs/audit/11_COMMAND_REFERENCE.md`'s "three
`docs/ops/*.md`" count named this file — both audits' citation sweeps covered CI/workflow
comments, and this runbook is cited only from `packages/db` migration/script comments, outside
either audit's search scope. It is real and current: both citing files are unchanged on
`origin/main` as of this reconstruction.

## What this covers

The Matching V1 rollout (ADR-0036): 8 migrations (`0052`–`0059`) plus 6 seed/backfill scripts
(`D1`–`D6`) that must run, **in this order**, against a database that has already applied
`0000`–`0051`, followed by a strictly read-only go/no-go verifier.

## Migrations (`0052`–`0059`)

| # | File | What it adds |
|---|---|---|
| 1 of 7 | `0052_match_vocabulary.sql` | `skill.kind` (`match_skill` vs `attribute`) + `skill.industry_id` + `skill_related` (tier-2 adjacency, symmetry enforced by the seeder/verifier, not a DB trigger) — expand-only, catalog-only `ADD COLUMN`s |
| 2 of 7 | `0053_worker_skills_and_tenure.sql` | Worker-skill + industry-tenure storage |
| 3 of 7 | `0054_job_postings_served_entity.sql` | `job_postings` served-entity columns |
| 4 of 7 | `0055_job_reach.sql` | The `job_reach` table (materialized worker-reach per posting) |
| 5 of 7 | `0056_applications_v1_snapshot.sql` | Applications V1 snapshot columns |
| 6 of 7 | `0057_match_config.sql` | `match_config` table structure — **ships no seed row**; nothing else in the migration chain inserts into it |
| 7 of 7 | `0058_payments_and_referral_bonus.sql` | Payments + referral-bonus columns |
| addendum (not numbered "N of 7") | `0059_boost_tiers_widened.sql` | Widens `posting_boosts.tier`'s CHECK constraint to admit `boost_7`/`boost_15`/`boost_30` alongside the original `all_candidates` — landed after the 7-migration train, additive/expand-only, reversible only while no row uses a new tier value (`SELECT count(*) FROM posting_boosts WHERE tier <> 'all_candidates'` must be 0 first) |

Apply with the standard chain (`pnpm db:migrate` — see `docs/supabase-workflow.md`). All 8 are
already exercised from a fresh, empty database by `ci.yml`'s `e2e` job on every PR.

## Seed / backfill scripts (`D1`–`D6`)

All six share one CLI harness (`packages/db/src/match-v1-cli.ts`) and its guards:

- **Dry-run is the default** for every script in this family — nothing writes until `--apply`.
- **`NODE_ENV=production` refuses outright** unless `MATCH_V1_PROD_CONFIRM=apply-matching-v1` is
  also set — the confirm token is the deliberate second key for a production run (this runbook is
  what that error message points at).
- **`DATABASE_URL` must be set explicitly** — no localhost fallback, so a mis-pointed run cannot
  silently target the wrong database.
- **PII-free by construction**: these scripts read `worker_profiles` signal columns, `jobs`,
  `job_postings`, and the skill vocabulary — never phone/name. Every log line is ids + counts.

Run in this order — later steps depend on earlier ones (D3/D4 both touch `job_postings`; D5
reads the output of D2/D3/D4; D6 is independent and can run any time after the migrations land):

| Step | Script (`pnpm --filter @badabhai/db <cmd>`) | Migration | What it does |
|---|---|---|---|
| D1 | `db:seed:match:vocabulary --apply` | 0052 + 0057 | Seeds the closed match-skill vocabulary + `skill_related` pairs (reference data, deterministic, checked-in — invariant #4) and writes **the single active `match_config` row** — the only writer of that table anywhere in the migration/seed chain. |
| D2 | `db:backfill:worker-skills --apply` | 0053 | Derives every worker's matchable skill inventory from their latest `worker_profiles` row (coarse launch rule, owner-ruled 2026-07-30: role bridge ∪ attribute bridge; tenure months bucketed and clamped to the worker's stated industry experience — the "E8 clamp"). |
| D3 | `db:backfill:job-postings --apply` | 0054 | Two idempotent jobs: backfills `published_at = created_at` for non-draft postings missing it, and **proposes** (never guesses) `match_skill_ids` for open postings with none, via normalized keyword match of `role_title` against the vocabulary. |
| D4 | `db:convert:seed-jobs --apply` | — (cutover continuity, not tied to one migration) | Converts legacy `jobs` rows into `job_postings` (copies open rows across, closes the originals) so the pre-V1 worker feed does not go empty at cutover. Own comment: **"WITHOUT THIS THE WORKER FEED IS EMPTY AT FLAG FLIP."** |
| D5 | `db:materialize:reach --apply` | 0055 | For every open posting, computes and writes the set of workers it can reach into `job_reach` (one `INSERT..SELECT` per posting, no app-side loop). Run once after D2/D3/D4; thereafter the API materializes reach live on publish/edit, and this script becomes the repair/rebuild tool. |
| D6 | `db:grant:free-tier --apply` | — | Grants every existing payer the V1 free-tier unlock credits (`match_config.free_unlock_credits`, 50 at launch). Exactly-once by a DB constraint (`credit_ledger_idempotency_key_uq` on `idempotency_key = 'free_tier_grant:<payerId>'`), not by a loop invariant — safe to re-run. |

`--apply` is required on every one of these — dry-run-by-default is not a formality: this same
class of script has previously gone green while writing nothing (the pack-seed steps in `ci.yml`
hit exactly this bug once — see `docs/github-actions.md`).

## Verify (go/no-go, read-only)

`pnpm --filter @badabhai/db db:verify:match-v1` — **strictly read-only** (`SELECT`s + `EXPLAIN`s,
no `--apply` flag exists because there is nothing to apply), so it is safe to run against
production at any time, including on a schedule. Exits non-zero on any violation. Checks:

| Check | What it asserts |
|---|---|
| A. Structure | All 7 new tables exist; row counts per table (informational) |
| B. Symmetry | No `skill_related` row is missing its mirror (no DB trigger enforces this — this verifier is one of only two places the guarantee is actually checked) |
| C. Self/kind | No self-relation; every skill id referenced anywhere (a relation, a worker_skill, a job_reach row, a posting's `match_skill_ids`) is a real row with `kind='match_skill'` — no orphan match ids |
| D. Reach | Every open posting with match skills has ≥1 `job_reach` row or is reported zero-reach; every posting's `reach_skill_ids` is a superset of its `match_skill_ids` |
| E. Tiers | Every `job_reach.match_tier` ∈ {1,2}; every tier-1 row's `matched_skill_id` really is in that posting's `match_skill_ids` |
| F. Tenure | The E8 clamp holds — no worker has a skill with more bucketed months than their stated industry tenure |
| G. Config | Exactly one active `match_config` row, and it parses |
| H. Plans | `EXPLAIN`s the feed query + the reach driver query and asserts the intended indexes are actually chosen |

This same verifier is run against a **freshly migrated, freshly seeded** database on every PR by
`ci.yml`'s `e2e` job (`db:verify:match-v1` step) — so the schema/vocabulary/backfill/index-plan
agreement is a continuously-checked property, not a one-time launch gate.

## Order of operations, summarized

```
0000..0051 (already applied) → 0052..0058 (7-step train) → 0059 (addendum)
  → D1 (vocabulary + match_config) → D2 (worker skills) → D3 (job_postings backfill)
  → D4 (legacy jobs cutover) → D5 (reach materialization) → D6 (free-tier grant)
  → db:verify:match-v1 (go/no-go)
```

## What this runbook does not cover

The ADR-0036 product/ranking design itself (see `docs/decisions/0036-matching-algorithm-v1.md`);
the DB-backed *ranking* release gates (`rank-parity`, `boost-fences`, `apply-freeze`,
`current-profile-order`) that separately protect the *ranking* behavior once V1 is live — those
are `RUN_DB_TESTS=1` vitest suites, not part of this migration/seed sequence (the same CI step
also runs gates that are nothing to do with ranking — `ai-cost-totals.db` and `jobs-search-sql`;
see
`docs/github-actions.md`'s CI job reference); rolling migrations back (see
`docs/rollback-guide.md`'s Migrations section — the same "additive migrations are safe to leave
applied, destructive ones are not" rule applies here).
