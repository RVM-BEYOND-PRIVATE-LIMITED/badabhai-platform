# AGENT_LOOP

> **This file was CREATED, not amended, and that needs saying.** The R2 directive asked for one
> line to be added to §4 of `AGENT_LOOP.md`. No file of that name exists in this repository, at
> the root or under `docs/` or `.claude/`, and `git log --all` shows it has never existed in any
> commit. There is precedent for the canonical copy living outside the repo — the Resume Engine
> Design Guideline is a `.docx` in a local Downloads folder, not a tracked file — so the real
> AGENT_LOOP may simply be somewhere I cannot see.
>
> Rather than lose the rule, it is recorded here in the section it was meant for. **Sections 1–3
> are deliberately absent: I do not know what they say and inventing them would be worse than an
> incomplete file.** If a canonical AGENT_LOOP exists elsewhere, this section should be merged
> into its §4 and this file deleted. Raised as `NEEDS_PRAKASH.md` Q9.

## 4 · HALT triggers

Stop and ask, rather than proceeding on your own judgement, when:

- **A gate goes red and the proposed fix changes the measurement rather than the code under
  test.** However strong the argument, that class of change cannot be validated from inside
  itself: the same reasoning that says the metric is wrong also decides what "fixed" looks like.
  It needs a control run — the new measurement against the unchanged baseline, so the metric
  change and the code change are not moving at once — and then a human ruling. Applies to test
  thresholds, eval floors, scoring functions, fixtures, and anything else that decides whether
  code passes rather than what the code does.

  _Worked example, PR #1292:_ `db:eval:occupation` fell to 95.7% against a 97.0% floor when a
  sub-unit `profiling_family` was added. The diagnosis — that the gold set is labelled at
  ISCO-unit granularity and cannot express a family bound below it — was correct, and the fix was
  in the metric with the floor untouched. It was still only _provable_ once the new metric was run
  against `origin/main`: same 98.2%, same twelve failures, and the new code path taken zero times.
  Without that control the argument was self-confirming.
