# The seniority ladder — five synthetic turners, run end to end

**R7 §3–§5.** Five invented CNC-turner personas, from a fresh ITI pass-out to twelve years with no
credential, put through the real extraction against a live model and rendered to real PDFs.

Everything below is **measured**. The extraction is a real `gemini-2.5-flash` call per persona
(₹0.60 total, artifacts in `scripts/persona-harness/out/*.extract.json`, each carrying `is_mock`
and the model that answered); the sheets come from the shipped `buildResumeRenderInput` and
`bb_trade.v1`; the page counts come from WeasyPrint.

## What the run cost, and on which model

|                                |                                                     |
| ------------------------------ | --------------------------------------------------- |
| Extraction, 5 personas         | **₹0.60** total — ₹0.053 (p1) to ₹0.21 (p4)         |
| Anchoring experiment, 26 calls | **₹0.28**                                           |
| **Total for the whole packet** | **≈ ₹0.9**                                          |
| Extraction model               | `gemini-2.5-flash` — real, every persona            |
| Chat-turn model                | **`gemini-2.5-pro` is RETIRED and 404s.** See below |

**`gemini-2.5-pro` is no longer reachable.** The provider answers
`404 — "This model models/gemini-2.5-pro is no longer available to new users. Please update your
code to use models/gemini-3.1-pro-preview"`. Every chat turn therefore fails twice on Gemini and
falls through to the Anthropic cross-provider fallback, `claude-haiku-4-5`, which works. Nothing
errors, so this is invisible in production: `#1237` raised the chat tier to Pro precisely because
"this is the model a worker actually meets", and that model has been unreachable ever since.
`gemini-2.5-flash` and `gemini-2.5-flash-lite` both answer 200, so extraction is unaffected.
Re-tiering is not mine to do; this is reported, not fixed.

## The blocker that had to be cleared first

**Two of the five personas extracted nothing at all**, and the cause was one field.

The model returned `"work_done": null` on one employment. `ExperienceEntry.work_done` was a
required `str` whose `default("")` only ever filled `undefined`, and because `experiences` is the
one list-of-objects in the contract, that single null failed the whole `model_validate` — so p3
lost 22 skills, 2 employments, his city, his salary and his availability, and p5 lost 24 skills
and 3 employments. Silently: the handler returns `is_mock=true`, which every downstream reader
takes to mean _no interview happened_.

Fixed in `1bb6b450` (null coerced to `""`, both sides of the contract; plus an entry-tolerant
retry so the next quirk costs one job rather than the profile). After it, all five extract.

## The gap table — each persona against the Ramesh sample

|                                        | p1 fresh ITI          | p2 2-yr operator                      | p3 5-yr → setter          | p4 8-yr setter                            | p5 12-yr no ITI              |
| -------------------------------------- | --------------------- | ------------------------------------- | ------------------------- | ----------------------------------------- | ---------------------------- |
| **Pages**                              | 1                     | 1                                     | 1                         | **2 — contract broken**                   | 1                            |
| Content height (of ~273 mm)            | 136 mm                | 158 mm                                | 212 mm                    | **312 mm**                                | 222 mm                       |
| Degradation stage                      | 0                     | 0                                     | 0                         | **0 — never fired**                       | 0                            |
| Role + function                        | Turner                | CNC Lathe Operator                    | CNC Operator              | CNC Setter cum Operator                   | CNC Machinist                |
| **Years in headline**                  | "duration not stated" | **"duration not stated"** (he said 2) | **1 yr 8 mo** (he said 5) | **5 yrs 4 mo** (he said 8)                | **9 yrs 11 mo** (he said 12) |
| City in verdict line                   | **absent**            | Rajkot                                | Pune                      | Faridabad                                 | **absent**                   |
| Controllers                            | —                     | Fanuc                                 | Fanuc, Siemens            | Fanuc, Siemens, Mitsubishi                | Fanuc, Haas                  |
| Capability rows rendered               | 6                     | 7                                     | 8                         | **9 (capped)**                            | 9 (capped)                   |
| Tolerance held                         | n/a                   | n/a (not asked)                       | **dropped by cap**        | **dropped by cap**                        | **dropped by cap**           |
| Sector worked                          | n/a                   | n/a                                   | **dropped**               | **dropped**                               | **dropped**                  |
| Work history                           | none (correct)        | 1 employer                            | 2 employers               | 3 employers                               | 3 employers                  |
| Promotion rendered                     | n/a                   | n/a                                   | n/a                       | **no — capture is one role per employer** | n/a                          |
| Education                              | ITI ya diploma        | ITI ya diploma                        | ITI ya diploma            | ITI ya diploma                            | Dasvi paas                   |
| ITI trade / council / year / institute | **absent**            | **absent**                            | **absent**                | **absent**                                | n/a                          |
| Certificates                           | **absent**            | **absent**                            | **absent**                | **absent**                                | **absent**                   |
| Languages                              | **absent**            | **absent**                            | **absent**                | **absent**                                | **absent**                   |
| Documents ready                        | **absent**            | **absent**                            | **absent**                | **absent**                                | **absent**                   |
| **Own words block**                    | **absent**            | **absent**                            | **absent**                | **absent**                                | **absent**                   |

### The four findings that are new here

**1 · Total years is wrong on every persona who has any.** The headline reads
`totalYearsFrom(rp.experiences)` — it sums the model's per-employment `duration_months`. The model
fills that field inconsistently, so a 5-year man prints "1 yr 8 mo" and an 8-year man prints
"5 yrs 4 mo". Meanwhile `experience_years` is a **mandatory universal ask** with the right answer
in it, and the container branch never looks at it. §5.1 ranks total years third; a sheet that
understates a senior man by three years is worse than one that omits it.

**2 · The one-page contract fails for the senior worker, and the ladder does not notice.** p4 is
312 mm of content in a 273 mm page and `degradationStage` is **0** — the line estimator in
`resume-degradation.ts` believes it fits. The budgets were fitted to the three ratified samples;
p4 exceeds them and nothing reports it. This is the persona §4 predicted would hit the ladder, and
the ladder was never reached.

**3 · The capability cap drops tolerance for everyone senior.** `CAPABILITY_ROW_BUDGET` is 9, and
p3/p4/p5 all produce more, so the tail goes: tolerance held, sector, quality, troubleshooting.
±0.01 mm is the strongest pay signal a turner has and it is not on his sheet.

**4 · The city is missing from two verdict lines.** p1 and p5 never state their city in so many
words, so the model returns `current_city: null` — and the chips, which carry it, are not consulted
on that branch. Distance is one of the four filters that reject a candidate outright.

## §4 — what must differ between persona 2 and persona 4

### Branch early on function and years — the proposal

Both facts are already asked and the pack ignores both. `turning_experience` is ask 0; a
`function` ask does not exist. **Proposal, not applied:**

|                           |                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ask 0**                 | `turning_experience` — unchanged, already the depth gate                                                                                                    |
| **Ask 1 (new)**           | `turning_function` — single-select: _"Machine chalate hain, ya set bhi karte hain?"_ → `operator` / `operator_setting_seekh_raha` / `setter` / `programmer` |
| **Everything downstream** | gated on `(function, years)` rather than on years alone                                                                                                     |

Years alone cannot separate a 6-year operator from a 6-year setter, and the pack currently gives
them the identical 15 questions. Asking function costs one ask and it is the axis §3.2 of the
guideline calls "the real seniority axis, not years".

### For persona 2 — skip and reallocate

Skipped when `function = operator AND years < 3`: canned cycles, CAM, programming beyond "reads",
5-axis, twin/sub-spindle, tolerance finer than ±0.05, surface finish Ra, steady rest, soft-jaw
boring. On the shipped pack that is **`programming_level`, `advanced_capability`, `tolerance_band`
and part of `setting_operation` / `workholding` — 4 whole asks plus two narrowed grids.**

Spent on what is actually his signal:

| new ask                                                    | why                                                            |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| `iti_trade` (Turner / Fitter / Machinist / Diesel / other) | on the ratified sheet; no pack in 143 asks it                  |
| `iti_council` (NCVT / SCVT / apprenticeship / none)        | the credential IS the junior's signal — §5.1 rank 8            |
| `iti_year` + `iti_institute`                               | completes the Zone 5 row the sample prints                     |
| `measuring_tools` **widened**                              | instruments are cheap to state and disproportionately credible |

This is the same reasoning as the R4 credential-floor rider and the Pehla Kaam ordering: for a man
with two years, the ITI line is the strongest thing on his page, and it is the one thing we do not
ask for.

### For persona 4 — add rather than skip

`canned_cycle` detail (G71/G76/G74), `surface_finish` (Ra), per-employment capability anchoring,
and the promotion probe. **His sheet already overflows**, so every addition has to come with
finding 2 above fixed first — otherwise more capture produces more page 2.

### The ask-budget rule — proposal

The cap should scale with seniority rather than sit at a fixed 28:

```
budget = 16 + tier_bonus(function, years)
         tier_bonus = 0   operator, < 3 yrs      →  16   (p2 finishes well under)
                      4   operator, 3–7 yrs      →  20
                      8   setter or 7+ yrs       →  24
                      12  programmer / 10+ yrs   →  28   (p4 may run over)
```

A junior finishing in 16 asks is not a degraded interview — it is the correct one, because the
questions he is being spared are the ones that invite a false claim. The ceiling stays 28 so the
authoring guard in `ask-budget.guard.test.ts` still bounds the worst case.

**And the ceiling is an abandonment question, not a token one.** `chat.session_abandoned` now
carries `engine_asks` (R6 §5), so the real answer is a drop-off curve nobody has yet read.

### The junior's sparse page, and the block that would fill it

p2's sheet is **158 mm of a 273 mm page**. The verbatim "in the worker's own words" block from the
Sunil sample is exactly what would fill it — and it fires for **nobody**.

The slot exists on `ResumeRenderInput` and the template renders it. `TradeSheetContext` has no
field for it, and no mapper sets it. So the mechanism that makes off-wedge trades work on day one
— below-floor phrases still printing as the worker's own words — is not wired to the sheet at all.
For p2 the material is right there: the extraction returned his `work_done` in his own Hinglish
("Programme load karke part banata hoon…"), and it is being thrown away.

**This is the single cheapest win on the junior's page** and it is a mapper change, not a capture
change.

## §5 — the chip over-claim hazard, and what the anchoring experiment showed

### The hazard is real and measurable

Persona 2's transcript says, in his own words, _"khud se setting nahi karta"_ — I do not do setting
myself. Asked to select from the capability grid on his behalf, the model ticked
**`setting_operation | Tool offset`, 5 runs out of 5.** It also ticked `First-piece check`,
`In-process checking` and `Boring`, none of which appear anywhere in his words.

**Four of eight claims contradict or exceed his own account, deterministically.** The R5 asymmetry
property test cannot see any of it, because every tick is a literal claim.

### Anchoring to an employer changed nothing

| arm                                                 | claims per run |
| --------------------------------------------------- | -------------- |
| p2 unanchored, "which of these can you do"          | 8, 8, 8, 8, 8  |
| p2 anchored, "which did you do at Shakti Precision" | 8, 8, 8, 8, 8  |
| p2, both arms, with over-claim pressure added       | 8 vs 8         |
| p4 (three employers), both arms                     | 18 vs 18       |

**Zero chips differed in any arm.** I checked the obvious explanation — that a one-employer worker
cannot be constrained by an employer anchor — by running p4, who has three. Same result.

### What I would do instead, and the limit of this evidence

**The honest limit first:** a model reading a transcript is not a worker with an incentive. I added
an explicit over-claim pressure to the simulated worker to correct for that and it moved nothing,
which strengthens the negative but does not make it a measurement of human behaviour. Only a real
worker in front of a real grid settles that.

**But the experiment did surface the fix that would work.** The over-claims are all
_contradicted by text we already hold_. So the constraint that bites is not a re-phrased question —
it is a **cross-check**: refuse, or down-rank, a capability chip that the worker's own transcript
contradicts. `setting_operation: tool_offset` against _"khud se setting nahi karta"_ is a
mechanical catch, and it is exactly the asymmetry rule §8.3 already states, applied to the surface
that currently bypasses it.

That is a bigger change than re-framing a question, and it is a proposal rather than a build.

## How to reproduce

```bash
# 1. real extraction (needs a provider key; costs ~₹0.60)
cd apps/ai-service && AI_SYNTHETIC_PERSONA_MODE="R7 persona harness" SKILL_CANONICALIZE_ENABLED=false \
  ./.venv/Scripts/python.exe ../../scripts/persona-harness/extract_personas.py
# 2. the sheets
RUN_PERSONA_SHEETS=1 pnpm --filter @badabhai/api run test persona-sheets
# 3. the PDFs
docker run --rm -v "$PWD/scripts/persona-harness/out:/w" -w /w bb-weasy:local \
  sh -c 'for f in *.html; do weasyprint "$f" "${f%.html}.pdf"; done'
# 4. the anchoring experiment
./.venv/Scripts/python.exe ../../scripts/persona-harness/anchoring_experiment.py --runs 5 --incentive
```
