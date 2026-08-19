#!/usr/bin/env bash
#
# STAGING/PRODUCTION BOX DEPLOY — the body of the `deploy-lightsail` job's ssh step.
#
# WHY THIS IS A FILE AND NOT AN INLINE `script:` BLOCK (#994). GitHub Actions caps a
# single step input at roughly 21 KB. This script had grown to 20,342 characters —
# about 97% of that ceiling — and crossing it does NOT produce a helpful error: the
# WHOLE ci.yml becomes unparseable, GitHub creates no workflow run at all, and because
# `ci-required` therefore never appears, every PR touching this file is BLOCKED
# forever with no explanation. Two PRs (#1001, #1002) hit it on the same day, and the
# failure looked like a mystery in GitHub rather than a size limit.
#
# Measured, not guessed: padding this script to 24,252 chars reproduced it, while the
# identical padding added OUTSIDE the scalar (same file size) did not.
#
# Living here instead means the 21 KB ceiling cannot be reached by editing deploy
# logic, the comments stay next to the code they explain, and the script is
# shellcheck-able and diffable. `ci-deploy-script-size.guard.test.ts` keeps the inline
# remainder small so this cannot silently regress.
#
# CONTRACT WITH ci.yml:
#   * The box has ALREADY `cd`-ed into the deploy directory and run `git pull`, so this
#     file is the version from the commit being deployed.
#   * Secrets arrive as environment variables via the ssh action's `envs:` list.
#   * The four values that are runner-side GitHub context — and so cannot be read on the
#     box — are bridged as GH_SHA, GH_ACTOR, GH_REPOSITORY and GHCR_TOKEN. They are
#     REQUIRED; the guard below fails loudly rather than deploying a `sha-` tag built
#     from an empty string, which would resolve to a nonexistent image.
set -e

for _required in GH_SHA GH_ACTOR GH_REPOSITORY GHCR_TOKEN; do
  if [ -z "$(eval "echo \"$${_required}\"")" ]; then
    echo "::error::${_required} is empty — ci.yml must bridge it through the ssh action's env:/envs:. Refusing to deploy with an unresolved image tag."
    exit 1
  fi
done

# CD-1: never leave a registry credential (even an expired job token)
# in the box's ~/.docker/config.json — logout on EVERY exit path.
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
echo "Starting deployment..."
cd ~/deployments/badabhai-platform
echo "Pulling latest code from main..."
git pull origin main
echo "Logging into GHCR..."
# CD-1: ephemeral job token (dies with the run) instead of a long-lived
# PAT stored as a repo secret next to a PUBLIC repo. The package is
# PRIVATE (anonymous pull 401-verified), so a login IS required; the
# box only ever pulls during a deploy run, so the ephemeral token
# suffices — and a leaked box can no longer pull outside a run.
echo "$GHCR_TOKEN" | docker login ghcr.io -u $GH_ACTOR --password-stdin

# CD-4: pin the IMMUTABLE per-commit tag pushed by build-and-push-image
# (metadata-action type=sha -> prefix "sha-" + short 7-char sha, length
# pinned via DOCKER_METADATA_SHORT_SHA_LENGTH above). Rollback = export
# the previous sha tag and re-run compose up (docs/rollback-guide.md).
export API_IMAGE="$(echo "ghcr.io/$GH_REPOSITORY/badabhai-api:sha-$(echo "$GH_SHA" | cut -c1-7)" | tr '[:upper:]' '[:lower:]')"
# TD81(a): the ai-service image, same commit, same immutability rule.
# This export is NOT optional even for an api-only concern: compose
# interpolates the WHOLE overlay before it filters by service or
# profile, so docker-compose.staging.yml's `${AI_SERVICE_IMAGE:?}`
# would fail EVERY command below — including `pull api` — if it were
# missing. Same reason a rollback must export both (docs/rollback-guide.md).
export AI_SERVICE_IMAGE="$(echo "ghcr.io/$GH_REPOSITORY/badabhai-ai-service:sha-$(echo "$GH_SHA" | cut -c1-7)" | tr '[:upper:]' '[:lower:]')"
# GAP-XC-06 (#920): the payer-web image, same commit, same immutability
# rule. Also NOT optional even for an api-only concern, for the identical
# reason AI_SERVICE_IMAGE above is not: compose interpolates the WHOLE
# overlay before filtering by service/profile, so docker-compose.staging.yml's
# `${PAYER_WEB_IMAGE:?}` would fail EVERY command below if it were missing.
export PAYER_WEB_IMAGE="$(echo "ghcr.io/$GH_REPOSITORY/badabhai-payer-web:sha-$(echo "$GH_SHA" | cut -c1-7)" | tr '[:upper:]' '[:lower:]')"
# GAP-XC-06 (#920): apps/admin-web (the INTERNAL admin portal), same commit,
# same immutability rule, and NOT optional either — `${ADMIN_WEB_IMAGE:?}` in
# the overlay would fail every command below, `pull api` included.
export ADMIN_WEB_IMAGE="$(echo "ghcr.io/$GH_REPOSITORY/badabhai-admin-web:sha-$(echo "$GH_SHA" | cut -c1-7)" | tr '[:upper:]' '[:lower:]')"
echo "Deploying image: $API_IMAGE"
echo "Deploying image: $AI_SERVICE_IMAGE"
echo "Deploying image: $PAYER_WEB_IMAGE"
echo "Deploying image: $ADMIN_WEB_IMAGE"

# CD-0: base + staging overlay. The overlay pins NODE_ENV=production and
# makes every production-required secret a fail-loud ${VAR:?} — a box
# without real secrets FAILS HERE at compose interpolation (job goes red)
# instead of booting on the public dev defaults. `--no-deps api` on `up`
# is load-bearing: it is what keeps the compose-internal throwaway
# postgres/adminer from ever starting on this box (see the depends_on
# note in docker-compose.staging.yml) — staging's DATABASE_URL is the
# real (Supabase) Postgres, never the compose-internal one. Passing -f
# explicitly ALSO means the tracked docker-compose.override.yml (a
# local-dev-only postgres remap) is NOT auto-loaded here.
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.staging.yml --profile api"

# CD-6: RECLAIM DISK BEFORE PULLING. Every deploy pulls a NEW immutable
# `sha-<short7>` image and nothing ever removed the old one, so the box's
# disk was monotonically increasing. It hit the wall on 2026-07-22: runs
# for #500, #501 and #503 ALL died with
#   failed to copy: ... no space left on device
# during `pull api` — the FIRST command here, so no container was ever
# recreated and the box kept serving the previous api (the failure mode was
# safe, but the deploy was dead and main stayed red for hours).
#
# SAFETY — why this cannot delete something we still need:
#   * `docker image prune` NEVER removes an image that a container
#     references, so the RUNNING api/redis/proxy images are untouchable
#     here regardless of the filter.
#   * `until=72h` keeps three days of recent `sha-` tags, i.e. the rollback
#     targets docs/rollback-guide.md tells an operator to `up` by tag.
#     Anything older is still in ghcr and re-pullable, so rollback is
#     preserved either way — a cold rollback just re-downloads.
#   * volumes are NEVER pruned (that is badabhai_pgdata / badabhai_redisdata).
#     No `docker system prune`, no `--volumes`, not now, not later.
#   * every step is `|| true`: reclaiming is best-effort and must never turn
#     an otherwise-healthy deploy red.
#
# ESCALATION: if the 72h prune does not get free space over the threshold,
# fall back to pruning ALL unused images. That is still container-safe (see
# above) and is strictly better than a dead deploy.
echo "Disk before reclaim:"; df -h / || true
docker image prune -af --filter "until=72h" || true
docker builder prune -af || true
# $(NF-2) not $4: POSIX `df -P` guarantees the LAST three fields are
# Available / Capacity / Mounted-on, but a device name containing a space
# shifts every positional field (verified: it silently returns USED
# instead of AVAILABLE). Counting from the end cannot be fooled that way.
FREE_MB=$(df -Pm / | awk 'NR==2 {print $(NF-2)}')
echo "Free after conservative prune: ${FREE_MB} MB"
if [ "${FREE_MB:-0}" -lt 4096 ]; then
  echo "::warning::under 4 GB free — pruning ALL unused images (still container-safe)"
  docker image prune -af || true
  # $(NF-2) not $4: POSIX `df -P` guarantees the LAST three fields are
# Available / Capacity / Mounted-on, but a device name containing a space
# shifts every positional field (verified: it silently returns USED
# instead of AVAILABLE). Counting from the end cannot be fooled that way.
FREE_MB=$(df -Pm / | awk 'NR==2 {print $(NF-2)}')
  echo "Free after full prune: ${FREE_MB} MB"
fi
if [ "${FREE_MB:-0}" -lt 2048 ]; then
  echo "::error::only ${FREE_MB} MB free after reclaim — the box needs a bigger disk, not a bigger prune"
  docker system df || true
  exit 1
fi
echo "Disk after reclaim:"; df -h / || true

# ---- #872: FAIL LOUD AS SOON AS A CONTAINER HAS ACTUALLY CRASHED, not only once
# the full poll budget is exhausted. A boot-time fail-closed assert (e.g.
# assertMemberInvitesConfig, assertAuthConfig, ...) exits the process in well under
# a second — every remaining poll attempt after that is dead time, and the eventual
# "never became healthy" message reads identically whether the container is merely
# slow or has been crash-looping the whole wait. `restart: unless-stopped` (base
# compose file) means a crashed container cycles back to `restarting`, which is a
# distinguishable, checkable state — so check it and short-circuit instead of
# waiting out the clock. Two consecutive `restarting`/`exited` reads (not one) avoid
# a false positive on the single instant between `created` and `running` on an
# otherwise-healthy first boot.
container_crashed() {
  # $1: compose service name. Empty/missing output (service not up yet) is NOT a
  # crash signal — only an explicit restarting/exited state is.
  cid="$($COMPOSE ps -q "$1" 2>/dev/null || true)"
  [ -z "$cid" ] && return 1
  status="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || true)"
  case "$status" in
    restarting|exited) return 0 ;;
    *) return 1 ;;
  esac
}

# ---- CD-3: THE HEALTH GATE, ONE IMPLEMENTATION FOR EVERY SERVICE ----
#
# This was three near-identical 25-line poll loops differing only in service
# name, URL and budget — the same hand-copying that let the image build steps
# drift, and a fourth app was about to add a fourth copy. Per-service behaviour
# is UNCHANGED: same 2-second interval, same caller-supplied budget, same
# two-consecutive-crash short-circuit (#872), same `logs --tail=100` dump, same
# `::error::` lines.
#
# IT FAILS CLOSED. Every path that is not an observed 2xx from the service's own
# /health returns non-zero — including a caller that forgets an argument — so
# this cannot decay into a health check that is incapable of failing. Each
# caller turns that non-zero into an immediate `exit 1`: an image that EXISTS
# and then will not come up still aborts the deploy on the spot, exactly as
# before. Missing is not the same as unhealthy, and only MISSING is tolerated
# (see the pull helper below).
wait_healthy() {
  # $1 compose service name, $2 health URL, $3 attempt budget (2s apart)
  wh_svc="$1"; wh_url="$2"; wh_attempts="$3"
  if [ -z "$wh_svc" ] || [ -z "$wh_url" ] || [ -z "$wh_attempts" ]; then
    echo "::error::wait_healthy called without a service, url or attempt budget — refusing to report healthy"
    return 1
  fi
  wh_streak=0
  wh_i=1
  while [ "$wh_i" -le "$wh_attempts" ]; do
    if curl -sf "$wh_url" >/dev/null 2>&1; then
      echo "${wh_svc} healthy after attempt ${wh_i}"
      return 0
    fi
    if container_crashed "$wh_svc"; then
      wh_streak=$((wh_streak + 1))
    else
      wh_streak=0
    fi
    if [ "$wh_streak" -ge 2 ]; then
      echo "::error::${wh_svc} container crashed during boot (not just slow) — dumping container logs"
      $COMPOSE logs --tail=100 "$wh_svc"
      return 1
    fi
    sleep 2
    wh_i=$((wh_i + 1))
  done
  echo "::error::${wh_svc} never became healthy — dumping container logs"
  $COMPOSE logs --tail=100 "$wh_svc"
  return 1
}

# ---- DEPLOY WHAT EXISTS, THEN FAIL LOUDLY ----
#
# `build-and-push-image` is a `fail-fast: false` matrix, so this job can now be
# reached with SOME images published for this commit and others not. Two rules,
# and NEITHER of them works without the other:
#
#   1. A MISSING image must not block the services that DO have one. Measured
#      2026-08-18: api and ai-service built AND PUSHED, payer-web's build failed,
#      the whole deploy skipped, and the box received NOTHING — two healthy
#      services held back by one broken one.
#   2. A MISSING image must still FAIL THIS JOB, at the end, after everything
#      that could be deployed has been. Silently skipping it is how payer-web
#      ends up sitting on a weeks-old image while api moves forward and nobody
#      finds out. Availability WITHOUT losing the signal; never one alone.
#
# "EXISTS" IS DECIDED BY ASKING THE REGISTRY, not by trusting the build job's
# status: `$COMPOSE pull <svc>` resolves the immutable `sha-<short7>` tag for
# THIS COMMIT or it does not. That also catches a leg that reported success but
# pushed nothing, and it needs no new state passed between jobs.
#
# Note the exports above are UNCHANGED and still unconditional: compose
# interpolates the WHOLE overlay before filtering by service, so every
# `${..._IMAGE:?}` must resolve for ANY command here — including a pull of an
# unrelated service. A missing image is a REGISTRY fact, never an unset variable.
MISSING_IMAGES=""
DEPLOYED_SERVICES=""

pull_image() {
  # $1 compose service name, $2 the image ref it resolves to (log line only).
  if $COMPOSE pull "$1"; then
    return 0
  fi
  # M3: `$COMPOSE pull` returns non-zero for MORE than "the tag does not
  # exist" — a ghcr outage, a rate limit, an expired token, or a full disk
  # all land here too. Naming only the build legs would send an operator to
  # the wrong place during a registry incident, so the message states what
  # was actually observed (the pull failed) and lists the causes in
  # likelihood order rather than asserting one.
  echo "::warning::could not pull '$1' ($2). Most likely its build leg failed so no image was published for this commit; a ghcr outage, rate limit, expired token or full disk on the box produce the same result. SKIPPING its deploy — it keeps running its previous container. This job will FAIL at the end."
  MISSING_IMAGES="${MISSING_IMAGES}${MISSING_IMAGES:+ }$1"
  return 1
}

image_present() {
  case " ${MISSING_IMAGES} " in
    *" $1 "*) return 1 ;;
    *) return 0 ;;
  esac
}

# PULL PHASE FIRST, EXACTLY AS BEFORE, so the start order below is untouched.
# `|| true` only stops `set -e` from aborting here — pull_image has already
# recorded the failure, and the end-of-script check is what turns it red.
pull_image api "$API_IMAGE" || true
# TD81(a). `--profile api` is what makes this resolve: the ai-service
# declares that profile alongside its own (docker-compose.yml), so it
# is selected here without depending on compose's newer
# "explicitly-named service enables its profile" behaviour — the box's
# compose version is not verified.
pull_image ai-service "$AI_SERVICE_IMAGE" || true
# GAP-XC-06 (#920): same `--profile api` reasoning as ai-service above —
# payer-web declares `profiles: ["api"]` directly on its own service block
# (docker-compose.staging.yml), since it has no base-file counterpart to
# inherit the profile from.
pull_image payer-web "$PAYER_WEB_IMAGE" || true
# admin-web, same `--profile api` reasoning: it declares `profiles: ["api"]`
# on its own service block, having no base-file counterpart to inherit from.
pull_image admin-web "$ADMIN_WEB_IMAGE" || true

# CD-1a: Redis IS box-local (owner decision) — it runs as this compose
# project's `redis` service, so unlike postgres it MUST start here. The
# api reaches it over the compose network at redis:6379, which is what
# the REDIS_URL secret must say (NOT localhost — inside the api container
# localhost is the api itself; and the host port is loopback-bound now).
#
# `--no-deps api` below would never start it (redis is only reachable as
# an api depends_on), so start it EXPLICITLY and FIRST. Naming the service
# starts ONLY it — redis declares no depends_on — so postgres/adminer
# still never start; --no-deps here keeps that true even if redis were
# later given one. Deliberately NOT `--wait`: docker-compose.staging.yml
# records that the box's compose version is unverified, and a flag it
# lacks would fail the deploy outright. Redis serves within ms and the
# api's own boot is far slower, so ordering is safe — and the CD-3 health
# gate below is the real backstop if it is not.
#
# UNCONDITIONAL: redis is a stock upstream image with no per-commit tag, so
# it has no build leg that could be missing.
#
# CD-7 (#994) PRE-FLIGHT: REFUSE TO DEPLOY INTO A DIFFERENT COMPOSE PROJECT.
#
# The project name is what NAMESPACES the volumes, and compose derives it from the
# directory basename. Rename ~/deployments/badabhai-platform, re-clone it elsewhere, or
# deploy from a worktree, and the very next `up` mounts a BRAND-NEW EMPTY volume: every
# worker's session and refresh token gone, deploy green. That is the invisible-wipe vector
# behind #994.
#
# This deliberately does NOT pin the name (no COMPOSE_PROJECT_NAME, no top-level `name:`
# key). Pinning requires KNOWING the live project label, and if the box's real label were
# anything else, the pin would ITSELF perform the wipe on its first run — the cure causing
# the disease. Compose's own resolution stays authoritative; we only assert it still points
# at the container that is actually running.
#
# `container_name: badabhai-redis` is fixed in docker-compose.yml, so `docker ps` finds the
# live one regardless of project, while `$COMPOSE ps -q redis` finds it only if THIS
# invocation resolves the SAME project. The two disagreeing is exactly the drift, caught
# BEFORE `up` can create anything. Both flags predate compose v2, so this adds no version
# risk (the box's version is unverified — see the `--wait` note above).
if [ -n "$(docker ps -q -f name='^badabhai-redis$' || true)" ] \
   && [ -z "$($COMPOSE ps -q redis 2>/dev/null || true)" ]; then
  echo "::error::a badabhai-redis container is running, but this compose invocation cannot see it — the compose project name has DRIFTED (the deploy directory was renamed, re-cloned, or is a worktree). Deploying now would mount a NEW EMPTY session store and force-log-out every worker. Refusing. See docs/ops/staging-session-durability.md."
  exit 1
fi

$COMPOSE up -d --no-deps redis

# CD-7 (#994): PROVE THE SESSION STORE SURVIVED. This redis is not a cache — `session:*`,
# `refresh:*`, `refresh_family:*`, `worker_sessions:*` and `worker_families:*` live ONLY
# here, with no Postgres mirror, so an emptied or re-namespaced keyspace force-logs-out
# every worker on the platform at once and surfaces to them as "PIN sahi nahi" for a PIN
# that is correct.
#
# Nothing detected that before this block. The ONLY redis assertion anywhere — in the
# compose healthcheck and in the api's /health — is PING, and PING PONGs perfectly happily
# at a brand-new empty keyspace. A wipe deployed GREEN.
#
# Redis needs a moment after a recreate (AOF load answers -LOADING to GET/SET), and `up -d`
# above is deliberately not `--wait`. Bounded wait, so a transient not-ready is never
# misreported below as a durability failure.
REDIS_CLI="$COMPOSE exec -T redis redis-cli"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ "$($REDIS_CLI PING 2>/dev/null | tr -d '\r')" = "PONG" ]; then break; fi
  sleep 2
done

# Two config assertions HARD-FAIL, deliberately, and deliberately HERE: they run after redis
# is up but BEFORE the api is recreated, so a red job leaves the PREVIOUS api serving (the
# same fail-before-you-touch-containers shape as the CD-6 disk guard above). Never deploy new
# code onto a store that will not keep what it is handed.
#
# UNREADABLE and WRONG are reported differently on purpose. A pipeline's exit status is the
# LAST command's, so a failed `compose exec` would otherwise yield an empty string and be
# announced as "appendonly is ''" — an operator reads that as a broken session store when
# docker merely hiccuped. `exec -T` because the ssh session has no TTY; `tr -d '\r'` because
# redis-cli writes CRLF; CONFIG GET prints the name then the value, hence `tail -n1`.
AOF="$($REDIS_CLI CONFIG GET appendonly 2>/dev/null | tr -d '\r' | tail -n1)"
if [ -z "$AOF" ]; then
  echo "::error::could not read redis config (container not answering after 20s) — this is a DOCKER problem, not necessarily a durability one. Refusing to deploy onto an unverifiable session store."
  exit 1
fi
if [ "$AOF" != "yes" ]; then
  echo "::error::redis appendonly is '$AOF', not 'yes' — worker sessions would not survive a restart. Refusing to deploy onto it."
  exit 1
fi
EVICT="$($REDIS_CLI CONFIG GET maxmemory-policy 2>/dev/null | tr -d '\r' | tail -n1)"
if [ "$EVICT" != "noeviction" ]; then
  echo "::error::redis maxmemory-policy is '$EVICT', not 'noeviction' — live refresh tokens could be evicted under memory pressure, and BullMQ refuses to run against an evicting instance. Refusing to deploy onto it."
  exit 1
fi

# The CANARY is the actual survival test, and it is a WARNING, not a failure: by the time it
# reads empty the sessions are already gone, and failing the job would only add an outage to
# a logout. Written with no TTL (a TTL would expire and manufacture a false wipe alarm),
# under a key in no app namespace. The first deploy after this lands legitimately reports
# MISSING once — that is the baseline being written, not an incident. Every command here is
# `|| true`: under `set -e` a bare redis-cli that exits non-zero (e.g. -LOADING during an AOF
# replay) would kill the deploy, which is precisely what this comment says it must never do.
PREV_CANARY="$($REDIS_CLI GET deploy:canary 2>/dev/null | tr -d '\r' || true)"
if [ -z "$PREV_CANARY" ]; then
  echo "::warning::redis deploy canary MISSING — this keyspace did NOT survive since the last deploy (new/empty volume, a rename of the deploy directory, or a flush). EVERY worker session was destroyed; workers will see 'wrong PIN' until they re-login by OTP. See docs/ops/staging-session-durability.md."
else
  echo "redis keyspace survived; canary from the previous deploy: ${PREV_CANARY}"
fi
$REDIS_CLI SET deploy:canary "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null || true
# Observability, not a gate: DBSIZE and the live worker-session lineage count give an
# at-a-glance "did this deploy cost anyone their session" in the job log.
# KEEP THE `| wc -l` — without it this prints every `worker_families:<uuid>` KEY, i.e. a list
# of worker ids, into a CI log. The count is the whole point.
echo "redis DBSIZE: $($REDIS_CLI DBSIZE 2>/dev/null | tr -d '\r' || true)"
echo "worker session lineages: $($REDIS_CLI --scan --pattern 'worker_families:*' 2>/dev/null | wc -l || true)"

# TODO(CD-2, held: 0031 human sign-off + D1): migrations-in-pipeline would
# run HERE — after the image pull, BEFORE the new code boots (CLAUDE.md §2
# ordering: migrations never run after the code that assumes them). Held
# pending owner sign-off on migration 0031 (destructive-adjacent billing-FK
# change, §7 human-gated) + the prod-vs-staging D1 environment answer.
# NOTE (CD-3 scope): the /health gate below checks CONNECTIVITY only
# (SELECT 1 + Redis PING) — a fresh, UNMIGRATED DATABASE_URL still boots
# and 200s while every real endpoint 500s. Until CD-2 lands, applying
# migrations MANUALLY (owner, after 0031 sign-off) is a required pre-step
# to the first real deploy against a fresh DB.

# TD81(a): start the ai-service BEFORE the api, and gate on it.
#
# Ordering: the api tolerates an absent ai-service by design (it
# degrades to its TypeScript mock), so this is not a hard dependency —
# but starting the dependency first means the new api never serves a
# single request into a gap. `--no-deps` keeps the one uniform
# discipline; this service declares no depends_on at all (it is
# DB-free), so nothing else can be dragged up by it.
#
# CD-3 probe: the api's own /health is 200 whether or not the AI service
# exists, so ONLY a direct probe can tell the deploy that the AI path is real
# (TD81's headline complaint: "staging silently runs mocked AI while reporting
# healthy"). localhost works because docker-compose.yml publishes 8000 on
# 127.0.0.1 (loopback-only, CD-1a). /health is the one route exempt from the
# TD67 token middleware, so this probe keeps working after AI_INTERNAL_TOKEN is
# armed. ~30s budget (15 x 2s) — a Python/uvicorn boot is far quicker than the
# Nest api's.
#
# TRADE-OFF, stated deliberately and UNCHANGED: this gate is BEFORE the api
# `up`, so an ai-service image that exists but will not come up still blocks the
# api deploy. That is the intended posture — the box keeps serving the PREVIOUS,
# working api (no partial state) and the job goes RED — and it beats shipping an
# api that silently answers from the mock. What is NEW is only the `if`: an
# ai-service image that was never published for this commit no longer takes the
# api down with it.
if image_present ai-service; then
  $COMPOSE up -d --no-deps ai-service
  echo "Waiting for the AI service to become healthy..."
  wait_healthy ai-service "http://localhost:8000/health" 15 || exit 1
  DEPLOYED_SERVICES="${DEPLOYED_SERVICES}${DEPLOYED_SERVICES:+ }ai-service"
else
  # M1: SKIPPING ai-service MUST NOT ALSO SKIP VERIFYING THE AI PATH.
  # Before this job could deploy a partial set, a failed `pull ai-service`
  # aborted everything under `set -e`, so the api was never deployed without
  # a live ai-service. Now the api CAN proceed — which would silently drop
  # the only check that the AI path is real. TD81(a) is explicit that the
  # api's OWN /health returns 200 whether or not the ai-service exists (it
  # degrades to the TypeScript mock), so a DIRECT probe is the only thing
  # that can tell this deploy the difference. Probe the INCUMBENT container
  # — the one still running from the previous deploy — and hard-stop before
  # the api `up` if it is dead, exactly as the deployed path does. The api
  # keeps serving its previous, working image; nothing is left half-updated.
  echo "ai-service image missing for this commit — verifying the INCUMBENT ai-service is still alive before deploying the api..."
  if ! wait_healthy ai-service "http://localhost:8000/health" 5; then
    echo "::error::ai-service has no image for this commit AND the incumbent container is not healthy. Refusing to deploy the api on top of a dead AI path — it would answer 200 from the mock and look fine. The box keeps its previous api."
    exit 1
  fi
  echo "Incumbent ai-service is healthy; continuing with the api."
fi

# CD-3: health-gate the deploy — the job must go RED when the API does not
# come up (the old unconditional success echo could never fail). Poll on
# the box itself: localhost sidesteps the instance firewall. Same poll
# pattern as the e2e job's /health wait above. ~60s budget (30 x 2s), short-
# circuited early on a confirmed crash (see container_crashed above — #872).
if image_present api; then
  $COMPOSE up -d --no-deps api
  $COMPOSE ps
  echo "Waiting for the API to become healthy..."
  wait_healthy api "http://localhost:3001/health" 30 || exit 1
  DEPLOYED_SERVICES="${DEPLOYED_SERVICES}${DEPLOYED_SERVICES:+ }api"
fi

# ---- GAP-XC-06 (#920): payer-web, started AFTER the api's own health gate
# passes. Not a hard dependency in compose (no depends_on — see the service
# block's own comment for why), but ordering it last here means a broken
# payer-web image never gets a chance to serve a request while the api is
# still coming up, and a payer-web failure below does not block the api
# (already healthy and serving) from having been deployed successfully.
#
# Reached via the box-published (NOT loopback-only — CD-1a does not apply here,
# see the service block's own comment) `PAYER_WEB_PORT`. ~30s budget (15 x 2s) —
# a Next.js standalone server starts about as fast as the ai-service's uvicorn
# boot. `:-3333` must match docker-compose.staging.yml's default EXACTLY: the
# secret is an optional override, so when it is unset this poll has to look at
# the same port compose actually published, not at `http://localhost:/health`.
if image_present payer-web; then
  $COMPOSE up -d --no-deps payer-web
  $COMPOSE ps
  echo "Waiting for payer-web to become healthy..."
  wait_healthy payer-web "http://localhost:${PAYER_WEB_PORT:-3333}/health" 15 || exit 1
  DEPLOYED_SERVICES="${DEPLOYED_SERVICES}${DEPLOYED_SERVICES:+ }payer-web"
fi

# ---- GAP-XC-06 (#920): apps/admin-web, the INTERNAL admin portal, started
# LAST. Same no-depends_on reasoning as payer-web: start order is what keeps a
# broken admin-web from preceding or blocking the two surfaces real users hit,
# both of which are already deployed and health-gated by the time this runs. An
# admin-web failure still turns the job red.
#
# DEPLOYING IT DOES NOT PUBLISH IT. Unlike payer-web, CD-1a DOES apply here: the
# service publishes on `127.0.0.1:3003` only, and no nginx server block routes to
# it, so this loopback poll is the only thing that can reach the container. Do
# not add nginx, DNS or certbot for it — exposing an admin portal is a separate
# owner decision needing an IP allowlist. See the service block in
# docker-compose.staging.yml.
#
# `:-3003` must match that block's default EXACTLY, or an unset override leaves
# this polling a port compose never published. ~30s budget (15 x 2s), same as
# payer-web — an identical Next.js standalone server. /health is unauthenticated
# by design and reads no session, no cookie and no upstream service.
if image_present admin-web; then
  $COMPOSE up -d --no-deps admin-web
  $COMPOSE ps
  echo "Waiting for admin-web to become healthy..."
  wait_healthy admin-web "http://localhost:${ADMIN_WEB_PORT:-3003}/health" 15 || exit 1
  DEPLOYED_SERVICES="${DEPLOYED_SERVICES}${DEPLOYED_SERVICES:+ }admin-web"
fi

# ---- THE LOUD ENDING. This is the half of the design that makes the tolerance
# above safe: everything deployable has now been deployed and health-gated, and
# a service whose image never arrived turns the job RED here rather than
# disappearing into a green tick. Do not "simplify" this into a warning.
echo "Deployed this run: ${DEPLOYED_SERVICES:-(nothing)}"
if [ -n "$MISSING_IMAGES" ]; then
  echo "::error::DEPLOY INCOMPLETE — no image published for this commit (sha-$(echo "$GH_SHA" | cut -c1-7)) for: ${MISSING_IMAGES}. Those services are STILL RUNNING THEIR PREVIOUS IMAGE and are now behind main. Fix the failed build leg and re-run this workflow, or roll the whole box back (docs/rollback-guide.md)."
  exit 1
fi

echo "Deployment finished successfully!"
