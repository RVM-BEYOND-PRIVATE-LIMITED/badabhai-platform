# Free-chat improvement loop, round 1 close-out (#2128, ADR-0051 §10), 2026-10-14

Every case here is fabricated. The JSON files hold model output over fabricated input, with no
worker data. The masked production sample (part B) is **not** stored anywhere in the repo (R29).
Only its findings are summarised below.

## 1. What production showed (probe, 2026-10-07 to 2026-10-14, part A counts only)

| Measure | Value |
|---|---|
| Free-chat turns | 275 turns from 75 workers; 189 were worker messages |
| Clarify | 9 (4.8%) |
| Fallback | 9 (4.8%) |
| Deflected | 3 |
| Refused | 2 |
| Strikes | 0 |
| Free-mode replies served as `REPLY_FALLBACK` | career 6 of 64, casual 3 of 11 |
| `profiling_free_reply` cost events | 75, all `real_call` and `success`, p95 2,922 ms against the API's 10 s budget |
| `profiling_free_classify` latency | p50 1,752 ms, p95 2,167 ms against a 2.5 s budget; 4 clarify fallbacks |

- **Every reply came back in time and in contract.** There is one cost event per reply-bearing turn, so each `fallback` outcome was the API's own gate (`screenFreeChatAnswer`) throwing the answer away.
- **The classifier latency** is the #2170 pattern: Haiku answers after a failed Gemini attempt.
- **The masked sample (4 eligible lines of 21 struggled)** held only career questions. They were trade comparisons, pay comparisons and "which software", and the classifier read every one of them right.

**The weak spot was the reply, not the classifier.**

## 2. Classifier: labelled set grown, re-scored (no revision)

- **Rewrites added.** `SAMPLE_ROWS` (8 lines) in `eval_free_classify_gold.py` are rewrites of the sample's shape, not copies.
- **The run** (`classify.txt`) used `claude-haiku-4-5`, the model production serves (R32, #2170): **126/134 = 94.0%**.
  - All 8 new lines were classified right.
  - The other 126 lines score as in round 1 (118/126).
- **No prompt change**, so R31 does not apply.

## 3. Reply: new served-rate eval, prompt revised

- **The set** is `eval_free_reply_gold.py`: 44 cases.
  - 28 career: comparisons, pay, which software or course, and follow-ups inside a conversation, including a re-ask after the fallback line.
  - 12 casual.
  - 4 must-refuse guards: `off_limits`, `legal_medical_financial`, `news`, `distress`.
- **The run:** `eval_free_reply_cli.py --repeats 3 --expect-model claude-haiku-4-5`. The reply's primary model is Haiku (`default_career_model`), so a local run measures exactly what production serves.
- **The score** comes from `free-chat-reply-served.js` (apps/api), which replays each dump through `FreeChatReplyOutputSchema` and `screenFreeChatAnswer`, the gate production runs.

| Run | Hits (of 132) | casual | career | must-refuse | Fallback reasons |
|---|---|---|---|---|---|
| Baseline (prompt on main) | 117 = 88.6% | 27/36 | 78/84 | 12/12 | line_too_long 4, too_many_questions 4, non_latin 3, promise 2, persona 1 |
| Revised (this PR) | 126 = 95.5% | 33/36 | 81/84 | 12/12 | line_too_long 3, too_many_questions 2, persona 1 |

- **R31, read for the reply: SHIP** (`served-revised.txt`). Overall hits went up, no must-refuse group lost a line, and career and casual both went up.
- **Intermediate draft.** It differed only in the "bahut acha" rule and scored 128/132. The two runs are within sampling noise of each other, and the final wording was kept because it covers the adverb use too ("kaam bahut acha karna").

**What the revision changed** (shared answer rules, plus three casual sentences):

- **Line length.** Lines aim for 12–15 words, under the 20-word wall.
- **Script.** Every Hindi word is in Latin letters down to its ending.
- **Questions.** At most one question, and only as the last line.
- **"bahut acha".** It is banned in any sense, with replacements offered.
- **Soft promises.** No "kaam mil jayega"; the prompt offers "kaam milne ki sambhavna badhegi" instead.
- **Casual replies.** A greeting gets a greeting and ONE question. Teasing or a complaint gets a polite answer, never a refusal (R37). A goodbye gets one warm line.

## Files

| File | What it is |
|---|---|
| `classify.txt` | Classifier eval on Haiku, 134 lines |
| `reply-baseline.json`, `reply-revised.json` | The two reply eval dumps (model output over fabricated input) |
| `reply-revised-cli.txt` | The revised run's CLI output: calls, model, latency, spend |
| `served-baseline.txt`, `served-revised.txt` | The API-gate replay, alone and with the R31 comparison |

**Baseline run's CLI totals:** 132 calls, all answered by `claude-haiku-4-5`, 0 mock, 0 failed, 0 late. Spend was ₹44.07. Round-trip latency was p50 2,609 ms and p95 3,478 ms.

## Not done here

- **The flash-lite re-run (R32)** is still owed before #2170 switches the box to Gemini. The local key is still free tier: `GenerateRequestsPerMinutePerProjectPerModel-FreeTier`, a 429 after 11 calls on 2026-10-14.
