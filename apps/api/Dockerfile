# syntax=docker/dockerfile:1
# ===========================================================================
# Production image for the BadaBhai NestJS API (apps/api) — the repo's FIRST
# Dockerfile (closes TD24(d); ADR-0007). Build from the REPO ROOT:
#   docker build -f apps/api/Dockerfile -t badabhai-api .
#
# The runtime stage installs WeasyPrint (+ its Pango/cairo native stack) because
# the resume-render worker spawns `weasyprint - -` to render PDFs in Node
# (ADR-0007: render in Node, never the AI service). A build-time `weasyprint
# --version` check fails the build if that install is broken.
#
# NOTE: deploy/CD is still TBD; image-size slimming (pnpm deploy / prune dev deps)
# is a follow-up — this image is correctness-first for image #1.
# ===========================================================================

# ---- builder: install workspace deps + build the API and its workspace packages ----
FROM node:22-bookworm-slim AS builder
ENV CI=true
RUN corepack enable
WORKDIR /app
# Copy the whole monorepo (the API depends on several @badabhai/* workspace
# packages). .dockerignore keeps node_modules / dist / .git out of the context.
COPY . .
RUN pnpm install --frozen-lockfile
# Build @badabhai/api AND its workspace deps (the `...` selector; pnpm runs them in
# topological order). nest-cli copies resume/templates/*.html into dist — the
# renderer reads those at runtime.
RUN pnpm --filter @badabhai/api... build

# ---- runtime: slim Node + the WeasyPrint native stack ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# WeasyPrint (TD5 / ADR-0007). Pango/cairo/gdk-pixbuf are its native deps;
# shared-mime-info + a font package are needed for correct rendering. bookworm's
# pip is PEP-668 externally-managed, hence --break-system-packages (acceptable in a
# single-purpose container). The trailing `weasyprint --version` is a build gate.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip \
      libpango-1.0-0 libpangocairo-1.0-0 libpangoft2-1.0-0 \
      libgdk-pixbuf-2.0-0 libffi8 libfontconfig1 shared-mime-info fonts-dejavu-core \
  && pip3 install --no-cache-dir --break-system-packages weasyprint \
  && apt-get clean && rm -rf /var/lib/apt/lists/* \
  && weasyprint --version
WORKDIR /app
# Robust: copy the built workspace as-is and run the API entrypoint. (Slimming to
# prod-only deps is a follow-up; correctness first for the first image.)
COPY --from=builder /app /app
# The API reads API_PORT (default 3001) from config.
EXPOSE 3001
USER node
CMD ["node", "apps/api/dist/main.js"]
