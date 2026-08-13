# 11 — Command Reference

Every command below was verified against a `package.json` script, a workflow file, a README, or a script's own source — nothing here is inferred or guessed. Root scripts live in [`package.json`](../../package.json); package-scoped scripts (mostly `@badabhai/db`) live in [`packages/db/package.json`](../../packages/db/package.json) and are run with `pnpm --filter @badabhai/db <script>` — **not** all of them are re-exported as root `pnpm db:*` shortcuts (noted per-command below).

**A note on runbooks this reference would normally point to.** Comments in `.github/workflows/{ci,staging-cd,staging-demand-verify}.yml` and `docker-compose.staging.yml` repeatedly cite `docs/rollback-guide.md`, `docs/release-checklist.md`, `docs/observability-runbook.md`, `docs/environment-variables.md`, `docs/supabase-workflow.md`, `docs/pii-key-rotation-runbook.md`, `docs/github-actions.md`, and three `docs/ops/*-runbook.md` files. **None of these exist in the current tree** — `git log --oneline -- docs/rollback-guide.md docs/ops` shows only `eb151468 "Removed the stale docs folder (#589)"` and nothing since. Every command below is documented from the workflow/script/source itself, not from a runbook — where a workflow comment says "see the runbook," that runbook is currently a dead link. This is a real gap for the remediation backlog, not fabricated here to fill it.

## Install

| Command | Purpose | Prerequisites | Failure symptom |
|---|---|---|---|
| `pnpm install --frozen-lockfile` | Install the whole workspace exactly as locked | Node ≥20, pnpm 11.5.2 (`packageManager` field — every CI job installs pnpm via `pnpm/action-setup` **without** a `version:` input specifically so this field is the single source of truth) | `ERR_PNPM_BAD_PM_VERSION` on a conflicting pin; a lockfile/manifest mismatch fails closed |
| `pip install -r requirements-dev.txt` (from `apps/ai-service/`) | Install ai-service's runtime+dev/test deps | Python ≥3.11, CI pins 3.12 | Wheel build failure on an unsupported Python version |
| `flutter pub get` (worker-app/payer-app) | Install Dart/Flutter deps | CI pins Flutter 3.35.7/Dart 3.9.2 | `pubspec.lock` floors Dart ≥3.8.0 — an older local Flutter cannot even `pub get` |

## Development

| Command | App | Port | Notes |
|---|---|---|---|
| `pnpm dev` (root) | all | — | `turbo run dev`, parallel |
| `pnpm dev:all` (root) | api + ai-service | 3001+8000 | **VERIFIED BROKEN**: invokes `concurrently`, which is not a declared dependency anywhere in the monorepo or lockfile (`grep -r "concurrently" **/package.json"` and `pnpm-lock.yaml` both return zero matches) — fails at runtime unless a developer happens to have it installed globally |
| `pnpm --filter @badabhai/api dev` | apps/api | 3001 | `nest start --watch` |
| `pnpm --filter @badabhai/web dev` | apps/web | 3000 | `next dev -p 3000` |
| payer-web `dev` | apps/payer-web | 3002 | `next dev -p 3002` |
| admin-web `dev` | apps/admin-web | 3003 | `next dev -p 3003` |
| `uvicorn app.main:app --reload --port 8000` (from `apps/ai-service/`) | apps/ai-service | 8000 | Needs a venv + `requirements-dev.txt` |
| `flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3001` (worker-app) | apps/worker-app | — | `10.0.2.2` = Android-emulator host-loopback alias |
| `flutter run` (payer-app) | apps/payer-app | — | `apps/payer-app/README.md` is stock `flutter create` boilerplate, no project-specific instructions |

## Backend (`apps/api`)

| Command | Purpose | Failure symptom |
|---|---|---|
| `nest build` (`pnpm build`) | Compile to `dist/` | TS compile error |
| `nest start --watch` (`pnpm dev`) | Local dev, reload | **Fails closed at boot** if `assertPiiCryptoConfig`/`assertAuthConfig`/`assertPayerAuthConfig`/`assertAdminAuthConfig` reject dev-default secrets outside development/test |
| `node dist/main.js` (`pnpm start`) | Run built server | Crash-loop if any `${VAR:?}` staging secret is unset, or a fail-closed boot assert rejects a dev default under `NODE_ENV=production` |
| `pnpm typecheck` | `tsc --noEmit` | TS type error |
| `pnpm test` (vitest) | Unit/integration suite | With `-- --coverage` in CI, enforces `apps/api/vitest.config.ts` thresholds (lines 75/functions 75/branches 73/statements 75) |

## AI-service (`apps/ai-service`)

| Command | Purpose | Notes |
|---|---|---|
| `uvicorn app.main:app --reload --port 8000` | Dev server | `GET /health` returns liveness + `ai_posture` |
| `pytest` | Whole suite | `testpaths=["tests"]` |
| `pytest tests/test_pseudonymize.py` | Pseudonymization-only | README states this file has **no third-party dependencies** — runs even where FastAPI/pydantic wheels are unavailable |
| `ruff check .` | Lint | `line-length=100`, rules `E,F,I,UP,B` |
| `python -m app.cli.onboarding_chat` | Terminal-drive the worker interview **through the real production code path** (`TestClient`, no server/socket/DB/Node) | Interactive trace |
| `python -m app.cli.onboarding_chat --edge-cases` | Scripted ~49-case regression suite | Known open defects (TD98, R30) asserted as **current** behavior and labeled — if one stops reproducing, the suite reports `STALE` and **exits non-zero** |
| `python -m app.cli.stt_smoke --file <clip>` | Real Sarvam STT smoke | Requires `AI_ENABLE_REAL_CALLS=true`+`SARVAM_API_KEY`; fails closed to an empty transcript on error |

## Frontend (`apps/web`, `apps/payer-web`, `apps/admin-web`)

Share the same script shape (`next dev/build/start -p <port>`, `tsc --noEmit`, `vitest run --passWithNoTests`).

| App | Port | Own `lint`? | Notable extra |
|---|---|---|---|
| apps/web | 3000 | No (root `pnpm lint` covers it) | — |
| apps/payer-web | 3002 | `eslint src` | `verify:assetlinks` → App Links release gate — **verified NOT wired into any CI workflow** (`grep -r verify-assetlinks .github` → nothing); a human must remember to run it before a payer-web release |
| apps/admin-web | 3003 | `eslint src` | — |

`staging-cd.yml`'s own comment notes Next.js apps fail `next build` under `NODE_ENV=development` — why the staging-CD workflow explicitly scopes its build to `@badabhai/api...` only. `next start -p <port>` is not used by any deploy path found in this repo — no compose service, no workflow step, no Dockerfile for these three apps.

## Mobile (`apps/worker-app`, `apps/payer-app`)

| Command | Purpose | Notes |
|---|---|---|
| `flutter analyze` | Static analysis — **BLOCKING** | Flutter 3.35.7/Dart 3.9.2 pinned; local Flutter <3.9 cannot even resolve `pubspec.lock` |
| `flutter test` | Widget/unit tests — **BLOCKING** | worker-app's README states CI is "the source of truth even if you can't run Flutter locally" |

**Verified CI pin**: both `worker-app.yml`/`payer-app.yml` pin `flutter-version: "3.35.7"` explicitly (not bare `channel: stable`) — the pin moved from 3.27.4/Dart 3.6 after the apps required Android 15's 16 KB page-size support, and letting it drift broke the gate once already.

## Database (`packages/db`)

Every `db:*` script runs `tsx src/<file>.ts`. Two forms: **root-exposed** (`pnpm db:<name>` from anywhere) and **package-only** (`pnpm --filter @badabhai/db db:<name>`, no root shortcut).

**Schema/migration**: `db:generate` (drizzle-kit generate, pure diff, no DB — `supabase-checks.yml`'s `migration-drift` job runs this + `git diff --exit-code`, currently `continue-on-error: true`), `db:migrate` (apply full chain — migrations 0003/0004 REVOKE from `anon`/`authenticated`/`service_role`, so a plain non-Supabase Postgres needs those roles pre-created), `db:studio`.

**Seed** (representative): `db:seed` (Phase-1 placeholder), `db:seed:jobs` (required before any swipe-to-apply e2e), `db:seed:demand` (must run against the same `PII_ENCRYPTION_KEY`/`PII_HASH_PEPPER` the API boots with), `db:seed:skills`, `db:seed:domains`/`db:seed:packs`/`db:seed:match:vocabulary` (all dry-run by default, need `--apply` — `ci.yml`'s own comment: "the first version of these two steps omitted `--apply`, both went green, and `db:verify:packs` then failed with 'the pack tables are EMPTY'"), `db:seed:reach`/`db:seed:reach:large` (verified identical invocation — both map to the same script, `:large` is an explicit-intent alias not a distinct code path).

**Verify**: `db:verify:demand`, `db:verify:domains`, `db:verify:packs` (bare = live-DB check; `--corpus` = DB-free, runs in the CI `node` job), `db:verify:reach`, `db:verify:match-v1` (package-only — strictly read-only SELECTs+EXPLAINs), `db:eval:occupation` (`--min-hit-rate 95` in CI, re-derived floor against a measured 97.0%, deliberately not raised to the 97% product-requirement default).

**Embed/retag/growth**: `db:embed:skills`/`domains`, `db:normalize:aliases` (**must run between `db:seed:domains` and any retrieval**, or aliases are "invisible to L0/L2 retrieval"), `db:gen:aliases`/`db:mine:aliases`, `db:growth:cluster`/`db:growth:occupation` (package-only), `db:retag:skills`.

**Reconcile/backfill/bootstrap** (package-only, no root shortcut): `db:reencrypt:pii`, `db:backfill:worker-skills`/`job-postings`, `db:convert:seed-jobs` (own comment: "WITHOUT THIS THE WORKER FEED IS EMPTY AT FLAG FLIP"), `db:materialize:reach`, `db:grant:free-tier`, `db:bootstrap:admin` (per team memory, already run once against prod — CLI now refuses to run again), `db:admin:reset-mfa`.

## Redis

No `redis-cli`-wrapping script — operated entirely through Docker Compose + the app's own `REDIS_URL`.

| Command | Purpose |
|---|---|
| `pnpm db:up` (despite the name, starts **both** Postgres and Redis) | `docker compose up -d postgres redis` |
| `pnpm db:down` | Stops containers, **keeps volumes** |
| `docker compose down -v` | Stop **and delete** volumes — deliberately not wrapped in any pnpm script |
| Loopback bind | Redis bound `127.0.0.1:6379:6379` in the **base** compose file (not an overlay) specifically because compose `ports` merge by union-of-keys, not override |

`infra/redis/README.md` is stale Phase-1 placeholder text ("BullMQ workers ... introduced when AI jobs move from inline to background") — `apps/api/package.json` already depends on `@nestjs/bullmq`/`bullmq` today.

## Tests

| Command | Scope | Notes |
|---|---|---|
| `pnpm test` (root) | `turbo run test` | CI runs `pnpm test -- --coverage`; the `--` is load-bearing — forwarding a filter incorrectly reruns the **whole** suite instead of a subset, a mistake `ci.yml`'s DB-gates step explicitly works around |
| `pnpm --filter @badabhai/api run test rank-parity boost-fences apply-freeze current-profile-order` | 4 DB-backed release gates (ADR-0036) | `RUN_DB_TESTS=1`-only, `e2e` job; the CI step double-checks each file ran AND exactly 4 ran (`Test Files +4 passed (4)`), to catch the arg-forwarding bug above recurring |
| `node --test scripts/staging-smoke.test.mjs` | Offline self-test of the smoke script | Zero network |
| `pnpm --filter @badabhai/e2e test` | Phase-1 E2E onboarding | ai-service **deliberately not started** — API degrades to safe mock, flow completes offline |
| `node scripts/smoke.mjs [baseUrl]` | Fast liveness + happy-path check | "No prod target is wired today" per the script's own header |
| `node scripts/staging-smoke.mjs` (`pnpm staging:smoke`) | Persistent-staging smoke | `/health` always; authed stage only when `SMOKE_TEST_LOGIN_TOKEN` set |
| `node scripts/prod-canary.mjs` | Production posture canary | "READ-ONLY and WRITE-FREE by construction"; a 200 on stage 2/3 is **CRITICAL**, not a warning |
| `sh scripts/chat-cli.sh` / `scripts/chat-cli.ps1` | Interactive terminal chat vs. the deterministic engine | Needs `TEST_LOGIN_ENABLED=true` + a seeded/normalized DB |

**Coverage thresholds** (`apps/api/vitest.config.ts`): lines 75/functions 75/branches 73/statements 75, enforced only when `--coverage` is passed.

## Type checking / Linting

`pnpm typecheck` (root, `turbo run typecheck`); `pnpm lint` (`eslint .`, root); `pnpm lint:fix`; `pnpm lint:oxlint` (payer-web-scoped correctness pass, separate CI step from `pnpm lint`); `ruff check .` (ai-service); `flutter analyze` (mobile, blocking).

## Build

`pnpm build` (root, `turbo run build`, topological); `pnpm --filter "@badabhai/api..." build` (API+deps only, **not** the whole monorepo — explicitly scoped in `e2e`/`staging-cd`/`staging-demand-verify` jobs because Next.js apps fail `next build` under `NODE_ENV=development`); `pnpm --filter "@badabhai/db..." build` (schema-checks + Docker builder stage).

## Docker

| Surface | Notes |
|---|---|
| `docker-compose.yml` | Base, dev-laptop by design — `postgres`/`redis`/`adminer` start unconditionally; `api`/`ai-service`/`proxy`/`mailpit` are all **profile-gated**, never started by plain `docker compose up` |
| `docker compose --profile api up --build` | Brings up `api`+`ai-service` together |
| `docker compose --profile proxy-harness up` | api+ai-service+an nginx that appends `X-Forwarded-For` like a real single-hop LB, for reproducing `TRUST_PROXY_HOP_COUNT` failure modes locally |
| `pnpm mail:up`/`mail:down` | Real SMTP catcher (mailpit) for local admin one-time-code email delivery |
| `docker-compose.override.yml` | Not committed pattern but present — remaps Postgres to host `5433`; auto-loaded, **not** picked up in staging (which passes explicit `-f` flags) |
| `docker-compose.staging.yml` | CD overlay — every production secret is `${VAR:?}` (fail-loud before any container starts); `AI_SERVICE_URL` is a **literal** (one correct value on that box) |
| `docker build -f apps/api/Dockerfile -t badabhai-api .` | **Must be built from repo root** (`.` context) — depends on multiple workspace packages. Build gate: `weasyprint --version` fails the build if the native stack doesn't install. **No `HEALTHCHECK` directive** — asymmetric with the ai-service image |
| `docker build -f apps/ai-service/Dockerfile apps/ai-service` | Context is `apps/ai-service` (pure Python, no workspace deps). Ships a real `HEALTHCHECK` |

## Migration

Sequencing (apply before deploying code that assumes them) is **currently not automated** on the Lightsail path: `deploy-lightsail`'s explicit `TODO(CD-2, held: 0031 human sign-off + D1)` — migrations require a manual, human, pre-deploy step there. `staging-cd.yml`/`staging-demand-verify.yml` **do** run `pnpm db:migrate` before starting the API and get the ordering right; the Lightsail path currently does not. `/health`'s DB check is connectivity-only (`SELECT 1`), so a fresh unmigrated `DATABASE_URL` still boots 200 while every real endpoint 500s.

## Health checks

| Endpoint | What it checks | Gates deploy? |
|---|---|---|
| `GET /health` (apps/api) | `database`+`redis` hard-gate; `deletion_sweep`/`ai_service`/`storage_config` informational **except** a deployed box with Storage armed-without-credentials (#793) flips to 503 | Yes — `deploy-lightsail`'s poll (30×2s), `staging-cd.yml`'s smoke (60×5s), `staging-demand-verify.yml`'s poll (60×1s) |
| `GET /health` (apps/ai-service) | Liveness + `ai_posture` | Yes — `deploy-lightsail` polls **before** starting `api`, 15×2s, blocks the api deploy entirely if it never comes up |
| Docker `HEALTHCHECK` (ai-service only) | Same `/health` | Not directly read by any compose `condition: service_healthy` for `api`/`ai-service` |
| `redis-cli ping` / `pg_isready` (compose healthchecks) | — | Yes — `api` (profile `api`) `depends_on: condition: service_healthy` |

## CI

10 workflow files. `node` job (lint/typecheck/test/build) — no path filter, always runs. `ai-service`/`ai-service-image` — path-gated on `apps/ai-service/**`+`packages/profiling-lexicon/**`. `e2e` — path-gated, full migrate→seed→verify→start→e2e chain. `worker-app`/`payer-app` — reusable, called from `ci.yml` (as of #718/#711 fix). `sast`/`deps-audit` — reusable, called both per-PR (scoped) and weekly (whole-tree) from `security-scan.yml`. `build-and-push-image`/`deploy-lightsail` — push-to-main only, not required. `ci-required` is the single required status check — `if: always()`, passes when every `needs:` job is `success` or (path-filtered) `skipped`. See [12_CICD_AUDIT.md](12_CICD_AUDIT.md) for the full per-workflow classification.

## Deployment

The only automated deploy path is `ci.yml`'s `deploy-lightsail` job (push to `main`, after `build-and-push-image`). Sequence: SSH in → `git pull` → `docker login ghcr.io` with the ephemeral job token → export immutable `sha-<short7>` image tags → disk-space reclaim (escalating prune, hard-fails under 2GB free — deploys #500/#501/#503 died from disk exhaustion before this step existed) → pull both images → start Redis (box-local, CD-1a) → **migrations are not run here** (see Migration above) → start ai-service, poll health, block-and-dump-logs on failure → start api, same pattern → `trap docker logout ghcr.io` on every exit path.

**Rollback**: the mechanic ("export the previous sha tag and re-run `up`") is reconstructable from `docker-compose.staging.yml`'s inline comments, but the runbook it repeatedly points to (`docs/rollback-guide.md`) **does not exist in the current tree** — a real gap, not a documentation nicety.

Two additional, currently-inert deploy-adjacent workflows target a **separate**, not-yet-provisioned persistent-staging host: `staging-cd.yml` and `staging-demand-verify.yml` — see [12_CICD_AUDIT.md](12_CICD_AUDIT.md) F3/F4 for their live-verified status.

---

**Two independently-verified defects surfaced during evidence gathering** (both belong in the remediation backlog): (1) `pnpm dev:all` invokes `concurrently`, which is not a dependency anywhere in the workspace or lockfile; (2) `docs/rollback-guide.md`, `docs/release-checklist.md`, `docs/observability-runbook.md`, `docs/environment-variables.md`, `docs/supabase-workflow.md`, `docs/pii-key-rotation-runbook.md`, `docs/github-actions.md`, and three `docs/ops/*.md` runbooks are cited across CI/compose/source comments but do not exist in the tree (removed by `eb151468`, PR #589, never recreated).

**Files referenced**: `package.json`, `apps/api/package.json`, `apps/ai-service/README.md`, `apps/ai-service/pyproject.toml`, `apps/worker-app/README.md`, `apps/payer-app/README.md`, `apps/{web,payer-web,admin-web}/package.json`, `packages/db/package.json`, `tests/e2e/package.json`, `turbo.json`, `docker-compose*.yml`, `apps/api/Dockerfile`, `apps/api/vitest.config.ts`, `apps/api/src/health/health.controller.ts`, all 10 `.github/workflows/*.yml`, `scripts/{smoke,prod-canary,staging-smoke,chat-cli.sh}`, `apps/payer-web/scripts/verify-assetlinks-release.mjs`, `infra/redis/README.md`, `infra/monitoring/README.md`, `.env.example`, headers of all 32 `packages/db/src/*.ts` scripts.
