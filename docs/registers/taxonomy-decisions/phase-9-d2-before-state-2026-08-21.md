# D2 — the complete before-state, captured 2026-08-21

> **Read-only throughout. NOTHING WAS WRITTEN. D2 has not been executed.**
>
> Owner instruction: *"Then run D2 Step 0 only as a dry-run/plan: verify the expected 4
> active→deprecated changes and 4 crosswalk changes; verify `--preserve-existing-status`
> behaviour; capture the complete before-state. Do not perform the actual seed/embed/promote
> writes yet."*
>
> Every command below was run against production from `origin/main` at `39d94f61`, i.e. **after**
> #1157 merged, so the plans exercise the `opsGuard` path that will carry the eventual writes.
> This page exists so that when D2 runs, "what did it change" is answerable by subtraction rather
> than by memory.

---

## Step 0's plan, both directions — the verification asked for

### With `--preserve-existing-status` — the way it must be run

```
pnpm --filter @badabhai/db db:seed:skills -- --plan --preserve-existing-status
```

```
[seed:skills] TARGET IS SUPABASE (remote) and NODE_ENV=production — read-only; nothing will be written.
[seed:skills] PLAN — nothing was written.

  new skills            = 16
  changed skills        =  0
  held statuses         =  4
  new aliases           = 41  (embedding NULL — run db:embed:skills after)
  aliases already there = 97  (DO NOTHING; existing vectors untouched)
  crosswalk pointers    =  0
```

### Without it — the hazard, measured rather than warned about

```
  new skills            = 16
  changed skills        =  4     <- every one a status flip
  held statuses         =  0     (--preserve-existing-status NOT set)
  crosswalk pointers    =  4     <- a replaced_by written beside each deprecation

  CHANGED — existing rows the corpus would overwrite:
    ~ skill_boring                 status (active -> deprecated)
    ~ skill_cad_interpretation     status (active -> deprecated)
    ~ skill_dimensional_inspection status (active -> deprecated)
    ~ skill_gdt_reading            status (active -> deprecated)

  WARNING: a status change is planned and --preserve-existing-status is NOT set.
```

**Both expectations confirmed: 4 active→deprecated and 4 crosswalk changes, exactly and only
without the flag.** With it, the same four appear as HELD and the crosswalk count drops to zero —
which is the behaviour that keeps the run from aborting, because a held row keeps `active` and
the table's CHECK is `replaced_by IS NULL OR status = 'deprecated'`.

⚠ **Two of the four also appear in the growth corpus's own advisory output** as
`EDGE_SKILL_UNRESOLVED skill_boring` and `EDGE_SKILL_UNRESOLVED skill_dimensional_inspection`.
That is the same disagreement surfacing from the other side, not a second problem. It is never
enforced, and deprecating these four is an S3-D decision that has not been taken.

### The 16 skills Step 0 would create

`skill_3d_modeling`, `skill_cabinet_making`, `skill_cad_2d_drafting`, `skill_carpenter_occupation`,
`skill_designer_occupation`, `skill_drainage_systems`, `skill_drawing_reading`,
`skill_furniture_finishing`, `skill_interior_designer_occupation`, `skill_material_selection`,
`skill_pipe_fitting`, `skill_plumber_occupation`, `skill_rendering_visualization`,
`skill_space_planning`, `skill_water_supply`, `skill_woodworking`.

Fifteen are `provisional` in the corpus; `skill_drawing_reading` is `active`. Four of them —
`skill_drainage_systems`, `skill_drawing_reading`, `skill_pipe_fitting`, `skill_water_supply` —
are the ones **Step 1 refuses by name** until they exist. That refusal is why Step 0 is mandatory
and first.

---

## The database, before anything runs

| | measured |
|---|---|
| `skill` | **51** — `active` 51, **`provisional` 0**, `deprecated` 0 |
| `skill_alias` | **98**, of which **22 have no vector** |
| alias embedding models | `gemini-embedding-001` × 76 · none × 22 |
| `job_domain_skill` | **0 edges**, 0 domains |
| `job_domain` | 4071 |
| provisional skills with an embedded alias | **0** |

**⚠ The correction this page exists to record.** Production has **0 provisional skills**. The
figure previously carried in the runbook — *"1 of 111 provisional skills has an embedded alias"* —
was derived from the corpus files, not from the database, and **must not be used to justify a
production promotion**. There is nothing to promote today. The provisional rows arrive in Step 0
(15) and Step 1 (98), each with `embedding = NULL`, which is why promotion is sequenced last.

### Wedge corpus vs production — they are not the same 49

| | |
|---|---|
| corpus skills | 49 |
| live skills | 51 |
| in the corpus, **not** live | **16** (listed above) |
| live, **not** in the corpus | **18** — every one an `mskill_*` occupation row, `active`, from `seed-match-vocabulary`. Step 0 does not touch them |
| status disagreements | **4** (listed above) |

---

## Preconditions P1–P6, all green

| # | command | result |
|---|---|---|
| P1 | `db:audit:schema-contract` | **READY** — including 0084's four RLS entries |
| P2 | `db:audit:rls` | 78 public tables, **78 fully locked, 0 deviating** |
| P3 | `adopt-migrations.ts --doctor` | **85/85 recorded, 0 orphans**; `db:migrate` will attempt no DDL |
| P4 | `db:verify:path-b-parity` | **PASS** — overall digest `d7f6cd4ec713ae52…` |
| P5 | `db:report:taxonomy` | **quality gate PASS**, 0 structural problems |
| P6 | `db:seed:skills --plan --preserve-existing-status` | `new=16, changed=0, held=4, crosswalk=0` |

### P4 in full — the digest the after-run must reproduce

```
  overall digest         = d7f6cd4ec713ae52…
  cnc-machining          candidates= 22  skills= 10   d85ddf77b8ae…
  cnc-programming        candidates= 11  skills=  4   b98478d463fd…
  fabrication            candidates=  6  skills=  3   4cf84c59d825…
  fitting-assembly       candidates=  5  skills=  3   8d7683c180b7…
  general-machining      candidates=  2  skills=  1   8eaa1219e414…
  grinding               candidates=  3  skills=  1   a7a96037fa1e…
  maintenance            candidates=  4  skills=  2   d2ea7c3edc6b…
  metrology-quality      candidates= 11  skills=  4   4633f4259037…
  vmc-machining          candidates=  3  skills=  1   fadd9d6add80…
  welding                candidates=  9  skills=  4   4f62901208a0…
```

**This is the safety property.** Path B is what serves today; D2 must not move it. Seeding adds
`job_domain_skill` edges, which Path B does not read, so the digest should be byte-identical
afterwards. If it is not, stop — that is a regression in the live path, not a Path-A improvement.

### P5 in full

```
  structural problems  = 0
  quality gate: PASS
    CORRECT_REUSE = 30   CORRECT_NEW = 98
    FALSE_REUSE   = 0    MISSED_REUSE = 0   POTENTIAL_AMBIGUITY = 0
    CONVERGED = 9   FRAGMENTED = 0   ABSENT = 1   NEEDS_REVIEW = 0
```

**Two trade groups have no shipped coverage to reuse** (`construction`, `warehouse_logistics`)
and two are thin (`electrical` 1/2, `hvac` 1/2). Recorded because it predicts where Path A will
retrieve worst once edges exist.

---

## What each later step would do, from its own plan

| step | command | measured plan |
|---|---|---|
| 0 | `db:seed:skills --plan --preserve-existing-status` | 16 skills, 41 aliases, 4 held, 0 crosswalk |
| 1 | `db:seed:domain-skills` (dry run is the default) | 28 domains, 98 skills, 197 aliases, **236 edges** (145 required / 91 preferred) |
| 2 | `db:embed:skills --plan` | **22 aliases** needing a vector today, over 16 skills; 1 batch, 1 provider request. After Steps 0+1 this becomes ~260 — **re-run the plan immediately before the apply and use that number** |
| 3 | `db:promote:skills --batch <dir>` | not runnable yet — there are 0 provisional skills to promote |

Step 2's plan is the only one that will move substantially between now and the run, which is why
the runbook says not to carry a figure forward from a page.

---

## What has NOT happened

- **No seed, no embed, no promotion.** Every command above is read-only, and the two that can
  write refused nothing because they were never asked to.
- **No flag touched.** `SKILL_CANONICALIZE_ENABLED`, `MATCH_V1_ENABLED`, `DOMAIN_MATCH_ENABLED`
  are as they were.
- **S3-D not activated. O1 not activated.**
- **No trainer phrase authored.** The six slots are still empty and a test asserts it.

## Change log

| date | what |
|---|---|
| 2026-08-21 | Before-state captured from `origin/main@39d94f61`, after #1157 merged, so the plans exercise the `opsGuard` path the writes will take. Step 0's plan verified in **both** directions: 4 active→deprecated and 4 crosswalk changes appear only without `--preserve-existing-status`. Records the correction that production holds **0 provisional skills**, so the corpus-derived "111 provisional" figure must not justify a promotion. |
