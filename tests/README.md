# Cross-cutting Tests

Per-package/app unit tests live next to their code (vitest for TS, pytest for the
AI service, `flutter test` for the worker app). This folder is for **cross-cutting**
suites that span services:

- [`contract/`](contract/) — contract tests keeping the TS (Zod) and Python
  (Pydantic) sides of `ai-contracts`/`event-schema` in agreement.
- [`e2e/`](e2e/) — end-to-end flows across API + AI service (+ a real DB).
- [`security/`](security/) — privacy/security assertions (no PII in events/logs,
  pseudonymization fail-closed, RLS once enabled).

These are scaffolding for Phase 1; suites are added as the surfaces stabilize.
