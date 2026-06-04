# BadaBhai Platform

BadaBhai is an AI-driven placement-team platform for blue/grey-collar India, starting with industrial manufacturing roles.

The platform turns workers into live, profiled, contactable candidates through a chat-first worker app, then gives paid access to companies, staffing firms, and agencies through a payer/ops console.

## Core Principles

- Event-first architecture
- Chat-first worker onboarding
- Offline-tolerant worker app
- Deterministic Reach Engine: reach, rank, pace, protect, learn
- LLMs assist with profiling, canonicalization, and explanations
- LLMs never rank, reject, or decide matches
- DPDP consent and worker protection are launch gates

## Monorepo Structure

```txt
apps/
  api/              # NestJS backend
  ai-services/      # Python FastAPI AI workers
  web-console/      # Next.js payer/ops console
  worker-app/       # Worker mobile app

packages/
  event-schema/     # Artifact #1: event schema and codegen
  shared-types/     # Shared DTOs, enums, validation contracts
  config/           # Typed configuration

db/
  migrations/
  seeds/

infra/
  docker/
  terraform/
  github-actions/

docs/
  architecture/
  product/
  ai/
  security/
  testing/
  dev/

scripts/
