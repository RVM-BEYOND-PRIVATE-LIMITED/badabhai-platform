# The local `.env` hazard — smaller than it looks today, and worth fixing anyway

**2026-08-27 · investigation only · the file was NOT edited, moved, or deleted**

The developer `.env` at the repository root contains:

```
SKILL_CANONICALIZE_ENABLED=true
DATABASE_URL=<the PRODUCTION Supabase cluster>
NODE_ENV=production
AI_ENABLE_REAL_CALLS=true
AI_SERVICE_URL=http://localhost:8000
```

A locally-started ai-service therefore boots with canonicalization **on**, on a workstation whose
database credentials point at production. That is the hazard as it appears. What follows is what
it actually is, because the two differ and the difference matters.

---

## What CANNOT happen today

**The ai-service cannot write to the database. Not "should not" — cannot.**

It is DB-free by design. Every canonicalization write goes through `get_skill_store()`:

```python
def get_skill_store(settings: Settings) -> SkillCanonicalStore:
    if settings.backend_api_url and settings.skills_internal_token:
        return HttpSkillStore(settings.backend_api_url, settings.skills_internal_token)
    return NullSkillStore()
```

Measured in this environment:

```
BACKEND_API_URL          ABSENT   -> seam inert
SKILLS_INTERNAL_TOKEN    ABSENT   -> seam inert
```

Both are unset, so the store is `NullSkillStore` and the TD65 chain — **store AND flag**, never
the flag alone — is broken at the store. A local `/skills/canonicalize` call today does its
retrieval and records nothing, anywhere. The comment in `config.py` says exactly this: *"the
wiring cannot activate by flag alone"*.

> **Correction to an earlier statement in this programme.** A note written on 2026-08-27 said a
> local ai-service started from this file would write `unresolved_phrase` rows and assign skills
> against production data. **That was wrong** — it assumed the flag was sufficient, and it is
> not. The seam has to be configured too, and it is not configured here. The corrected
> assessment is below.

## What CAN happen — the real risk, which is conditional and quiet

The danger is not today's state. It is that **the dangerous half is already switched on**, so
whoever completes the other half gets no warning.

A developer wiring the FORK-B-1 seam locally — the obvious reason anyone would set
`BACKEND_API_URL` and `SKILLS_INTERNAL_TOKEN` — expects to be testing *the seam*. They will not
expect canonicalization to arm itself at the same moment, because they did not turn it on; it
was already on. And `BACKEND_API_URL` on a laptop points at a local NestJS api, which reads
`DATABASE_URL` from this same file: **production**.

The result would be real `unresolved_phrase` and `worker_skill` rows written from a laptop,
outside every gate this programme built, against a corpus that grew from 49 to 111 active skills
on 2026-08-27. Nothing would fail; the writes would simply succeed.

Two properties make it hard to notice:

- **`/skills/canonicalize` returns an identical body whether the flag is on or off**, by design.
  Local behaviour gives no signal about which state you are in.
- **`AI_ENABLE_REAL_CALLS=true` with a live Gemini key** is also set here, so the same path
  spends real money per phrase. (That is deliberate and useful — it is what paid the authorised
  ₹0.00563 for this phase — but it compounds the surprise.)

**Severity: low today, high the moment two unrelated variables are added.** It is a latent
hazard, which is the kind worth fixing before it fires rather than after.

---

## Proposed fixes — the file is the operator's, so these are proposals

### Recommended: change one line locally

```diff
- SKILL_CANONICALIZE_ENABLED=true
+ SKILL_CANONICALIZE_ENABLED=false
```

Zero cost, zero side effects. Nothing in this repository reads it locally, no test depends on
it, and no runner in `packages/db` consults it — the flag is read only by the ai-service
process. **This alone removes the hazard.**

### Also worth doing: point local work at the local database

`badabhai-postgres` is already running on this workstation. Pointing `DATABASE_URL` at it would
break the far larger standing hazard — that every `packages/db` script hits production by
default — of which this flag is one instance. Larger change, separate decision, noted here
because the two share a root cause.

### The durable fix, and it belongs in code — a boot-time refusal

Neither of the above survives the next `.env` copied from a teammate. The seam already knows how
to fail closed; it should refuse this combination outright. In `apps/ai-service/app/config.py`,
at settings validation:

> **Refuse to boot when `skill_canonicalize_enabled` is true, the skill store is configured, and
> the target is not a local database** — i.e. arm canonicalization against production only when
> something explicitly says so (a `CANONICALIZE_ALLOW_PRODUCTION=<reason>` acknowledgement, the
> same two-signal shape `ops-guard.ts` already uses for `packages/db` writers, which has worked
> for every production write in this programme).

That turns a silent misconfiguration into a startup error naming the cause, and it costs one
check. Owner: the AI Systems Engineer (`apps/ai-service`, CLAUDE.md §7) — **recommended, not
built here**, because it is outside this change's scope and ownership.

### Not recommended

Deleting or rewriting `.env` from tooling, or committing any variant of it. It holds live
credentials, it is correctly gitignored, and it is the operator's file.

---

## Why this does not block activation

The deployed value is a GitHub Actions secret. This file has **no bearing** on it, is not read by
any deploy path, and must not be used to infer it — see
[`canonicalize-flag-read-2026-08-27.md`](./canonicalize-flag-read-2026-08-27.md). It is recorded
here as a developer-workstation hazard and nothing more.
