# Rollback Guide — AWS Lightsail staging box

Reconstructed from `docker-compose.staging.yml`'s and `.github/workflows/ci.yml`'s
`deploy-lightsail` job's own inline comments (docs/audit/22_REMEDIATION_BACKLOG.md BL-20,
R46) — the file was deleted in the 2026-08-05 docs purge (`eb151468`) but is still cited
4 times by the currently-running `deploy-lightsail` job. This is the box-side rollback
procedure only; it does not cover a bad database migration (see **Migrations** below).

## When to use this

`deploy-lightsail` went green but the newly-deployed code is behaving badly in a way CI
couldn't catch (a runtime-only bug, a bad config interaction, anything short of the
health gate itself catching it — a failed health gate already leaves the box on the
previous working image, no action needed).

## What "rollback" actually means here

Every deploy pins **immutable per-commit images** —
`ghcr.io/<owner>/badabhai-platform/badabhai-api:sha-<short7>`, the `badabhai-ai-service`
equivalent, and (as of GAP-XC-06, #920) the `badabhai-payer-web` equivalent — all three built
from the same commit's first 7 sha characters. A rollback is: **export the previous commit's
sha tag for ALL THREE images and re-run the same `compose up` sequence the deploy job runs.**
Nothing is reverted in git; the box just points at older, already-built images.

## Procedure

1. **SSH to the box** as the deploy user (same host/user the `deploy-lightsail` job's
   `LIGHTSAIL_HOST`/`LIGHTSAIL_USER` secrets point at).

2. **Find the previous good commit's short sha.** Either:
   - `cd ~/deployments/badabhai-platform && git log --oneline -5` — the commit before the
     one that broke things, or
   - `docker images | grep badabhai-api` — the box keeps a rolling 72h window of pulled
     `sha-` tags (disk-reclaim prunes anything older, see the deploy job's CD-6 comment),
     so a recent-enough rollback target is likely already local and needs no re-pull.

3. **Export ALL THREE image variables — never just one or two.** `docker-compose.staging.yml`
   interpolates the *whole* file before filtering by service, so a compose command that
   only sets `API_IMAGE` still fails on the ai-service's `${AI_SERVICE_IMAGE:?}` gate (and,
   as of GAP-XC-06, payer-web's `${PAYER_WEB_IMAGE:?}` gate too), even for an api-only
   rollback:
   ```bash
   cd ~/deployments/badabhai-platform
   SHORT_SHA=<the previous good commit's first 7 chars>
   export API_IMAGE="ghcr.io/<owner>/badabhai-platform/badabhai-api:sha-${SHORT_SHA}"
   export AI_SERVICE_IMAGE="ghcr.io/<owner>/badabhai-platform/badabhai-ai-service:sha-${SHORT_SHA}"
   export PAYER_WEB_IMAGE="ghcr.io/<owner>/badabhai-platform/badabhai-payer-web:sha-${SHORT_SHA}"
   ```
   `PAYER_WEB_PORT` is deliberately NOT in that list: it is `${PAYER_WEB_PORT:-3002}`
   (defaulted, not fail-loud), precisely so a missing box-specific port can never brick an
   api-only rollback the way the image gates above would. Export it only if this box
   overrides the 3002 default.

4. **Log into GHCR** (the package is private; an expired/missing login 401s the pull):
   ```bash
   echo "<a GHCR-scoped token with packages:read>" | docker login ghcr.io -u <github-actor> --password-stdin
   ```

5. **Run the same compose sequence the deploy job runs, in the same order** — the
   ordering is load-bearing (ai-service starts and health-gates *before* the api, so a
   bad rollback target for either service never serves a request with the other half
   missing):
   ```bash
   COMPOSE="docker compose -f docker-compose.yml -f docker-compose.staging.yml --profile api"
   $COMPOSE pull api
   $COMPOSE pull ai-service
   $COMPOSE pull payer-web
   $COMPOSE up -d --no-deps redis        # box-local; must be started explicitly
   $COMPOSE up -d --no-deps ai-service
   curl -sf http://localhost:8000/health  # must return 200 before continuing
   $COMPOSE up -d --no-deps api
   curl -sf http://localhost:3001/health  # must return 200
   $COMPOSE up -d --no-deps payer-web
   curl -sf "http://localhost:${PAYER_WEB_PORT:-3002}/health"  # must return 200
   ```
   `--no-deps` on every `up` is deliberate: it is what keeps the compose-internal
   throwaway Postgres/Adminer from ever starting on this box — staging's `DATABASE_URL`
   is the real (Supabase) Postgres, never the compose-internal one.

6. **Verify.** All three `/health` endpoints 200, and `$COMPOSE ps` shows all three
   containers `Up`/`healthy`. api's and ai-service's `/health` check connectivity
   (`SELECT 1` + Redis `PING`); payer-web's `/health` is a bare liveness probe
   (`apps/payer-web/src/app/health/route.ts` — no upstream call). None of the three
   proves the rolled-back code is *correct*, only that it booted.

7. **Log out of GHCR** when done (`docker logout ghcr.io`) — never leave a registry
   credential on the box, matching the deploy job's own `trap ... EXIT` discipline.

## Migrations — read this before rolling back if a migration shipped with the bad deploy

Migrations are **never auto-applied** by `deploy-lightsail` (CD-2, held pending owner
sign-off + the prod-vs-staging environment answer) — they require a human to run
`pnpm db:migrate` manually, and that has already happened separately from any deploy.
**Rolling back the code does not roll back the database.** If the bad deploy's commit
included a migration:
- An additive migration (new column/table) is almost always safe to leave applied while
  rolling back the code — the old code simply ignores the new column/table.
- A destructive or renaming migration is NOT safely undone by a code rollback alone —
  stop and get a second opinion (Backend Platform / database-architect) before rolling
  back code that expects a schema the database no longer has, or vice versa.

## Disk

`deploy-lightsail` prunes Docker images older than 72h before every pull (`docker image
prune -af --filter "until=72h"`, escalating to a full prune only if free space stays
under 4 GB). This never removes an image a running container references, and never
touches the `badabhai_pgdata`/`badabhai_redisdata` volumes — but it does mean a rollback
target older than ~3 days will need a fresh `docker pull` from GHCR rather than using a
locally-cached image.

## What this guide does not cover

Rolling back a `staging-cd.yml` deploy (a different, `workflow_dispatch`-only pipeline
for a *persistent* staging host — see that workflow's own header comments); provisioning
a new box from scratch; anything about `apps/web`/`apps/admin-web` — see
`docs/operations/COMMANDS.md` (BL-1): neither is deployed anywhere as of this writing.
`apps/payer-web` IS now deployed by this same `deploy-lightsail` job (GAP-XC-06, #920) —
see the rollback steps above, which now cover all three images.
