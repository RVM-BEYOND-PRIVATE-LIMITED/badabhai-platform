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

1. **Install real deps** (adds `openai`, `langfuse`):
   ```bash
   pip install -r requirements-ai.txt
   ```
   > The real path uses the lightweight `openai` AsyncOpenAI SDK against an
   > OpenAI-compatible endpoint — **not** litellm. The env vars keep the
   > `LITELLM_*` names for now but feed this OpenAI client (TD: rename to
   > `LLM_*`).
2. **Set staging env** (never commit these). A ready-to-fill, secrets-free
   template lives at
   [`apps/ai-service/.env.staging.example`](../../apps/ai-service/.env.staging.example) —
   copy it into the staging secrets / a staging `.env` and fill the `<...>` placeholders:
   ```bash
   AI_ENABLE_REAL_CALLS=true
   AI_REAL_CALL_TASKS=profile_extraction        # ONLY canonicalization goes real
   # OpenAI-compatible gateway (vars keep LITELLM_* names; feed the openai SDK):
   LITELLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
   LITELLM_API_KEY=<your Gemini API key>
   DEFAULT_CAPABLE_MODEL=gemini-2.0-flash       # extraction tier (bare id, no "openai/" prefix)
   # Cost guardrails (INR):
   AI_TARGET_PROFILE_COST_INR=4
   AI_COST_ALERT_PROFILE_INR=6
   AI_MAX_CALL_COST_INR=10
   # Observability (so cost/profile shows in Langfuse over pseudonymized text only):
   LANGFUSE_PUBLIC_KEY=<...>
   LANGFUSE_SECRET_KEY=<...>
   # Per-field pytest gate target (only the staging pytest run reads this; the
   # CLI uses --base-url). Unset => the real per-field test is SKIPPED.
   AI_EVAL_BASE_URL=http://localhost:8000
   ```
3. **Confirm the gate** at boot: `GET /health` →
   `real_calls_enabled: true`, `langfuse_enabled: true`. Then a chat turn must
   still be `is_mock: true` (only extraction is allowlisted).
4. **Validate canonicalization ≥ 90%** — one command, against the running
   service:
   ```bash
   python -m app.profiling.eval_canonicalization --real
   # custom host:  python -m app.profiling.eval_canonicalization --real --base-url http://localhost:8000
   ```
   This POSTs every case in the tiered Hinglish gold set
   (`app/profiling/canonicalization_gold.py` — the same source of truth the CI
   test imports) to the LOCAL `POST /profile/extract`, reads back
   `canonical_role_id`, scores **all tiers** (`core` / `negative` / `hard`), and
   **exits non-zero if overall accuracy < 90%.** The endpoint pseudonymizes
   first, so this never bypasses the privacy gate, and it makes **no direct
   external LLM call** — only the allowlisted real extraction does. The `hard`
   tier (out-of-vocab spellings, implicit roles, multi-role disambiguation) is
   the bar the **real LLM** must clear that the deterministic heuristic does not.
   **Fabricated test transcripts only — no real worker PII.**

   > Offline regression (no server, deterministic heuristic) is the same command
   > without `--real`; CI runs it via `tests/test_canonicalization_eval.py`,
   > which gates only `core + negative ≥ 90%` and tracks `hard` as informational.

4b. **Validate PER-FIELD accuracy ≥ 90% + attribute misses** — same gold set,
   scores every extracted field (not just role) and classifies each miss:
   ```bash
   python -m app.profiling.eval_canonicalization --per-field --real
   # offline heuristic (no server, no LLM):
   python -m app.profiling.eval_canonicalization --per-field
   ```
   This POSTs each FABRICATED transcript to the LOCAL `POST /profile/extract`
   (and smoke-tests `POST /profiling/respond` so the rig touches both real
   endpoints), reads back the full profile, and scores **per field + an
   aggregate**, exiting non-zero if the aggregate `< 90%`:

   | field             | match semantics                                  |
   | ----------------- | ------------------------------------------------ |
   | `trade` / `role`  | exact taxonomy id (derived trade defaults from role) |
   | `skills`          | subset — all expected skill ids present (extras OK) |
   | `machines`        | subset — all expected machine ids present (extras OK) |
   | `experience`      | years within `±0.5` (`None` = assert no experience) |

   **Miss attribution (TD3 over-masking vs extraction error):** for every miss
   it re-runs the SAME input through `POST /pseudonymize` (the gateway the
   extraction path uses) and checks whether the answer's anchor term — which was
   literally present in the source — survived masking. Anchor *removed by the
   gateway* → **over-masking (TD3)**; anchor *survived but mis-canonicalized*
   (or never present, i.e. implicit/out-of-vocab phrasing) → **extraction
   error**. The report prints the split and the dominant cause. It never inspects
   the original↔token mapping (the endpoint never returns it) and never bypasses
   pseudonymization.

   > CI/local: the same scoring runs as a structural/heuristic test
   > (`tests/test_per_field_eval.py`) with **no network and no LLM**; the live
   > `≥ 90%` assertion (`test_per_field_real_meets_threshold`) is **skipped**
   > unless `real_call_enabled_for("profile_extraction")` is true AND
   > `AI_EVAL_BASE_URL` is set — so CI never makes a real call.
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
