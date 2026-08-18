# Phase 9 — Deployment & configuration design for the Path-A rollout

> **Design only.** Nothing in this document has been applied. No code, config, secret,
> workflow, compose file, production data or deployment behaviour was changed.
> Investigated read-only 2026-08-18.
> Context: [D0 decision](./PHASE-9-D0-PRODUCTION-RETRIEVAL-DECISION.md) ·
> [unified alias architecture](./phase-9-unified-alias-architecture.md) ·
> [PR #958](https://github.com/RVM-BEYOND-PRIVATE-LIMITED/badabhai-platform/pull/958)

---

## 1. Where production configuration actually comes from

Production is a single AWS Lightsail box running `docker-compose.staging.yml` from
`~/deployments/badabhai-platform`. **The filename is historical; it is the production
compose file.**

A value reaches the `ai-service` container only by crossing **three independent hops**. All
three are required, and a missing hop fails silently:

```
  GitHub secret
      │  hop 1  ci.yml deploy-lightsail  →  env:   NAME: ${{ secrets.NAME }}
      ↓
  Actions runner process env
      │  hop 2  appleboy/ssh-action      →  envs:  NAME   (comma-separated list)
      ↓
  the BOX's shell session
      │  hop 3  docker-compose.staging.yml → environment:  NAME: ${NAME:-default}
      ↓
  the container
```

The compose file states hop 3's necessity in its own words: *"Compose forwards ONLY the
names a service's `environment:` block declares — it does not pass the host shell through."*
And the workflow states hop 2's: *"GitHub environment/repo secrets do NOT reach it on their
own (the first health-gated run proved it: `INTERNAL_SERVICE_TOKEN` was SET as an
environment secret yet compose failed 'missing a value')."*

**Neither `DOMAIN_MATCH_ENABLED` nor `SKILL_CANONICALIZE_ENABLED` appears at any of the
three hops.** Both therefore resolve to their Pydantic code defaults — `false` — and *a
GitHub secret cannot currently change that.*

### GitHub Environments as they stand

| Environment | Created | Protection | Reviewers | Variables |
|---|---|---|---|---|
| `production` | **2026-08-17** | `required_reviewers` | `kpdagrt22`, `divyuuu` | none |
| `staging` | 2026-06-24 | none | — | none |

**I could not enumerate secret names** — `GET .../environments/{env}/actions/secrets`
returns 404 for this token. Where each secret lives is therefore **unconfirmed and must be
checked by you**; §3 and §9 depend on it.

---

## 2. Why `deploy-lightsail` declares `environment: staging`

It is a **placeholder awaiting exactly the ruling you have now made.** The workflow says so
at [ci.yml:911](../../../.github/workflows/ci.yml):

> *"CD-1 / Gate D1: scopes environment secrets + makes the deploy target explicit in the
> Actions UI. Named `staging` per the current D1 default — **if the owner rules this box is
> PRODUCTION, rename AND add a required reviewer to the environment** (protection rules;
> repo is now PUBLIC so they are available on Free)."*

You have already completed the **second half**: the `production` environment was created on
2026-08-17 with `required_reviewers` = `kpdagrt22`, `divyuuu`. The **rename has not been
done**, so the job still scopes to `staging`.

---

## 3. Are production secrets currently inaccessible to that job?

**Conditionally yes — and this is the question to answer before anything else.**

`${{ secrets.NAME }}` inside a job with `environment: staging` resolves in this order:

1. the **`staging` environment** secret, then
2. the **repository** secret as fallback.

The **`production` environment scope is never consulted.** So:

| Where the secret lives | Visible to `deploy-lightsail` today? |
|---|---|
| Repository scope | ✅ yes (fallback) |
| `staging` environment | ✅ yes |
| **`production` environment only** | ❌ **no — silently absent** |

Because the 23 bridged names include `DATABASE_URL`, `JWT_SECRET` and
`PII_ENCRYPTION_KEY`, and because the box's `${VAR:?}` gate fails loudly on a missing
*required* value, the deploy would have crashed if the critical ones were production-only.
That it deploys is evidence the critical secrets resolve at repo or `staging` scope — but it
is **inference, not verification**, and it says nothing about any name you add later.

> **Action for you:** if you add `SKILL_CANONICALIZE_ENABLED` to the `production`
> environment while the job scopes to `staging`, it will be silently invisible. Add it at
> repository scope, or rename the environment first (§9).

---

## 4. Exact compose bridge entries

In `docker-compose.staging.yml`, inside the **`ai-service`** service's `environment:` block
— alongside `AI_ENABLE_REAL_CALLS`, which is the working precedent for a boolean flag:

```yaml
      # Phase 9 / Path A. Both DEFAULT FALSE and both use `:-`, never `:?` — an absent or
      # empty value must mean "off", not "fail the deploy". The flags are additive
      # capability gates, not credentials, so a missing one is a safe state.
      #
      # DOMAIN_MATCH_ENABLED gates ONLY the embedding-based ANN fallback in
      # domain_match.py. The lexical interview pin short-circuits BEFORE this check, so
      # Path A does not need it (see §6).
      DOMAIN_MATCH_ENABLED: ${DOMAIN_MATCH_ENABLED:-false}
      # SKILL_CANONICALIZE_ENABLED gates /skills/canonicalize outright — the route returns
      # `unresolved` before reaching either retrieval path. Stays false until Path A is
      # proven (see §7).
      SKILL_CANONICALIZE_ENABLED: ${SKILL_CANONICALIZE_ENABLED:-false}
```

**`:-` and not `:?` is load-bearing.** `${VAR:-false}` substitutes `false` when the variable
is unset **or empty**, so every failure mode of the bridge — secret absent, secret empty,
`envs:` entry forgotten — lands on `false`. With `:?` the deploy would instead crash, which
is the correct behaviour for a credential and the wrong behaviour for a feature flag.

These entries are **outside** `scripts/check-secret-parity.mjs`'s scope: that gate tracks
only `${VAR:?}` required vars, so adding two `:-` defaults creates no parity obligation.

---

## 5. Exact CI bridge entries

Two edits in `.github/workflows/ci.yml`, both in the `deploy-lightsail` job's
`Deploy via SSH` step.

**(a) the `env:` block** — append after `ANTHROPIC_API_KEY`:

```yaml
          DOMAIN_MATCH_ENABLED: ${{ secrets.DOMAIN_MATCH_ENABLED }}
          SKILL_CANONICALIZE_ENABLED: ${{ secrets.SKILL_CANONICALIZE_ENABLED }}
```

**(b) the `envs:` list** — append the two names to the existing comma-separated string
(line 975). Without this the values reach the runner and stop there; this is precisely the
`INTERNAL_SERVICE_TOKEN` failure the workflow comment records.

```
...,AI_ENABLE_REAL_CALLS,GEMINI_FLASH_API_KEY,ANTHROPIC_API_KEY,DOMAIN_MATCH_ENABLED,SKILL_CANONICALIZE_ENABLED
```

An unset secret renders as the empty string, is exported empty, and is resolved to `false`
by hop 3 — so landing hops 1–3 *before* creating any secret is safe and is the recommended
order: build the bridge first, verify the container still reports both flags off, then
create the secret when it is actually wanted.

Pydantic parses `"true"`/`"false"`/`"1"`/`"0"`/`"yes"`/`"no"`/`"on"`/`"off"`
case-insensitively, so the secret value should be the literal `true` or `false`.

---

## 6. Does the Path-A rollout require `DOMAIN_MATCH_ENABLED`?

**No. Your expectation is correct, and it is verified in code and in production data.**

`domain_match.match_domain()` checks the interview pin **before** the flag:

```python
if pinned_job_domain_id:
    return DomainMatch(status=MATCHED_AUTO, job_domain_id=pinned_job_domain_id, ...)

if not settings.domain_match_enabled:
    return DomainMatch(status=UNMATCHED_DEGRADED)
```

The pin comes from the API's lexical matcher, `identify.service.ts`, which writes
`match_status = "matched_lexical"`. Both production `worker_profiles` rows carry exactly
that, with a score — so **production is already producing deterministic `jd_*` scopes today,
with the flag off and with no embedding spend.**

`DOMAIN_MATCH_ENABLED` gates only the **ANN fallback for workers the lexical matcher does
not pin**. It is a *coverage* improvement, not a prerequisite.

**The consequence to measure, not assume:** Path A's coverage is bounded by the lexical pin
rate. An unpinned worker has no `job_domain_id`, so Path A cannot scope and the request
falls back. **Measuring the pin rate belongs in Stage A (observe)** — it is the number that
decides whether the ANN fallback is ever needed. Right now the sample is 2 profiles, which
is not a rate.

---

## 7. Can `SKILL_CANONICALIZE_ENABLED` stay false through the shadow stages?

**Through Stages A and B, yes. For Stage C it depends on which shadow you run, and the
originally-sketched live shadow does *not* work with the flag off.**

`/skills/canonicalize` short-circuits at [skills.py:74](../../../apps/ai-service/app/routers/skills.py):

```python
if not settings.skill_canonicalize_enabled:
    return SkillCanonicalization(status="unresolved")
```

That returns **before either retrieval path runs**. So with the flag false there is no
in-request traffic to shadow — a live dual-read would compare nothing against nothing.

Two options, and I recommend the first:

| | **C1 — offline replay** *(recommended)* | C2 — live in-request shadow |
|---|---|---|
| Flag | **stays `false`** | must be `true` |
| What it does | capture the `(phrase, job_domain_id)` pairs production *would* canonicalize; run both paths offline against them | run both paths per request, return Path B, log both |
| Production behaviour change | **none** | canonicalization becomes live on Path B |
| Traffic realism | real inputs, replayed | real inputs, in situ |
| Cost | offline embeds only | one extra query + live embeds per request |

**C1 keeps the flag false through the entire parity programme**, which is strictly safer:
Path B's live universe is 22 aliases across 10 skills, so switching it on merely to observe
would put a tenth of a catalogue in front of workers for the duration of the experiment.

So: **the flag can remain `false` until Stage E**, and turning it on is the activation
itself rather than a step toward it. If C1's coverage proves insufficient, C2 becomes a
separate, explicitly authorized decision.

---

## 8. Rollback

**Single change, and the safest form of it is deletion.**

Because hop 3 is `${SKILL_CANONICALIZE_ENABLED:-false}`, *removing* the secret is a complete
rollback — the value resolves empty, `:-` substitutes `false`, and the container starts with
canonicalization off. Setting it to `false` is equivalent and more explicit.

| Mechanism | Change | Time to effect | Notes |
|---|---|---|---|
| **Primary** | set the secret to `false` (or delete it) → re-run `deploy-lightsail` | one workflow run | **After the rename, this needs reviewer approval** (§9) — factor that into the incident path |
| **Fastest** | on the box: `export SKILL_CANONICALIZE_ENABLED=false` then `docker compose up -d ai-service` | seconds | ⚠️ **the other 23 vars are not persisted on the box** — they live only in the deploy session. A bare `docker compose up -d` will fail the `${VAR:?}` gate on required credentials. This path works only if the full env is re-exported, so it is an incident tool, not a routine one |
| **Structural** | revert the compose/CI bridge commit | one deploy | Returns to today's state, where the flag has no path in at all |

No database rollback is involved: neither flag writes anything. Toggling
`SKILL_CANONICALIZE_ENABLED` changes only whether the route answers.

---

## 9. Risk assessment: renaming `staging` → `production`

**Does it expose unrelated secrets? No.** Changing a job's `environment:` does not widen
what the job can read. A job only ever receives the names it explicitly references in
`env:` / `with:`. The rename changes **which scope is consulted first**, not how many
secrets are reachable.

**Does it alter existing deployment behaviour? Yes, in two ways — one intended, one latent.**

| # | Effect | Severity | Detail |
|---|---|---|---|
| **1** | **Every deploy will block pending manual approval** | **High, and intended** | `production` carries `required_reviewers` (`kpdagrt22`, `divyuuu`). Merges to `main` will no longer auto-deploy; each run waits for a reviewer. This is correct for production and will surprise anyone expecting continuous deploy — including during an incident, where the rollback in §8 also needs approval |
| **2** | **Silent value swap on any name present in BOTH scopes** | **High, and latent** | Resolution becomes production-env-first, repo-fallback. Any of the 23 bridged names that exists in the `production` environment with a *different* value than repo scope changes value at the next deploy — including `DATABASE_URL`. Nothing warns; the deploy just uses the other value |
| 3 | A name present only at repo scope | None | Fallback still resolves it |
| 4 | A name present only in `staging` | **Breaks** | It would stop resolving entirely. Required vars fail loudly at the `${VAR:?}` gate; optional ones silently become defaults |
| 5 | Deployment-history attribution | Cosmetic | Past deploys stay recorded against `staging` |

**Prerequisite before renaming — a name-and-value diff across all three scopes** (repo,
`staging`, `production`) for the 23 bridged names plus `LIGHTSAIL_HOST`,
`LIGHTSAIL_USERNAME`, `LIGHTSAIL_SSH_KEY`, `CORS_ALLOWED_ORIGINS`. **I cannot do this** — the
secrets API returns 404 for my token, and I would not read values in any case. It is a
manual check, and risk 2 is entirely invisible without it.

**Recommended order**, which decouples the two changes so neither masks the other:

1. Diff the three scopes (manual).
2. Land the compose + CI bridge with **no secret set** — both flags stay `false`, zero
   behaviour change, and it proves the bridge in isolation.
3. Verify the container reports both flags off.
4. *Separately*, rename `staging` → `production` and accept the approval gate.

---

## 10. Standing constraints, unchanged

`SKILL_CANONICALIZE_ENABLED=false` · `DOMAIN_MATCH_ENABLED=false` · neither activated ·
no secret assumed effective until the bridge exists.

`legacyAliasRows`, the legacy scope arm, and `LEGACY_ANCHOR_SKILL_DOMAIN` **all stay.** They
are the only implemented fallback if canonicalization is activated, and they are removed
only once Path A has been proven to serve correctly.

**verify CLEAN ≠ canonicalization READY.** Production `skill_alias` is clean because it is
entirely unprocessed; no production mutation is indicated at this checkpoint.

Blocked as before: TD-04, TD-06, TD-07, TD-01 terms, TD-05 split, `finishing`, the six
generic aliases, election, predicate, embedding, promotion, canonicalization, the
4,071-domain surface.

---

## 11. What I need from you

1. **Confirm where each secret lives** (repo / `staging` / `production`) — §3 and risk 2 in
   §9 both hinge on it, and I cannot read it.
2. **Decide whether to rename `environment: staging` → `production`**, accepting that every
   deploy — including a rollback — then requires reviewer approval.
3. **Authorize (or not) landing the compose + CI bridge with no secret set.** That is the
   smallest safe step: both flags provably still `false`, no behaviour change, and it makes
   the flags controllable when they are eventually wanted.

Nothing else is requested, and nothing above has been executed.
