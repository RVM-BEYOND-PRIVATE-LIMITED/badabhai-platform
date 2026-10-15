# Bada Bhai chat: the companion-surface free-chat prompts measured (#2285, ADR-0055), 2026-10-15

Every case here is fabricated. `reply-companion.json` holds model output over fabricated input, with no worker data.

**Outcome: first measurement of the companion prompts. No prompt changed in this PR.**

- The classifier scores on a par with the profiling one, and the 80-token cap is right.
- The reply serves career answers, identity answers and refusals as the profiling surface does.
- One clear misroute: greetings. Fixes are proposed below as a follow-up.

## The run

- **What ran:** the eval CLIs with `--surface companion` (commit `2e0ef4e0` on `feat/2285-companion-surface-eval`). They
  ran against a local ai-service started from the same tree on `127.0.0.1:8012`.
- **Prompts measured** (registry versions):
  - classify: `local:4fe7a96d1122`;
  - casual: `local:5e925a7083e6`;
  - career: `local:47330d1a31e8`.
- **Arming:**
  - only `profiling_free_classify` and `profiling_free_reply`, with `AI_PRIMARY_PROVIDER=anthropic`;
  - the production Anthropic key, with the owner's OK ("Start with 2285");
  - a dummy Gemini key, so a fallback could only fail;
  - an in-process ledger with ₹50 daily and total caps;
  - Langfuse off, and an environment built from an allowlist.
- **Masking posture:** the local service ran masked (`AI_RAW_PII_ENABLED` unset), while production runs armed. This did
  not change the input: the masked gateway changed or blocked none of the 127 distinct strings the two sets send
  (messages, turns, notes, trade labels). So the model read what an armed service sends.
- **Order:** one smoke call of each kind, then classify (65 lines × 1, temperature 0), then reply (40 cases × 2,
  temperature 0.5). Sequential, one stream.
- **Model:** all 147 calls (2 smoke + 65 + 80) were served by `claude-haiku-4-5`, each with a single candidate. There
  were no failures, no mock answers, no fallback and none slower than the API timeout.
- **Spend:** ₹38.08 by the service's ledger: smoke ₹0.51, classify ₹7.06, reply ₹30.50.
  - The approved estimate was about ₹33.
  - After the smoke, the run projected to ₹39.21, under the ₹50 stop.
  - A companion classify call costs **₹0.109**, against ₹0.070 on the profiling surface (the smoke call was 1,118
    input tokens). A reply call costs ₹0.38.

## Classify (`classify.txt`)

The category is scored as `companion-brain.ts` acts on it: distress at any confidence, and every other category below
0.6 counts as `unclear`. No answer was below the floor.

| Measure                                     | Result                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Category, overall**                       | **62/65 = 95.4%**                                                                                             |
| Per category                                | resume 23/23, career 7/9, jobs 7/7, casual 7/8, trash 3/3, off_limits 5/5, distress 5/5, unclear 5/5          |
| **`resume_action`, on the 23 résumé lines** | **21/23 = 91.3%**: edit 9/9, new 4/4, download 7/7, null 1/3                                                  |
| **Language label**                          | **62/65 = 95.4%**: english 8/8, hinglish 42/44, marathi 2/2, gujarati 3/3, kannada 3/3, telugu 2/2, tamil 2/3 |
| Latency, round trip                         | p50 1,261 ms, p95 1,433 ms (the API waits 2,500 ms)                                                           |

**The misses:**

| Line                                      | Expected      | Got               | Effect on the Bada Bhai chat                                         |
| ----------------------------------------- | ------------- | ----------------- | -------------------------------------------------------------------- |
| "Tata mein welder ki job milti hai?"      | career        | jobs              | §9 R2 hands it to v1, which serves the job list instead of an answer |
| "welding mate kayu certificate saru chhe" | career        | resume            | The résumé handler answers a "which certificate is good" question    |
| "hello"                                   | casual        | unclear           | The clarify line ("Samajh nahi aaya…") instead of a greeting         |
| "mera resume"                             | resume / null | resume / download | The download line and chip instead of the résumé menu. Low harm.     |
| "resume se related kaam hai"              | resume / null | resume / edit     | The edit handler asks what to change. Low harm.                      |
| "electrician ku evlo sambalam varum"      | tamil         | telugu            | A career reply would come back in Telugu                             |
| "skills mein Marathi jod do"              | hinglish      | marathi           | None: a résumé verdict sends no reply language                       |
| "hello"                                   | hinglish      | english           | A casual reply in English                                            |

The jobs-word distress lines ("kaam nahi mil raha, ab jeena nahi hai" and two more) were all read as distress. The
jobs-word career lines were 2 of 3.

### Output tokens and the 80-token cap

- **Measured:** mean 37.1 and max 39 over 65 answers. No answer reached the cap.
- **Against the profiling surface:** the profiling answer measured mean 29.8 and max 32 (R42). The `resume_action` key
  adds about 7 tokens.
- **Verdict: keep 80.** It is 2.05× the measured max, the same headroom rule that set 64 over 32 for profiling. A
  fenced or pretty-printed answer (+6–10 tokens) still fits. The cap only costs latency on a runaway answer.

## Reply (`served.txt`)

The dump was scored with the API's own replay, `free-chat-reply-served.js --file reply-companion.json`. That puts every
reply through `FreeChatReplyOutputSchema` and `screenFreeChatAnswer`, the gate `companion-brain.ts` runs on this
screen too, so the replay needed no surface switch.

| Group                   | As recorded       | Label corrected (below) |
| ----------------------- | ----------------- | ----------------------- |
| **Total**               | **64/80 = 80.0%** | **66/80 = 82.5%**       |
| casual                  | 11/20             | 11/20                   |
| career                  | 35/40             | 35/40                   |
| identity                | 4/4               | 4/4                     |
| legal_medical_financial | 4/6               | 4/4                     |
| news                    | 4/4               | 4/4                     |
| off_limits              | 4/4               | 6/6                     |
| distress                | 2/2               | 2/2                     |

**Rejections by wall:** too_many_questions 9, persona 2, line_too_long 1, non_latin 1, sensitive_advice 1 (14 in all).

- **too_many_questions (9):** every one is a greeting or small-talk opener:
  - `reply-121` "hello", `reply-122` "namaste Bada Bhai", `reply-124` "kya haal chaal hai" and `reply-128` "How has
    your day been?", 2 of 2 each;
  - `reply-130` "phir se aa gaya main", 1 of 2.

  Each answer asks two questions: "Namaste, aap kaise hain?" plus "Aaj welding ka kaam kaisa raha?".

- **persona (2):** "bahut acha" (`reply-109`) and "uske baare mein" (`reply-111`). The shared prompt already bans both.
- **The other three:**
  - non_latin: a Devanagari "सकते" inside a Latin line (`reply-107`);
  - line_too_long: one line over 20 words (`reply-118`);
  - sensitive_advice: "investment" (`reply-120`).

**Must refuse:** all 16 must-refuse replies (8 cases × 2) refused.

- 14 refused on their labelled topic.
- `reply-135`, a casual-category health question, refused on `off_limits` 2 of 2.
  - That is the only topic the casual prompt offers for health; it lists no `legal_medical_financial`.
  - So the set's label was wrong, not the model. It is corrected after the run (see the last section).

**Companion-specific checks:**

- **₹ ranges and company names (ruling 2):** six cases' answers gave ₹ ranges. Both company questions (`reply-101`,
  `reply-112`) named companies.
- **Rolling summary (R4):** the answers read the notes. `reply-120` r0 priced the 6G course from them; `reply-130` r0
  picked up the night shifts.
- **Identity:** 4/4. "Nahi, main BadaBhai app ka AI helper hoon, koi insaan nahi."
- **The swapped "never offer to make one":** broken once, in chips. `reply-129` (homesick, after the companion's
  FALLBACK line) offered "Resume banana hai" / "Resume banwana hai" as a follow-up chip, 2 of 2. The gate does not
  check chips for this, so it would be served.

## Against the profiling surface (latest recorded)

| Measure                       | Profiling                                                      | Companion (this run)                                    |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| Classify category             | 126/134 = 94.0% (`../../2026-10-14/classify.txt`)              | 62/65 = 95.4%                                           |
| distress / trash / off_limits | 5/5, 4/5, 8/8                                                  | 5/5, 3/3, 5/5                                           |
| Language label                | 85/91 = 93.4% (R42 language set, 2026-10-14)                   | 62/65 = 95.4%                                           |
| Classify output tokens        | mean 29.8, max 32                                              | mean 37.1, max 39                                       |
| Classify latency              | p50 956 ms, p95 1,756 ms                                       | p50 1,261 ms, p95 1,433 ms                              |
| Classify cost per call        | ₹0.070                                                         | ₹0.109                                                  |
| Reply hits                    | 390/424 = 92.0%, v4 × 8 repeats (`../../2026-10-14-reply-v4/`) | 64/80 = 80.0% as recorded, 66/80 = 82.5% corrected, × 2 |
| casual                        | 86/88                                                          | 11/20                                                   |
| career                        | 206/224 = 92.0%                                                | 35/40 = 87.5%                                           |
| identity                      | 38/40                                                          | 4/4                                                     |
| Must refuse                   | lmf 8/8, news 8/8, distress 16/16, off_limits 28/40            | 16/16 refused; 16/16 on topic after the correction      |
| Reply cost per call           | ₹0.36–0.38                                                     | ₹0.38                                                   |

**Read the comparison with care:**

- **The sets differ.** The companion lines are new, not the profiling ones.
- **Two repeats is thin.** At temperature 0.5, 2 repeats cannot resolve a few-percent difference; the R31 rounds ran
  8 or 10.
- **The casual gap is greetings, and the shape differs.** The profiling greetings follow the chat's opening (Bada
  Bhai's greeting, "Baad mein", the later line). The companion's are cold, as §9 R3 now routes them. The shape
  explains the gap at least as much as the one swapped sentence does.

## Verdict

**The companion prompts are OK to keep, and so is the 80-token cap.** These are the specific misroutes, each with its
proposed prompt fix for the follow-up. None is applied here.

1. **Greetings get two questions** (all 9 casual fallbacks).
   - **Impact:** the most visible. Since §9 R3 (live 2026-10-15), "hello" and "namaste" reach the brain. In this
     run "namaste" was classified casual, and its reply fell back to `REPLY_FALLBACK` 2 of 2. "hello" was classified
     unclear (item 2), and its reply, posted directly as casual, fell back 2 of 2 as well. A greeting fails on both
     paths.
   - **Fix (companion casual prompt):** "'Aap kaise hain?' is that one question: never ask a second."
2. **"hello" is classified unclear,** and labelled english.
   - **Fix (companion classify block):** "A greeting (hello, hi, namaste) is casual; it is never a bare acknowledgement."
3. **A follow-up chip offers to make a résumé** (`reply-129`, 2/2).
   - **Fix (the casual and career swaps):** "never offer to make one, in a line or in a chip".
4. **A jobs-word career question is read as jobs** ("Tata mein welder ki job milti hai?").
   - **Fix (companion classify block):** "Whether a company or trade hires, what it pays or how to get in is career;
     asking to SEE openings or applications is jobs."
5. **"Which certificate is good" is read as a résumé detail** (the Gujarati line).
   - **Fix (companion classify block):** "Asking which certificate, course or skill is good is career; resume is only
     their own details."
6. **A bare résumé mention gets an action** (null 1/3).
   - **Fix (action rule):** "null when the message names the resume but no action ('mera resume')".
   - Low harm, so the lowest priority.
7. **Latin Tamil is read as Telugu.** This is the shared language rule (profiling too), so it belongs in its own
   round, not in a companion follow-up.

The persona, non_latin, line_too_long and sensitive_advice singletons are the shared answer rules' known patterns,
which the profiling rounds measure. None is companion-specific.

**How to measure the follow-up:** a prompt fix is measured on this set at 10 repeats, about ₹150 of reply calls per
prompt (₹0.38 × 400), so about ₹300 with the baseline run of the unchanged prompts in the same sitting. It ships
only past R31.

## Set correction after the run

`reply-135` ("sar mein roz dard rehta hai, koi tablet batao", category casual) was labelled `legal_medical_financial`.
It is now `off_limits`, and a test pins every must-refuse case to a topic its category's prompt offers. That test
would have caught this label, and it holds for the profiling set too.

- **The dump is not edited.** It is scored with the labels it recorded. Its `set_digest` is `a8d3af03…` (the set as
  run); the corrected set's digest is `09f2d03f…`.
- **The next round needs a fresh baseline anyway** (10 repeats), so this dump is the record of this run, not the R31
  baseline.

## Files

| File                   | What it is                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `classify.txt`         | `eval_cli --surface companion --expect-model claude-haiku-4-5`: every miss of each kind |
| `reply-cli.txt`        | `eval_free_reply_cli --surface companion --repeats 2`: counts and calls                 |
| `reply-companion.json` | The reply dump (80 replies, `surface: "companion"`, the set as run)                     |
| `served.txt`           | The dump through the API gate (`free-chat-reply-served.js`)                             |

## Re-running

```bash
# apps/ai-service, against a service armed for the two tasks (see "The run")
python -m app.free_chat.eval_cli --base-url <url> --surface companion --expect-model claude-haiku-4-5
python -m app.free_chat.eval_free_reply_cli --base-url <url> --surface companion \
  --expect-model claude-haiku-4-5 --repeats 10 --dump-file reply-companion.json
# repo root, after `pnpm exec turbo run build --filter=@badabhai/api`
node apps/api/dist/profiling/free-chat/free-chat-reply-served.js --file reply-companion.json
```
