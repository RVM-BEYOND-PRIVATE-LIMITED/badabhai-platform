# D-7A — `skill_boring`: HELD, and why it is the inverse of D-7B

**Prepared against main `88ee23d6` · measured 2026-08-25 · read-only**
**Production mutation: NONE · AI spend: ₹0 · nothing seeded, deprecated, retagged or mapped**

Reproduce: `pnpm db:audit:crosswalk-chain --skill=skill_boring --json=<out>`
Artifact: [`d7a-boring-chain.json`](./d7a-boring-chain.json) (carries `measured_at`)

> **STATUS: OWNER-HELD. No option selected.** Task 18 was scoped HOLD/DOCUMENT ONLY, and this
> document does exactly that — it records the state, measures what each action would do, and
> chooses nothing.

---

## 1. Current state

**MEASURED** — production:

| | |
|---|---|
| `skill_boring` | **`status = active`**, `replaced_by = NULL`, `domain_id = cnc-machining` |
| aliases | **1** (`"boring"`), embedded |
| `job_domain_skill` edges | 1 — `jd_nco_7223_0701` |
| bridge entry | **`[]`** — deliberately unmapped |

**STATIC** — `SKILL_CORPUS` marks it `deprecated` with `replacedBy: skill_turning` (TD-03,
ratified). So this is a **drift**: the corpus has deprecated it and production has not. The
instrument resolves the successor from the corpus and records `successor_source: "corpus"`.

**STATIC** — `skill_turning` maps to `["mskill_cnc_turner"]`. TD-03's impact note reads *"no
matching signal is lost"* — true, and it answers only the loss direction (D-7).

---

## 2. The measured behaviour, and why D-7A ≠ D-7B

Scored with `skill_boring`'s own stored alias vector — the most favourable input, and free.

| scenario | "boring" resolves to | score | bridge | claim |
|---|---|---:|---|---|
| **today** (active) | `skill_boring` itself | 1.0000 | `[]` | **none — correct** |
| **if the deprecation were seeded** | **`skill_drilling`** | **0.7556** | **`[]`** | **none** |
| **if the retag also ran** | `skill_turning` (alias moved onto it) | ~1.0 | `["mskill_cnc_turner"]` | **WIDENING** |

> **This is the inverse of D-7B.** There, deprecation *alone* armed the widening, because the
> nearest active neighbour was a bridged successor. Here, the nearest active neighbour is
> `skill_drilling`, which is deliberately unmapped — so deprecation confers **no** match claim.
> It is the **retag's alias move** that would arm this one, by relocating `"boring"` onto
> `skill_turning` at ~1.0.

**Containment therefore differs per crosswalk, and cannot be generalised.** For D-7B, withholding
the retag contains nothing. For D-7A, withholding the retag is exactly what contains it.

### A second defect, smaller and separate

**MEASURED** — seeding the deprecation would make `"boring"` canonicalize to **`skill_drilling`
at 0.7556**, above the 0.75 floor. Boring and drilling are different operations. No match claim
follows, so this is a **taxonomy-correctness** defect rather than a matching one — but it is a
wrong assignment written to a worker's profile.

**MEASURED** — the corpus's intended successor, `skill_turning`, scores **0.6652** — *below* the
floor. So retrieval would **not** pick the successor the crosswalk names. The crosswalk and the
retrieval disagree, and retrieval does not read the crosswalk.

---

## 3. Why no option is selected

Task 18's instruction is HOLD. Recording the reasoning so the hold is legible rather than inert:

- **A — leave `skill_boring` unmapped forever.** Consistent with the bridge's stated doctrine:
  drilling, boring, tapping and deburring are near-universal shop-floor operations, and mapping
  them *"would reach a lathe hand for a programmer's vacancy"*.
- **B — replace with a semantically justified match.** **There is no obvious target.** No
  `mskill_*` corresponds to boring; `mskill_cnc_turner` is the wrong one, which is the whole
  finding.
- **C — retire without a runtime replacement.** Would leave the drift in place and the
  `"boring"` phrase resolving to itself, which is the behaviour that is currently correct.

**No recommendation is offered.** This is a product judgement about what a worker's boring
experience entitles them to claim, and the engineering evidence does not favour one answer —
it only rules out the accidental one.

**OWNER DECISION: PENDING.**

---

## 4. What this constrains elsewhere

**D-7C sequencing.** Seeding the three "match-set neutral" deprecations is safe on the matching
axis. **Seeding `skill_boring` alongside them is not equivalent** — it introduces the 0.7556
`drilling` misassignment. The three-vs-four split in D-7C is therefore load-bearing and should
not be simplified back to "seed all four".

**Nothing else changes.** `skill_boring` stays `active` in production, unmapped, unseeded,
unretagged.

---

## 5. Gates

```
RESOLVABLE_ABOVE_FLOOR    FAIL — 62/96      unchanged
NO_REGRESSION             FAIL              unchanged
PROMOTION CANDIDATES      0                 unchanged
```


---

## OWNER RULING — 2026-08-26: **KEEP THE HOLD**

**Ruled:** hold. Do **not** activate a widening mapping for `skill_boring`. Do **not** invent an
`mskill_*` target for it. Keep the current safe behaviour and re-evaluate later against real
performance.

**What this changes: nothing in the corpus.** `skill_boring` stays `active`, unmapped, unseeded
and unretagged — exactly the state §4 of this document describes.

**What it keeps load-bearing.** The three-vs-four split in D-7C. Seeding `skill_boring` alongside
the three neutral subjects is *not* equivalent to seeding them: it introduces the 0.7556
`drilling` misassignment. `seed-deprecations.ts` enforces this by **allow-list** —
`skill_boring` cannot be named on `--only=` at all, and a test asserts the exclusion cannot be
argued around rather than trusting the operator to remember.

`D-7A` is now **COMPLETE** in the programme graph. It was one of the two items gating
`D-7C-SEED`; both are now ruled.
