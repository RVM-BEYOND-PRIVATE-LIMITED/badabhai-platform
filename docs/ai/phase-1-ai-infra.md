# Phase 1 — AI Infrastructure

This document describes the BadaBhai Phase-1 AI foundation: controlled model
routing, cost tracking, optional Langfuse tracing, the mandatory
pseudonymization gateway, the CNC/VMC worker-interview chat, and the messy-text →
clean-profile pipeline.

Scope is **worker profiling only**. No employer/job-posting/unlock/payments/
matching logic lives here.

## TL;DR

- **Mock mode is the default.** `AI_ENABLE_REAL_CALLS=false` → no external LLM
  call is ever made; deterministic responses + estimated cost are returned.
- **Pseudonymization runs first, always.** If it blocks, the LLM is never called
  and a safe fallback is returned (fail closed).
- **Everything is optional in dev.** No Gemini key, no Anthropic key, no Langfuse
  key required to run and test the service.

## Components (`apps/ai-service`)

| Area | Module | Responsibility |
| --- | --- | --- |
| Routing | `app/ai/model_config.py` | task → model tier, token limits, retries, INR cost table |
| Router | `app/ai/router.py` | mock-vs-real gating, retries, returns `(content, AICallMetadata)` |
| Cost | `app/ai/cost_tracker.py` | token/cost estimate + `cost_alert` / `above_target` flags |
| Tracing | `app/ai/langfuse_tracing.py` | optional Langfuse; safe no-op when keys/package missing |
| Providers | `app/ai/providers.py` + `gemini_client.py` + `anthropic_client.py` | direct provider transports (Gemini REST primary, Claude SDK fallback); real mode only (ADR-0008) |
| Privacy | `app/pseudonymize.py` | mask phone/name/employer/city/IDs; fail-closed |
| Interview | `app/profiling/interview_engine.py` + `question_bank.py` + `prompts.py` | bada-bhai chat, one question at a time |
| Extraction | `app/profiling/signals.py` + `profile_extractor.py` | messy text → `WorkerProfileDraft` (+ legacy `DraftProfile`) |

## `AI_ENABLE_REAL_CALLS` behavior

Real calls require **both** the flag and the Gemini key (fail closed):

```
real_calls_enabled = AI_ENABLE_REAL_CALLS == true
                     AND GEMINI_FLASH_API_KEY is set   # master gate (ADR-0008)
```

(`ANTHROPIC_API_KEY` is optional — its presence only ADDS the Claude Haiku
fallback candidate; it is never a master gate.)

**Per-task gate (enable ONE role at a time).** `AI_REAL_CALL_TASKS` is an
optional comma-separated allowlist; a real call also requires the task to be
allowlisted:

```
real(task) = real_calls_enabled
             AND (AI_REAL_CALL_TASKS is empty OR task in AI_REAL_CALL_TASKS)
```

Empty = all tasks (backward compatible). Set
`AI_REAL_CALL_TASKS=profile_extraction` to make only canonicalization real while
chat/resume stay mock — see the staging rollout in
[enable-real-llm-extraction.md](enable-real-llm-extraction.md).

- **Mock mode** (`false`): the router returns the caller's deterministic
  `mock_response`, logs estimated tokens/cost, and exercises every contract. No
  network, no keys needed.
- **Real mode** (`true` + key): the router calls the provider **directly** with the
  routed model (Gemini primary → Claude Haiku fallback), captures real token usage,
  traces to Langfuse (if configured), validates the response, and **falls back to
  the next candidate then the mock on any failure** (never raises).

A single request can also opt out via `real_call_allowed=false`.

## Model routing

| Task | Tier | Model (default) | Notes |
| --- | --- | --- | --- |
| `profiling_chat_turn` | cheap | `DEFAULT_CHEAP_MODEL` | short (256 tok), warm, 0 retries |
| `profile_extraction` | capable | `DEFAULT_CAPABLE_MODEL` | strict JSON, 2 retries |
| `resume_generation` | cheap | `DEFAULT_CHEAP_MODEL` | runs in mock mode too |

Model names are env-driven, so routing changes need no code change. Defaults:
`DEFAULT_CHEAP_MODEL=gemini-2.5-flash-lite`,
`DEFAULT_CAPABLE_MODEL=gemini-2.5-flash`, with `DEFAULT_FALLBACK_MODEL=claude-haiku-4-5`
(the cross-provider fallback, used only when `ANTHROPIC_API_KEY` is set).

## Cost tracking

Every call returns `AICallMetadata`: `ai_call_id`, `task_type`, `model_name`,
`provider`, `real_call`, `input_tokens`, `output_tokens`, `estimated_cost_inr`,
`latency_ms`, `success`, `error_code`, `cost_alert`, `above_target`,
`created_at`. It is logged as structured JSON and returned to the backend so it
can later be persisted onto `ai_jobs` / `events`.

Guardrails (INR), three levels:

| Env var | Default | Effect |
| --- | --- | --- |
| `AI_TARGET_PROFILE_COST_INR` | 4 | soft target — sets `above_target=true` (flag only) |
| `AI_COST_ALERT_PROFILE_INR` | 6 | alert — sets `cost_alert=true` (flag only) |
| `AI_MAX_CALL_COST_INR` | 10 | **hard ceiling** — a real call whose *worst-case* cost (input tokens + the route's max output tokens) exceeds this is **refused**: no model call is made, the deterministic mock is returned, and `error_code="cost_ceiling_exceeded"` is recorded |

The target/alert are flags only (no external alerting in Phase 1). The ceiling is
an enforced, stateless per-call runaway guard. Per-profile **cumulative** budgets
(across a worker's turns) need a counter/store and are a deferred enhancement.

**Verified live (2026-06-10, mock + gated real):** `/profiling/respond` and
`/profile/extract` return populated `ai_metadata` and log structured `ai_call`
cost lines; with `AI_ENABLE_REAL_CALLS=false` calls are mock (`real_call=false`);
with it `true` the real path engages (`real_call=true`, falling back safely when
the provider call fails); and with a near-zero `AI_MAX_CALL_COST_INR` a real call is
refused (`real_call=false`, `error_code=cost_ceiling_exceeded`). `/health` reports
`real_calls_enabled`, the **actual** `langfuse_enabled` (keys present *and* package
installed), and `max_call_cost_inr`.

## Langfuse

- Enabled only when **both** `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are
  set **and** the `langfuse` package is installed; otherwise a silent no-op.
- Traces `task_type`, `model`, `real_call`, latency, cost estimate — over
  **pseudonymized text only**. Never logs raw phone/name/address/employer.

## Pseudonymization gateway (what NEVER goes to an LLM)

Raw **phone, full name, home address, employer/company name, ID numbers (PAN/
Aadhaar)** are masked to request-scoped placeholders (`[PHONE_1]`, `[PERSON_1]`,
`[EMPLOYER_1]`, `[CITY_1]`, `[ID_1]`) before any external LLM call. The
original↔token map is request-scoped and never persisted or returned.

**Trusted-local vs external boundary.** Deterministic heuristics in
`signals.py` may read *raw* text **inside the service** (no network) to extract
non-identity profile data such as role, machine, city preference, and salary.
Pseudonymization gates only **external** LLM calls. If pseudonymization blocks,
the whole turn/extraction fails closed regardless.

## Endpoints

- `POST /profiling/respond` — one chat turn. Pseudonymize → engine picks the next
  question + updates `conversation_state` → router phrases it (mock/real).
  Returns `assistant_message`, `updated_state`, `asked_question_id`,
  `extraction_ready`, `ai_metadata`, `pseudonymization_metadata`.
- `POST /profile/extract` — messy transcript → clean `worker_profile_draft`
  (rich) + `profile` (legacy `DraftProfile`, taxonomy ids). `extraction_status`
  is `blocked` when pseudonymization fails.
- `POST /resume/generate` — short, name-less worker summary.
- `POST /pseudonymize`, `GET /health`.

Contracts are mirrored: Pydantic (`app/contracts.py`) ↔ Zod
(`packages/ai-contracts`). New fields are additive/optional → backward
compatible with the existing NestJS integration.

## Run + test (mock mode)

```bash
cd apps/ai-service
python -m venv .venv && .venv/Scripts/activate   # (Windows) or source .venv/bin/activate
pip install -r requirements-dev.txt
pytest                                            # all green, no keys needed
uvicorn app.main:app --reload --port 8000
```

Test the chat flow:

```bash
curl -s localhost:8000/profiling/respond -H 'content-type: application/json' -d '{
  "session_id":"s1","message_text":"vmc chalata hu 4 saal se fanuc pe","role_family":"cnc_vmc"
}' | jq

curl -s localhost:8000/profile/extract -H 'content-type: application/json' -d '{
  "transcript":"bhai vmc chalata hu 4 sal se fanuc pe, setting thoda aata hai, drawing pad leta hu, salary 22k, faridabad me hu, pune bhi chalega",
  "role_family":"cnc_vmc"
}' | jq
```

Use fake worker data only. Phone-like numbers will be masked or will fail closed.

## Enabling real calls later

1. `pip install -r requirements-ai.txt` (adds `anthropic`, `langfuse`; Gemini is
   reached over REST with `httpx`, already a base dep — no LiteLLM, no openai SDK).
2. Set `AI_ENABLE_REAL_CALLS=true` and `GEMINI_FLASH_API_KEY` (the master gate).
3. (Optional) `ANTHROPIC_API_KEY` to add the Claude Haiku fallback; Langfuse keys
   for tracing.
4. Keep keys backend-only — never in web/Flutter or any `NEXT_PUBLIC_*`.

### Choosing models

Point `DEFAULT_CHEAP_MODEL` / `DEFAULT_CAPABLE_MODEL` at bare Gemini model ids and
`DEFAULT_FALLBACK_MODEL` at a Claude id; `app/ai/providers.py` dispatches each id to
its direct transport by `provider_for_model`. No app code change is required.
Full staging rollout + the ≥90% eval: [enable-real-llm-extraction.md](enable-real-llm-extraction.md).

## What NOT to send to an LLM

Phone numbers, full names, home addresses, employer/company names, ID documents
(Aadhaar/PAN), or any free text that still contains them. The gateway enforces
this and fails closed; do not bypass it.
