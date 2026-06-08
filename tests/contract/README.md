# Contract Tests (placeholder)

Keep the cross-language contracts in sync:

- `@badabhai/ai-contracts` (Zod) ↔ `apps/ai-service/app/contracts.py` (Pydantic)
- `@badabhai/event-schema` payloads ↔ the `events` table columns

TODO: add a generator/checker (e.g. emit JSON Schema from both sides and diff).
