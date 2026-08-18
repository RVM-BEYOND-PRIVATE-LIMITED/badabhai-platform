# syntax=docker/dockerfile:1
# ===========================================================================
# Production image for apps/payer-web (the external payer/agency portal, Next.js) —
# the repo's THIRD Dockerfile (GAP-XC-06, #920), for a new container on the SAME
# Lightsail box that already runs apps/api and apps/ai-service. Build from the
# REPO ROOT, exactly like apps/api/Dockerfile:
#
#   docker build -f apps/payer-web/Dockerfile -t badabhai-payer-web .
#
# WHY THE REPO ROOT, LIKE apps/api AND UNLIKE apps/ai-service: payer-web depends on
# THREE workspace packages (@badabhai/config, @badabhai/pricing, @badabhai/validators
# — the last pulls in @badabhai/types too), so the build needs the whole monorepo in
# context to resolve and build them, same reasoning as apps/api/Dockerfile's header.
# .dockerignore keeps node_modules/dist/.next/.git out of the context either way.
#
# v1 SCOPE (deliberate, per #920): get this BUILDING and REACHABLE via the box's IP
# + a published port. No TLS, no domain, no CORS hardening beyond wiring the
# mechanism — deferred until the badabhai.ai domain is provisioned. See
# docker-compose.staging.yml's `payer-web` service block and
# docs/payer-agent/GAP_REGISTER.md's GAP-XC-06 row for exactly what a human needs to
# configure before this image can actually be deployed.
#
# STATIC EXPORT WAS EXPLICITLY REJECTED (owner decision): `src/app/i/[code]/page.tsx`
# is `export const dynamic = "force-dynamic"` and calls `pingInviteClick(code)`
# server-side on every request — it needs a real Node runtime, never static files.
# `output: "standalone"` (next.config.mjs) is the alternative: a lean, self-contained
# runtime that traces only the files this app actually needs and ships a minimal
# `server.js`, while still running a real per-request Node server.
#
# ---------------------------------------------------------------------------------
# THE ONE THING TO UNDERSTAND BEFORE TOUCHING THIS FILE: `NEXT_PUBLIC_*` VALUES ARE
# BAKED IN AT `next build` TIME, NOT READ AT CONTAINER START. This is a materially
# DIFFERENT trust/config boundary than every other variable in this repo's
# docker-compose.staging.yml `${VAR:?}` convention (which all resolve at container
# START, from the box's own environment) — setting `NEXT_PUBLIC_SITE_URL` in
# docker-compose.staging.yml's `environment:` block would have ZERO effect on an
# already-built image; only a BUILD-TIME value (the `ARG`s below, threaded from
# `.github/workflows/ci.yml`'s `build-and-push-image` job) can change it, and doing
# so requires a NEW image build, never just a redeploy of the existing one.
#
# ONLY TWO `NEXT_PUBLIC_*` values are wired here (`NEXT_PUBLIC_API_URL`,
# `NEXT_PUBLIC_SITE_URL`) — verified, not assumed, by reading every call site in
# `apps/payer-web/src` before this file was written:
#   - `NEXT_PUBLIC_SITE_URL` is read directly by 2-3 CLIENT components
#     (`src/app/(portal)/agency/qr/qr-invite.tsx` and the invite-panel components,
#     via `src/lib/invite-share.ts`'s `shareableInviteOrigin`), and ALREADY has a
#     graceful fallback to `window.location.origin` when unset/blank/unparsable — so
#     leaving the build-arg empty is SAFE, not a silent break, for v1's IP:port box.
#   - `NEXT_PUBLIC_API_URL` has no live browser-fetch call site today (every
#     server-to-api call goes through a Server Action reading `PAYER_API_URL`,
#     server-only, wired as a compose-time literal below — never this value); it is
#     wired here anyway because it IS part of the public config schema
#     (`@badabhai/config/public`) and a future client call site should not silently
#     inherit a wrong value nobody thought to set.
# Both `ARG`s default to UNSET (not empty-string — see the "declared-empty is not
# unset" trap this repo has hit before with server env vars): when no build-arg is
# supplied, the build behaves EXACTLY as it does outside Docker today (the
# `@badabhai/config` schema's own defaults apply), never a hard build failure.
# Set them by exporting `PAYER_WEB_NEXT_PUBLIC_API_URL` / `PAYER_WEB_NEXT_PUBLIC_SITE_URL`
# as repository secrets — non-sensitive config values (an IP:port / origin string),
# stored as GitHub *secrets* only for consistency with every other value this repo's
# CI already threads that way, not because they need confidentiality. Repository-
# level (not the `staging` GitHub Environment) because `build-and-push-image` in
# ci.yml does not declare `environment: staging` and changing that job's protection
# posture is out of scope for this change.
# ===========================================================================

# ---- builder: install workspace deps + build payer-web and its workspace packages ----
FROM node:22-bookworm-slim AS builder
ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app
# Copy the whole monorepo (payer-web depends on several @badabhai/* workspace
# packages, and Next's standalone output tracing needs to see them to resolve real
# paths through pnpm's symlinked node_modules). .dockerignore keeps node_modules /
# dist / .next / .git out of the context.
COPY . .
RUN pnpm install --frozen-lockfile

# See the file header: UNSET by default (never an empty string) so a build with no
# build-args behaves identically to a build outside Docker.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SITE_URL
# Build @badabhai/payer-web AND its workspace deps (the `...` selector; pnpm runs
# them in topological order — @badabhai/config, @badabhai/pricing,
# @badabhai/validators, and validators' own @badabhai/types dependency, each via
# their own `tsc` build script, before `next build` runs).
RUN set -e; \
    if [ -n "$NEXT_PUBLIC_API_URL" ]; then export NEXT_PUBLIC_API_URL; fi; \
    if [ -n "$NEXT_PUBLIC_SITE_URL" ]; then export NEXT_PUBLIC_SITE_URL; fi; \
    pnpm --filter @badabhai/payer-web... build

# ---- runtime: minimal Node + the standalone server output ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3002 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# Standalone output does NOT include `public/` or `.next/static` — Next's own docs
# require copying both by hand. `outputFileTracingRoot` (next.config.mjs) is the
# monorepo root, so the traced tree under `.next/standalone` mirrors this repo's own
# layout (`apps/payer-web/server.js`, a pruned root `node_modules`, and each
# workspace package's built `dist/` reachable through it) — copying the whole
# directory as-is preserves that layout inside the runtime image.
COPY --from=builder /app/apps/payer-web/public ./apps/payer-web/public
COPY --from=builder /app/apps/payer-web/.next/standalone ./
COPY --from=builder /app/apps/payer-web/.next/static ./apps/payer-web/.next/static
# payer-web reads PAYER_API_URL (server-only) at RUNTIME, not build time — see
# docker-compose.staging.yml's `payer-web` service block for that wiring; nothing
# box-specific needs to be baked into this image beyond the two NEXT_PUBLIC_* build
# args above.
EXPOSE 3002
USER node
CMD ["node", "apps/payer-web/server.js"]
