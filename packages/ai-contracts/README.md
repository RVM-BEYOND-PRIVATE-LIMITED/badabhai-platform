# @badabhai/ai-contracts

**Zod contracts** for the request/response boundary between the NestJS API and
the FastAPI AI service:

- `ProfilingTurnInput` / `ProfilingTurnOutput`
- `PseudonymizationInput` / `PseudonymizationOutput`
- `ProfileExtractionInput` / `ProfileExtractionOutput`
- `ResumeGenerationInput` / `ResumeGenerationOutput`
- shared `DraftProfileSchema`

> These are **mirrored as Pydantic models** in
> `apps/ai-service/app/contracts.py`. Keep both sides in sync.

**Privacy:** contracts never carry raw identity. Profiling/extraction inputs pass
through the pseudonymization gateway before any LLM call; resume generation
receives only the structured profile (the backend re-attaches the real name).
