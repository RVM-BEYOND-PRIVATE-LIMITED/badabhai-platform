# API hot-path performance notes (P3 audit)

Scope: the `apps/api` audit, performance pass (P3). Records the concrete fixes
landed and the honest state of the load baseline.

## Indexes added (migration 0022)

| Index | Backs | Query |
| ----- | ----- | ----- |
| `jobs_status_created_at_idx` on `jobs(status, created_at)` | Worker feed + Reach View B | `findOpenJobs` / `listOpenJobSignalRows`: `WHERE status='open' ORDER BY created_at` (was a seq scan; `jobs` previously had **no** indexes, only CHECKs) |
| `job_postings_status_created_at_idx` on `job_postings(status, created_at)` | Ops job-postings list | `JobPostingsRepository.list`: `WHERE status=? ORDER BY created_at DESC LIMIT n` (`job_postings` previously had **no** indexes) |

Both are plain additive `CREATE INDEX` (composite, btree). On alpha-sized tables
the build lock is negligible; if these grow large before this ships to a busy
environment, switch to `CREATE INDEX CONCURRENTLY` (drizzle does not emit it —
hand-edit the migration).

## Unbounded ops list reads — now capped (`OPS_LIST_CAP = 500`)

These ops/internal reads took no `?limit` and had no cap; a bounded `LIMIT` was
added (with a deterministic order so the capped page is stable):

- `ApplicationsRepository.findApplicantsByJob` — `ORDER BY created_at ASC LIMIT 500`
- `ApplicationsRepository.findApplicationsByWorker` — `ORDER BY created_at ASC LIMIT 500`
- `UnlocksRepository.listByPayer` — `ORDER BY created_at DESC LIMIT 500`

If an ops view legitimately needs more than 500 rows, add real pagination
(`?limit`/cursor) — a follow-up, not a safety issue.

## Deliberately NOT changed

- **Reach `listSignalRows` / `listOpenJobSignalRows` (full pool).** These feed the
  deterministic RANK core, which ranks the **full** candidate pool by design
  (ADR-0011, alpha "View A full-pool"). Capping them would silently change which
  candidates are ranked — a ranking-semantics change that needs an ADR, not a
  perf tweak. Left uncapped; flagged for the Reach owner. The per-worker / per-job
  signal lookups it also uses are already index-backed (`worker_profiles_worker_id_idx`).
- **Event emission on the feed/reach paths.** Already batched into a single
  round-trip via `EventsService.emitMany` (no N+1) — verified, no change.

## Load baseline — follow-up (not run here)

A real autocannon/k6 baseline requires a running API + seeded Postgres (staging or
`pnpm db:up`). It was **not** run in this PR and no numbers are recorded here
rather than fabricate them. To capture it:

1. `pnpm db:up && pnpm db:migrate` (applies 0022), seed jobs/applications.
2. `pnpm --filter @badabhai/api dev`.
3. `autocannon -d 20 -c 20 http://localhost:3000/feed` (with a worker bearer token)
   and the ops reads; record p50/p99 + `EXPLAIN ANALYZE` showing the new indexes
   are used (`Index Scan using jobs_status_created_at_idx`).

Owner: performance-engineer + the Reach owner (reach full-pool question).
