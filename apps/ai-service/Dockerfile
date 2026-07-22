# syntax=docker/dockerfile:1
# ===========================================================================
# Production image for the BadaBhai AI service (apps/ai-service) — the FastAPI
# pseudonymization gateway. This is the repo's SECOND Dockerfile and it closes
# TD81 option (a): until it existed nothing served the AI service on the box, so
# `AI_SERVICE_URL` (default http://localhost:8000, packages/config/src/server.ts)
# resolved to nothing on Lightsail, the NestJS API degraded to its TypeScript
# mock (`real_call=false`) and /health still returned 200 — staging reported
# healthy while running AI ENTIRELY MOCKED, with no red signal anywhere.
#
# BUILD FROM apps/ai-service — NOT from the repo root. This DIFFERS from
# apps/api/Dockerfile's convention on purpose:
#
#   docker build -f apps/ai-service/Dockerfile -t badabhai-ai-service apps/ai-service
#
# apps/api needs the WHOLE monorepo in its context because it builds several
# @badabhai/* workspace packages. This service has ZERO workspace dependencies —
# it is pure Python and requirements.txt + requirements-ai.txt are its entire
# dependency surface (the api/ai boundary is HTTP + the mirrored contracts, not a
# shared package). Scoping the context to this directory keeps it in the hundreds
# of KB instead of the monorepo's GBs. Consequence worth knowing: the file that
# filters the context is apps/ai-service/.dockerignore, NOT the repo-root one.
#
# Python 3.12 to MATCH THE CI GATE: .github/workflows/ci.yml's `ai-service` job
# pins `python-version: "3.12"`, and pyproject.toml declares requires-python
# >=3.11 (ruff target-version py311). 3.12 satisfies both, so the interpreter
# that ships is the exact one `ruff check .` and `pytest` were green on — not a
# nearby version nobody ran the suite against.
#
# THIS IMAGE DOES NOT ARM REAL LLM CALLS (CLAUDE.md §2 invariant 5).
# requirements-ai.txt (langfuse + the `anthropic` fallback SDK) IS installed so
# that turning real mode on later is an ENV change, never a rebuild — and so the
# router's `fallback_transport_available()` probe can actually find the SDK when
# a key is supplied. The gate itself is `AI_ENABLE_REAL_CALLS` + a provider key
# read at RUN time, and both stay false/unset in every committed file (compose
# pins `AI_ENABLE_REAL_CALLS: "false"` in base AND in the staging overlay). The
# image is deliberately CAPABLE and deliberately NOT ARMED.
# ===========================================================================

FROM python:3.12-slim-bookworm

# PYTHONDONTWRITEBYTECODE — no .pyc litter written into the container layer at
# runtime. PYTHONUNBUFFERED — uvicorn + app/logging_config output must reach
# `docker logs` immediately; a buffered stdout is exactly why a crash-looping
# container so often looks silent, and this service's boot-time failures (the
# AI_SPEND_REDIS_URL validator, the AI_INTERNAL_TOKEN min_length check) are
# LOUD BY DESIGN and must not be swallowed by a buffer.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependencies FIRST, as their own layer — requirements*.txt churn far less often
# than app/, so an app-only edit reuses this (slow) layer. BOTH files are copied
# because requirements-ai.txt opens with `-r requirements.txt`: installing it
# alone therefore installs the base runtime set too, but the base file must be
# present for that include to resolve.
#
# No build toolchain (gcc/python3-dev) is installed: every dependency here
# publishes manylinux cp312 wheels (fastapi/pydantic-core/uvicorn[standard]'s
# uvloop+httptools/httpx/redis/langfuse/anthropic), so the image stays slim and
# free of a compiler. If a future dep ships sdist-only, add the toolchain in a
# BUILDER stage and copy the site-packages out — do not leave gcc in the runtime.
COPY requirements.txt requirements-ai.txt ./
RUN pip install --no-cache-dir -r requirements-ai.txt

# Non-root. python:*-slim ships no unprivileged account (unlike the node:* images
# apps/api/Dockerfile leans on for its `USER node`), so create one explicitly. A
# fixed high uid keeps ownership predictable if a volume is ever mounted; no
# login shell, no password. Created AFTER the pip install so the dependency layer
# is not invalidated by a change to this line.
RUN useradd --system --create-home --uid 10001 --shell /usr/sbin/nologin aiservice

# Application code. `app/` is the entire runtime surface: the package is pure
# Python with NO data files (no templates, no gazetteer/corpus files to ship) and
# reads nothing outside itself — config.py anchors its optional .env to
# `parents[1]`, i.e. /app, which stays absent here on purpose (see .dockerignore:
# an image must never bake in an env file). `scripts/` carries only
# sample-interview.txt, the fixture for `python -m app.cli.onboarding_chat
# --script ...`; it is ~500 bytes and keeping the CLI harness runnable inside the
# container is worth that for on-box triage. tests/ and requirements-dev.txt are
# deliberately NOT copied — the test gate runs in CI, not in the deployed image.
COPY app ./app
COPY scripts ./scripts

USER aiservice

# The container port is FIXED at 8000. AI_SERVICE_PORT exists in app/config.py
# but is DECLARATIVE ONLY — nothing binds uvicorn to it — and 8000 is the value
# AI_SERVICE_URL defaults to on the caller's side. Which port the HOST sees is a
# compose `ports:` concern (loopback-bound there, CD-1a), never a rebuild.
EXPOSE 8000

# /health is the ONE path exempt from the TD67 service-token middleware
# (`_AUTH_EXEMPT_PATHS` in app/main.py), so this probe keeps working after
# AI_INTERNAL_TOKEN is armed — a healthcheck that starts 401ing the moment the
# token is set would be worse than no healthcheck at all. Probing with stdlib
# urllib rather than curl: python:slim ships no curl, and adding it purely for a
# liveness probe would grow the image and its CVE surface for nothing. urlopen
# raises on any non-2xx, so a bad status exits non-zero without an explicit check.
# start-period covers the lifespan hook (cost_tracker.get_ledger()) — no network
# I/O, but it is where a malformed AI_SPEND_REDIS_URL aborts the boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3).read()"]

# ONE uvicorn worker ON PURPOSE (no --workers). The TD27 spend caps — daily,
# cumulative and per-user INR — are enforced PER PROCESS unless
# AI_SPEND_REDIS_URL points at the shared ledger (app/config.py spells this out:
# "with N Uvicorn workers each holds its own counters"). N workers would
# therefore silently mean N x every cap, which is the wrong default for a service
# whose whole cost story is those caps. Raising the worker count is a change that
# must land TOGETHER with a shared ledger URL, never before it.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
