# Database Migration Protocol

> Lives at the repo root, alongside `CLAUDE.md`, so it travels with every working branch
> and cannot go stale in a docs tree nobody reads.
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

Numbers are reserved **up front**, per developer, per workstream. Current head:
**`0071_outstanding_monster_badoon`** (journal has 72 entries, `idx` 0–71).

| Block         | Owner     | Workstream                                                    |
| ------------- | --------- | ------------------------------------------------------------- |
| `0067`        | Divyanshu | **APPLIED** — Phase 1 retrieval foundations                   |
| `0068`        | Prakash   | **CLAIMED** — W1 referral link metadata on `agency_invites`    |
| `0069`        | Divyanshu | **APPLIED** — Occupation Intelligence question packs (5 tables) |
| `0070`        | Prakash   | **MERGED** — worker notification prefs + Alerts watermark (#646) |
| `0071`        | Prakash   | **MERGED** — voice profiling form data spine (V1)              |
| `0072`–`0074` | Divyanshu | Occupation Intelligence — taxonomy, retrieval, remaining slots |
| `0075`–`0079` | Prakash   | Occupation Intelligence — orchestrator, profiling, parse      |
| `0080`+       | unclaimed | claim in a PR of its own, so the claim is reviewable          |

### The `0070` collision — 2026-08-07, and it happened exactly as this file predicted

Two branches minted `0070` on the same day. `#646` (notification prefs) took
`0070_bent_storm`; the voice data spine took `0070_confused_human_cannonball`. Git warned nobody,
and the second PR only discovered it as a merge conflict.

**One author was not enough to prevent it.** The voice-spine branch deliberately took a contiguous
number outside its nominal block on the reasoning that Prakash owned both backend workstreams, so
there was no second party to collide with. That reasoning was wrong, and the way it was wrong is
worth keeping: the collision risk is per **concurrent branch**, not per person. A single developer
running two sessions against one repo is two branches, and the protocol's whole purpose is that git
will not warn you. **Reserve by workstream even when you own every workstream.**

Renumbered to `0071` per rule 2 — and **regenerated rather than renamed**, because a drizzle
snapshot chains to its predecessor by `prevId`. A renamed `0070_*_snapshot.json` would still have
chained off `0069`, so the next `db:generate` would have diffed against a schema that skipped
`0070_bent_storm` entirely and emitted a migration to "add" columns that already exist. The
regenerated SQL was verified **byte-identical** to the original apart from the hand-appended RLS
tail, which was re-appended byte-for-byte.

### `when` was pinned, on purpose — read this before touching `0071`'s journal entry

`0071`'s journal `when` is **deliberately kept at the pre-renumber value** (`1786100629365`) rather
than the fresh timestamp `db:generate` emitted.

The reason is in drizzle's own migrator (`pg-core/dialect.js`): it applies a migration only when
`Number(lastDbMigration.created_at) < migration.folderMillis`. It is **timestamp-driven, not
hash-driven and not name-driven**. The old `0070_confused_human_cannonball` had already been applied
to a live database, stamping `created_at = 1786100629365`. Had the renumbered file carried a newer
timestamp, drizzle would have tried to re-run `CREATE TABLE worker_attributes` on a database that
already has it, and the whole chain would have died there.

Keeping the timestamp makes both cases correct with no manual intervention:

- a database that **already applied** the pre-renumber file: `0071` is skipped (equal, not less), and
  nothing is re-run;
- a database that **has not**: `0071.folderMillis` is still greater than `0070_bent_storm`'s, so it
  applies in order.

**The one case it does NOT fix, and it is not fixable in the repo:** any database that applied the
pre-renumber `0070` **before** `0070_bent_storm` landed will now skip `0070_bent_storm` forever, its
`created_at` being the smaller number. That database is missing `workers.notifications_enabled` and
`workers.notifications_read_at`, and the notification-prefs code from #646 will fail against it. The
remedy is manual and one-time: run `0070_bent_storm.sql` by hand, then
`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (<sha256 of the file>, 1786099264002)`
so the bookkeeping matches reality. It does not disturb `order by created_at desc limit 1`.

`0068` was released by the OIE sprint plan (below) and is now **taken** by the referral-metadata
workstream — a contiguous claim, so `idx` stays equal to the tag number and drizzle's snapshot
chain is unbroken. Divyanshu's OIE block therefore starts at `0069`; it lost a slot, not a
position. The alias unique index and the HNSW retune that originally held `0068` were folded
into `0067` and need no number of their own:

The sprint plan had reserved it for the alias unique index and the HNSW
retune, deferred until after `db:normalize:aliases` had run — because a unique index on
`(job_domain_id, text_norm, lang) NULLS NOT DISTINCT` fails while `text_norm` is still NULL
(every domain with 2+ aliases is a duplicate; verified against the live catalogue). Making that
index **partial on `is_searchable`**, which defaults to false, removes the ordering dependency
entirely — the index is empty at creation and cannot fail — so both statements folded into
`0067`. Two migrations that must be separated by a mandatory data-runner run is a deploy hazard;
one order-independent migration is not.

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
