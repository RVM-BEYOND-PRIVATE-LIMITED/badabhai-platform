# Environment Variables Reference

**Citation note:** no live code cites a specific procedure "from `docs/environment-variables.md`"
— the only citations of this exact path are `.claude/agents/devops-engineer.md`'s
ownership-mandate list and this repo's audit documents analyzing it
(`docs/audit/16_OBSERVABILITY_AUDIT.md`, `docs/audit/24_RISK_REGISTER.md` R46). This reference is
reconstructed from `.env.example` (the repo's own, already-extensively-commented template — the
real source of truth for every variable's purpose and default) plus the fail-closed boot
assertions in `apps/api/src/main.ts` / `packages/config/src/server.ts`. **`.env.example` is more
current than any snapshot of it here could stay** — this document organizes and cross-references
it; for the exact current default/placeholder of any one variable, read `.env.example` itself.

## The one rule that matters most: the server/public split

`NEXT_PUBLIC_*` is the **only** prefix Next.js ships to the browser bundle. Everything else in
`.env.example` is server-only by construction — a secret without that prefix cannot leak into a
client bundle by Next.js's own build behavior, but nothing stops a developer from *reading* a
server var somewhere that then echoes it client-side, so the discipline still has to be kept by
hand:

- `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_ENVIRONMENT`, `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` are the **entire** public surface today — the anon/publishable
  Supabase key, never the service-role key.
- `INTERNAL_SERVICE_TOKEN` read by `apps/web` is a **server-only** secret — `.env.example`'s own
  comment: "read only in Server Components (`apps/web/src/lib/api.ts` via `process.env`) — it is
  never inlined into the client bundle."
- Any new `NEXT_PUBLIC_*` variable is a **shared decision with DevOps** (per the DevOps-engineer
  role's own collaboration protocol) — Frontend owns the bundle, DevOps owns what's allowed to be
  in it.

## Fail-closed boot assertions (`apps/api/src/main.ts`, in call order)

Every one of these runs **before** `app.listen()` — a violation crashes the boot, it never lets
the process come up half-configured:

| Assertion | What it refuses |
|---|---|
| `assertPiiCryptoConfig` | Dev-default `PII_HASH_PEPPER`/`PII_ENCRYPTION_KEY`, or a malformed/half-set TD22-1 keyring pair, outside development/test — see `docs/pii-key-rotation-runbook.md` |
| `assertAuthConfig` | Dev-default `JWT_SECRET`, missing/half-set Fast2SMS credentials (worker OTP is real-only — no mock exists), or an unsafe `TEST_LOGIN_ENABLED` configuration, outside development/test/staging |
| `assertPaymentsConfig` | `PAYMENTS_ENABLE_REAL=true` with any of `PAYMENTS_PROVIDER_KEY` / `PAYMENTS_PROVIDER_SECRET` / `RAZORPAY_WEBHOOK_SECRET` unset or blank (ADR-0010 F-6) |
| `assertMessagingConfig` | `MESSAGING_ENABLE_REAL=true` without WhatsApp Cloud API credentials (ADR-0020) |
| `assertPushConfig` | `PUSH_ENABLE_REAL=true` without an FCM credential (ADR-0034) |
| `assertPayerAuthConfig` | A half-configured payer login method, or a dev-default JWT under the same rule as `assertAuthConfig` (ADR-0019 B) |
| `assertMemberInvitesConfig` | `MEMBER_INVITES_ENABLE_REAL=true` without real email credentials / `MEMBER_INVITE_ACCEPT_URL` (ADR-0027 B5.4) |
| `assertAdminAuthConfig` | A dev/shared `ADMIN_JWT_SECRET` (must differ from `JWT_SECRET` — principal separation), or half-set MFA/TOTP, outside development/test (ADR-0025 ADMIN-1) |

The common shape across all eight: **a real-provider flag flipped `true` with its credential(s)
missing/blank refuses to boot rather than silently running mocked** — this is the "a gate that
reads an empty-string secret must fail startup, never arm vacuously" rule made concrete
(`TD67`/`AI_INTERNAL_TOKEN` follows the identical rule on the ai-service side — see
`docs/ai/` — but is validated at the Pydantic `Settings()` construction layer instead of a
NestJS boot assertion).

## Categories (see `.env.example` for the authoritative variable list per category)

- **Runtime** — `NODE_ENV`. Governs which fail-closed assertions actually enforce (most refuse
  outside `development`/`test`, some also exempt `staging`).
- **Core datastores** — `DATABASE_URL`, `REDIS_URL`.
- **Supabase (backend-only)** — `SUPABASE_URL` (safe to expose), `SUPABASE_SERVICE_ROLE_KEY`
  (a god-key, backend-only, never `NEXT_PUBLIC_*`), the Storage bucket names
  (`RESUMES_BUCKET`, `INTERVIEW_KIT_BUCKET`, `VOICE_NOTES_BUCKET`, `WORKER_PHOTOS_BUCKET`,
  `WORKER_FEEDBACK_ATTACHMENTS_BUCKET`, `CONVERSATIONS_BUCKET`). An empty bucket var means
  that feature is **dormant by design**, not broken — see `docs/observability-runbook.md` §3 for how `GET /health` distinguishes "dormant"
  from "armed without credentials" (#793).
- **PII protection** — `PII_HASH_PEPPER`, `PII_ENCRYPTION_KEY` (legacy single-key), the TD22-1
  keyring pair. Full rotation procedure: `docs/pii-key-rotation-runbook.md`.
- **Worker auth** — `JWT_SECRET`, `SESSION_TTL_DAYS`, the `OTP_*` shape/lifecycle/rate-limit
  family plus `WORKER_OTP_MAX_SENDS_PER_HOUR` (the worker-only per-phone hourly cap — #1421 split
  it off `OTP_MAX_SENDS_PER_HOUR`, which is now admin + payer only),
  `SMS_PROVIDER`/`FAST2SMS_*` (real-only, no mock). Levers and their blast radius:
  `docs/otp-throttles-runbook.md`.
- **Payer auth** — `PAYER_LOGIN_METHOD`, `EMAIL_PROVIDER`/`ZEPTOMAIL_*`/`SMTP_*` (real-only email
  OTP), `PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY`.
- **PIN unlock** — `PIN_PEPPER` (ADR-0026 Phase 3).
- **Admin auth** — `ADMIN_JWT_SECRET` (ADR-0025, must differ from `JWT_SECRET`).
- **AI routing** — `GEMINI_FLASH_API_KEY`, `AI_ENABLE_REAL_CALLS` (master kill-switch, default
  `false`), `AI_REAL_CALL_TASKS` (per-task allowlist — **empty means NO task may go real**,
  fail-closed, owner-ruled 2026-08-01 after the inverse reading was found in an earlier version
  of this same template), `ANTHROPIC_API_KEY` (optional fallback), `SARVAM_*` (STT/TTS),
  `AI_INTERNAL_TOKEN` (TD67 service bearer — unset keeps the historical internal-only open
  posture; see `docs/audit/24_RISK_REGISTER.md` R40).
- **Model-prompt masking (ADR-0047)** — `AI_RAW_PII_ENABLED`, ONE name read by **both** services:
  the ai-service as `ai_raw_pii_enabled` (`apps/ai-service/app/config.py`) and the api through
  `packages/config/src/server.ts` (`booleanFromString`). **Default `false`, and off masks every
  prompt as before.** On, text reaches model prompts unmasked: every prompt-side ai-service
  call site passes it through `app/llm_input_policy.py` (size caps and the non-string refusal
  kept), the Langfuse `mask=` hook and the `ai_call_traces` text pass it through too, companion v2
  skips its `/pseudonymize` hop (its Redis memory then holds raw text, TTL-bound). The résumé
  import routes read it OR'd with `RESUME_PARSE_RAW_TEXT_ENABLED`, which stays its own flag.
  **It never touches** `pseudonymize()` itself, any output wall (the certifiers, gate 6,
  `contains_hard_identifier`, the placeholder refusals, the hard-identifier floor of ADR-0047 §6
  G1), `redactKnownName` in profile extraction and both interview turns (§6 G2), the at-rest
  masked copies (job-posting draft, growth queue, training corpus), PII encryption at rest,
  employer-side disclosure masking, STT, event schemas or log lines. A GitHub **`production`-environment secret**, bridged by
  `ci.yml`'s deploy job (`env:` + the appleboy `envs:` list) into compose's
  `${AI_RAW_PII_ENABLED:-false}` on the `api` and `ai-service` services. Arming is the secret plus
  a redeploy: `gh secret set AI_RAW_PII_ENABLED --env production --body true` and re-run the
  deploy; roll back by setting it `false` and re-running (companion Redis memory and
  `ai_call_traces` rows written while armed stay behind — ADR-0047 §5). Values:
  `true`/`false`/`1`/`0`/empty, lowercase and exact — both services refuse `True`, `yes` or `on`,
  and the deploy script fails the job on them before a container moves. The owner has set the `production` secret to `true` and
  instructed a direct merge, so the first deploy after the implementing change merges arms it:
  **merging is arming** (ADR-0047 §5, runbook P0 #13).
- **Offline corpus embed throughput** (ADR-0030 / TAX-3, ai-service) — `AI_EMBED_REQUEST_BATCH`
  (texts per provider request, default 100), `AI_EMBED_TEXTS_PER_MINUTE` (pacing; **0 = unpaced,
  the default**), `AI_EMBED_MAX_RETRIES` (default 2), `AI_EMBED_BACKOFF_BASE_SECONDS`,
  `AI_EMBED_BACKOFF_MAX_SECONDS`, `AI_EMBED_RATE_LIMIT_COOLDOWN_SECONDS` (default 60 — a 429
  waits out the rate window rather than backing off inside it), `AI_EMBED_RETRY_ON_READ_TIMEOUT`
  (default `false`: the request was sent and its outcome is unknown, so retrying can pay for the
  same texts twice), `AI_EMBED_MAX_PACING_WAIT_SECONDS`.
  Two provider quotas pull in opposite directions and each has its own control. The per-DAY
  REQUEST quota wants a LARGE batch (100 texts/request puts the 9,121-alias corpus at ~92
  requests; one text per request needs 9,121 and takes ten days). The per-MINUTE TEXT quota
  wants PACING, not a smaller batch — shrinking the batch spends the same text budget across
  more requests, which is strictly worse for the daily quota. Measured on our own Phase 5
  traces: request size does not predict failure (a 100-text request succeeded while a 50-text
  one was refused); what predicts it is how many texts went out in the preceding minute, and
  **refused attempts consume the quota too**. Free-tier operators should set
  `AI_EMBED_TEXTS_PER_MINUTE=90`; leaving it at 0 preserves today's behaviour so a paid tier is
  never throttled to a free-tier number.
- **Payments** — `PAYMENTS_ENABLE_REAL` + the three Razorpay vars, all-or-nothing per
  `assertPaymentsConfig` above.
- **Messaging / push** — `MESSAGING_ENABLE_REAL` (WhatsApp), `PUSH_ENABLE_REAL` (FCM, security
  alerts only in this phase — security pushes are exempt from the numeric daily ceiling).
- **Post-completion chat companion (ADR-0044)** — `CHAT_COMPANION_ENABLED` (default off; off is
  the chat tab as it was), `CHAT_COMPANION_NEW_JOBS_WINDOW_DAYS` (7), `CHAT_COMPANION_NEW_JOBS_COUNT_CAP`
  (20) and `CHAT_COMPANION_JOB_CHIPS` (3). Only the flag is bridged to staging; the knobs run on
  their defaults. Production ON only after ADR-0044 is Accepted.
- **Companion v2 — the LLM task router (ADR-0046)** — **every switch defaults off, and off is v1
  byte-for-byte** (deterministic resolver, zero model calls). Flags:
  `CHAT_COMPANION_V2_ENABLED` (master), `CHAT_COMPANION_V2_EDIT_ENABLED` (P1),
  `CHAT_COMPANION_V2_NEW_RESUME_ENABLED` / `CHAT_COMPANION_V2_FALTU_ENABLED` (P2),
  `CHAT_COMPANION_V2_CAREER_ENABLED` (P3). Knobs: `CHAT_COMPANION_V2_ROUTER_MIN_CONFIDENCE` (0.6,
  0..1; below → `unclear`), `CHAT_COMPANION_V2_EDIT_MAX_ROWS` (3),
  `CHAT_COMPANION_V2_PROPOSAL_TTL_SECONDS` (600), `CHAT_COMPANION_V2_FALTU_STRIKES` (3),
  `CHAT_COMPANION_V2_FALTU_COOLDOWN_MINUTES` (30), `CHAT_COMPANION_V2_MEMORY_TURNS` (6),
  `CHAT_COMPANION_V2_MEMORY_TTL_SECONDS` (1800). The five phase flags are bridged to staging
  through the GitHub environment secrets of the same names (compose `${VAR:-false}`, `ci.yml`
  `env:` + `envs:`); the knobs run on their reviewed defaults and are deliberately NOT bridged.
  Nothing v2 is reachable until both the parent `CHAT_COMPANION_ENABLED` and
  `CHAT_COMPANION_V2_ENABLED` are on, production ON additionally requires ADR-0046's signature
  with companion v1 live, and real model calls need the box to widen the ai-service's
  `AI_REAL_CALL_TASKS` allowlist to name `companion_classify` and `companion_edit_parse` (P1)
  and `companion_career_answer` (P3). The production box sets its own list, which replaces
  the compose default (#1843), so widening means appending to that list on the box.
- **The general road (ADR-0045)** — `CHAT_GENERAL_ROAD_ENABLED` (default off; off is the interview
  as it was for every worker). On, a chat worker whose role is outside the 21 predefined roles gets
  role → skills and then the offline general form. Needs `CHAT_LLM_INTERVIEW_ENABLED`. Stamped per
  session, so a flip reaches new sessions only. Bridged to staging/production through the GitHub
  secret of the same name; production ON only after the app release with the card and the form.
- **The identity intake (ADR-0048, #1858)** — `CHAT_IDENTITY_INTAKE_ENABLED` (default off; off is
  `POST /chat/session` and `POST /chat/message` exactly as before). On, a NEW chat session for a
  worker whose record lacks a name, a state or a city opens by asking for what is missing (first
  name, surname, state, city) as deterministic chat turns, written through `WorkersService`; a
  worker with nothing missing is never asked. Only clients that send `confirm_first: true` are
  served it. Bridged through the GitHub `production` environment secret of the same name (compose
  `${CHAT_IDENTITY_INTAKE_ENABLED:-false}`, `ci.yml` `env:` + `envs:`). **It must be on by the
  release that unroutes the app's `/name` screen** — off with `/name` gone captures nobody's name;
  on with `/name` still routed asks only what `/name` left blank. No migration.
- **Matching V1 cutover gate (ADR-0036 §8, #1904)** — `MATCH_V1_ENABLED`, api only
  (`booleanFromString`, default off). Off is the legacy source for the worker feed, apply and the
  payer candidate list (`jobs` + the weighted engine); on is `job_reach` + `job_postings` + the V1
  rank key. It is the only matching env var: every tunable lives in the `match_config` row.
  Bridged through the GitHub `production` environment secret of the same name (compose
  `${MATCH_V1_ENABLED:-false}` on `api`, `ci.yml` `env:` + `envs:`). **Absent = off**: no secret
  exists today, so the bridge exports an empty value, compose resolves it to `false`, and the
  parser reads `""` as `false` as well. A box-level `export` no longer survives a deploy.
  **Do not create the secret before P1 + P3 of `docs/ops/production-release-runbook.md`** —
  production's `job_reach` and `worker_skill` are empty, so `true` serves every worker an empty
  deck. The flip is that runbook's P4 #12. Arming is the secret set to `true` plus a redeploy; off
  again is the secret set to `false` (or deleted) plus a redeploy. Values: lowercase `true`/`false`/
  `1`/`0`/empty only; anything else would stop the api booting, so `scripts/deploy/staging-deploy.sh`
  refuses any other value before a container moves. In CI only the `e2e` job's Matching V1 journey step
  sets it, on its own API process (port 3002).
- **Interim union feed (ADR-0049, #1823)** — `FEED_POSTINGS_UNION_ENABLED`, api only
  (`booleanFromString`, default off). Off is the legacy worker feed and apply/skip byte for byte
  (`jobs` only). On adds company `job_postings` to the legacy `GET /feed` (newest-first, the legacy
  17-key card) and the posting branch of apply/skip. **Effective only while `MATCH_V1_ENABLED` is
  off**: `isFeedPostingsUnionEnabled` answers false whenever V1 is on, whatever this says. Not
  behind it, live from their merge: the payer posting-applicants list, the ops
  `GET /jobs/:jobId/applicants` read and the unlock job-context fix (#1903). Bridged through the
  GitHub `production` environment secret of the same name (compose
  `${FEED_POSTINGS_UNION_ENABLED:-false}` on `api`, `ci.yml` `env:` + `envs:`). **Absent = off**,
  exactly as for `MATCH_V1_ENABLED`. **Production stays off**: arming is an owner decision, taken
  only after every item of the pre-arm list in `docs/ops/production-release-runbook.md` P4 #13
  holds. Arming is the secret set to `true` plus a redeploy; off again is the secret set to `false`
  plus a redeploy. Values: lowercase `true`/`false`/`1`/`0`/empty only; anything else would stop
  the api booting, so `scripts/deploy/staging-deploy.sh` refuses any other value before a
  container moves. In CI only the `e2e` job's union step sets it, on a restarted API process that
  runs `tests/e2e/feed-postings-union.e2e.test.ts` alone.
- **Chat / profiling** — `CHAT_TRANSCRIPT_TTL_SECONDS`, `CHAT_ABANDON_AFTER_SECONDS`,
  `CHAT_MAX_TURNS` (the authoritative hard cap — the ai-service mirrors it but holds no
  per-session state, so it can only enforce what the API tells it).
- **Résumé import sweep (ADR-0041 §7.1, #1665)** — `RESUME_IMPORT_STALE_AFTER_SECONDS` (1800)
  and `RESUME_IMPORT_SWEEP_INTERVAL_MINUTES` (15). Both run on their defaults; neither compose
  file forwards them. **The threshold is DERIVED from four other numbers** — the three résumé AI
  transport budgets in `apps/api/src/ai/ai.service.ts` and BullMQ's `attempts`/backoff in
  `apps/api/src/queue/queue.module.ts` — and the arithmetic is written beside the value in
  `packages/config/src/server.ts`. **Raising any of those four without raising this one lets the
  sweep settle a failure over a job that is still legitimately working.** Lowering the threshold
  is the dangerous direction; raising it only delays a count.
- **Observability** — `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`/`LANGFUSE_BASE_URL` (tracing
  off unless both keys are set; see `docs/observability-runbook.md` §6).
- **Service URLs / ports** — `API_PORT`, `AI_SERVICE_PORT`, `AI_SERVICE_URL`, `WEB_PORT`.
- **Reverse proxy** — `TRUST_PROXY_HOP_COUNT` (not in `.env.example` as a var but read in
  `main.ts`; a hop **count**, never a blanket boolean — spoofable `X-Forwarded-For` would
  otherwise let an attacker rotate their rate-limit identity. Default 0 = trust nothing, use the
  raw socket peer, until the deploy edge's actual hop count is known).
- **CORS** — `CORS_ALLOWED_ORIGINS` (`resolveCorsOrigins`): permissive in dev, an explicit
  allow-list outside dev, **deny-all if unset** outside dev — fail closed, not fail open.

## Where each environment's real values actually live (never in this file, never in git)

- **Local dev**: copy `.env.example` to `.env` at the repo root (`.gitignore`d). See
  `docs/supabase-workflow.md` / the root `README.md` for the local-dev loop.
- **CI (`ci.yml`'s `e2e` job)**: obviously-fake literal placeholders set directly in the job's
  `env:` block (e.g. `ci-dummy-fast2sms-api-key`) — real enough to satisfy the fail-closed boot
  asserts, never a real credential, never reaching a real provider.
- **Lightsail (`deploy-lightsail`)**: GitHub **Environment** secrets (`environment: staging` in
  the job), bridged onto the box's shell environment via `appleboy/ssh-action`'s `env:`/`envs:`
  pair — GitHub secrets do not reach the box's compose interpolation on their own; this bridge is
  what makes them visible to `docker-compose.staging.yml`'s `${VAR:?}` gates. See
  `docs/rollback-guide.md` and `docs/release-checklist.md` for the exact secret list currently
  bridged.
- **Persistent staging (`staging-cd.yml`)**: the same GitHub `staging` Environment's secrets, read
  directly into the workflow's own `env:` block (a different job, a different consumption path,
  same Environment) — see `docs/ops/staging-service-deploy-runbook.md`.

## What this reference does not cover

The exact current default/placeholder text for any one variable (read `.env.example` — it is
authoritative and this document is not); the ai-service's own Python-side settings
(`apps/ai-service/app/config.py`) beyond the handful cross-referenced above; per-environment
actual values (never documented anywhere, by design — secrets never in git, and never logged:
CLAUDE.md §3).
