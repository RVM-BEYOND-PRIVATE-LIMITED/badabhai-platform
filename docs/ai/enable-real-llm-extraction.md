# Enabling the real LLM path for ONE role (profile_extraction)

A controlled, staging-first runbook for turning on real model calls for **just
the canonicalization (`profile_extraction`) task**, while every other task stays
on the mock path. This is the first real-LLM rollout; treat it as an escalation
(real keys + spend — CLAUDE.md §2.5/§7).

> **The repo default stays mock.** `AI_ENABLE_REAL_CALLS=false` and
> `AI_REAL_CALL_TASKS=` (empty) are committed. Real calls are turned on **only**
> by setting environment variables in **staging** with a real key — never in the
> repo, never on a dev laptop, never against production worker data.

## Why this is safe to do now

- **Spine is locked + idempotent:** spine-wide RLS + REVOKE (TD20), PII encrypted
  at rest (TD21/ADR-0004), idempotent events (TD18) and idempotent profile
  creation (TD14) — so a retried/duplicated extraction can't corrupt state.
- **Pseudonymization fails closed before the call:** `/profile/extract`
  pseudonymizes the transcript first; if it blocks, the endpoint returns
  `extraction_status="blocked"` and the router/LLM is never reached
  (`test_profile_extract_fails_closed_on_unsafe_input`).
- **Per-task gate:** real calls can be scoped to a single task, so chat and
  resume generation keep running mock while only extraction goes real.
- **Hard cost ceiling + alerts** are enforced per call (`AI_MAX_CALL_COST_INR`).

## The per-task gate

`app/config.py` → `real_call_enabled_for(task_type)`:

```
real(task) = AI_ENABLE_REAL_CALLS               # master flag
             AND LITELLM_API_KEY is set          # + base url
             AND (AI_REAL_CALL_TASKS is empty OR task in AI_REAL_CALL_TASKS)
```

So `AI_REAL_CALL_TASKS=profile_extraction` makes **only** extraction real; an
empty allowlist keeps the previous "all tasks" behavior (backward compatible).

## Staging rollout steps

1. **Install real deps** (adds `litellm`, `langfuse`):
   ```bash
   pip install -r requirements-ai.txt
   ```
2. **Set staging env** (never commit these):
   ```bash
   AI_ENABLE_REAL_CALLS=true
   AI_REAL_CALL_TASKS=profile_extraction        # ONLY canonicalization goes real
   LITELLM_BASE_URL=<your litellm gateway>
   LITELLM_API_KEY=<staging key>
   DEFAULT_CAPABLE_MODEL=<gemini-flash | claude-haiku | ...>   # extraction tier
   # Cost guardrails (INR):
   AI_TARGET_PROFILE_COST_INR=4
   AI_COST_ALERT_PROFILE_INR=6
   AI_MAX_CALL_COST_INR=10
   # Observability (so cost/profile shows in Langfuse over pseudonymized text only):
   LANGFUSE_PUBLIC_KEY=<...>
   LANGFUSE_SECRET_KEY=<...>
   ```
3. **Confirm the gate** at boot: `GET /health` →
   `real_calls_enabled: true`, `langfuse_enabled: true`. Then a chat turn must
   still be `is_mock: true` (only extraction is allowlisted).
4. **Validate canonicalization ≥ 90%** with the eval harness
   (`tests/test_canonicalization_eval.py`): point its `extract_fn` at a client
   that calls `POST /profile/extract` (real) instead of the heuristic, run over
   `CASES`, and require `evaluate()` accuracy ≥ `THRESHOLD`. Use **fabricated
   test transcripts only.**
5. **Watch cost/profile in Langfuse:** each call traces `task_type`, `model`,
   `real_call`, latency, and the INR estimate — over **pseudonymized text only**.
   Confirm per-profile cost is within target and no `cost_alert` fires.

## Rollback (instant, no deploy)

Set either `AI_ENABLE_REAL_CALLS=false` **or** clear `AI_REAL_CALL_TASKS` →
extraction immediately returns to the deterministic mock path. The router also
**falls back to mock on any model failure** and **refuses** a call whose
worst-case cost exceeds `AI_MAX_CALL_COST_INR`.

## Invariants that still hold (do not bypass)

- No raw PII to the LLM — pseudonymization runs first and fails closed.
- LLM **assists**, never decides — extraction canonicalizes; it does not rank/match.
- Keys are backend/staging-only — never in `NEXT_PUBLIC_*`, web, or the worker app.
- Test data only until a DPDP/spend sign-off for production.
