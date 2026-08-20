# D2 — seed + embed, then promote: the runbook

> **Owner ruling 2026-08-20: D2**, re-read as *seed + embed, **then** promote*.
> ([`phase-9-decision-record.md`](./phase-9-decision-record.md) §3.)
>
> **NOTHING HERE HAS BEEN RUN.** This page exists so that when it is run, it is run once, in
> order, with a recorded before/after — not assembled from memory at the console.
>
> **Revised 2026-08-20 after every step was dry-run against production.** Two things changed and
> both matter: the authorisation blocker is cleared, and **the step order was wrong** — see
> Step 0, which is mandatory and was previously written as optional.

---

## Why the order is the decision

D1 ("seed now") and D3 ("seed with S3-D") were rejected for the same reason: **seeding is the
step that turns Path A on in fact, whatever the flags say.** `DOMAIN_MATCH_ENABLED` gates the
ANN fallback; it does not gate the *presence of edges*. There is no flag that un-seeds a table.

D2 puts the irreversible step next to the authorisation that justifies it, and — the correction
that matters — puts **embedding before promotion**:

```
0  seed   the WEDGE corpus      16 skills + 41 aliases   <- MANDATORY, and it must be first
1  seed   the GROWTH corpus     98 skills + 197 aliases + 236 edges
2  embed  every alias with no vector
3  promote                      provisional -> active
4  re-measure                   shadow, parity, coverage
                                ...only THEN consider S3-D
```

**Promotion on its own buys nothing.** A skill needs two things to be retrievable: a retrievable
status *and* an alias with a vector. Promotion moves only the first. Production holds **0
provisional skills today** — there is currently nothing to promote at all — and the provisional
rows arrive in steps 0 and 1 with `embedding = NULL`. Running step 3 before step 2 is the
sequence that looks like progress and produces none.

---

## The measured before-state, 2026-08-20

Read-only, against production. Everything below is a count from the live database, not a figure
derived from the corpus files — a distinction this phase has confused before.

| | |
|---|---|
| `skill` | **51** — all `active`; **0 provisional**, 0 deprecated |
| `skill_alias` | **98**, of which **22 carry no vector** |
| alias embedding models | `gemini-embedding-001` × 76, none × 22 |
| `job_domain_skill` | **0 edges**, 0 domains |
| provisional skills with an embedded alias | **0** |

**The 22 unembedded aliases are a pre-existing gap, not something D2 creates.** They are already
on production, on skills that are already `active`, and step 2 picks them up along with
everything it seeds.

---

## Before you start

### The authorisation guard — cleared, and the earlier note here was wrong

This page previously said the D2 path would run against production *"with no authorisation signal
at all"*. **That was incorrect and is corrected here.** `NODE_ENV` is unset in the shell but set
to `production` by the repo-root environment file, which every one of these runners loads through
dotenv before its own guard — so the old guard **did** fire, and what it produced was the
opposite failure: it refused every run, dry runs included.

The real problem was where the protection lived. One line of a **gitignored** file stood between
these runners and production, the obvious cure for the over-refusal removed it, and a fresh clone
or CI had no protection at all. `match-v1-cli` was worse: its `MATCH_V1_PROD_CONFIRM` token
authorised `--apply` **against any database**, because it said nothing about the target.

**All four runners on this path now gate on `opsGuard`**, which classifies the connection string.
Every step below therefore takes two independent signals for its write, and every step can be
dry-run without ceremony. Verified: all four refuse a production write before opening a
connection, naming exactly what is missing.

### Preconditions to verify, and record

Run all six and keep the output. Each is read-only.

| # | command | expected |
|---|---|---|
| P1 | `pnpm --filter @badabhai/db db:audit:schema-contract` | **READY** |
| P2 | `pnpm --filter @badabhai/db db:audit:rls` | all tables locked, **0 deviating** |
| P3 | `npx tsx packages/db/adopt-migrations.ts --doctor` | journal fully recorded, **0 orphans** |
| P4 | `pnpm --filter @badabhai/db db:verify:path-b-parity` | **PASS** against the committed pre-S3 baseline — this is the digest step 4 compares against |
| P5 | `pnpm --filter @badabhai/db db:report:taxonomy` | the corpus quality verdict, before anything is written from it |
| P6 | `pnpm --filter @badabhai/db db:seed:skills -- --plan --preserve-existing-status` | `new skills = 16`, `changed skills = 0`, `held statuses = 4` |

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

## ⛔ Step 0 — seed the WEDGE corpus. Mandatory, and it goes first

The previous version of this page had this as an aside: *"If the wedge corpus also needs seeding
(it should not; production holds all 51)."* **That is wrong, and the dry run says so:**

```
pnpm --filter @badabhai/db db:seed:domain-skills
...
[seed:domain-skills] failed: 4 SHIPPED skill(s) this corpus references are not in `skill`.
  Run 'pnpm db:seed:skills' first.
  missing: skill_drainage_systems, skill_drawing_reading, skill_pipe_fitting, skill_water_supply
```

**Step 1 cannot run until step 0 has.** Production holds 51 skills and the wedge corpus holds 49,
and they are not the same 49 — they overlap in 33:

| | |
|---|---|
| in the corpus, **not** live | **16** (15 provisional + `skill_drawing_reading`, active) |
| live, **not** in the corpus | **18** — every one an `mskill_*` occupation row, all `active`, from `seed-match-vocabulary`. Step 0 does not touch them |
| status disagreements | **4** — `skill_boring`, `skill_cad_interpretation`, `skill_dimensional_inspection`, `skill_gdt_reading`: corpus says `deprecated`, production says `active` |

### Preview it. This step can be looked at now, and could not be before

```
pnpm --filter @badabhai/db db:seed:skills -- --plan --preserve-existing-status
```

```
[seed:skills] PLAN — nothing was written.
  new skills            = 16
  changed skills        = 0
  held statuses         = 4
  new aliases           = 41  (embedding NULL — run db:embed:skills after)
  aliases already there = 97  (DO NOTHING; existing vectors untouched)
  crosswalk pointers    = 0
```

### `--preserve-existing-status` is mandatory, and the plan proves why

Run the same preview **without** it and the numbers change in exactly the dangerous direction:

| | with the flag | without it |
|---|---|---|
| changed skills | 0 | **4** — each `status (active -> deprecated)` |
| held statuses | 4 | 0 |
| crosswalk pointers | 0 | **4** — a `replaced_by` written alongside each deprecation |

Those four are live, `active`, and referenced by the growth corpus's advisory output. Deprecating
them is an S3-D decision that has not been taken.

### Then apply

```
OPS_ALLOW_PRODUCTION=seed:skills \
  pnpm --filter @badabhai/db db:seed:skills -- \
    --preserve-existing-status --i-am-authorised-to-write-to-production
```

**Record after this step:** re-run the plan. It must report `new skills = 0`, which is the
idempotency check *and* the confirmation that the 16 landed.

---

## Step 1 — seed the GROWTH corpus

**Step 0 must have run.** This step refuses otherwise, by name.

```
pnpm --filter @badabhai/db db:seed:domain-skills                       # DRY RUN, the default

OPS_ALLOW_PRODUCTION=seed:domain-skills \
  pnpm --filter @badabhai/db db:seed:domain-skills -- \
    --apply --i-am-authorised-to-write-to-production
```

**What it writes**, from the dry run against production on 2026-08-20:

```
  domains                = 28
  skills                 = 98
  aliases                = 197
  edges                  = 236   (145 required, 91 preferred; 236 llm_bootstrap)
  skills_reusing_shipped = 0
```

Production currently holds **0** edges, so this is the step that gives Path A anything to
retrieve at all.

**The dry run also emits three ADVISORY lines** — `CONVERGENCE_ABSENT
quality_inspection/Dimensional inspection`, and `EDGE_SKILL_UNRESOLVED` for `skill_boring` and
`skill_dimensional_inspection`. They are never enforced, and note what the second two are: two of
the four skills Step 0 **held** at `active` against a corpus that wants them `deprecated`. The
same disagreement, surfacing twice. Worth reading before the apply, not worth blocking on.

**Two trade groups have no shipped coverage to reuse** (`construction`, `warehouse_logistics`)
and two are thin (`electrical`, `hvac` — both 1 of 2). Recorded because it predicts where Path A
will retrieve worst after this lands.

**Two gates run before a connection is opened** — structural (`validateTaxonomyCorpus`) and
semantic (`taxonomyQualityVerdict`). A corpus can pass the first and fail the second; both must
pass.

**Idempotent**, and specifically embedding-safe: every write is `ON CONFLICT ... DO UPDATE` with
a `WHERE` that fires only on a real difference, so a second run reports zero changes rather than
rewriting `updated_at` across the corpus — and never clobbers a vector step 2 wrote.

**Record after this step:** row counts for `skill`, `skill_alias`, `job_domain_skill`, and
`db:verify:path-b-parity` (still PASS — seeding adds `job_domain_skill` edges, which Path B does
not read).

---

## Step 2 — embed

```
pnpm --filter @badabhai/db db:embed:skills -- --plan

OPS_ALLOW_PRODUCTION=embed:skills \
  pnpm --filter @badabhai/db db:embed:skills -- \
    --apply --i-am-authorised-to-write-to-production
```

**This one spends money and calls a provider.** It is the step that actually moves coverage: an
alias with no vector is not a candidate no matter what its skill's status says.

**The plan is the count to trust, and it is now runnable at any point.** Measured 2026-08-20,
*before* steps 0 and 1: `aliases needing embedding = 22, distinct skills covered = 16`. After
step 0 (+41) and step 1 (+197) the plan should report roughly **260**. Re-run the plan
immediately before the apply and use that number — do not carry a figure forward from this page.

⚠ **`--reset-embeddings` is a global recovery, not part of this sequence.** It NULLs every vector
in the table. It cannot be combined with `--batch`, and `--plan` describes it without doing it.

**Check the model.** Every alias on a skill must carry the SAME embedding model, or
`FULLY_EMBEDDED` refuses that skill at step 3 — a partially embedded active skill is findable
only through whichever aliases happen to have vectors, which is the worst of both worlds.

**Record after this step:** `pnpm --filter @badabhai/db db:audit:embeddings` — the per-model
provenance, so a later run can tell what was embedded when and by what.

---

## Step 3 — promote

```
pnpm --filter @badabhai/db db:promote:skills -- --batch <dir>          # PLAN. Default.

OPS_ALLOW_PRODUCTION=promote:skills \
  pnpm --filter @badabhai/db db:promote:skills -- \
    --batch <dir> --apply --i-am-authorised-to-write-to-production
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
| 0 seed (wedge) | **NO** | 16 skill rows and 41 aliases. Deletable by hand; nothing un-seeds them |
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
| 2026-08-20 | **Every step dry-run against production; still not run.** Four corrections. (1) **Step 0 added** — `db:seed:skills` is MANDATORY and FIRST, not the optional aside this page called it: `seed:domain-skills` refuses by name until four shipped skills exist, and 16 of the corpus's 49 are missing from production. (2) The authorisation note was **wrong** — the old `NODE_ENV` guard did fire, from the repo-root environment file, and refused everything including dry runs; the real defect was that the protection lived in a gitignored line. All four runners now gate on `opsGuard`. (3) Before-state **measured**: 51 skills all active, **0 provisional**, 98 aliases of which 22 unembedded, 0 edges — so "1 of 111 provisional has an embedded alias" was a corpus projection, and the live answer is that there is nothing to promote yet at all. (4) `db:seed:skills --plan` added, because the mandatory first step was the only one of the five that could not be previewed. |
