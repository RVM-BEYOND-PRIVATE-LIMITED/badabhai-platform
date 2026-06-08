# Redis

Redis backs the cache and the **BullMQ** queues used for async AI work
(transcription, profile extraction, resume generation) in later slices.

Phase 1: a local Redis is provided by `docker compose up -d` (port 6379). Set
`REDIS_URL=redis://localhost:6379` in `.env`.

BullMQ workers and queue wiring are introduced when the AI jobs move from inline
calls to background processing (see `docs/sprint-plans/phase-1-worker-profiling.md`).
