# BadaBhai AI Service (FastAPI)

Python AI service for Phase 1. Its defining responsibility is the
**pseudonymization gateway**: PII is replaced with request-scoped placeholder
tokens BEFORE any LLM call, and the service **fails closed**.

## Endpoints

| Method | Path                  | Purpose                                              |
| ------ | --------------------- | --------------------------------------------------- |
| GET    | `/health`             | liveness + whether real LLM calls are enabled       |
| POST   | `/pseudonymize`       | mask PII → placeholder tokens (or `blocked=true`)   |
| POST   | `/profiling/respond`  | one profiling turn (pseudonymize → mock/LLM)        |
| POST   | `/profile/extract`    | structured draft profile from a transcript          |
| POST   | `/resume/generate`    | name-less text resume from a structured profile     |

## Privacy & safety invariants

- **Pseudonymize first.** Every endpoint that could reach an LLM runs
  `pseudonymize()` before anything else.
- **Fail closed.** On oversize input, parsing errors, or a residual numeric
  sequence that looks like un-masked PII, the gateway returns `blocked=true` and
  the LLM is never called.
- **Mapping is request-scoped.** The original↔token mapping is never persisted or
  returned — callers only see labels like `[PERSON_1]`.
- **Real LLM calls are gated.** Disabled unless `AI_ENABLE_REAL_CALLS=true` AND
  `GEMINI_FLASH_API_KEY` is set (the master gate). Default: mock responses (`is_mock=true`).

The Pydantic contracts in `app/contracts.py` mirror `@badabhai/ai-contracts`.

## Setup & run

```bash
cd apps/ai-service
python -m venv .venv
. .venv/Scripts/activate        # macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8000   # http://localhost:8000/health
```

## Tests

```bash
pytest                 # all tests
pytest tests/test_pseudonymize.py   # gateway only (stdlib — no fastapi needed)
```

> The pseudonymization core (`app/pseudonymize.py`) has **no third-party
> dependencies**, so its tests run even if FastAPI/pydantic wheels are
> unavailable for your Python version.

## Drive the interview from a terminal (production path)

`app/cli/onboarding_chat.py` lets you sit at a terminal and run the worker-profiling
interview **exactly as production runs it**. It does not call the interview engine or
the extractor directly: every turn is a real `POST /profiling/respond` and the profile
is a real `POST /profile/extract` against `app.main:app`, driven in-process with
`fastapi.testclient.TestClient` (ASGI — **no server, no socket, no DB, no Node**).
Parity is therefore structural, not a claim: the pseudonymization gate, the Pydantic
contracts, the clarify-vs-advance branch and the router call are the deployed code.

```bash
cd apps/ai-service
python -m app.cli.onboarding_chat                      # interactive, full per-turn trace
python -m app.cli.onboarding_chat --trace              # + raw request/state/ai_metadata
python -m app.cli.onboarding_chat --quiet              # conversation only
python -m app.cli.onboarding_chat --edge-cases         # scripted suite; non-zero exit on failure
python -m app.cli.onboarding_chat --script scripts/sample-interview.txt
python -m app.cli.onboarding_chat --http http://localhost:8000   # a RUNNING ai-service
```

Per turn it prints the raw message, the pseudonymized text that would reach a model
(or the BLOCK), the engine's decision (advance vs clarify + ask counts), what the
detector found vs what was collected vs what was **discarded and why**, the
answered / essential / MUST_ASK state, and whether the reply came from a **real model
call or the mock** — with `AI_ENABLE_REAL_CALLS` unset, everything is mock and the
trace says so on every line.

Two things it deliberately shows that are easy to miss:

- the extraction transcript is assembled the way `profile-extraction.processor.ts`
  `buildTranscript` assembles it — **both** directions, so Bada Bhai's own questions
  are part of the extractor's input;
- a message the gate BLOCKS is still stored (`chat.service.ts` inserts the inbound row
  before the AI call), so it is in that transcript.

The `merge_collected` view (question-attributed answers merged onto the draft) is
printed **separately and labelled**: `merge_collected` has no caller in the production
path, so that view is CLI-only and the endpoint's own profile is the headline result.

`--edge-cases` runs ~49 scripted cases (fabrication probes, exclusions/refusals,
origin-vs-preference, vague answers, Devanagari, privacy/fail-closed, robustness,
extraction, flow) with expected-vs-actual and a PASS/FAIL summary. Known open defects
are asserted as **current** behaviour and labelled (e.g. `TD98`, `R30`); if one stops
reproducing the suite reports `STALE` and exits non-zero so the expectation gets
updated instead of silently lying.

## Real STT (Sarvam)

`POST /` transcription uses the **mock** transcript by default. The **real**
Sarvam Speech-to-Text path is wired but gated and **fails closed** (an empty,
never-fabricated transcript on any failure — it never falls back to mock text).

Real STT requires:

- `AI_ENABLE_REAL_CALLS=true` and `SARVAM_API_KEY` (the flag + key gate the call);
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — the AI service fetches the
  uploaded voice audio from a PRIVATE Supabase bucket (Storage Mode A,
  service-role) before transcribing. Missing storage config fails CLOSED to empty;
- optional `VOICE_NOTES_BUCKET` (default `worker-voice-notes`) and
  `SARVAM_STT_MODEL` (default `saarika:v2.5`).

The Sarvam sync endpoint accepts clips **under 30s** only; longer audio fails
closed (the duration guard fires before any upload/spend). Batch/chunking for
>30s clips is future work. Audio bytes, transcripts, and secrets are never logged
and never appear in any raised error message.

### Translate to English (Sarvam)

An optional step translates the (spoken-language) transcript to English via Sarvam
`/translate` (`mayura:v1`, code-mixed mode for Hinglish/romanized source). It is
gated by the **same** `AI_ENABLE_REAL_CALLS` + `SARVAM_API_KEY` as STT, mock by
default (a deterministic, PII-free English gloss), and **fails closed**: any
failure yields an empty English string with `error_code=translate_call_failed` —
never a fabricated translation, never a fall back to the mock text. Optional
`SARVAM_TRANSLATE_MODEL` (default `mayura:v1`).

- When the source is **already English** the call is **skipped** (no API spend) —
  the transcript is returned as-is, marked real (not mock).
- `mayura:v1` caps a single request at **1000 chars**; a longer transcript fails
  closed (the cap fires before any network call; chunking is future work).
- The raw transcript may contain PII — this is the same exposure class as the STT
  call. The input, the translation, and the key are **never logged** and never
  appear in any raised error message.

Terminal usage (mirrors the STT smoke tool) — translation runs by default, the
same as the production `/voice/transcribe` flow:

```bash
python -m app.cli.stt_smoke --file <clip>                 # transcribe, then translate (default)
python -m app.cli.stt_smoke --file <clip> --no-translate  # transcribe only
```

## Observability (Langfuse)

Every AI boundary the service crosses is traced: the router's LLM calls, the skill
embeds, and the voice STT + translate hops. Tracing is **optional** — it initializes
only when both keys are present *and* the v4 SDK is installed, and is a safe no-op
otherwise, so local dev, CI and mock mode never depend on it.

```bash
pip install -r requirements-ai.txt        # brings in langfuse>=4.14,<5.0
# then in .env:
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com   # US cloud: https://us.cloud.langfuse.com
LANGFUSE_TRACING_ENVIRONMENT=staging           # keeps staging out of prod dashboards
```

`/health` reports `langfuse_enabled` — whether tracing is *actually* live, not just
configured.

**Trace shape.** One trace per unit of AI work, named for the action it performs:

```
extract-worker-profile                 [span]        user=<worker_ref>  tags=feature:profiling, real-call
├── llm-call                           [generation]  model=gemini-2.5-flash  level=ERROR  status=http_5xx
└── llm-call                           [generation]  model=gemini-2.5-flash  usage={input:214, output:63}

transcribe-voice-note                  [span]        user=<worker_ref>  tags=feature:voice
├── transcribe-audio                   [generation]  model=saarika:v2.5
└── translate-to-english               [generation]  model=mayura:v1

embed-skill-aliases                    [span]        tags=feature:taxonomy
└── embed-text                         [embedding]   model=mock-embedding   (xN)
```

One generation **per provider attempt**, so a retry chain and a cross-provider
fallback are both visible. A failed attempt is `level=ERROR` carrying its closed-set
transport reason; a call that never reached a provider (spend cap, per-call ceiling,
kill switch) is `level=WARNING` on the trace root. That split matters here because
`AIRouter.run` never raises — every terminal state returns a 200 with a mock body, so
without the level a provider outage looks exactly like deliberate mock mode.

**Privacy.** Only pseudonymized text is ever traced (the endpoint gate runs first),
and `app/ai/langfuse_tracing.py` masks *again* on export, failing closed: a payload
the gate refuses is replaced wholesale rather than shipped. The voice route is
stricter still — raw worker speech (`transcript_text`, `english_text`) is **never**
traced, only counts; the one text it does record is the already-masked payload
actually sent to Sarvam.

**Cost.** Model id + token counts go on the generation, so Langfuse prices calls from
its own table. Our `estimated_cost_inr` goes in metadata and never in `cost_details`,
which is denominated in USD.

## TODO (later phases)

- Replace heuristic PII detection with NER / LLM-assisted detection.
- Add a cumulative/daily spend cap + retry budget at the `cost_tracker`/`AIRouter.run`
  seam (TD27); real model calls already go direct to Gemini → Claude ([ADR-0008](../../docs/decisions/0008-litellm-to-direct-providers.md)).
- Batch/chunked STT for clips over the 30s Sarvam sync limit.
- Group related traces into Langfuse **sessions**. Blocked on the contracts, not the
  tracer: `ProfileParseInput` / `ProfileExtractionInput` carry a `worker_ref` but no
  conversation id, so extraction, parse and résumé for one interview are three
  traces tied together only by `user_id`. `LangfuseTracer.task` already accepts a
  `session_id` — wiring it is a one-line change once a caller has one to pass.
- Per-chunk STT observations. A 120s note is up to 5 Sarvam calls; today the trace
  records `chunk_count` on one generation rather than one child per chunk.
