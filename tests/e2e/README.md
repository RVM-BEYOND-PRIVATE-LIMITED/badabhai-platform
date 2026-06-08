# E2E Tests (placeholder)

End-to-end Phase 1 flow across API + AI service + Postgres:

login (mock OTP) → consent → chat → profile extract → confirm → resume generate,
asserting the expected events were emitted along the way.

TODO: wire against docker-compose Postgres + a running API and AI service.
