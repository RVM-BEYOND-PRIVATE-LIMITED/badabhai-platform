# @badabhai/api

NestJS backend for Phase 1 worker profiling. **Event-first**: every important
endpoint emits a validated event via `EventsService`.

## Run

```bash
pnpm --filter @badabhai/api dev      # nest start --watch -> http://localhost:3001
pnpm --filter @badabhai/api build    # nest build -> dist
pnpm --filter @badabhai/api test     # vitest unit tests
```

The app boots even without a live DB (postgres.js connects lazily) and without
the AI service running (the AI client falls back to safe mocks).

## Endpoints

| Method | Path                     | Emits                                                |
| ------ | ------------------------ | ---------------------------------------------------- |
| GET    | `/health`                | —                                                    |
| POST   | `/auth/otp/request`      | `worker.otp_requested`                               |
| POST   | `/auth/otp/verify`       | `worker.created` (if new) + `worker.otp_verified`    |
| POST   | `/consent/accept`        | `consent.accepted`                                   |
| POST   | `/chat/session`          | `chat.session_started`                               |
| POST   | `/chat/message`          | `chat.message_received` + `chat.message_sent`        |
| POST   | `/voice/upload`          | `voice_note.uploaded` (duration ≤ 120s)              |
| POST   | `/profile/extract`       | `profile.extraction_requested` + `…completed`        |
| POST   | `/profile/confirm`       | `profile.confirmed`                                  |
| POST   | `/resume/generate`       | `resume.generated`                                   |
| GET    | `/workers/:id/profile`   | —                                                    |

## Architecture

- **DTO validation** uses Zod (`ZodValidationPipe`) sharing `@badabhai/validators`.
- **Repository/service separation**: thin Drizzle repositories per aggregate.
- **DI tokens**: `SERVER_CONFIG`, `DATABASE`, `DB_CLIENT`.
- **Middleware**: `RequestIdMiddleware` sets `requestId` + `correlationId`
  (threaded into events for tracing).
- **Structured logging** via `StructuredLogger`; global `AllExceptionsFilter`.

## Privacy & safety

- Raw phone/name never go into events — only hashes/ids (`common/crypto.ts`).
- The AI service does pseudonymization before any LLM call; this API never sends
  raw PII for LLM use. Real LLM calls require `AI_ENABLE_REAL_CALLS=true` (default
  off) — the gating lives in `@badabhai/config`.

## TODO

- Replace mock OTP with a real provider.
- Move AI extraction/transcription to BullMQ background jobs (Redis).
- Apply Supabase RLS + connect with the service role (see infra/supabase).
- Lock down CORS origins per environment.
