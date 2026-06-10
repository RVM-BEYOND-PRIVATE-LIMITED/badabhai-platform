# Phase-1 AI — Privacy / Security Review

**Date:** 2026-06-10 · **Reviewer:** Prakash · **Gate:** `bb-security-review`
**Scope:** the merged AI foundation — `apps/ai-service/app/**` (interview engine,
`signals.py`, `profile_extractor.py`, `prompts.py`, `ai/router.py`,
`ai/cost_tracker.py`, `ai/langfuse_tracing.py`), which merged without an explicit
privacy gate having run on it.

**Verdict: PASS** (after one High-severity fix, applied in this change).

---

## Invariants checked (CLAUDE.md §2)

| # | Invariant | Result |
| - | --------- | ------ |
| 1 | No raw PII (phone/name/address/employer/ID) in LLM input | ✅ after fix (see F-1) |
| 2 | No raw PII in events / `ai_jobs` / `audit_logs` / logs / Langfuse | ✅ |
| 3 | Pseudonymization runs before every external LLM call, fails closed | ✅ |
| 4 | original↔token mapping never persisted or returned | ✅ |
| 5 | `AI_ENABLE_REAL_CALLS` defaults false; real calls gated + keyed | ✅ |
| 6 | No secrets committed / client-exposed; server·public env split | ✅ |

## Findings

### F-1 — Raw conversation history reached LLM input + Langfuse  ·  High (Critical-when-live)  ·  FIXED

`/profiling/respond` pseudonymized only the **current** message; `body.history`
(prior turns) was passed **raw** into `build_chat_messages`, which appended each
turn verbatim into the LLM `messages`. The router forwards those to LiteLLM (real
mode) and joins them into `input_text` for the Langfuse trace. A prior worker
turn containing a phone/name/employer would therefore reach the model and the
trace.

- Not live today: `AI_ENABLE_REAL_CALLS=false` and Langfuse off by default, so no
  external send occurred. But the input was being **constructed** unsafely.
- **Fix:** `_pseudonymized_history()` in `apps/ai-service/app/main.py`
  pseudonymizes every prior turn before it enters `messages`, and **drops** any
  turn that can't be safely pseudonymized (fail closed). History is phrasing
  context only, so dropping is non-disruptive.
- **Regression test:** `test_conversation_history_is_pseudonymized_before_llm`
  (phone masked, residual-digit turn dropped, safe technical turn kept).

## Notes (reviewed, no action needed)

- **Trusted-local heuristics read raw text.** `signals.py` /
  `profile_extractor.py` run deterministic regex over raw text **inside the
  service (no network)** to read role/machine/city/salary. This is allowed:
  pseudonymization gates only *external* LLM calls, and pseudonymization still
  runs first as the gate (a block fails the turn closed). No identity PII
  (phone/name/employer) is produced by these heuristics.
- **City & salary are profile data, not identity PII.** They appear in
  `WorkerProfileDraft` / `ConversationState.collected` / the rich extract output
  (returned to the worker's own app), but never in events. `profile.extraction_ready`
  carries only topic ids + counts; `ai.cost_recorded` carries ids/model/tokens.
  None carry phone/name/address/employer.
- **Cost logging is PII-free.** `cost_tracker` logs `AICallMetadata` (ids, model,
  tokens, INR estimate) only — no text.
- **Fail-closed verified** on both `/profiling/respond` and `/profile/extract`
  (blocked pseudonymization → safe fallback / `extraction_status="blocked"`, no
  router call).
- **Secrets:** new model/Langfuse/Google keys are backend-only (`server.ts`,
  not `public.ts`); `.env.example` placeholders only; `AI_ENABLE_REAL_CALLS=false`.

## Residual risk

- **RLS not finalized** (R1/TD4) — backend uses the service role; unchanged by
  this review, still contained (Phase-1 deferred).
- Real-mode + Langfuse have **not** been exercised live; re-run this gate before
  enabling either in a shared environment.
