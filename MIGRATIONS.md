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
**`0079_journey_read_indexes`** (journal has 80 entries, `idx` 0–79).

| Block         | Owner     | Workstream                                                    |
| ------------- | --------- | ------------------------------------------------------------- |
| `0067`        | Divyanshu | **APPLIED** — Phase 1 retrieval foundations                   |
| `0068`        | Prakash   | **APPLIED** — W1 referral link metadata on `agency_invites`    |
| `0069`        | Divyanshu | **APPLIED** — Occupation Intelligence question packs (5 tables) |
| `0070`        | Prakash   | **MERGED** — worker notification prefs + Alerts watermark (#646) |
| `0071`        | Prakash   | **MERGED** — voice profiling form data spine (V1)              |
| `0072`–`0073` | Divyanshu | **MERGED** — OIE P8 cutover: `unresolved_phrase.scope`, pack answers (#650) |
| `0074`        | Prakash   | **MERGED** — `.enableRLS()` model markers, 31 tables (BL-26, #839) |
| `0075`        | Divyanshu | **MERGED** — `job_postings` state for `GET /jobs/search` (#822, #856) |
| `0076`        | Prakash   | **APPLIED IN PRODUCTION** — canonical Domain→Skill taxonomy, Phase 1 (`fca0ef9c`; verified 2026-08-19) |
| `0077`        | Prakash   | **APPLIED IN PRODUCTION** — AI cost attribution: three running-total tables (verified 2026-08-19) |
| `0078`        | Prakash   | **APPLIED IN PRODUCTION** — S3-C / D-6: `unresolved_phrase.job_domain_id` (verified object-by-object 2026-08-19) |
| `0079`        | Prakash   | **CLAIMED** — admin worker-journey read indexes (#992; renumbered from `0078`, see notes below) |
| `0080`+       | unclaimed | OIE's orchestrator/profiling/parse migration lands here; claim in a PR of its own |

### `0079` — renumbered from `0078` after a live collision — 2026-08-19

**This is the collision this file exists to describe, and it happened again.** `#992` minted
`0078_journey_read_indexes` (two CREATE INDEX statements, nothing else) while S3-C minted
`0078_unresolved_phrase_job_domain_id` on another branch. S3-C merged first, so `#992` moved to
`0079` per rule 2 — taking the last slot of the OIE block, exactly as `0077` and `0078` took the
first two, and for the reason recorded there: drizzle-kit assigns sequentially and
`supabase-checks.yml` enforces contiguous prefixes, so there is exactly one legal next number.
**OIE's orchestrator/profiling/parse migration is now `0080`.** The block reservation has now
been overtaken three times; it is a record of intent, not a reservation the generator honours.

**REGENERATED, NOT RENAMED** — the `0071` rule. A drizzle snapshot chains to its predecessor by
`prevId`, so a renamed `0078_snapshot.json` would still have chained off `0077`, and the next
`db:generate` would have diffed against a schema that skipped `0078_unresolved_phrase_job_domain_id`
entirely. Verified after regeneration: `0079_snapshot.json.prevId == 0078_snapshot.json.id`, and a
second `db:generate` emits nothing.

**The `when` was NOT pinned, and that is the opposite of what `0071` did.** `0071` kept its
pre-renumber timestamp because its old file had already been applied to a live database and
drizzle's migrator is timestamp-driven (`created_at < folderMillis`), so a newer `when` would have
re-run its `CREATE TABLE`. Here the pre-renumber file has ALSO been applied by hand to a live
database — but the two statements are `CREATE INDEX IF NOT EXISTS`, so re-running them is a no-op,
while pinning the old `when` (`1787058904704`) would order this entry BEFORE
`0078_unresolved_phrase_job_domain_id` (`1787061158602`) and make every database that applied
`0078` skip this file forever. Idempotent DDL is what makes the fresh timestamp the safe choice;
`0071`'s was not idempotent, which is why it needed the other answer. **The journal row the manual
apply wrote under the old timestamp must be deleted from that database** — otherwise its
`created_at` high-water mark is `1787058904704`, which is fine, but the row claims a hash for a
file that no longer exists.

**`IF NOT EXISTS` is hand-re-appended.** `db:generate` emits both statements bare — verified on
this regeneration, not assumed. This is the same class of hand-edit as `NULLS NOT DISTINCT` in
`0037`/`0067`/`0072`/`0076`/`0078`, and it is load-bearing twice over: the migration's own TIMING
note tells an operator to build `events`' index CONCURRENTLY outside the transaction and let the
statement no-op, and the live database that took the manual apply already holds both indexes under
these exact names.

**NOT apply-before-deploy.** Both journey queries are correct without the indexes and merely slow,
so an app deployed ahead of this file serves identical JSON off a sequential scan. It IS
apply-before-the-page-carries-real-traffic. Rollback is two `DROP INDEX`es with the app live —
nothing references an index, and the reads return the same rows, slower. The full reasoning,
including the `events` write-lock caveat, is in the migration's own header.

### `0078` — additive, APPLY BEFORE DEPLOY, no backfill — 2026-08-18

**It takes the second slot of the OIE block**, exactly as `0077` took the head, and for the same
reason: the block was reserved before either workstream existed, and leaving a hole to preserve a
stale reservation costs more than re-recording it. `0079` was OIE's last remaining slot when this
note was written; it has since gone to `#992` (see the `0079` note above), so OIE now lands on
`0080`.

**APPLY BEFORE DEPLOY. Corrected 2026-08-19 — the first version of this note said the opposite,
and was wrong.**

The reasoning it gave ("nothing writes `job_domain_id` unless a caller sends one, and no caller
does") describes the DTO, not the SQL. `SkillsRepository.recordUnresolved` names the column in the
INSERT list and in the `ON CONFLICT` target **unconditionally** — a legacy or occupation miss binds
NULL for it, but the column still has to exist. Against a database without `0078` every unresolved
write fails, not just a canonical one: `42703 column "job_domain_id" does not exist`, or `42P10` on
the conflict target, which must name the widened index's exact five columns.

**The path that would actually have hit it is the occupation one, and it runs today.**
`IdentifyService` → `OccupationService.recordUnresolved` → the same widened SQL, on every
below-floor trade phrase in a live worker interview. Blast radius was bounded rather than
catastrophic — `identify.service.ts` wraps the call in try/catch and logs "the interview is
unaffected", so the failure mode is **growth signal silently lost**, not a 500 for the worker. That
is a fail-soft worth having and not a reason the ordering claim was acceptable.

**APPLIED TO PRODUCTION 2026-08-19, and verified rather than taken on report.** An earlier
version of this note claimed the same thing a day too early, on report, and it was false: at that
point the column did not exist while the code that names it was already deployed, so every
unresolved write was failing (the interview path swallowed it; the two `unresolved` endpoints
returned 500). That is the whole reason the check below exists.

Verified state after the apply:

| object | state |
|---|---|
| `unresolved_phrase.job_domain_id` | `text`, nullable |
| `unresolved_phrase_scope_uq` | `(scope, phrase, domain_id, job_domain_id, lang) NULLS NOT DISTINCT` |
| `unresolved_phrase_one_domain_chk` | `CHECK ((domain_id IS NULL) OR (job_domain_id IS NULL))` |
| `unresolved_phrase_job_domain_id_idx` | btree on the FK column |
| FK | `job_domain(job_domain_id)`, `ON DELETE NO ACTION` |
| rows | **9 preserved**, summed `count` 10, `first_seen` and `last_seen` untouched. No row split, none merged |

The write path was then exercised against the real production schema inside a transaction that
was rolled back — canonical, legacy and occupation shapes all upsert; the same phrase in two
different job domains produces two DISTINCT rows (the point of the widening); a repeat dedupes and
increments; both-set is refused by the CHECK; a bogus `job_domain_id` is refused by the FK. Row
count and summed `count` were identical before and after, so production carries nothing from it.

**Do not take a migration's application on report.** `drizzle.__drizzle_migrations` will not
settle it either — production shows 76 applied rows against 79 files, because earlier migrations
were baselined, so the count reads as alarming and means nothing. Ask for the OBJECTS:

```bash
pnpm --filter @badabhai/db db:audit:schema-contract   # read-only; exits 1 if the DB is behind
```

That check is manifest-driven (`packages/db/src/schema-contract.ts`) and covers every object the
deployed code names unconditionally. It verifies the unique index's SHAPE, not merely its
existence — a same-named index with the old four-column list is the quieter failure, because two
canonical misses of one phrase in different job domains would merge into a single summed row with
nothing raised anywhere.

The reverse order is still safe: applying `0078` ahead of the code changes nothing, since the
column is nullable with no default and the pre-`0078` SQL never mentions it.

**What it does, and the one part that is easy to get wrong:**

| statement | note |
|---|---|
| `ADD COLUMN job_domain_id text` + FK to `job_domain` | nullable, defaultless → catalogue-only on PG11+, no rewrite |
| `DROP` + re-`CREATE` `unresolved_phrase_scope_uq` with `job_domain_id` | **the load-bearing statement.** Without it two canonical misses of one phrase in different domains both carry `domain_id IS NULL`, collide on the old 4-column key, and merge into a single row with a summed `count`. No error; the data is simply wrong, and wrong in the direction that makes Path A look healthier than it is |
| `NULLS NOT DISTINCT` re-appended BY HAND | fourth time in this schema (`0037`, `0067`, `0072`, `0076`). `db:generate`'s output for THIS migration omitted it again — verified, not assumed. Dropping it is an active regression: the occupation scope has written `domain_id = NULL` since `0070` and depends on NULLs deduping onto one row. Pinned by `unresolved-phrase-job-domain.test.ts` |
| `unresolved_phrase_one_domain_chk` | at most one vocabulary per row. Three legal shapes (legacy / canonical / occupation-both-null); only both-set is refused |

**Index rebuild lock:** DROP + CREATE, not CONCURRENTLY — drizzle wraps each migration in a
transaction and `CREATE INDEX CONCURRENTLY` cannot run in one. `unresolved_phrase` held **9 rows**
in production when this was authored (measured), so the window is sub-millisecond. Re-measure
before applying if that has changed by orders of magnitude.

**Rollback** is written into the migration's own footer, and is lossy only once canonical misses
exist — after that, re-derive from `skill.phrase_unresolved_v2` on the event spine before dropping.

**Event contract:** adds `skill.phrase_unresolved_v2`; `skill.phrase_unresolved` v1 is untouched
and still emits for legacy-scoped misses. A second registry entry rather than relaxing v1's
required `domain_id`, which would break every consumer reading the field without a null check.

### `0077` — additive, no ordering constraint, no backfill — 2026-08-18

**NOT apply-before-deploy — BUT ONLY BECAUSE OF THE SAVEPOINT.** It creates three empty tables
(`worker_ai_cost_totals`, `session_ai_cost_totals`, `platform_ai_cost_totals`) that nothing reads
yet. Deploying the app before applying it does not break a request, and does not lose an event
either: the only writer is `AiCostRecorder.record()`, which runs the accrual inside a `SAVEPOINT`
on the event's transaction and catches its failure, so the `ai.cost_recorded` row still commits.
The cost is accuracy (uncounted spend), not uptime and not the ledger.

That qualifier is the whole claim. Without the savepoint this line was **false**: the accrual's
unconditional `platform_ai_cost_totals` upsert raises `relation "platform_ai_cost_totals" does
not exist`, which aborts the enclosing transaction, and Postgres executes the eventual `COMMIT`
as a `ROLLBACK` — so every `ai.cost_recorded` event on every surface would have been silently
dropped for as long as the app ran ahead of the migration, one `warn` line each. If anyone ever
removes the savepoint, this migration becomes apply-before-deploy and this row must change with
it. Staging CD already migrates before it deploys (`.github/workflows/staging-cd.yml`), so the
exposure was never staging's normal path — it is the rollback path, a hand-run deploy, and any
environment whose migration step is separate from its deploy step.

**No backfill ships with it.** The tables accrue from the moment they exist; spend already on the
event spine is not counted, so every figure derived from them means "since 0077" until a backfill
is separately authorised and run against `events WHERE event_name = 'ai.cost_recorded'`.

**Rollback is three `DROP TABLE`s** in any order — no other table has an FK to them, no view or
function selects from them, and the only code that touches them is `AiCostTotalsRepository`, whose
single caller runs in that savepoint. So dropping them **while the app is live** degrades cost
accrual to a warn per AI call and changes nothing else; the event spine they are derived from is
untouched, and a re-apply plus a backfill reconstructs every figure exactly. Dropping the *code*
first is optional, not required.

One thing a rollback must not forget: all three tables are listed in `LOCKED_TABLES` in
`tests/e2e/rls-spine.e2e.test.ts`. That gate asserts RLS + FORCE + no grants on each name, so it
fails on a table that no longer exists — remove those three entries in the same change that drops
the tables.

**Time the DDL under a `lock_timeout`.** The `ADD CONSTRAINT ... FOREIGN KEY` statements take
`SHARE ROW EXCLUSIVE` on `workers` (twice) and `chat_sessions` — the two hottest worker-side
tables — which conflicts with the `ROW EXCLUSIVE` every ordinary write holds. Validation itself is
instant (the new tables are empty), but the request queues behind any in-flight transaction on
those tables and every writer arriving after it queues behind the request. `0073` set the same
precedent, so this is timing guidance, not a blocker:

```sql
SET lock_timeout = '3s';   -- fail fast rather than stall the write path
-- run the migration; on 55P03 (lock_not_available) wait and retry
```

**It takes the head of the OIE block.** `0077`–`0079` was reserved for Occupation Intelligence;
that workstream has not minted `0077` on any branch, and this file's own rule is that the claim is
recorded in the change that takes it. OIE's remaining slot is now `0080` — `0078` went to S3-C and
`0079` to `#992`.

### `0076` deploy ordering and rollback — 2026-08-16

Two operational facts that the migration header does not carry, recorded here because both
were found by review rather than by anyone hitting them.

**MIGRATE BEFORE YOU DEPLOY.** `0076` adds `job_postings.job_domain_id`, and `schema/job.ts`
adds the matching Drizzle column. Drizzle enumerates columns explicitly on `.select()`, so a
`@badabhai/db` build containing that column, deployed against a database that has not run
`0076`, fails **every** `job_postings` read with `column "job_domain_id" does not exist` — not
merely the new canonical arm. There is no application-level feature flag that avoids this; the
ordering is the control.

**THE ROLLBACK IS NO LONGER SINGLE-COMMIT.** The recipe in the migration header was written at
Phase 1 and is correct in isolation. `ef73ce70` then made
`apps/api/src/skills/skills.repository.ts` query `job_domain_skill` directly, so reverting
`0076` now requires reverting `ef73ce70` in the same operation. Today the blast radius is
compile/deploy-time rather than request-time — nothing writes `job_postings.job_domain_id`
yet, so the canonical arm is unreachable at runtime — but the pairing is real and the header
does not mention it.

### The `0076` claim, and the stale table that preceded it — 2026-08-16

Two things were wrong here and both are worth recording, because the second is the kind of
error this file exists to prevent.

**The head was stale by five migrations.** This table claimed `0071` / 72 entries while the
journal actually held 76 entries through `0075_job_postings_state`. Anyone trusting it for
"the next free number" would have minted `0072` and collided with a merged migration. The
protocol's whole premise is that git will not warn you — a reservation table that lags the
journal is worse than no table, because it is confidently wrong. **Refresh the head in the
same PR that claims a block, not later.**

**`0075`–`0079` was reserved for OIE, and `0076` was taken anyway.** Deliberately, and on
this evidence: the OIE sprint plan documents its own nominal `0075`/`0076` claims being
renumbered down to `0071`/`0072` (drizzle-kit assigns sequentially, so a reservation cannot
survive contact with the generator); `0075` was then consumed by an unrelated job-search
change under a different owner; no branch of the 86 on `origin` holds a `0076`+ file; and
`.github/workflows/supabase-checks.yml` enforces contiguous prefixes, so skipping to the
unclaimed `0080` is not reachable — there is exactly one legal next number.

The block reservation was already not being honoured as written. Rather than pretend
otherwise, the remaining OIE slots are renumbered to `0077`–`0079` above. **If that conflicts
with in-flight OIE work, this is the line to argue with** — the migration itself is
additive and its rollback is documented in its own header.

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
