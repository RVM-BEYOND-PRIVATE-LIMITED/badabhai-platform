# Free-chat improvement loop, round 1 close-out (#2128, ADR-0051 §10), 2026-10-14

Every eval case here is fabricated. The JSON files hold model output over fabricated input, with no worker
data. The masked production sample (part B) is **not** stored anywhere in the repo (R29). Only its findings
are summarised below.

**Outcome:** the labelled sets grew, a reply served-rate eval now exists, and the probe shows the served model.
**No prompt changed this round:** the one reply revision measured did not pass R31.

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

## 2. Classifier: labelled set grown, re-scored, no revision

- **Rewrites added.** `SAMPLE_ROWS` (8 lines) in `eval_free_classify_gold.py` are rewrites of the sample's shape.
  - The security review asked for one of them to be rewritten further, away from a sampled line's word order. The other 7 are as scored.
- **The run** (`classify.txt`) used `claude-haiku-4-5`, the model production serves (R32, #2170): **126/134 = 94.0%**.
  - All 8 sample lines were classified right; the other 126 score as in round 1.
  - The reworded line ("packing waalon ka mahina…", résumé mode, `career`) was **not** re-scored, because the Anthropic credit ran out (§4).

## 3. Reply: new served-rate eval; the draft revision did not pass R31

**The eval** has three parts:
- **The set:** `eval_free_reply_gold.py`, 46 cases.
  - 28 career: comparisons, pay, which software or course, and follow-ups inside a conversation, including a re-ask after the fallback line.
  - 12 casual.
  - 6 must-refuse: off_limits, legal_medical_financial, news, distress, plus two teases mixed with a refusal topic.
- **The run:** `eval_free_reply_cli.py --expect-model claude-haiku-4-5 --repeats N`. The reply's primary is Haiku (`default_career_model`), so a local run measures the production model.
- **The score:** `free-chat-reply-served.js` (apps/api) replays a dump through `FreeChatReplyOutputSchema` and `screenFreeChatAnswer`, and applies R31 with `--baseline`.

**The draft (v2)** changed the shared answer rules:
- a 12–15-word line target;
- Latin verb endings;
- one question, only as the last line;
- no "bahut acha";
- no soft promise ("kaam mil jayega", "kaam pakka hai").

It also told the casual prompt to answer a greeting with one question, to answer a tease "never with a refusal, unless it touches a refusal topic", and to answer a goodbye warmly.

| Run (46 cases, `claude-haiku-4-5`) | Hits | casual | career | off_limits | Fallback reasons |
|---|---|---|---|---|---|
| Baseline, main's prompt, 3 repeats (`reply-baseline.json`) | 131/138 | 30/36 | 83/84 | 6/6 | too_many_questions 4, non_latin 2, line_too_long 1 |
| Draft v2, 3 repeats (`draft-v2/`) | 131/138 | 34/36 | 80/84 | 5/6 | line_too_long 2, non_latin, persona, promise, too_many_questions 1 each |

**R31: HOLD** (`draft-v2/served-vs-baseline.txt`). The overall score did not go up, career dropped 3 lines, and off_limits lost 1 line.

**A larger pair (10 repeats) was run to separate the effect from noise.**
- Each local service's in-process ₹200/day cap turned the last repeat into mock answers, so the CLI marked both runs CONTAMINATED and they are not committed.
- On repeats 0–8, which are all real Haiku answers (414 replies each):
  - **overall:** baseline 375, draft 379;
  - **casual and career:** casual 93 → 99, career 229 → 234;
  - **off_limits: 17 → 10.** The "tease is never a refusal" rule moved the tease-plus-politics case to `unsafe_other` 8 times in 9;
  - **gate rejections:**

    | Reason | Baseline | Draft |
    |---|---|---|
    | too_many_questions | 11 | 5 |
    | persona ("bahut acha") | 8 | 2 |
    | line_too_long | 9 | 3 |
    | promise ("pakka" meaning "skilled") | 4 | 9 |
    | non_latin | 6 | 8 |

**Noise, for the record.**
- An earlier 3-repeat pair, on a 44-case version of the set (before the R29 rewording), read 117 → 126.
- The same baseline prompt scored 131/138 two hours later.
- At temperature 0.5, 3 repeats cannot resolve a 1–3% effect. Use 10.

**Draft v3** drops the tease rule and steers "pakka" (meaning "skilled") to "achhe se seekh lenge". It was **not measured**: the Anthropic credit ran out mid-run (§4). It is tracked as a follow-up.

## 4. Operational note: evals draw on the production Anthropic account

- **The laptop's ai-service key is the account the production box uses.** Today's local runs cost about ₹750, some of them as two parallel streams. Then the account ran out of credit.
- **A read-only `ai.cost_recorded` scan** (owner-approved) found:
  - 10 of 21 real calls `llm_call_failed` in the 11:00 IST hour;
  - no successful AI call after 12:27 IST (the scan ran at 12:38).
- **Since #2170 the box serves only Haiku**, so every AI call in production failed in that window.
- **Before a large eval run:** estimate the cost (about ₹0.33 per reply call, ₹0.07 per classify call), get the owner's OK, and never run streams in parallel against that key.

## Files

| File | What it is |
|---|---|
| `classify.txt` | Classifier eval on Haiku, 134 lines (before the one R29 rewording) |
| `reply-baseline.json`, `reply-baseline-cli.txt` | Baseline reply run (main's prompt), 46 cases × 3 |
| `served-baseline.txt` | The baseline through the API gate |
| `draft-v2/reply-revised.json`, `draft-v2/reply-revised-cli.txt` | The draft's run, 46 cases × 3 (not shipped) |
| `draft-v2/served-vs-baseline.txt` | The draft through the gate, and R31 against the baseline: HOLD |

## Still owed

- **Measure draft v3** against main at 10 repeats, sequentially, with the owner's OK on cost (about ₹300). Ship it only past R31.
- **Flash-lite classifier re-run** (R32) before #2170 switches the box. The local Gemini key is still free tier.
- **R35 (owner):** delete the operator session transcript holding the pasted sample, including its subagent transcripts.
