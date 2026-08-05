# Ownership Map — every path has exactly one primary owner

Source of truth for **who owns what**. Companion to
[organization.md](./organization.md). Verified against the working tree on 2026-08-04.

**Rule:** every tracked path resolves to exactly one primary owner. A path with no owner is
a bug — the Chief Software Architect assigns one before the PR merges. "Collaborators"
listed below must be consulted, but they do **not** co-own: the primary owner decides.

**Legend** — `ARCH` Chief Software Architect · `BE` Backend Platform · `AI` AI Systems ·
`FE` Frontend Product · `MOB` Mobile Product · `OPS` DevOps & Reliability · `QA` QA &
Verification.

---

## apps/

| Path | Owner | Collaborators | Notes |
| ---- | ----- | ------------- | ----- |
| `apps/api/**` | **BE** | ARCH (contracts), AI (`src/ai` seam) | All 37 modules incl. `auth`, `chat`, `profiles`, `resume`, `events`, `queue`, `payer-portal`, `admin`, `reach`, `pricing`, `unlocks`. |
| `apps/api/src/ai/**` | **BE** | AI | The **API side** of the AI bridge. The HTTP boundary is the seam: BE owns the caller, AI owns the service. |
| `apps/ai-service/**` | **AI** | ARCH (contract parity), BE (caller) | Includes `pseudonymize.py`, `contracts.py`, `llm.py`, `extraction.py`, `stt.py`, `ai/router.py`. |
| `apps/web/**` | **FE** | — | Internal ops console (Next.js). |
| `apps/payer-web/**` | **FE** | — | External self-serve payer + agency portal. |
| `apps/admin-web/**` | **FE** | — | Admin portal (Next.js). |
| `apps/worker-app/**` | **MOB** | FE (design tokens) | Flutter, Android-first. |
| `apps/payer-app/**` | **MOB** | FE (design tokens) | Flutter payer client. |
| `apps/FLUTTER_ISSUES_TRACKER.json` | **MOB** | — | |
| `apps/android` | **MOB** | — | ⚠️ Tracked **0-byte stray file**, not a directory. Owner to delete or explain. |

## packages/

| Path | Owner | Collaborators | Notes |
| ---- | ----- | ------------- | ----- |
| `packages/event-schema/**` | **ARCH** | BE (primary consumer) | Cross-service contract. Payload changes are **versioned, never mutated** (invariant #8). |
| `packages/ai-contracts/**` | **ARCH** | AI, BE | Zod side. Must stay mirrored with `apps/ai-service/app/contracts.py` (AI owns the Pydantic side). |
| `packages/db/**` | **BE** | ARCH (model), OPS (apply), `migration-reviewer` (gate) | Drizzle schema + the migration spine. **55 tables** (counted 2026-08-05); `schema.ts` is the source of truth. ⚠️ CLAUDE.md §4 still says 43 — drift for ARCH to close. |
| `packages/config/**` | **BE** | OPS (env surface) | Typed env, server/public split. |
| `packages/types/**` · `packages/validators/**` · `packages/taxonomy/**` | **BE** | — | Shared TS contracts. |
| `packages/pricing/**` · `packages/reach-engine/**` · `packages/reach-learn/**` · `packages/match-engine/**` | **BE** | ARCH | Deterministic engines. **No learned ranking on the live path** (invariant #4). ⚠️ `match-engine` is absent from the CLAUDE.md §4 repo map — doc drift for ARCH to close. |

## infra/ · deployment · CI

| Path | Owner | Collaborators | Notes |
| ---- | ----- | ------------- | ----- |
| `.github/**` (workflows, CODEOWNERS, PR template, dependabot) | **OPS** | all owners for their own path filters | Includes `ci.yml`, `staging-cd.yml`, `security-scan.yml`, `worker-app.yml`, `payer-app.yml`, `supabase-checks.yml`. |
| `infra/docker/**` · `infra/monitoring/**` · `infra/redis/**` | **OPS** | BE (queue behavior) | OPS provisions Redis; **BE owns queue code** in `apps/api/src/queue`. |
| `infra/supabase/**` (rls-plan, storage-buckets, migration-plan) | **BE** | OPS (apply), `security-engineer` (gate) | Data-authorization **design** is BE; the pipeline that applies it is OPS. |
| `supabase/config.toml` | **OPS** | — | Local stack config. |
| `docker-compose*.yml` · `start-dev.sh` · `scripts/**` | **OPS** | — | Incl. `smoke.mjs`, `staging-smoke.mjs`, `prod-canary.mjs`. |
| `turbo.json` · `pnpm-workspace.yaml` · root `package.json` · `pnpm-lock.yaml` | **OPS** | ARCH | Build/workspace wiring. Note: `pnpm-workspace.yaml` also holds pnpm `overrides`. |
| `tsconfig.base.json` · `eslint.config.mjs` | **ARCH** | OPS (CI wiring) | Language + lint standard. |
| `.claude/hooks/**` · `.claude/settings*.json` | **OPS** | `security-engineer` | Tool guardrails (`guard.mjs`, `guard-secrets.mjs`) — change together, probe end-to-end. |

## tests/

| Path | Owner | Collaborators | Notes |
| ---- | ----- | ------------- | ----- |
| `tests/e2e/**` · `tests/contract/**` · `tests/security/**` | **QA** | domain owner of the flow under test | Cross-cutting suites only. |
| Co-located unit/integration tests inside `apps/*` and `packages/*` | **domain owner** | QA (standards) | QA sets the bar; the owner writes and maintains them. |

## docs/

Rule: **`docs/<area>/` is owned by the engineer who owns the code that area documents.**

| Path | Owner |
| ---- | ----- |
| `docs/decisions/` (ADRs) · `docs/architecture/` · `docs/engineering-org/` · `docs/registers/` · `docs/bible/` · `docs/specs/` · `docs/product/` · `docs/sprint-plans/` · `docs/tracker/` · `docs/security/` · `docs/legal-later/` · `docs/reports/` | **ARCH** |
| `docs/api/` · `docs/schema/` · `docs/reach/` | **BE** |
| `docs/ai/` | **AI** |
| `docs/frontend/` · `docs/design/` (Design System source of truth) | **FE** (MOB is a required collaborator on any token/primitive change) |
| `docs/qa/` · `docs/testing-guide.md` · verification runbooks | **QA** |
| `docs/ops/` · `docs/observability-runbook.md` · `docs/rollback-guide.md` · `docs/release-checklist.md` · `docs/github-actions.md` · `docs/environment-variables.md` · `docs/supabase-workflow.md` · `docs/pii-key-rotation-runbook.md` | **OPS** |
| `docs/perf/` | **QA** (load/perf validation; hot-path fixes belong to the code owner) |
| `docs/claude-working-guide.md` · `docs/post-alpha-hardening-plan.md` · `docs/e2e-test-auth-seam-proposal.md` | **ARCH** |
| `docs/worker-account-deletion-runbook.md` · `docs/worker-profile-summary-spec.md` · `docs/resume-pdf-render-local.md` · `docs/admin-foundation-verification-runbook.md` · `docs/security-checklist.md` | owner of the feature it documents (BE unless the map says otherwise); the **runbook pattern** is QA's |

## Root

| Path | Owner | Notes |
| ---- | ----- | ----- |
| `CLAUDE.md` · `README.md` · `SECURITY.md` | **ARCH** | CLAUDE.md changes are an architecture action. |
| `.claude/agents/**` · `.claude/*.md` (project/team memory) | **ARCH** | The org definition itself. |
| ~~`.claude/skills/**`~~ | — | **Retired 2026-08-05** (owner decision). Path no longer exists; no owner. Each agent's Review checklist carries its procedure. |
| `issues.txt` | **ARCH** | Tracked scratch file; candidate for removal. |
| `dump.rdb` · `edge.log` · `coverage/` · `node_modules/` | *unowned* | Untracked runtime/build artifacts. Should be gitignored, not owned. |

---

## Cross-cutting concerns

Concerns that span surfaces but must still resolve to **one** owner. None of these creates a new
engineer; each attaches to an existing domain.

| Concern | Owner | Rule |
| ------- | ----- | ---- |
| **Localization / regional language** | the **surface owner** | Each owner owns the localized content and locale behavior of their own surface: **MOB** for `apps/worker-app` + `apps/payer-app`, **FE** for the three Next.js apps, **BE** for server-generated strings. No cross-cutting i18n owner exists; if a shared translation contract is ever needed, **ARCH** defines it as a contract like any other seam. |
| **Product analytics on the event spine** | **BE** | The `events` table and all queries over it belong to Backend Platform, which owns the data. **ARCH** owns the *event contract* being analyzed; **QA** owns event-emission correctness. Analytics is a read over BE's data, not a new domain. |
| **Dependency upgrades** | split, explicitly | **OPS** owns the update mechanism (`dependabot.yml`, lockfile, CI pins, the Flutter/toolchain pins). The **domain owner** owns upgrading a dependency inside their own paths (e.g. a NestJS major is BE's, a Next.js major is FE's) — including the migration work and the regression risk. Root `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` remain OPS. |

## Open ownership issues (assigned, not yet resolved)

1. ✅ **`.claude/skills/` — RESOLVED (retired 2026-08-05, owner decision).** All 24 skills
   (25 files) were removed from the repository, and every reference to them was cleaned up in
   the same change: 18 links in the agent + engineering-org docs, and 22 links across six
   operational docs (`rollback-guide`, `release-checklist`, `observability-runbook`,
   `security-checklist`, `testing-guide`, `claude-working-guide`). Skill names survive as plain
   text where they carried meaning. Recoverable from git history. Each agent's **Review
   checklist** is now the procedure of record.
2. **`.github/CODEOWNERS` is human-keyed, this map is role-keyed.** They currently disagree
   (CODEOWNERS splits `apps/api` between two humans and marks `packages/db` dual-owned).
   **Owner: OPS**, with ARCH — reconcile CODEOWNERS to this map so the automated reviewer
   request matches the org.
3. **`packages/match-engine` missing from the CLAUDE.md §4 repo map. Owner: ARCH.**
4. **`apps/android` — tracked 0-byte file. Owner: MOB.**
