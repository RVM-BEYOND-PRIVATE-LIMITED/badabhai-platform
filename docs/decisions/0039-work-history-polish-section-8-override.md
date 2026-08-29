# ADR-0039: §8's "no fourth source" is overridden for work-history descriptions

- **Status:** Accepted (owner ruling, 2026-08-29) — see issue **#1350**
- **Date:** 2026-08-29
- **Supersedes/relates:** carves a **named exception** out of **§8** of the Resume Engine
  guideline, which every other printed string on the sheet still obeys. Touches
  `resume-fabrication.gate.test.ts` (the executable form of §8), adds
  `worker_employment_role.work_done_polished` (migration `0096`), a new AI task
  `work_history_polish`, and the flag `WORK_HISTORY_POLISH_ENABLED`. New residual risk **R-§8**.

## Context

§8 of the Resume Engine guideline governs every printed string on a BadaBhai resume:

> The model extracts, normalises and classifies. **It never composes.** Every printed string on a
> BadaBhai resume originates from one of exactly three sources: a closed vocabulary label, a
> number the worker stated, or the worker's own words rendered verbatim. **THERE IS NO FOURTH
> SOURCE.**

That rule is not documentation. It is an executable gate — `resume-fabrication.gate.test.ts` —
which splits every string the mapper contributes into atoms and requires each to resolve to a
reviewed label, a deterministic phrase, or a **substring** of something the worker supplied. The
containment is one-directional, deliberately: _"Reversed, 'Highly skilled CNC turning' would pass
because it contains 'CNC turning', which is exactly the fabrication this gate exists to catch."_

The stake the gate names: _"at the machine trial the fabrication is discovered and the employer
stops trusting BadaBhai, not the worker."_

Work-history descriptions are captured as free text the worker types, usually in Hinglish
("lathe pe shaft banata tha, EN8 material"), and printed verbatim. The owner's judgement is that a
resume reading in Hinglish costs the worker more, with the employers this product is built for,
than the fabrication risk costs. That judgement is the decision recorded here.

## Decision

**The model may rephrase work-history descriptions into professional English. §8 is overridden
for that field and for no other.**

Raised twice with the cost stated, and reaffirmed. #1350 is the written ruling.

## What changed

1. **`worker_employment_role.work_done_polished`** (migration `0096`, additive, nullable).
   `work_done` is **never overwritten** — the worker's own words remain the system of record, the
   fallback whenever the polish is null, and what makes this reversible by changing which column
   the renderer reads.
2. **`POST /profiling/work-history/polish`** on the ai-service, prompt
   `worker-work-history-polish`, task `work_history_polish`.
3. **The fabrication gate is widened by one named field**, not relaxed. Every other atom on the
   sheet is unchanged and still has to satisfy the original three-source rule.
4. **Two independent locks, both off by default:** `WORK_HISTORY_POLISH_ENABLED` (the API side)
   and `AI_REAL_CALL_TASKS` (the ai-service's existing fail-closed allowlist). Turning either off
   is a config change, not a deploy — a reversal that needs a deploy is not a reversal.

   **`WORK_HISTORY_POLISH_ENABLED` is read in TWO places, and the second one is the one that makes
   the sentence above true.** As first shipped it gated only the polisher, which stops new rewrites
   while every row that had already been polished kept printing model-composed text — reverting
   would have meant a data migration to `NULL` the column, or a deploy. Since #1350's completion the
   **renderer** reads it as well (`workLine` in `resume-employment-rows.ts`, threaded through
   `TradeSheetContext.polishEnabled`), so flipping the flag false makes the next render of every
   resume print the worker's own words. The polished column is retained, so flipping it back on
   restores the rewrites with no second model call. Absent means off, in both readers.

## What replaced the guarantee

The gate proved a property about bytes. What replaces it are checks on a model, and they are
weaker. Stated plainly so nobody mistakes the mitigation for the guarantee:

| Was                                                      | Is now                                                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Printed atom must be a substring of worker-supplied text | Prompt written as **prohibitions** — no skill levels, no numbers, no machines/materials/processes not in the input, no praise                                                                     |
| —                                                        | **Digit grounding**: every digit run in the rewrite must occur in the worker's sentence. Re-implements the gate's own digit rule, because invented tolerances are the fabrication that costs most |
| —                                                        | **Length cap** (300, the column and the one-line budget)                                                                                                                                          |
| Input-side pseudonymize only                             | **Re-certification of the composed output** — composed text is not covered by the input gate, and a model can put a name into a sentence that had none                                            |
| —                                                        | Model may **return null**, and does so freely; null prints the worker's own words                                                                                                                 |

## Where it runs, and why not at capture

On the **render**, not on the worker's form submit. Capture is a request path on a phone, often on
2G; the render is already a queue job that already loads the employments. One model call per stint
ever, because the result is written back and only null-polish stints are visited — so a re-render
of an unchanged history spends nothing, while an edited description arrives as a fresh row and is
re-polished for free.

Nothing on this path throws into the render. A resume that fails to render is strictly worse than
one that renders in Hinglish.

## Privacy

The route receives **the description and the role title only**. Not the worker's name, not the
employer, not the city or state, not the dates — all of those are rendered deterministically in
the API and never leave it. The input is pseudonymized before the model and the output is
re-certified after it. `worker_ref` is the worker id, which is what the service already bills and
traces against.

## Residual risk R-§8

A polished description is a claim the worker did not make in those words. The checks above narrow
the space of bad rewrites; they do not close it, and no test can assert the absence of a plausible
sentence. If a fabrication reaches a machine trial, the mitigations are: the raw text is retained
for the dispute, and either lock turns the feature off for every worker without a deploy.

## Alternatives considered

- **Print verbatim (status quo).** §8-compliant, zero risk, and the sheet reads in Hinglish.
  Rejected by the owner.
- **Subsequence-constrained cleanup** — model may only fix casing/spelling and delete filler,
  enforced by checking the output is a subsequence of the input. Keeps a mechanical proof and
  would not have needed this ADR, but it cannot turn Hinglish into English, which was the point.
- **Polish for matching only, never printed.** §8 governs what is _printed_, so this respects it
  entirely — and gains nothing on the artifact the owner is trying to improve.
