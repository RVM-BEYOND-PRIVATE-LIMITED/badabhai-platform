# The CNC-turner ask budget — audit and proposal

**R5 §1.4. A proposal. Nothing here is applied** — the revised list goes to Prakash and RVM.

Measured, not recalled: the ask sequences below come from driving the real `nextQuestion` engine
over the shipped packs (`apps/api/src/profiling/interview-cost.report.test.ts`).

## What the budget actually is

|                         |                                                         |
| ----------------------- | ------------------------------------------------------- |
| `MAX_ENGINE_ASKS`       | **24** (`apps/api/src/profiling/next-question.ts:54`)   |
| `qp_universal@2`        | **8**, all unconditional                                |
| `qp_cnc_turning`        | **15** items, of which a senior worker is served all 15 |
| Senior turner, measured | **23 asks** — 15 turning + 8 universal                  |
| **Spare**               | **1**                                                   |

Junior (band 0) is asked 16; band 2 unlocks tier 1 (19); bands 5 and 10 unlock tier 2 (23).

Two things follow that a headline "16 asks" hides:

- **The budget is a HARD CLOSE, not a degradation.** At 24 the engine ends the interview with
  `completionReason: "ask_budget"` (`next-question.ts:313`) — it does not skip a pack or shorten
  one. The occupation pack drains first, so the question actually lost is the LAST universal one,
  `shift_preference`. A trade question crowds out a universal one, never the reverse.
- **The margin is already spent by detection, not by pack size.** A senior worker with one
  mandatory universal answer the engine failed to detect hits 24 exactly. With two, he loses
  `shift_preference` outright. Anything added lands on top of that, not on a spare 8.

## Each ask, against §5.1 decisiveness and the §9.1 weights

§5.1 ranks how decisive an element is for the ₹40 unlock; §9.1 weights what a complete profile is
worth. They are different questions and an ask can score well on one and badly on the other.

| #   | ask                                                                                                                                                   | captures                     | §5.1    | §9.1 weight it feeds              | verdict                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------- | --------------------------------- | ----------------------------------------------------------------------- |
| 0   | `turning_experience`                                                                                                                                  | the depth gate + total years | 3       | duration (15)                     | **keep** — one ask that decides eleven others                           |
| 1   | `turning_machine`                                                                                                                                     | lathe types                  | **2**   | machines/controllers (15)         | **keep** — the highest-value ask in the pack                            |
| 2   | `controller_brand`                                                                                                                                    | Fanuc/Siemens/…              | **2**   | machines/controllers (15)         | **keep** — literal advertisement vocabulary                             |
| 3   | `turning_operation`                                                                                                                                   | facing, boring, threading…   | 4       | skill tags (20)                   | **keep**                                                                |
| 4   | `workholding`                                                                                                                                         | chuck, collet, steady rest   | 5       | capability detail (15)            | keep                                                                    |
| 5   | `material_worked`                                                                                                                                     | MS, EN8, SS, aluminium       | 5       | —                                 | **weak** — display-only, feeds no weight                                |
| 6   | `measuring_tools`                                                                                                                                     | vernier, micrometer…         | 5       | capability detail (15)            | keep                                                                    |
| 7   | `drawing_reading`                                                                                                                                     | none / 2D / GD&T             | 4       | capability detail (15)            | keep                                                                    |
| 8   | `setting_operation`                                                                                                                                   | offsets, jaw change          | 4       | capability detail (15)            | keep                                                                    |
| 9   | `tolerance_band`                                                                                                                                      | ±0.01…±0.1                   | 4       | —                                 | keep — a strong pay signal (Q2 names it)                                |
| 10  | `sector_worked`                                                                                                                                       | automotive, oil & gas        | —       | —                                 | **drop candidate** — §4.3 locks it display-only, never a matching input |
| 11  | `programming_level`                                                                                                                                   | offset / edit / write / CAM  | 3       | capability detail (15)            | **keep** — the only ask that reaches a second vacancy type              |
| 12  | `advanced_capability`                                                                                                                                 | live tooling, bar feeder     | 4       | —                                 | keep — pay signal, no corpus ids yet                                    |
| 13  | `quality_work`                                                                                                                                        | first-piece, SPC             | 6       | —                                 | **weak** — maps to nothing by design (§5.3)                             |
| 14  | `troubleshooting`                                                                                                                                     | chatter, tool wear           | 6       | —                                 | **weak** — no corpus id, no weight                                      |
| U   | `primary_trade` · `current_city` · `experience_years` · `salary_expected` · `preferred_locations` · `availability` · `education` · `shift_preference` |                              | 1, 6, 7 | availability+salary (10), ITI (8) | all keep — three of the four rejection filters live here                |

## The gaps — attributes with no ask

| missing                             | §9.1 weight stranded | notes                                                                                                                                                                 |
| ----------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **employer + dates**                | **10**               | No ask anywhere. Ruled to a form, not the pack (R4 Q1) — a multi-employer loop needs ~6 keys each and there is 1 spare. **Now built** (`PUT /workers/me/employment`). |
| **certificates** (NCVT/NSQF detail) | part of ITI (8)      | `certifications` is carried by the crosswalk but **no pack in the 143-pack corpus asks for it**. `education` gives the level only.                                    |
| **documents ready**                 | **7**                | No ask anywhere in the corpus. The résumé renders the row; nothing fills it.                                                                                          |
| **languages**                       | —                    | No ask, and `crosswalk.ts` records `draftPath: null` — no column either.                                                                                              |

**Roughly 15 of the 100 §9.1 points are unreachable by any question that exists**, and two of the
three (`documents ready`, `certificates`) are Zone 5 rows the locked sheet prints.

## Proposed revised list — NOT applied

Net zero asks, so it does not touch the budget:

|        | change                                                                                                        | why                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **−1** | drop `sector_worked`                                                                                          | §4.3 locks it as display-only and never a matching input. It is the only ask that scores nothing on either scale.   |
| **−1** | drop `troubleshooting`                                                                                        | Six symptoms with no corpus id, no §9.1 weight, and §5.1 rank 6. The weakest surviving ask.                         |
| **+1** | add `documents_ready` (multi_select: Aadhaar, PAN, bank, UAN/PF, ITI certificate, experience letter)          | Recovers **7 points**, fills a row the sheet already prints, and is the single most-scanned item at a factory gate. |
| **+1** | add `certificate_detail` (multi_select: NCVT, NSQF, apprenticeship, none), gated on `education = iti_diploma` | Recovers the rest of the ITI weight and de-vacuates the R4 credential floor for the workers it was built for.       |

Two second-order notes on the same page, neither proposed:

- `material_worked` and `quality_work` are the next two weakest and would fund two more asks. They
  are left because both are real trade vocabulary a supervisor recognises, and cutting four asks
  from a fifteen-ask pack on a scoring argument is exactly the kind of change that wants RVM's
  eye rather than mine.
- The 1-ask margin is the real fragility, not the mix. **Nothing guards it at authoring time** —
  `question-pack-corpus.ts` has no budget check, and the strongest existing assertion
  (`asked.length <= MAX_ENGINE_ASKS`) is vacuous because the engine enforces that bound by
  construction. A pack author gets no signal until a senior worker's interview closes early in
  production.
