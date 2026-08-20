# D2 — seed + embed, then promote: the runbook

> **Owner ruling 2026-08-20: D2**, re-read as *seed + embed, **then** promote*.
> ([`phase-9-decision-record.md`](./phase-9-decision-record.md) §3.)
>
> **NOTHING HERE HAS BEEN RUN.** This page exists so that when it is run, it is run once, in
> order, with a recorded before/after — not assembled from memory at the console.
>
> Every step is a production write. Read *Before you start* first; one of its items is a
> blocker, not a checklist tick.

---

## Why the order is the decision

D1 ("seed now") and D3 ("seed with S3-D") were rejected for the same reason: **seeding is the
step that turns Path A on in fact, whatever the flags say.** `DOMAIN_MATCH_ENABLED` gates the
ANN fallback; it does not gate the *presence of edges*. There is no flag that un-seeds a table.

D2 puts the irreversible step next to the authorisation that justifies it, and — the correction
that matters — puts **embedding before promotion**:

```
1  seed   skill + skill_alias + job_domain_skill   (236 edges, 98 skills)
2  embed  the 225 aliases that have no vector
3  promote                                          provisional -> active
4  re-measure                                       shadow, parity, coverage
                                                    ...only THEN consider S3-D
```

**Promotion on its own buys one rankable skill.** A skill needs two things to be retrievable: a
retrievable status *and* an alias with a vector. Promotion moves only the first, and exactly
**1 of 111** provisional skills currently has an embedded alias. Running step 3 before step 2 is
the sequence that looks like progress and produces none.

---

## Before you start

### ⛔ The authorisation guard on this path is the one the codebase calls backwards

Steps 1–3 run through `seed-skills.ts`, `match-v1-cli.ts` (which `seed:domain-skills` uses),
`embed-skill-aliases.ts` and `promote-skills.ts`. **All four still guard on
`process.env.NODE_ENV === "production"`**, not on the target.

`ops-guard.ts` exists precisely because that guard protects the wrong thing — its own docstring
names both failure modes — and four runners have already moved to it (`retag-skills`,
`s3d-rollback`, `verify-rls-lock`, `verify-unresolved-write`). The D2 path has not.

The consequence is specific and it applies to this machine:

> This repository's local `.env` points at **production**. `NODE_ENV` is not normally set to
> `production` on a developer shell. So every step below would run against production **with no
> authorisation signal at all** — the "FALSE PERMIT" `ops-guard.ts` describes — while a shell
> that *had* correctly set `NODE_ENV` would be refused even for a read-only dry run.

**Recommended: migrate those four runners to `opsGuard` before running D2**, so the largest
irreversible write in the phase requires the two independent signals every other gated action
does (`--i-am-authorised-to-write-to-production` plus `OPS_ALLOW_PRODUCTION=<script>`). Raised
separately; it is not part of the decision, but it is a precondition worth insisting on.

### Preconditions to verify, and record

Run all five and keep the output. Each is read-only.

| # | command | expected |
|---|---|---|
| P1 | `pnpm --filter @badabhai/db db:audit:schema-contract` | **READY** |
| P2 | `pnpm --filter @badabhai/db db:audit:rls` | all tables locked, **0 deviating** |
| P3 | `npx tsx packages/db/adopt-migrations.ts --doctor` | journal fully recorded, **0 orphans** |
| P4 | `pnpm --filter @badabhai/db db:verify:path-b-parity` | **PASS** against the committed pre-S3 baseline — this is the digest step 4 compares against |
| P5 | `pnpm --filter @badabhai/db db:report:taxonomy` | the corpus quality verdict, before anything is written from it |

**P4 is the one to keep the raw output of.** Path-B parity is the safety property this whole
sequence must not disturb, and "it still passes afterwards" is only meaningful next to the
before.

### What must NOT change

- **No taxonomy flag is touched.** `SKILL_CANONICALIZE_ENABLED`, `MATCH_V1_ENABLED` and
  `DOMAIN_MATCH_ENABLED` are exactly as they were, before and after.
- **S3-D is not activated.** This sequence produces the coverage number that the S3-D question
  is asked *with*; it does not answer it.
- **Path-B parity must still PASS at step 4.** If it does not, stop — Path B moved, and that is a
  regression in the path serving today, not a Path-A improvement.

---

## Step 1 — seed

```
pnpm --filter @badabhai/db db:seed:domain-skills            # DRY RUN, the default
pnpm --filter @badabhai/db db:seed:domain-skills --apply
```

**What it writes.** `skill` (98 new rows), `skill_alias` (226 rows, `embedding = NULL`), and
`job_domain_skill` (236 edges over 28 domains). Production currently holds **0** edges, so this
is the step that gives Path A anything to retrieve at all.

**Two gates run before a connection is opened** — structural (`validateTaxonomyCorpus`) and
semantic (`taxonomyQualityVerdict`). A corpus can pass the first and fail the second; both must
pass.

**Idempotent**, and specifically embedding-safe: every write is `ON CONFLICT ... DO UPDATE` with
a `WHERE` that fires only on a real difference, so a second run reports zero changes rather than
rewriting `updated_at` across the corpus — and never clobbers a vector step 2 wrote.

**If the wedge corpus also needs seeding** (it should not; production holds all 51):

```
pnpm --filter @badabhai/db db:seed:skills --preserve-existing-status
```

`--preserve-existing-status` is not optional here. Without it the seeder applies the corpus's
`status` to rows that already exist, and four corpus rows are `deprecated`/`provisional` where
production has them `active` — it would flip all four in the same run.

**Record after this step:** row counts for `skill`, `skill_alias`, `job_domain_skill`, and
`db:verify:path-b-parity` (still PASS — seeding adds `job_domain_skill` edges, which Path B does
not read).

---

## Step 2 — embed

```
pnpm --filter @badabhai/db db:embed:skills                  # plan
pnpm --filter @badabhai/db db:embed:skills --apply
```

**This one spends money and calls a provider.** It is the step that actually moves coverage:
**225 of the 226** newly seeded aliases have no vector, and an alias with no vector is not a
candidate no matter what its skill's status says.

**Check the model.** Every alias on a skill must carry the SAME embedding model, or
`FULLY_EMBEDDED` refuses that skill at step 3 — a partially embedded active skill is findable
only through whichever aliases happen to have vectors, which is the worst of both worlds.

**Record after this step:** `pnpm --filter @badabhai/db db:audit:embeddings` — the per-model
provenance, so a later run can tell what was embedded when and by what.

---

## Step 3 — promote

```
pnpm --filter @badabhai/db db:promote:skills --batch <dir>            # PLAN. Default.
pnpm --filter @badabhai/db db:promote:skills --batch <dir> --apply
```

**Fail-closed and all-or-nothing:** `--apply` promotes NOTHING unless every selected skill
passes every non-waived criterion. There are seven, and the report names the binding one per
candidate.

**Expect `EVAL_COVERED` to block six skills.** That is E1 working as ruled, not a defect — the
six are covered in the fixture only by a mechanical `corpus_alias:*` case. They need one reviewed
trainer phrase each; the pack is
`packages/db/data/taxonomy/eval/review-pack/e1-eval-coverage-trainer-pack.md`. Either land those
six cases first, or promote without them and come back — do **not** reach for
`--waive EVAL_COVERED` to make a number look complete.

**The report IS the audit record.** It lands in `docs/registers/skill-promotions/` and is
git-tracked; commit it with the run. A `packages/db` runner has no event pipeline, so there is
no spine event to emit and the file is the whole trail.

**Reverting:** `db:promote:skills --revert <report.json>` puts them back. That reverses the
STATUS only — it does not un-seed step 1 or un-spend step 2.

---

## Step 4 — re-measure, and stop

```
pnpm --filter @badabhai/db db:verify:path-b-parity     # must still PASS
pnpm --filter @badabhai/db db:report:s3d-shadow        # the coverage/disagreement numbers
pnpm --filter @badabhai/db db:audit:embeddings
pnpm --filter @badabhai/db db:audit:rls
pnpm --filter @badabhai/db db:audit:schema-contract
```

**The shadow is offline and reads the CORPUS FILES, not the database.** Before this sequence its
figures described a corpus production did not have; after it, the two finally agree, and *that*
is the first time a shadow number can be quoted as a production one. Say so explicitly in
whatever is written up — the previous confusion between the two is on the record.

**What the numbers are for.** They are the input to the S3-D question, not an answer to it. The
last measured state was: 123 cases, Path A empty on 65, agreement 15.52%, and `--if-promoted`
identical to six decimal places because promotion alone adds one candidate. If step 2 did its
job, these should move for the first time.

---

## Rollback, honestly

| step | reversible? | how |
|---|---|---|
| 1 seed | **NO** | no flag un-seeds a table. `job_domain_skill` rows can be deleted by hand, but Path A behaviour created here is created |
| 2 embed | no, and the spend is spent | vectors can be nulled; the provider calls cannot be un-made |
| 3 promote | **yes** | `db:promote:skills --revert <report.json>` |
| 4 measure | read-only | — |

This asymmetry is the whole reason the order is what it is: the reversible step is last, and the
irreversible ones happen under one authorisation with a recorded before/after.

---

## Change log

| date | what |
|---|---|
| 2026-08-20 | Written. Not run. |
