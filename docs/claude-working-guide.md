# Claude Working Guide — BadaBhai

> The working protocol for any Claude Code session on this repo. Read after
> [CLAUDE.md](../CLAUDE.md) (the invariants), [project-memory](../.claude/project-memory.md)
> (architecture), and [team-memory](../.claude/team-memory.md) (ownership). CLAUDE.md §2
> invariants always win; this guide adds the _how-we-work-with-Claude_ layer and the safety
> guardrails.

## Golden rules (non-negotiable)

1. **Never read or print secrets.** `.env*` (except `.env.example`), `*.pem`/`*.key`,
   service-account / credentials JSON are off-limits. [`.claude/settings.json`](../.claude/settings.json)
   denies these at the tool layer and a PreToolUse hook ([`.claude/hooks/guard.mjs`](../.claude/hooks/guard.mjs))
   blocks shell exfiltration. **Humans manage secrets; Claude never reads or edits `.env`.**
2. **Never trust body-supplied IDs.** A worker/payer/company/job id in a request body is a
   _claim_, not identity. Authorization must derive the actor from the authenticated session —
   never from `dto.worker_id` etc. Phase-1 is mock-auth/no-JWT, so this is currently a known
   structural gap (see [team-memory](../.claude/team-memory.md)); when real auth lands, checking
   body ids against the session is a **blocker**, not a nice-to-have.
3. **No schema change without a migration plan.** Drizzle (`packages/db`) is the source of truth.
   Generate migrations from the schema; never hand-edit drifted SQL; write a rollback; never apply
   to a shared/prod DB without sign-off. See the [`migration`](../.claude/skills/migration/SKILL.md) skill.
4. **Always add/adjust tests for changed logic.** New behavior gets a test; privacy/event paths get
   explicit assertions (no PII, event emitted). See [`bb-testing`](../.claude/skills/bb-testing/SKILL.md).
5. **Event-first + no raw PII** (CLAUDE.md §2): every important endpoint emits a validated event;
   PII lives only in `workers`; pseudonymization runs before every LLM call and fails closed.
6. **Escalate, don't improvise** on: changing a §2 invariant, the stack, a destructive migration,
   real provider keys/spend, or anything touching production data.

## How to work

- **Phases & gates:** follow the [development workflow](engineering-org/development-workflow.md) and
  [quality gates](engineering-org/quality-gates.md); the merge gate is CLAUDE.md §6.
- **Agents** ([`.claude/agents`](../.claude/agents/)): route work to the specialist —
  backend-engineer, ai-engineer, database-architect, security-engineer/-reviewer, qa-engineer,
  test-planner, code-reviewer, migration-reviewer, devops-engineer, etc.
- **Skills** ([`.claude/skills`](../.claude/skills/)): run the procedure skills. Playbook entry
  points: `migration`, `pr-review`, `security-review`, `observability-review`, `release-check`;
  the canonical BadaBhai procedures are the `bb-*` skills they reference.
- **Memory:** keep project-memory / team-memory / the [registers](registers/) current in the same change.

## Guardrails reference

- [`.claude/settings.json`](../.claude/settings.json) — permission **deny** (secret files,
  force-push, `db reset`), **ask** (push, migrate, `supabase push`/`link`), **allow** (safe read-only).
- [`.claude/hooks/guard.mjs`](../.claude/hooks/guard.mjs) — PreToolUse hook; **fail-open**; blocks
  secret reads + catastrophic shell. Self-test: `node .claude/hooks/guard.selftest.mjs` (expect 0 failures).
- To temporarily disable the hook: remove the `hooks` block from `.claude/settings.json`.

## Commands

See CLAUDE.md §5. On Windows use `corepack pnpm` and prefix with
`PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false` (see project-memory "Developer Notes").

## File risk classification (use during review)

- **Low:** docs, tests, isolated UI, additive non-exported helpers.
- **Medium:** service logic, new endpoints/DTOs, versioned event payloads, config defaults.
- **High:** auth/authorization, RLS/migrations, the pseudonymization/AI privacy path, shared
  contracts (event-schema, ai-contracts), money/credits.
- **Critical:** production data/secrets, destructive migrations, the fail-closed pseudonymization
  gate. → plan + human sign-off **before** code.
