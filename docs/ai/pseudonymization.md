# AI Safety — Pseudonymization Gateway

The single most important AI-safety control in Phase 1. It lives in the FastAPI
service (`apps/ai-service/app/pseudonymize.py`) and runs **before any LLM call**.

## Contract

- Detects & replaces likely PII with request-scoped placeholder tokens:
  phone → `[PHONE_n]`, person → `[PERSON_n]`, employer → `[EMPLOYER_n]`,
  city → `[CITY_n]`, ID (PAN/Aadhaar) → `[ID_n]`.
- The original↔token **mapping is never persisted or returned** — callers only
  see labels.
- **Fails closed:** returns `blocked=true` on oversize input, parsing errors, or
  a residual long digit run (potential un-masked numeric PII). When blocked, the
  LLM is never called and a safe fallback is returned.

## Example

```
in:  "Rahul, phone 9876543210, worked at ABC Industries in Faridabad"
out: "[PERSON_1], phone [PHONE_1], worked at [EMPLOYER_1] in [CITY_1]"
```

## Current Implementation (2026-07)

- **Detection:** heuristic (regex + small gazetteers). Over-masking is the safe
  direction. Real NER / LLM-assisted detection comes later.
- **Names:** rely on cue phrases + a leading-name heuristic; will improve with NER.
- **Gateway:** `_pseudonymized_history()` in `apps/ai-service/app/main.py`
  pseudonymizes **every prior turn** (not just the current message) before it
  enters `messages`; any turn that can't be safely pseudonymized is dropped
  (fail closed).
- **LLM Adapter / Router:** The `LlmAdapter` / `AIRouter` seam (
  `apps/ai-service/app/ai/router.py`) calls pseudonymization **before** any
  provider dispatch. Real calls require `AI_ENABLE_REAL_CALLS=true` **and**
  `GEMINI_FLASH_API_KEY` (master) / optional `ANTHROPIC_API_KEY` (fallback).
  The LiteLLM adapter was never wired and is retired ([ADR-0008](../decisions/0008-litellm-to-direct-providers.md)).
- **Providers (direct, behind the router):**
  - **Primary:** Gemini 2.5 Flash (`gemini-2.5-flash`) / Flash-Lite (`gemini-2.5-flash-lite`) via REST (httpx)
  - **Fallback:** Claude Haiku 4.5 via Anthropic SDK
  - **Mock:** deterministic fallback used in CI and when real calls are gated off
- **Spend caps (TD27 paid):** Rolling per-UTC-day + cumulative INR caps enforced
  in `cost_tracker.SpendLedger` (Redis-backed, global across Uvicorn workers)
  + per-user/day cap + retry budget + independent kill-switch
  (`AI_REAL_CALLS_KILL_SWITCH`). All fail-closed → mock.

## Phase 1 Limitations / TODO

- Detection is **heuristic** (regex + small gazetteers). Over-masking is the safe
  direction. Real NER / LLM-assisted detection comes later.
- Names rely on cue phrases + a leading-name heuristic; will improve with NER.
- Known gaps (tracked as risks):
  - **R30:** Separator-split phones bypassed the residual-digit net (narrowed 2026-07-17, PR #392: digit-count rule 9–13 digits joined by any separator run; 13/13 shapes covered).
  - **R32:** Names without cue words can leak (e.g., "Chandrashekhar bol raha hu" — 3/4 natural forms unmasked on main). Not live (`AI_ENABLE_REAL_CALLS=false` by default). Must be re-assessed before flag flip.
  - Both tracked in [risks-register.md](../registers/risks-register.md) as Critical-if-live; invariant #5 holds today.