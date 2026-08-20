# A CI-safe drift gate — design, for review

> **This is a proposal. Nothing is wired into CI.** The owner's instruction was: *"don't wire it
> into CI yet. First design a deterministic CI-safe version that can run against a fresh/local DB
> and prove the expected state. Open a PR for review rather than forcing it into CI."*
>
> The code is `packages/db/src/live-drift-ci.ts` (`pnpm db:audit:live-drift:ci`). The YAML at the
> bottom is written out so it can be argued with; it is **not** applied.

---

## Why `--strict` was the wrong thing to wire in

`db:audit:live-drift` already has a `--strict` flag, and adding four lines to `ci.yml` would have
been the obvious move. It was declined for three reasons, and only the first is about caution.

**1. Nobody had ever observed it pass.** It had only ever run against production, where it
reports an undeclared table, six undeclared routines and a set of open questions — all real, none
a verdict. A gate whose green state is theoretical blocks every merge the first time it lands
red, and the person unblocking everyone deletes the gate. That is a worse outcome than no gate.

**2. It would fail forever against production.** `--strict` has no opinion about its target, so
the same command means *"the repo and the database agree"* in CI and *"here are eight things to
rule on"* against production. One of those is a gate; the other is a report. Sharing an exit code
between them is how a red job becomes background noise.

**3. A half-migrated database reports as drift.** `missingTables` on a database that simply has
not run `db:migrate` is a true statement and a useless diagnosis — sixty confident lines sending
the reader to hunt an out-of-band `DROP` that never happened.

---

## What the CI mode asks instead

> Against a database built **only** from this repository's migrations, is the live schema exactly
> what the Drizzle schema declares — no extra table, no missing column, no undeclared routine?

That question has one answer, always, for a given commit. The investigative tool keeps asking the
broader question against production, unchanged.

### The three things that make it deterministic

| | |
|---|---|
| **Target guard** | refuses anything that is not `LOCAL DOCKER`, **before** a query runs, with exit **2** |
| **Migration state first** | proves every journal entry is recorded in `drizzle.__drizzle_migrations` and **short-circuits** if not, so "you did not migrate" is never reported as "the schema drifted" |
| **Pure verdict** | `ciVerdict(catalog, declared, routines, journal)` — no clock, no environment, no ordering dependence. Sorting the input does not change the output, and a test says so |

### Exit codes

| code | meaning |
|---|---|
| **0** | clean |
| **1** | drift, or migrations not applied — the report names every difference |
| **2** | **refused**: the target is not one this mode can judge |

`2` is distinct from `1` deliberately. A CI step that gets `2` is **mis-configured**; reading that
as "the schema drifted" sends the reader to entirely the wrong file.

---

## How the passing state was proved without Docker

This was the blocker last time: the gate could not be verified locally, and shipping an
unverifiable gate that could block everyone's merges was worse than leaving it out.

`expectedFreshCatalog()` derives the catalog a freshly migrated database **must** have from the
Drizzle schema. That is sound rather than circular: `drizzle-kit generate` produces the migrations
*from* that schema, and the **`Migration drift (schema.ts vs committed migrations)`** CI job
already fails when the two disagree. So "the schema" and "what the migrations build" are the same
statement, checked elsewhere, by a job that has been green for months.

The tests then judge that catalog and require **CLEAN**, and mutate it one way at a time —
extra table, missing table, extra column, missing column, undeclared trigger, undeclared
function, undeclared event trigger — and require each to be caught. Both answers are observed.

**What this still does not prove, stated rather than left to be noticed:** the SQL that turns a
real database into a catalog is only exercised by running it. `--catalog-out=<path>` exists for
exactly that — the first run against a real container records a catalog, and committing it as a
fixture closes the last gap.

Three CLI paths were run by hand:

```
db:audit:live-drift:ci                            -> exit 2, refused (this .env points at production)
db:audit:live-drift:ci --from-json=<fresh>        -> exit 0, CLEAN
db:audit:live-drift:ci --from-json=<mutated>      -> exit 1, both problems named
```

---

## The proposed CI step — NOT APPLIED

It belongs in the existing **`e2e`** job, which already stands up Postgres, pre-creates the
Supabase-compatible roles and runs `pnpm --filter @badabhai/db db:migrate`. That job is the only
place in CI where a freshly migrated database exists, and adding a second one would be a second
thing to keep in sync.

```yaml
      # After "Apply migrations", before the suites.
      - name: Schema drift (live vs Drizzle, fresh database)
        run: pnpm --filter @badabhai/db db:audit:live-drift:ci
        env:
          DATABASE_URL: ${{ env.DATABASE_URL }}
```

**Placement matters.** Before the suites, so a drifted schema is reported as drift rather than as
a confusing test failure three minutes later.

### What to argue about before this lands

1. **Should it be blocking, or `continue-on-error` for a period?** The safe rollout is one green
   run in CI first — the fixture proves the logic, not the SQL. A week of non-blocking runs
   converts "should be clean" into "has been clean", and only then does it become required.
2. **Is `e2e` the right job?** It is the only one with a migrated database, but it is also one of
   the slower ones, so a drift failure is discovered late. A dedicated 40-second job would report
   sooner at the cost of a second Postgres service.
3. **Does the CI database really match `LOCAL DOCKER`?** `hostClass` classifies by hostname.
   CI's `DATABASE_URL` points at `localhost`, so it should — **and this is the one assumption
   that has not been executed.** If it classifies otherwise the step exits 2, which is the safe
   direction (mis-configured, not silently passing), but it must be checked on the first run.
4. **Undeclared routines are currently a failure.** On a fresh database there are none, so this
   is free today. It stops being free the moment someone adds a trigger — which is the point, but
   it means #1110's eventual resolution has to include *declaring* whatever stays.

---

## Relationship to the other audits

| tool | question | where it runs |
|---|---|---|
| `db:audit:schema-contract` | are the objects a NAMED migration promised present? | production |
| `db:audit:live-drift` | what does the database have that no schema file declares? | production, investigative |
| **`db:audit:live-drift:ci`** | **is a freshly migrated database EXACTLY the schema?** | **CI / local only** |
| `db:audit:undeclared-routines` | who owns the undeclared routines, and what may call them? | production, #1110 |

The first is a whitelist and can only check what someone thought to write down. The second is its
complement and is deliberately not a verdict. This one is the verdict, in the only place a verdict
is meaningful.

---

## Change log

| date | what |
|---|---|
| 2026-08-20 | Designed and implemented. Not wired into CI — the YAML above is a proposal. |
