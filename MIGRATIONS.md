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
**`0081_worker_feedback_screen_context`** (journal has 82 entries, `idx` 0–81).

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
| `0079`        | Prakash   | **APPLIED IN PRODUCTION** — admin worker-journey read indexes (#992; renumbered from `0078`, see notes below; verified object-by-object 2026-08-19) |
| `0080`        | Divyanshu | **APPLIED IN PRODUCTION** — worker app feedback table (#997, `ac3db91c`). Verified object-by-object 2026-08-19: 6 columns, 3 CHECKs, the FK, 3 indexes, RLS enabled + FORCED, all four REVOKEs, and two real rows written through the live path |
| `0081`        | Prakash   | **APPLIED IN PRODUCTION** — `worker_feedback.screen_context` (#1036). Recorded in `drizzle.__drizzle_migrations` (`created_at=1787141865609`) and verified by `db:audit:schema-contract`. Note this migration is the ONLY one of `0076`–`0081` that is journal-recorded — see the drift note below |
| `0082`        | Prakash   | **APPLIED IN PRODUCTION 2026-08-20, AND NOW RECORDED** — R39: re-lock the seven public tables `db:audit:rls` reported open. Permissions only; no table, column, index or constraint moves. Minted as `0081` and renumbered after `#1036` took that slot. Rehearsed first (`db:verify:rls-lock`, 22/22 PASS), then applied **by hand rather than through `db:migrate`**, so its objects are live and `drizzle.__drizzle_migrations` has no row for it. Verified after the fact: `db:audit:rls` = **77/77 locked, 0 deviating**; `db:audit:schema-contract` = **READY**. Recorded by adoption on 2026-08-20 — not by `db:migrate`, which can no longer reach it; see the drift note below |
| `0083`+       | unclaimed | OIE's orchestrator/profiling/parse migration lands here; claim in a PR of its own |

### The journal is five files behind, and what that actually costs — corrected 2026-08-20

**`0076`–`0080` are LIVE in production and UNRECORDED in `drizzle.__drizzle_migrations`.** All
five were applied out of band, so their objects exist and their journal rows do not.

**The rule this file stated on 2026-08-19 was wrong, and the correction changes the
instruction.** It said `drizzle-kit migrate` "replays every unrecorded file in order". Read from
the installed `drizzle-orm@0.45.2` (`pg-core/dialect.js`; `drizzle-kit migrate` delegates to it):

```js
select id, hash, created_at from drizzle.__drizzle_migrations
  order by created_at desc limit 1          // ONE row. A WATERMARK.
for (const m of migrations)
  if (!last || Number(last.created_at) < m.folderMillis) { …apply…; …insert… }
```

It is a **high-water mark**, not set membership. Everything with a `when` above the newest
recorded `created_at` is applied; everything at or below it is skipped, recorded or not. The two
models agreed on 2026-08-19 only by coincidence — the watermark sat at `0075`, so "unrecorded"
and "above the watermark" named the same five files. They came apart when `0081` was applied out
of band on 2026-08-20 and moved the watermark to `1787141865609`.

**RESOLVED 2026-08-20. The journal now matches the database: `--doctor` reads 83/83, and
`db:migrate` will attempt no DDL.** What follows is how it got there, because the route changed
twice in one day and the second change is the one worth remembering.

| | |
|---|---|
| journal entries | 83 |
| recorded, matching a journal entry | **83** |
| unrecorded | **0** |
| recorded rows matching NO journal entry (orphans) | **1** — see below |

**The plan that stopped working.** `0082` was applied by hand, so it was live and unrecorded but
*above* the watermark — which meant `db:migrate` would replay it (a measured no-op) and write the
row. That was the instruction in this file for about an hour. Then a **third** out-of-band apply
landed, from a checkout that has never reached `main`, carrying a hand-pinned
`created_at = 1787230000000`. That is **above** `0082`'s `1787220000000`, so the watermark moved
past `0082` and `db:migrate` went from *replaying* it to **skipping it silently, forever** — the
dangerous direction, arrived at without anyone touching `0082`.

**Why adoption could not take it either, and what changed.** `0082`'s Section B is a
`to_regclass`-guarded `DO $$` block, and adoption refuses dynamic SQL on principle: what the
block does is chosen at run time and cannot be read off the file. Both routes were closed.

The fix is an **effect verifier** — see `EFFECT_VERIFIERS` in `src/migration-adoption.ts`. It is
not a relaxation. A migration may register a function that verifies its EFFECTS against the live
catalog, which is *stronger* evidence than the text parse it replaces: a parse asks what the file
says, a verifier asks what the database is. It is keyed to one migration tag, it runs **in
addition** to the static check rather than instead of it, it must assert a non-zero number of
facts (a test pins this), and it can still fail. `0082`'s checks all seven tables for
ENABLE + FORCE + four revoked roles — **42 assertions**, all satisfied, which is how it was
recorded.

Run against a database where `0082` is not applied, the same verifier reports 42 problems and
adoption refuses. The property the runbook needs — *cannot record a migration whose effects are
absent* — is preserved exactly, and now covers the four GAP-DB-21 tables the parse could never
see.

**The orphan row stays, and it is not ours to remove.** `created_at=1787230000000`,
hash `b70e16df…`, matching no migration file in this checkout and no open PR. Production carries
a table this repository does not model as a result — `db:audit:live-drift` reports **78 live
public tables against 72 declared**. It is locked (`db:audit:rls`: 78/78, 0 deviating), so there
is no exposure; it is a reconciliation the migration's author owes. Both `--doctor` and the
`[adopt]` header now name it rather than absorbing it into a subtraction.

**What to run, and when.** The journal is clean, so there is nothing owed today. Keep these for
the next time it is not:

```bash
# STATE OF PLAY — run these three before believing anything about the journal.
cd packages/db
npx tsx adopt-migrations.ts --doctor                   # 83/83 today; names orphan rows
npx tsx reconcile-migrations.ts                        # per file: RECORDED / LIVE / ABSENT / PARTIAL
pnpm --filter @badabhai/db db:audit:live-drift         # live schema vs the Drizzle schema, both ways

# A MIGRATION APPLIED OUT OF BAND, ABOVE THE WATERMARK — db:migrate replays it. Check the replay
# is a no-op FIRST; for a permissions migration `db:verify:rls-lock` rehearses it for real.
pnpm --filter @badabhai/db db:migrate

# APPLIED OUT OF BAND, AT OR BELOW THE WATERMARK — db:migrate will skip it SILENTLY. Adoption is
# the only route. It is all-or-nothing, so pin the set with --only.

# HYGIENE — record the five live files so the journal stops lying. No DDL runs.
cd packages/db
npx tsx reconcile-migrations.ts                        # per file: RECORDED / LIVE / ABSENT / PARTIAL
npx tsx adopt-migrations.ts --only 0076_canonical_domain_skill_taxonomy,0077_ai_cost_running_totals,0078_unresolved_phrase_job_domain_id,0079_journey_read_indexes,0080_worker_feedback
npx tsx adopt-migrations.ts --only 0076_canonical_domain_skill_taxonomy,0077_ai_cost_running_totals,0078_unresolved_phrase_job_domain_id,0079_journey_read_indexes,0080_worker_feedback --apply --expect-host aws-1-ap-south-1.pooler.supabase.com
npx tsx adopt-migrations.ts --doctor                   # expect 83/83 match, 0 orphan rows
```

**The `--only` list is spelled out twice on purpose, and it is not padding.** Adoption is
all-or-nothing, and `0082` is unrecorded *and* unadoptable — so a bare
`adopt-migrations.ts --apply` sweeps it into the set and correctly refuses all six, recording
nothing. That holds whether or not `db:migrate` has run first, which is what makes the pin
mandatory rather than tidy. A `<the same list>` placeholder in a runbook is the line someone
paraphrases at 2am; the literal one is the line they paste.

**Three properties worth knowing before running it, each demonstrated against production on
2026-08-20 rather than argued:**

| | evidence |
|---|---|
| it cannot mark a **missing** migration as applied | `--only 0082_rls_lock_seven_tables`, run *before* the apply → `REFUSING to record ANYTHING`, exit **1**, ten stated mismatches — nine of them the grants `0082` had not yet revoked |
| …and it keeps refusing once the objects arrive | the **same command after** the apply → `clean=0 mismatched=1`. The nine grant mismatches are gone — independent corroboration, from a second tool, that the lock really took — and the dynamic-SQL refusal stands. Verifiability is a property of the file, not of the database |
| it is **idempotent** — an already-recorded migration is not even selected | `--only 0048_empty_archangel` → `selected=0`, `nothing to do` |
| the five in the list verify **clean at full depth** | `clean=5 mismatched=0` — tables, columns *and their types*, indexes, constraints, RLS enable/force, and every `REVOKE ALL` |
| **idempotency, proven live rather than argued** | after the real run recorded all six, re-issuing the same `--apply` returned `recorded=84 unrecorded=0 selected=0`, `nothing to do`. The insert is `INSERT … WHERE NOT EXISTS` in one transaction, so it holds for overlapping runs too |
| an **effect verifier** does not weaken any of the above | `0082` adopted on **42 catalog assertions**; remove the lock from any one of the seven tables and the same command refuses. Unit-tested in both directions |

The write itself is `INSERT … WHERE NOT EXISTS` inside one transaction, so the guard survives two
overlapping runs as well as two sequential ones — `__drizzle_migrations` has no unique constraint
on `created_at` to fall back on.

`--only` is required here, not optional: adoption is all-or-nothing, and `0082` is unrecorded
*and* unadoptable, so an unpinned run correctly refuses the whole set. `--expect-host` is
not ceremony either — adoption records DDL as done **without running it**, so the wrong target
writes a false journal row that every later migration inherits.

**Adoption's two blind spots, and what one of them cost.** The depth check covers objects. Until
2026-08-20 it did **not** look at GRANTs, and it treated a migration with no checkable objects as
vacuously clean. That is how `0048` came to be recorded as applied with its twelve REVOKEs never
run — which is `R39`, and why `0082` exists. Both are refusals now, as is dynamic SQL. The
compensating control is `db:audit:rls`, which sweeps every live table for the lock rather than
trusting any migration to have applied it.

**And the direction nothing was checking at all:** `--doctor` only ever asked *"is each file
recorded?"*. It now also asks *"is each recorded row a file?"*. A row with no journal entry means
production has applied a migration this checkout does not contain — which is exactly how `0081`
was found to be taken while a second branch was minting its own.

### `0082` — R39: permissions only, APPLY ANY TIME, no backfill — 2026-08-20

**Not additive and not destructive — it changes only who may reach seven tables.** No CREATE,
no ALTER COLUMN, no DROP, and it grants nothing to anyone. A test asserts all four of those
properties against the file itself.

**What R39 is.** `db:audit:rls` sweeps all 77 public tables for the three conditions the house
pattern requires — RLS enabled, FORCE, and no grant to a Data-API role. Seven fail. Measured
2026-08-20: every one is **empty (0 rows)**, owned by `postgres`, with 0 policies.

**The grant is the finding, not the missing FORCE.** "RLS is on with zero policies, so
everything is denied" is true for `anon` and `authenticated` and **false for `service_role`**,
which has `rolbypassrls = true` — RLS does not apply to it at all, so the grant is the only
control and on these seven it is wide open, every DML privilege plus TRUNCATE. Three of the
seven are correctly FORCEd *and still reachable*, which is what makes this worth a migration
rather than a note.

**Two sections, because the seven divide.**

| | tables | why |
|---|---|---|
| **A** | `agency_kyc`, `agency_payout_accruals`, `agency_payout_requests` | `0048` already declares FORCE + all four REVOKEs for them. Its DDL is live and it is *recorded*, but its REVOKE tail never ran on production. Unconditional here; a no-op wherever `0048` ran in full |
| **B** | `agency_profiles`, `employer_profiles`, `payer_capabilities`, `payer_member_invites` | exist on production and in **no** migration and **no** schema file (`GAP-DB-21`). Guarded by `to_regclass` — an unconditional ALTER would abort `0082` on every fresh database and take the slot with it |

**Dropping the four is the better end state and is deliberately not this migration.**
`GAP-DB-21`'s recorded recommendation is to drop them — `payer_member_invites` FKs to
`auth.users` (Supabase Auth, unused here) and `payer_capabilities` is superseded by the shipped
`org_role` enum. That is a destructive production action needing an owner's ruling. Locking them
costs nothing and does not prejudge it.

**Rehearsed, not reasoned.** `pnpm --filter @badabhai/db db:verify:rls-lock` runs the exact
statements against the live database inside a transaction that **cannot commit**, then re-reads
the catalog after the rollback and fails if anything moved. It answers the three things review
cannot: that the REVOKEs actually take (a REVOKE only removes grants the executing role may
remove — every grant here has `grantor = postgres`, and so does the migration), that FORCE does
not lock the backend out (`postgres` is `rolbypassrls`), and that the Section-B guard does not
silently skip a table that is present. **22/22 PASS against production, 2026-08-20.**

**Timing.** ACCESS EXCLUSIVE per statement, microseconds each, seven empty tables. Run under
`SET lock_timeout = '3s';` and retry on 55P03, per the `0073`/`0077`/`0080` precedent.

**Rollback.** Re-grant. Nothing is lost and no data moves — the grants being restored are the
finding.

**Hand-written, not generated.** Drizzle-kit models `ENABLE ROW LEVEL SECURITY` and nothing else
about the lock, so there is no model change to generate from. `meta/0082_snapshot.json` is a copy
of `0081`'s with a fresh `id` and `prevId` chained to it — genuinely unchanged, because nothing
in the model moves. Verified: `npx drizzle-kit generate` after this lands emits *"No schema
changes, nothing to migrate"*.

**Slot — and the fourth collision this file has recorded.** Minted as `0081`, renumbered to
`0082` before merge: `#1036` took `0081` (`0081_worker_feedback_screen_context`) and **applied it
to production** while this branch was in flight, so the clash was not only in the tree, it was
already in `drizzle.__drizzle_migrations`. Nothing local reported it — every tool asked "is each
FILE recorded?" and none asked "is each RECORDED ROW a file?". That direction is now part of
`adopt-migrations.ts --doctor`. REGENERATED, NOT RENAMED (the `0071` rule): the snapshot was
re-derived from `0081`'s, so `0082_snapshot.json.prevId == 0081_snapshot.json.id`, verified by a
`db:generate` that emits nothing. The pre-renumber file was never applied anywhere, so its `when`
needed no pinning. **OIE moves to `0083`.**

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

### `0080` — additive, APPLY BEFORE DEPLOY, no backfill — 2026-08-19

One new table, `worker_feedback`: the worker taps the app-wide Feedback button (#997), types free
text, optionally tags it, and it lands here for ops to read in the admin portal.

**Renumbered `0079` → `0080` mid-review**, after `#992` took `0079` while this branch was in flight — the third time the OIE block has been overtaken, and the second collision this file has recorded in one day. REGENERATED, NOT RENAMED (the `0071` rule): the snapshot was deleted and `db:generate` re-run against a tree that already contained `0079_journey_read_indexes`, so `0080_snapshot.json.prevId == 0079_snapshot.json.id` and a second `db:generate` emits nothing. The pre-renumber file was never applied to any database, so nothing needed its `when` pinned. **OIE moves to `0081`.** *(Superseded twice. 2026-08-19: `0081` went to `worker_feedback.screen_context`, the #997 follow-up. 2026-08-20: `0082` went to the R39 lock, itself renumbered out of `0081` after `#1036` took that slot AND applied it to production mid-flight. **OIE's block is `0083`+ — and the reserved-block table above is the authority, not this line.** Left here rather than rewritten, because this paragraph is the record of what was decided at the time; a stale forward-pointer in a slot register is exactly what the fourth collision was made of.)*

**APPLY BEFORE DEPLOY**, and unlike `0077` there is no savepoint softening it.
`FeedbackRepository.insert` names `worker_feedback` unconditionally on the request path of
`POST /workers/me/feedback`, and that INSERT shares a transaction with its `feedback.submitted`
event — deliberately, so a feedback row without an audit record cannot exist. Against a database
without this file, every submission is a 500 **and the worker's typed message is gone with the
response**; `GET /admin/feedback` 500s on its first page load. Both failures are loud, which is the
one respect in which this is easier than `0078`.

Because it is apply-before-deploy, it is registered in `packages/db/src/schema-contract.ts` as
`0080-worker-feedback-table`. That makes the readiness question answerable rather than reportable —
the `0078` lesson:

```bash
pnpm --filter @badabhai/db db:audit:schema-contract   # read-only; exits 1 if the DB is behind
```

**No backfill, and none is possible.** There is no prior source of worker feedback; this table
starts the record.

**Time the DDL under a `lock_timeout`.** The single `ADD CONSTRAINT ... FOREIGN KEY` takes
`SHARE ROW EXCLUSIVE` on `workers`, which conflicts with the `ROW EXCLUSIVE` every ordinary write
holds. Validation is instant — the table is empty — but the request queues behind any in-flight
transaction on `workers`, and every writer arriving after it queues behind the request. Same
guidance as `0073` and `0077`: `SET lock_timeout = '3s';` and retry on `55P03`.

**The RLS tail is hand-appended and matters more here than on any table before it.** drizzle-kit
models `ENABLE` and neither `FORCE` nor the four `REVOKE`s; without `FORCE` the table owner — the
only connection the backend uses — walks straight through every policy. `message` is the **one
column on this spine deliberately allowed to contain a worker's own PII** (their name, their phone
number, their employer, because the product invites them to say anything), so a permissive default
here exposes free-text personal data across the whole worker base to every PostgREST role. A
`db:generate` re-run drops those five statements silently; `packages/db/src/worker-feedback-schema.test.ts`
is what catches it.

**Privacy, stated once so it is not re-litigated later.** The words live in this table and nowhere
else. `feedback.submitted` carries `message_length`, never the text — the same ruling
`job.search_performed` made about the search term — and `FeedbackService` logs an id prefix, a
category and a length. Erasure needs no code: `WorkersRepository.hardDelete` enumerates no table
names, so the `ON DELETE cascade` from `workers` **is** the DPDP/DSAR coverage.

**Rollback is one statement, and it is lossy in a way the others were not.**

```sql
DROP TABLE IF EXISTS "worker_feedback";
```

No other table has an FK to it, no view or function selects from it, and its own FK and three
indexes go with it. But it is **not** safe with the app live — there is no savepoint, so both
endpoints 500 immediately; revert the app first. And unlike `0077`, nothing reconstructs the data:
the rows *are* the record and the event spine holds only lengths by design. Export before dropping
if the table is not empty. `worker_feedback` is also listed in `LOCKED_TABLES` in
`tests/e2e/rls-spine.e2e.test.ts`, which asserts RLS + FORCE + no-grants per **name** — remove that
entry in the same change that drops the table.

**Event contract:** adds `feedback.submitted` (v1) and a new `"feedback"` event domain. Nothing
existing changes.

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
