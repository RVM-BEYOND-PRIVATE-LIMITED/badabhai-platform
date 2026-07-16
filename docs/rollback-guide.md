# Rollback Guide

> How to back out a bad change in BadaBhai with the smallest blast radius and no
> data loss. This is the companion to the [`bb-deployment`](../.claude/skills/bb-deployment/SKILL.md)
> skill (which requires a written rollback per change) and the
> [`bb-root-cause-analysis`](../.claude/skills/bb-root-cause-analysis/SKILL.md)
> skill (which runs _after_ the system is stable again).

**First principle.** Stabilize first, diagnose later. Pick the fastest safe lever
that stops the harm, then do the RCA. The four levers below are ordered by speed:
an **env gate flip** is faster and safer than a **code redeploy**, which is far
safer than touching the **database**.

| Lever                     | Speed      | Risk    | When                                                                            |
| ------------------------- | ---------- | ------- | ------------------------------------------------------------------------------- |
| 1. Env gate / kill-switch | Seconds    | Lowest  | A gated feature (AI / resume render / payments) is misbehaving                  |
| 2. Code revert / redeploy | Minutes    | Low     | A code defect not behind a gate                                                 |
| 3. Database               | Slow       | Highest | A migration is actively breaking reads/writes (rare — usually fixed by lever 2) |
| 4. Event schema           | Code-speed | Low     | A newly-emitted event is wrong (rollback = stop emitting it)                    |

---

## The first 15 minutes (incident sequence)

1. **0–2 min — Detect & declare.** Note the symptom, the time, and the last deploy
   (the [`bb-deployment`](../.claude/skills/bb-deployment/SKILL.md) "watch logs in
   the first window" step usually surfaces this). The `events` table is the audit
   spine — use it plus structured logs (request id / correlation id from
   `apps/api/src/common/middleware/request-id.middleware.ts`) to scope blast radius.
2. **2–5 min — Choose the smallest lever.** Is the broken behavior behind an env
   gate? → **flip it off** (lever 1, fastest). Otherwise → **revert/redeploy the
   previous build tag** (lever 2). Only consider the DB (lever 3) if a migration is
   actively breaking the running system.
3. **5–10 min — Apply & verify.** After the change, confirm `/health` is green,
   events are flowing, and the symptom is gone in the ops console (read-only
   workers / events / ai-jobs views).
4. **10–15 min — Confirm no PII leaked.** If the incident touched the AI boundary,
   events, `ai_jobs`, `audit_logs`, or logs, verify no raw PII escaped the `workers`
   table (CLAUDE.md §2). A privacy incident is escalated immediately, not after.
5. **After stable — RCA.** Run [`bb-root-cause-analysis`](../.claude/skills/bb-root-cause-analysis/SKILL.md):
   reconstruct the timeline from events/logs/deploys, reach the systemic cause, and
   record the prevention in [`docs/registers/`](registers/) (risks / tech-debt /
   decisions).

**Escalate to a human immediately** (CLAUDE.md §7) for: any suspected PII leak, any
destructive/irreversible DB step, anything touching real LLM/OTP/SMS/payment
providers, or anything touching production data.

---

## 1. CODE rollback (git revert / redeploy a previous build tag)

The default, lowest-drama rollback. Because the DB rule is **backward-compatible
only** (see §2), reverting the code is almost always sufficient — the previous build
still reads the new schema.

- **Prefer redeploying the previous immutable build tag** over rebuilding from a
  reverted branch. The old artifact is already known-good and already passed
  [CI](../.github/workflows/ci.yml) / the [quality gates](engineering-org/quality-gates.md).
- **If you must revert in git:** branch off `main`, `git revert <sha>` (don't
  force-push history), open a PR, let CI go green, merge, redeploy. One logical
  change per revert PR — same mechanics as [development-workflow.md](engineering-org/development-workflow.md#branch--pr-mechanics).
- **Ordering vs. the DB:** code that depends on a migration must be deployed _after_
  it (the [`bb-deployment`](../.claude/skills/bb-deployment/SKILL.md) rule). On
  rollback this is automatically safe **because migrations are additive** — the old
  code does not need the new column and simply ignores it. Do **not** also revert the
  migration (see §2).

### Concrete recipe — redeploy a previous API image on the Lightsail box (CD-4)

The deploy pipeline (`deploy-lightsail` in [ci.yml](../.github/workflows/ci.yml))
pushes every main image to GHCR under an **immutable per-commit tag**
`sha-<short7>` (first 7 hex chars of the commit sha) alongside the mutable
`:main` tag — **always roll back to a `sha-` tag, never `:main`** (`:main` moves
on the next push). On the box:

```bash
# on the Lightsail box, in ~/deployments/badabhai-platform
export API_IMAGE="ghcr.io/rvm-beyond-private-limited/badabhai-platform/badabhai-api:sha-<prev7>"
docker compose -f docker-compose.yml -f docker-compose.staging.yml --profile api pull api
docker compose -f docker-compose.yml -f docker-compose.staging.yml --profile api up -d --no-deps api
curl -sf http://localhost:3001/health   # verify before walking away
```

- **Both `-f` files and `--no-deps api` are load-bearing:** the staging overlay
  ([docker-compose.staging.yml](../docker-compose.staging.yml)) supplies
  `NODE_ENV=production` + the fail-loud `${VAR:?}` secret requirements, and
  `--no-deps` is what keeps the compose-internal postgres/redis/adminer from
  starting (they must never run on the box — R27).
- **Finding the previous good tag:** the last green `deploy-lightsail` run logs
  `Deploying image: ghcr.io/...:sha-<short7>`; equivalently, take the first 7
  chars of the last known-good main commit sha.
- Secrets resolve from the box env/`.env` (STAGING-SECRETS-1); if they are
  missing the compose commands fail loud — that is intended (R27), not a
  rollback bug.
- No DB action is needed for a code rollback: migrations are additive (§2), so
  the older image reads the newer schema.

---

## 2. DATABASE rollback

**The rule that makes this easy:** migrations are **backward-compatible and
forward-only in shared environments** (see [infra/supabase/migration-plan.md](../infra/supabase/migration-plan.md),
"Keep migrations forward-only"). Schema is authored in Drizzle
(`packages/db/src/schema.ts`, the source of truth) and migrations are generated into
[`packages/db/migrations/`](../packages/db/migrations/) by `pnpm db:generate`.

Because every shipped change is additive (new nullable column, new table, new
index), **rolling back the code is the rollback** — the previous build ignores the
new column. You almost never drop anything.

### Handling a bad migration — forward-fix, not down-migration

1. **Preferred: forward-fix.** Author a _new_ additive migration that corrects the
   problem (e.g. backfill a value, add the missing index, relax a too-strict
   constraint), then `pnpm db:generate` → review the emitted SQL → `pnpm db:migrate`.
   This keeps the migration history linear and append-only, which is what
   `db:migrate` and the journal (`packages/db/migrations/meta/_journal.json`) expect.
2. **Do NOT run a destructive down-migration on shipped data.** Dropping the column
   or table you just added will delete data written _after_ the migration shipped and
   breaks any code (old or new) still reading it. There is no automatic Drizzle
   "down" here, and hand-writing a `DROP` is exactly the failure mode the
   [`bb-database-design`](../.claude/skills/bb-database-design/SKILL.md) skill calls
   out ("destructive/irreversible change with no plan").
3. **Risky changes use expand → migrate → contract.** If a change cannot be made
   purely additively, it ships as three separate migrations across releases:
   _expand_ (add the new shape alongside the old), _migrate_ (backfill + dual-write),
   _contract_ (remove the old shape only once nothing reads it). Rolling back is then
   just "stop at the current phase" — you never have to undo a contract that already
   ran. See [development-workflow.md](engineering-org/development-workflow.md#4-database).

### Notes on the existing migrations

- Several migrations are deliberately idempotent (`IF EXISTS` / `IF NOT EXISTS`,
  e.g. [`0003_harden_workers_pii.sql`](../packages/db/migrations/0003_harden_workers_pii.sql))
  so `db:migrate` can converge a drifted DB in one pass. That helps _forward_
  convergence; it is **not** a substitute for a rollback plan.
- RLS / `FORCE` / `REVOKE` migrations (e.g. `0004`, `0009`) and anything touching
  the `workers` PII table are sign-off changes — RLS is **not finalized** (the
  backend uses the service role today, see [infra/supabase/rls-plan.md](../infra/supabase/rls-plan.md)).
  Do not roll these back without Security sign-off.

### Escalation (destructive / irreversible)

Any rollback that would **drop a column/table, delete rows, or otherwise lose data**
is destructive and **must be escalated to a human before it runs** (CLAUDE.md §7).
Never apply a migration — forward-fix or down — to a shared/remote DB (Supabase)
without sign-off. If a forward-fix is not possible and data must change, write the
data plan first (what changes, how it's reversible, who approved it) per the
[`bb-database-design`](../.claude/skills/bb-database-design/SKILL.md) "reversible, or
a written data plan" standard.

---

## 3. ENV GATE rollback (the fastest mitigation)

If the broken behavior is behind a feature gate, **flipping the gate off is the
fastest and safest rollback** — no rebuild, no migration, no PR. This is the
kill-switch concept: a single env var that disables a feature and degrades to a safe
fallback. The gates are defined and defaulted-safe in
[`packages/config/src/server.ts`](../packages/config/src/server.ts).

| Gate (env var)           | Default       | Flipping it OFF does…                                                                                                                                 |
| ------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_ENABLE_REAL_CALLS`   | `false`       | Stops real LLM calls; the AI path falls back to mock. (Master gate; also needs `GEMINI_FLASH_API_KEY` to be _on_.)                                    |
| `RESUME_RENDER_ENABLED`  | `false` (off) | Disables the WeasyPrint render step; the renderer degrades to null (no PDF) instead of crashing. Governs **both** resume and interview-kit rendering. |
| `PAYMENTS_ENABLE_REAL`   | `false`       | Stops real charges; falls back to the mock credit ledger (alpha is mock-only anyway).                                                                 |
| `INTERNAL_SERVICE_TOKEN` | unset → deny  | Unsetting it makes the ops/backend resume routes deny **all** callers (fail closed). Use to slam the door on a leaking route.                         |

**Kill-switch mechanics:**

- These gates **fail closed by design** — `false`/unset is the safe state, so a flip
  to off can never make the system _less_ safe. The boot guards
  (`realAiCallsBlockedReason`, `assertPaymentsConfig`, `assertPiiCryptoConfig`,
  `assertAuthConfig` in `server.ts`) enforce that a half-configured "on" state
  refuses to boot rather than running mis-configured.
- **A flip is an env change + a restart** of the affected service, not a code deploy.
  It is the first lever to reach for in the first-15-minutes sequence.

> TODO(verify): the exact place env vars are set per environment (Supabase project
> env, container env, secrets manager) and the restart command are environment-
> specific and not committed here. The variable **names** above are authoritative
> (from `server.ts`); the _where to set them_ is operational config.

**Never** commit a real secret or a real `.env` while doing this (CLAUDE.md §6). Only
`.env.example` (placeholders) is in the repo. Flip values in the environment, not in
git.

---

## 4. EVENT SCHEMA rollback

Events are the audit spine and are **append-only by contract**: a shipped event
payload schema is **never mutated** and a shipped event is **never dropped**
(CLAUDE.md §2 invariant 8; the envelope carries `event_version` and `schema_version`,
see [`packages/event-schema/src/envelope.ts`](../packages/event-schema/src/envelope.ts)).
Changes are **additive only** — a new event type or a new _version_ of an existing
one, registered in `packages/event-schema/src/registry.ts`.

Because changes are additive, **rolling back an event change = stop emitting the new
event** (revert the emitting code, §1). You do **not**:

- delete the new event type from the registry (something may have already validated
  against it, and removing it would break replay/validation of historical rows), or
- mutate the payload schema back to an older shape (that breaks every event already
  written under the new shape).

**Procedure:**

1. Revert/redeploy the code that emits the bad event (§1) so no _new_ bad events are
   written.
2. Leave the registry entry and the already-written rows in place — they are history.
3. If the _consumer_ (ops view, downstream) mis-handles the new event, fix the
   consumer forward rather than rewriting the events.
4. Any change to an event **payload shape** is a Backend + event-schema decision
   (coordinate per [development-workflow.md](engineering-org/development-workflow.md#5-apis));
   do not "fix" it by editing a shipped payload.

---

## Related

- [`bb-deployment`](../.claude/skills/bb-deployment/SKILL.md) — ship with a rollback ready (this guide is that rollback).
- [`bb-root-cause-analysis`](../.claude/skills/bb-root-cause-analysis/SKILL.md) — run after the system is stable.
- [`bb-database-design`](../.claude/skills/bb-database-design/SKILL.md) — backward-compatible migrations + data plans.
- [infra/supabase/migration-plan.md](../infra/supabase/migration-plan.md) — migration source of truth + forward-only rule.
- [infra/supabase/rls-plan.md](../infra/supabase/rls-plan.md) — RLS not finalized; service role today.
- [engineering-org/quality-gates.md](engineering-org/quality-gates.md) · [engineering-org/development-workflow.md](engineering-org/development-workflow.md) — the gates a rollback PR still clears.
- [docs/registers/](registers/) — where the post-incident RCA / risk / tech-debt entry lands.
