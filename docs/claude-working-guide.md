# Claude Working Guide (BadaBhai)

How any Claude Code session — and every human pairing with one — should operate in
this repo. This guide **points at the sources of truth**; it does not restate them.
When this guide and a source conflict, the source wins and you fix this guide.

Sources of truth, in read order:

1. [CLAUDE.md](../CLAUDE.md) — the operating contract (invariants, stack, gates, escalation).
2. [.claude/project-memory.md](../.claude/project-memory.md) — architecture, domain models, business rules, ADRs, tech debt.
3. [.claude/team-memory.md](../.claude/team-memory.md) — who owns what, active branches, coordination rules.

---

## 1. Before you explore

Read the three files above first. Do **not** rediscover architecture, ownership,
business rules, or in-flight work already documented there. Search the code only for
implementation details, or when a memory file is stale (e.g. migration count / "next
migration number" drift — verify against [packages/db/migrations/](../packages/db/migrations/)).

## 2. Guardrails the harness now enforces

[.claude/settings.json](../.claude/settings.json) (checked in, team-wide) adds two layers
so a session **cannot** leak secrets or fire a catastrophic command:

- **Declarative `permissions.deny`** — blocks Read/Edit/Write of real env files
  (`.env`, `.env.local`, `.env.production`, `.env.ci`, …) and key material (`*.pem`,
  `*.key`, `*.p12`/`*.pfx`/`*.keystore`/`*.jks`, `id_rsa*`, `id_ed25519`, `id_ecdsa`,
  `*serviceAccount*.json`, `*credentials*.json`). `.env.example` / `.env.*.example` stay
  readable. This layer holds even if the hook process never runs. `ask` gates `git push`,
  `pnpm db:migrate`, and `supabase push`/`link`.
- **Two PreToolUse hooks** (defense-in-depth — either can block a call):
  - [.claude/hooks/guard.mjs](../.claude/hooks/guard.mjs) — the comprehensive layer
    (**fail-open**): an inverted secret-file model (ANY reference to a secret file is
    suspect, except the one narrow `.env`-load pattern), echo-of-secret-value detection,
    and the full catastrophic-shell set (`rm -rf` root/home, fork bomb, `mkfs`, `dd
    of=/dev/…`, `format`, `Remove-Item -Recurse -Force` on root/home, `dropdb`, `supabase
    db reset`, destructive DDL via a DB client, force-push). Self-test:
    `node .claude/hooks/guard.selftest.mjs` (expect 0 failures).
  - [.claude/hooks/guard-secrets.mjs](../.claude/hooks/guard-secrets.mjs) — a pure,
    unit-tested `decide()` layer that additionally covers the **Grep** tool and emits a
    structured `permissionDecision: "deny"`. Spec:
    [guard-secrets.test.mjs](../.claude/hooks/guard-secrets.test.mjs)
    (`node --test .claude/hooks/guard-secrets.test.mjs`).
  - To temporarily disable the hooks: remove the `hooks` block from `.claude/settings.json`.

These are guardrails, not a substitute for judgment. The §2 invariants in
[CLAUDE.md](../CLAUDE.md) still bind every change.

## 3. Non-negotiable invariants (summary — full text in CLAUDE.md §2)

Event-first · **no raw PII past the `workers` boundary** (LLM input, events, `ai_jobs`,
`audit_logs`, logs) · pseudonymization runs before every LLM call and **fails closed** ·
LLMs assist, never decide · real LLM calls gated + off by default · DPDP consent is a
gate · typed contracts (Zod ↔ Pydantic) at every boundary · backward-compatible schema/
event changes only. A change that breaks one is a bug even if it compiles.

**Authorization rule (make it reflexive): never trust a body-supplied
user/worker/payer/company ID.** Derive identity from the authenticated principal
(guard/session), never from request input. This is how IDOR (e.g. TD29) stays closed.

## 4. Ownership — route, don't trespass

Two human owners with strict boundaries (see [team-memory](../.claude/team-memory.md)):

- **Prakash** — `auth`, `workers`, `events`, `chat`, `consent`, `profiles`, `voice`,
  `resume` download authz, `interview-kit`, E2E, CI, Drizzle migrations, ops console, Flutter.
- **Divyanshu** — `apps/ai-service/app/ai/*`, `reach`, `job-postings`, `reach-engine`,
  resume PDF render, OTP/STT real integration, pricing engine.

When work falls in an owned domain, **author the change as a plan/spec and route it to the
owning specialist agent** (see §6) for that owner to review and merge. Do not edit another
owner's domain without coordination. Migrations: check the latest number in
[packages/db/migrations/](../packages/db/migrations/) before `pnpm db:generate` — never
create a colliding number.

## 5. Workflow stages

Idea → Requirements → Architecture (ADR if structural) → DB → API/Events → Implementation
→ Tests → Security/Privacy review → Performance sanity → Deploy → Monitor. Invoke the
matching skill at each stage; details in [docs/engineering-org/development-workflow.md](engineering-org/development-workflow.md)
and [quality-gates.md](engineering-org/quality-gates.md).

## 6. Skill & agent map (playbook name → what this repo actually has)

The repo's `bb-*` skills and specialist agents already cover the generic playbook roles.
Use these — do not create duplicates:

| Need                               | Skill                                           | Agent                                       |
| ---------------------------------- | ----------------------------------------------- | ------------------------------------------- |
| Safe DB migration                  | `bb-database-design`                            | `database-architect`                        |
| Pre-merge code review              | `bb-code-review` (+ built-in `/code-review`)    | `code-reviewer`                             |
| Security / PII / RLS / IDOR        | `bb-security-review`                            | `security-engineer`                         |
| Observability / logging / alerts   | `bb-monitoring`                                 | `performance-engineer` (for hot paths)      |
| Release readiness & rollback       | `bb-deployment`                                 | `devops-engineer`                           |
| Missing unit/integration/E2E tests | `bb-testing`                                    | `qa-engineer`                               |
| API endpoint design                | `bb-api-design`                                 | `backend-engineer`                          |
| AI / pseudonymization path         | `bb-security-review` + `bb-architecture-review` | `ai-engineer` (mandatory near pseudonymize) |

Full lists: [.claude/skills/](../.claude/skills/) and [.claude/agents/](../.claude/agents/).

## 7. Escalate (stop and ask a human) when

A §2 invariant or the locked stack (§3 of CLAUDE.md) must change; a migration is
destructive/irreversible; real LLM/OTP/STT/payment keys or spend are involved; or anything
touches production data or flips an environment gate (`AI_ENABLE_REAL_CALLS`,
`RESUME_RENDER_ENABLED`, `PAYMENTS_ENABLE_REAL`, …). Gate flips need human sign-off and
staging-first — see [team-memory](../.claude/team-memory.md) "Environment gates".

## 8. Before you call it done

The merge gate is [.github/pull_request_template.md](../.github/pull_request_template.md),
enforced by [CI](../.github/workflows/ci.yml): `pnpm lint && pnpm typecheck && pnpm test &&
pnpm build` green; AI service `ruff check . && pytest` if touched; **no raw PII** anywhere
it must not be; every important new endpoint emits a validated event; DB change is
backward-compatible + migrated + has a rollback note; event payload changes are versioned;
AI contracts stay mirrored; no secrets committed; registers/docs updated. Run `/code-review`
and, for any PII/AI/auth change, `/security-review`.

## 9. Response style

Experienced engineers — no tutorials. Default to the Status / Files Changed / Issues /
Next Steps format ([CLAUDE.md §9](../CLAUDE.md)). Concise. Update the memory files and
[docs/registers/](registers/) in the same change that makes them stale.
