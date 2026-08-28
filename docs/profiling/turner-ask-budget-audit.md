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

---

# R6 §5 — the cap, raised and instrumented

**Applied**, unlike everything above it: R6 §5 ruled the cap lifted. The revised ask LIST above
is still a proposal and is still unapplied.

## The new number, derived rather than picked

`MAX_ENGINE_ASKS` **24 → 28**. Not a round number — the terms are:

| term                               | value  | where it comes from                                                       |
| ---------------------------------- | ------ | ------------------------------------------------------------------------- |
| largest occupation pack            | **15** | `qp_cnc_turning`; every other pack in the corpus is 6                     |
| universal tail                     | **8**  | `qp_universal@2`                                                          |
| one retry per MANDATORY question   | **3**  | `turning_experience`, `primary_trade`, `current_city` — all `max_asks: 2` |
| **what the corpus needs today**    | **26** |                                                                           |
| reserved for the two proposed asks | **2**  | the Zone 5 credential pair in `sample-parity-gap.md`                      |
| **cap**                            | **28** |                                                                           |

**The old cap of 24 could not serve 26.** That is the R5 finding restated with a number on it:
the margin was already spent by detection rather than by pack size, and a senior turner needing
one re-ask on each mandatory answer was over budget before anything was added. What the overflow
deletes is the TAIL — `shift_preference` — not the question that caused it.

## The guard that was missing

`apps/api/src/profiling/ask-budget.guard.test.ts`. The strongest assertion that existed
(`asked.length <= MAX_ENGINE_ASKS`) is **vacuous**: the engine enforces that bound by
construction, so it can never fail. A pack author got no signal until a real interview closed
early in production.

Four assertions, and the second is the authoring signal:

- the cap can serve the largest pack, retries included — the **floor**;
- the worst case is pinned at **26 exactly**, so any pack that grows or shrinks turns it red and
  has to be updated deliberately, in the same commit;
- headroom is held **≤ 2**, because an inflated cap is not free;
- no pack exceeds the cap, not merely the largest one.

## The measurement that decides the real ceiling

The binding constraint on interview length was never cost — R5 priced a full interview at ₹0.23
shipped and ₹1.99 worst-case against a ₹4 target — and it is not tokens. It is **abandonment**.

`profile.interview_completed` already carried `ask_count`, so completion-by-ask-index was
computable for the workers who **finished** — the half that cannot tell you where people leave.
`chat.session_abandoned` now carries **`engine_asks`** as well, which is the numerator. It is
nullable and null is a real state: the sweep may run after the Redis buffer expired, and writing
`0` there would invent a drop-off spike at index zero in the one number this exists to make
honest.

With both halves on the spine, the ceiling is a curve someone can read rather than a number
anyone can argue. If drop-off spikes at ask 28, that is the answer.

## What §4 removed from this problem

`documents_ready` was the R5 proposal's strongest addition (+7 §9.1 points). It is no longer an
ask at all — it went to the finishing form with languages, job type, shift, preferred cities,
relocation and accommodation, which is seven closed-set answers recovered for **zero** engine
asks. The interview's budget is now spent only on what needs language.
