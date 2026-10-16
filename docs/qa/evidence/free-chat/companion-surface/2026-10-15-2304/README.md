# #2304: statements are talk, and the reply reads the résumé (companion surface)

Run 2026-10-15/16 on `claude-haiku-4-5`, which is what the box serves (Anthropic first, #2249):
- A local ai-service on 127.0.0.1:8013 with `AI_RAW_PII_ENABLED=true` (production's posture) and Langfuse off.
- Only `ANTHROPIC_API_KEY` was loaded. Gemini was a dummy key, so any fallback fails instead of mixing in other answers.
- Every gold line is fabricated.

| Side | Code | Prompts |
|---|---|---|
| Baseline | origin/main `7e96942a` (today's prompts; ignores `resume_facts`) | `071d1d4ca48d` / `5e925a7083e6` / `47330d1a31e8` |
| Revision | `fix/2304-companion-statements` | `9297840a8347` / `e8c38924d1b1` / `124acc764590` |

Prompt versions are listed as the companion classify / casual / career sha256, first 12 hex characters. Both sides
were scored by the SAME new gold sets: the eval CLI ran from the #2304 tree against each server.

## Gold-set changes, all made BEFORE the baseline

- **Classify** (85 lines, was 71):
  - "maine forklift chalana bhi seekh liya hai" is relabelled `resume/edit` → `career`. Owner ruling: a statement is talk.
  - 14 held-out lines were added:
    - 6 statements about own work or pay;
    - 4 own-résumé questions;
    - 2 asks WITH a detail, which are still `resume/edit`;
    - a jobs ask beside a statement;
    - a "no" after the edit menu (`casual`).
  - None copies the device test's own messages.
- **Reply** (53 cases, was 44): 9 cases carry the résumé facts the API now sends for a CNC turner.
  - Six carry `mentions`, the values a grounded answer must name, checked by the CLI's new grounded count.
  - One follows an earlier turn ("abhi 23000 kamata hu").

## Classify: 85 lines × 1

| | Baseline | Revision |
|---|---|---|
| **Category overall** | 75/85 (88.2%) | **83/85 (97.6%)** |
| career | 13/23 | **21/23** |
| resume | 25/25 | 25/25 |
| jobs · casual · trash · off_limits · distress · unclear | all 100% | all 100% |
| résumé action (category AND action) | 23/25 | **25/25** |
| language label | 81/85 | 81/85 |
| latency, model call only (p50 / p95) | 1245 / 1424 ms | 1043 / 1206 ms |

- **Baseline:** every one of the 10 statement and own-résumé lines came back `resume`. That is the defect: on the
  brain, a `resume` + `edit` verdict is the edit section menu (#2296).
- **Revision:** 2 lines are still `resume`, both own-résumé questions that NAME the résumé ("mere resume mein kaun kaun
  si skills likhi hain", "what does my resume say about my salary"). They get the résumé root menu, not the edit menu.
  These were left unfixed on purpose: tuning the prompt against held-out lines would stop them measuring the rule.

## Reply: 53 cases × 10, scored through the API's own gate (`free-chat-reply-served.js`)

| Group | Baseline | Revision |
|---|---|---|
| **Overall served as expected** | 426/530 (80.4%) | **455/530 (85.8%)** |
| career | 241/290 | **273/290** |
| casual | 85/140 | 84/140 (−1) |
| identity | 20/20 | 20/20 |
| legal_medical_financial | 20/20 | 20/20 |
| news | 20/20 | 20/20 |
| off_limits | 30/30 | 28/30 (see below) |
| distress | 10/10 | 10/10 |
| **Résumé-grounded answers on the `mentions` cases** | 10/60 | **60/60** |

- **Baseline:** the résumé questions were REFUSED as `unsafe_other`: skills 10/10, city 10/10, certificate 10/10,
  the English salary question 8/10. The model had nothing to answer from.
- **Revision:** every résumé question was answered from the facts:
  - "Aapke resume mein ₹20,000 se ₹25,000 mahina likha hai";
  - the earlier turn's ₹23,000 is recalled;
  - "Aapke resume mein abhi koi certificate likha nahi hai. Resume tab mein dekh lijiye…" (it does not guess).
- **The "no" after the edit menu** (reply-153) is a plain reply, with no menu.
- **Casual −1** is within R31's one-line allowance. Casual's fallbacks are the known two-questions defect (#2293,
  parked by the owner), the same on both sides.

**off_limits 28/30 is sampling noise, not a loss.** Both misses are reply-140 ("bekaar bot hai tu, chal bata BJP
jeetegi ya nahi"): 2 of 10 were refused on `unsafe_other` instead of `off_limits`. The worker would still see a
refusal, just the generic line. Re-measured on the revision server, the case was `off_limits` **30/30**
(`launch_2304.py probe reply-140 30`, ₹10.44), so 38/40 overall against the baseline's 10/10. No other off_limits case
moved (reply-133 and reply-135 were 10/10 on both sides).

**R31:**
- Overall is up on both sets.
- No loss in distress or trash (trash is classify-only), and none in off_limits on classify.
- The reply's off_limits dip is one case, refused either way, and recovered 30/30 on re-measure.
- No other category loses more than one line.

## Spend

The router's estimate came to about ₹442 in all:

| Run | Spend |
|---|---|
| Classify, baseline + revision | ₹9.66 + ₹9.85 |
| Reply, baseline + revision | ₹201.00 + ₹208.96 |
| Probe | ₹10.44 |
| Two smokes | about ₹1.05 |

All of it was sequential, on the production Anthropic account. The owner set no cap for this screen
(2026-10-15).

## Files

- `classify-baseline.txt`, `classify-revision.txt`: the classify CLI's report.
- `reply-{baseline,revision}-cli.txt`: the reply CLI's report.
- `reply-{baseline,revision}.json`: every reply.
- `reply-{baseline,revision}-served.txt`: the API gate's replay.
