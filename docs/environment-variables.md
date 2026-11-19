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
client bundle by Next.js's own build behavior, but nothing stops a developer from _reading_ a
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

| Assertion                   | What it refuses                                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assertPiiCryptoConfig`     | Dev-default `PII_HASH_PEPPER`/`PII_ENCRYPTION_KEY`, or a malformed/half-set TD22-1 keyring pair, outside development/test — see `docs/pii-key-rotation-runbook.md`                            |
| `assertAuthConfig`          | Dev-default `JWT_SECRET`, missing/half-set Fast2SMS credentials (worker OTP is real-only — no mock exists), or an unsafe `TEST_LOGIN_ENABLED` configuration, outside development/test/staging |
| `assertPaymentsConfig`      | `PAYMENTS_ENABLE_REAL=true` with any of `PAYMENTS_PROVIDER_KEY` / `PAYMENTS_PROVIDER_SECRET` / `RAZORPAY_WEBHOOK_SECRET` unset or blank (ADR-0010 F-6)                                        |
| `assertMessagingConfig`     | `MESSAGING_ENABLE_REAL=true` without WhatsApp Cloud API credentials (ADR-0020)                                                                                                                |
| `assertPushConfig`          | `PUSH_ENABLE_REAL=true` without an FCM credential (ADR-0034)                                                                                                                                  |
| `assertPayerAuthConfig`     | A half-configured payer login method, or a dev-default JWT under the same rule as `assertAuthConfig` (ADR-0019 B)                                                                             |
| `assertMemberInvitesConfig` | `MEMBER_INVITES_ENABLE_REAL=true` without real email credentials / `MEMBER_INVITE_ACCEPT_URL` (ADR-0027 B5.4)                                                                                 |
| `assertAdminAuthConfig`     | A dev/shared `ADMIN_JWT_SECRET` (must differ from `JWT_SECRET` — principal separation), or half-set MFA/TOTP, outside development/test (ADR-0025 ADMIN-1)                                     |

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
  `PAYER_LOGIN_METHOD` (`email_otp` | `whatsapp` | `supabase`) is env-driven in both compose
  files and never a literal (#2122): `${PAYER_LOGIN_METHOD:-email_otp}` on `api` in
  `docker-compose.yml` and `docker-compose.staging.yml`. `whatsapp` is the ADR-0020 **mock**
  channel and delivers nothing, so it is never a default. On the box it is bridged from the
  GitHub `production` environment secret of the same name (`ci.yml` `env:` + `envs:`); **absent =
  `email_otp`**. `email_otp` with `EMAIL_PROVIDER` unset or `zeptomail` requires the
  `production` secrets `ZEPTOMAIL_API_URL`, `ZEPTOMAIL_API_TOKEN`, `ZEPTOMAIL_MAIL_AGENT` and
  `EMAIL_FROM_ADDRESS` (all bridged): `assertPayerAuthConfig` fails the api closed at boot
  without the last three, and no send leaves the box without the URL. `scripts/deploy/staging-deploy.sh`
  refuses, before a container moves, both an unknown method and `email_otp` with any of the four
  empty (names only in the error). Locally, the base compose `api` carries dummy ZeptoMail values
  so it boots; with no `ZEPTOMAIL_API_URL` it sends nothing (use `mailpit` for a readable code).
- **Rollout switches (#2746)** — `JOB_AUDIENCE_ROLLOUT` (job audience, RVM targeting and the
  placement team's review) and `CAMPUS_DRIVE_REQUESTS_ROLLOUT` (campus-drive requests), each
  `off` | `pilot` | `on`. `off` (the default, and what an empty value reads as) is today's product:
  the new payer fields are ignored and the new routes answer 404. A switch gates capabilities only:
  stored audience and review state are honoured whatever it says, so `off` is a safe rollback and
  never exposes an RVM-only job to BadaBhai workers. `pilot` opens the feature only to
  the companies listed for it in `feature_pilot_payers` (keyed by the tenant key; rows are added
  by the owner with `added_by` and `reason`). The tenant key is the company's anchor only with
  `PAYER_ORG_TENANCY_MODE=on`; in `off` / `shadow` it is the login, so list every login that should
  see the pilot (those per-login rows stop matching a team member once tenancy goes `on`, and the
  org-tenancy census C5 counts them). `on` opens it to everyone. Their one reader is
  `apps/api/src/feature-rollout/feature-rollout.service.ts` (a static test pins it), and a
  pilot-list read error answers "not enabled". Declared on the `api` service only, as
  `${NAME:-off}` in `docker-compose.staging.yml`, and bridged from the GitHub `production` secrets
  of the same names (`ci.yml` `env:` + `envs:`); **absent = `off`**.
  `scripts/deploy/staging-deploy.sh` accepts exactly `off`, `pilot`, `on` and empty, and refuses
  anything else before a container moves. Arm: `gh secret set JOB_AUDIENCE_ROLLOUT --env
  production --body pilot`, then redeploy.
- **Theme switch (#2820)** — `THEME_ROLLOUT` (`off` | `pilot` | `on`): who may use a theme other
  than the app's default (Light) in every BadaBhai app, for every kind of login. Same grammar,
  wiring and preflight as the two switches above (`${THEME_ROLLOUT:-off}` on the `api` service
  only, bridged from the `production` secret of the same name; **absent = `off`**). Its one
  question is `FeatureRolloutService.isThemeOpenFor(caller)`, where the caller is built from what
  the auth guard attached (the worker, the company's tenant scope, the admin), never from a body or
  a path; it never throws. A company login's display preference (#2819) asks
  `isThemeOpenForPayer` instead, with the tenancy resolve lazy: `off` and `on` answer without
  reading memberships, and only `pilot` resolves the tenant key.
  - `off` (the default, and what an empty value reads as): nobody. Every display-preference GET
    (#2819) answers `light` with `theme_open: false` whatever is stored, and every PATCH answers
    404 and writes nothing. A stored choice is kept for when the person is piloted again.
  - `pilot`: a company listed for feature `theme` in `feature_pilot_payers` (by tenant key, as
    above: with `PAYER_ORG_TENANCY_MODE=on` a team member inherits the company's place; in `off` /
    `shadow` list each login), and a worker or an admin listed in `feature_pilot_subjects`
    (migration 0164; `subject_kind` `worker` is a `workers.id`, `admin` an `admin_users.id`).
    Everyone else gets `false`. A failed list read, or a database without 0164, answers `false`
    and logs `sqlstate=` and ids only; never a 500.
  - `on`: everyone; no list is read.
  - Both open states also need migration 0165 (`display_prefs`, #2819), where the choices are
    stored. Open on a database without it, the login's GET answers `light` / `theme_open: false`
    and its PATCH 404 (`sqlstate=42P01` and ids in the log); never a 500. The routes are in
    `docs/api/display-prefs-api-reference.md`.

  **Adding a pilot company, worker or admin** is an owner step in the release flow, like a
  migration apply (`MIGRATIONS.md`): after 0164 and 0165 are applied, with the ids agreed in the pilot issue
  (#2818), in one transaction. `added_by` is an id or a fixed token such as `owner_sql`; `reason`
  says why, never who (a worker's row outlives his account: the table has no foreign key).

  ```sql
  BEGIN;
  INSERT INTO feature_pilot_payers (feature, payer_id, added_by, reason)
    VALUES ('theme', '<tenant key: the company anchor payers.id>', 'owner_sql', '#2818 theme pilot');
  INSERT INTO feature_pilot_subjects (feature, subject_kind, subject_id, added_by, reason)
    VALUES ('theme', 'worker', '<workers.id>', 'owner_sql', '#2818 theme pilot, worker app'),
           ('theme', 'admin', '<admin_users.id>', 'owner_sql', '#2818 theme pilot, admin-web');
  COMMIT;
  ```

  The list is read on every request, so a row added or removed (`DELETE FROM
  feature_pilot_subjects WHERE feature = 'theme' AND subject_kind = 'worker' AND subject_id =
  '<id>'`) counts from the next request. Arm: `gh secret set THEME_ROLLOUT --env production
  --body pilot`, then redeploy. **Rollback** is closing the switch: `gh secret set THEME_ROLLOUT
  --env production --body off`, then redeploy (no code change, no migration); every GET answers
  `light` from the first request on the new container, and the pilot rows can stay.
- **Payer org tenancy** — `PAYER_ORG_TENANCY_MODE` (`off` | `shadow` | `on`; ADR-0053,
  PAY-DB-01). `off` (the default, and what an empty value reads as) keys every payer read to the
  login, the pre-ADR behaviour; `shadow` serves `off` and logs what `on` would decide
  (`payer tenancy shadow: actor=… would_key=… would_differ=… outcome=… ms=…`, ids only); `on`
  keys a team member to their org's founder (`payer_orgs.root_payer_id`). Its one reader is
  `apps/api/src/payers/payer-tenant-scope.service.ts` (a static test pins it). Declared on the
  `api` service only, as `${PAYER_ORG_TENANCY_MODE:-off}` in `docker-compose.staging.yml`, and
  bridged from the GitHub `production` secret of the same name (`ci.yml` `env:` + `envs:`);
  **absent = `off`**. `scripts/deploy/staging-deploy.sh` accepts exactly `off`, `shadow`, `on`
  and empty, and refuses any other value (e.g. `ON`, `true`) before a container moves, because
  the api's config would refuse to boot. Until PAY-DB-01 Phase 3 it also refused `on` (risk R66,
  **closed by the P3 PR**: every tenant predicate is converted, so `on` switches the whole payer
  surface at once). The CI `e2e` job runs `on`. Arming `shadow` and then `on` in production is
  owner decision O-8, after the `db:audit:org-tenancy` census (the runbook is
  `docs/payer-agent/ORG_TENANCY_PLAN.md` §5).
- **PIN unlock** — `PIN_PEPPER` (ADR-0026 Phase 3).
- **Admin auth** — `ADMIN_JWT_SECRET` (ADR-0025, must differ from `JWT_SECRET`).
- **AI routing** — `GEMINI_FLASH_API_KEY`, `AI_ENABLE_REAL_CALLS` (master kill-switch, default
  `false`), `AI_REAL_CALL_TASKS` (per-task allowlist — **empty means NO task may go real**,
  fail-closed, owner-ruled 2026-08-01 after the inverse reading was found in an earlier version
  of this same template), `ANTHROPIC_API_KEY` (optional fallback), `SARVAM_*` (STT/TTS),
  `AI_INTERNAL_TOKEN` (TD67 service bearer — unset keeps the historical internal-only open
  posture; see `docs/audit/24_RISK_REGISTER.md` R40).
- **Loud AI alerts (B13, #2567)** — `AI_FALLBACK_ALERT_WINDOW_HOURS` (24),
  `AI_FALLBACK_ALERT_MIN_CALLS` (10), `AI_FALLBACK_ALERT_SHARE` (0.5): a task breaches
  when it records at least the minimum `ai.cost_recorded` rows inside the trailing window
  and its fallback share (`real_call=false` / total) reaches the share. The breach raises
  `ai.fallback_alert_raised` and clears with `ai.fallback_alert_cleared`; spend caps
  already alert as `ai.spend_cap_exceeded`. Surfaced per task on `GET /health`
  (informational, never gates) and `GET /admin/ai-alerts` (active + recent).
  `AI_ALERT_EMAIL_ENABLED` (default off) + `AI_ALERT_EMAIL_TO` (comma-separated) send the
  raise to super admins through the ADR-0038 email pipeline; off keeps the signal on the
  spine + admin API only. Empty values read as absent (defaults hold), never a boot
  failure.
- **A typed tenure on the trade form (token-audit fix Q10, decision D9)** —
  `FORM_TYPED_TENURE_DERIVE_ENABLED` (api, environment secret; default `false`, today's form).
  `true` reads the years out of a worker's TYPED answer to the pack's tenure question ("10 saal
  ho gaye") at read time and uses them to resolve the experience gates, so a veteran is not shown
  fresher questions. Never stored; the question stays on screen; an ambiguous answer (two figures,
  a negated one, none, or outside 0–60) derives nothing.
- **A trade form's experience band as match months (#2753 item 2)** — `FORM_TENURE_MONTHS_ENABLED`
  (api, environment secret, `booleanFromString`; default `false`, today's derivation and no extra
  query). `true` gives each skill a trade form derived that form's band years as
  `worker_skill.months_bucketed`, through the existing 6-month bucketing (fresher and under one year
  0, 1–3 years 24 months, 3–5 years 48, 5–10 years 84, over 10 years 144), and only where the
  profile's own `total_years` buckets to 0 — a stated tenure is never overridden. A typed tenure
  counts only with `FORM_TYPED_TENURE_DERIVE_ENABLED` on too. Rank input only, never printed on the
  sheet. Bridged like its neighbours (compose `${FORM_TENURE_MONTHS_ENABLED:-false}` on `api`,
  `ci.yml` `env:` + `envs:`, preflighted in `scripts/deploy/staging-deploy.sh`).
  `db:backfill:worker-skills` reads the SAME two names from the operator's own environment and
  prints them; its `--apply` refuses (exit 1, one line naming the variable) unless
  `FORM_TENURE_MONTHS_ENABLED` is set explicitly, and `FORM_TYPED_TENURE_DERIVE_ENABLED` too when the
  first is true, so an operator's shell cannot silently write different months from the live path.
  A dry run assumes false for an unset switch and prints `(assumed: unset)`.
  Arming changes rank inputs for every form worker, so it waits for the owner's `engine_version`
  ruling (ADR-0036), then: the secret `true` plus a redeploy, then from a tree equal to origin/main
  `pnpm --filter @badabhai/db db:backfill:worker-skills --apply` (both switches exported) and
  `pnpm --filter @badabhai/db db:materialize:reach --apply`.
- **Stopping AI calls nobody uses (token-audit fixes, 2026-10-22)** — every one defaults to
  today's behaviour, and each is switched on separately:
  - `AI_REAL_CALL_TASKS_DENY` (ai-service, box only, never bridged; default empty) — tasks
    removed from `AI_REAL_CALL_TASKS`. It can only narrow: a denied task falls to its mock, and
    naming a task the allowlist lacks arms nothing. First use: `resume_generation`, whose
    model-written blurb nothing reads (F1); the résumé text is identical on the mock path.
  - `AI_RESUME_OPTION_MAP_MAX_OUTPUT_TOKENS` (ai-service, box; default `1024`, today's value) —
    the résumé option map's own output budget, split off `AI_EXTRACTION_MAX_OUTPUT_TOKENS`.
    At 1024 a complete trade-pack mapping is cut off and discarded; `2048` is the recommended
    value (F4). Compose restates the default; a bare pass-through would fail boot.
  - `RESUME_OPTION_MAP_REQUIRES_AUTOFILL` (api, environment secret; default `false`) — `true`
    skips the option-map call while `RESUME_AUTOFILL_ENABLED` is off, since autofill is its only
    reader (F4). With autofill on it changes nothing.
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
- **Payments (Razorpay, #2749 part 5b)** — four values, all-or-nothing per `assertPaymentsConfig`
  above:

  | Variable                   | What it is                                                                                                                         | Services           | Unset / empty                 |
  | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------- |
  | `PAYMENTS_ENABLE_REAL`     | The master gate (`booleanFromString`)                                                                                              | `api`, `payer-web` | `false`: today's mock credits |
  | `PAYMENTS_PROVIDER_KEY`    | The Razorpay key ID, `rzp_live_…` (or `rzp_test_…` for the rehearsal). Public by design: the browser gets it on the order response | `api` only         | unset                         |
  | `PAYMENTS_PROVIDER_SECRET` | The Razorpay key secret: signs the order call and verifies the checkout signature                                                  | `api` only         | unset                         |
  | `RAZORPAY_WEBHOOK_SECRET`  | The webhook signing secret from the Razorpay dashboard (a different secret from the key secret)                                    | `api` only         | unset                         |

  **How they are supplied.** In production, only as GitHub **`production`-environment secrets**,
  set by Prakash with `gh secret set NAME --env production` (the value typed at the prompt, never
  on the command line, in chat or in an issue). `ci.yml`'s deploy job bridges all four (`env:` +
  the appleboy `envs:` list) into `docker-compose.staging.yml`: `${PAYMENTS_ENABLE_REAL:-false}` on
  `api` and `payer-web`, `${NAME:-}` for the three on `api` only. A box-level export no longer
  survives a deploy. Actions masks every `${{ secrets.* }}` value in the job log, and nothing in
  the deploy echoes one.

  **Empty means unset.** The three Razorpay fields are `optionalSecret(z.string().min(1))`: an
  unset secret arrives as `""` and reads as unset, so the api boots as today. A non-empty value is
  kept as given. With `PAYMENTS_ENABLE_REAL` false the three are inert (the api reads them only
  through `getRazorpayCredentials`, which answers null). With it true, an empty or whitespace-only
  value still counts as missing and the api refuses to boot, naming it.

  **The deploy preflight** (`scripts/deploy/staging-deploy.sh`, before any prune, pull or
  recreate; it prints names, never values, and ends "Nothing was deployed"):
  - `PAYMENTS_ENABLE_REAL` is in the bridged-boolean list (`true`/`false`/`1`/`0`/empty), and `1`
    is refused on top: the api reads `1` as on, but payer-web reads only a literal `true`.
  - `PAYMENTS_ENABLE_REAL=true` with any of the three empty: refused, naming each missing one.
  - `PAYMENTS_ENABLE_REAL=true` while `RETIRED_PRODUCTS_OFF_SALE` is not `true`/`1`: refused
    (ADR-0065 hardening 7: the dropped products have no real-payments path, so they go off sale no
    later than real money).
  - `PAYMENTS_PROVIDER_KEY` set but not the key ID alone, `rzp_test_` or `rzp_live_` followed by
    letters and digits only (most likely the key secret pasted into the key slot, or a
    `key-id:key-secret` pair): refused when
    `PAYMENTS_ENABLE_REAL` is `true`; otherwise a `::warning::` naming the variable, and the deploy
    goes on (nothing reads the key yet, but arming will be refused until it is fixed).
  - Armed with a `rzp_test_` key: a `::warning::`, no refusal. `rzp_live_` is what production
    expects; `rzp_test_` is for the test-key rehearsal only.

  Unset in production today, so deploying the bridge changes nothing. The switch-on order is
  `docs/runbooks/2749-switch-on.md`.

- **Managed Hiring rollout (#2751 items 4 to 13)** — `MANAGED_HIRING_ROLLOUT` (`off` | `pilot` |
  `on`, key `managed_hiring`): may this company see, buy and follow a Managed Hiring order? Same
  grammar, wiring and preflight as the rollout switches above (`${MANAGED_HIRING_ROLLOUT:-off}` on
  the `api` service only, bridged from the `production` secret of the same name; **absent =
  `off`**). Off for a company: every `/payer/managed-hiring/*` route answers the neutral 404 and a
  worker on a tracker costs what the cost rule says without it. Off everywhere: the
  `/admin/managed-hiring/*` routes answer 404 and the sweep idles. The company routes also need
  `PAYMENTS_ENABLE_REAL` live (on the mock path the product is not offered at all). The tracker's
  free contact also needs `CREDIT_RULES_ROLLOUT` on for the company (it is a row of the cost rule).
  Settling an order already paid is never gated. Needs the `managed_hiring` migration applied
  first. Runbook: `docs/runbooks/2751-managed-hiring-switch-on.md`.
- **Posting choice rollout (#2751 items 1 to 3)** — `POSTING_CHOICE_ROLLOUT` (`off` | `pilot` |
  `on`, key `posting_choice`). Same grammar and wiring; its `ci.yml` bridge was added with Managed
  Hiring (before it, the production secret could not reach the container).

- **Credit checkout rollout (#2749 item 10, ADR-0065)** — `CREDIT_CHECKOUT_ROLLOUT` (`off` |
  `pilot` | `on`, key `credit_checkout`): do the new money rules apply to this company? Same
  grammar, wiring and preflight as the rollout switches above (`${CREDIT_CHECKOUT_ROLLOUT:-off}` on
  the `api` service only, bridged from the `production` secret of the same name; **absent =
  `off`**). Asked only by `UnlockService` through `FeatureRolloutService.stateForPayer`, which is
  lazy: `off` and `on` answer without resolving the tenant or reading the list; `pilot` resolves
  the session (or path) payer's tenant key and reads `feature_pilot_payers` for
  `credit_checkout`. What it gates (with `PAYMENTS_ENABLE_REAL` = live payments, as
  `areRealPaymentsEnabled`):
  - `POST /payer/credits/order` (a new real order): open only when payments are live AND the
    rules apply to the company; otherwise the route's neutral 404.
  - `POST /payer/credits/verify`: gated on payments being live only, NOT on this switch (it
    creates no order; the signature and the order's tenant bind it), so a paid order still
    settles after a rollback. It settles only a payment Razorpay reports `captured`.
  - `POST /payer/credits` (free mock packs): open only when payments are NOT live AND the rules do
    NOT apply to the company; otherwise the same 404 (hardening 1).
  - `POST /payers/:payerId/credits` (ops grant, InternalServiceGuard): a 409
    `reason: real_payments_live` for every company while payments are live; otherwise a 409
    `reason: credit_checkout_rollout` for a company the rules apply to; everyone else as before
    (hardening 2).
  - `GET /payer/credits` carries `checkout` (`real` | `free` | `none`) from the same gates, for
    the front ends.
  - A pilot list that cannot be read closes the order and the free packs, and the ops grant
    answers 503 (409 while payments are live).
  - Not gated by this switch: the Razorpay webhook (its guard needs `RAZORPAY_WEBHOOK_SECRET`, so
    it answers 401 to every delivery while payments are not live), the signup free-tier grant,
    the admin grant, stored lots and orders, and the ledger.

  `off` is today's routes exactly, with no extra read. Rollback is this switch back to `off` with
  `PAYMENTS_ENABLE_REAL` LEFT ON (new orders stop, paid ones still settle); turning real payments
  off strands any payment still in flight. The switch-on order and the rollback are
  `docs/runbooks/2749-switch-on.md`.
- **Dropped products (#2749 item 11, ADR-0065)** — `RETIRED_PRODUCTS_OFF_SALE`, api only
  (`booleanFromString`, default `false` = still on sale). `true` takes posting plans, boosts (the
  retired `all_candidates` tier included), hiring capacity and quota top-ups off sale, and with them
  every offer and coupon: they leave `GET /payer/pricing/catalog` (`products` and `prices`), and
  every purchase route for them (`POST /payer/job-postings/:id/plan|boost|quota-topup`,
  `POST /payer/capacity`, the ops `POST /job-postings/:id/plan|boost`) answers a bare 404. Credit
  packs are unaffected; what was already bought stays readable and runs to its end date. One reader
  (`apps/api/src/pricing/retired-products.ts`). Bridged through the GitHub `production` secret of
  the same name (compose `${RETIRED_PRODUCTS_OFF_SALE:-false}` on `api`, `ci.yml` `env:` + `envs:`,
  preflighted in `scripts/deploy/staging-deploy.sh`'s bridged-boolean list). It must be `true` **no
  later than** real payments (hardening 7). Values lowercase `true`/`false`/`1`/`0`/empty only.
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
  the compose default (#1843), so widening means appending to that list on the box. The
  profiling-stage free chat's three tasks (`profiling_free_classify`, `profiling_free_reply`,
  ADR-0051, and Release 2's rolling summary `profiling_free_summary`, §8) are appended the same
  way; see its kill-switch entry below. So is its live news answer, `profiling_free_news`
  (ADR-0054: Claude + the web search tool, billed per search), appended only after the app
  release that renders the news tiles (R7); unarmed, it returns its mock and workers keep the
  "coming soon" news line. The profiling turn's understanding, `profiling_turn_understand`
  (ADR-0057, #2309: one call per typed profiling-chat message), is appended the same way, and
  only after its eval records a PASS (`python -m app.profiling.eval_understand_cli`, evidence
  under `docs/qa/evidence/turn-understanding/`); unarmed, it returns its mock, which the API reads
  as unavailable and runs today's interview unchanged.
- **The general road (ADR-0045)** — `CHAT_GENERAL_ROAD_ENABLED` (default off; off is the interview
  as it was for every worker). On, a chat worker whose role is outside the 21 predefined roles gets
  role → skills and then the offline general form. Needs `CHAT_LLM_INTERVIEW_ENABLED`. Stamped per
  session, so a flip reaches new sessions only. Bridged to staging/production through the GitHub
  secret of the same name; production ON only after the app release with the card and the form.
- **Off-topic chat and the profile (token-audit fix Q2)** — `PROFILE_EXTRACT_SKIP_CHAT_TURNS_ENABLED`
  and `CHAT_SIDE_MESSAGE_CITY_GUARD_ENABLED` (both default off; off is today's interview and
  extraction exactly). Both act only on a message the turn understanding (next entry, which must be
  on) read as CHAT ONLY: intent `chat` above the confidence floor, with no fill, no edit, no
  Profile-page mention and no "none" answer. With the first on, such a message — on a turn that
  wrote nothing — is flagged `chat_only` in the transcript (`chat_messages.metadata`), and the
  end-of-interview extraction (Phase C, the parse and the legacy re-parse) leaves it out, with the
  reply when that reply only served the same pack question again. "Gurgaon mein koi company hai jo
  38 de de?" then stops becoming a preferred city and a salary. A message where the layer heard a
  Profile-page fact is still read (owner ruling #1505-2). The switch is read again at every
  extraction, so turning it off gives later extractions the whole transcript. With the second on,
  the cross-question fill takes no current city from such a message ("bhai Pune mein kitna milta
  hai?"); a message that states his city still fills it. Bridged through the GitHub secrets of the
  same names; switch-on needs the owner's reading of #1505-2 (decision D8).
- **The profiling turn, understood (ADR-0057, #2311)** — `CHAT_TURN_UNDERSTANDING_ENABLED` (default
  off; off is the interview exactly as before). On, every TYPED profiling-chat message is read by
  `profiling_turn_understand` against the session's whole schema: a value the worker volunteers
  fills the empty field it belongs to (never overwrites one), a filled question is never asked
  again, a side message over a pack question gets a short model line instead of the free chat's
  fixed deflection (ADR-0051 R6 amended), and a Profile-page fact gets a pointer line. Any model
  failure runs that turn exactly as today. Read per turn. Bridged through the GitHub secret of the
  same name; production ON only after the eval PASS and the box arming the task (#2319).
- **The form offer before the model (token-audit fix F3)** — `CHAT_TRADE_OFFER_BEFORE_MODEL_ENABLED`
  (default off; off is today's interview). On, a TAPPED "Haan" to the trade-confirm gate routes to
  the trade-form offer without calling the model, whose reply on that turn is discarded today. A
  typed yes with more in it, an open experience gate, or a trade with no form still calls the
  model exactly as today. Visible effect: a worker who declines the offer returns to the AI-led
  chat. Bridged through the GitHub secret of the same name.
- **The identity intake (ADR-0048, #1858)** — `CHAT_IDENTITY_INTAKE_ENABLED` (default off; off is
  `POST /chat/session` and `POST /chat/message` exactly as before). On, a NEW chat session for a
  worker whose record lacks a name, a state or a city opens by asking for what is missing (first
  name, surname, state, city) as deterministic chat turns, written through `WorkersService`; a
  worker with nothing missing is never asked. Only clients that send `confirm_first: true` are
  served it. Bridged through the GitHub `production` environment secret of the same name (compose
  `${CHAT_IDENTITY_INTAKE_ENABLED:-false}`, `ci.yml` `env:` + `envs:`). **It must be on by the
  release that unroutes the app's `/name` screen** — off with `/name` gone captures nobody's name;
  on with `/name` still routed asks only what `/name` left blank. No migration.
- **The profiling-stage free chat's kill switch (ADR-0051, #2027)** — `CHAT_FREE_CHAT_DISABLED`
  (default false, which means the feature is ON: live on merge, owner ruling 2026-10-06). A
  profiling session opens on a greeting ("Shuru karein?"); résumé mode is today's interview,
  locked until the résumé is done; free mode classifies and answers every message per category.
  `true` sends every session straight to today's interview with no greeting and no classifier
  call, byte for byte the pre-ADR-0051 chat. Bridged through the GitHub `production` environment
  secret of the same name (compose `${CHAT_FREE_CHAT_DISABLED:-false}`, `ci.yml` `env:` + `envs:`).
  The four model tasks it calls (`profiling_free_classify`, `profiling_free_reply`,
  Release 2's `profiling_free_summary`, whose unarmed mock stores no summary, and ADR-0054's
  `profiling_free_news`, whose unarmed mock keeps today's "jaldi aayegi" line) are armed
  separately, by appending them to the box's `AI_REAL_CALL_TASKS`. `true` also stops live news
  and drops `news_links` from every response. No migration.
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
  container moves. In CI tests, only the `e2e` job's union step sets it, on a restarted API process that
  runs `tests/e2e/feed-postings-union.e2e.test.ts` alone.
- **Payer applicant pipeline board (owner ruling 2026-10-07)** — `PAYER_APPLICANT_STAGES_ENABLED`,
  api only (`booleanFromString`, default off). Off is today's API byte for byte: the stage route
  `PUT /payer/reach/jobs/:jobId/applicants/:workerId/stage` is a neutral 404, neither applicant
  feed carries `stage`, `GET /payer/reach/applicants?stage=` is a 400, and nothing reads
  `payer_applicant_stages`. On saves the New / Shortlist / Passed board server-side and adds
  `stage` to both feeds plus the inbox filter. **Apply migration 0134 BEFORE turning it on** — on
  without the table, both payer applicant feeds 500. Bridged through the GitHub `production`
  environment secret of the same name (compose `${PAYER_APPLICANT_STAGES_ENABLED:-false}` on `api`,
  `ci.yml` `env:` + `envs:`, preflighted in `scripts/deploy/staging-deploy.sh`). Arming is the
  secret set to `true` plus a redeploy; values lowercase `true`/`false`/`1`/`0`/empty only. Its write
  cap `PAYER_APPLICANT_STAGE_MAX_PER_HOUR` (default 600 per payer per UTC hour, its own Redis
  bucket) runs on its default; neither compose file forwards it.
- **Sign-up age gate (#2541, CEO pack v1 A4 #9, owner rulings 2026-11-04)** — `SIGNUP_AGE_GATE_ENABLED`,
  api only (`booleanFromString`, default off). `POST /consent/accept` takes an additive optional
  `age_18_plus` boolean. An explicit `false` is refused **whatever the flag says**: no consent row
  (a live one from before is withdrawn), `consent.age_declared` with `age_18_plus: false`, then
  403 `AGE_BELOW_MINIMUM`; the app signs the worker out. `true` records consent as before plus `consent.age_declared` naming the
  row. The flag decides only the **missing** answer: off (today) it passes exactly as before; on it
  is a 400 `AGE_CONFIRMATION_REQUIRED` with nothing written. **No migration.** Turn it on only once
  the worker-app release that sends `age_18_plus` is live, otherwise new sign-ups on older builds
  stop at consent. Bridged through the GitHub `production` environment secret of the same name
  (compose `${SIGNUP_AGE_GATE_ENABLED:-false}` on `api`, `ci.yml` `env:` + `envs:`, preflighted in
  `scripts/deploy/staging-deploy.sh`). Arming is the secret set to `true` plus a redeploy; off again
  is `false` plus a redeploy. Values lowercase `true`/`false`/`1`/`0`/empty only.
- **Privacy notice link (#2753 item 13)** — `CONSENT_NOTICE_URL`, api only (`optionalSecret`, an
  https URL). `GET /consent/notice` (worker-authed, `no-store`) serves
  `{ version, employer_contact_versions, notice_url }`: `CURRENT_CONSENT_VERSION`,
  `EMPLOYER_CONTACT_NOTICE_VERSIONS` and this value, or `notice_url: null` while it is unset (the
  default; no link is invented). Not a switch. A plain-http or malformed value refuses boot.
  Bridged through the GitHub `production` environment secret of the same name (compose
  `${CONSENT_NOTICE_URL:-}` on `api`, `ci.yml` `env:` + `envs:`, preflighted in
  `scripts/deploy/staging-deploy.sh`). Setting it is the secret plus a redeploy.
- **"Level needed" applicant sort (engine v1.1, CEO ruling 30 Oct 2026, ADR-0061)** —
  `LEVEL_NEEDED_SORT_ENABLED`, api only (`booleanFromString`, default off). Off is today's
  applicant list exactly: no extra query, the v1.0 ORDER BY, `levelFit: null` on every row. On, a
  company posting in one of the 4 CNC trades (`LEVEL_SORT_TRADE_KINDS`) that names a rung lists
  its applicants meets → level not confirmed → below inside each trade group, from the rung frozen
  on each application. Nobody is hidden; "Any level" posts are unchanged. Migration 0153 is
  APPLY-BEFORE-DEPLOY whatever the flag says (the apply snapshot writes its columns either way).
  Bridged through the GitHub `production` environment secret of the same name (compose
  `${LEVEL_NEEDED_SORT_ENABLED:-false}` on `api`, `ci.yml` `env:` + `envs:`, preflighted in
  `scripts/deploy/staging-deploy.sh`; the bridge shipped in #2613, after #2552). Arming is the
  secret set to `true` plus a redeploy, on the CEO's go-ahead; values lowercase
  `true`/`false`/`1`/`0`/empty only.
- **The helper's name before sign-in (#2753 item 12)** — `REFERRAL_HELPER_NAME_ENABLED`, api
  only (`booleanFromString`, default off). Off, `GET /referrals/helper` is a neutral 404 that
  touches neither the rate limiter nor the database. On, the unauthenticated route answers
  `{ "display_name": … }`: the agency's company name for a live agency code, `null` for every
  other code (a worker referrer's, unknown, expired, spent, malformed) with the same 200 body;
  never a worker's name. Capped per address by `REFERRAL_ATTRIBUTE_MAX_PER_IP_PER_HOUR` in its own
  bucket. **Needs the owner's OK before it goes on:** it reverses the no-oracle rule of
  `POST /referrals/attribute` and opens a code-to-name lookup to anyone; the screen's copy ("[Name]
  helped you make this profile. Confirm with the OTP only if the details are yours and you have
  not paid anyone.") waits for a lawyer's check. **No migration.** Contract:
  `docs/api/worker-referrals-api-reference.md`. Bridged through the GitHub `production`
  environment secret of the same name (compose `${REFERRAL_HELPER_NAME_ENABLED:-false}` on `api`,
  `ci.yml` `env:` + `envs:`, preflighted in `scripts/deploy/staging-deploy.sh`). Arming is the
  secret set to `true` plus a redeploy; values lowercase `true`/`false`/`1`/`0`/empty only.
- **The brief's four availability answers (#2753 item 3)** —
  `AVAILABILITY_ANSWERS_V2_ENABLED`, api only (`booleanFromString`, default off). Off is today's
  `GET /workers/me/work-preferences/options` exactly. On, its `availability_status` serves `join_now` / `in_15_days` / `in_30_days` /
  `working_open` ("Can join now", "Can join in 15 days", "Can join in 30 days", "Working, open to a
  better offer") in place of the first four, and clients render what they are served. **The flag
  never narrows a write:** the worker PUT, admin corrections and the chat edit layer accept both
  sets either way, because installed builds keep sending the old keys. Every reader (résumé, admin
  candidate detail, applicant card) labels a stored key of either set in its own words; an old
  answer is never shown in the new words. **No migration** (the answer lives in the `availability`
  json attribute). Turn it on with the app release that renders the served chips. Bridged through
  the GitHub `production` environment secret of the same name (compose
  `${AVAILABILITY_ANSWERS_V2_ENABLED:-false}` on `api`, `ci.yml` `env:` + `envs:`, preflighted in
  `scripts/deploy/staging-deploy.sh`). Arming is the secret set to `true` plus a redeploy; values
  lowercase `true`/`false`/`1`/`0`/empty only.
- **Last active, one definition (#2753 items 4 and 7)** — `WORKER_ACTIVITY_ENABLED`, api only
  (`booleanFromString`, default off). On, every signed-in worker request and every Campus
  application records the worker's IST day in `worker_activity` (migration 0168; fire-and-forget,
  never fails the request), and the one last-active read is the later of that table's newest day
  and the IST day of his newest device sighting: the #2747 pre-pay fact `lastActiveOn`, the agency
  referred-workers `lastActiveOn`, and `notRecentlyActive` on every applicant, inbox and company
  search row. Off is today exactly: nothing reads or writes the table, no row carries
  `notRecentlyActive`, and `lastActiveOn` is the device sighting. The card's activity band, the
  search order and the `worker.active` event never read it. Migration 0168 is
  APPLY-BEFORE-THE-SWITCH: on without the table nothing answers 500 (the writes are lost and the
  reads fall back to the device day, with one warning per process), but every day of activity
  until the apply is lost.
  Bridged through the GitHub `production` environment secret of the same name (compose
  `${WORKER_ACTIVITY_ENABLED:-false}` on `api`, `ci.yml` `env:` + `envs:`, preflighted in
  `scripts/deploy/staging-deploy.sh`). Arming is the secret set to `true` plus a redeploy; values
  lowercase `true`/`false`/`1`/`0`/empty only. `NOT_RECENTLY_ACTIVE_DAYS` (integer, default 90, at
  least 1) is the mark's threshold: more than that many days since the last active day (IST) marks
  him, so day 90 is not marked and day 91 is. Not bridged (like `PAYER_APPLICANT_STAGE_MAX_PER_HOUR`):
  production runs the default until a bridge is added.
- **Leave company search (#2753 item 6)** — `SEARCH_EXIT_ENABLED`, api only (`booleanFromString`,
  default off). Off is today exactly: `GET`/`PUT /workers/me/search-visibility` are the plain 404
  of an unmounted route, the candidate search statement is byte-identical, the unlock path reads
  nothing, and nothing names `worker_search_exits`. On, a worker can leave company search while
  keeping his consent: he is absent from every company's search (its city facet and the admin card
  read too), and only a company he applied to, or one already holding an open contact, can open
  him. Migration 0169 is APPLY-BEFORE-THE-SWITCH, but on without it nothing answers 500: search,
  its city facet, the admin card read and the unlock gate FAIL OPEN (everyone visible, one warning
  per process), and the two worker routes answer 503 until it is applied. Bridged through the GitHub `production` environment secret of the same name
  (compose `${SEARCH_EXIT_ENABLED:-false}` on `api`, `ci.yml` `env:` + `envs:`, preflighted in
  `scripts/deploy/staging-deploy.sh`). Arming is 0169 applied, then the secret set to `true` plus
  a redeploy; values lowercase `true`/`false`/`1`/`0`/empty only.
- **Hire records (#2753 item 9)** — `HIRE_RECORDS_ENABLED`, api only (`booleanFromString`, default
  off). Off is today's API exactly: nothing reads or writes `hires`, a stage move is unchanged, and
  `GET /admin/hires` is a 404. On, a company's real move of an applicant INTO `hired` confirms the
  hire record in the stage transaction (one row per company, worker and posting), a move OUT takes
  back a mark nothing else confirmed (`rejected`), and `GET /admin/hires` lists the records. The
  migration `hires` is APPLY-BEFORE-THE-SWITCH: on without it, a move into or out of `hired` fails
  (42P01) and rolls back. Bridged through the GitHub `production` environment secret of the same
  name (compose `${HIRE_RECORDS_ENABLED:-false}` on `api`, `ci.yml` `env:` + `envs:`, preflighted
  in `scripts/deploy/staging-deploy.sh`); values lowercase `true`/`false`/`1`/`0`/empty only.
- **The pay-on-joining pilot's hire record (#2753 item 11)** — api only, two variables
  (contract: `docs/api/admin-pay-on-joining-api-reference.md`; runbook:
  `docs/ops/pay-on-joining-pilot-runbook.md`).
  - `PAY_ON_JOINING_RECORDS_ENABLED` (`booleanFromString`, default off): off, every
    `/admin/pay-on-joining-hires` route is a neutral 404 for every admin role before any query,
    and nothing reads or writes `pay_on_joining_hires`. **Needs migration 0171 applied first**
    (APPLY BEFORE THE SWITCH, not before the deploy). A record only: no invoice, no payout, no
    eligibility rule. Bridged through the GitHub `production` environment secret of the same name
    (compose `${PAY_ON_JOINING_RECORDS_ENABLED:-false}` on `api`, `ci.yml` `env:` + `envs:`,
    preflighted in `scripts/deploy/staging-deploy.sh`); values lowercase `true`/`false`/`1`/`0`/empty.
  - `POJ_PARTNER_SHARE_PERCENT` (integer 0..100, default **70**, empty reads as the default): the
    partner's share of a hire's fee in whole percent; BadaBhai keeps the rest. COPIED onto each hire
    when it is recorded, so changing it never rewrites a recorded hire; the share in paise is
    `floor(fee * percent / 100)`. Bridged like `CAMPUS_DRIVE_MAX_OPEN_REQUESTS` (compose
    `${POJ_PARTNER_SHARE_PERCENT:-70}`, `ci.yml` `env:` + `envs:`); the deploy preflight refuses
    anything but empty or a whole number 0..100 before a container moves, because a bad value would
    stop the api booting.
- **The company follow-up (#2753 item 10)** — api only, three variables.
  - `UNLOCK_FOLLOWUP_ENABLED` (`booleanFromString`, default off). Off is today's API exactly:
    `GET /payer/unlock-outcomes/due` and `POST /payer/unlocks/:unlockId/outcome` are a neutral 404
    and nothing reads or writes `unlock_outcomes`. On, a company lists its opened contacts due for
    an answer and answers `hired` / `not_hired` / `still_talking` (one row per unlock; a later
    answer replaces the earlier one); a `hired` answer also confirms the hire record when
    `HIRE_RECORDS_ENABLED` is on and the unlock names a posting. The migration `unlock_outcomes` is
    APPLY-BEFORE-THE-SWITCH: on without it, the due list and every answer fail (42P01) and nothing
    is written. Bridged through the GitHub `production` environment secret of the same name
    (compose `${UNLOCK_FOLLOWUP_ENABLED:-false}` on `api`, `ci.yml` `env:` + `envs:`, preflighted in
    `scripts/deploy/staging-deploy.sh`); values lowercase `true`/`false`/`1`/`0`/empty only.
  - `UNLOCK_FOLLOWUP_AFTER_DAYS` (`positiveIntFromString`, default 7, at least 1; empty reads as
    7): how many whole days of 24 hours after the grant a contact is due, and how long a
    `still_talking` answer waits before it is due again. Bridged like
    `CAMPUS_DRIVE_MAX_OPEN_REQUESTS` (compose `${UNLOCK_FOLLOWUP_AFTER_DAYS:-7}`, `ci.yml` `env:` +
    `envs:`); the deploy preflight refuses anything but empty or a whole number 1..999 before a
    container moves, because a bad value would stop the api booting.
  - `PAYER_UNLOCK_OUTCOME_MAX_PER_HOUR` (default 600 per company login per UTC hour, its own Redis
    bucket `payer_unlock_outcome`, fail-closed): the answer route's write cap. Runs on its default;
    neither compose file forwards it.
- **The monthly "still looking?" check (#2753 item 5)** — api only, three variables.
  - `STILL_LOOKING_CHECK_ENABLED` (`booleanFromString`, default off). Off is today's API exactly:
    `GET`/`POST /workers/me/still-looking` are the plain 404 of an unmounted route, the daily
    `still-looking-sweep` tick returns at once, and nothing reads or writes `still_looking_checks`.
    On, the sweep opens one check per active, consented worker with no open check and none opened or
    answered in the last `STILL_LOOKING_EVERY_DAYS`, and emits `worker.still_looking_prompted` (the
    in-app card and an Alerts entry); the worker answers `yes` / `not_now` / `hired`. With
    `SEARCH_EXIT_ENABLED` on as well, `not_now` takes him out of company search (via
    `monthly_check`) and `yes` brings him back; `hired` is stored only (no hire record: the answer
    names no company or posting). The migration `still_looking_checks` is APPLY-BEFORE-THE-SWITCH:
    on without it, both routes answer 503 and the sweep logs one warning per process and opens
    nothing. Bridged through the GitHub `production` environment secret of the same name (compose
    `${STILL_LOOKING_CHECK_ENABLED:-false}` on `api`, `ci.yml` `env:` + `envs:`, preflighted in
    `scripts/deploy/staging-deploy.sh`); values lowercase `true`/`false`/`1`/`0`/empty only.
  - `STILL_LOOKING_PUSH_ENABLED` (`booleanFromString`, default off): the prompt also goes out as a
    push, ONLY while `STILL_LOOKING_CHECK_ENABLED` is on too (the template's `pushRequires`, read by
    `PushService` at delivery, and the sweep enqueues nothing while it is off). **An owner call
    first:** under the ADR-0034 ruling every push is a security alert (ADR-0062 added the
    correction notices); this is a new, NON-security push, so the ruling must be widened before the
    secret is set. As a non-security push it counts against `PUSH_GLOBAL_MAX_SENDS_PER_DAY` and
    respects the worker's own notifications toggle; security pushes stay exempt from both. With it
    off the check still opens and the card and the Alerts entry still show. Bridged like the check
    (compose `${STILL_LOOKING_PUSH_ENABLED:-false}`, `ci.yml` `env:` + `envs:`, preflighted).
  - `STILL_LOOKING_EVERY_DAYS` (integer, default 30, at least 7; empty reads as 30): how often a
    worker is asked, in whole days of 24 hours from his last check (the later of when it opened and
    when he answered it). Bridged like `UNLOCK_FOLLOWUP_AFTER_DAYS` (compose
    `${STILL_LOOKING_EVERY_DAYS:-30}`, `ci.yml` `env:` + `envs:`); the deploy preflight refuses
    anything but empty or a whole number 7..999 before a container moves, because a bad value would
    stop the api booting.
- **The bulk student move (#2887)** — api only.
  - `STUDENT_MOVE_ENABLED` (`booleanFromString`, default off). Off: the company-search, open-gate
    and pre-pay statements are byte-identical to before, a worker's own edit writes no field
    marker, and every `/admin/students/*` route is a neutral 404. On: a moved student whose
    visibility is off is kept from companies by #2752's rules; once an admin turns it on he is an
    ordinary worker. (`job_reach` is not switched — reach depends on no switch, #2746 M2: a hidden
    moved student is out of reach whenever the `student_visibility` table exists) (contract: `docs/api/admin-student-move-api-reference.md`). Needs the
    `student_move` migration, APPLY BEFORE THE SWITCH (on without it: the routes answer 503 and
    the hot reads fall back to their off text). Bridged through the GitHub `production`
    environment secret of the same name (compose `${STUDENT_MOVE_ENABLED:-false}` on `api`,
    `ci.yml` `env:` + `envs:`, preflighted in `scripts/deploy/staging-deploy.sh`); values
    lowercase `true`/`false`/`1`/`0`/empty only.
- **The numbers screen (#2755)** — api only, two variables (contract:
  `docs/api/admin-numbers-api-reference.md`).
  - `ADMIN_NUMBERS_ENABLED` (`booleanFromString`, default off). Off is today exactly: every
    `/admin/numbers/*` route (`GET definitions`, `PUT|DELETE test-accounts/:payerId`, `GET weekly`;
    the call list and the launch-test records in later parts) is a neutral 404 for every role,
    before any pipe or query, and the nightly numbers sweep returns at once without a query. On,
    the routes answer to `read_business_numbers` (super_admin, ops_admin) and the sweep keeps
    `numbers_weekly` current (its first run backfills history). The company test marker is
    `payers.is_test_account` (migration 0162); the weekly snapshot needs the `numbers_weekly`
    migration, APPLY BEFORE THE SWITCH (on without it: `GET weekly` answers 503, the sweep logs
    and skips). Bridged through the GitHub `production` environment secret of the same name
    (compose `${ADMIN_NUMBERS_ENABLED:-false}` on `api`, `ci.yml` `env:` + `envs:`, preflighted in
    `scripts/deploy/staging-deploy.sh`); values lowercase `true`/`false`/`1`/`0`/empty only.
  - `ADMIN_AI_TRACE_READ_ENABLED` (`booleanFromString`, default off; #2739). Off is today exactly:
    `GET /admin/ai-traces` and `GET /admin/ai-traces/:id` are a neutral 404 for every role, so the
    admin portal's AI calls tab shows "unavailable". On, `read_ai_traces` (super_admin only) reads
    the list and the per-call detail. Bridged through the GitHub `production` environment secret
    of the same name (compose `${ADMIN_AI_TRACE_READ_ENABLED:-false}` on `api`, `ci.yml` `env:` +
    `envs:`, preflighted in `scripts/deploy/staging-deploy.sh`); values lowercase
    `true`/`false`/`1`/`0`/empty only. Arm it only with the owner's sign-off. The prompt and reply
    text are stored only while the ai-service's `AI_CALL_TRACE_TEXT_ENABLED` is on, which the box
    does not declare, so until then each call's detail shows its metadata with no text.
  - `NUMBERS_FREEZE_AFTER_DAYS` (`positiveIntFromString`, default 3, at least 1; empty reads as
    the default): how many whole days after a week ends (Sunday 23:59:59 India time) the sweep
    freezes it. A frozen week is never recomputed by the sweep; only the logged recompute tool
    (`recompute-numbers.cli.ts`) changes it. Bridged like `UNLOCK_FOLLOWUP_AFTER_DAYS` (compose
    `${NUMBERS_FREEZE_AFTER_DAYS:-3}`, `ci.yml` `env:` + `envs:`); the deploy preflight refuses
    anything but empty or a whole number 1..999 before a container moves, because a bad value
    would stop the api booting.
- **The Campus link (#2752)** — api only, four variables, all read by `CampusServiceGuard` on
  `/internal/campus/v1` (contract: `docs/api/campus-link-v1-api-reference.md`).
  - `CAMPUS_LINK_ENABLED` (`booleanFromString`, default off): off, every Campus route is a neutral
    404 and nothing else runs (no token check, no audit row).
  - `CAMPUS_SERVICE_TOKEN_SHA256S`: the sha256 hex of each token Campus sends in `X-Service-Token`,
    comma-separated, at most two (the live one and its replacement during a rotation). Hashes,
    never the tokens, so the env alone cannot call the API. Empty refuses every token; a malformed
    entry fails boot. Its own credential: Campus never holds `INTERNAL_SERVICE_TOKEN`.
  - `CAMPUS_SERVICE_ALLOWED_IPS`: the Campus server's addresses as `req.ip` sees them, so
    `TRUST_PROXY_HOP_COUNT` must match the proxy in front of the api. Empty refuses every address;
    a refused call logs its address (at most once a minute), which is how the real egress address
    is found at set-up. Outside development a loopback, private or link-local peer is always
    refused, even when listed: behind an untrusted hop it is the proxy's address, not Campus's.
  - `CAMPUS_SERVICE_MAX_PER_MINUTE` (default 600): calls per UTC minute after the token check,
    fail-closed on a Redis outage.
  - `RVM_STUDENT_API_BASE_URL`, `RVM_STUDENT_API_TOKEN` (`optionalSecret`), `RVM_STUDENT_API_TIMEOUT_MS`
    (default 5000): RVM's Student API (Scheduler_Backend#162), read by `RvmStudentApiClient` for
    a linked student's six agreed fields, token in `X-Service-Token`. Unset, every read fails
    closed and no student is linked; a slow or failed read is retryable and creates nothing.
  - `RVM_CONSENT_RECHECK_SECONDS` (default 300, at most 86400): how long a confirmed RVM consent
    stands before a company's open (unlock, reveal, résumé disclosure) of a linked student re-reads
    it. RVM's refusal on that read withdraws the link and erases the copied facts (it never deletes
    a row); an outage refuses the open and ends nothing. Read with the flag off too, because a link
    outlives the flag.
  Declared in compose (`${CAMPUS_LINK_ENABLED:-false}` and `${…:-}` for the others) but NOT yet
  bridged in `ci.yml`: the bridge lands with the pilot, so production stays off until then.
- **Payer all-candidates search cap (ADR-0040 / E2, owner rulings 2026-11-03)** —
  `PAYER_CANDIDATE_SEARCH_MAX_PER_HOUR`, api only (default 120 pages per payer login per UTC hour,
  its own Redis bucket `payer_candidate_search`, fail-closed). Bounds how fast one login can page
  the whole consented pool through `POST /payer/candidates/search` (≤ 50 masked rows a page);
  identity still costs an unlock per worker. Not a flag — the route is always on. Runs on its
  default; neither compose file forwards it.
- **Admin Engine view demo allow-list (owner ruling 2026-10-06, #2014)** —
  `ADMIN_ENGINE_VIEW_ALLOW_PHONES`, api only. The Engine view (`/admin/match/engine/*`) shows
  DEMO WORKERS ONLY: phones in the reserved demo block `+910000026xxx`, plus the handsets listed
  here (comma-separated E.164, `+91` + 10 digits, at most 20). Default empty = the demo block only.
  Bridged through the GitHub `production` environment secret of the same name (compose
  `${ADMIN_ENGINE_VIEW_ALLOW_PHONES:-}`, `ci.yml` `env:` + `envs:`); a malformed value fails the api
  boot, so `scripts/deploy/staging-deploy.sh` refuses it before a container moves.
  **Every entry must be a handset whose owner has consented to demo use, and adding one is an
  owner decision** — the list can admit any `+91` number (risks register R61).
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
- **Reverse proxy** — `TRUST_PROXY_HOP_COUNT` (read in `main.ts`; commented in `.env.example`). A
  hop **count**, never a blanket boolean — a spoofable `X-Forwarded-For` would otherwise let an
  attacker rotate their rate-limit identity. It keys `req.ip`, so it keys every per-IP cap.
  - **Default 0** = the raw socket peer. Behind the box nginx that is one shared bucket for all
    app traffic, and payer-web's container for every portal call.
  - **Production: bridged** from the `production` Environment secret of the same name (#2542):
    `ci.yml` deploy `env:` + `envs:` → box shell → `docker-compose.staging.yml`'s
    `${TRUST_PROXY_HOP_COUNT:-0}` on the api (re-declared there; the base file's line is the dev
    proxy-harness knob). Absent secret = 0 = dormant. `staging-deploy.sh` refuses anything but
    empty/0/1 before a container moves. **The armed value is 1**, set by the owner per
    `docs/ops/visitor-ip-turn-on-runbook.md`. Bridging also means a box `.env` or `export` of this
    name no longer reaches the container — the bridged (possibly empty) value wins.
  - **Why 1 is correct on the box** (owner `nginx -T` + `docker ps`, 2026-11-04): the api host and
    the payer host each have ONE `location /` proxying to `127.0.0.1:3001` / `127.0.0.1:3333` with
    `X-Forwarded-For $proxy_add_x_forwarded_for` (append), `X-Real-IP $remote_addr`,
    `X-Forwarded-Proto $scheme`, `Host $host`; no `real_ip` directives; port 80 is certbot
    redirects only. There is NO admin-web server block (admin-web is `127.0.0.1:3003`,
    tunnel-only), and since 2026-11-18 (#2925, R89) the api host's block ALSO has
    `location = /admin` and `location ^~ /admin/`, both `return 404`, before its `location /`:
    the admin API is not public; admin-web reaches it at `http://api:3001`. A rebuilt box must
    re-add them (backup of the edited file: `/etc/nginx/backup-2925/`). The api and payer-web publish on loopback only (#2542), so nginx is the only
    way in. payer-web forwards the visitor (the last entry nginx appended, public addresses only)
    as its own `X-Forwarded-For`, which the hop-1 api reads as `req.ip`.
  - **Not 2 or more** on this topology: Express would then trust an entry the client wrote. A CDN
    or a second proxy in front of nginx changes the count — re-derive it first
    (`infra/docker/proxy-harness/README.md`).
- **CORS** — `CORS_ALLOWED_ORIGINS` (`resolveCorsOrigins`): permissive in dev, an explicit
  allow-list outside dev, **deny-all if unset** outside dev — fail closed, not fail open.

## Where each environment's real values actually live (never in this file, never in git)

- **Local dev**: copy `.env.example` to `.env` at the repo root (`.gitignore`d). See
  `docs/supabase-workflow.md` / the root `README.md` for the local-dev loop.
- **CI (`ci.yml`'s `e2e` job)**: obviously-fake literal placeholders set directly in the job's
  `env:` block (e.g. `ci-dummy-fast2sms-api-key`) — real enough to satisfy the fail-closed boot
  asserts, never a real credential, never reaching a real provider.
- **Lightsail (`deploy-lightsail`)**: GitHub **Environment** secrets (`environment: production` in
  the job — the Lightsail box IS production), bridged onto the box's shell environment via `appleboy/ssh-action`'s `env:`/`envs:`
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
