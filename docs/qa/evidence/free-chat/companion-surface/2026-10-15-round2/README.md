# Bada Bhai chat: companion prompt fix round (#2287 PR 2), 2026-10-15

Every case here is fabricated. The JSON files hold model output over fabricated input, with no worker data.

**Outcome: R31 HOLD for the full revision. Only the classify subset (fixes 2, 4, 5, 6) shipped, re-measured on its
own.** The casual and career prompts stay as on main.

| Part                      | R31                                      | Shipped                                                     |
| ------------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| Classify (fixes 2, 4–6)   | PASS: 68/71 → 71/71, no category drops   | **Yes**, re-measured alone: 71/71                           |
| Reply (fixes 1, 3)        | **HOLD**: career dropped 16 lines        | No                                                          |
| Casual alone (fixes 1, 3) | 404/440, SHIP, but **computed, not run** | No: re-measuring it did not fit in the ₹400 cap (see below) |

The fixes are #2285's (`../2026-10-15/README.md`):

1. one question per greeting reply;
2. a greeting is casual;
3. no résumé offer, in a line or a chip;
4. "does X hire / pay" is career;
5. "which certificate" is career;
6. a bare résumé mention gets a null action.

## The runs

- **Sets:** classify 71 lines, reply 44 cases × 10 repeats. The 6 + 4 held-out lines were added before the baseline
  (commit `d3aabc26`), so both runs scored identical sets. The reply set digest is `9466d60d…`.
- **Arming:** the same as round 1:
  - only `profiling_free_classify` and `profiling_free_reply`, Anthropic primary;
  - the production Anthropic key, with the owner's OK ("Yes, run it now");
  - a dummy Gemini key, so a fallback could only fail;
  - Langfuse off, and an environment built from an allowlist;
  - masked posture, under which the gateway left all 10 new strings unchanged.
- **Caps:** each server's in-process cap was what remained of the round's ₹400: ₹400, then ₹224, then ₹48.
- **Prompts per run** (registry versions; classify / casual / career):

  | Run      | Classify       | Casual         | Career         | Source                                |
  | -------- | -------------- | -------------- | -------------- | ------------------------------------- |
  | Baseline | `4fe7a96d1122` | `5e925a7083e6` | `47330d1a31e8` | main `5869a5a6`, as #2285 measured    |
  | Revision | `071d1d4ca48d` | `9b50f5a1e05d` | `295cb84d89a9` | fixes 1–6 (`revision-prompt.diff`)    |
  | Subset   | `071d1d4ca48d` | `5e925a7083e6` | `47330d1a31e8` | fixes 2, 4–6 only (commit `5818fb40`) |

  The profiling prompts are byte-identical in every run (the sha256 pins).

- **Order:** smoke, baseline classify, baseline reply, then a new server for the revision classify and reply, then a
  new server for the subset classify. Sequential, one stream, each server stopped by PID.
- **Model:** all 1,095 calls (2 smoke + 71 + 440 + 71 + 440 + 71) were served by `claude-haiku-4-5`, each with a
  single candidate. There were no failures, no mock answers, no fallback and none slower than the API timeout.
- **Spend: ₹359.76** by the three servers' ledgers: baseline ₹175.77 (smoke ₹0.52 included), revision ₹175.92, subset
  ₹8.07. The smoke projected ₹376.75 for baseline plus revision.

## Classify (`classify-baseline.txt`, `classify-revision.txt`, `classify-subset.txt`)

| Measure                       | Baseline          | Revision          | Subset (shipped)  |
| ----------------------------- | ----------------- | ----------------- | ----------------- |
| **Category, overall**         | **68/71 = 95.8%** | **71/71 = 100%**  | **71/71 = 100%**  |
| resume                        | 24/24             | 24/24             | 24/24             |
| career                        | 10/12             | 12/12             | 12/12             |
| jobs                          | 8/8               | 8/8               | 8/8               |
| casual                        | 8/9               | 9/9               | 9/9               |
| trash / off_limits / distress | 3/3, 5/5, 5/5     | 3/3, 5/5, 5/5     | 3/3, 5/5, 5/5     |
| unclear                       | 5/5               | 5/5               | 5/5               |
| **`resume_action`**           | **21/24**         | **22/24**         | **22/24**         |
| null actions                  | 1/4               | 2/4               | 2/4               |
| Language label                | 67/71             | 67/71             | 67/71             |
| Output tokens                 | mean 37.0, max 39 | mean 37.0, max 39 | mean 37.0, max 39 |
| Latency, p50 / p95            | 1,144 / 1,343 ms  | 1,183 / 1,373 ms  | 1,125 / 1,297 ms  |
| Cost per call                 | ₹0.109            | ₹0.114            | ₹0.114            |

**R31 on the classify categories: PASS.**

- The overall score went up by 3 lines, and distress, trash and off_limits lost none.
- No category dropped.
- `resume_action` went up, from 21/24 to 22/24.
- The language label and the token max did not move, so **the 80-token cap stays**.

**What changed:**

- **Now right:** the three round-1 misroutes ("Tata mein welder ki job milti hai?", the Gujarati certificate question,
  "hello"), and "resume se related kaam hai" now gets null.
- **Read with care:** the held-out lines were already right in category at baseline. So the +3 is on the lines the
  fixes were written for, with no held-out regression.
  - The prompt quotes none of those lines.
  - The greeting rule names no greeting word, and a test pins that.
- **Still missed:**
  - "mera resume" → download;
  - "resume wali baat karni hai" → edit;
  - the four language misses ("skills mein Marathi jod do" read as Marathi; Latin Tamil read as Telugu; "hello" and
    "good evening sir" read as English).
- **Subset determinism:** the subset re-measure reproduced the revision's classify result exactly, as expected at
  temperature 0.

## Reply (`served-baseline.txt`, `served-revision-vs-baseline.txt`)

Scored with the API's own replay: `free-chat-reply-served.js --file reply-revision.json --baseline reply-baseline.json`.

| Group                   | Baseline            | Revision            |
| ----------------------- | ------------------- | ------------------- |
| **Total**               | **365/440 = 83.0%** | **388/440 = 88.2%** |
| casual                  | 69/130              | **108/130**         |
| career                  | 196/210             | **180/210**         |
| identity                | 20/20               | 20/20               |
| legal_medical_financial | 20/20               | 20/20               |
| news                    | 20/20               | 20/20               |
| off_limits              | 30/30               | 30/30               |
| distress                | 10/10               | 10/10               |

**R31: HOLD.** The total went up and no refusal group lost a line, but career dropped 16 lines, against an allowance
of 1.

**Rejections by wall:**

- **Baseline (75):** too_many_questions 56, persona 11, line_too_long 3, sensitive_advice 2, worker_rating 2,
  exclamation 1.
- **Revision (42):** too_many_questions 20, persona 5, sensitive_advice 5, non_latin 4, line_too_long 3, worker_rating 3,
  promise 2. In addition, 10 career replies were refused on `unsafe_other`.

**Fix 1 worked.** Casual answers with more than one "?" fell from 59 to 20.

| Case                                         | Baseline | Revision |
| -------------------------------------------- | -------- | -------- |
| `reply-121` "hello"                          | 1/10     | 10/10    |
| `reply-122` "namaste Bada Bhai"              | 1/10     | 10/10    |
| `reply-124` "kya haal chaal hai"             | 1/10     | 6/10     |
| `reply-130` "phir se aa gaya main" (+ notes) | 4/10     | 8/10     |
| `reply-141` "hello ji, aaj factory mein…"    | 3/10     | 7/10     |
| `reply-142` "namaste, aaj yahan baarish…"    | 7/10     | 9/10     |
| `reply-144` "aur sunao, kya naya hai"        | 0/10     | 8/10     |
| `reply-128` "How has your day been?"         | 2/10     | **0/10** |

The English small-talk line got worse: the Hinglish example ("Aap kaise hain?") did not carry over to English, and every
answer still asked two questions.

**What still reaches the model in production.** #2287 PR 1 (#2288, merged during this round) answers a BARE greeting
with the fixed `V3_GREETING` line and no model call. A bare greeting is one where every word is a greeting or a filler:
namaste, hello, hi, ram ram, good morning; bada, bhai, ji, sir.

- So `reply-121` and `reply-122` no longer reach the reply in production.
- On the other six casual cases above, fix 1 gained 21 lines (17/60 → 38/60). The remaining casual cases are unchanged
  in sum.
- In the classify set, "hello" and "namaste" are bare too, while "good evening sir" still reaches the classifier.

**Fix 3 caused the HOLD, and it did not do its job.**

- **It caused the drop.** It was the career prompt's only change.
  - `reply-114` ("mera resume dekh ke batao kaunsi line mein jaun") went from 7/10 served to 0/10: it was refused on
    `unsafe_other` 10 of 10. The new "never offer to make a resume" sentence makes the model refuse a career question
    that names the résumé.
  - The other −9 is net: 14 lines lost across ten cases and 5 gained across three. The losses are non_latin 4, promise
    2, and `reply-120`'s sensitive_advice ("investment"), up from 2 misses to 5; the rest are singletons.
- **It did not stop the offers.** `reply-129`'s chip "Resume banane mein madad" rose from 2 of 10 to 4 of 10. The API's
  gate does not check chips for a résumé offer, so these would be served.

**The casual-only composite (analysis, not a run).**

- **How it was built:** every reply call reads one prompt, picked by its category. Taking the revision's samples for
  the casual-category cases and the baseline's for the career-category cases therefore gives the gate's score for
  "casual revised, career as main". The composite file is not evidence and is not committed.
- **The score:** 404/440 = 91.8%, with casual 69 → 108 and everything else unchanged, so R31 says SHIP.
- **Why it did not ship:** the round's rule is to ship a subset only after measuring it once more. A casual re-run
  needs at least ₹80 for the casual-category cases, or ₹168 for the replay's full-set comparison. Only ₹48 was left
  under the ₹400 cap.

## Verdict and next steps

1. **Shipped:** the companion classifier's fixes 2, 4, 5 and 6 (commit `5818fb40`).
2. **Re-run the casual greeting fix (fix 1) without fix 3, as one revision run against this baseline.**
   - The baseline is reusable: same set digest, 10 repeats, Haiku.
   - The cost is about ₹170.
   - Add an English line to the rule ("How are you?" is that one question too) for `reply-128`.
3. **Drop fix 3 from both prompts.** A deterministic API-side check is the better place: drop a follow-up chip that
   offers to make a résumé on the companion. That is Backend's lane, so it needs an issue.
4. **Leave "mera resume" → download for now.** It is low harm: the download line and chip.

## Files

| File                                            | What it is                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| `classify-baseline.txt`                         | Main's companion classifier, 71 lines                                  |
| `classify-revision.txt`                         | The revision's classifier (fixes 2, 4–6 are its only classify changes) |
| `classify-subset.txt`                           | The shipped subset, re-measured alone                                  |
| `reply-baseline.json`, `reply-baseline-cli.txt` | Main's casual and career prompts, 44 × 10                              |
| `reply-revision.json`, `reply-revision-cli.txt` | The revision's casual and career prompts (fixes 1 and 3), 44 × 10      |
| `served-baseline.txt`                           | The baseline through the API gate                                      |
| `served-revision-vs-baseline.txt`               | The revision through the gate, and R31 against the baseline: HOLD      |
| `revision-prompt.diff`                          | The full revision (fixes 1–6) as measured, against main's `prompts.py` |
