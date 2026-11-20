# ADR-0069: A trade form's experience band counts as match months (engine v1.2)

- **Status:** Accepted. CEO ruling (Akshit), 20 Nov 2026, in session: switch it on.
- **Date:** 2026-11-20
- **Owner:** Divyanshu (Backend Platform, match module) · **Issue:** #2753 item 2 (built in PR #2859), owner steps #2865 §3 ruling 2 and §4
- **Needs:** no migration. This build deploys with the `production` environment secret `FORM_TENURE_MONTHS_ENABLED=true` (set 20 Nov 2026). Then, from a tree equal to origin/main with both tenure switches exported at production's values: `pnpm --filter @badabhai/db db:backfill:worker-skills` (a dry run), `--apply`, then `pnpm --filter @badabhai/db db:materialize:reach --apply`.
- **Amends:** [ADR-0036](0036-matching-algorithm-v1.md) §5. A change to the rank inputs needs a new `engine_version`, CEO sign-off and an ADR. This is v1.2, the 20 Nov ruling and this file.

## 1. Context

Every trade form asks for an experience band, but `worker_skill.months_bucketed` was built only from the interview profile's `total_years`. A worker who finished a trade form has no profile row, so every skill showed 0 months: "not recorded" in search, last inside their tier, and never promoted by the 36-month tier floor. Part E of #2753 (PR #2859) built the fill behind `FORM_TENURE_MONTHS_ENABLED`, default off, and left the version question to the CEO because it changes rank inputs.

## 2. Decision

1. **The band fills the months.** With `FORM_TENURE_MONTHS_ENABLED` on, each skill a trade form derived takes that form's band through the existing 6-month bucketing: fresher and under one year 0, 1–3 years 24 months, 3–5 years 48, 5–10 years 84, over 10 years 144.
2. **Fill, never override.** The band applies only where the profile's own years bucket to 0. A skill named by two forms keeps the longer band. A skill the worker or ops set by hand (`interview`, `ops`) keeps its months.
3. **A typed tenure counts only with `FORM_TYPED_TENURE_DERIVE_ENABLED` on too.** That switch keeps its current production value; this ruling does not change it.
4. **`engine_version` moves to `v1.2`,** the code default in `packages/match-engine/src/config.ts` (the active `match_config` row is inert, TD128). Every application from this deploy on is stamped `v1.2`, so a replay can tell which rule ranked it.
5. **Old snapshots stay frozen.** Applications made before the switch keep their `v1.1` stamp and their months (E16); nothing is rewritten.

## 3. Consequences

- **The order changes for form workers.** In company search and in each posting's applicant list, a form worker now sorts by their band's months inside their tier. A related-trade worker with a band of 3–5 years or more (48+ months) clears the 36-month floor and is promoted into tier-1 ordering.
- **Reach is rebuilt.** Reach is materialized from `worker_skill`, so `db:materialize:reach --apply` runs after the backfill. Until the backfill runs, only workers whose skills are rebuilt (a form save, a profile edit) carry the new months, so the backfill runs straight after the deploy.
- **Rollback:** set the secret to `false`, redeploy, and run the backfill again with the switch exported as `false`. Applications already stamped `v1.2` keep their stamp and their months.
- **Known limits (from #2859):** old pack versions stored 5 and 10 years (60 and 120 months), and `qp_cad_drafting` v1 stored 1 year for "under one year" (12 months). A worker whose tier was pre-set from chat's `experience_years` has no stored band and stays "not recorded".
