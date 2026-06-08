# @badabhai/types

Shared domain **enums and types** — framework-agnostic and dependency-free, so
any service (Nest, Next, Drizzle, tests) can import them without pulling in zod.

Includes: worker/profile/chat/voice/AI-job statuses, message direction/type,
consent purposes + current consent version, voice retention/storage classes,
supported language codes, and the `MAX_VOICE_NOTE_SECONDS` constant.

Runtime validation → `@badabhai/validators`. Event contracts → `@badabhai/event-schema`.
