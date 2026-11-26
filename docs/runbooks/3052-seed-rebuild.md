# Runbook: rebuild worker skills + stored matches after each trades-v2 seed (#3052)

**Who:** owner (production database + secrets). Not a deploy step, not a dev-session
step. Never run from a checkout with a root `.env` pointing at production.

From a tree equal to `origin/main`, in this order (reach reads skills):

1. `db:backfill:worker-skills` (`packages/db/src/backfill-worker-skills.ts`) — re-derives
   each worker's `worker_skill` rows from his latest `worker_profiles` row through the
   same table the live path uses (`PACK_ANSWER_SKILLS` + role/attribute bridges).
2. `db:materialize:reach` (`packages/db/src/materialize-job-reach.ts`) — re-materializes
   `job_reach` from each open posting's STORED `reach_skill_ids` (never re-derived).

Both are dry-run by default (print, write nothing); `--apply` writes. `DATABASE_URL`
must be set — there is no localhost fallback, and a dry run is refused without it.
A production write needs BOTH `--i-am-authorised-to-write-to-production` on the
command line AND `OPS_ALLOW_PRODUCTION=<script-name>` in the environment
(`backfill:worker-skills` / `materialize:reach`). Logs are ids + counts only, never PII.

## Owner steps (per seed: #3003 phase 1, #3013 each wave)

0. Logical backup first (per #3003 step 1 / #3013 wave step 1).
1. Dry run, from `origin/main`:
   `DATABASE_URL=<target> pnpm --filter @badabhai/db db:backfill:worker-skills`
   `DATABASE_URL=<target> pnpm --filter @badabhai/db db:materialize:reach`
2. Apply the seed-gate rule (#3052 §3) to the dry-run output. SHIP-stopper —
   any of these stops the seed:
   - any per-skill line with `after < before` (a worker lost a skill);
   - `worker_skill deleted (stale)` > 0;
   - any per-job tier line with `after_t1 < before_t1` (a job lost a tier-1 row);
   - `job_reach rows deleted` > 0 (stale or cleared) unless the cleared posting is
     an intended #2746 no-BadaBhai-audience row.
   Additions only is expected for live trades: new tier-2 rows from the new pairs
   (#3001: Industrial Electrician↔Maintenance Technician, Assembly↔Fitter, 2D↔new 3D id).
3. Post the dry-run counts BEFORE rebuilding:
   - #3003 step 6: the five stored-match counts
     (`mskill_industrial_electrician`, `mskill_maintenance_technician`,
     `mskill_assembly_line_worker`, `mskill_fitter`, `mskill_designer`).
   - #3013 wave steps: counts + the four verify results.
4. If the gate passes, rebuild with `--apply` (backfill first, then reach), plus the
   production authorisation above. Post the counts again in the same place.
5. Thin-form workers are NOT re-prompted (#2995 point 16): when one reopens his
   profile he is served the new form version with his earlier answers under kept
   keys already filled. Keys are append-only
   (`question-pack-keys.append-only.test.ts`); the no-loss test below pins the rest.

## Local rehearsal (this work, throwaway `bb3052_test` + demo workforce)

- Backfill dry run: 10 workers scanned, `upserted=0 deleted (stale)=0`,
  per-skill table empty (demo personas hold `worker_skill source='ops'` directly;
  pack-answer preservation is proven offline instead).
- Reach dry run: 1200 postings processed / 1200 materialized, 0 skipped, 0 cleared,
  `inserted=0 refreshed=2037 deleted=0`, 351 zero-reach (demo roles with no matching
  worker — expected). All 1200 per-job tier lines `after_t1 == before_t1`,
  `after_t2 == before_t2`, `deleted=0`: additions-only, nobody lost a match.
- Offline pins: `deepened-forms-noloss.test.ts` (7 tests: every option of every mapped
  question on v1 of each of the 6 deepened forms + `qp_foundry_forging` holders
  derives the same skill set through the current table) and
  `question-pack-keys.append-only.test.ts` (kept keys carry over).
