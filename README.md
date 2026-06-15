# BadaBhai Platform

**BadaBhai** is an AI placement-team product for blue/grey-collar India, starting
with industrial manufacturing and CNC/VMC roles. It turns workers into live,
profiled, contactable candidates through a chat-first worker app.

> **Phase 1 scope is intentionally narrow: Worker Profiling + Profile Generation.**
> Employer posting, unlock, payments, payouts, boosts, ranking/matching, and
> production legal flows are explicitly **out of scope** for Phase 1.

---

## Core Principles

- **Event-first architecture** — every important endpoint emits a validated event.
- **Privacy by construction** — a pseudonymization gateway runs before *every* LLM
  call. Phone, name, address, employer names, and ID docs never reach an LLM.
- **Fail closed** — if pseudonymization fails, the AI path is blocked.
- **API-first AI** — no self-hosted LLM at launch; the AI service calls providers
  directly (Gemini primary + Claude Haiku fallback; ADR-0008) behind the
  `LlmAdapter`/`AIRouter` seam, gated behind `AI_ENABLE_REAL_CALLS` (default `false`).
- **Lean and maintainable** — TypeScript strict everywhere, Zod/Pydantic runtime
  validation, simple enough for a small team.

---

## Locked Tech Stack

| Layer            | Technology                                          |
| ---------------- | --------------------------------------------------- |
| Monorepo         | pnpm + Turborepo                                     |
| Backend API      | NestJS (TypeScript)                                  |
| AI service       | Python FastAPI                                       |
| Web dashboard    | Next.js (internal ops console)                       |
| Worker app       | Flutter                                              |
| Database         | Supabase Postgres (MVP)                              |
| ORM / migrations | Drizzle (TypeScript services)                        |
| Queue / cache    | Redis + BullMQ                                       |
| AI routing       | Direct Gemini + Claude (ADR-0008)                   |
| STT              | Sarvam (placeholder only)                            |
| Observability    | Structured logging + Langfuse (placeholders)        |
| AI safety        | Pseudonymization gateway before every LLM call       |

---

## Repository Structure

```txt
badabhai-platform/
├─ apps/
│  ├─ api/            # NestJS backend (worker profiling endpoints + event bus)
│  ├─ ai-service/     # Python FastAPI (pseudonymization, profiling, extraction)
│  ├─ web/            # Next.js internal ops console
│  └─ worker-app/     # Flutter worker mobile app (scaffold)
├─ packages/
│  ├─ event-schema/   # Artifact #1 — event envelope, registry, payloads, validation
│  ├─ db/             # Drizzle schema + migrations + client
│  ├─ config/         # Typed env validation (server vs public)
│  ├─ types/          # Shared domain types/enums
│  ├─ validators/     # Reusable Zod validators (phone, uuid, duration, ...)
│  ├─ taxonomy/       # Canonical industries/roles/skills/machines (placeholder)
│  ├─ ai-contracts/   # Zod contracts for AI I/O (mirrored as Pydantic in ai-service)
│  └─ reach-engine/   # Placeholder only — NOT implemented in Phase 1
├─ infra/
│  ├─ docker/         # Container assets
│  ├─ supabase/       # Migration/RLS plans + local-dev docs
│  ├─ redis/          # Redis notes
│  └─ monitoring/     # Observability notes
├─ docs/
│  ├─ decisions/      # ADRs
│  ├─ sprint-plans/   # Phase plans
│  └─ ...             # architecture/schema/ai/bible/legal-later
├─ tests/             # contract / e2e / security (cross-cutting)
└─ .github/           # CI workflow + PR template
```

---

## Prerequisites

| Tool      | Version (used here)   | Required for                        |
| --------- | --------------------- | ----------------------------------- |
| Node.js   | 20+ (tested on 25.x)  | TS packages, API, web               |
| pnpm      | 11.x                  | monorepo install/build              |
| Python    | 3.11+ (tested 3.14)   | AI service                          |
| Docker    | latest                | local Postgres + Redis (optional)   |
| Flutter   | 3.x                   | worker app (optional in Phase 1)    |
| gh        | latest                | GitHub workflows (optional)         |
| supabase  | latest                | Supabase workflow (optional)        |

> If pnpm is missing: `npm install -g pnpm` (corepack also works where available).

---

## Setup

```bash
# 1. Install JS/TS workspace deps
pnpm install

# 2. Create your env file
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env

# 3. (Optional) start local Postgres + Redis
docker compose up -d

# 4. Build shared packages first (Turbo handles ordering)
pnpm build
```

### Root scripts

| Command            | Description                                   |
| ------------------ | --------------------------------------------- |
| `pnpm dev`         | Run dev tasks across apps (Turbo)             |
| `pnpm build`       | Build all packages/apps in dependency order   |
| `pnpm test`        | Run all test suites                           |
| `pnpm lint`        | ESLint across the TS monorepo                 |
| `pnpm typecheck`   | `tsc --noEmit` per package                    |
| `pnpm format`      | Prettier write                                |
| `pnpm db:generate` | Generate Drizzle migrations                   |
| `pnpm db:migrate`  | Apply Drizzle migrations                      |
| `pnpm db:studio`   | Open Drizzle Studio                           |

---

## Running Each App

### API (NestJS)

```bash
pnpm --filter @badabhai/api dev     # http://localhost:3001  (GET /health)
```

### AI service (FastAPI)

```bash
cd apps/ai-service
python -m venv .venv
. .venv/Scripts/activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000   # http://localhost:8000/health
```

### Web ops console (Next.js)

```bash
pnpm --filter @badabhai/web dev     # http://localhost:3000
```

### Worker app (Flutter)

```bash
cd apps/worker-app
flutter pub get
flutter run
```

---

## Supabase Setup

Phase 1 uses Supabase Postgres. The project is **not linked** by default. See
[infra/supabase/README.md](infra/supabase/README.md) and
[infra/supabase/local-dev.md](infra/supabase/local-dev.md) for full detail.

```bash
supabase login
supabase link --project-ref <PROJECT_REF>
supabase db push                              # apply migrations
supabase migration new <name>                 # author a new migration
supabase db diff                              # inspect schema drift
supabase gen types typescript --project-id <PROJECT_REF> > packages/db/src/supabase.types.ts
```

> RLS is **planned, not finalized** in Phase 1 — see
> [infra/supabase/rls-plan.md](infra/supabase/rls-plan.md).

---

## GitHub CLI Usage

```bash
gh auth status              # confirm authentication
gh repo view               # inspect this repo
gh issue list              # if issues are enabled
gh pr create --fill        # open a PR (uses .github/pull_request_template.md)
```

---

## Docker Usage

```bash
docker compose up -d        # postgres (5432), redis (6379), adminer (8080)
docker compose ps
docker compose logs -f postgres
docker compose down         # stop (add -v to delete data volumes)
```

---

## Running Tests

```bash
pnpm test                                   # all TS suites (Turbo)
pnpm --filter @badabhai/event-schema test   # one package

cd apps/ai-service && pytest                 # Python AI service
cd apps/worker-app && flutter test           # Flutter
```

---

## Phase 1 Scope (Worker Profiling)

- Worker identity (mock OTP) + consent capture
- Chat-based profiling + voice-note placeholder
- AI pseudonymization gateway + profile extraction (mock by default)
- Resume/profile generation (placeholder)
- Event emission + validation for every important action
- Internal ops console shell + Flutter worker-app scaffold

## NOT in Phase 1

Employer job posting · unlock flow · payments · agency payout · boosts ·
Reach Engine ranking · advanced matching · production legal flows · real OTP
provider · real STT integration · real payment gateway.

---

## Troubleshooting

| Symptom                                   | Fix                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `pnpm: command not found`                 | `npm install -g pnpm`                                               |
| Type errors importing `@badabhai/*`       | Run `pnpm build` first — packages must be built to `dist/`.         |
| API can't reach DB                        | `docker compose up -d` or set `DATABASE_URL` to your Supabase URL.  |
| AI service returns mock responses         | Expected. Real calls require `AI_ENABLE_REAL_CALLS=true` + keys.    |
| Web crashes on missing backend secrets    | It shouldn't — web only reads `NEXT_PUBLIC_*`. File a bug if it does. |
| Flutter/Docker commands fail              | Those SDKs are optional in Phase 1; install them if needed.         |

---

## Documentation Index

- [docs/decisions/0001-mvp-infra-decision.md](docs/decisions/0001-mvp-infra-decision.md) — infra ADR
- [docs/sprint-plans/phase-1-worker-profiling.md](docs/sprint-plans/phase-1-worker-profiling.md) — Phase 1 plan
- [infra/supabase/README.md](infra/supabase/README.md) — Supabase workflow
- [packages/event-schema/README.md](packages/event-schema/README.md) — event contracts
