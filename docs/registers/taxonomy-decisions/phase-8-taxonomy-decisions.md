# Phase 8 taxonomy decisions — DRAFT register

**Status: DRAFT. Nothing here has been applied. No row has been written, no alias added or
removed, no vector embedded.**

Every entry requires RVM trade-trainer / ops ratification before it becomes actionable. This
register exists so that ratification happens against measured impact rather than against a
description, and so the order of operations is fixed before anything is irreversible.

Impact figures are computed offline against the live corpus by
`packages/db/data/taxonomy/decisions/phase-8-decision-impact.json`. Zero provider calls.

---

## 1. Inputs that did NOT arrive

Recorded because the gap changes what can be finalized, and because inventing any of it would
be manufacturing exactly the ground truth this phase exists to avoid.

| missing | consequence |
|---|---|
| The domain-review answer sheet itself | The 16 skills said to be "marked reviewed" cannot be identified. No case has been moved to `reviewed`. |
| The drafted paraphrases | All 52 slots remain empty and `pending_review`. |
| "Appropriate Devanagari transliterations where specified in the review sheet" | Only the transliterations given explicitly in the instruction are recorded below. |
| "Appropriate Fanuc model aliases" | **Not recorded.** Controller model numbers are factual claims about hardware; Mitsubishi (`M70`, `M80`) and Siemens (`828D`, `840D`) were given explicitly, Fanuc's were not, and guessing them would put fabricated model numbers into a worker-facing taxonomy. |
| TD-01's per-alias split of `skill_cad_interpretation` | Which of its 4 aliases are *reading* and which are *CAD usage* is undecided — see TD-01. |

---

## 2. Taxonomy decisions

### TD-01 — `skill_gdt_reading` + reading portion of `skill_cad_interpretation` → `skill_drawing_reading` · **DECIDED**

CAD *software usage* stays a separate skill.

- `skill_gdt_reading` — active, 4 aliases (4 embedded), **8 domains**, 0 fixture cases
- `skill_cad_interpretation` — 4 aliases, 6 domains, **must be split, not merged**
- `skill_drawing_reading` — **does not exist**; requires creation

**Blocked on a reviewer decision the sheet does not contain**: each `skill_cad_interpretation`
alias must be assigned to one side of the split.

| alias | reading? | CAD usage? |
|---|---|---|
| `read engineering drawings` | ? | ? |
| `drawing padhna` (hi) | ? | ? |
| `technical drawing` | ? | ? |
| `CAD` | ? | ? |

Measured support for the merge: `"read engineering drawings"` (cad) and `"blueprint reading"`
(gdt) sit at cosine **0.7985**, and `"drawing padhna"` vs `"drawing reading"` likewise at
**0.7985** — among the closest cross-skill pairs in the corpus.

### TD-02 — `skill_dimensional_inspection` → `skill_quality_control` · **DECIDED**

- source: active, 3 aliases (3 embedded), 2 domains
- target: active, 3 aliases, 1 domain

⚠️ **Breaks a fixture case.** `US-04` (`unembedded_shipped`) names
`skill_dimensional_inspection` as its expected skill. When the merge lands, that reference
dangles and the fixture validator fails with an unknown-skill problem. The fixture edit must
ship in the same change as the merge, not after it.

Measured support: `"quality check"` (dimensional_inspection) vs `"quality check karna"`
(quality_control) at cosine **0.8219** — the second-closest cross-skill pair in the corpus.

### TD-03 — `skill_boring` → `skill_turning` · **DECIDED, CONDITIONAL**

Conditional on no JD requiring a dedicated boring-machine operator.

- `skill_boring` — active, **1 alias**, 1 domain, 0 fixture cases
- `skill_turning` — active, 5 aliases, 2 domains

Lowest-risk merge on the list. Note `skill_turning` is the skill that took GP-04 from
`skill_coolant_management`; widening it slightly increases that pressure, so GP-04 should be
re-measured after this merge rather than assumed unaffected.

### TD-04 — `skill_go_no_go_gauge_checking` + `skill_measuring_instruments` · **DEFERRED**

Line-inspector / JD decision required. Not decided automatically.

- source: **provisional**, 2 aliases (2 embedded), 2 domains
- target: active, 6 aliases, 9 domains

Measured: `"गेज से जांच"` vs `"gauge"` at cosine **0.7933**. Note this interacts with the
approved removal of the bare alias `gauge` — see §3.

### TD-05 — `skill_fixture_setup` + `skill_tool_offset_setting` → `skill_cnc_setup` · **DEFERRED**

Only if RVM JDs do not distinguish workholding setup from tool-offset setting.

- `skill_fixture_setup` — active, 5 aliases (5 embedded), 1 domain
- `skill_tool_offset_setting` — active, 2 aliases (2 embedded), 2 domains
- `skill_cnc_setup` — does not exist; requires creation

⚠️ **Blocks one approved alias addition**: `offset lagana → skill_tool_offset_setting` (§3)
attaches vocabulary to a skill this decision may dissolve.

### TD-06 — `skill_chassis_fitting` → `skill_mechanical_assembly` · **DEFERRED**

Confirm whether automotive JDs specifically require chassis-fitting experience.

- source: **provisional**, 2 aliases (2 embedded), 1 domain
- target: active, 2 aliases, 3 domains

### TD-07 — generic welding node · **GAP, not a merge**

There is no generic welding skill. Recorded as a taxonomy gap.

**Bare `welding` must not be mapped to `skill_arc_welding`.** The corpus currently holds
`skill_arc_welding`, `skill_mig_welding`, `skill_tig_welding` and `skill_gas_cutting`, with
`SMAW` vs `GMAW` at cosine **0.8405** — the closest cross-skill pair measured. A worker who
says only "welding" has not told us which, and silently resolving to arc welding would put a
specific process on their profile that they may not do.

---

## 3. Alias changes — frozen list, pre-checked, NOT applied

All 13 additions were checked against every existing alias: **no collisions, no missing target
skills**. Both removals match exactly one row and leave the skill with other aliases.

### Add

| text | skill | pre-check |
|---|---|---|
| `CO2 welding` | `skill_mig_welding` | ok |
| `CO2 वेल्डिंग` | `skill_mig_welding` | ok |
| `patra` | `skill_sheet_metal` | ok |
| `पतरे का काम` | `skill_sheet_metal` | ok |
| `M70` | `skill_mitsubishi` | ok |
| `M80` | `skill_mitsubishi` | ok |
| `828D` | `skill_siemens` | ok |
| `840D` | `skill_siemens` | ok |
| `thread marna` | `skill_tapping_threading` | ok |
| `offset lagana` | `skill_tool_offset_setting` | ⚠️ **held — TD-05 may dissolve this skill** |
| `assembly ka kaam` | `skill_mechanical_assembly` | ok |
| `असेंबली` | `skill_mechanical_assembly` | ok |
| `hydraulic ka kaam` | `skill_hydraulics_pneumatics` | ok |

Fanuc model aliases: **omitted, not forgotten**. See §1.

### Remove / demote

| text | skill | effect |
|---|---|---|
| `fitting` | `skill_bench_fitting` | 1 row; 2 aliases remain. No fixture case queries this text. |
| `gauge` | `skill_measuring_instruments` | 1 row; 5 aliases remain. No fixture case queries this text. |

Both are the single-token hazard the label audit flags: a bare token matches far too broadly,
which is precisely how GP-04 was lost to `turning`.

Prefer `is_searchable = false` over `DELETE`. Demotion preserves the row, its id, and its
`embedded_at` provenance while removing it from the unique index and from retrieval —
additive-only, per the database standards, and reversible without a re-embed.

---

## 4. Interaction with the 84 audit-approved canonical labels

**3 of the 84 must be held back** until their decision resolves — ingesting the canonical label
of a skill that is about to be dissolved creates a row that then has to be migrated or deleted:

| label | skill | blocked by |
|---|---|---|
| `Chassis fitting` | `skill_chassis_fitting` | TD-06 |
| `Go no-go gauge checking` | `skill_go_no_go_gauge_checking` | TD-04 |
| `Tool offset setting` | `skill_tool_offset_setting` | TD-05 |

**Writable set: 84 → 81**, pending the deferred decisions.

Three further labels already carrying a `REVIEW` verdict are also moot if their merge proceeds:
`skill_cad_interpretation` ("CAD / technical drawing interpretation"), `skill_fixture_setup`
("Fixture / job setup"), `skill_gdt_reading` ("GD&T / drawing reading"). All three are compound
labels, which is consistent with them naming skills that turned out to be two skills.

---

## 5. Order of operations

Each arrow is a stop. The sequencing is not bureaucracy — TD-02 breaks a fixture case and TD-05
invalidates a queued alias, so running these concurrently would corrupt one with the other.

```
1  taxonomy freeze      TD-01..TD-07 ratified; TD-01 alias split assigned; TD-07 gap resolved
2  fixture repair       US-04 re-pointed in the same change as TD-02
3  alias update         13 additions minus any blocked; 2 demotions        [STOP — authorization]
4  canonical labels     the 81, re-audited after the merges                [STOP — authorization]
5  embed                approved set only, Gate B safeguards + fresh Langfuse
6  trainer review       16 draft skills ratified; 52 slots authored
7  fixture v3           reviewed cases promoted out of pending_review
8  fresh evaluation     new experiment record; EXP-P8-* never overwritten
9  gates                NO_REGRESSION, RESOLVABLE_ABOVE_FLOOR
10 promotion review     separate decision
```

Steps 3–5 and 7–8 must not be combined into one measurement. An evaluation that moves the
taxonomy, the aliases and the fixture at once cannot attribute its own result.

---

## 6. Unchanged

`skill_canonicalize_enabled = false` · floor **0.75** · `NO_REGRESSION` enforced · no skill
promoted · 4,071-domain generation NOT AUTHORIZED · the 33 provisional-skill aliases remain
unembedded · `EXP-P8-BASELINE` and `EXP-P8-CANONICAL-LABEL` untouched.

The measured GP-04 repair sits at **0.7509**, nine ten-thousandths above the floor. The floor
does not move to accommodate it.
