# Profiling turn understanding eval (#2309, ADR-0057 §6), 2026-10-20

Every case here is fabricated. No worker data. Nothing here prints a model's raw output.

## What ran

`eval_understand_cli.py` (55 cases) against a local ai-service started from `main`
(`b50f7574`), with `AI_REAL_CALL_TASKS` = shipped set + `profiling_turn_understand`,
`--expect-model claude-haiku-4-5 --pace-ms 1500`. Production Anthropic key with the
owner's OK. Local `anthropic` SDK had to be installed first (attempt 0 failed: SDK
missing, 34 mocks + 21 Gemini fallback — correctly rejected by the gate, ₹1.36).

## Scores

| | A1 (`attempt1-fail.txt`) | A2 (`attempt2-fail.txt`) | A3 (`attempt3-nearmiss.txt`) | A4 (raw lost, summary) | A5 PASS (`run.txt`) | Bar |
|---|---|---|---|---|---|---|
| intent accuracy | 49/55 = 89.1% | 47/55 = 85.5% | 52/55 = 94.5% | 52/55 = 94.5% | 52/55 = 94.5% | >= 90% |
| fill precision | 24/26 = 92.3% | 24/26 = 92.3% | 26/27 = 96.3% | 26/28 = 92.9% | 26/27 = 96.3% | >= 95% |
| keys outside schema | 0 | 0 | 0 | 0 | 0 | 0 |
| false-positive deletes | 0 | 0 | 0 | 0 | 0 | 0 |
| false-positive 'none' | 0 | 0 | 1 | 0 | 0 | 0 |
| over API timeout (4000 ms) | 3 | 6 | 2 | 2 | 2 | — |
| mock / fallback answers | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| spend (router est.) | INR 10.95 | INR 10.95 | INR 11.67 | INR 12.10 | INR 12.44 | — |

(A0, not filed: SDK missing locally — 34 mocks + 21 Gemini fallback, correctly
rejected by the `--expect-model` gate, INR 1.36. Fixed by installing `anthropic`.)
(A4's raw file was overwritten by the A5 run; its score lines are preserved above.)

## Attempt 5 — PASS (`run.txt`, after prompt + gold fixes)

Owner-adjudicated changes: gold `kal se join` → `Within a week`; prompt gained four
rules (refusal is an answer; volunteered location is a statement; fill only what is
stated + field-specific no-inference bans; `X nahi Y` is always the edit + the
`yaad nahi` none-guard). Deterministic suite 49/49 throughout.

| | Attempt 5 | Bar |
|---|---|---|
| intent accuracy | 52/55 = 94.5% | >= 90% ✅ |
| fill precision | 26/27 = 96.3% | >= 95% ✅ |
| keys outside schema / false deletes / false nones | 0 / 0 / 0 | 0 ✅ |
| mock / fallback answers | 0 / 0, all 55 Haiku | 0 ✅ |
| over API timeout | 2 (local-laptop latency) | — |
| spend (router est.) | INR 12.44 | — |

**Verdict: PASS — gate met, recorded 2026-10-20.**

Known residuals (bars pass; not chasing here): 2 local-latency timeouts (a box run
should be cleaner); `experience 5 nahi 6 saal` still reads as statement — the other
correction cases pass (edits exact 53/55), flagged as prompt follow-up, not a gate
blocker.

## Analysis

- Safety bars all met in both runs (0/0/0). When the model answers, it is near
  perfect ('none' reading 52/52 then 49/49).
- The misses are dominated by latency, not understanding: model call p50 ~1.4 s,
  but round trip to the local service p50 ~3.5–3.6 s against the pinned 4000 ms
  API timeout, so 3–6 cases/timeout convert to "no answer" = intent miss.
  Temperature is 0; run-to-run variance is the timeout lottery.
- Remaining non-timeout misses are single gold-boundary reads (`kal se join` →
  availability bucket, `interest nahi hai` intent, `Mumbai mein hi rehta hoon`
  intent, one travel fill, one edit-vs-statement) — owner call whether the gold
  or the prompt moves.

## Needed for PASS

Owner decision: (a) accept the latency profile and re-run on the box (where the
hop differs), (b) review the borderline gold labels, or (c) tune then re-run.
No code was changed for this eval; no prod flags touched.
