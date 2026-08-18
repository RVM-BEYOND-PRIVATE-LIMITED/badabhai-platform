# S3 — deploy the taxonomy corpus to production: execution plan and preflight

> **Status: PREPARED, NOT EXECUTED, AND NOT YET SAFE TO AUTHORIZE AS SPECIFIED.**
> Nothing has been seeded. Production is untouched. Both flags remain `false`.
>
> Baselines measured read-only against production on **2026-08-18**.

---

## 0. The finding that must be resolved before S3 can be authorized

**S3 is not additive-only, and D0's "Path B's universe stays bit-identical" promise is false as
written.**

Deploying the corpus writes `skill.status`. Four skills that production currently serves as
`active` become `deprecated`, and `legacyAliasRows` — the path production actually runs today —
carries `AND s.status = 'active'`. So their aliases leave the live retrieval universe the moment
the seed runs.

| skill | prod today | after S3 | aliases | embedded | legacy slug |
|---|---|---|---:|---:|---|
| `skill_gdt_reading` | active | **deprecated** | 4 | 4 | `cnc-machining` |
| `skill_cad_interpretation` | active | **deprecated** | 4 | 3 | `cnc-programming` |
| `skill_dimensional_inspection` | active | **deprecated** | 3 | 3 | `metrology-quality` |
| `skill_boring` | active | **deprecated** | 1 | 1 | `cnc-machining` |

**12 of 98 production aliases (12.2%) and 11 of 76 embedded vectors (14.5%) drop out of Path B.**

This is the same defect shape as R19 — a status change removing a surface — but on the *live*
path rather than the target one, and against real traffic rather than a fixture. R19 was caught
because a probe reported *what won instead*; nothing equivalent exists for production yet.

**A second-order effect makes it worse for one of the four.** `skill_cad_interpretation`'s
vocabulary sits under the `cnc-programming` slug. Its successor `skill_drawing_reading` carries
`domainId: "cnc-machining"`. So a legacy caller scoped to `cnc-programming` does not merely lose
those aliases — the replacement vocabulary appears under a *different* slug it never queries.
For `skill_gdt_reading` the slug is unchanged, so only that half is a clean swap.

**This is an authorization question, not an engineering one, and it is not resolved here.**
Three shapes exist; each has a real cost:

| | Approach | Cost |
|---|---|---|
| **A** | Deploy in full, accept the 12-alias Path B loss | A measurable live recall reduction on the path production serves, before Path A is available to replace it |
| **B** | Deploy corpus + edges, but hold the 4 status flips until Path A is live | Production deliberately diverges from `main` for the duration; the divergence must be recorded and time-boxed, and the parity assertion in §4 must be written to expect it |
| **C** | Deploy, then immediately `db:retag:skills` to re-home stored references and alias rows onto the successors | Re-homing is itself a mutation with its own manifest, and it does not fix the `cnc-programming` → `cnc-machining` slug move |

**Recommendation: B**, time-boxed, with the flips bundled into the S8 read-switch. It is the
only option that never leaves production with less vocabulary than it has today. It costs a
recorded divergence, which is a documentation burden rather than a worker-facing one.

---

## 1. Measured baseline

Production, read-only, 2026-08-18:

| | value | note |
|---|---:|---|
| `skill` rows | **51** | **two namespaces** — 33 `skill_*` (taxonomy) + 18 `mskill_*` (match engine) |
| `skill_alias` rows | 98 | |
| ├ embedded | 76 | |
| ├ `embedding_model` | **NULL on all 76** | no provenance; model coherence unverifiable |
| ├ `text_norm` | 0 | |
| └ `is_searchable` | 0 | |
| `job_domain_skill` edges | **0** | Path A returns nothing for every query |
| `job_postings` with canonical `job_domain_id` | 0 of 8 | the canonical branch never fires |

**The two namespaces matter.** `mskill_*` rows belong to the match engine, not the taxonomy. Any
S3 count assertion that says "`skill` should now hold N rows" must scope to `skill_id LIKE
'skill\_%'` or it will report a false failure — and worse, a careless "delete what we added"
rollback that ignores the prefix would take out the match vocabulary.

Authoritative corpus on `main`: **147** skill ids, **335** distinct `(skill_id, text)` aliases,
**236** active edges (`db:verify:taxonomy` PASS).

Set difference against production:

- skills in **corpus only**: 114 (to be inserted)
- skills in **production only**: 18 — all `mskill_*`, none touched by S3
- aliases in **corpus only**: 238 (to be inserted)
- aliases in **production only**: **1** — `skill_cad_interpretation | "drawing padhna"`,
  unembedded. TD-01 repointed that wedge alias to `skill_drawing_reading`, so seeding creates
  the same text under both skills unless it is retagged. It is the one row S3 makes stale.

---

## 2. Expected post-deployment state

Asserted exactly, so "it looked fine" is not an outcome:

| object | before | after | delta |
|---|---:|---:|---|
| `skill` where `skill_id LIKE 'skill\_%'` | 33 | **147** | +114 |
| `skill` where `skill_id LIKE 'mskill\_%'` | 18 | **18** | **0 — must not move** |
| `skill_alias` | 98 | **336** | +238 |
| `job_domain_skill` | 0 | **236** | +236 |
| `job_domain_skill` where `status='active'` | 0 | **236** | +236 |
| `skill.status='deprecated'` | 0 | **6** under option A / **0** under option B | see §0 |
| `skill_alias.text_norm` populated | 0 | **0** | S4, not S3 |
| `skill_alias.is_searchable` | 0 | **0** | S4, not S3 |
| `skill_alias.embedding` non-null | 76 | **76** | S5, not S3 |

`336 = 98 + 238`, and independently `335 corpus + 1 stale = 336`. The two derivations must agree;
if they do not, the corpus and the database disagree about what a row is.

---

## 3. Preflight — every check read-only, all must pass

Run immediately before the seed, on the same connection that will perform it.

1. **Target is the intended database.** Print host + database name and confirm by eye. Three
   prior findings in this workstream turned on which database was connected.
2. **`git rev-parse HEAD` equals `origin/main`**, and `git status --porcelain` is empty. A seed
   from a dirty tree cannot be reproduced.
3. **`pnpm db:verify:taxonomy` PASSes** — 98 growth skills, 236 edges, 0 problems.
4. **Full test suite green** — db, taxonomy, match-engine.
5. **Baseline snapshot captured** to an evidence file: every count in §1, plus the full
   `(skill_id, text, lang, domain_id, embedding IS NOT NULL)` tuple set and its sha256. This is
   the rollback key and the Path-B parity baseline; without it, §4 cannot be evaluated.
6. **Path B universe recorded per slug** (the 10 slugs, 98 aliases, 76 embedded).
7. **Migration state current** — `job_domain_skill` and the `skill.status`/`replaced_by` TAX-9
   columns exist.
8. **No concurrent writer.** Confirm no other seed or backfill is mid-flight.
9. **Both flags still `false`**, verified from deployed configuration rather than inferred.
10. **Rollback rehearsed against staging** with the same manifest shape — not merely written.

---

## 4. Parity assertions — after the seed, before anything else

**P1 — Path B is unchanged.** For each of the 10 legacy slugs, the set of
`(skill_id, text)` returned by `legacyAliasRows`' predicate must be **identical** before and
after, compared as a sorted sha256. Under option A this assertion **will fail by 12 rows**, and
that is the whole reason §0 must be decided first — the assertion is written to fail rather than
to be quietly relaxed.

**P2 — nothing existing was mutated.** For all 98 pre-existing alias rows: `id`, `text`, `lang`,
`domain_id`, `embedding` and `embedded_at` byte-identical. S3 is an insert, not an update. The
only permitted change is `skill.status` on the four rows in §0, and only under option A.

**P3 — the match namespace is untouched.** 18 `mskill_*` rows, unchanged.

**P4 — the deployed corpus matches `origin/main`.** Not a count check. Recompute, from the
database, the same `(skill_id, text)` key set the corpus produces, and assert it equals the file
set exactly — same 335 keys, plus the one known stale row, and nothing else. Then assert the
edge set equals the 236 file edges as `(job_domain_id, skill_id, default_requirement,
relevance)` tuples. **Counts agreeing while contents differ is the failure this catches.**

**P5 — R19 holds in production.** `skill_drawing_reading` is `active` and carries **12** edges;
`skill_gdt_reading` and `skill_cad_interpretation` carry **0**. The defect must not be
re-imported by the deployment that was supposed to carry its fix.

**P6 — no new lifecycle violations.** `db:verify:aliases` CLEAN on both tables, all six
invariants, `is_searchable` stored equal to expected.

**P7 — Path A is reachable but still not serving.** `job_domain_skill` returns 236 rows, and
`canonicalAliasRows` for a known domain returns a non-empty candidate set — while
`SKILL_CANONICALIZE_ENABLED` remains `false` and no caller passes `job_domain_id`. Proves the
deployment worked without turning anything on.

**P8 — TD-07 was not resolved by side effect.** No skill named or aliased as a generic welding
parent was created; the bare `welding` alias still resolves exactly as before. **S3 must not
decide TD-07 implicitly** — it remains GAP, requiring product + trainer.

---

## 5. Rollback

**Rollback key:** the id set captured in preflight step 5, plus the seed's own manifest.

| what | how | reversible? |
|---|---|---|
| 114 inserted `skill` rows | `DELETE FROM skill WHERE skill_id = ANY(<manifest ids>)` | yes — they had no dependants before S3 |
| 238 inserted `skill_alias` rows | delete by captured id set | yes |
| 236 inserted `job_domain_skill` edges | delete by captured id set; the table was **empty** before, so `DELETE FROM job_domain_skill` is also exact | yes |
| 4 `skill.status` flips (option A only) | `UPDATE skill SET status='active', replaced_by=NULL WHERE skill_id = ANY(<4>)` | yes |
| Path B behaviour | restored by the above; re-assert P1 after rollback | yes |

**Order matters:** edges first, then aliases, then skills — the reverse of insertion, so no FK
is left dangling mid-rollback.

**What rollback does NOT restore:** nothing, at this stage. S3 writes no vectors and consumes no
quota, which is precisely why it is separated from S5.

---

## 6. Explicitly out of scope for S3

Normalization and election (**S4**) · embedding and `embedding_model` provenance (**S5**) · the
dual-read shadow (**S6**) · the read switch (**S8**) · enabling either flag (**S9**) · removing
`legacyAliasRows`, `LEGACY_ANCHOR_SKILL_DOMAIN` or the legacy arm (**S10**) · the 14-edge
re-point (already done at corpus level, #975) · TD-07 · the 4,071-domain surface.

---

## 7. What blocks authorization right now

1. **§0 must be decided** — A, B or C. As specified, S3 reduces live Path-B vocabulary by 12
   aliases, and the plan will not paper over that by relaxing P1.
2. **TD-07 unresolved.** Its aliases either ship or are explicitly excluded; that is a decision.
3. **The 76 NULL `embedding_model` rows.** Not blocking S3 itself, but blocking S5, and the
   choice (re-embed with provenance vs. record as legacy-unattributable) affects what S3 should
   record as its baseline.
4. **Rollback not yet rehearsed** (preflight 10).

Items 2–4 can proceed in parallel. **Item 1 is the gate.**
