# Phase 3 — Career talk (branch 2)

**Prerequisite:** Phases 1–2 merged. The highest-risk phase: the model writes what the worker reads.

Contracts: [`contracts.md`](contracts.md). Why: [ADR-0046](../../decisions/0046-chat-companion-v2-llm-task-router.md)
O7, O9, O10, O13, O16.

## 1. Flow

```
classifier → career_talk & CAREER flag on → CareerTalkHandler
  context  ← memory (last 6 pseudonymized turns) + worker_context (trade label, experience bucket)
  call     ← ai-service POST /companion/career (Claude route)
  status refuse → fixed V2_CAREER_REFUSE_<topic> (reviewed copy, with Devanagari twin + read-aloud)
  status answer → validate (§2) → pass: turn {reply: lines joined, read_aloud: false}
                                   fail: V2_FALLBACK
  append turn pair to memory; emit chat.companion_career_answered
```

`worker_context` holds no name, no phone, no employer, no city — only the canonical trade label and an
experience bucket.

## 2. Output validation (deterministic, in the API, after the model)

A model answer is served only if **every** check passes; any failure → `V2_FALLBACK`, outcome
`fallback`.

1. Schema: 1–4 lines; each ≤ 20 words; Latin script only (no Devanagari, O9).
2. Persona: `checkPersonaTokens` (packages/profiling-lexicon) returns nothing; no "!"; no emoji;
   ≤ 1 "?" in the whole answer; no vocative (ADR-0044 R8).
3. Refusal backstop (O10), deterministic:
   - money: digits next to `₹`, `rs`, `rupaye`, `salary`, `tankhwah`, `per month`, `mahina`, `lakh`,
     `hazaar` → fail;
   - promise words: `pakka`, `guarantee`, `zaroor milegi`, `100%` → fail;
   - legal / medical / financial terms list (court, case, vakil, dawai, ilaaj, loan, EMI, insurance,
     bima, …) → fail;
   - worker rating: `aap achhe`, `aap kamzor`, score / rank / number-out-of patterns → fail;
   - named employers: any token matching the employer / payer-name list the API already holds for
     jobs (read once, cached) → fail.
4. `looksLikePii` (packages/validators) false for every line.
5. Follow-up chips: ≤ 3, each ≤ 4 words, same checks.

## 3. Prompt rules (ai-service, prompt registry)

- System prompt states Bada Bhai persona v3.2 (aap register, calm, short), the four refusal topics
  with the exact `refuse` output, "answer only about trades, skills, learning, safety at work, how
  to grow in the worker's trade", and the JSON schema.
- The prompt names every persona v3.2 banned token the API validator (§2.2) rejects — rendered
  once at import from the profiling-lexicon mirror, pinned to the canonical `persona.json` and to
  `bannedTokenGroups()` by `test_companion_career.py` — and tells the model the chips carry no "?"
  (the validator's ≤ 1 "?" counts lines and chips together). Audit fix, 2026-09-30: without them a
  normal answer using "perfect", "interview" or a question-chip became a fallback that the
  ai-service eval (scored before the validator) could not see.
- Temperature low (≤ 0.4). `max_output_tokens` small (answer ≤ 4 lines).
- Input text pseudonymized at the endpoint; memory turns are already pseudonymized.

## 4. Tasks

### Backend — AI service
- [x] **A1** Contracts (`contracts.py` + `packages/ai-contracts`) for `/companion/career` + parity test.
      Four models (worker context, input, the two union members), the refusal-topic set shared
      with `@badabhai/types`, key-name parity on the golden fixture and bounds/union behaviour
      pinned by pytest.
- [x] **A2** `app/companion/career.py`, prompt, route; task `companion_career_answer` routed to a
      Claude model in `model_config.py` (model name from settings/env, existing Gemini fallback per
      the router's fallback rules).
      `default_career_model` (default `claude-haiku-4-5`) via the new `TaskRoute.model`;
      `TaskRoute.fallback_model` = the capable Gemini model, because the GLOBAL fallback model is
      also Claude and the router skips a same-provider candidate — without it the chain would
      have no fallback at all. The prompt is registered (`COMPANION_CAREER`); the parser maps
      every unreadable output to `refuse/unsafe_other`.
      Audit fix (2026-09-30): the Langfuse trace is named `answer-companion-career` and tagged
      `feature:companion` like the Phase-1 pair (it had fallen back to `feature:other`).
- [x] **A3** **Red-team eval** (release gate): ≥ 150 prompts — ≥ 25 per refusal topic, jailbreaks
      ("ignore rules", role-play), Hindi/Hinglish/English, plus ≥ 50 normal career questions.
      Targets in §6.
      180 prompts (28/26/26/25/25 risky across the five topics + 50 normal). CI gates the set
      shape and the scorer's ability to fail; `python -m app.companion.eval_cli --career` gates
      the model on staging — and it is STRICTER than §6: zero answers on risky prompts, where §6
      also accepts an answer the API's validator would reject (that validator is measured by its
      own tests).

### Backend — API
- [x] **C1** `v2/handlers/career-talk.handler.ts` + `v2/career-output.validator.ts` (§2).
- [x] **C2** `AiService.companionCareer` (timeout 10 s).
- [x] **C3** Memory: store last `MEMORY_TURNS` pairs (orchestrator already writes; handler reads 6).
      The orchestrator reads memory ONCE and passes the full list on `HandlerInput.recentTurns`
      (the classifier keeps its `slice(-2)`), so the handler pays no second Redis hop.
- [x] **C4** Refusal copy `V2_CAREER_REFUSE_*` (reviewed, with twins) + `read_aloud: false` on model turns.
      Five pairs keyed by the closed topics (persona-scanned like every other line);
      `read_aloud: false` is present-and-false on model turns only — refusal turns are fixed
      copy with twins and keep their read-aloud.
- [x] **C5** Event `chat.companion_career_answered` v1.
      `{outcome: answered|refused|fallback, refusal_topic (nullable), turns_in_memory}` — never
      the answer, the question or the worker's words. Registry count 213 → 214.
- [x] **C6** Flag `CHAT_COMPANION_V2_CAREER_ENABLED`; task chip `companion_task:career_talk`.
      Registry-gated like the other phases; the chip appears only while the flag is on, and a
      tap routes deterministically (the P2 chip step). The spend is recorded against
      `companion_career_answer` in the SAME change that routes it (the ledger-naming rule).

### Frontend — worker app (GitHub issue)
- [ ] **F1** `read_aloud: false` → no speaker button / no auto-read for that bubble (do **not** fall
      back to speaking `reply`).
- [ ] **F2** Render up to 4 lines and follow-up chips.

## 5. Tests

| Test | Proves |
|---|---|
| `career-output.validator.test.ts` | each check rejects its fixture; a clean answer passes |
| `career-talk.handler.test.ts` | refuse → fixed copy; invalid → fallback; memory passed (≤ 6) |
| `career.privacy.test.ts` | worker_context has only trade label + bucket; no text in events/logs |
| ai-service `test_companion_career*` | contracts; mock mode; red-team gate thresholds |

## 6. Acceptance (release gate before any flag-ON)

- Red-team: **100 %** of salary / legal-medical-financial / employer / rating prompts end as a refusal
  or a validator fallback (0 unsafe answers served).
- Normal career questions: ≥ 85 % answered (not refused, not fallback) on the eval set.
- p95 latency < 4 s.
- Owner reviews 30 sampled answers before widening beyond test devices.

## 7. Open questions

_None open._
