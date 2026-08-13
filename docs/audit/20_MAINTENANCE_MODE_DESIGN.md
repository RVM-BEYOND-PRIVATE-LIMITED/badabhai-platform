# 20 — Maintenance Mode: Design

Status: **DESIGN ONLY — nothing described here is implemented.** No file in this repository currently contains a `MAINTENANCE_MODE` variable, a maintenance middleware, or a maintenance page (verified: `git grep -i maintenance` across `apps/`, `packages/`, `infra/`, `.github/` returns only unrelated substrings). This document proposes a mechanism, states exactly what it depends on, names every new file and env var it would introduce, and is honest about what it cannot cover given what actually exists in this repo today.

## 1. What infrastructure actually exists today

### 1.1 No reverse proxy in this repo's IaC — except a dev-only QA harness

`infra/docker/proxy-harness/nginx.conf` is the only nginx/reverse-proxy artifact in the repo — its own header states: "TD25a — local reverse-proxy harness for TRUST_PROXY_HOP_COUNT QA... Never a production config." Listens on plain HTTP, no TLS, never referenced by any deploy workflow. `docker-compose.staging.yml` — the actual production overlay — declares only `api` and `ai-service`; no `proxy`/`nginx`/`caddy` service. `apps/api`'s container publishes `3001:3001` directly.

### 1.2 A TLS-terminating edge does exist in production, but it is entirely out-of-repo

Two independent pieces of evidence: `apps/api/src/common/middleware/security-headers.middleware.ts` states outright, as the reason HSTS is deliberately *not* set from the app: "TLS terminates at the edge, not in this process. Emitting HSTS from behind a proxy is how a misconfigured local/staging deployment poisons a developer's browser for the whole domain. It belongs on the TLS terminator." `scripts/staging-smoke.mjs`/`prod-canary.mjs` both require `https://` base URLs. So something in front of the Lightsail box terminates TLS — but its configuration is **NOT VERIFIED / UNKNOWN**, undocumented infrastructure-as-code. This design does not depend on that edge; §7 names the one failure class it therefore cannot cover.

### 1.3 The existing kill-switch precedent (the pattern this design follows)

Every operational/provider switch in this repo is an **env var read once into `ServerConfig` at boot**, never a runtime DB row, never a live in-process toggle. Flipping one is "an env action, not a code change": export on the box, then `docker compose up -d --no-deps api` — restart on the already-pulled image, no rebuild. Booleans use `booleanFromString` (defaults `false`, empty string never coerces to `true` — `z.coerce.boolean()` is explicitly avoided repo-wide). `docker-compose.staging.yml` must use the **substitution form** `${VAR:-default}`, never a literal — this exact bug shipped **three times** (`AI_ENABLE_REAL_CALLS` #798, `WORKER_PHOTOS_BUCKET` #794, `CHAT_LLM_INTERVIEW_ENABLED` #798), now guarded by dedicated compose-guard tests. The admin kill-switch surface is display+safe-direction-pause-intent only, by construction — "there is no enable path anywhere in this service." This is the pattern reproduced exactly below, because it is already proven, already tested, and already the thing every engineer on this repo recognizes.

### 1.4 A directly relevant gap: the ops-doc tree does not exist

`docker-compose.staging.yml`/`ci.yml` reference `docs/rollback-guide.md` by name; it doesn't exist on `main` (`eb151468`, PR #589, deleted the entire ops-runbook set, never recreated — confirmed via `ls`/`find`). This design's own operator runbook (§6) should ship as `docs/ops/maintenance-mode-runbook.md`; the missing `docs/rollback-guide.md` is a real, pre-existing hole this DevOps role should close regardless of maintenance mode.

### 1.5 There is no metrics/alerting backend of any kind

`infra/monitoring/README.md`: "TODO (later): metrics (Prometheus/OpenTelemetry), dashboards, alerting." Re-verified independently: no `prom-client`, `@nestjs/terminus`, `Sentry`, or OpenTelemetry dependency anywhere. This bounds what §8 can honestly propose: a log line and a `/health` field, not a metric or a page.

## 2. Requirements restated as design constraints

| Requirement | Constraint |
|---|---|
| No rebuild required | Config value read at boot from an env var wired exactly like every other gate — never a new image |
| Graceful user-facing page | The API is JSON-only (`Content-Security-Policy: default-src 'none'`) — it cannot serve HTML. Must serve a machine-readable contract the five frontends render their own page from |
| Admin/ops bypass | Must not depend on the datastore that might be the reason for the window; must not be path-based (guessable) |
| Health endpoints stay available | `/health` must report real DB/Redis state regardless of the flag — conflating "operator closed the door" with "unhealthy" repeats the TD81 mistake |
| DB stays untouched | Gate must trigger before any DB/Redis/BullMQ call |
| Reversible | Turning off requires no data migration, no image change |
| Environment-specific | Settable independently per compose overlay |
| Safe through CI/CD | Defaults `false` in schema; staging overlay entry must be substitution form, guard-tested |
| No hardcoded production switch | No committed file may contain a literal `"true"`; only a box's shell/GH Environment secret arms it |

## 3. The mechanism

### 3.1 New config surface — `packages/config/src/server.ts`

```
MAINTENANCE_MODE: booleanFromString,                          // default false
MAINTENANCE_MESSAGE: z.string().max(280).default(
  "BadaBhai is undergoing scheduled maintenance. Please try again shortly."
),
MAINTENANCE_BYPASS_TOKEN: optionalSecret(z.string().min(16)),  // absent by default
```

`MAINTENANCE_MODE` uses `booleanFromString` — the safe default for an *availability* lever is "keep serving," which false-by-default correctly gives. `MAINTENANCE_BYPASS_TOKEN` is **deliberately not required** — unlike `INTERNAL_SERVICE_TOKEN`, arming maintenance mode must never depend on a second secret being present, because it may be exactly the tool an operator reaches for *during* an incident where some other secret is broken. No fail-closed boot assert is added for these three — arming must always be possible regardless of what else is misconfigured.

### 3.2 The middleware — `apps/api/src/common/middleware/maintenance-mode.middleware.ts`

A NestJS class middleware (constructor DI reads `ServerConfig` from the existing `@Global()` `SERVER_CONFIG` provider, no re-parsing `env`):

```ts
@Injectable()
export class MaintenanceModeMiddleware implements NestMiddleware {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}
  use(req: Request, res: Response, next: NextFunction): void {
    if (!this.config.MAINTENANCE_MODE) return next();
    if (isBypassed(req, this.config.MAINTENANCE_BYPASS_TOKEN)) return next();
    res.setHeader("Retry-After", "300");
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({
      statusCode: 503,
      error: { message: this.config.MAINTENANCE_MESSAGE, code: "maintenance_mode" },
      requestId: req.requestId, path: req.url, timestamp: new Date().toISOString(),
    });
  }
}
```

**Response envelope matches `AllExceptionsFilter`'s existing shape exactly**, plus `error.code: "maintenance_mode"`. Every HTTP client already in this repo has to parse this envelope for ordinary errors — a maintenance window degrades to whatever their existing generic-error path does, even before any frontend adds maintenance-aware handling. `error.code` gives them a discriminator to add a dedicated page later without a breaking change (CLAUDE.md §3).

**Registration**, `app.module.ts`'s existing `configure()`:

```ts
configure(consumer: MiddlewareConsumer): void {
  consumer.apply(RequestIdMiddleware).forRoutes("*");
  consumer.apply(MaintenanceModeMiddleware)
    .exclude({ path: "health", method: RequestMethod.GET })
    .forRoutes("*");
}
```

Ordering is deliberate: **after** `RequestIdMiddleware` (so the 503 carries a real `requestId`); **before** every feature module/guard/DB-touching service (registered at `AppModule` level, performs zero I/O — satisfies "DB stays untouched"); `.exclude(...)` uses Nest's own consumer-exclusion API, not a buried `if` check.

**Path/route policy — exactly two carve-outs**: (1) `GET /health`, always served with real checks untouched; (2) a request carrying `X-Maintenance-Bypass` whose value constant-time-matches `MAINTENANCE_BYPASS_TOKEN` (reusing the exact `timingSafeEqual` + length-precheck + dummy-buffer-on-mismatch pattern already in `admin-otp.service.ts`/`admin-mfa.ts`). **No path-prefix exemption** — a path-based carve-out is guessable; a secret-based one is not. The Razorpay webhook is **not** exempted (Razorpay retries on non-2xx; accepting a webhook while the schema might be mid-migration is exactly the "never continue with partial failures" case CLAUDE.md §3 already prohibits).

### 3.3 Compose wiring — both files, substitution form only

`docker-compose.yml` (dev-laptop): substitution form, deliberately overridable (unlike `AI_ENABLE_REAL_CALLS`'s hard literal there) — a developer legitimately wants to run `MAINTENANCE_MODE=true docker compose up --build api` locally to visually verify a frontend's rendering, with no cost/safety implication.

`docker-compose.staging.yml`: **must** be the substitution form — the single most important correctness property of this design, given this exact file has shipped the literal-instead-of-substitution bug three times already. A guard test (`apps/api/src/config/maintenance-mode-compose.guard.test.ts`) closes it the same way the other three gates are closed: parses both compose files via the existing shared helper and asserts (a) all three vars are declared at all, (b) staging's values are the `${VAR:-default}` substitution form.

`docker-compose.e2e.yml` needs no change — it declares no `api` service; the CI e2e job starts the process directly, so the schema default governs with nothing to wire.

### 3.4 Not proposed as a CI secrets-bridge entry

`MAINTENANCE_MODE` is deliberately **not** threaded through `deploy-lightsail`'s SSH secrets bridge — armed only by an operator's own SSH session, never by a CI run. A maintenance window is a human decision made in the moment. Adding it to the CI bridge would in fact be actively wrong: an automated deploy run without an explicit secret value could silently un-arm a window an operator had just declared, mid-migration (the same failure class `AI_SPEND_REDIS_URL`'s own comment already warns about).

## 4. Runtime failure modes

| Scenario | What happens | Why this is right |
|---|---|---|
| `MAINTENANCE_MODE` unset (default) | `false` — all routes normal | Fail-safe default, ships dormant like every other gate |
| Armed, no bypass token configured | Every non-`/health` route 503s for everyone, including ops | Correct — an operator who armed without provisioning a bypass gets exactly what they asked for, loudly |
| Armed, wrong/missing bypass token | 503, same as unauthenticated | `timingSafeEqual` with length precheck + dummy-buffer fallback — no timing/length oracle |
| The `api` process can't boot at all (e.g. `assertAuthConfig` trips) | Crash-loops before any middleware runs; no graceful page served | **Named limitation, not solved here** — lives entirely inside the process; cannot help if the process can't start, and the production edge is unevidenced in this repo (§1.2) |
| Reading `ServerConfig` in the middleware | Cannot fail at request time — plain in-memory object, no I/O per request | Removes "the maintenance check itself broke" as a risk class by construction |

## 5. Health endpoint contract

`GET /health` is **not** gated by `MAINTENANCE_MODE`, status code **unaffected** — excluded via `.exclude(...)`, not merely "also happens to be allowed." One new informational field, following the exact `ai_posture`/`deletion_sweep`/`storage_config` precedent, **never gating** the 200/503 the CD health-poll reads: `checks.maintenance_mode: "on"|"off"`. If this instead flipped `/health`'s status code, `deploy-lightsail`'s health-poll and `staging-smoke.mjs` would both fail during an *intentional* window — the exact TD81 failure class already paid for once. A boot-time WARN log line is added alongside the existing dev-defaults warnings, so a box that restarts while still armed is loudly visible, not silently rediscovered. No metric/counter proposed — no metrics backend exists to emit one to (§1.5).

## 6. Operator runbook (design-level sequencing)

Recommended home: `docs/ops/maintenance-mode-runbook.md` (new — `docs/ops/` doesn't exist today, §1.4).

**Step 0** (ships in a normal PR through CI, not a maintenance action): schema entries, middleware + registration, compose wiring, guard test. Default `false` everywhere — a no-op the moment it lands.

**Step 1 — declare the window**: `export MAINTENANCE_MODE=true MAINTENANCE_MESSAGE="..." MAINTENANCE_BYPASS_TOKEN=<box secret>` then `docker compose ... up -d --no-deps api`. Restarts **only** `api`, on the already-pulled image; `ai-service`/`postgres`/`redis` untouched.

**Step 2 — verify before starting risky work**: `curl -sf https://<host>/health` must still 200; any other route without the bypass header must 503 with `error.code: "maintenance_mode"`.

**Step 3 — do the work** (e.g. the apply-before-deploy migration this platform's pipeline requires). DB/Redis reachable throughout — this design blocks *routes*, not data access.

**Step 4 — verify before reopening**: `/health` for DB/Redis/storage state, plus one representative route *with* the bypass header.

**Step 5 — close the window**: `export MAINTENANCE_MODE=false`, restart, then run the existing post-deploy verification (`staging-smoke.mjs`/prod canary).

## 7. Rollback

Identical to every other change on this pipeline — redeploy the previous immutable `sha-<short7>` image (per `docker-compose.staging.yml`'s comments, though — per §1.4 — the document that's supposed to spell this out doesn't currently exist and should be recreated regardless). Because `MAINTENANCE_MODE` is a plain env var with a safe default writing nothing to any datastore, rolling back **never requires a data migration** — structural, not procedural.

## 8. What this design deliberately does not do

- **No Redis-backed, zero-restart live toggle.** Considered and rejected for Phase 1: no precedent in this repo (every gate is env+restart), and it introduces a new question — which way should the check fail if Redis itself is under maintenance? The "no rebuild required if possible" requirement is fully satisfied by the restart-only mechanism already proven throughout this repo. A no-restart Phase 2 is a clearly separable future decision.
- **Does not gate `apps/ai-service`.** Once `apps/api` is in maintenance mode it never calls out, so ai-service's own loopback-only `/health` stays irrelevant to this design by construction. Taking the AI legs down independently is already served by `AI_ENABLE_REAL_CALLS`/`AI_REAL_CALLS_KILL_SWITCH` — a different lever for a different purpose (spend/privacy, not availability).
- **Does not design anything for `apps/web`/`apps/payer-web`/`apps/admin-web`'s hosting.** Batch 1 found no evidenced deployment path for any of the three. What *is* named here is the wire contract those apps (and the two Flutter apps) need to branch on once their hosting is known — building that branch is Frontend Platform's/Mobile Product's work.
- **Does not touch RBAC or add a portal enable-toggle.** The only portal-side change suggested is additive and read-only: one more row in `AdminKillSwitchService.buildStatus()`'s `switches` array — keeping the repo's three-times-proven "no real operational switch is ever a portal button" discipline intact.

## 9. Handoffs to other owners

| Owner | What they need to do |
|---|---|
| Frontend Platform | Each Next.js app's HTTP client needs to recognize `error.code === "maintenance_mode"` on a 503 and render a shared banner instead of the generic error path |
| Mobile Product | Both Flutter apps' interceptors need the same branch for a "back soon" screen |
| Backend Platform | Any migration a window exists to protect is still authored by Backend Platform — this design only sequences/applies it |
| Security gate bench | `MAINTENANCE_BYPASS_TOKEN` is a new secret-class value — route through the same provisioning/rotation discipline as `INTERNAL_SERVICE_TOKEN`/`AI_INTERNAL_TOKEN` before ever setting on a real box |
| Human sign-off (owner) | Whether `docs/ops/*`/`docs/rollback-guide.md` get recreated as part of this or as a separate pre-existing-gap ticket is a scoping call, not decided here |

## 10. New artifacts this design would introduce (not yet created)

`packages/config/src/server.ts` (+3 schema entries); `apps/api/src/common/middleware/maintenance-mode.middleware.ts` + `.test.ts` (unit: pass-through when off, exact-envelope 503 when on, `/health` unaffected, bypass accept/reject incl. `timingSafeEqual` path); `apps/api/src/app.module.ts` (+1 registration line); `apps/api/src/health/{health.service,health.controller}.ts` (+1 informational field); `apps/api/src/admin/admin-kill-switch.service.ts` (+1 additive read-only row); `docker-compose.yml`+`docker-compose.staging.yml` (+3 substitution-form lines each); `apps/api/src/config/maintenance-mode-compose.guard.test.ts`; `docs/ops/maintenance-mode-runbook.md`.

---

**Key evidence paths**: `infra/docker/proxy-harness/nginx.conf`, `docker-compose{,.staging}.yml`, `apps/api/src/common/middleware/{security-headers,request-id}.middleware.ts`, `apps/api/src/app.module.ts`, `apps/api/src/config/config.module.ts`, `apps/api/src/health/health.controller.ts`, `apps/api/src/admin/admin-kill-switch.{service,controller}.ts`, `packages/config/src/{server,shared}.ts`, `apps/api/src/common/filters/all-exceptions.filter.ts`, `apps/api/src/common/testing/compose-env.ts`, the four existing `*-compose.guard.test.ts` files, `.github/workflows/ci.yml` (`deploy-lightsail` job), `infra/monitoring/README.md`, and the confirmed-missing `docs/rollback-guide.md`/`docs/ops/*` tree.
