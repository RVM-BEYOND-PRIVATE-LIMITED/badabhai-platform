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

5. **The override reached a SECOND column, and a second kind of worker.** A fresher has no
   employment at all: his Zone 4 is his ITI training, and its one worker-written segment
   (`iti_project_work`) printed exactly as typed — "kuch nhi banaya, bas knowledge he mujhe" on
   the sheet an employer reads. `worker_attributes.value_text_polished` (migration `0102`,
   additive, nullable) is `work_done_polished` for an answer, on the same terms: a second column
   beside the answer and never a second `attribute_key`, because this table is the record of what
   the worker ANSWERED and the matcher reads it. Owner report, 2026-09-09. **Text answers only**, by
   CHECK — a slug is closed vocabulary and sending one to a model would be the §8 violation this
   whole column is scoped to avoid.

6. **THE WORKER CAN REFUSE, and that is the mitigation this ADR was missing.** The locks in (4) are
   OURS and revert every rewrite at once; a refusal is HIS and reverts exactly the sentence he
   objects to. Two flags, two routes, one rule:

   | Path | Column | Route |
   | --- | --- | --- |
   | An employment (#1354) | `worker_employment_role.work_done_polish_declined` (`0097`) | `PUT /workers/me/employment/:employmentId/description-source` |
   | A free-text answer (#1485) | `worker_attributes.value_text_polished_declined` (`0103`) | `PUT /workers/me/answers/:attributeKey/text-source` |

   **A FLAG AND NOT A CLEARED COLUMN**, on both paths. Expressing a refusal by NULLing the polish is
   indistinguishable from "not polished yet" — precisely the state the polisher reads as work to do —
   so the next render would silently rewrite the sentence the worker had just refused, and nothing
   would report it. Keeping the rewrite also means changing his mind costs no second model call.

   **READ AT BOTH ENDS, exactly as the kill switch in (4) is, and for the same reason.** The polisher
   skips a refused row (`WorkHistoryPolishService.polish`'s filter; the fresher gate in
   `resume-render.processor.ts`) and the RENDERER refuses to print a stored rewrite
   (`workLine` in `resume-employment-rows.ts`; `buildFresherRows` in
   `resume-fresher-rows.ts`). Gating only the polisher would leave every already-polished row
   printing model-composed text forever.

   **THE CLIENT IS GIVEN BOTH LINES AND AN ADDRESS, never a line to take apart.** The sheet sends
   `work_own_words` — the SAME line composed through the SAME joiner in the same pass — plus the
   identifier the refusal names (`ResumeEmployment.id`; `ResumeExperienceLine.own_words_key`).
   Two independently-composed strings differ in ways the rewrite did not cause, and the fresher block
   is a ` · `-joined composite whose machines carry that same separator, so a client guessing
   which span changed would be manufacturing exactly the plausible-but-false sentence this mitigation
   exists to surface (#1476, #1485).

   **A REFUSAL SURVIVES A RE-ANSWER OF THE SAME TEXT, and only that.** Both write paths carry the flag
   across a rewrite of the row, keyed on the TEXT: a refusal is about a SENTENCE, so an edited answer
   arrives un-refused and is re-polished for free, while re-submitting an unchanged answer must not
   quietly revoke his decision.

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
for the dispute, either lock turns the feature off for every worker without a deploy, and — since
#1354 and #1485 — **the worker himself can refuse the sentence**, per employment or per answer, and
see what it was rewritten from before he decides.

That third one is the only mitigation on this list that can act on ONE bad rewrite rather than all of
them, and it is the only one held by the person who actually knows. It is also the weakest to rely on
and must not be read as closing the risk: it requires him to open his resume, read a sentence in a
language he may not read well, and recognise a claim about his own work as false. What it changes is
that the platform is no longer the only party able to act.

## Alternatives considered

- **Print verbatim (status quo).** §8-compliant, zero risk, and the sheet reads in Hinglish.
  Rejected by the owner.
- **Subsequence-constrained cleanup** — model may only fix casing/spelling and delete filler,
  enforced by checking the output is a subsequence of the input. Keeps a mechanical proof and
  would not have needed this ADR, but it cannot turn Hinglish into English, which was the point.
- **Polish for matching only, never printed.** §8 governs what is _printed_, so this respects it
  entirely — and gains nothing on the artifact the owner is trying to improve.
