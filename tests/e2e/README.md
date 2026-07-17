# E2E Tests

End-to-end Phase 1 flow across the NestJS API + Postgres + Redis:

> login (mock OTP) → consent → chat → profile extract (async) → confirm → resume
> generate — asserting the expected events were emitted and that **no raw PII
> (phone) ever lands in the `events` table**.

`/profile/extract` is **async**: it enqueues a BullMQ job (returns `202` +
`ai_job_id`) and the test polls `GET /ai-jobs/:id` until the job completes, then
reads `output_ref.profile_id`. So **Redis is required** for this flow.

The AI service is **not** required: the API falls back to safe mocks when it is
unreachable, so the flow (and its events) still complete.

## Run it

The suite is **opt-in** (gated on `RUN_E2E=1`) so the normal `pnpm test` /
CI run skips it when no infra is up.

```bash
# 1. Postgres + Redis (local docker) — or set DATABASE_URL to Supabase instead.
#    (Redis is needed because profile extraction runs on a BullMQ queue.)
pnpm db:up           # starts postgres + redis
pnpm db:migrate

# 2. Start the API (separate terminal)
pnpm --filter @badabhai/api dev

# 3. Run the e2e flow
#   bash/zsh:
RUN_E2E=1 pnpm --filter @badabhai/e2e test
#   PowerShell:
$env:RUN_E2E=1; pnpm --filter @badabhai/e2e test
```

> **Windows note:** if the host already runs PostgreSQL on `5432`, the compose
> Postgres is shadowed. Use the `docker-compose.e2e.yml` override (publishes the
> container on `5433`) and point the DB env vars at `5433` — see that file.

## Configuration

| Env var            | Default                                                  | Purpose                          |
| ------------------ | -------------------------------------------------------- | -------------------------------- |
| `RUN_E2E`          | _(unset → skipped)_                                      | Set to `1` to actually run.      |
| `E2E_API_URL`      | `http://localhost:3001`                                  | Base URL of the running API.     |
| `E2E_DATABASE_URL` | `DATABASE_URL` or `postgresql://badabhai:badabhai@localhost:5432/badabhai` | DB to read `events` from. |
| `E2E_CAPACITY_ENFORCED` | _(unset → shadow)_                                  | Capacity e2e (ADR-0016 D5) only. Set to `1` ONLY when the API was started with `CAPACITY_ENFORCEMENT_ENABLED=true`. Gates the enforcement cases (real pauses) vs the default shadow case so they never contradict on one running config. |

## TODO — un-skip the worker suites on the D-3 test-login seam

Five suites are hard-`describe.skip`ped because worker login is REAL-ONLY (Fast2SMS;
the `dev_otp` echo was removed in `d2f228e`) so no test can complete an OTP
round-trip: **phase1-flow, contact-unlock, payer-tenancy, payer-capacity,
swipe-to-apply** (+ `phase1-onboarding`'s `it.skip`).

**The unblocking seam now exists** — `POST /auth/test-login`
([`apps/api/src/auth/auth.controller.ts`](../../apps/api/src/auth/auth.controller.ts),
D-3, owner ruling `docs/registers/team-decisions.md` 2026-07-17 item 9). It returns the
**identical `LoginResponse` shape** as `/auth/otp/verify` (`access_token`, `worker_id`,
`is_new_worker`, `status`, `pin_set`, `refresh_token`, `session`, `consent_accepted`),
so each suite's `login()` helper is a **drop-in swap** — replace the two-call
`otp/request` → `otp/verify` (`dev_otp`) dance with ONE call:

```js
// was: const r1 = await req("POST", "/auth/otp/request", { body: { phone } });
//      const r2 = await req("POST", "/auth/otp/verify", { body: { phone, otp: r1.json.dev_otp } });
const r = await req("POST", "/auth/test-login", {
  headers: { "x-test-login-token": process.env.E2E_TEST_LOGIN_TOKEN },
  body: { phone },
});
return { workerId: r.json.worker_id, token: r.json.access_token, phone };
```

Requires the API started with `TEST_LOGIN_ENABLED=true` + a ≥32-char `TEST_LOGIN_TOKEN`
(`NODE_ENV=development`/`test`/`staging` only — arming it in production is a **boot
failure** by `assertAuthConfig`). Consent is **not** bypassed: the minted session behaves
exactly like an OTP session, so each suite keeps its explicit `POST /consent` step.

> **The `phone` MUST be in the reserved synthetic range `+9100000XXXXX`** (`+91` + five zeros
> + 5 free digits — 100,000 addresses, e.g. `+910000000042`). Anything else gets a neutral
> **404** from the mint chokepoint. Suites currently build random real-looking numbers
> (`+9198…`) — those must be swapped for synthetic ones, and the range is wide enough to keep
> per-test isolation (use a per-test counter/random 5 digits instead of a random mobile).
> The range is unassignable (a real Indian mobile starts 6–9 after `+91`), which is exactly
> why the seam can never mint a session for a real worker.

> The suite rewrites are deliberately **out of scope** for the D-3 seam PR — this note is
> the pointer for the follow-up. `tests/e2e/helpers/payer-session.ts` is a **separate**
> gap: it mints a PAYER session and still assumes a payer `dev_otp` echo; the D-3 seam is
> worker-only and does not unblock it.

> **Capacity enforcement posture (ADR-0016 D5).** The API defaults to
> `CAPACITY_ENFORCEMENT_ENABLED=false` (shadow: over-cap plans stay active). Run
> `payer-capacity.e2e.test.ts` in TWO passes to cover both postures:
> - **Shadow (default):** start the API normally → `RUN_E2E=1 … test` runs the shadow case
>   (over-cap → active, `wouldPause=true`, no pause event); enforcement cases skip.
> - **Enforced:** start the API with `CAPACITY_ENFORCEMENT_ENABLED=true` →
>   `RUN_E2E=1 E2E_CAPACITY_ENFORCED=1 … test` runs the atomicity / pause-at-limit /
>   auto-resume cases (real pauses); the shadow case skips.
> The faceless/no-PII + `capacity.purchased`/`payment.*` cases run in both.
