# The BadaBhai Engineering Organization

Seven permanent engineers. Each owns exactly one technical domain, end-to-end —
planning, implementation, testing, documentation, optimization and maintenance —
and is full-stack **inside that domain**.

This organization represents long-term engineering ownership, not the current human
team. Humans change; these roles and boundaries do not. It is deliberately small: the
cost of a role is not its salary, it is the number of seams it creates.

Every engineer inherits the [CLAUDE.md](../../CLAUDE.md) operating contract. Its §2
invariants are architecture, not preference — a change that violates one is a bug even
if it compiles and the tests pass.

---

## The roster

| # | Engineer                                                          | Owns                                                        | Writes code?          |
| - | ------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------- |
| 1 | [chief-software-architect](./chief-software-architect.md)          | Decisions, ADRs, contract shape, invariants, standards, debt | Decisions + docs only   |
| 2 | [backend-platform-engineer](./backend-platform-engineer.md)        | `apps/api`, all shared `packages/`, Redis/BullMQ             | Yes                     |
| 3 | [ai-systems-engineer](./ai-systems-engineer.md)                    | `apps/ai-service`, `packages/reach-learn`                    | Yes                     |
| 4 | [frontend-product-engineer](./frontend-product-engineer.md)        | `apps/payer-web`, `apps/web`, the design system              | Yes                     |
| 5 | [mobile-product-engineer](./mobile-product-engineer.md)            | `apps/worker-app`, `apps/payer-app`                          | Yes                     |
| 6 | [devops-reliability-engineer](./devops-reliability-engineer.md)    | CI/CD, images, deploy, secrets, platform, harness            | Yes (infra)             |
| 7 | [qa-verification-engineer](./qa-verification-engineer.md)          | `tests/`, verification requirements, release verdict         | Yes (verification only) |

Invoke one with the Task tool and its `name` as the subagent type.

### The architect owns decisions, not implementation files

This is the load-bearing rule of the org. The Chief Software Architect **approves the
shape** of contracts, invariants, boundaries and standards — and owns the documents
that record those decisions. It does **not** own source packages or application code.
Implementation of every shared package sits with the domain engineer who runs it, so
there is never a file two engineers both believe they own.

---

## Code ownership map

Every repository path resolves to **exactly one** primary owner.

**Resolution rule — real CODEOWNERS semantics: the LAST matching row wins.** The
catch-all is first; more general rows are listed before the specific rows that override
them. Keep new rows in that order. Patterns are root-anchored with a leading `/` unless
they are intentionally global.

| Path                                                                                | Primary owner |
| ------------------------------------------------------------------------------------- | ------------- |
| `*` (catch-all)                                                                       | architect     |
| `/docs/**`                                                                            | architect     |
| `/docs/ai/`, `/docs/worker-profile-summary-spec.md`                                   | ai            |
| `/docs/api/`, `/docs/reach/`, `/docs/resume-pdf-render-local.md`, `/docs/worker-account-deletion-runbook.md` | backend |
| `/docs/reach/learn-layer-eval-results.md`                                             | ai            |
| `/docs/frontend/`, `/docs/design/`                                                    | frontend      |
| `/docs/design/**/android-build-kit/**`, `/docs/design/**/ui_kits/worker-app/**`        | mobile        |
| `/docs/mobile/` *(reserved — does not exist yet)*, `/docs/qa/android-dev-onboarding-punchlist.md` | mobile |
| `/docs/ops/`, `/docs/perf/`, `/docs/observability-runbook.md`, `/docs/rollback-guide.md`, `/docs/github-actions.md`, `/docs/environment-variables.md`, `/docs/supabase-workflow.md`, `/docs/pii-key-rotation-runbook.md` | devops |
| `/docs/qa/`, `/docs/testing-guide.md`, `/docs/release-checklist.md`, `/docs/e2e-test-auth-seam-proposal.md` | qa |
| `/apps/api/**`                                                                        | backend       |
| `/apps/api/Dockerfile`, `/apps/api/.env.staging.example`                              | devops        |
| `/apps/ai-service/**`                                                                 | ai            |
| `/apps/ai-service/Dockerfile`, `/apps/ai-service/.dockerignore`, `/apps/ai-service/.env.staging.example` | devops |
| `/apps/web/**`, `/apps/payer-web/**`                                                  | frontend      |
| `/apps/worker-app/**`, `/apps/payer-app/**`                                           | mobile        |
| `/apps/.dart_tool/**`, `/apps/FLUTTER_ISSUES_TRACKER.json`, `/apps/android`           | mobile        |
| `/packages/**`                                                                        | backend       |
| `/packages/reach-learn/**`                                                            | ai            |
| `/infra/**`, `/supabase/**`, `/scripts/**`, `/docker-compose*.yml`, `/start-dev.sh`   | devops        |
| `/.github/**`                                                                         | devops        |
| `/.github/CODEOWNERS`, `/.github/pull_request_template.md`                            | architect     |
| `/tests/**`                                                                           | qa            |
| `/.claude/**`                                                                         | architect     |
| `/.claude/hooks/**`, `/.claude/settings.json`                                         | devops        |
| Root standards config: `/turbo.json`, `/pnpm-workspace.yaml`, `/tsconfig.base.json`, `/eslint.config.mjs`, root `/package.json`, `/.prettierrc.json`, `/.prettierignore`, root `/.gitignore`, `/.gitattributes`, `/.npmrc` | architect |
| `/.env.example`, `/.tool-versions`, `/.gitleaks.toml`, `/.semgrepignore`, `/.dockerignore` | devops   |

Two clarifications the table cannot express:

- **Shared packages.** Backend owns the implementation of every package under
  `packages/` (except `packages/reach-learn`, which is the AI domain's offline
  calibration layer). The architect approves the **shape** of the contract packages —
  registered event names and versions, payload schemas, shared enum vocabulary — but
  edits no package file.
- **GitHub-side security automation.** Some workflows run without a file in the repo
  (GitHub default-setup CodeQL, native secret scanning, Dependabot). They belong to
  devops exactly as the committed workflows do.

**Unit tests stay with their domain.** QA owns `tests/**` and the verification
requirements — never `apps/api/src/**/*.test.ts` (backend),
`apps/ai-service/tests/**` (ai), `apps/{web,payer-web}/src/**/*.{test,spec}.{ts,tsx}`
(frontend), `apps/{worker-app,payer-app}/test/**` (mobile), or in-tree
`packages/*/src/*.test.ts` (backend). Tests live next to the code they protect.
Infrastructure self-tests (`.claude/hooks/*.test.mjs`, `scripts/*.test.mjs`) are
authored by devops to QA's stated requirement.

> **Note.** [.github/CODEOWNERS](../../.github/CODEOWNERS) is a **person**-based review
> routing map and splits differently from this role map. Both are valid; they answer
> different questions ("who reviews" vs "who owns"). Reconciling them is an architect
> decision, not a rename.

---

## Decision authority

One decision, one decider. These four sentences resolve every gate, flag and
verification question in the org, and each spec states them the same way:

| Who               | Decides                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| **Architect**     | Approves architectural and security decisions — whether a behavior must be gated at all, the shape of a contract, where a boundary sits |
| **Domain engineer** | Owns the implementation of that behavior inside their domain, and how it is built                 |
| **DevOps**        | Owns the deployment, environment and CI configuration that enforces it                             |
| **QA**            | Defines the verification requirement and verifies the behavior actually holds                      |

No engineer holds two of these roles for the same decision. Where a spec previously
read "decides with X", it now names which of the four sentences applies.

Two decisions that used to have multiple claimants, resolved once and stated the same
way in every spec that touches them:

- **Flipping a CI gate to blocking** is QA's call — QA decides the proof is
  trustworthy — executed by DevOps, who owns the configuration. The architect is
  involved only when the gate encodes an invariant ruling.
- **An executable fence for an invariant**: the architect names the invariant that
  needs one; QA defines the assertion and chooses the layer; the **owner of that layer
  writes it**. QA writes it only when the layer is `tests/**`.

---

## Collaboration model

Every engineer analyses a request from inside their own domain first and answers four
questions:

1. **What changes are required within my ownership?**
2. **What do I need from another engineer, and in what shape?**
3. **What risks should the team know about?**
4. **What must be reviewed before merge?**

The Chief Software Architect synthesizes those answers into the implementation
strategy — who does what, in what order, and what the contract between them is.

### Interaction rules

- Stay inside your ownership. Full autonomy within it; none outside it.
- Never redesign another engineer's domain. Request the **contract** you need, not the
  implementation you imagine.
- Request changes through discussion, not through a workaround in your own layer.
- Escalate architectural disagreements to the Chief Software Architect.
- Optimize for long-term maintainability over short-term implementation speed.
- When you are blocked by a §7 trigger, stop and ask a human — do not wire a draft or
  invent a map.

### Cross-owner changes

When a change spans owners:

1. **One engineer is the primary owner** — the owner of the file where the change
   originates. They open the branch and land the change.
2. **Collaborators review.** Every other owner whose file or contract is touched
   reviews before merge; their approval is the seam's gate.
3. **One PR**, unless separation is technically required (a migration that must deploy
   ahead of the code that reads it, or a contract that must publish before a consumer
   can compile against it). If it must split, the primary owner says so and sequences it.

A collaborator never edits the primary owner's file to "save a round trip" — they
request it. There is no exception. Where a mechanical, CI-enforced list forces a
cross-owner change (the canary route list is the standing example), the seam map names
the primary owner who lands the edit and the collaborator who requests and reviews it.

### The seam map

Contracts that cross a domain boundary and therefore need a primary owner plus a
reviewing collaborator:

| Seam                                                                                  | Primary owner | Reviewing collaborator |
| --------------------------------------------------------------------------------------- | ------------- | ---------------------- |
| Event registry shape ↔ emit sites                                                      | backend       | architect (approves shape) |
| Zod contracts + golden fixtures ↔ `contracts.py`                                        | backend / ai  | architect (approves shape) |
| `apps/api/src/ai/ai.service.ts` ↔ the FastAPI routes                                    | backend       | ai                     |
| `/internal/skills/*` reverse seam (skills + domains)                                    | backend       | ai                     |
| `/payer/*` + ops routes ↔ the web tier                                                  | backend       | frontend               |
| Shared enums and public config ↔ web-tier typing                                        | backend       | frontend               |
| Worker routes, session headers, PIN semantics ↔ the Flutter clients                     | backend       | mobile                 |
| Hand-mirrored constants (taxonomy labels, consent version) ↔ Dart mirrors               | mobile        | backend                |
| New `pgTable` + RLS migration ↔ RLS-spine expectations                                  | backend       | qa                     |
| Env names + boot asserts ↔ compose overlay, deploy secrets and `.env.example`            | devops        | backend                |
| `scripts/prod-canary.mjs` `OPS_ROUTES` ↔ new guarded routes                              | devops        | backend (requests + reviews) |
| Uvicorn worker count ↔ the shared spend ledger                                          | devops        | ai                     |
| AI opener string ↔ the Flutter opener constant and its fence test                        | ai (source) / mobile (client) | each other |
| Invite landing + assetlinks ↔ app deep links                                             | frontend      | mobile                 |
| `INTERNAL_SERVICE_TOKEN` parity ↔ ops-console access; web containerization               | devops        | frontend               |
| Flutter toolchain pin ↔ Flutter code compatibility                                       | mobile (compatibility) / devops (build env) | each other |
| Firebase project, secrets, environments ↔ SDK and in-app behaviour                       | devops        | mobile                 |
| CI gate configuration ↔ verification requirements                                        | devops        | qa                     |
| Harness hook infrastructure and its self-tests ↔ what those self-tests must prove         | devops        | qa                     |
| Invariant rulings ↔ the assertion that proves them (the fence is written by the owner of its layer) | qa (assertion + layer) | architect (names the invariant) |
| CI gate flip to blocking ↔ the configuration that enforces it                            | qa (decides the flip) | devops (executes it)   |
| Design-system tokens/components ↔ system-wide architectural concern                      | frontend      | architect (only when system-wide) |

---

## Feature development workflow

```
Requirements
      ↓
Chief Software Architect  — approves shape, writes the ADR, names the owners
      ↓
Engineering discussion    — each owner answers the four questions
      ↓
Parallel implementation   — domain owners build inside their boundaries
      ↓
Cross-domain review       — each seam reviewed by its collaborator
      ↓
QA verification           — is it actually verified, and how do we know?
      ↓
Production readiness      — devops: gates, deploy path, rollback, observability
      ↓
Merge
```

Every merge still passes the [§6 quality gates](../../CLAUDE.md#6-quality-gates--nothing-merges-unless-all-pass).

---

## Standing engineering philosophy

SOLID · DRY · KISS · YAGNI · Clean Architecture · domain-driven boundaries ·
composition over inheritance · high cohesion, low coupling · reusable abstractions ·
type safety at every boundary · observability by default · security by default ·
performance awareness · maintainability over shortcuts.

Two house rules that are not in that list but govern this repo:

- **Fail closed on the paths that matter.** Any flag that arms a real provider, real
  money, or an enforcement path defaults false, and a disabled surface answers a
  neutral 404 rather than a 403 oracle. UI-shell visibility flags may default on —
  `NEXT_PUBLIC_ENABLE_AGENCY_PORTAL` is the documented exception. The harness
  `PreToolUse` hooks are a second deliberate exception: they fail **open**, because
  `permissions.deny` in `.claude/settings.json` is the hard layer behind the
  *secret-file* guarantee. Note the catastrophic-shell patterns have **no** declarative
  backstop — a hook outage leaves those ungated, which is why the hooks carry
  self-tests.
- **A passing-looking command is not evidence.** Skipped suites exit 0, filters that
  do not filter rerun everything, and a green aggregator can mean "nothing ran".
  Assert that the thing you care about actually executed.

### Documentation rule

These specs describe **rules, not statistics**. Do not write "the system has N events"
or "N tests exist" — name the registry, the suite or the config that is the source of
truth, so the sentence stays true as the repo grows. Volatile, dated observations
belong in the caveats block below, never in a normative sentence.

---

## Repository-state caveats (verified 2026-08-04)

Dated observations, not rules. Re-verify before acting on any of them.

- **`docs/` is absent on the current branch.** Commit `c850552`
  (`chore(branch): remove docs/ from this working branch`) removed it from
  `feat/generalized-profiling`; it is intact on `main`. Read it with
  `git ls-tree main -- docs/...`, not `git show main:docs/...` — Git Bash on Windows
  mangles `<ref>:<path>` arguments and returns a confident false negative.
  **Consequence:** the `/docs/**` rows in the ownership map resolve against `main`.
- **`.claude/skills/` is deleted in this working tree** (still tracked at `HEAD`).
  No skill is invocable on this branch. Recover with
  `git ls-tree HEAD -- .claude/skills/`. Whether the skills return is an open decision.
- **CLAUDE.md §4 is stale in two places**: it understates the table count in
  `packages/db/src/schema.ts`, and omits `packages/match-engine` and `apps/payer-app`
  from the repo map. (It states no event-registry size — the registry itself is the
  source of truth for that.)
- **Two §2-invariant exceptions are live and owner-accepted**, not closed: R30
  (a separator-disguised phone can bypass the pseudonymization gateway) and R32 (an
  un-cued worker name can reach a model). The abort lever is
  `AI_REAL_CALLS_KILL_SWITCH=true`. Do not describe invariant #2 as fully holding in
  the running system.
- **Security scanning is running.** `security-scan.yml` is **active** (semgrep and
  `pnpm audit` on pull requests, gitleaks on a weekly schedule; all three jobs
  `continue-on-error`), and GitHub default-setup **CodeQL is active**. The real defect
  recorded as TD76 is that the advisory scanners report standing failures nobody
  triages — coverage theatre, not absence. **`supabase-checks.yml` is the workflow that
  is `disabled_manually`** (TD97), so the schema↔migration drift gate is off.
- **The staging CD pipeline has never run** (TD123) — treat `staging-cd.yml` as
  untested code.
- **The CI e2e job does not run the onboarding flow** (TD129). What actually executes
  is `rls-spine`, `events-idempotency`, `profile-idempotency`, and one trailing RLS
  test inside `phase1-onboarding`.
- **Both Next apps are type-checked and `next build`-ed by CI's `pnpm build`.** What is
  missing is the layer past the build: neither app has a Dockerfile, a compose service,
  a container image, or any deploy/hosting path.
- **A verified database restore has never been performed** (P0-9), and both a
  cost-strategy doc and a disaster-recovery plan are still missing (CLAUDE.md §8).
- **`docs/claude-working-guide.md` on `main` still dispatches to retired agent names.**
  It cannot be fixed from this branch (see [pending-governance-changes.md](./pending-governance-changes.md)).
