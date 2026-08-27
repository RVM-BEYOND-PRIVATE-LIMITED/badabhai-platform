# The local `.env` hazard — smaller than it looks today, and worth fixing anyway

**2026-08-27 · investigated, then FIXED under owner authorisation**
**Local flag set to `false` · boot guard added · production secret untouched**

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

## RESOLVED, 2026-08-27 — and the hazard was smaller again than the section above says

Two further facts, both measured after the analysis above was written, and both narrowing it:

**1 - The ai-service never read that file in the first place.** `config.py` anchors its env file
to its own package (`_AI_SERVICE_ROOT / ".env"`, the AI-ENV-1 fix), precisely so that running
`uvicorn app.main:app` from the repository root cannot silently load the NestJS API's root file —
the two define overlapping names with incompatible meanings. The ai-service's OWN file already
had `SKILL_CANONICALIZE_ENABLED=false`.

**2 - Nothing else consumes the root value either.** `apps/api` does not read
`SKILL_CANONICALIZE_ENABLED` at runtime; the only references are a guard test asserting the
deploy workflow wires it. So the root `true` was inert everywhere — a trap rather than a leak.

Measured directly from the local service's own configuration:

```
skill_canonicalize_enabled   False
backend_api_url set          False
skills_internal_token set    False
get_skill_store() ->         NullSkillStore
```

### What was done

- **The local value is now `false`.** One line in the root developer file, under explicit owner
  authorisation. 183 lines before, 183 after; nothing else touched. The ai-service's own file
  already read `false` and was not modified. **No production secret was changed.**
- **A boot guard now makes the dangerous combination impossible to reach by accident** — below.
- The committed `.env.example`'s `LANGFUSE_BASE_URL` was corrected from the EU/global default to
  the US region this project actually uses, with a comment explaining that a wrong region
  presents as a *credential* error. Anyone copying the example was getting traces silently
  rejected.

### The boot guard — two signals plus a topology check

`Settings._refuse_local_canonicalization_against_a_shared_api` refuses to start when **all** of:

1. `skill_canonicalize_enabled` is true, **and**
2. the FORK-B-1 seam is wired (`backend_api_url` **and** `skills_internal_token`), **and**
3. `backend_api_url` is a **loopback** host,

unless `CANONICALIZE_ALLOW_LOCAL=<reason>` is set — the same two-signal shape
`packages/db/src/ops-guard.ts` uses, where the second signal cannot be inherited by accident and
makes the operator write down why.

**Why loopback is the discriminator, and why this cannot become an outage.** Production reaches
the api over the compose network by service name (`http://api:3000`); a loopback
`backend_api_url` is not a production topology and never has been. A guard that simply refused
"both halves set" would refuse the intended production state — it would block the very
activation it exists to protect. `test_it_CANNOT_fire_on_the_deployed_topology` pins that.

The refusal names the variables and the remedy and echoes **neither the token nor the URL**; it
raises `ConfigError`, not `ValueError`, so pydantic cannot wrap the input into a
`ValidationError` that would record `backend_api_url` verbatim.

---

## Why this does not block activation

The deployed value is a GitHub Actions secret. This file has **no bearing** on it, is not read by
any deploy path, and must not be used to infer it — see
[`canonicalize-flag-read-2026-08-27.md`](./canonicalize-flag-read-2026-08-27.md). It is recorded
here as a developer-workstation hazard and nothing more.
