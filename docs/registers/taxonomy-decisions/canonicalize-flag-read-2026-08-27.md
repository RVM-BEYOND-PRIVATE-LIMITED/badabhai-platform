# Reading the effective `SKILL_CANONICALIZE_ENABLED` — every route tried, and why none of them answers

**2026-08-27 · read-only · no production mutation · AI spend ₹0 · the flag was NOT changed**

The instruction was explicit: read the effective value **from the actual running ai-service**,
using the legitimate deployment access available, and **not** from repository defaults, GitHub
secrets, events, or local `.env` files. This records what was attempted and what was found.

**Answer: the effective value cannot be read from this workstation.** Not "not determinable in
principle" — determinable, by someone with shell access to the box. That access is not here.

---

## The five routes, and where each one ends

### 1 ▸ `docker compose exec ai-service env` — the route that WOULD answer it

Blocked: no credential to reach the host.

```
~/.ssh                     does not exist
~/.aws                     does not exist
aws CLI                    not installed
LIGHTSAIL_HOST             absent from the environment
LIGHTSAIL_SSH_KEY          absent from the environment
docker ps                  badabhai-redis, badabhai-postgres  <- local only; NO ai-service
```

CI reaches the box through `appleboy/ssh-action` with `secrets.LIGHTSAIL_HOST` and
`secrets.LIGHTSAIL_SSH_KEY`. Those live in GitHub Actions and are not present locally, by
design. **This is the one route that gives a direct answer, and it needs a human with the key.**

### 2 ▸ `GET /health` on the running service — deliberately does not carry it

`apps/ai-service/app/routers/health.py` returns `status`, `service`, `build`,
`service_auth_enabled`, and — only when the service bearer is NOT set — provider posture and
spend. **`skill_canonicalize_enabled` is in neither branch.** In production `AI_INTERNAL_TOKEN`
is set, so the trimmed payload applies (TD67: the tokenless surface is liveness plus one
boolean; provider posture is recon data on a shared network).

### 3 ▸ Probing `POST /skills/canonicalize` — cannot distinguish, BY DESIGN

```python
if not settings.skill_canonicalize_enabled:
    task.update(level="WARNING", status_message="skill_canonicalize_disabled")
    return SkillCanonicalization(status="unresolved")
```

A disabled flag and a phrase nothing matched return **the same body**. The module docstring says
so in as many words. So no amount of network access answers this over the wire — and inferring
from behaviour is exactly the mistake Task 17b had to retract.

Separately, probing production is not free of consequence: with the flag ON the call embeds
(paid) and may write an `unresolved_phrase` row. Neither was authorised.

### 4 ▸ Langfuse — the right idea, no working credentials

The `status_message` above **is** a direct observation of which branch the running process took,
which would be a legitimate read rather than an inference. Credentials are present in the
environment; both endpoints refuse them.

```
GET /api/public/observations?name=skill_canonicalization  -> 401
GET /api/public/traces?name=skill_canonicalization        -> 401
{"message":"Invalid credentials. Confirm that you've configured the correct host."}
```

`LANGFUSE_HOST` is unset, so the client defaults to `cloud.langfuse.com`. Either the keys are
stale or the project is on a different host. **Worth fixing on its own merits** — this is the
observability backend the activation plan expects to confirm activation with.

### 5 ▸ GitHub secret metadata — explicitly excluded, and it does not answer anyway

```
secret exists          true
created / updated      2026-07-16T11:51:11Z  /  2026-08-24T11:30:45Z
bridged by CI          true
compose default        false     <- governs ONLY if the value is empty
DEPLOYED VALUE         NOT DETERMINABLE
```

GitHub never exposes a value. The deploy job runs on every push to `main`, so the 2026-08-24
change has long since reached the container — **the container is running whatever that value
became, and nothing in this repository records it.**

---

## What the local `.env` says, and why it is a WARNING rather than an answer

> **`SKILL_CANONICALIZE_ENABLED=true` in the local `.env`.**

This is **not** the deployed value, and it is not offered as evidence of one — the instruction
excluded local env files precisely because they are a different machine's configuration.

It is recorded here because it is a **live hazard that promotion just made sharper**. The same
`.env` points `DATABASE_URL` at the production cluster. Before today the corpus was 49 active
skills; it is now 111. So anyone who starts the ai-service locally from this file gets
canonicalization **on**, against **production data**, with 62 skills that went live this morning —
writing `unresolved_phrase` rows and assigning skills outside any of the gates this programme
built. `AI_SERVICE_URL` is `localhost`, which is what makes that easy to do by accident.

**Recommended, not done here** (it is the operator's file and outside this change's scope): set
it to `false` locally, or point the local `DATABASE_URL` at the local `badabhai-postgres`
container.

---

## The engineering gap this exposes, stated as a recommendation

**There is no non-privileged way to observe this flag, which means activation cannot be
verified by anyone who is not holding the SSH key.** That is a problem *after* the flag is
turned on, not just before it: "did the deploy take effect?" is the first question anybody will
ask, and today the only honest answer is "ask whoever can reach the box".

The fix is small and belongs to `apps/ai-service` (CLAUDE.md §7 — the AI Systems Engineer, not
this change): report the boolean on a **token-gated** surface, alongside the posture booleans
`/ai/spend` already carries. A capability boolean is not recon data once a bearer is required,
and it is not a secret in any branch — it is one bit that says whether the route is live.

Until that exists, the sequence's `READ-FLAG` step is only satisfiable by a human with
deployment access, and the programme graph is right to hold `CANONICALIZE-FLAG-VALUE` as
`BLOCKED_ON_INFRA` rather than as anything an engineer can clear.

---

## The one action required

**A person with Lightsail access runs, on the box:**

```bash
docker compose exec ai-service env | grep SKILL_CANONICALIZE_ENABLED
```

and reports the value. That is the whole of step `READ-FLAG`, and it is the last input the
activation decision is missing.
