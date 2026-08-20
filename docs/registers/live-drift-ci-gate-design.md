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

## The four questions, answered — 2026-08-21

The owner's instruction was: *"First address the four design questions in the proposal and prove
the gate against fresh DB + production-like DB states. Then open a follow-up PR for review."*
Two of the four turn out to be answerable from evidence rather than from preference, and one of
them assumed a conflict that does not exist.

### Q3 — does CI's database really classify as `LOCAL DOCKER`? **YES. Executed.**

This was flagged as *"the one assumption that has not been executed"*, and it did not need a CI
run: the URL is a literal in the workflow.

```
.github/workflows/ci.yml:1016
  DATABASE_URL: postgresql://postgres:postgres@localhost:5432/badabhai_test
```

`hostClass` matches `localhost` and returns `LOCAL DOCKER`, which `isCiSafeTarget` accepts.

**A test now reads that literal out of `ci.yml` and asserts it**, rather than restating it — a
copy would keep agreeing with itself after somebody changed the workflow. The same test drives
the other direction: a Supabase URL in the same position is refused, so the guard is what stops
a mis-pointed job rather than the absence of one.

### Q4 — do undeclared routines couple this gate to #1110? **NO. The conflict does not exist.**

The worry was that *"#1110's eventual resolution has to include declaring whatever stays"*. It
does not, because **this gate only ever sees a fresh database**, and #1110's routines are absent
there by definition — they are undeclared, so no migration creates them.

Every outcome of #1110 leaves the fresh-database view unchanged:

| #1110 decides | fresh CI database | gate |
|---|---|---|
| drop them | still none | green |
| declare them in a migration | the migration creates them **and** declares them | green — the two move together by construction |
| leave them undeclared | still none | green, and the gate never sees the production-only state |

Two tests pin this, including the declare-them case. One caveat found while writing them, and
worth stating because it is the only real work the declare path would create: an **event
trigger** has no `CREATE FUNCTION` for `declaredRoutines` to match, so `ensure_rls` would still
report as undeclared even after being declared. That is a parser gap in `declaredRoutines`, not a
reason to keep the rule out — and it is cheap to fix when and if #1110 goes that way.

### Q1 — blocking, or non-blocking for a period? **Non-blocking for a COUNT of runs, not a week.**

*"A week of non-blocking runs"* measures the calendar, not the gate. A quiet week proves nothing
and a busy one over-proves it. **Land it with `continue-on-error: true` and flip it to blocking
in a second, one-line PR once it has been observed green on at least 10 real CI runs**, at least
one of which included a migration.

The flip must be a PR rather than a date, so that the evidence is attached to the change that
relies on it.

What has changed since the question was asked: the read is no longer unproven either (below), so
the residual risk is narrower than it was — it is now specifically *"this combination, on a fresh
CI database"*, which only CI can answer.

### Q2 — is `e2e` the right job? **Yes, for now. Revisit only on evidence.**

`e2e` is the only job with a migrated database, and a dedicated job means a second Postgres
service to keep in sync with it. The argument against is discovery latency: a drift failure
surfaces late in a slow job.

That argument optimises the wrong case. A drift failure should be rare — it means somebody
changed the schema out of band — and paying a permanent second-service cost to find a rare
failure three minutes sooner is a bad trade. **Keep it in `e2e`, placed before the suites so
drift is reported as drift rather than as a confusing test failure.** If drift failures turn out
to be frequent enough that the latency is felt, that frequency is itself the finding, and the
job can be split then.

---

## Proving the gate against both states

The proposal's stated gap was precise: *"the SQL that turns a real database into a catalog is
only exercised by running it."* Everything proved so far ran off `expectedFreshCatalog()` and
mutations of it — which exercises the **verdict** and never the **read**.

`--catalog-out` was meant to close that on the first container run. It could not: it sits
**after** the target guard, so it can only run somewhere the gate already accepts, which is
nowhere yet. A chicken-and-egg the design did not notice.

### `--capture-only=<path>` — recording is not judging

Capture is read-only and says nothing about whether a schema is correct, so the guard's argument
— *"this question is only meaningful about a database built solely from these migrations"* —
does not apply to it. **Judgement stays guarded; recording does not.** It renders no verdict,
exits 0, and says so.

**The read is now executed, against production, read-only:**

```
db:audit:live-drift:ci --capture-only=<path>
  target      SUPABASE (remote)
  tables      78
  columns     835
  routines    2 trigger(s), 3 function(s), 7 event trigger(s)
  CAPTURE ONLY — no verdict was reached.
```

Those counts **corroborate independently**: 78 tables is what `db:audit:rls` locks, and
2 triggers / 3 functions / 7 event triggers is exactly what `db:audit:undeclared-routines`
reports through completely different SQL. Two unrelated queries agreeing is the strongest
evidence available short of a container.

### The production-like judgement

Feeding that captured catalog back through `--from-json` exercises the gate against a
production-like state without ever pointing it at production:

```
db:audit:live-drift:ci --from-json=<the captured catalog>     ->  exit 1

  5 problem(s):
    UNDECLARED tables (1)         _delete_forensics
    UNDECLARED columns (8)        audit_logs.actor_member_id, audit_logs.actor_user_id,
                                  audit_logs.payer_id, job_postings.posted_by_member_id,
                                  jobs.posted_by_member_id, payers.metadata,
                                  payers.payer_type, payers.verification_status
    UNDECLARED triggers (2)       _t_log_del_worker_profiles, _t_log_del_workers
    UNDECLARED functions (3)      _log_delete, is_active_payer_member, rls_auto_enable
    UNDECLARED event triggers (7) ensure_rls + the six supabase_admin platform triggers
```

**This is the gate working, not an alarm.** Every line is a real difference between production
and this repository, and it is precisely why the gate refuses production as a *target*: a
production database legitimately carries objects the repo does not declare, and reporting them
as a verdict would make the job permanently red.

Two things worth carrying out of it:

- **The 8 undeclared COLUMNS are a class GAP-DB-21 did not cover.** That register was about four
  undeclared *tables*; these are undeclared *columns on declared tables*, on `audit_logs`,
  `job_postings`, `jobs` and `payers`. They are not new drift — `db:audit:live-drift` has been
  reporting the same shape — but they had not been enumerated in one place before, and the
  `payers` four (`metadata`, `payer_type`, `verification_status`) look like the same
  payer-onboarding lineage as the GAP-DB-21 tables.
- **The six `supabase_admin` event triggers appear here and would never appear in CI**, because a
  plain Postgres container has no Supabase platform. That asymmetry is the reason the fresh-
  database question and the production question have to be different commands.

### What is now proved, and what is still not

| | proved by |
|---|---|
| the verdict, clean | `expectedFreshCatalog()` judged CLEAN |
| the verdict, red — 7 ways | seven mutations of that catalog, each caught |
| the verdict, green again | an eighth case: declaring a routine turns it back green |
| the target guard | refuses production before any query; exit 2 |
| **the catalog READ** | **`--capture-only` against production: 78/835/2/3/7, corroborated by two other tools** |
| **a production-like judgement** | **exit 1, five categories, every one real** |
| Q3's classification | a test that reads the literal out of `ci.yml` |
| Q4's independence | two tests, including the declare-them case |
| **the combination, on a fresh CI database** | **still nothing. Only CI can answer it — which is what Q1's non-blocking period is for.** |

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
| 2026-08-21 | **All four questions answered, and the read proved.** Q3 executed — CI's `DATABASE_URL` is `localhost`, so `LOCAL DOCKER`, now pinned by a test that reads `ci.yml` rather than restating it. Q4 dissolved — the gate only sees a fresh database, so every #1110 outcome leaves it green; two tests, including the declare-them case, which surfaced one real gap (`declaredRoutines` cannot match an event trigger). Q1 — non-blocking for a COUNT of runs (>=10, one with a migration), not a week; the flip is a one-line PR so the evidence attaches to it. Q2 — keep it in `e2e`; a second Postgres service to find a rare failure three minutes sooner is a bad trade. **`--capture-only` added** because `--catalog-out` sat behind the guard and so could never run anywhere: the catalog SQL has now been executed against production read-only (78 tables / 835 columns / 2 triggers / 3 functions / 7 event triggers, corroborated by `db:audit:rls` and `db:audit:undeclared-routines`), and judging that captured catalog exits 1 with five real categories — including **8 undeclared COLUMNS**, a class GAP-DB-21 did not cover. Still unproved: the combination on a fresh CI database, which only CI can answer. |
