# CLAUDE.md — BadaBhai Operating Contract

> This file is the contract every Claude Code session and every project agent reads
> first. It is intentionally short and authoritative. When something here conflicts
> with a casual instruction, **the invariants below win** — surface the conflict
> instead of silently breaking one.

---

## 1. What BadaBhai is

**BadaBhai** is an AI "placement-team" product for blue/grey-collar India, launching
with industrial manufacturing (CNC/VMC) roles. It turns workers into live, profiled,
contactable candidates through a **chat-first worker app**.

**Phase 1 scope is narrow and locked: Worker Profiling + Profile Generation.**
Employer posting, unlock, payments, payouts, boosts, ranking/matching (the Reach
Engine), and production legal flows are **out of scope for Phase 1**. See
[docs/sprint-plans/phase-1-worker-profiling.md](docs/sprint-plans/phase-1-worker-profiling.md).

**Phase 1 exit criteria (what we are optimizing for right now):**
A worker can log in (mock OTP) → give consent → chat → get an extracted, confirmed
profile → get a generated resume — with **every step emitting a validated event** and
**no PII ever reaching an LLM**. Ops can view workers / events / AI jobs (read-only).

---

## 2. Non-negotiable invariants (do not break these)

These are architecture, not preference. A change that violates one is a bug even if it
compiles and tests pass. If a task requires breaking one, **stop and escalate** (§7).

1. **Event-first.** Every important endpoint emits an event built with `createEvent`
   and validated against [`@badabhai/event-schema`](packages/event-schema). The
   `events` table is the audit spine. No important state change without an event.
2. **No raw PII leaves its boundary.** Phone, full name, address, employer names, and
   ID-doc tokens **must never** appear in: LLM input, event payloads, `ai_jobs`,
   `audit_logs`, or logs. Use `*_hash` or opaque UUIDs. Raw PII lives **only** in the
   `workers` table.
3. **Pseudonymization runs before every LLM call and fails closed.** It lives in
   [`apps/ai-service/app/pseudonymize.py`](apps/ai-service/app/pseudonymize.py). If it
   blocks (oversize input, parse error, residual digit run), the LLM is **never called**
   and a safe fallback is returned. Never add an LLM path that bypasses it.
4. **LLMs assist; they never decide.** LLMs profile, canonicalize, and explain. They
   **never rank, reject, score, or decide a match.** Those are deterministic and live
   in the (deferred) Reach Engine.
5. **Real LLM calls are gated and off by default.** `AI_ENABLE_REAL_CALLS=false` is the
   default. Real calls require the flag **and** a key, and only ever in staging first.
6. **DPDP consent is a gate.** No profiling/AI processing of a worker before
   `consent.accepted` is captured.
7. **Typed contracts at every boundary.** Zod (TS) + Pydantic (Python). AI I/O
   contracts in [`packages/ai-contracts`](packages/ai-contracts) must stay mirrored in
   [`apps/ai-service/app/contracts.py`](apps/ai-service/app/contracts.py).
8. **Backward compatibility.** Never mutate a shipped event payload schema or drop a DB
   column in use — version it (§ event-schema-change, safe-db-migration skills).

---

## 3. Locked tech stack

| Layer           | Tech                             | Location                             |
| --------------- | -------------------------------- | ------------------------------------ |
| Monorepo        | pnpm + Turborepo                 | root                                 |
| Backend API     | NestJS (TS strict)               | [`apps/api`](apps/api)               |
| AI service      | Python FastAPI                   | [`apps/ai-service`](apps/ai-service) |
| Web ops console | Next.js (internal only)          | [`apps/web`](apps/web)               |
| Worker app      | Flutter (Android-first)          | [`apps/worker-app`](apps/worker-app) |
| Database        | Supabase Postgres + Drizzle      | [`packages/db`](packages/db)         |
| Queue/cache     | Redis + BullMQ (deferred wiring) | [`infra/redis`](infra/redis)         |
| AI routing      | Direct Gemini + Claude ([ADR-0008](docs/decisions/0008-litellm-to-direct-providers.md)) | `apps/ai-service/app/ai/router.py` |

Stack is **locked** for Phase 1 (see [ADR-0001](docs/decisions/0001-mvp-infra-decision.md),
[ADR-0008](docs/decisions/0008-litellm-to-direct-providers.md)). The AI service calls
Gemini (primary) + Claude Haiku (fallback) directly behind the `LlmAdapter`/`AIRouter`
seam — there is no LiteLLM proxy.
Proposing a new framework/library/datastore is an architecture decision → ADR + escalate.

---

## 4. Repository map

```
apps/
  api/         NestJS — auth, consent, chat, voice, profiles, resume, events, workers, ai, health
  ai-service/  FastAPI — pseudonymize.py, contracts.py, llm.py, config.py
  web/         Next.js ops console — workers / events / ai-jobs (read-only)
  worker-app/  Flutter scaffold — Splash → … → ResumePreview, ApiClient
packages/
  event-schema/  Artifact #1 — envelope, registry, payloads, validate
  db/            Drizzle schema + migrations + client (10 tables)
  config/        Typed env (server vs public split)
  types/ validators/ taxonomy/ ai-contracts/   shared contracts
  reach-engine/  PLACEHOLDER — not implemented in Phase 1
docs/        decisions(ADRs) · sprint-plans · architecture · ai · schema · bible · registers
infra/       docker · supabase(migration/RLS plans) · redis · monitoring
.claude/     agents/ · skills/   (this engineering org)
tests/       contract / e2e / security (cross-cutting)
```

**API module convention** (every domain follows it): `<domain>.controller.ts` (thin,
HTTP only) → `<domain>.service.ts` (business logic, emits events) →
`<domain>.repository.ts` (Drizzle data access) + `<domain>.dto.ts` (Zod) +
`<domain>.module.ts` (DI wiring). Do not put data access in controllers or business
logic in repositories.

**DB tables (10):** `workers` · `worker_consents` · `worker_profiles` ·
`chat_sessions` · `chat_messages` · `voice_notes` · `generated_resumes` · `events` ·
`ai_jobs` · `audit_logs`. PII lives **only** in `workers`.

---

## 5. Commands (verified)

```bash
pnpm install            # install workspace
pnpm build              # build all (Turbo dependency order) — run before typecheck if @badabhai/* errors
pnpm dev                # dev across apps
pnpm lint               # eslint .
pnpm typecheck          # tsc --noEmit per package
pnpm test               # all TS suites
pnpm format             # prettier --write
pnpm db:generate        # drizzle: author migration from schema.ts
pnpm db:migrate         # apply migrations
pnpm db:up / db:down    # docker postgres+redis

# AI service (from apps/ai-service)
ruff check .            # lint   (CI gate)
pytest                  # tests  (CI gate)

# Worker app (from apps/worker-app)
flutter analyze && flutter test   # CI gate (currently non-blocking)
```

Single package: `pnpm --filter @badabhai/<name> <script>`.

---

## 6. Quality gates — nothing merges unless all pass

Mirror of [.github/pull_request_template.md](.github/pull_request_template.md), enforced
by [CI](.github/workflows/ci.yml). The `feature-quality-gate` skill is the runnable checklist.

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green
- [ ] AI service `ruff check .` + `pytest` green (if touched)
- [ ] **No raw PII** in LLM input, events, `ai_jobs`, `audit_logs`, or logs
- [ ] Every important new endpoint emits a **validated** event
- [ ] DB change is backward-compatible + has a migration + rollback note
- [ ] Event payload change is **versioned**, not mutated in place
- [ ] AI-contract change kept in parity (Zod ↔ Pydantic)
- [ ] No secrets / `.env` committed
- [ ] Docs/registers updated (decisions, risks, tech-debt as relevant)
- [ ] Reviewed (`/code-review`) and, for any PII/AI/auth change, `/security-review`

---

## 7. How we work (small team, low ceremony)

**Feature workflow** (the `feature-quality-gate` skill encodes this):
Idea → Requirements → Architecture (ADR if structural) → DB → API/Events → Implementation
→ Tests → Security/Privacy review → Performance sanity → Deploy → Monitor.

**Engineering org** — invoke the specialist for the layer you're in:

| Agent                                                                    | Owns                                   | Use the Task tool with subagent |
| ------------------------------------------------------------------------ | -------------------------------------- | ------------------------------- |
| [backend-engineer](.claude/agents/backend-engineer.md)                   | NestJS API, events                     | `backend-engineer`              |
| [ai-engineer](.claude/agents/ai-engineer.md)                             | FastAPI, privacy gateway, AI contracts | `ai-engineer`                   |
| [database-architect](.claude/agents/database-architect.md)               | Drizzle schema + migrations            | `database-architect`            |
| [frontend-engineer](.claude/agents/frontend-engineer.md)                 | Next.js ops console                    | `frontend-engineer`             |
| [mobile-engineer](.claude/agents/mobile-engineer.md)                     | Flutter worker app                     | `mobile-engineer`               |
| [security-privacy-reviewer](.claude/agents/security-privacy-reviewer.md) | PII/event/DPDP gate                    | `security-privacy-reviewer`     |

Skills (run with the Skill tool): `add-api-endpoint` · `event-schema-change` ·
`safe-db-migration` · `privacy-review` · `feature-quality-gate` · `wire-client-to-api`.

**Escalate (stop and ask the human) when:** an invariant in §2 must change; the stack
(§3) must change; a migration is destructive/irreversible; real LLM/OTP/STT/payment
provider keys or spend are involved; or anything touches production data.

**Project memory** lives in [docs/registers/](docs/registers/) — update the relevant
register in the same PR as the change that motivated it. Decisions of record are ADRs in
[docs/decisions/](docs/decisions/).

---

## 8. Deferred (do not build in Phase 1 without an explicit decision)

Reach Engine ranking, employer posting/unlock, payments/payouts, boosts, advanced
matching, finalized RLS (backend uses the service role today — see
[infra/supabase/rls-plan.md](infra/supabase/rls-plan.md)), BullMQ job queues, real
OTP/STT/LLM/payment providers, production DPDP legal copy. **Org expansion (next):**
system-architect, devops, performance, qa, product-manager, technical-writer,
refactoring, debugging agents; cost/DR/monitoring strategy docs.
