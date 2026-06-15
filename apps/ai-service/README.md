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

## TODO (later phases)

- Replace heuristic PII detection with NER / LLM-assisted detection.
- Add a cumulative/daily spend cap + retry budget at the `cost_tracker`/`AIRouter.run`
  seam (TD27); real model calls already go direct to Gemini → Claude ([ADR-0008](../../docs/decisions/0008-litellm-to-direct-providers.md)).
- Batch/chunked STT for clips over the 30s Sarvam sync limit; Langfuse tracing.
