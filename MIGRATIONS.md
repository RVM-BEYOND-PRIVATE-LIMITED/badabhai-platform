# Database Migration Protocol

> Lives at the repo root because `docs/` is deliberately not carried on working branches.
> Owner: Backend Platform. Applies to every change under `packages/db/migrations/`.

## Why this file exists

`drizzle-kit` writes **three** artefacts per migration:

1. `packages/db/migrations/NNNN_slug.sql`
2. an entry in `packages/db/migrations/meta/_journal.json`
3. `packages/db/migrations/meta/NNNN_snapshot.json`

Two developers generating concurrently collide on **all three**, and git will not warn anyone —
each branch mints a locally-unique number that is only discovered to be wrong once both merge.

This has already cost the project real work:

- `88cb536` had to hand-renumber the job-domain migration `0060` → `0066`, because
  `0060_referral_links_and_clicks.sql` had claimed the slot on another branch. Comments referring
  to "migration 0060" survived that renumber and were only corrected later.
- The tech-debt register recorded the same hazard prospectively: _"two branches can each mint a
  locally-unique number and git will not warn you."_

## Reserved blocks

Numbers are reserved **up front**, per developer, per workstream. Current head: **`0066_special_pyro`**
(journal has 67 entries, `idx` 0–66).

| Block         | Owner     | Workstream                                                    |
| ------------- | --------- | ------------------------------------------------------------- |
| `0067`–`0074` | Divyanshu | Occupation Intelligence — taxonomy, retrieval, question packs |
| `0075`–`0079` | Prakash   | Occupation Intelligence — orchestrator, profiling, parse      |
| `0080`+       | unclaimed | claim in a PR of its own, so the claim is reviewable          |

## Rules

1. **Rebase before you generate.** Never run `pnpm db:generate` on a branch that is behind `main`.

2. **Stay in your block.** If drizzle assigns a number outside it:
   - rename the `.sql`,
   - renumber `idx` in `meta/_journal.json` (keep `when` monotonic with `idx`),
   - rename the matching `meta/NNNN_snapshot.json`,
   - re-run `pnpm db:migrate` against a **fresh** database to confirm it still applies cleanly.

3. **A pure refactor must emit nothing.** After any change that only _moves_ schema code between
   modules, `pnpm db:generate` must produce **no** migration. Drizzle diffs the schema against the
   latest snapshot, so an emitted file means you changed semantics, not just layout. Delete the
   emitted `.sql` and snapshot, restore `_journal.json`, and fix the refactor.

   This is the standing verification for any `packages/db/src/schema/` reorganisation:

   ```bash
   pnpm db:generate
   node -e "const j=require('./packages/db/migrations/meta/_journal.json');console.log(j.entries.length, j.entries.at(-1).tag)"
   git status --short packages/db/migrations   # must be EMPTY
   ```

4. **Expand-only by default.** Per `CLAUDE.md` §10: never drop a production column, never rename
   without a migration, prefer additive. Anything risky goes expand → migrate → contract across
   separate releases.

5. **Comments carry the number.** If you renumber, grep for the old number and fix the prose —
   `schema.ts`, the runner headers under `packages/db/src/`, and `infra/supabase/rls-plan.md` have
   all drifted this way before. Be careful: some `0060` references legitimately point at
   `0060_referral_links_and_clicks.sql` and must **not** be rewritten.

## Deploy gates

Reference-data migrations have verifier scripts that exit non-zero on failure. Run them after
`pnpm db:migrate`:

```bash
pnpm db:verify:domains    # job_domain / job_domain_alias catalogue
pnpm db:audit:domains     # files <-> DB id-set diff, both directions
```
