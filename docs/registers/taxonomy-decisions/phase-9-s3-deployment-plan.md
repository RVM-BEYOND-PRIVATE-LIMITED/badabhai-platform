# S3 — staged taxonomy deployment: S3-A → S3-D

> **Status: DESIGN ONLY. No stage has been executed.** Production is untouched: not seeded, not
> embedded, no status changed, no flag moved, legacy retrieval arm intact.
>
> **Option B is the ratified shape** (2026-08-18): the four deprecated-status flips are held
> until the read switch is ready and verified. Supersedes the single-shot S3 plan, which was
> found unsafe — see §0.
>
> Baselines measured read-only against production on **2026-08-18**.

---

## 0. Why the single-shot plan was unsafe, and what makes the staged one provable

`legacyAliasRows` — the arm production actually serves — carries `AND s.status = 'active'`.
Seeding the corpus with its status changes applied would flip four live skills to `deprecated`
and remove **12 of 98 production aliases (12.2%)** and **11 of 76 embedded vectors (14.5%)** from
the live retrieval universe, before Path A exists to replace them.

**P1 failing under that plan was evidence the plan was wrong, not that P1 was too strict.** P1 is
retained unchanged and unweakened.

### The property that makes S3-A safe, and it is structural rather than hopeful

`seed-skills.ts` inserts every alias with **`embedding` left NULL** (`db:embed:skills` is the
separate gated step), and alias rows are `onConflictDoNothing` — an existing row is never
rewritten, so no stored vector or `embedded_at` can be disturbed. **Both** retrieval statements
filter `sa.embedding IS NOT NULL`.

Therefore every newly seeded alias is **invisible to both paths on arrival**. The corpus lands
inert. The only thing in a seed run that can perturb live retrieval is the `skill.status`
update — and Option B holds exactly that.

This turns "we believe it is additive" into "it cannot be seen, and here is the predicate that
proves it".

### The one code change S3-A requires

`seed-skills.ts` upserts with `onConflictDoUpdate({ set: { ..., status: s.status } })`, so the
stock seeder **would** apply the four flips. S3-A needs:

**`db:seed:skills --preserve-existing-status`**

- For a row that **already exists**: omit `status` from the `set` clause. Production's status
  wins.
- For a **new** row: the corpus status applies as normal.
- **Also skip PASS 2's `replaced_by` write for preserved rows.** The DB CHECK is
  `replaced_by IS NULL OR status = 'deprecated'`; writing a pointer onto a row whose status was
  preserved as `active` violates it. Missing this turns a safety flag into a failed migration.
- The flag must **report** every row whose status it held, by id, so the divergence is recorded
  rather than silent.

Exactly **4** rows are affected. Verified: of all corpus skills whose status is `deprecated` or
`provisional`, only these four exist in production today.

Not implemented here — this design is the deliverable. It is one flag, one conditional in each
pass, and one test asserting a preserved row keeps `active` and gains no pointer.

---

## 1. Stage overview

| stage | changes | live retrieval effect | gate to the next |
|---|---|---|---|
| **S3-A** | seed corpus + edges, statuses held | **none — provably inert** | P1–P8 pass |
| **S3-B** | nothing (verification only) | none | parity + shadow evidence accepted |
| **S3-C** | caller change behind a switch, off | none until flipped | switch reversible, observability live |
| **S3-D** | the 4 status flips, tied to the switch | intended cutover | rollback window elapses |

**No stage enables `SKILL_CANONICALIZE_ENABLED`.** See §8.

---

## 2. S3-A — additive corpus deployment

### Production state before → after

| object | before | after | note |
|---|---:|---:|---|
| `skill` where `skill_id LIKE 'skill\_%'` | 33 | **147** | +114 inserted |
| `skill` where `skill_id LIKE 'mskill\_%'` | 18 | **18** | **must not move** |
| `skill` with `status='deprecated'` | 0 | **10** | new rows only; **the 4 live ones stay `active`** |
| `skill_alias` | 98 | **336** | +238, all `embedding IS NULL` |
| ├ embedded | 76 | **76** | unchanged — nothing embedded |
| ├ `text_norm` | 0 | **0** | S4 |
| └ `is_searchable` | 0 | **0** | S4 |
| `job_domain_skill` | 0 | **236** | +236 |
| **Path B candidate universe** | **98 rows / 76 embedded across 10 slugs** | **identical** | the assertion |

`336 = 98 + 238`, and independently `335 corpus keys + 1 stale = 336`. Both derivations must
agree; disagreement means the corpus and the database disagree about what a row is.

### What runs

```
pnpm db:seed:skills --preserve-existing-status     # 49 SKILL_CORPUS rows + wedge aliases
pnpm db:seed:domain-skills --apply                 # 98 growth skills + 236 edges
```

Order is fixed: `domain-skills` edges reference `SKILL_CORPUS` ids (`skill_drawing_reading` among
them) and its own `shippedDependencies` precondition will refuse to run otherwise.

### The one stale row

`skill_cad_interpretation | "drawing padhna"` (unembedded) exists in production; TD-01 repointed
that wedge alias to `skill_drawing_reading`. After S3-A the same text exists under both skills.

**Left in place at S3-A, deliberately.** It is unembedded, so it is invisible to both paths and
can affect nothing. Re-homing it is `db:retag:skills`, a separate mutation with its own manifest,
and it belongs with S3-D where the rest of the TD-01 cutover happens. Recorded here so it is not
discovered later and mistaken for corruption.

### Parity assertions at the S3-A boundary — all must pass

**P1 — Path B is bit-identical.** For each of the 10 legacy slugs, the set of `(skill_id, text)`
satisfying `legacyAliasRows`' predicate, compared as a sorted sha256, before vs after.
**Unweakened.** Under Option B this must now *pass*; if it fails, the status hold did not work
and S3-A is rolled back.

Baseline (`domain_id → aliases / embedded`): `cnc-machining` 29/22 · `cnc-programming` 14/11 ·
`fabrication` 10/6 · `fitting-assembly` 6/5 · `general-machining` 2/2 · `grinding` 5/3 ·
`maintenance` 5/4 · `metrology-quality` 14/11 · `vmc-machining` 3/3 · `welding` 10/9.

**P2 — nothing existing was mutated.** All 98 pre-existing alias rows keep `id`, `text`, `lang`,
`domain_id`, `embedding`, `embedded_at` byte-identical. Guaranteed structurally by
`onConflictDoNothing`, asserted anyway.

**P2b — the four statuses were held.** `skill_gdt_reading`, `skill_cad_interpretation`,
`skill_dimensional_inspection`, `skill_boring` are still `active`, still with
`replaced_by IS NULL`. **This is the assertion Option B exists for.**

**P3 — the match namespace is untouched.** 18 `mskill_*` rows, unchanged.

**P4 — the deployed corpus matches `origin/main` by CONTENT, not count.** Recompute the
`(skill_id, text)` key set from the database and assert equality with the file set — 335 keys
plus the one known stale row, nothing else. Then assert the edge set equals the 236 file edges as
`(job_domain_id, skill_id, default_requirement, relevance)` tuples. Counts agreeing while
contents differ is exactly what this catches.

**P5 — R19 holds in production.** `skill_drawing_reading` is `active` with **12** edges. Its two
predecessors hold **0** edges. The deployment must not re-import the defect whose fix it carries.

**P6 — no new lifecycle violations.** `db:verify:aliases` CLEAN on both tables, all six
invariants.

**P7 — Path A reachable, still not serving.** `job_domain_skill` returns 236 rows; but
`canonicalAliasRows` still returns **zero candidates for every domain**, because every new alias
is unembedded. That is the correct S3-A outcome and it is asserted positively — Path A being
wired and empty is the proof the corpus landed inert.

**P8 — TD-07 not resolved by side effect.** No generic welding parent was created; bare `welding`
resolves exactly as before. **TD-07 remains GAP — product + trainer.**

### Rollback

Reverse insertion order — edges, then aliases, then skills — so no FK dangles mid-rollback.

| what | how |
|---|---|
| 236 edges | delete by captured id set; the table was **empty** before, so `DELETE FROM job_domain_skill` is equally exact |
| 238 aliases | delete by captured id set (deterministic ids, so recomputable) |
| 114 skills | `DELETE FROM skill WHERE skill_id = ANY(<manifest>)` — no dependants existed before S3-A |
| statuses | nothing to revert; none were changed |
| Path B | restored by the above; **re-assert P1 after rollback**, not just before |

Consumes no provider quota and writes no vector, so rollback is complete rather than partial.

---

## 3. S3-B — parity and shadow verification

**Mutates nothing.** Runs against the S3-A production state.

### Required report

| measurement | source | expected |
|---|---|---|
| legacy candidate count, per slug, before/after | P1 baseline vs live | **identical** |
| aliases before/after | 98 → 336 total; **Path-B-visible 98 → 98** | additions invisible |
| embedded vectors before/after | 76 → 76 | unchanged |
| domain-scoped reachability | `canonicalAliasRows` per fixture domain | 236 edges wired, **0 candidates** (unembedded) |
| **TD-01 scope difference** | `skill_cad_interpretation` = `cnc-programming`; `skill_drawing_reading` = `cnc-machining` | **replacement vocabulary lands under a different slug** — see below |
| stale alias | `skill_cad_interpretation \| "drawing padhna"` | present, unembedded, inert |

### The scope difference, stated plainly

`skill_gdt_reading` (`cnc-machining`) → `skill_drawing_reading` (`cnc-machining`): same slug, a
clean swap once embedded.

`skill_cad_interpretation` (`cnc-programming`) → `skill_drawing_reading` (`cnc-machining`):
**not** a swap. A legacy caller scoped to `cnc-programming` loses 4 aliases at S3-D and gains
nothing, because the replacement sits under a slug it never queries.

**Replacement reachability must not be assumed to preserve domain-scoped behaviour.** S3-D cannot
proceed on the theory that "the successor covers it" — for `cnc-programming` it demonstrably does
not, and that is a decision (accept the loss for legacy callers, or re-home the vocabulary) which
S3-D must make explicitly rather than inherit.

### Shadow evidence

The offline replay stands in for a live shadow until S3-C: enabling canonicalization to observe
it is the change the shadow de-risks. Minimum accepted at this boundary:

- the committed pre/post-repair replay artifacts,
- the 96-probe TD-01 diagnostic at **96/96**,
- **the 11 provider cases resolved** — otherwise 12.5% of the scoreable set is still unmeasured.

Once S3-C's dual-read exists, live parity replaces this and the threshold is **derived from the
shadow data**, never invented in advance.

---

## 4. S3-C — read-switch design

### The switch already exists, and it is caller-side

```ts
// apps/api/src/skills/skills.dto.ts:73-77
export function toAliasSearchScope(dto: NearestAliasesDto): AliasSearchScope | null {
  if (dto.job_domain_id !== undefined) return { kind: "canonical", jobDomainId: dto.job_domain_id };
  if (dto.domain_id !== undefined) return { kind: "legacy", domainId: dto.domain_id };
  ...
}
```

| | |
|---|---|
| **Switch** | which field the caller populates — `job_domain_id` (Path A) or `domain_id` (Path B) |
| **Candidate source** | `canonicalAliasRows` (`job_domain_skill` join) vs `legacyAliasRows` (`sa.domain_id`) |
| **Rollback switch** | stop sending `job_domain_id`. `job-postings.service.ts:140` already falls back to `LEGACY_ANCHOR_SKILL_DOMAIN` — **no code change, no deploy** |
| **Independently deployable** | yes — no repository change, no migration, no flag, and it does **not** require the seed or the status migration to be atomic with it |
| **Activation owner** | Backend Platform |

This is the property the staging demanded: the switch is a request shape, so it can be flipped
per-caller, reverted instantly, and is entirely decoupled from S3-D.

### Dual-read shadow (the part that must be built)

Compute `canonicalAliasRows` alongside `legacyAliasRows`, **return Path B**, log both. Behind its
own flag, sampled. It changes no response, so it is safe before parity is known — and it is the
only way to get parity against real traffic rather than a fixture.

### Observability — and a gap that blocks the switch

Available: `unresolved_phrase` (`scope`, `phrase`, `domain_id`, `lang`, `count`, `last_seen`) and
Langfuse tracing.

**Gap, already known (D-6):** `unresolved_phrase` has no `job_domain_id` column —
`skills.dto.ts:115` names the unblocker. **A canonical-scoped miss cannot currently be recorded.**
Flipping the switch without it means Path A's failures are invisible in exactly the table built
to catch failures. Adding the column plus widening its unique key is a **prerequisite of S3-C**,
not a follow-up.

Per-request shadow metrics: top-1 agreement, score delta, Path A empty-rate, latency delta.

### Abort thresholds

| signal | abort if |
|---|---|
| Path A empty-rate | exceeds the Path B baseline by any margin agreed **from shadow data** |
| top-1 disagreement | above the derived threshold, or **any** disagreement unclassified |
| `unresolved_phrase` volume | rises against the pre-switch baseline |
| GP-04 | fails to resolve to `skill_coolant_management`, or scores below **0.75** |
| latency | canonicalization p95 regresses beyond its budget |

No threshold is fixed here. Inventing one before the shadow data exists is the mistake
`REGRESSION_BASELINE`'s own comment warns about.

**Not implemented or enabled. Separate authorization.**

---

## 5. S3-D — status migration, tied to the read switch

**Only after S3-A, S3-B and S3-C are proven.** This is the sole stage that changes live retrieval.

### The invariant this stage exists to protect

> There must be **no** production state in which `legacy retrieval = active-only` **and** the
> deprecated statuses are applied, unless the legacy candidate universe has been proven
> equivalent.

Mechanically: the 4 flips must land **at or after** the read switch, never before. Ordering them
the other way reproduces exactly the 12-alias loss Option B was chosen to avoid.

### What changes

1. The 4 `skill.status` → `deprecated` with `replaced_by` set (`db:seed:skills` **without**
   `--preserve-existing-status`, i.e. the stock seeder, now safe).
2. `db:retag:skills` re-homes stored references and the one stale `drawing padhna` row.
3. The `cnc-programming` decision from §3 applied explicitly.

### Entry criteria

- Path A serving via the switch, parity accepted, rollback window elapsed with no revert;
- the merged skill's aliases **embedded with recorded provenance** (S5) — otherwise deprecating
  the predecessors removes a live surface and the successor is still unembedded, which is the
  original defect wearing a different hat;
- `cnc-programming` decision recorded.

### Rollback

`UPDATE skill SET status='active', replaced_by=NULL WHERE skill_id = ANY(<4>)`, then re-assert
P1 against the original baseline. Reverting the read switch alone is **not** sufficient once the
flips have landed — both must be undone, and in that order: switch first, then statuses.

---

## 6. Safety rails — retained verbatim, not relaxed

**P1** Path-B parity · **P8** TD-07 guard · `skill_*` / `mskill_*` namespace separation · exact
expected post-state · captured-id rollback · reverse-order rollback · unembedded-alias detection.

P1 failing under a plan is evidence the plan is unsafe. It is never evidence that P1 should be
softened to let the plan pass.

---

## 7. Still-open dependencies

| | blocks |
|---|---|
| 11 provider cases — contract approved, **you** execute; no sandbox calls, guard untouched | S3-B's evidence completeness |
| 5 TD-01 trainer slots — **empty**, no fabricated ground truth; mechanical cases stay reachability diagnostics and are never promoted to recall evidence | fixture credibility for the merged skill |
| `unresolved_phrase.job_domain_id` | **S3-C** |
| 76 NULL `embedding_model` rows | S5 |
| `cnc-programming` scope decision | S3-D |
| **TD-07 — GAP, product + trainer** | S3-A's P8 keeps it from being resolved implicitly |

---

## 8. Flag confirmation

**No stage in S3-A → S3-D enables `SKILL_CANONICALIZE_ENABLED` or `DOMAIN_MATCH_ENABLED`.**

- **S3-A** seeds data. No flag is read or written.
- **S3-B** reads. No flag.
- **S3-C** adds a caller-side scope choice and a separately-flagged dual-read shadow. Neither is
  `SKILL_CANONICALIZE_ENABLED`; the shadow returns Path B and changes no response.
- **S3-D** updates `skill.status`. No flag.

`SKILL_CANONICALIZE_ENABLED` is **S9**, a standalone PR containing the flag flip and nothing
else, gated on the eleven activation criteria. `DOMAIN_MATCH_ENABLED` is not on this path at all
— the scope comes from the lexical pin, which short-circuits before that flag is read.

`legacyAliasRows`, `LEGACY_ANCHOR_SKILL_DOMAIN` and the legacy arm **stay** through every stage
above. They are removed at **S10**, and only after S3-D's rollback window closes clean.
