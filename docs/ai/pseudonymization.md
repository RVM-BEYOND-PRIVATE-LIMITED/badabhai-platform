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

## Phase 1 limitations / TODO

- Detection is **heuristic** (regex + small gazetteers). Over-masking is the safe
  direction. Real NER / LLM-assisted detection comes later.
- Names rely on cue phrases + a leading-name heuristic; will improve with NER.
- The `LlmAdapter` (`app/llm.py`) is a placeholder and only reachable AFTER
  pseudonymization succeeds; real calls require `AI_ENABLE_REAL_CALLS=true` + key.
