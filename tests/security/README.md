# Security / Privacy Tests (placeholder)

Assert the platform's safety invariants:

- The privacy policy of [ADR-0047](../../docs/decisions/0047-lift-pii-restriction.md):
  raw PII is no longer banned from prompts, logs or events, but no secret is ever
  logged, name and phone stay encrypted at rest, no existing event schema is mutated
  to carry PII, and every place PII is written is reachable by account deletion (or
  named as unreachable).
- While `AI_RAW_PII_ENABLED` is off (the default), pseudonymization runs before any
  LLM call and **fails closed**. Either way, model output carrying a hard identifier
  is dropped, and profile extraction redacts the worker's own name.
- `AI_ENABLE_REAL_CALLS` defaults to false; real calls require a key.
- Supabase RLS (once enabled) blocks direct client access to sensitive tables.

Unit-level coverage exists today in `apps/ai-service/tests/test_pseudonymize.py`
and `apps/api` event tests; this folder is for cross-service security assertions.
