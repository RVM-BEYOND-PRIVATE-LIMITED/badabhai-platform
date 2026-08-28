# R11 §1.1 — what a second `TRADE_RESUME_MAPS` entry costs, measured

> Report only. Nothing here is built, and a milling entry is explicitly out of R11's scope.
>
> **This document replaces an earlier estimate that was written from recollection.** Every figure
> below now carries the command that produced it. Where the earlier version's number was wrong,
> the correction is stated rather than overwritten — see the two boxes marked CORRECTION.

## The question, restated

`TRADE_RESUME_MAPS` has exactly one entry, `qp_cnc_turning`. The ratified sample is a **VMC
milling** sheet, so no real milling worker can be handed the document eleven packets have been
spent matching.

Q8 ratified one spine on the theory that **trade variation is a data change**. This is the audit of
whether that is true in practice, now that the first entry exists to measure.

---

## 1 · What was actually written

The whole turner track is two squash-merges, `24f976a2` (#1292) and `7f97b901` (#1294), on top of
`e87b5ede`.

```
git diff --numstat e87b5ede 7f97b901 | sort -k1 -rn
git diff --name-status e87b5ede 7f97b901 | grep -c '^A'   # 119 added
git diff --name-status e87b5ede 7f97b901 | grep -c '^M'   #  67 modified
```

**186 files, 23,597 insertions.** That headline number is misleading and should not be quoted:
**13,408 of those lines are one drizzle snapshot** (`migrations/meta/0094_snapshot.json`), which is
generated, and a further 2,095 are the journal. The engineering is much smaller than the diffstat.

### 1a · One-time infrastructure — a second trade reuses all of it

Measured with `wc -l`, and for `trade-resume-map.ts` with a comment/code classifier over the line
ranges reported by `grep -n '^export \|^const \|^};$'`.

| File                                                    | Lines | What it does                                                                                                                                                                                      |
| ------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resume/templates/bb_trade.v1.html`                     | 299   | The locked sheet. Shipped and **immutable** — a second trade may not touch it.                                                                                                                    |
| `resume/resume-renderer.service.ts`                     | +345  | Slot engine incl. nested object regions for `employments[] → roles[]`.                                                                                                                            |
| `resume/resume-render-input.ts`                         | +616  | The mapper. Both branches, audience switch, all Zone composition.                                                                                                                                 |
| `resume/resume-degradation.ts`                          | 495   | The ladder. Line budget, ranks, drop order, headroom model.                                                                                                                                       |
| `resume/resume-employment-rows.ts`                      | 315   | Zone 4 from `worker_employment`. Trade-independent by construction.                                                                                                                               |
| `resume/resume-sheet-rows.ts`                           | 326   | Verdict line, chip/tick/fact row builders, `formatSalaryBand`.                                                                                                                                    |
| `resume/resume-own-words.ts`                            | 169   | §8.4's quote block. Model proposes, transcript disposes.                                                                                                                                          |
| `resume/resume-preference-facts.ts`                     | 139   | The finishing form's seven trade-independent keys.                                                                                                                                                |
| `resume/resume-fresher-rows.ts`                         | 111   | Zone 4 for a worker with no employments. **Mostly** trade-independent — see 1b.                                                                                                                   |
| `resume/resume-qr.ts` + `resume-sheet-footer.ts`        | 148   | Footer, QR data-URI, ref code.                                                                                                                                                                    |
| `resume/resume-phone.ts`                                | 42    | `+91 98765 43210`.                                                                                                                                                                                |
| `common/pdf/font-resolution.ts`                         | 152   | Fail-closed font resolution.                                                                                                                                                                      |
| `profiles/worker-employment.*` + `worker-preferences.*` | 855   | The work-history + finishing-form APIs, schema and vocabulary.                                                                                                                                    |
| `packages/db` migration 0094 + `schema/employment.ts`   | 313   | `worker_employment`, `worker_employment_role`.                                                                                                                                                    |
| `trade-resume-map.ts` **minus** the turner entry        | 302   | Types, `CAPABILITY_ROW_BUDGET`, `MEASURING_TOOLS`, `buildTradeCapabilityRows`, `appendConfiguration`. **29 code lines of it are the types; 121 lines are the rank/cap/config contract in prose.** |

Plus ~4,900 lines of test and gate files that are keyed on nothing trade-specific: the degradation
matrix, the fabrication gate, the QR gate, the nested-region tests, the renderer tests.

**Three mechanisms in this list exist only because R10 built them, and a milling map is the thing
they were built for**: `TradeRowSpec.configFrom`/`configValues` (`VMC · 3-axis`), the Verdict
Line's axis segment with shared-suffix compression (`3 & 4-axis`), and `buildFresherRows`. Had
milling been attempted before R10, all three would have surfaced as code changes inside it.

### 1b · Trade-specific — milling needs each of these written fresh

| Where                                                                 | Lines | Measured how                                               |
| --------------------------------------------------------------------- | ----- | ---------------------------------------------------------- |
| `question-packs/packs/qp_cnc_turning.json`                            | 775   | `wc -l`; **18 items, 91 options** (parsed)                 |
| `trade-resume-map.ts` lines 157–349 — the turner entry                | 193   | **187 code, 6 comment**, classified                        |
| `resume-transcript-veto.ts` lines 126–178 `CAPABILITY_TERMS`          | 53    | the Hinglish gazetteer: 6 attributes, ~40 slug alias lists |
| `match/pack-attribute-skills.ts` lines 38–113 `PACK_ATTRIBUTE_SKILLS` | 76    | 57 code lines; 8 attributes → corpus skill ids             |
| `question-tts-text.ts` — two turner blocks                            | 50    | **33 Devanagari twins** (19 question, 14 why)              |
| `resume-fresher-rows.ts` `WORKSHOP_MACHINES` + `TRADE_TEST`           | 14    | machine and trade-test vocabulary                          |
| `scripts/persona-harness/personas.json`                               | 821   | 5 turner personas, **78 transcript turns**                 |
| `resume/__fixtures__/sheet-shapes.ts`                                 | 631   | 12 references to `qp_cnc_turning`                          |
| Golden records: `pack-served-text.json`, `reply-closure.json`         | ~580  | regenerated, not authored                                  |

> **CORRECTION to the earlier estimate.** It said "R10 added nine [TTS twins] for three fresher
> questions; a fifteen-question pack needs roughly forty-five." Measured, the turner pack's 18
> questions carry **33** twins, a ratio of 1.83 per question — so a 15-question milling pack needs
> about **28**, not 45. The earlier figure was an estimate presented as a count. The item is still
> the one most likely to be forgotten; it is just 40% smaller than I said.

---

## 2 · The answer to Q8 — one spine holds for the sheet, and does NOT hold for three dictionaries

**For the sheet itself, one-spine is true and measurably so.** The template is untouched, the
renderer is untouched, the ladder is untouched, the mapper reads `tradeResumeMapFor(packId)`, and
the section heading is data on the map. A milling entry adds a `TradeResumeMap` and changes no
rendering code. That is what the abstraction was built for and it delivers.

**But three trade-specific dictionaries live OUTSIDE `TRADE_RESUME_MAPS`, and they are pack-blind.**
This is the finding, and it is a measurement rather than a reading of the code's intent:

| Dictionary                                   | Keyed by       | Signature                                                         |
| -------------------------------------------- | -------------- | ----------------------------------------------------------------- |
| `TRADE_RESUME_MAPS`                          | **`pack_id`**  | `tradeResumeMapFor(packId)` — correct                             |
| `CAPABILITY_TERMS` (transcript veto)         | attribute name | `applyTranscriptVeto({ attributes, workerSaid })` — **no packId** |
| `PACK_ATTRIBUTE_SKILLS` (match reach)        | attribute name | keyed `attribute_key → option_key`                                |
| `WORKSHOP_MACHINES` / `TRADE_TEST` (fresher) | attribute name | `buildFresherRows(attributes)` — **no packId**                    |

`resume-transcript-veto.ts` states in its own docstring that it is "SCOPED TO THE CNC TURNING PACK".
It is not. Nothing in that module has ever seen a pack id. The scoping is an intention recorded in
prose, not a property the code has.

### The collision is already live, not hypothetical

Scanning all 143 packs for the turner's attribute keys:

```
python - <<'PY'   # full script in the R11 transcript
for each packs/*.json: collect question_key
PY
```

| Attribute         | Packs using it                                    | Shared option keys                     |
| ----------------- | ------------------------------------------------- | -------------------------------------- |
| `drawing_reading` | `qp_cnc_turning`, `qp_machining`, `qp_toolmaking` | none — **boolean** in the other two    |
| `measuring_tools` | `qp_cnc_turning`, `qp_machining`                  | `vernier`, `micrometer`                |
| `material_worked` | `qp_cnc_turning`, `qp_welding`                    | `mild_steel`, `stainless`, `aluminium` |

**What that does today, bounded honestly.** `drawing_reading` is `boolean` in the other two packs,
so `slugsOf` yields `[]` and the veto never reaches them — no harm. `material_worked` has no entry
in either behaviour dictionary — no harm. **`measuring_tools` does**: a `qp_machining` worker's
`vernier`/`micrometer` answers are mapped to match skills by a table authored for turners. That
mapping is probably right — a vernier is a vernier — but it is _unreviewed reuse_, and nobody
decided it.

**What it would do for milling.** A milling pack would naturally reuse `setting_operation`,
`programming_level`, `measuring_tools`, `material_worked`, `quality_work` and `troubleshooting` —
six of the turner's fourteen. Each silently inherits the turner's aliases and skill mappings. For
a miller most of that is close to right, which is precisely what makes it dangerous: it will work
well enough that nobody looks, and the one that is wrong will be a deleted true claim on a man's
résumé that no test asks about.

### So: is one-spine weaker than it was ratified as?

**Not for the reason Q8 was about, and yes for a reason Q8 did not consider.** Q8 asked whether the
_layout_ has to vary per trade. It does not; that ratification stands and nothing here reopens it.

What the first entry proved is a different thing: **the trade's vocabulary escaped the map.** Of
the roughly 2,600 trade-specific lines above, ~970 are properly pack-keyed (the pack JSON and the
map entry) and **143 are trade-specific behaviour sitting in modules that cannot tell one trade
from another** — 53 veto + 76 match + 14 fresher. That is 5% of the trade-specific volume and 100%
of its risk surface, because it is the only part that can be applied to the _wrong_ worker.

**Recommendation, for the record and not applied**: before a second entry, key those three
dictionaries by `pack_id` the way `TRADE_RESUME_MAPS` already is. It is a mechanical change
against one caller each, it is measurable (the collision table above is the test), and doing it
_after_ two trades exist means auditing which of six shared attribute names was intended.

---

## 3 · Milling, estimated against the ratified Yadav sheet

Because the sample IS a VMC sheet, this is a gap measurement rather than a guess.

**Already exists, no work:** `TRADE_CONTENT` in `resume/trade-content.ts` already carries
`vmc_operator`, `cnc_vmc_setter` and `vmc_programmer` entries (15 trade keys total, `grep -n
'trade_key:'`). The résumé bullet copy for milling is written.

**Work required:**

| Item                                           | Basis                                                 | Estimate                                     |
| ---------------------------------------------- | ----------------------------------------------------- | -------------------------------------------- |
| `qp_vmc_milling.json`, ~15 items               | turner's 18 items / 775 lines / 91 options            | ~640 lines, 1 day authoring                  |
| A `TRADE_RESUME_MAPS` entry                    | turner entry = 187 code lines                         | ~150 lines, half a day                       |
| `CAPABILITY_TERMS` milling gazetteer           | turner = 53 lines, 6 attributes                       | ~50 lines, half a day of shop-floor Hinglish |
| `PACK_ATTRIBUTE_SKILLS` milling rows           | turner = 57 code lines, 8 attributes                  | ~50 lines                                    |
| 28 Devanagari TTS twins                        | measured ratio 1.83/question × 15                     | half a day                                   |
| `profiling_family` + binding seed rows         | two JSONL lines                                       | minutes                                      |
| Golden-record regeneration                     | `UPDATE_PACK_SERVED_TEXT=1`, `UPDATE_REPLY_CLOSURE=1` | mechanical                                   |
| A practising-miller review of all of the above | the turner's is still an open redline (Q2)            | **the long pole**                            |

**Three to four days of authoring and review, plus one review this project has not yet completed
once.** No renderer change, no template change, no contract change (capability answers are
`worker_attributes`, outside the frozen contract), no ask-budget change.

**The one risk that is not on the list.** `CAPABILITY_ROW_BUDGET` is 9 and it is global. A milling
pack that defines more than nine rows hits the same forced choice the turner has, and the turner's
version of that choice is the open **Q2** redline. A second trade does not create the problem; it
doubles the surface on which an unresolved ruling is applied silently, because the budget drops by
rank with no per-trade override.

---

## 4 · The estimate against the actual (R13 §3.1, measured 2026-08-28)

§3.1 built the pack and the map entry. This section is the audit of the estimate above; where a
figure was wrong the correction is stated, not overwritten.

| item                         | estimated  | actual                        | source                                                                  |
| ---------------------------- | ---------- | ----------------------------- | ----------------------------------------------------------------------- |
| `qp_vmc_milling.json`        | ~640 lines | **520**, 18 items, 89 options | `wc -l`, parsed                                                         |
| `TRADE_RESUME_MAPS` entry    | ~150 lines | **13 rows**                   | the entry                                                               |
| Devanagari TTS twins         | ~28        | **35 clips, 22 to author**    | `question-tts-text.test.ts`; 13 clarifies compose from their halves     |
| Renderer / template / ladder | none       | **none**                      | `git diff --name-only`                                                  |
| Contract change              | none       | **none**                      | capability answers are `worker_attributes`, outside the frozen contract |

**The twin figure was wrong in both directions and the second one matters.** 35 clips is more than
28, but 13 of them are composed rather than authored, and **seven prompts needed no twin at all**
because their Hinglish is byte-identical to the turner's ("Kya aap drawing padh lete hain?",
"Trade test diya hai?", and five more). A shared question vocabulary pays a dividend the estimate
did not model.

### What §2 predicted, and what actually happened

§2 above recommended keying the three pack-blind dictionaries by `pack_id` **before** a second
entry, on the argument that doing it afterwards means auditing which shared attribute name was
intended. R12 §2 did that. The measurement now available:

| dictionary                | colliding keys before milling | after                                                                                    |
| ------------------------- | ----------------------------: | ---------------------------------------------------------------------------------------- |
| `CAPABILITY_TERMS` (veto) |         1 (`drawing_reading`) | **5** — adds `setting_operation`, `programming_level`, `quality_work`, `troubleshooting` |
| `PACK_ATTRIBUTE_SKILLS`   |                             2 | **6** — adds `controller_brand`, `setting_operation`, `programming_level`, `workholding` |

Nothing broke, and that is the whole point: written in the other order, a miller's setting,
programming, quality and troubleshooting answers would have been read through a turner's gazetteer
and no test would have said so. **The 143 lines §2 called "5% of the trade-specific volume and
100% of its risk surface" now govern five times as many keys as when they were scoped.**

### The one thing the estimate did not anticipate

`MEASURING_TOOLS` was a shared constant documented as _"shared by every machining-family pack: the
instruments do not change by role"_. The ratified milling sheet prints a **snap gauge** and the
turner's dictionary carries a **plug / ring gauge**; a plug gauge checks a bore a turner just
bored. The constant is now `TURNING_MEASURING_TOOLS` and milling authors its own. This is evidence
for [Q14](../../NEEDS_PRAKASH.md) and it is recorded there rather than acted on.
