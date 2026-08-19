# syntax=docker/dockerfile:1
# ===========================================================================
# Production image for apps/admin-web (the INTERNAL admin portal, Next.js) — the
# repo's FOURTH Dockerfile, deliberately a near-copy of apps/payer-web/Dockerfile
# rather than a fresh design. Build from the REPO ROOT:
#
#   docker build -f apps/admin-web/Dockerfile -t badabhai-admin-web .
#
# WHY THE REPO ROOT, LIKE apps/api AND apps/payer-web (VERIFIED, NOT ASSUMED — every
# `@badabhai/*` import under apps/admin-web/src was enumerated before this file was
# written): admin-web imports @badabhai/validators (login + admin-invite schemas),
# @badabhai/pricing (paise/credit formatting) and @badabhai/config/shared (the
# shared secure-cookie helper), and @badabhai/validators pulls in @badabhai/types.
# The build therefore needs the whole monorepo in context to resolve and build them.
# .dockerignore keeps node_modules/dist/.next/.git out of the context either way.
#
# ---------------------------------------------------------------------------------
# THIS PORTAL IS NOT PUBLISHED TO THE INTERNET, AND THAT IS THE DESIGN.
#
# Building and deploying this image does NOT expose it: the box's security group opens
# ONLY 80/443 (measured — 3001/8000/3333 all refuse an external connection), and nginx
# fronts nothing but the payer portal and the api. `docker-compose.staging.yml` publishes
# this container on the box's own 3003 so the deploy's health gate can curl it over
# loopback, exactly as it does for payer-web; that is the whole of its reachability.
#
# Exposing an admin portal is a SEPARATE owner decision requiring an IP allowlist (or a
# VPN / SSH tunnel / mTLS equivalent) and is NOT authorized by this change. Do not add an
# nginx server block, a DNS record, or a certbot step for admin-web here.
#
# ---------------------------------------------------------------------------------
# NO `NEXT_PUBLIC_*` BUILD ARGS — AND THAT DIFFERENCE FROM payer-web IS DELIBERATE.
#
# payer-web bakes NEXT_PUBLIC_API_URL / NEXT_PUBLIC_SITE_URL at `next build` time and
# therefore needs two ARGs plus an `unset` dance, because `@badabhai/config`'s zod schema
# rejects the EMPTY STRING that an absent CI secret produces (that trap took a deploy
# down: `NEXT_PUBLIC_API_URL: Invalid url`). admin-web is structurally free of it:
#
#   * It imports only `@badabhai/config/shared` — pure helpers (booleanFromString,
#     isDevEnv, shouldUseSecureCookie, formatEnvError). There is NO top-level zod parse
#     of any NEXT_PUBLIC_* value anywhere on admin-web's import graph, so an empty or
#     absent public var cannot fail this build the way it failed payer-web's.
#   * It has NO client-side reader of any NEXT_PUBLIC_* value. The only two reads are
#     BOTH in `import "server-only"` modules and BOTH already fall back safely:
#       - `src/lib/server-config.ts` → `NEXT_PUBLIC_ENVIRONMENT ?? NODE_ENV ?? "development"`
#       - `@badabhai/config/shared`'s `shouldUseSecureCookie()` → short-circuits `true` on
#         `NODE_ENV === "production"`, which the runtime stage below pins, so the admin
#         session cookie is `Secure` in this image WITHOUT any public var being set.
#   * The api origin is `ADMIN_API_BASE_URL`, server-only ON PURPOSE (the browser must
#     never learn the internal API origin) and read at CONTAINER START, not baked here —
#     see the `admin-web` block in docker-compose.staging.yml.
#
# The matrix row in `.github/workflows/ci.yml` therefore carries `"next-public":false`,
# which is also what keeps payer-web's PAYER_WEB_NEXT_PUBLIC_* secrets from leaking into
# a DIFFERENT app's client bundle — those two `build-args:` lines name payer-web's secrets
# literally, so flipping this switch on would bake the PAYER portal's origin into the
# ADMIN portal. If a genuine admin-web public var is ever needed, it needs its OWN
# `ADMIN_WEB_NEXT_PUBLIC_*` secrets and its own ARGs with payer-web's `unset` guard —
# never this app riding payer-web's switch.
# ===========================================================================

# ---- builder: install workspace deps + build admin-web and its workspace packages ----
FROM node:22-bookworm-slim AS builder
ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app
# Copy the whole monorepo (admin-web depends on several @badabhai/* workspace packages,
# and Next's standalone output tracing needs to see them to resolve real paths through
# pnpm's symlinked node_modules). .dockerignore keeps node_modules / dist / .next / .git
# out of the context.
COPY . .
RUN pnpm install --frozen-lockfile

# Build @badabhai/admin-web AND its workspace deps (the `...` selector; pnpm runs them in
# topological order — @badabhai/config, @badabhai/pricing, @badabhai/validators, and
# validators' own @badabhai/types dependency, each via their own `tsc` build script,
# before `next build` runs).
RUN pnpm --filter @badabhai/admin-web... build

# ---- runtime: minimal Node + the standalone server output ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3003 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# Standalone output does NOT include `public/` or `.next/static` — Next's own docs require
# copying both by hand. `public/` is NOT empty here (it carries the four RobotoMono font
# files), so omitting that COPY would ship a portal that 404s its own assets.
# `outputFileTracingRoot` (next.config.mjs) is the monorepo root, so the traced tree under
# `.next/standalone` mirrors this repo's own layout (`apps/admin-web/server.js`, a pruned
# root `node_modules`, and each workspace package's built `dist/` reachable through it) —
# copying the whole directory as-is preserves that layout inside the runtime image.
COPY --from=builder /app/apps/admin-web/public ./apps/admin-web/public
COPY --from=builder /app/apps/admin-web/.next/standalone ./
COPY --from=builder /app/apps/admin-web/.next/static ./apps/admin-web/.next/static
# admin-web reads ADMIN_API_BASE_URL (server-only) at RUNTIME, not build time — see
# docker-compose.staging.yml's `admin-web` service block for that wiring; nothing
# box-specific is baked into this image.

# ---- build identity (#965): which build is actually running? ----
# Identical wiring to apps/api, apps/ai-service and apps/payer-web: the commit sha is
# knowable only at image-build time (the runtime container has no .git — .dockerignore
# strips it), so it arrives as a build arg and is promoted to an ENV so it survives into
# the running process; `src/app/health/route.ts` reads `process.env.GIT_COMMIT_SHA` per
# request and reports it as `"build"`.
#
# DELIBERATELY IN THE RUNTIME STAGE, NOT THE BUILDER: this is a server-side runtime read,
# NOT a NEXT_PUBLIC_* value baked by `next build`. The builder stage does not declare this
# ARG, so it is never injected into the `next build` RUN's environment — i.e. it is
# structurally incapable of reproducing the empty-build-arg failure that took payer-web's
# build down once already. `src/app/health/route.test.ts` asserts that placement.
#
# An unset or empty build arg is SAFE and expected: `--build-arg GIT_COMMIT_SHA=` (what a
# GitHub Actions `build-args:` line resolves to when the referenced value does not exist)
# bakes ENV GIT_COMMIT_SHA="" — and the route maps "" to the string "unknown" rather than
# failing. The route fails OPEN on it by design.
#
# PLACED AFTER THE COPYs ON PURPOSE: this value changes on every commit, and a changed ENV
# invalidates every layer below it. Keeping it last means a new sha re-runs only this
# instruction, never the expensive COPY layers.
ARG GIT_COMMIT_SHA
ENV GIT_COMMIT_SHA=${GIT_COMMIT_SHA}
EXPOSE 3003
USER node
CMD ["node", "apps/admin-web/server.js"]
