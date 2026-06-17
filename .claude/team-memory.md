# BadaBhai — Team Memory

> Single source of truth for backend **ownership** + **active work**. Cuts duplicate
> investigation across sessions. Pairs with CLAUDE.md (invariants) and project-memory.md
> (architecture). **Update this file in place — do not recreate.**
> Ownership is inferred from git history (2 backend committers); confirm with the human
> before assigning new work. PR open/closed status is inferred (gh not authenticated).

# Team Overview
- **Backend developers: 2** — Divyanshu Pant (Dev A) and Prakash Kantumutchu (Dev B, also **Tech Lead / integrator-reviewer**, ~3× the commit volume).
- Other roles: Utkarsh (Next.js ops console / web), Flutter dev (worker app, onboarding ~2026-06-25), Akshit (CEO, broad sign-off).
- Process calibrated for **2–5 engineers**: automation-first checks + **exactly one human reviewer**; specialist agents review, the human confirms.
- **Phase 1 — Worker Profiling + Profile Generation.** Phase 2 (Reach, employer, payments) needs a new team-decision row. Alpha-gate slices (job postings, reach feed, contact unlock) are landing as strictly-additive, gated work.

# Developer Ownership
> Fluid in a 2-person team; based on commit history, not hard walls.

## Developer A — Divyanshu Pant (`DivyanshuPant`)
- **Owned domains:** job postings (ops, ADR-0012) · Reach feed serving (ADR-0011) · Phase-1 worker-profiling foundation.
- **Owned modules:** `apps/api/src/job-postings`, reach feed-serving slice, web ops-console job-posting route.
- **Active PRs:** #48 `feat/job-posting-alpha-gate`, #47 `feat/reach-feed-serving-alpha-gate` (both merged to main 2026-06-16; current working branch is `feat/job-posting-alpha-gate`).
- **Current tasks:** close out job-posting alpha gate (vacancy-banded, stored-only).
- **Avoid changing without coordination:** contact-unlock module, reach RANK core/scoring, auth/OTP, RLS migrations (Dev B areas).

## Developer B — Prakash Kantumutchu (`Prakash Kantumutchu`) — TL / integrator
- **Owned domains:** Contact Unlock + Reveal (ADR-0010) · Reach Engine RANK core + hardening (ADR-0006) · auth/OTP + Sarvam STT · RLS · PII-at-rest encryption · AI cost ceiling + LLM routing.
- **Owned modules:** unlocks backend, reach-engine/scoring, `worker-otp-auth-and-sarvam-stt`, `td20-spine-rls`, `td21-encrypt-fullname`, AI cost/real-Gemini client. **Reviews/merges most PRs.**
- **Active PRs:** #46 `feat/contact-unlock-stream-a` (merged 2026-06-16) + unlock concurrency (F-2 deadlock) fixes.
- **Current tasks:** contact-unlock stream A stabilization; integrating/merging alpha-gate branches into main.
- **Avoid changing without coordination:** job-postings + reach-feed slices (Dev A areas).

# Shared Infrastructure (both own — coordinate)
- **Event system:** `@badabhai/event-schema` registry + domain/subject/actor enums — every new domain edits it.
- **DB migrations:** `packages/db` — strict sequential numbering; recently renumbered on merge (conflict-prone — see Coordination).
- **Auth:** mock OTP (`apps/api/src/auth`) + `ConsentGuard`; Phase-1, no JWT.
- **Common libs:** `@badabhai/validators`, `types`, `config`, `taxonomy`, `ai-contracts` (Zod ↔ Pydantic mirror).
- **Shared services:** `EventsService`, `DatabaseModule`, AI privacy gateway (`pseudonymize.py`), root `app.module.ts`.

# Active Workstreams
- **Job postings alpha gate** — ops vacancy register, banded/stored-only (ADR-0012). Status: merged (#48). Owner: A.
- **Reach feed serving** — alpha feed over the RANK core (ADR-0011). Status: merged (#47). Owner: A.
- **Contact Unlock + Reveal** — routed disclosure + reveal backend (ADR-0010). Status: stream A merged (#46); concurrency fixes ongoing. Owner: B.
- **Reach Engine core/hardening** — deterministic RANK (ADR-0006). Status: ratified + hardening. Owner: B.
- **Jobs entity lifecycle** — Reach-facing `jobs` (opaque payer, integer vacancy, `job.*` events), **distinct from `job_postings`**. Status: PR #42 (open per register). Owner: confirm.
- **Phase-1 "next" items** (priority before Phase 2): real OTP (TD2), platform-wide RLS (TD4), real Sarvam STT, real LLM in staging — partially paid.

# Current PR Status
> Inferred from merge commits + branches (2026-06-16); not gh-verified.
- **#48 job-posting-alpha-gate** — A — *merged* — job postings (ADR-0012). Blockers: none. Deps: event-registry + app.module wiring.
- **#47 reach-feed-serving** — A — *merged* — reach feed (ADR-0011). Deps: RANK core (ADR-0006).
- **#46 contact-unlock-stream-a** — B — *merged* — unlock core (ADR-0010). Follow-up: deadlock fixes landed.
- **#45 docs/contact-unlock-phase0** — B — *merged* — ADR-0010 design + PII threat model.
- **#42 jobs-entity-lifecycle** — *likely open* — Reach-facing jobs entity. Blocker/risk: naming overlap with `job_postings` — keep `job.*` vs `job_posting.*` unambiguous.
- **#39 r14-failclose-boot-gates** — *merged*. · **#32 worker-otp-auth + Sarvam STT** — B — *merged*.

# Important Domain Knowledge (repeatedly affects implementation)
- CLAUDE.md §2 invariants: event-first · no raw PII anywhere outside `workers` · pseudonymize-before-LLM (fail-closed) · LLMs never decide.
- Consent is a hard gate; **disclosure consent is separate from profiling consent** (ADR-0010).
- `job_posting.*` (ops, banded, **no employer entity**, ADR-0012) is **distinct** from `job.*` (Reach-facing jobs entity, opaque payer, integer vacancy). Don't conflate.
- **Reach RANK weights:** the implemented `scoring.ts` set is **authoritative** (Trade .35 / Loc .20 / Exp .15 / Pay .10 / Avail .10 / Activity .10; **no Skills, no embeddings**). The ledger's Σ100 + embeddings = Phase-2 draft — **don't "fix" code to match the doc** (ADR-0006).
- Revenue = **employer-pays-to-unlock**; workers free.
- Backward compat: version events/columns; never mutate in place.

# Coordination Notes
- **Frequent merge-conflict hotspots:** `apps/api/src/app.module.ts` (every new module imports here) · **migration numbering** in `packages/db` (renumber on merge) · **event registry + domain/subject enums** · **registers** (`tech-debt-register` IDs, `decisions-log` — dedupe on merge).
- **Communicate before touching:** event-schema registry · shared `validators`/`types`/`ai-contracts` · RLS migrations · the AI privacy gateway · root module wiring.
- **Shared contracts:** AI I/O must stay mirrored Zod ↔ Pydantic; event payloads are versioned contracts (change = bump, not mutate).

# Do Not Rediscover (trust without re-analysis)
- Architecture / stack / invariants → CLAUDE.md + project-memory.md (Phase 1 locked).
- ADRs **0001–0012** in `docs/decisions/` are decisions of record; `docs/registers/team-decisions.md` holds non-ADR calls — don't re-litigate either.
- **Event naming = `domain.action`**; standard envelope + registry-driven two-stage validation.
- Conventions: Zod DTO + `ZodValidationPipe` · `AllExceptionsFilter` + request/correlation id · controller→service→repository layering · Vitest/Pytest/Flutter CI gates.
- **Dead decisions (never rebuild):** Employer entity, 100-pt score, RVM-as-ranking, hire/no-show signals (see ledger / CLAUDE.md).
