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
- **Real LLM calls are gated.** Disabled unless `AI_ENABLE_REAL_CALLS=true` AND a
  LiteLLM key is set. Default: mock responses (`is_mock=true`).

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

## TODO (later phases)

- Replace heuristic PII detection with NER / LLM-assisted detection.
- Wire `app/llm.py` to LiteLLM (only reachable post-pseudonymization).
- Real Sarvam STT for transcription; Langfuse tracing.
