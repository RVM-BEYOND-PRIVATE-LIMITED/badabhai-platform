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

> **Phase-2 alpha-gate streams have since landed additively, each by its own ADR and behind
> launch gates — they do NOT relax the §2 invariants:** swipe-to-apply
> ([ADR-0009](docs/decisions/0009-alpha-swipe-to-apply-seeded-jobs.md)), Reach feed serving
> ([ADR-0011](docs/decisions/0011-reach-feed-serving.md) / [ADR-0015](docs/decisions/0015-reach-feed-on-real-jobs.md)),
> ops job postings ([ADR-0012](docs/decisions/0012-ops-job-postings-banded-stored-only.md)),
> monetization + config-driven pricing ([ADR-0013](docs/decisions/0013-monetization-and-config-driven-pricing-engine.md)),
> per-payer hiring capacity ([ADR-0016](docs/decisions/0016-payer-hiring-capacity.md):
> faceless concurrent-active-vacancy cap, mock payments, **enforcement INERT by default**),
> and **Contact Unlock + Reveal — "Stream A"** ([ADR-0010](docs/decisions/0010-contact-unlock-and-reveal.md):
> mock credits + in-app relay, built + verified 2026-06-17). Further streams have since landed (each its own ADR — full set in [docs/decisions/](docs/decisions/) through ADR-0022): the **self-serve payer/agency portal** ([ADR-0019](docs/decisions/0019-self-serve-payer-portal.md) → [`apps/payer-web`](apps/payer-web); agency = `payers.role='agent'`, [ADR-0022](docs/decisions/0022-agency-supply-portal.md)), the **WhatsApp invite funnel** ([ADR-0020](docs/decisions/0020-whatsapp-invite-funnel-and-reengagement.md), MOCK provider), **PACE supply-widening + ops alert** ([ADR-0021](docs/decisions/0021-pace-supply-widening-and-ops-alert.md)), and the **OFFLINE-only** learn layer ([ADR-0017](docs/decisions/0017-learn-layer-offline-rank-calibration.md)) + model-training corpus ([ADR-0018](docs/decisions/0018-model-training-corpus-and-finetune.md)) — both **offline-built / live-deferred**, so no learned ranking touches the live path (**invariant #4 holds**). The **real-money / real-provider /
> per-payer-auth / production-legal** portions of these remain **deferred / launch-gated** (§8).

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
   `audit_logs`, or logs. Use `*_hash` or opaque UUIDs. Raw worker PII lives **only** in
   the `workers` table; the only other PII at rest is **encrypted** payer contact in
   `payers` (TD21) — and PII still **never** reaches LLM input, events, `ai_jobs`,
   `audit_logs`, or logs.
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
   column in use — version it (the `bb-database-design` + `migration` skills).

---

## 3. Locked tech stack

| Layer           | Tech                                                                                    | Location                             |
| --------------- | --------------------------------------------------------------------------------------- | ------------------------------------ |
| Monorepo        | pnpm + Turborepo                                                                        | root                                 |
| Backend API     | NestJS (TS strict)                                                                      | [`apps/api`](apps/api)               |
| AI service      | Python FastAPI                                                                          | [`apps/ai-service`](apps/ai-service) |
| Web ops console | Next.js (internal only)                                                                 | [`apps/web`](apps/web)               |
| Payer/Agency portal | Next.js (external, self-serve — [ADR-0019](docs/decisions/0019-self-serve-payer-portal.md)/[0022](docs/decisions/0022-agency-supply-portal.md)) | [`apps/payer-web`](apps/payer-web) |
| Worker app      | Flutter (Android-first)                                                                 | [`apps/worker-app`](apps/worker-app) |
| Database        | Supabase Postgres + Drizzle                                                             | [`packages/db`](packages/db)         |
| Queue/cache     | Redis + BullMQ (deferred wiring)                                                        | [`infra/redis`](infra/redis)         |
| AI routing      | Direct Gemini + Claude ([ADR-0008](docs/decisions/0008-litellm-to-direct-providers.md)) | `apps/ai-service/app/ai/router.py`   |

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
  ai-service/  FastAPI — pseudonymize.py, contracts.py, llm.py, extraction.py, stt.py, config.py + ai/ (router.py, model_config.py, cost_tracker.py)
  web/         Next.js ops console — workers / events / ai-jobs (read-only)
  payer-web/   Next.js — external self-serve payer + agency portal (ADR-0019/0022)
  worker-app/  Flutter scaffold — Splash → … → ResumePreview, ApiClient
packages/
  event-schema/  Artifact #1 — envelope, registry, payloads, validate
  db/            Drizzle schema + migrations + client (34 tables — full set in schema.ts)
  config/        Typed env (server vs public split)
  pricing/       config-driven pricing + credit-pack catalog (ADR-0013)
  reach-engine/  BUILT — deterministic RANK core (scoring.ts / types.ts / ranking.ts, ADR-0011/0015)
  reach-learn/   OFFLINE learn layer — calibration only, NOT live ranking (ADR-0017)
  types/ validators/ taxonomy/ ai-contracts/   shared contracts
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

**DB tables (34):** the full set is the source of truth in
[`packages/db/src/schema.ts`](packages/db/src/schema.ts). Raw worker PII lives **only**
in `workers`; the only other PII at rest is **encrypted** payer contact in `payers` (TD21).

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
pnpm db:seed:demand     # BUG-2 demand-loop fixture (idempotent, prod-guarded)
pnpm db:verify:demand   # assert the demand loop emits its six events
pnpm --filter @badabhai/db db:seed:jobs   # seed ADR-0009 swipe jobs (package-scoped)
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
by [CI](.github/workflows/ci.yml). The `bb-feature-planning` skill is the runnable checklist.

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

**Feature workflow** (the `bb-feature-planning` skill encodes this):
Idea → Requirements → Architecture (ADR if structural) → DB → API/Events → Implementation
→ Tests → Security/Privacy review → Performance sanity → Deploy → Monitor.

**Engineering org** — invoke the specialist for the layer you're in:

| Agent                                                      | Owns                                   | Use the Task tool with subagent |
| ---------------------------------------------------------- | -------------------------------------- | ------------------------------- |
| [backend-engineer](.claude/agents/backend-engineer.md)     | NestJS API, events                     | `backend-engineer`              |
| [ai-engineer](.claude/agents/ai-engineer.md)               | FastAPI, privacy gateway, AI contracts | `ai-engineer`                   |
| [database-architect](.claude/agents/database-architect.md) | Drizzle schema + migrations            | `database-architect`            |
| [frontend-engineer](.claude/agents/frontend-engineer.md)   | Payer/agency portal + ops console      | `frontend-engineer`             |
| [design-engineer](.claude/agents/design-engineer.md)       | Design-system fidelity + UI/UX         | `design-engineer`               |
| [mobile-engineer](.claude/agents/mobile-engineer.md)       | Flutter worker app                     | `mobile-engineer`               |
| [security-engineer](.claude/agents/security-engineer.md)   | PII/event/DPDP gate                    | `security-engineer`             |

The seven builders above include **design-engineer** (UI/UX + design-system fidelity across
apps/payer-web, apps/web, and the worker app); the **full roster (19) lives in
[`.claude/agents/`](.claude/agents/)** (also system-architect, devops, performance, qa,
product-manager, technical-writer, refactoring, debugging, the reviewers, test-planner).

Skills (run with the Skill tool): see [`.claude/skills/`](.claude/skills/) — `bb-api-design`,
`bb-database-design` / `migration`, `bb-security-review`, `bb-feature-planning`,
`bb-architecture-review`, `bb-testing`, `bb-design-system`, `bb-ui-review`, `pr-review`.

**Escalate (stop and ask the human) when:** an invariant in §2 must change; the stack
(§3) must change; a migration is destructive/irreversible; real LLM/OTP/STT/payment
provider keys or spend are involved; or anything touches production data.

**Project memory** lives in [docs/registers/](docs/registers/) — update the relevant
register in the same PR as the change that motivated it. Decisions of record are ADRs in
[docs/decisions/](docs/decisions/).

---

## 8. Deferred (do not build in Phase 1 without an explicit decision)

Reach Engine **learned** ranking, advanced matching, finalized RLS (backend uses the service
role today — see [infra/supabase/rls-plan.md](infra/supabase/rls-plan.md)), BullMQ job queues,
real OTP/STT/LLM/payment providers, real telephony/proxy + raw-phone reveal, production DPDP
legal copy. **Note:** the _alpha-gate_ forms of employer postings, contact unlock (mock credits
+ in-app relay, [ADR-0010](docs/decisions/0010-contact-unlock-and-reveal.md) Stream A), Reach
feed serving, config-driven pricing/boosts, **per-payer hiring capacity**
([ADR-0016](docs/decisions/0016-payer-hiring-capacity.md): faceless cap, mock payments,
**enforcement INERT by default** behind `CAPACITY_ENFORCEMENT_ENABLED`), the **self-serve
payer/agency portal** (ADR-0019/0022) and the **WhatsApp invite funnel** (ADR-0020, mock) have
**landed additively behind launch gates** (§1) — it is their **real-money / real-provider /
production-legal** portions (tracked: TD33/TD34/TD35/TD43 + the threat-model LC items) that
remain deferred here.

**`PayerAuthGuard` has LANDED** for the self-serve payer/agency portal (R16/LC-1, PR #110); but
the **money routes** — Contact Unlock unlock/reveal and `POST /job-postings/:id/plan` — still ride
`InternalServiceGuard` + body `payer_id` (see
[unlocks.controller.ts](apps/api/src/unlocks/unlocks.controller.ts)), so LC-1 for that surface
remains **open** (TD33/TD50). **Still pending:** a **cost** strategy doc + a **disaster-recovery**
plan (monitoring/rollback have runbooks — [observability-runbook.md](docs/observability-runbook.md),
[rollback-guide.md](docs/rollback-guide.md)).

## 9. Claude Efficiency Rules

Before repository exploration:

1. Read `.claude/project-memory.md`
2. Read `.claude/team-memory.md`
3. Read [`docs/claude-working-guide.md`](docs/claude-working-guide.md) — the working protocol + guardrails

Treat all three as authoritative. `.claude/settings.json` enforces hard guardrails — no reading
secret files, no destructive shell — via permission rules + a `PreToolUse` hook
(`.claude/hooks/guard.mjs`, self-test `node .claude/hooks/guard.selftest.mjs`).

Do not rediscover architecture, ownership, business rules, or active workstreams already documented there.

Search code only when:

- implementation details are needed
- memory files are outdated
- information is missing

### Evidence-Based Work

Never invent:

- architecture
- APIs
- database schema
- event types
- business rules

When information is missing:

1. Check memory files
2. Search the repository

If still unknown:

- mark it as UNKNOWN
- ask for clarification
- do not assume

### Response Style

Assume experienced backend engineers.

Preferred format:

- Status
- Files Changed
- Issues
- Next Steps

Keep responses concise.
Prefer bullets over paragraphs.
Avoid tutorials, framework explanations, and unnecessary reasoning.

Update memory files when project knowledge, ownership, or workstreams change.
