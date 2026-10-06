# Agency-job V1 twins — how the sync works and how to run it

Implements [ADR-0050](../decisions/0050-agency-inventory-v1-twin.md) (#1957). Read the ADR for the
reasons behind each rule. This page covers the behaviour, the controls and the operator steps.

## What a twin is

Each agency `jobs` row (owner `payers.role = 'agent'`) gets exactly one `job_postings` row, linked by
`job_postings.source_job_id` and marked `sync_source = 'agency_job'`. That row is the **twin**:

- **System-owned.** `payer_id` is NULL and `created_by` is `AGENCY_TWIN_SYSTEM_ACTOR_ID`.
  `org_label` is `AGENCY_TWIN_ORG_LABEL`; it is never projected to a worker. Both constants live in
  `packages/config/src/agency-twin.ts` and are checked at boot. Migration 0132's
  `job_postings_twin_owner_chk` makes an agent-owned or unlinked twin impossible in the DB.
- **Derived.** The agency keeps authoring in `jobs` (#1885), and the twin is a projection of it.
  The field map is the D4 map: `title → role_title`, plus city, area, pay, pay_type, shift,
  needed_by, description, experience, benefits, requirements and role_kind. Two values are fixed:
  `vacancy_band = '1'`, and `published_at = jobs.created_at` once V1 is on.
- **Matched only on an explicit pick.** `match_skill_ids` is copied from `jobs.match_skill_ids`.
  An agent sets it on the agency form; ops sets it with `PUT /ops/agency-jobs/:jobId/match-skills`.
  It is **never** inferred from `trade_key`. `reach_skill_ids` is `match ∪ related(match)` through
  `resolveReachSet`, with no unticks.

### Status (ADR-0050 §4.2)

| Source / deploy state                                                      | Twin status | Refusal reason                                                   |
| -------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------- |
| `MATCH_V1_ENABLED` off                                                     | `draft`     | —                                                                |
| source `closed`                                                            | `closed`    | —                                                                |
| source `suspended`                                                         | `suspended` | —                                                                |
| source `paused`                                                            | `paused`    | —                                                                |
| source `open`, no pick / unknown id / text fails the worker-visible screen | `paused`    | `no_match_skills` / `unknown_match_skill` / `text_screen_failed` |
| source `open`                                                              | `open`      | —                                                                |

A refused twin stores no match or reach ids. It reaches nobody, whatever its status.

## The sync

The shared core is `packages/db/src/agency-twin.ts`. Two callers run it, so they cannot write
different twins:

| Trigger    | Where                                                                                                                                                    | Cadence                       | Does                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Event poll | `apps/api/src/agency-twin` (BullMQ `agency-twin-sync`, job `poll`)                                                                                       | every 30 s                    | re-syncs every agency job named by a `job.created/updated/closed` in the last 10 min                        |
| Sweep      | same queue, job `sweep`                                                                                                                                  | every 10 min                  | converges every agency job; catches the ADR-0037 suspension cascade and any write that emits no event       |
| CLI        | `pnpm db:sync:agency-twins` (after `pnpm --filter @badabhai/api build`; on a box: `node dist/agency-twin/sync-agency-twins.cli.js` in the api container) | by hand (flip window, probes) | the same sync and the same validated event; dry run by default; the shared ops guard on a production target |

What one job's sync does:

1. Locks the source row (`FOR UPDATE OF jobs`) in one transaction.
2. Plans and diffs the twin.
3. Writes the full sync-owned column set **only if something differs**.
4. Re-materializes the twin's `job_reach` when its match set or status changed.
5. Emits one `job_posting.twin_synced` v1 on the same transaction.

An unchanged source writes and emits nothing. A failure rolls back that job only; the next sweep
retries it. The agency service is unchanged, so a slow or failed sync never touches an agency
write.

### The kill switch: `AGENCY_TWIN_SYNC_ENABLED`

Read only through `isAgencyTwinSyncEnabled`. Default off.

- **Armed:** both triggers run as above.
- **Disarmed:** the sweep does exactly one thing. In one bounded statement it moves every twin
  that is not closed (and not already paused) to `paused`, copying no field and emitting
  `refused / kill_switch` for each. The poll does nothing.
- **Re-arming** restores every twin to its mirrored status on the next sweep. Applies, skips,
  unlocks and counters all live on the source id, so pausing hides nothing anyone already acted on.

Plumbing: the `production` environment secret, `ci.yml` `env:` and appleboy `envs:`,
`docker-compose.staging.yml` (`:-false`), and the `staging-deploy.sh` boolean preflight.

## Read and write fences

- **Writes (§4.3).** Only the sync writes a twin. The ops posting edit, close, verify and reject
  routes, the ops reach-widen, the admin force-close and the plan/boost purchases all refuse a
  twin with one identical `409`: "This job posting is system-managed and cannot be changed here".
  Payer routes never see a twin, because their `payer_id` scoping returns the neutral `404`.
  D3 (`db:backfill:job-postings`) skips twins.
- **V1 feed (§4.4).** A twin is served only while its **source** is open; source status always
  wins. Its interleave key is the source agency's `payer_id` (Q1). It is hidden from a worker who
  applied to or skipped the source job.
  - The ADR wording is "applied-only". Skips are included here because a V1 skip of a twin is
    recorded on the source too.
- **Applies, skips and unlocks (§4.5).** A V1 apply or skip naming a twin resolves to the source
  **before** choosing a code path, then runs the legacy job path:
  - writes `applications.job_id = source`, with the twin's rank snapshot frozen under E16;
  - bumps `jobs.applicants_received`;
  - emits `application.*` with subject `job`, using the same idempotency key a legacy apply uses.

  A twin whose source is not open gets the neutral `404`. An unlock naming a twin stores
  `unlocks.job_id = source`. On the payer route, the session must own the source.

- **D4 (§6.2).** `db:convert:seed-jobs` converts only `payer_id IS NULL` rows. It reports agency
  rows and never converts them, and it refuses `--apply` while any open agency row has no twin.

## Operator steps (ADR-0050 §6.3)

1. Apply the ADR-0050 §4.1 migration (apply-before-deploy), then deploy.
2. **(c)** For each live agency job:
   `PUT /ops/agency-jobs/:jobId/match-skills` with `{ "match_skill_ids": ["mskill_…"] }`.
   This needs the internal-service token and an admin session.
3. **(d)** Arm: `gh secret set AGENCY_TWIN_SYNC_ENABLED --env production --body true`, then redeploy.
4. **(e)** Probe:
   ```sql
   SELECT count(*) FROM job_postings WHERE sync_source = 'agency_job';
   ```
   The count must equal the number of agency jobs, and every twin must be `draft`. The union
   deck and search must be unchanged. The CLI dry run lists what would be refused:
   ```bash
   pnpm db:sync:agency-twins --match-v1=on --agency-twin-sync=on
   ```
5. **(g) Flip window:** deploy with `MATCH_V1_ENABLED` on, then run:
   ```bash
   pnpm db:sync:agency-twins --match-v1=on --agency-twin-sync=on --apply
   ```
   Then run D4 (seed rows only), then D5 `db:materialize:reach --apply`.

**Pre-flip check:** every open agency job must have a non-empty `jobs.match_skill_ids`:

```sql
SELECT j.id FROM jobs j JOIN payers p ON p.id = j.payer_id
 WHERE p.role = 'agent' AND j.status = 'open' AND j.match_skill_ids = '[]'::jsonb;  -- expect 0 rows
```

**Rollback:** disarm, or revert the code. The columns stay unused; they are not dropped
(CLAUDE.md §10). Twins remain as `paused` rows and are never deleted, because `source_job_id` is
provenance.
