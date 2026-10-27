# D4 model gate (#2459), 2026-10-27

Every case here is fabricated. There is no worker data. The reports print counts, served models,
timings, and the fabricated case text with the keys and values that were proposed. They never
print a model's raw output.

## Question

Can a cheaper model replace **Claude Haiku 4.5** (production today) for `profile_extraction` and
`profiling_turn_understand`? The approved scenario sheet (Stack B) sets the gate rules:

| Set | Cases | Bar |
|---|---|---|
| Blind Hinglish extraction (`eval_hinglish_cli`) | 116 | reported: trade, level, controller, salary, location |
| Understand (`eval_understand_cli`) | 55 | intent >= 90%, fill precision >= 95%, 0 out-of-schema keys, 0 false deletes, 0 false "none" |
| Canonicalisation (`eval_canonicalization --real`) | 64 | overall >= 90% |

Quality decides. A tie goes to Flash-Lite. **Nothing switches without Akshit's ruling.**

## Gemini arm: 3.1 Flash-Lite, not 2.5

- **2.5 Flash-Lite cannot be measured.** The first attempt ran on a free-tier key (20 calls a day).
  It produced 112 mock answers out of 116 and is not evidence. The paid key (`…MejA`, project
  `gen-lang-client-0050675763`, Tier 1 Prepay, created 2026-10-22) then got HTTP 404 *"This model
  models/gemini-2.5-flash-lite is no longer available to new users"* on 12 of 12 calls. Google
  has closed the 2.5 family to new projects.
- **Owner ruling (2026-10-27): gate `gemini-3.1-flash-lite` instead.** It returned HTTP 200 on 12
  of 12 calls to the unchanged request (`thinkingBudget: 0`). PR #2462 (`84824bb6`) allows it in
  `AI_TASK_MODEL_OVERRIDES` and prices it at $0.25 in / $1.50 out per 1M tokens.
- `gemini-3.5-flash-lite` (the model Google's 404 suggests) returns HTTP 400 to `thinkingBudget: 0`.
  It would need a client change first, so it was not run.
- **3.1 Flash-Lite costs more than the 2.5 Flash-Lite in the scenario sheet** ($0.10 / $0.40) and
  more than Haiku 5.5 ($0.10 / $0.50).

## Results

| Model | Blind Hinglish (116) | Understand (55), fill-precision bar 95% | Canonicalisation (64) | Gate |
|---|---|---|---|---|
| Haiku 4.5 (baseline) | 349/349 fields, 116/116 exact | **PASS**, 1 run: intent 55/55, fills 29/30 = 96.7% | **PASS** 95% (core 38/39, negative 7/7, hard 16/18) | eligible (production today) |
| Haiku 5.5 | 349/349, 116/116 | **1 of 3 runs pass**: 90.0%, 92.9%, 96.4% | **PASS** 95% (same misses as baseline) | not reliably eligible |
| 3.1 Flash-Lite | 349/349, 116/116 | **0 of 3 runs pass**: 90.0% on all three, same five misses each time | **PASS** 97% (core 39/39, negative 7/7, hard 16/18) | not eligible |

Every scored call in every run was a real, successful answer from the named model, with 0 mock
answers, 0 fallbacks, 0 failures and 0 answers over the API timeout.

### Cost per call (router estimate, Rs)

| Model | Extraction (blind set) | Understand | vs Haiku 4.5 |
|---|---|---|---|
| Haiku 4.5 | 0.216 (Rs 25.09 / 116) | 0.226 (Rs 12.44 / 55) | 100% |
| Haiku 5.5 | 0.011 (Rs 1.23 / 116) | 0.012 (Rs 0.68 / 55) | ~5% |
| 3.1 Flash-Lite | 0.050 (Rs 5.74 / 116) | 0.051 (Rs 2.80 / 55) | ~23% |

Per-flow cost (chat <= Rs 1.10, form <= Rs 0.25, résumé <= Rs 0.35) is measured only after a switch,
by the nine scripted runs in `scripts/cost-regression/` on the box.

### Understand misses

| Case | Gold | Haiku 4.5 | Haiku 5.5 (3 runs) | 3.1 Flash-Lite (3 runs) |
|---|---|---|---|---|
| `kal se join kar sakta hoon` | `Within a week` (owner-adjudicated 2026-10-20) | right | `Immediately` 3/3 | `Immediately` 3/3 |
| `15 din ka notice hai` | `Serving notice` | right | `Within a month` 2/3 | `Within a month` 3/3 |
| `Pune ya Nashik mein kaam chahiye` | no `willing_to_travel` | wrong 1/1 | wrong 1/3 | wrong 3/3 |
| `5 saal ka experience hai mera` | statement, no edit | right | read as `edit` in run 3 | extra edit 3/3 |
| `night shift chahiye` | statement | right | right | `chat` 3/3 |

The fill-precision denominator is small: about 28 to 30 proposed fills. So **one wrong fill moves
the score by about 3.4 points**, and the 95% bar allows one wrong fill in 30. The baseline passes
with exactly one. The understand route runs at temperature 0, so Flash-Lite gives the same answers every run. Haiku 5.5 runs at
a forced temperature of 1.0 (the model accepts no other value), so its score moves between runs.
Haiku 4.5 has one run today. On 2026-10-20 its understand attempts also moved, from 92.3% to 96.3%
(`../../turn-understanding/2026-10-20/`), mostly through laptop timeouts.

## Verdict under the scenario rules

**Neither candidate clears every bar.**

- Flash-Lite fails understand on every run.
- Haiku 5.5 fails it on two runs out of three.

The scenario rule for this outcome is **stay on Haiku 4.5 unless Akshit relaxes the bar.**
Nothing has switched.

### Decision for Akshit

1. **Stay on Haiku 4.5. No switch, and D4 closes.** This is the scenario default for this outcome.
2. **Relax the understand fill bar, for example to 90%, and pick a model:**
   - **Haiku 5.5:** about 5% of today's per-call cost, but its score moves between runs.
   - **3.1 Flash-Lite:** about 23% of today's cost, steady from run to run, and the best canonicalisation score (97%).

   Both are equal on the blind set. Under a relaxed bar, the tie rule ("a tie goes to Flash-Lite")
   does not settle it cleanly: Flash-Lite canonicalises better, Haiku 5.5 understands slightly
   better on average, and Haiku 5.5 is about 4.7 times cheaper.
3. Optional before ruling: two more Haiku 4.5 understand runs (about Rs 25 on the production
   Anthropic account) would show whether the baseline holds 95% every time.

A switch is then a box change raised as a Prakash issue:
- **Haiku 5.5:** `AI_TASK_MODEL_OVERRIDES` for the two tested tasks.
- **3.1 Flash-Lite:** the same override variable, and per scenario step 8 also `AI_CHAT_MODEL_TIER=capable`.

After a switch, the nine cost runs must hit their targets.

## How it ran

- **Flash-Lite:**
  - **Service:** a local ai-service from the PR #2462 tree.
  - **Settings:** `AI_REAL_CALL_TASKS=profiling_turn_understand,profile_extraction`, both tasks
    overridden to `gemini-3.1-flash-lite`.
  - **Anthropic key:** a **dummy**, so any fallback would fail and mark the run contaminated
    instead of answering from Haiku.
- **Haiku 5.5:** a local ai-service from `main` (the ai-service code is identical to `4d532b8a`),
  with both tasks overridden to `claude-haiku-5-5`, on the production Anthropic account.
- **Both:** `AI_RAW_PII_ENABLED=true` (the production setting), Langfuse blanked, a warm-up call
  first, `--pace-ms 300`, and `--expect-model` set to the arm's model.
- **Canonicalisation:** the stock `--real` mode ignores each call's `ai_metadata`. The Flash-Lite
  run used a wrapper with the same `gold.evaluate` and the same `POST /profile/extract`, which
  also recorded every call's `model_name`, `real_call` and `success`: 64 of 64 were real successes
  from `gemini-3.1-flash-lite`.

### Files

| File | What |
|---|---|
| `hinglish-haiku-4-5.json`, `hinglish-haiku-5-5.json`, `hinglish-flash-lite-3-1.json` | blind-set reports |
| `hinglish-flash-lite-3-1.txt` | blind-set console, Flash-Lite |
| `understand-haiku-5-5-run2.txt`, `-run3.txt` | Haiku 5.5 understand repeats (run 1: 90.0%, console not kept) |
| `understand-flash-lite-3-1-run1.txt` … `-run3.txt` | Flash-Lite understand |
| `canonicalisation-flash-lite-3-1.txt` | Flash-Lite canonicalisation with per-call attribution |

The Haiku 4.5 understand and canonicalisation runs, and Haiku 5.5's understand run 1 and
canonicalisation run, are from this morning's session. Their scores are recorded above, but
their consoles were not kept.

### Spend

| Arm | Account | Spend |
|---|---|---|
| Haiku 4.5 and Haiku 5.5 (blind, understand, canonicalisation) | production Anthropic | ~Rs 50 |
| Haiku 5.5 understand repeats | production Anthropic | Rs 1.36 |
| 3.1 Flash-Lite (all three sets, three understand runs, probes) | Google key | ~Rs 18 |
