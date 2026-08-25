# D-7C — the three "match-set neutral" deprecations, verified through HOP 0

**Prepared against main `52511487` · measured 2026-08-25 · read-only**
**Production mutation: NONE · AI spend: ₹0 · nothing seeded, deprecated, retagged or mapped**

Reproduce: `pnpm db:audit:deprecation-hop0 --json=<out>`
Artifact: [`d7c-hop0.json`](./d7c-hop0.json) (carries `measured_at`)

> **HEADLINE.** Match-set neutrality **holds** — verified through the retrieval hop, not
> inferred from a bridge subtraction. **The seed did not run**: the existing mechanism cannot
> write three of four, and the fourth is `skill_boring`, which is owner-held.
>
> The same measurement also found a **boring-class misassignment in one of the three**. That is
> new, and it is an owner decision.

---

## 1. What was actually verified, and why the usual check is not enough

The D-7C candidates were called neutral because their bridge rows match:

| subject | bridge | corpus successor | successor bridge | delta |
|---|---|---|---|---|
| `skill_gdt_reading` | `[]` | `skill_drawing_reading` | `[]` | none |
| `skill_cad_interpretation` | `[]` | `skill_drawing_reading` | `[]` | none |
| `skill_dimensional_inspection` | `["mskill_quality_inspector"]` | `skill_quality_control` | `["mskill_quality_inspector"]` | none |

**That subtraction assumes the phrase lands on the successor.** Retrieval never reads
`replaced_by`. It filters `s.status = 'active'`, which drops the deprecated skill's own aliases
and promotes **the nearest active neighbour** — successor or not. D-7B and D-7A both turned on
exactly this gap.

So all 17 phrase×scope combinations were measured on both sides of the deprecation, in **both**
retrieval scopes, with the three subjects excluded **together** (they would be seeded in one
run). Query vector = each alias's own stored embedding: zero spend, and maximally favourable to
the phrase, so a miss is definitive.

**MEASURED** — production state. All three are still `active` with `replaced_by = NULL`; the
corpus deprecated them and production never followed. Same drift as `skill_boring`.

| subject | status | aliases | active canonical edges |
|---|---|---:|---:|
| `skill_gdt_reading` | active | 4 | **0** |
| `skill_cad_interpretation` | active | 4 | **0** |
| `skill_dimensional_inspection` | active | 3 | 2 |

Two of the three have **no canonical edges at all**, so they are reachable only on the legacy
`skill_alias.domain_id` path. Measuring one scope would have produced a confidently wrong
answer in either direction.

---

## 2. The result

```
observations              = 17
MATCH-SET NEUTRAL         = YES
match skills gained       = none
misassignments            = 2
coverage losses           = 9
neutral only via floor    = 6
```

**Neutrality holds, and the mechanical reason is asserted in a test:** every above-floor
landing is either unbridged, or carries a claim the subject already had. Every landing that
*is* bridged and *would* be new sits below the floor.

### `skill_gdt_reading` — genuinely clean

All four phrases land on the declared successor at **1.0000**, because the completed merge
already put duplicate alias rows on `skill_drawing_reading` with identical vectors. Two of them
(`GD&T`, `geometric dimensioning and tolerancing`) already resolve there *today*. Bridge `[]` →
`[]`. No coverage loss, no misassignment, lands where the crosswalk says.

### `skill_cad_interpretation` — neutral, but only because of the floor

Its aliases live in the `cnc-programming` legacy scope; `skill_drawing_reading` lives in
`cnc-machining`. **The successor is not reachable from where these phrases are**, so all four
stop resolving:

| phrase | lands on | score | landing's bridge |
|---|---|---:|---|
| `CAD` | `skill_cam_software` | 0.6812 | `["mskill_cam_programmer"]` |
| `drawing padhna` | `skill_program_editing` | 0.6171 | `[]` |
| `read engineering drawings` | `skill_cnc_programming` | 0.5939 | `["mskill_cnc_programmer"]` |
| `technical drawing` | `skill_cnc_programming` | 0.5907 | `["mskill_cnc_programmer"]` |

Three of the four fall onto **bridged** skills. No claim fires, because 0.68 / 0.59 / 0.59 are
all below 0.75. **This is neutrality by floor, not by taxonomy** — recorded separately in the
artifact (`neutral_only_via_floor`) rather than folded into the pass, because only one of those
two survives a floor change. Nothing here argues for moving the floor; it argues for knowing
which conclusions depend on it.

Cost: four phrases that resolve today at 1.0 would resolve to nothing.

### `skill_dimensional_inspection` — carries a boring-class misassignment

**MEASURED** — in **both** canonical domains:

```
dimensional inspection  ->  skill_drawing_reading  @ 0.756977   (floor 0.75)
```

Above the floor, so it would be **assigned**, not left open. Reading a drawing is not
inspecting a part — the hit is a lexical artifact ("dimensional" ↔ "dimensioning") on
`geometric dimensioning and tolerancing`. `skill_drawing_reading` is unbridged, so **no match
claim follows**; this is a taxonomy-correctness defect, and it is the same shape as the
0.7556 `boring → skill_drilling` finding that held `skill_boring` back.

Its one clean above-floor landing is `quality check` → `skill_quality_control` @ **0.8219**,
the declared successor, carrying the identical `["mskill_quality_inspector"]`.

> **On the two 0.7570s.** D-7B's chassis figure and this one both round to 0.7570 at 4dp. They
> are different measurements: `0.756975792…` and `0.756977453…`, four distinct alias rows, no
> shared vectors. Checked because a repeated number usually means a copy-paste error. Across
> 89,682 sampled alias pairs the corpus is anisotropic (mean 0.5333, sd 0.0458) and four pairs
> round to exactly 0.7570 — a 4dp collision at this scale is unremarkable.

---

## 3. Blast radius, and reach

**MEASURED** — exactly one alias elsewhere in the corpus currently top-hits one of the three:
`skill_drawing_reading`'s own `drawing reading` resolves to `skill_gdt_reading` at 1.0000, a
duplicate-row tie. After seeding it would resolve to itself. No other phrase moves.

**MEASURED, and vacuous** — `worker_skill` = **0 rows**, `job_posting_skill` = **0 rows**, in
the whole database. So "no worker or job reach changes" is *true but empty*: there are no
stored references to any skill, not merely none to these three. It is not evidence of safety,
and it is recorded as vacuous rather than quoted as a pass. (Consistent with the 2026-08-21
dashboard deletion; the taxonomy spine itself is intact at 165 skills.)

**MEASURED** — precedent exists: `skill_chassis_fitting` and `skill_go_no_go_gauge_checking`
are already `deprecated` in production, both still carrying active job-domain edges.

---

## 4. Why the seed did not run — STOP, not a workaround

TASK 19 says to seed **using the existing approved mechanism** and to keep `skill_boring` out.
Those two instructions cannot both be satisfied. **MEASURED** — `pnpm db:seed:skills --plan`:

```
  CHANGED — existing rows the corpus would overwrite:
    ~ skill_boring                           status (active -> deprecated)
    ~ skill_cad_interpretation               status (active -> deprecated)
    ~ skill_dimensional_inspection           status (active -> deprecated)
    ~ skill_gdt_reading                      status (active -> deprecated)
```

The seeder has exactly two relevant invocations, and `heldSkillIds` is all-or-nothing:

- **without** `--preserve-existing-status` → writes **all four**, `skill_boring` included —
  violates the explicit exclusion and the D-7A hold;
- **with** it → holds all four, writes **nothing**.

There is no third form. Seeding exactly three would require a **new selective guarded runner**,
which is a production mutation through a mechanism that does not exist and has not been
approved. Per the standing rule — *production mutation required but not authorized* — **it was
not built and not run.** Nothing was written.

---

## 5. Owner decisions

### D-7C-1 — `skill_dimensional_inspection`

**FACTS.** Corpus deprecates it → `skill_quality_control` (TD-02, ratified). Production has it
active. Bridge is identical to its successor's.

**MEASURED EVIDENCE.** Match-set neutral. But `dimensional inspection` lands on
`skill_drawing_reading` @ 0.756977 in both `jd_nco_7313_2601` and `jd_nco_7543_2001` — above
the floor, unbridged, semantically wrong. `inspection` stops resolving in both. `quality check`
lands correctly at 0.8219.

**RISK.** A worker who says "dimensional inspection" gets *drawing reading* written to their
profile. No wrong vacancy follows, because the landing is unbridged.

**OPTIONS.** **A** — seed it and accept the misassignment. **B** — hold it, as `skill_boring`
was held for the same defect class. **C** — seed it only after the alias rows are moved onto
the successor, so the phrase lands at ~1.0 instead of on a lexical neighbour.

**RECOMMENDATION.** None on the product question. On consistency only: **the criterion that
excluded `skill_boring` also catches this one**, and applying it to one and not the other needs
a stated reason.

**OWNER DECISION: PENDING.**

### D-7C-2 — the seeding mechanism

**FACTS.** No approved mechanism can write three of four.

**OPTIONS.** **A** — authorize a new selective guarded runner (`--only=<ids>`), reviewed and
ops-guarded like every other production writer. **B** — resolve D-7A first, then the existing
all-or-nothing seeder becomes correct for all four at once. **C** — leave the drift in place.

**RECOMMENDATION.** None — **A** and **B** differ only in whether `skill_boring`'s hold is
resolved first, which is the owner's call.

**OWNER DECISION: PENDING.**

### D-7C-3 — `skill_cad_interpretation`'s floor dependence

Neutral today; three of its four phrases fall onto bridged skills at 0.59–0.68. Recorded so
that any future floor discussion knows this deprecation is load-bearing on it. **No action
requested; the floor is not to be changed.**

---

## 6. What did NOT change

`SKILL_CANONICALIZE_ENABLED` · the 0.75 floor · `NO_REGRESSION` · the regression baseline ·
Q1 bridge mappings · D-7A `skill_boring` · D-7B `skill_chassis_fitting` · vernacular §5a ·
`MATCH_SKILLS` · `ATTRIBUTE_TO_MATCH_SKILLS` · pooler configuration.

**No skill was promoted, mapped, re-domained, deprecated or retagged.**

## 7. Gates

```
RESOLVABLE_ABOVE_FLOOR    FAIL — 62/96      unchanged
NO_REGRESSION             FAIL              unchanged
PROMOTION CANDIDATES      0                 unchanged
```
