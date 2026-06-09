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
- **Everything is optional in dev.** No LiteLLM key, no Langfuse key, no Google
  project required to run and test the service.

## Components (`apps/ai-service`)

| Area | Module | Responsibility |
| --- | --- | --- |
| Routing | `app/ai/model_config.py` | task → model tier, token limits, retries, INR cost table |
| Router | `app/ai/router.py` | mock-vs-real gating, retries, returns `(content, AICallMetadata)` |
| Cost | `app/ai/cost_tracker.py` | token/cost estimate + `cost_alert` / `above_target` flags |
| Tracing | `app/ai/langfuse_tracing.py` | optional Langfuse; safe no-op when keys/package missing |
| LiteLLM | `app/ai/litellm_client.py` | real call (lazy import; real mode only) |
| Privacy | `app/pseudonymize.py` | mask phone/name/employer/city/IDs; fail-closed |
| Interview | `app/profiling/interview_engine.py` + `question_bank.py` + `prompts.py` | bada-bhai chat, one question at a time |
| Extraction | `app/profiling/signals.py` + `profile_extractor.py` | messy text → `WorkerProfileDraft` (+ legacy `DraftProfile`) |

## `AI_ENABLE_REAL_CALLS` behavior

Real calls require **both** the flag and a LiteLLM key (fail closed):

```
real_calls_enabled = AI_ENABLE_REAL_CALLS == true
                     AND LITELLM_API_KEY is set
                     AND LITELLM_BASE_URL is set
```

- **Mock mode** (`false`): the router returns the caller's deterministic
  `mock_response`, logs estimated tokens/cost, and exercises every contract. No
  network, no keys needed.
- **Real mode** (`true` + key): the router calls LiteLLM with the routed model,
  captures real token usage, traces to Langfuse (if configured), validates the
  response, and **falls back to the mock on any failure** (never raises).

A single request can also opt out via `real_call_allowed=false`.

## Model routing

| Task | Tier | Model (default) | Notes |
| --- | --- | --- | --- |
| `profiling_chat_turn` | cheap | `DEFAULT_CHEAP_MODEL` | short (256 tok), warm, 0 retries |
| `profile_extraction` | capable | `DEFAULT_CAPABLE_MODEL` | strict JSON, 2 retries |
| `resume_generation` | cheap | `DEFAULT_CHEAP_MODEL` | runs in mock mode too |

Model names are env-driven, so routing changes need no code change. Recommended
defaults: `DEFAULT_CHEAP_MODEL=gemini-flash-lite`,
`DEFAULT_CAPABLE_MODEL=claude-haiku-or-gemini-flash`.

## Cost tracking

Every call returns `AICallMetadata`: `ai_call_id`, `task_type`, `model_name`,
`provider`, `real_call`, `input_tokens`, `output_tokens`, `estimated_cost_inr`,
`latency_ms`, `success`, `error_code`, `cost_alert`, `above_target`,
`created_at`. It is logged as structured JSON and returned to the backend so it
can later be persisted onto `ai_jobs` / `events`.

Guardrails (INR): `cost_alert=true` when the estimate exceeds
`AI_COST_ALERT_PROFILE_INR` (default 6); `above_target=true` when it exceeds
`AI_TARGET_PROFILE_COST_INR` (default 4). Phase 1 only **flags** — no external
alerting yet.

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

1. `pip install -r requirements-ai.txt` (adds `litellm`, `langfuse`).
2. Set `AI_ENABLE_REAL_CALLS=true`, `LITELLM_BASE_URL`, `LITELLM_API_KEY`.
3. (Optional) Langfuse keys for tracing; Google/Gemini vars for Vertex via LiteLLM.
4. Keep keys backend-only — never in web/Flutter or any `NEXT_PUBLIC_*`.

### Adding Gemini / Vertex

Point `DEFAULT_CHEAP_MODEL` / `DEFAULT_CAPABLE_MODEL` at LiteLLM Gemini/Vertex
model ids and set `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` (and
`GEMINI_API_KEY` for the API-key path). LiteLLM handles provider auth; no app
code change is required.

## What NOT to send to an LLM

Phone numbers, full names, home addresses, employer/company names, ID documents
(Aadhaar/PAN), or any free text that still contains them. The gateway enforces
this and fails closed; do not bypass it.
