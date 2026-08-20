#!/usr/bin/env bash
#
# R38 — what is ACTUALLY published on this box, and on which interface.
#
# ============================================================================
# WHY THIS SCRIPT EXISTS
# ============================================================================
# R38's repo half is done: `docker-compose.yml` and `docker-compose.staging.yml` bind every
# port to loopback except two that say why, and `published-port-binding-compose.guard.test.ts`
# fails CI if that stops being true.
#
# None of that changes a CONTAINER THAT IS ALREADY RUNNING. Docker fixes a port binding at
# `create` time, so the `adminer` and compose-internal `postgres` containers started weeks ago
# keep their original `0.0.0.0` binds forever — and the deploy will never recreate them,
# because it runs `up -d --no-deps api` and those two are not in the `api` profile. The compose
# fix is a guard against the next bare `up`, not a remedy for the live exposure.
#
# So the residual is a HOST question, and it was left open because nobody had run the two
# commands that answer it. This is those commands, and nothing else.
#
# ============================================================================
# IT ONLY READS
# ============================================================================
# `docker ps`, `ss`, and a `curl` against loopback. It stops nothing, removes nothing, and
# changes no configuration. The remediation is PRINTED for a human to run, deliberately — a
# script that stops containers on a production box is not something to trigger by curiosity.
#
#   ssh <box> 'bash -s' < scripts/deploy/r38-port-audit.sh
#
# Exit code: 0 when nothing unexpected is published, 1 when something is. That makes it usable
# from a cron or a smoke step later without reading the text.

set -uo pipefail

# Host ports allowed to bind every interface, and why. Keep in step with INTENTIONALLY_PUBLIC
# in apps/api/src/config/published-port-binding-compose.guard.test.ts — the guard covers the
# FILES, this covers the RUNNING CONTAINERS, and they are allowed to disagree only while a
# residual like R38 is open.
declare -A ALLOWED=(
  [3001]="the api itself — the service the box exists to serve"
  [3333]="payer-web — real browser traffic, loopback would defeat it"
)

echo "== R38 port audit =="
echo "host: $(hostname)   date: $(date -u +%FT%TZ)"
echo

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found on PATH — run this ON the box, not locally." >&2
  exit 2
fi

# FAIL LOUDLY WHEN DOCKER CANNOT ANSWER, and this is the most important line in the file.
# The first version piped a failing `docker ps` through `|| true`, then found no offenders in
# the empty output — so an unreachable daemon printed "nothing is published on 0.0.0.0" and
# exited 0. A security audit that reports CLEAN when it could not look is worse than no audit,
# because someone acts on it. Measured, not imagined: that is what it did on a machine with
# Docker Desktop stopped.
if ! ps_out=$(docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' 2>&1); then
  echo "CANNOT AUDIT: \`docker ps\` failed — the daemon is unreachable, or this user cannot" >&2
  echo "reach the socket. This is NOT a clean result." >&2
  echo "$ps_out" >&2
  exit 2
fi

echo "-- containers and their published ports ------------------------------------"
if [ -z "$ps_out" ]; then
  echo "  (no containers running — on the production box that is itself a finding)"
else
  echo "$ps_out"
fi
echo

# `docker ps` renders a 0.0.0.0 publish as `0.0.0.0:8080->8080/tcp` and an all-interfaces IPv6
# one as `:::8080->8080/tcp`. Both are public; matching only the first would report an IPv6-only
# exposure as clean.
offenders=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  name=${line%%$'\t'*}
  ports=${line##*$'\t'}
  IFS=',' read -ra entries <<<"$ports"
  for e in "${entries[@]}"; do
    e=$(echo "$e" | xargs)
    case "$e" in
      0.0.0.0:*|:::*)
        hostport=$(echo "$e" | sed -E 's/^(0\.0\.0\.0|::):([0-9]+)->.*/\2/')
        if [ -z "${ALLOWED[$hostport]:-}" ]; then
          offenders+=("$name  $e")
        fi
        ;;
    esac
  done
done <<<"$(echo "$ps_out" | cut -f1,3)"

echo "-- listening sockets (host view) -------------------------------------------"
if command -v ss >/dev/null 2>&1; then
  ss -lntp 2>/dev/null | grep -E '(:3001|:3333|:8080|:5432|:5433|:6379|:8000|:3003)\b' || echo "  (none of the tracked ports are listening)"
else
  echo "  ss not available; skipping"
fi
echo

if [ ${#offenders[@]} -eq 0 ]; then
  echo "RESULT: nothing is published on 0.0.0.0 outside the allowlist."
  echo
  echo "The remaining R38 question is then the Lightsail SECURITY GROUP, which is not"
  echo "visible from inside the box. Check it in the console: only 80/443 (and 3333 if"
  echo "payer-web is meant to be reachable) should accept inbound from 0.0.0.0/0."
  exit 0
fi

echo "RESULT: ${#offenders[@]} unexpected public bind(s) — THIS IS R38's RESIDUAL."
for o in "${offenders[@]}"; do echo "   $o"; done
echo
echo "-- remediation, for a human to run -----------------------------------------"
echo "Docker fixes a bind at create time, so these cannot be re-bound in place. They have to"
echo "be removed. Both are safe to remove and neither is part of the api profile, so the next"
echo "deploy (\`up -d --no-deps api\`) will not bring them back:"
echo
echo "  # adminer is dev tooling with NO production purpose."
echo "  docker stop adminer && docker rm adminer"
echo
echo "  # the compose-internal postgres is a LEFTOVER: production data lives in Supabase"
echo "  # (docker-compose.staging.yml: 'the real Postgres, never the compose-internal one')."
echo "  # Confirm it holds nothing first — this prints its databases and their sizes:"
echo "  docker exec <pg-container> psql -U postgres -c '\\l+' "
echo "  # then, once confirmed empty/unused:"
echo "  docker stop <pg-container> && docker rm <pg-container>"
echo
echo "Re-run this script afterwards; it should exit 0."
exit 1
