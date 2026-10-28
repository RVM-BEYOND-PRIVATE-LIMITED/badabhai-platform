# Free-chat reply: the casual "how are you" rule (#2465), 2026-10-28

Every case here is fabricated. There is no worker data. The JSON dumps hold model output over fabricated input.

**Outcome:** the rule ships under a one-time owner override of R31 (ADR-0051 R49).

## 1. The defect

In the owner's device test on 2026-10-27, right after production moved free chat to `claude-haiku-5-5` (#2464), small
talk did not get a small-talk answer. A local reproduction on a production-mirror service (10 draws each) found the
cause in the reply, not in the classifier:

| Worker typed | Served on the device | Classifier, 10 draws | Reply, 10 draws through the API gate |
|---|---|---|---|
| `aur kya haal hai` | `FREE_CLARIFY` | `casual` 10/10 | served 8, `too_many_questions` 2 |
| `puch raha hu haal chal` | `REPLY_FALLBACK` | `casual` 10/10 | served 9, `too_many_questions` 1 |
| `acha` | `FREE_CLARIFY` | `unclear` 10/10, as designed | none (a clarify) |

A rejected answer looked like `["Main theek hoon, shukriya. Aap kaise hain?", "Aaj ka kaam kaisa raha?"]`: the model
asks the worker back, then adds the greeting rule's question about the day.

On the device, `aur kya haal hai` got `FREE_CLARIFY` because the verdict was unavailable. The classifier reads it as
`casual` 10/10, and the cost log shows a real, successful call. This was the first classify call on a freshly
recreated container, so the cold start most likely ran past the API's hard-coded 2.5 s wait (`ai.service.ts:473`).
That wait is a separate change, not this one.

## 2. The revision

One sentence follows the greeting rule in `CASUAL_SYSTEM_PROMPT`, and the companion casual prompt carries it through
`_swapped`:

> When the worker asks how YOU are ("aap kaise hain", "haal kaisa hai aapka"), say you are fine in one statement,
> then ask ONE question back: how they are OR how their day or work is going, never both. For example "Main theek
> hoon, shukriya. Aapka din kaisa chal raha hai?".

The prompt's worker examples are not the sets' cases (pinned by a test). New cases:
- profiling: `reply-054` and `reply-055` (the device-test turns), `reply-056`, `reply-057`;
- companion: `reply-154`, `reply-155`.

The classifier prompt is byte-identical (`local:56ad200b6337`).

## 3. The run

Main and the revision were scored in one sitting on the new sets, each against a local ai-service from this branch that
mirrors production after #2464:
- the 11-task override on `claude-haiku-5-5`;
- tier defaults `claude-haiku-5-5`;
- fallback `gemini-3.1-flash-lite`.

`--expect-model claude-haiku-5-5`, `--repeats 8`, 1,792 replies. All were real, all served by Haiku 5.5, with 0
failures, 0 mocks and 0 over the API timeout. Spend: ₹20.70 (router estimate). The score is the API gate's
(`free-chat-reply-served.js`).

| Group | Profiling main | Profiling revision | Companion main | Companion revision |
|---|---|---|---|---|
| **Total** | 413/456 | **422/456** | 390/440 | **392/440** |
| casual | 119/120 | 117/120 | 109/128 | **119/128** |
| career (prompt unchanged) | 183/224 | 193/224 | 201/232 | 194/232 |
| identity | 39/40 | 40/40 | 16/16 | 15/16 |
| legal_medical_financial, news, off_limits, distress | 8, 8, 40, 16 | 8, 8, 40, 16 | 16, 16, 24, 8 | 16, 16, 24, 8 |
| `too_many_questions` rejections | 0 | 1 | 17 | 6 |

**Companion greetings** (`too_many_questions`, of 8):

| Case | main | revision |
|---|---|---|
| `hello` | 4 | 3 |
| `namaste Bada Bhai` | 3 | 2 |
| `kya haal chaal hai` | 3 | 0 |
| `tum kaise ho, sab badhiya` | 4 | 0 |

## 4. Why R31 said HOLD, and why it shipped

R31 held on two drops:
- **Profiling casual −2:** two single draws. `namaskar ji` asked two questions once, and `good night` was rejected
  once on `worker_rating`.
- **Companion career −7:** the career prompt is byte-identical. The same unchanged prompt moved +10 on the profiling
  set.

At the forced temperature 1.0 of `claude-haiku-5-5`, a category swings by up to 10 lines between identical runs, so
R31's one-line tolerance sits inside the noise.

The owner shipped it as a one-time override (R49). R31 stands for every later round.

## Files

| File | Contents |
|---|---|
| `reply-baseline.json`, `reply-revision.json` | profiling dumps (main, revision) |
| `companion-reply-baseline.json`, `companion-reply-revision.json` | companion dumps |
| `served-*.txt`, `companion-served-*.txt` | the API gate's replay; `*-vs-baseline` carries R31 |
| `cli-*.txt` | the eval CLI's report for each run |
