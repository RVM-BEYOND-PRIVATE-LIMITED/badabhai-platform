# Staging Session Durability — why workers get logged out, and what actually wipes them

> Written for #994: "worker sessions die within ~1 day — the app asks for the PIN, says
> **PIN sahi nahi**, and forgot-PIN reset does not recover it either."

This document answers three questions an operator actually asks during that incident:
**where does a worker's session live**, **what destroys it**, and **does a routine deploy
destroy it** (spoiler: no — and the deploy now proves it).

---

## 1. Where a worker session lives

Entirely in the box-local Redis. There is **no Postgres mirror**.

| Key                          | What it is                                                            |
| ---------------------------- | --------------------------------------------------------------------- |
| `session:<sid>`              | the session record (worker, family, bound device, tier, absolute cap) |
| `refresh:<sha256(token)>`    | one opaque rotating refresh token. The token VALUE is never stored    |
| `refresh_family:<familyId>`  | the rotation lineage, for reuse detection + revocation                |
| `worker_sessions:<workerId>` | the worker's live sids, so logout-all can find them                   |
| `worker_families:<workerId>` | the worker's live refresh families, same reason                       |

Written by [`apps/api/src/auth/session.service.ts`](../../apps/api/src/auth/session.service.ts).

**The blast radius of losing that keyspace is total and instant.** Every worker's
`POST /auth/token/refresh` 401s, so every app force-reauths. Worse, PIN unlock is _only_ a
refresh-token lookup — `POST /auth/pin/verify` resolves identity from the refresh token and
answers a deliberately **neutral** 401 on every failure (no oracle, by design). The app can
only render that as "PIN sahi nahi". So a store wipe presents to the worker as **their
correct PIN being rejected**, with nothing in any log saying otherwise.

TTLs are not the explanation and never were. Staging overrides none of the session knobs, so
the schema defaults apply: `AUTH_REFRESH_TTL_DAYS` **90**, `SESSION_TTL_DAYS` **30**,
`AUTH_SESSION_ABSOLUTE_MAX_DAYS` **90**, `AUTH_ROLLING_TIERS_ENABLED` **false**
([`packages/config/src/server.ts`](../../packages/config/src/server.ts)), and rotation re-arms
the refresh TTL every time. A token that dies in a day was **deleted**, not expired.

---

## 2. What actually destroys it

In rough order of how easy it is to do by accident:

1. **`docker compose down -v` on the box.** Deletes `badabhai-platform_badabhai_redisdata`.
   This is the one to worry about: it is documented as a routine local command, and the
   tempting way to clean up a stray container. **On the box, remove a container with
   `docker rm -f <name>` — never `down`, and never `down -v`.**
2. **A rename / re-clone / worktree of the deploy directory.** The volume prefix comes from
   the compose _project name_, which compose derives from the directory basename. A different
   basename mounts a **new empty volume** and the deploy goes green. The deploy now DETECTS
   this before it can happen: if a `badabhai-redis` container is running but the deploy's own
   compose invocation cannot see it, the project has drifted and the job hard-fails before
   `up`. It deliberately does not _pin_ a name — pinning one we cannot confirm matches the
   live project would itself perform the wipe on its first run.
3. **`docker volume rm`, or `docker system prune --volumes`.** The deploy never does this
   (it prunes images and build cache only, `--filter until=72h`, never volumes) but a hand-run
   cleanup can.
4. **Re-provisioning the box.** A new Lightsail instance is a new empty volume by definition.
   Every worker must OTP again. Plan for it; it is not recoverable after the fact.
5. **Redis restarting without AOF.** Then only the last RDB snapshot survives, and every
   session minted since it is gone. `--appendonly yes` + `--appendfsync everysec` are pinned
   in `docker-compose.yml` and asserted on the live box by the deploy (below).
6. **Eviction under memory pressure.** With an LRU/random `maxmemory-policy`, redis discards
   _live_ refresh tokens as if they were cache. Pinned to `noeviction` (which BullMQ requires
   anyway) and likewise asserted on the box.

---

## 3. Does a routine deploy destroy it? No — and now it proves it

Read the deploy script yourself in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
(the `deploy-lightsail` job is the only thing that SSHes to the box). It contains **no**
`docker compose down`, no `down -v`, no `docker volume rm`, no `docker system prune`, and no
`FLUSHALL`/`FLUSHDB` — none of those strings exist in first-party code anywhere. It does
`git pull`, an image/builder prune that explicitly excludes volumes, `pull`, and three
`up -d --no-deps` calls. `up -d` **recreates containers**; it never touches a named volume.

Likewise for Postgres, which answers #994's third ask directly: **a routine deploy does not
re-create the database.** Staging's `DATABASE_URL` points at the real (Supabase) Postgres,
and every `up` passes `--no-deps`, so the compose-internal throwaway `postgres` service is
never started at all. (If you find `badabhai-postgres` or `badabhai-adminer` running on the
box, they are leftovers from a hand-run `docker compose up`, not something the deploy did —
remove them with `docker rm -f`, per §2.1.)

### CD-7, the survival gate

Immediately after `up -d --no-deps redis` and **before** the api is recreated, the deploy now:

- **hard-fails** if the live redis reports `appendonly != yes` or
  `maxmemory-policy != noeviction`. Failing there leaves the _previous_ api serving — the
  same fail-before-you-touch-containers shape as the CD-6 disk guard;
- reads a TTL-less `deploy:canary` key written by the previous deploy, and emits a
  `::warning::` when it is **missing** — that is the wipe alarm. It is a warning, not a
  failure: by the time it reads empty the sessions are already gone, and failing the job
  would add an outage to a logout;
- logs `DBSIZE` and the live `worker_families:*` count, so "did this deploy cost anyone their
  session" is answerable from the job log.

The first deploy after this landed reports the canary MISSING exactly once. That is the
baseline being written, not an incident.

**Why any of this is needed:** the only Redis assertion that existed before — in the compose
healthcheck _and_ in the api's `/health` — is `PING`. `PING` PONGs perfectly happily at a
brand-new empty keyspace. A total session wipe deployed green and looked healthy.

---

## 4. Recovering a worker who is stuck

A worker whose session record is gone cannot be fixed server-side — the credential is gone,
not corrupted. They must re-establish one:

- **Forgot PIN → OTP → new PIN.** Since #994, `POST /auth/pin/reset/confirm` returns a **fresh
  session** (200, the same login-shape body `/auth/otp/verify` returns) instead of 204, so the
  reset itself re-credentials the app rather than leaving it on the dead token it already had.
  This is what makes the reset self-healing regardless of store state. _Note the app must
  consume that body for the worker to feel it — see #998._
- **Otherwise: a plain OTP login.** Always works; it mints from scratch.

Do not "fix" it by clearing anything else in Redis.

---

## 5. Related

- [ADR-0026](../decisions/0026-production-worker-auth-pin-and-tiered-sessions.md) — sessions,
  refresh rotation, the device-bound PIN, and why `/auth/pin/verify` is neutral.
- [Staging Service Deploy Runbook](./staging-service-deploy-runbook.md) — what the deploy job does.
- [Rollback guide](../rollback-guide.md) — rolling the api back does **not** roll Redis back;
  the session store has no versions.
