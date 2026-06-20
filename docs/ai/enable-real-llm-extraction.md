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

## Transport: direct Gemini (no LiteLLM proxy)

The AI service calls **Google AI Studio (Gemini) directly over REST** with
`httpx` (`app/ai/gemini_client.py`) — there is **no LiteLLM proxy or SDK**. The
single real-call credential is `GEMINI_FLASH_API_KEY`; the extraction model is
`gemini-2.5-flash` (`DEFAULT_CAPABLE_MODEL`). Request/response bodies are never
logged (pseudonymized, but still content) — counts/status only.

## The per-task gate

`app/config.py` → `real_call_enabled_for(task_type)`:

```
real(task) = AI_ENABLE_REAL_CALLS               # master flag
             AND GEMINI_FLASH_API_KEY is set     # direct Gemini key
             AND (AI_REAL_CALL_TASKS is empty OR task in AI_REAL_CALL_TASKS)
```

So `AI_REAL_CALL_TASKS=profile_extraction` makes **only** extraction real; an
empty allowlist keeps the previous "all tasks" behavior (backward compatible).

## Staging rollout steps

1. **Install real-mode deps** (adds `anthropic` + `langfuse`; `httpx` is already a base dep):
   ```bash
   pip install -r requirements-ai.txt
   ```
   > The real path calls Google AI Studio (Gemini) **directly over REST** with
   > `httpx` — **no** litellm and **no** openai SDK. The Anthropic SDK is only the
   > fallback provider (Claude Haiku). The single master credential is
   > `GEMINI_FLASH_API_KEY`; `ANTHROPIC_API_KEY` merely adds the fallback candidate.
2. **Set staging env** (never commit these). A ready-to-fill, secrets-free
   template lives at
   [`apps/ai-service/.env.staging.example`](../../apps/ai-service/.env.staging.example) —
   copy it into the staging secrets / a staging `.env` and fill the `<...>` placeholders:
   ```bash
   AI_ENABLE_REAL_CALLS=true
   AI_REAL_CALL_TASKS=profile_extraction        # ONLY canonicalization goes real
   GEMINI_FLASH_API_KEY=<google ai studio key>  # the single real-call credential
   ANTHROPIC_API_KEY=<anthropic key>            # OPTIONAL — adds the Claude Haiku fallback
   DEFAULT_CAPABLE_MODEL=gemini-2.5-flash       # extraction tier (bare model id)
   DEFAULT_FALLBACK_MODEL=claude-haiku-4-5       # cross-provider fallback (needs ANTHROPIC_API_KEY)
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
   # FREE TIER (low RPM): pace the run so it doesn't mass-429 + fall back to mock:
   python -m app.profiling.eval_canonicalization --per-field --real --min-interval 6
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

   > **Mock-fallback contamination (measurement correctness).** The router
   > **returns mock content on any model failure** (e.g. a free-tier 429), and
   > `/profile/extract` still reports `is_mock: false` because it reflects "a real
   > call was *attempted*", not "the content is real". The rig therefore reads
   > **`ai_metadata.real_call` + `ai_metadata.success`** (NOT `is_mock`): a case
   > with `real_call=true AND success=false` is a **mock fallback**. If ANY scored
   > case fell back, the `--real` run is declared **INVALID** — it prints a loud
   > `INVALID REAL RUN: N/M cases fell back to mock …` banner, exits non-zero, and
   > **does NOT print a PASS/FAIL aggregate**, so a throttled/erroring run can
   > never be mistaken for a real ≥90% (or <90%) result. Fix it by enabling **paid
   > billing** (the clean path) or pacing with **`--min-interval SECONDS`**, then
   > retry. A clean run prints `real calls: N/N succeeded`.
   >
   > CI/local: the same scoring runs as a structural/heuristic test
   > (`tests/test_per_field_eval.py`) with **no network and no LLM**; the live
   > `≥ 90%` assertion (`test_per_field_real_meets_threshold`) is **skipped**
   > unless `real_call_enabled_for("profile_extraction")` is true AND
   > `AI_EVAL_BASE_URL` is set — so CI never makes a real call.
5. **Watch cost/profile in Langfuse:** each call traces `task_type`, `model`,
   `real_call`, latency, and the INR estimate — over **pseudonymized text only**.
   Confirm per-profile cost is within target and no `cost_alert` fires.

## Re-validation on the pinned model (GO/NO-GO Finding 4 — DO THIS before the flip)

**The prod extraction model is PINNED to `gemini-2.5-flash`** (`DEFAULT_CAPABLE_MODEL`,
`app/config.py` default now matches this runbook). The ≥90% gold-set evidence on record was
measured on **Claude Haiku**, and the cost/latency on **flash-lite** — **neither is the pinned
model.** Before the flip, re-validate **on `gemini-2.5-flash`** (human-gated: real paid calls, §7):

1. **Use a FUNDED staging key**, not the dev-box free-tier key (Finding 3 — rotate that; free-tier
   429s fall back to mock and **INVALIDATE** the run). Set in the staging AI-service env:
   ```bash
   AI_ENABLE_REAL_CALLS=true
   AI_REAL_CALL_TASKS=profile_extraction
   DEFAULT_CAPABLE_MODEL=gemini-2.5-flash      # the PINNED model — validate exactly this
   GEMINI_FLASH_API_KEY=<funded staging key>
   ```
2. **Clean 56-case gold-set run on the pinned model** (role + per-field, both must be ≥90%, and the
   rig must print `real calls: N/N succeeded` with **zero mock fallback** or it is INVALID):
   ```bash
   cd apps/ai-service
   python -m app.profiling.eval_canonicalization --real              # role/canonicalization ≥90%
   python -m app.profiling.eval_canonicalization --per-field --real  # per-field aggregate ≥90%
   ```
3. **p95 latency on the pinned model:** each real call traces `model` + `latency` (Langfuse, over
   pseudonymized text only). Measure p95 across the 56-case run (repeat ≥1× for ≥112 samples, or run
   a small concurrent batch for "realistic load"), then **record the p95 number vs target**.
   - Target: extraction is **async (BullMQ `ai_jobs`, off the request hot path)**, so the bar is
     cost/throughput, not interactive latency — **recommend p95 ≤ ~5 s/call** (tune at sign-off).
4. **Record results** in [real-llm-flip-go-no-go.md](real-llm-flip-go-no-go.md) Finding 4: the model
   (`gemini-2.5-flash`), role %, per-field %, `N/N succeeded`, the p95 number, and cost/call.
   **If <90% on `gemini-2.5-flash` → STOP**, do not ship; re-open the model choice (don't silently
   fall back to the Haiku/flash-lite numbers — they don't cover this model).

> Offline pre-check (no key, no spend): `python -m app.profiling.eval_canonicalization --per-field`
> runs the heuristic scorer (core+negative) — confirms the rig + the 56 cases load, but is **NOT**
> the pinned-model validation (the hard tier + the real ≥90% bar need the real calls above).

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
