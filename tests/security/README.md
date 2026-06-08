# Security / Privacy Tests (placeholder)

Assert the platform's safety invariants:

- No raw PII (phone/full name/address/employer/ID) appears in `events`,
  `audit_logs`, `ai_jobs`, or logs.
- Pseudonymization runs before any LLM call and **fails closed**.
- `AI_ENABLE_REAL_CALLS` defaults to false; real calls require a key.
- Supabase RLS (once enabled) blocks direct client access to sensitive tables.

Unit-level coverage exists today in `apps/ai-service/tests/test_pseudonymize.py`
and `apps/api` event tests; this folder is for cross-service security assertions.
