# Enterprise Readiness — Reliability, Observability, Performance, UX

**Status:** COMPLETE (audited 2026-08-11, dimension re-run after the usage-limit interruption).
**Method:** evidence-based static analysis; every claim carries a `file:line` citation.
**Findings feed** `GAP_REGISTER.md`. Coverage caveats: `AUDIT_STATUS.md`.

---

# Enterprise-Grade Readiness (reliability, observability, performance, scalability, maintainability, UX/presentation, error handling)

## Executive summary
The backend money core is genuinely well engineered — the Razorpay webhook is signature-gated, always-200-on-business-outcome, and settles through one transaction (apps/api/src/unlocks/razorpay-webhook.controller.ts:33-52; unlocks.repository.ts:437-470), and 22 multi-write operations are wrapped in db.transaction. Everything around that core is pre-enterprise. Observability is the largest single gap: 0 of 281 logger call sites in apps/api carry a requestId or correlationId even though RequestIdMiddleware mints both (structured-logger.ts:14-20 vs request-id.middleware.ts:36-39), payer-http.ts never sends or reads x-request-id, and a repo-wide grep for Sentry/OpenTelemetry/prom-client/Datadog returns zero hits — there is no error tracking and no metric of any kind for the payer surface. Reliability: payer-web's HTTP transport has no timeout and no retry, while the sibling admin-web transport in the same repo has both (payer-http.ts:54-59 vs admin-web/src/lib/admin-http.ts:84,105); a transient API error maps every payer to "logged out" (http-provider.ts:130-137). Money paths carry EVENT-level idempotency keys but no REQUEST-level idempotency: POST /payer/credits and POST /payer/job-postings/:id/quota-topup will both charge twice on a retry, a hazard payer-api.ts:1304-1310 documents in its own comment and then works around client-side. Performance has one P0: GET /payer/reach/jobs/:id/applicants reads the ENTIRE worker pool with no LIMIT and writes one feed.shown row per worker per page view (reach.repository.ts:81-101; reach.service.ts:112-140), and one clear P1 N+1 — the "My jobs" list runs 3 queries per posting, up to ~301 per request (payer-job-postings.controller.ts:74-84,106-113). The payer dashboard costs 6 API round-trips per view, two of them exact duplicates, with zero React cache() dedupe and cache:"no-store" everywhere. Scalability is hard-wired to one payer == one org (payer_orgs_root_payer_id_uq + resolveOrgForPayer taking a single newest membership) with no org switcher. Maintainability: 21 HTTP status-code decisions in payer-api.ts are made by regex-matching an error MESSAGE string; three Next apps carry three hand-rolled HTTP clients (980 lines) and two already-divergent copies of tokens.css with no shared package. UX/presentation: the DS-adherence ESLint gate is TS/TSX-only, so the 145 raw px + 1 raw hex in globals.css and 106 raw px in ds-components.css are entirely unpoliced; there are three different confirmation postures for money/destructive actions in one portal (DS dialog, native window.confirm, and nothing); the Dialog primitive has no focus trap or focus restore; and there is no skip link anywhere. Error handling is the weakest layer: payer-http.ts throws one untyped Error for every non-401 status, and every Server Action catch collapses 400/403/404/409/422/429/500/timeout/zod-parse-failure AND an expired session into a single "Please retry" line — isPayerUnauthorized is referenced in exactly one file in the whole app. Tally for this dimension: 34 findings — 1 P0, 12 P1, 18 P2, 3 P3.

> NOTE ON EVIDENCE: every row below was produced by opening the cited file. Counts marked
> "measured" come from a grep/wc run recorded in the audit session. Nothing is inferred from
> a filename, a route name, or a test name.

---

# 1. RELIABILITY

## 1.1 Idempotency on money and create paths

| Path | Route / entry | Mechanism | Verdict |
|---|---|---|---|
| Unlock a contact | `POST /payer/unlocks` — `payer-unlocks.controller.ts:61` | Natural key: upsert on the `(payer, worker)` unique index, `onConflictDoUpdate` — `unlocks.repository.ts:179-224` | **Idempotent** (structural) |
| Denied-unlock audit row | same | `onConflictDoUpdate` on `(payer, worker)` — `unlocks.repository.ts:225-255` | **Idempotent** |
| Razorpay webhook | `POST /payments/razorpay/webhook` — `razorpay-webhook.controller.ts:33-52` | HMAC guard + unique `(provider, provider_order_id)` on `payment_orders` (`unlocks.repository.ts:475-477`) + partial-unique `credit_ledger_idempotency_key_uq` fed by `payment.captured:order:<id>` (`unlocks.service.ts:733`) | **Idempotent**, and correctly designed (business outcome → 200; infra failure → 5xx so Razorpay redelivers) |
| Browser payment verify | `POST /payer/credits/verify` — `payer-unlocks.controller.ts:191-215` | Settles through the SAME order row as the webhook; the two converge | **Idempotent** |
| **Mock credit-pack purchase** | `POST /payer/credits` — `payer-unlocks.controller.ts:129-139` → `unlocks.service.ts:515-538` → `purchasePackMock` → `creditPack` | `creditPack`'s `idempotencyKey` is **optional and not passed** (`unlocks.repository.ts:420-427,466`); the only guard is the client's `pendingCode` state (`credits-panel.tsx:166`) | **NOT idempotent** — ENT-REL-03 |
| **Quota top-up** | `POST /payer/job-postings/:id/quota-topup` — `payer-job-postings.controller.ts:209-218` | None. `payer-api.ts:1304-1306` states the hazard verbatim: *"a retry would buy a SECOND top-up"*, and works around it by degrading a failed re-read to `null` instead of preventing the double-charge | **NOT idempotent** — ENT-REL-04 |
| **Buy plan / buy boost** | `POST /payer/job-postings/:id/plan`, `/boost` — `payer-job-postings.controller.ts:177-206` | None | **NOT idempotent** — ENT-REL-04 |
| Org member invite | `POST /payer/org/invites` → `payer-orgs.repository.ts:78-83` | Natural key: `onConflictDoNothing` on `payer_members_org_email_uq` | **Idempotent** |
| Agency invite mint | `agency.service.ts:596` | Event key `agency_invite.created:<invite_id>`; the invite row itself is a fresh mint per call | Event-idempotent; request re-mints |

**The structural point:** every `idempotencyKey` in the codebase (`grep` over `apps/api/src/payer-portal`, `posting-plans`, `agency` — 20 hits) is an **event-spine dedupe key**, not a request dedupe key. There is **no `Idempotency-Key` request header anywhere in the repo**. Money endpoints that lack a natural unique key are therefore replay-unsafe.

## 1.2 Transaction boundaries

`db.transaction` appears at 22 non-test sites. Verified coverage of the money-critical ones:

- `unlocks.repository.ts:426` — `creditPack` (balance upsert + ledger append) ✅
- `unlocks.repository.ts:437-470` — `creditPackWithinTx`, explicitly designed so the grant and the `payment_orders` created→paid flip commit together ✅
- `free-tier.service.ts:43`, `agency-payout.repository.ts:168`, `pricing.repository.ts:39`, `posting-plans.repository.ts:40`, `worker-skills.repository.ts:111,199,285`, `referral-link.repository.ts:90` ✅

**Documented gap:** `agency.service.ts:426-430` and `:555-565` both describe the shape that *is not implemented* — "`db.transaction` → tx-aware `invitesRepo.create` + emit on the same tx". The invite row and its `agency_invite.created` event are therefore written in **two separate transactions**; a crash between them leaves an invite with no audit event. (ENT-REL-11)

## 1.3 Outbound calls — timeout / retry matrix

| Dependency | File:line | Timeout | Retry | Verdict |
|---|---|---|---|---|
| ai-service (POST) | `ai.service.ts:380-418` | ✅ 8 s AbortController (60 s for chunked STT) | ❌ | fails soft to in-process mock |
| ai-service (health probe) | `ai.service.ts:348-366` | ✅ 2 s | ❌ | fine |
| ZeptoMail | `email-notification.service.ts:172` | ✅ 10 s `AbortSignal.timeout` | ✅ exactly 1, transport-only, never on a rejection (`:69-101`) | **best-in-repo** |
| FCM push | `fcm-push.provider.ts:71-81,141-148` | ✅ `REQUEST_TIMEOUT_MS` | ❌ | BullMQ `attempts:3` covers it |
| Supabase Storage | `storage.service.ts:47-355` | ✅ 8 s / 15 s AbortControllers throughout | ❌ | acceptable |
| **Fast2SMS (OTP)** | `fast2sms.provider.ts:59-76` | **❌ none** | **❌ none** | ENT-REL-05 — a hung socket stalls a login request indefinitely |
| **Razorpay SDK** | `razorpay.client.ts:80-107,117-120` | **❌ none configured** on `new Razorpay({key_id,key_secret})` | ❌ | ENT-REL-06 — order creation is on the payer's request path |
| **payer-web → API** | `payer-http.ts:54-59` | **❌ none** | **❌ none** | ENT-REL-01/02 — and `admin-http.ts:84,105` in the same repo *does* have `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` |

## 1.4 Queues

Root config — `queue.module.ts:20-27`: `attempts: 3`, exponential backoff `delay: 1000`, `removeOnComplete: 1000`, `removeOnFail: 5000`.

Queues declared (`queue.constants.ts`): `profile-extraction`, `voice-transcription`, `resume-generate`, `resume-render`, `account-deletion`, `ai-jobs-retention`, `worker-push`, `referral-bonus`. Processors: 9 files under `auth/`, `pace/`, `profiles/`, `push/`, `referrals/`, `resume/`, `voice/`.

**Not one of them is payer or agency work.** Every payer-facing operation — credit purchase, plan/boost/top-up purchase, unlock grant, member-invite email, agency invite mint, payout request, KYC submit — runs **synchronously in the HTTP request**. (ENT-REL-08)

**No DLQ.** Failed jobs sit in the BullMQ failed set bounded by `removeOnFail: 5000` and are silently evicted after that; nothing reads the failed set, and there is no alert. The single detection surface is the ADR-0031 sweep-scheduler existence probe (`health.service.ts:180-187`), which covers one scheduler, not job outcomes. (ENT-REL-09)

## 1.5 Session fragility

`http-provider.ts:130-137` — `currentSession()` returns `null` on **any** failure, and the comment concedes it: *"A transient API error should not masquerade as 'logged out' … but the seam contract is null-or-session, so fail closed to /login."* `auth/index.ts:26-30` then `redirect("/login")`. A 30-second API blip therefore bounces every logged-in payer out of whatever form they were filling. (ENT-REL-10)

---

# 2. OBSERVABILITY

## 2.1 Structured logging — no correlation id, measured

`StructuredLogger.write` (`structured-logger.ts:11-24`) emits exactly `{level, time, service, context, message}`. There is **no requestId field and no correlationId field**.

`RequestIdMiddleware` (`request-id.middleware.ts:26-39`) correctly mints both, honours inbound `x-request-id` / `x-correlation-id`, and echoes them as response headers — and then **nothing consumes them for logging**. The `@Ctx()` decorator (`request-context.ts:16-22`) threads them into *events*, never into logs.

Measured: `grep 'logger\.(log|warn|error|debug)' apps/api/src --exclude tests` → **281 call sites**. The same set filtered for `requestId|correlationId|request_id|correlation_id` → **0**.

Even the batch-emit line that would benefit most carries only counts: `events.service.ts:96-98` logs `events=N written=M event=<name> (batch)` with no correlation id. The global exception filter puts `requestId` in the **HTTP response body** (`all-exceptions.filter.ts:32-38`) but logs a bare string without it (`:42`).

**Consequence:** a payer reporting "my top-up failed at 3pm" cannot be traced. There is no field to join on.

## 2.2 Trace propagation payer-web → API

`payer-http.ts:46` builds `headers` as `{content-type}` plus `authorization`. It sends **no** `x-request-id` and **no** `x-correlation-id`, and never reads the response headers the API sets. The two tiers are unlinkable. (ENT-OBS-02)

## 2.3 Error tracking

`grep -r 'sentry|Sentry|opentelemetry|prom-client|datadog|newrelic'` over all `package.json`, `*.ts`, `*.tsx` (excluding node_modules) → **zero hits**.

Stated plainly: **there is no error tracking, no APM, and no metrics pipeline in either apps/api or apps/payer-web.** Client-side errors are explicitly *not* reported — `(portal)/error.tsx:9`, `app/error.tsx:16`, `global-error.tsx:24` each say "Nothing is logged client-side."

`infra/monitoring/` contains one file, a README, whose lines 12-13 read: *"TODO (later): metrics (Prometheus/OpenTelemetry), dashboards, alerting."*

## 2.4 Health checks

`/health` (`health.controller.ts:63-79`) is a **single endpoint**, well built for what it is:
- Probes DB (`select 1`), Redis (`PING` over the existing BullMQ client), the ADR-0031 deletion-sweep scheduler, and ai-service reachability — all in parallel, each under a 2 s cap (`health.service.ts:141-155,301-316`).
- Gates 200/503 on DB + Redis only; sweep + ai posture are informational, with a well-argued rationale at `:26-54`.
- TD81 `ai_posture` is a genuinely good idea and carries an honest caveat about config-presence vs verified key (`health.service.ts:53-66`).

Gaps:
- **No liveness/readiness split.** One endpoint that 503s on a DB outage. Wired as a k8s liveness probe it would restart healthy pods during a DB blip; wired as readiness only, there is nothing to detect a wedged process. (ENT-OBS-04)
- **payer-web has no health endpoint at all** and no `instrumentation.ts`. (ENT-OBS-05)
- `health.controller.ts:35` points operators at `docs/observability-runbook.md §7` for the SEV2 alert threshold. `git ls-tree -r origin/main -- docs` returns 5 files; that runbook is **not one of them**. The alert threshold the code cites does not exist. (ENT-OBS-06)

---

# 3. PERFORMANCE

## 3.1 Unbounded full-pool scan + per-worker event write — **P0**

`ReachRepository.listSignalRows()` (`reach.repository.ts:81-101`): `selectDistinctOn(workerId)` over `worker_profiles ⋈ workers`, `WHERE deletion_scheduled_at IS NULL`. **No `.limit()`.** The doc comment at `:68-80` states the intent — "The FULL eligible worker pool… ELIGIBILITY, NOT RELEVANCE" — so this is deliberate for ranking, but it is unbounded by construction.

`ReachService.applicantsForOwnedJob` (`reach.service.ts:105-140`) then:
1. loads that full pool into memory (`:112`),
2. maps every row to signals and bands (`:114-116`),
3. ranks every worker (`:118`),
4. and at `:123-136` calls `emitMany` with **one `feed.shown` row per ranked worker** — explicitly UNKEYED (`:191-193`: "NO `idempotencyKey` — feed.shown is UNKEYED").

So a single payer opening a single applicants page performs one full-table read of the worker population **and inserts N rows into `events`**, where N = the whole platform's worker count. At 10 000 workers that is 10 000 event rows per page view, per payer, per refresh. The `events` table is the audit spine — this is both an unbounded read and an unbounded write amplification.

The `MATCH_V1_ENABLED` path (`payer-reach.controller.ts:74-81` → `matchCandidates.listForPosting`) is bounded by `OPS_LIST_CAP` and emits nothing — but that flag is **OFF by default**, so the legacy path above is the shipping path.

## 3.2 N+1 on the payer's own job list — **P1**

`payer-job-postings.controller.ts:106-113`:

```
const postings = await this.jobPostings.listForPayer(payer.id, query);
return Promise.all(postings.map((p) => this.enrich(p, payer.id)));
```

`enrich` (`:74-84`) issues, **per posting**:
- `plans.getPostingStats` → `posting-plans.service.ts:159-164` → 2 queries (`findActivePlanForPostingAndPayer` + `findActiveBoost`)
- `disclosures.countDisclosuresForPosting` → 1 query

`listByPayer` defaults to `limit = 100` (`job-postings.repository.ts:199-214`). Worst case: **1 + 100 × 3 = 301 queries** for one `GET /payer/job-postings`. That endpoint is called twice per dashboard render (see 3.3).

## 3.3 payer-web request amplification — **P1**

Per dashboard view:

| # | Call | Origin |
|---|---|---|
| 1 | `GET /payer/me` | `layout.tsx:33` → `requirePayer()` → `http-provider.ts:129` |
| 2 | `GET /payer/credits` | `layout.tsx:40` `getCredits()` (balance chip) |
| 3 | `GET /payer/me` **(duplicate of 1)** | `dashboard/page.tsx:36` → `requirePayer()` again |
| 4 | `GET /payer/credits` **(duplicate of 2)** | `payer-api.ts:174` inside `getDashboard()` |
| 5 | `GET /payer/unlocks` | `payer-api.ts:174` |
| 6 | `GET /payer/job-postings` | `payer-api.ts:174` — and this one is the 301-query N+1 |

Measured: `grep 'cache('` over `apps/payer-web/src/lib` and `src/app` (excluding `no-store` and tests) → **0 hits**. React's `cache()` is not used anywhere, so nothing dedupes 1↔3 or 2↔4. Every call is `cache: "no-store"` (`payer-http.ts:58`) and 26 files carry `export const dynamic = "force-dynamic"` across 25 pages — so nothing is cached at any layer, ever.

`/credits` and `/team` are worse still: `requireOwner()` (`org-roles.ts:63-70`) calls `requirePayer()` a *third* time.

## 3.4 Unbounded and silently-truncating queries

| Read | Bound | Note |
|---|---|---|
| `payer-orgs.repository.ts:108-115` `listMembers(orgId)` | **none** | every non-removed member returned; the service then RSA-decrypts each email one at a time (`payer-org-members.service.ts:67-68,241`) |
| `agency-jobs.repository.ts:114-119` `listOwned(payerId)` | **none** | every job an agency ever posted |
| `unlocks.repository.ts:601-607` `listByPayer` | `OPS_LIST_CAP` = 500 | **silent truncation** — payer #501 onward simply vanishes with no UI signal |
| `applications.repository.ts:245-251` `findApplicantsByJob` | 500 | same |
| `applications.repository.ts:258-294` `findApplicationsByWorker` | 500 | same |
| `job-postings.repository.ts:199-214` `listByPayer` | 100 | truncation at 100 postings |
| `reach.repository.ts:81-101` `listSignalRows` | **none** | §3.1 |

`common/pagination.ts` provides only `clampLimit` + `OPS_LIST_CAP` — **there is no cursor/offset pagination primitive in the repo**, and no payer-facing list endpoint accepts a page token.

## 3.5 SQL-side per-row fan-out

`agency-workers.repository.ts:57-120` — the agency worker-engagement list runs **four correlated subqueries per row** (`EXISTS worker_profiles`, `count(*) applications`, `count(*) unlocks`, `max(last_seen_at) worker_devices`) plus a correlated `EXISTS` + `max()` consent gate in the WHERE. One query, but O(rows × 6) index probes.

## 3.6 Rendering, bundle, fonts

- **38 `"use client"` modules** (measured, `^"use client"` anchored, tests excluded) out of 130 source files. Several are heavy screen managers (`postings-manager.tsx`, `team-manager.tsx`, `job-posting-chat.tsx`, `applicant-actions.tsx`) that hold only per-row busy/error state — candidates for a smaller client leaf.
- **Zero `<Suspense>` boundaries** (measured: 0 hits). **One** `loading.tsx`, for the entire `(portal)` group. So every navigation blocks on the full serial fetch chain behind a single global skeleton; nothing streams.
- **Google Fonts is still a third-party dependency**, but correctly de-risked: `layout.tsx:44-60` moved four cross-origin sheets (measured 250 748 B from two origins) out of the render-blocking path into `ASYNC_CSS_SCRIPT`, keeping `preconnect` and a `<noscript>` fallback. Remaining cost: third-party availability + privacy on a public `/i/<code>` page; `next/font` self-hosting would remove both. (P3)
- **No security headers.** `next.config.mjs` (11 lines) sets only `reactStrictMode` and `eslint.ignoreDuringBuilds`. There is **no `headers()` export** → no CSP, no HSTS, no X-Frame-Options, no Referrer-Policy, no Permissions-Policy on the public payer portal. (ENT-PERF-09)

---

# 4. SCALABILITY

## 4.1 One payer == one org is hard-wired

- `payer-orgs.repository.ts:56-60` — `ensureSoloOrg` inserts with `onConflictDoNothing({target: payerOrgs.rootPayerId})`. The `payer_orgs_root_payer_id_uq` index means **a payer can found exactly one org, ever**.
- `payer-orgs.repository.ts:88-100` — `resolveOrgForPayer` selects the payer's active membership `.orderBy(desc(acceptedAt)).limit(1)`. The comment concedes the model: *"B5: one org per member; most-recently-accepted wins if that ever changes."*

**What breaks with a payer in 2 orgs:** they silently act inside whichever org they accepted most recently, with no indication which. There is no org switcher in payer-web (no route, no UI, no session claim), so the payer cannot see or change it. Every downstream tenancy check then binds to the wrong org.

**What breaks with 50 members in one org:** `listMembers` returns all 50 unbounded, the service decrypts 50 emails serially (`payer-org-members.service.ts:67-68`), `.team-table` has no scroll container (`globals.css:3326-3334`, `overflow: hidden`), and the whole surface is unreachable anyway because `getOrgRole()` hard-returns `"recruiter"` outside dev (`org-roles.ts:38,46-56` → `requireOwner()` → `notFound()`).

## 4.2 Concurrency

- **DB pool: `max = 10`** for the whole API process — `packages/db/src/client.ts:23-29`; `database.module.ts:26-30` calls `createDbClient(config.DATABASE_URL)` with **no options object**, so the default applies. With the §3.2 N+1 issuing up to 301 sequential queries per request, ten concurrent "My jobs" loads saturate the pool.
- **Redis: one connection for everything.** `queue.module.ts:33-46` builds the BullMQ connection with `maxRetriesPerRequest: null` (required for blocking commands). Every other Redis consumer then reuses that same client via `queue.client`: `ip-rate-limit.service.ts:56,102`, `subject-rate-limit.service.ts:79`, `otp.service.ts:298`, `payer-disclosure-rate-limit.service.ts:102`, `health.service.ts:164`. With `maxRetriesPerRequest: null`, ioredis **queues commands indefinitely during a reconnect rather than rejecting** — so the carefully written fail-closed `catch` at `payer-disclosure-rate-limit.service.ts:105-110` cannot fire; the request hangs instead of 429-ing. (ENT-REL-07, medium confidence — behavioural claim about ioredis, config read directly.)

---

# 5. MAINTAINABILITY

## 5.1 Status codes decided by regex over an error message — **P1**

`payer-http.ts:62-65` throws one untyped error for every non-401:

```
throw new Error(`payer API ${path} returned ${res.status}`);
```

`payer-api.ts` then makes **21 control-flow decisions by regex-matching that string** (measured; lines 249, 328, 365, 397, 572, 600, 615, 630, 713, 757, 824, 1029, 1046, 1086, 1154, 1173, 1233, 1252, 1297, 1298, 1343):

```
if (e instanceof Error && /returned 404/.test(e.message)) return null;
if (e instanceof Error && /returned 429/.test(e.message)) return { ok: false };
if (e instanceof Error && /returned 409/.test(e.message)) throw new QuotaTopUpNoPlanError();
```

Any change to the message template in `payer-http.ts:64` silently converts 21 handled business outcomes into thrown errors — with no type error, no failing typecheck, and no lint signal.

**The fix already exists in this repo.** `apps/admin-web/src/lib/admin-http.ts:29-62` defines `AdminUnauthorizedError`, `AdminForbiddenError`, and `AdminRequestError` carrying a real `.status: number`. The payer surface — the one that handles money — is the weaker of the two.

## 5.2 Duplication across the three Next apps

| Concern | apps/web | apps/admin-web | apps/payer-web | Shared package? |
|---|---|---|---|---|
| HTTP client | `lib/api.ts` (771 L) | `lib/admin-http.ts` (137 L) | `lib/payer-http.ts` (72 L) + `lib/invite-landing.ts` | **none** |
| Design tokens | `globals.css` 467 L, no tokens file | `styles/tokens.css` 545 L | `styles/tokens.css` 545 L | **none** |
| DS components | — | — | `components/ds/*` 15 files | **none** |

**The token copies have already diverged.** `diff apps/payer-web/src/styles/tokens.css apps/admin-web/src/styles/tokens.css` differs at lines 386-389:

```
payer-web:  --radius-md:10px  --radius-lg:10px  --radius-xl:12px  --radius-2xl:12px
admin-web:  --radius-md:14px  --radius-lg:18px  --radius-xl:24px  --radius-2xl:32px
```

`packages/` holds 12 packages (`ai-contracts`, `config`, `db`, `event-schema`, `match-engine`, `pricing`, `profiling-lexicon`, `reach-engine`, `reach-learn`, `taxonomy`, `types`, `validators`) — **not one UI or HTTP package**.

**Extraction candidates, in priority order:** (1) `@badabhai/http` — a typed fetch client with status-carrying error classes, timeout, and `x-request-id` propagation, replacing all three; (2) `@badabhai/tokens` — one `tokens.css` consumed by both portals; (3) `@badabhai/ui` — the `.bb-*` DS.

## 5.3 Copy-pasted date formatting that is wrong for the market

An identical 3-line `day()` helper appears **six times** verbatim:
`postings-manager.tsx:33-36`, `credits/page.tsx:23-26`, `job-posting-chat.tsx:80-83`, `applicant-actions.tsx:81-84`, `postings/[id]/page.tsx:18-21`, `routed-contact-card.tsx:16-19`.

All six do `d.toISOString().slice(0, 10)` — i.e. **render UTC dates to an IST audience**. A posting created at 02:00 IST displays as the previous day. The backend already learned this lesson and documented it: `agency-workers.repository.ts:88-95` explains the exact timezone day-shift bug and fixes it in SQL. The frontend never got the fix, and there is no `formatDay()` in `lib/format.ts` (which contains only `formatInr`).

## 5.4 Layering violations (CLAUDE.md §4: controllers = HTTP only)

- `payer-job-postings.controller.ts:74-84` — `enrich()` is a **private orchestration method on a controller** that fans out to two services and merges their results into a view model. That is service work.
- `payer-job-postings.controller.ts:190,205,217` — the controller performs an ownership pre-check (`await this.jobPostings.getOneForPayer(...)`) before delegating. Correct behaviour, wrong layer: the authorization sequencing is a business rule living in HTTP code, and it is duplicated three times.

## 5.5 A formatter that throws during render

`format.ts:21-28` — `formatInr` throws `RangeError` on any non-integer or negative input. It is called at 12 render sites (`earnings-panel.tsx:42-45`, `payout-panel.tsx:75,88,121`, `capacity-panel.tsx:41,79`, `credits-panel.tsx:53,159`, `credits/page.tsx:87`, …), several of them with values that arrive straight off the wire. A backend that ever returns a fractional or negative rupee amount takes down the whole page into `error.tsx` rather than rendering a dash. (P3, low blast radius today — every wire schema currently parses these as integers.)

---

# 6. UX / PRESENTATION (apps/payer-web)

## 6.1 The DS-adherence gate does not police where the values live

`eslint.config.mjs:97-107` bans raw hex and raw `px` via `no-restricted-syntax`. Its `files` filter (`:95`) is `apps/payer-web/src/**/*.{ts,tsx}` and `apps/admin-web/src/**/*.{ts,tsx}`, and the comment at `:88-90` states the carve-out outright: *"Color/size token values live in CSS, so the token files + the `.bb-*` component CSS … are out of scope here (ESLint lints TS/TSX only)."*

Measured, on the files the gate cannot see:

| File | Raw hex | Raw `px` |
|---|---|---|
| `app/globals.css` (4099 L) | **1** (`:4090` `background: #fff`) | **145** |
| `styles/ds-components.css` (559 L) | 0 | **106** |

Sample real declarations, not comments: `globals.css:271` `border: 1px solid`, `:272` `padding: 12px 24px`, `:277` `gap: 12px`, `:281` `font-size: 16px`, `:287` `font-size: 11px`, `:296-297` `padding: 6px 12px; border-radius: 6px`.

**Second bypass — numeric inline styles.** 22 `style={{…}}` occurrences remain in TSX (measured). Because the gate's selector is `Literal[value=/\b\d+px\b/]`, a **numeric** value is invisible to it:
- `(portal)/loading.tsx:19` — `style={{ marginTop: 24 }}`
- `components/ds/masked-candidate.tsx:62` — `style={{ width: 52, height: 52, fontSize: 20 }}`
- `components/ds/masked-candidate.tsx:78` — `style={{ fontSize: 16 }}`
- `components/ds/logo.tsx:42` — `<rect width="512" height="512" rx="128">`
- `components/ds/display.tsx:210`, `components/ds/logo.tsx:67` — computed `Math.round(size * …)`
- `app/not-found.tsx:19`, `ds/job-card.tsx:109`, `ds/job-card.tsx:58` — layout/colour set inline

So the gate is green while the portal ships 252 raw pixel values and one raw hex.

## 6.2 Stale copy contradicting shipped behaviour

`globals.css:1894-1896`:

> *"The pause / resume / quota top-up trio renders as DISABLED 'coming soon' DS Buttons — no payer-authed lifecycle route exists yet."*

`postings-manager.tsx:144-190` ships all three as **live, enabled** buttons wired to real Server Actions (`postings/actions.ts:37-114`), against real routes (`payer-job-postings.controller.ts:145-218`). The CSS class is still named `.posting-card__soon` and now renders **live error and success text** (`postings-manager.tsx:186-187`).

Related stale reference: `health.controller.ts:35` cites `docs/observability-runbook.md §7`, which does not exist on `origin/main` (5 docs files total).

## 6.3 Three different confirmation postures for money and destructive actions

| Action | Money / destructive? | Confirmation | Evidence |
|---|---|---|---|
| Unlock a contact | ✅ spends a credit | **DS `ConfirmSpendDialog`** | `applicant-actions.tsx:505`; `components/unlock/confirm-spend-dialog.tsx` |
| Buy credit pack | ✅ | **native `window.confirm`** | `credits-panel.tsx:52-56` |
| Upgrade capacity tier | ✅ | **native `window.confirm`** | `capacity-panel.tsx:40-44` |
| Quota top-up | ✅ charges | **none** — fires on one click | `postings-manager.tsx:171-180` → `actions.ts:73-98` |
| Buy plan / boost | ✅ charges | **none** | `payer-job-postings.controller.ts:177-206` (no FE confirm path) |
| Close a posting | ✅ terminal | **none** | `postings-manager.tsx:182-190` |
| Remove an org member | ✅ destructive | **none** | `team-manager.tsx:45` → `removeMemberAction` |

`window.confirm` is unstyled, unbranded, not theme-aware, not translatable, and blocks the main thread — three incompatible answers to the same question inside one portal.

## 6.4 Responsive behaviour

Measured across 5203 CSS lines: **24 `@media` blocks in `globals.css`**, of which most are `prefers-reduced-motion` (9) or `print` (1). Actual viewport breakpoints: `max-width:768px` ×3 (`:78, :159, :251`), `max-width:900px` ×1 (`:2619`), `min-width:1024px` ×4 (`:581, :600, :723, :760`), `max-width:60rem` ×1 (`:3866`). **`styles/ds-components.css` — the DS component layer itself — contains ZERO media queries.** `tokens.css` has one (`prefers-reduced-motion`).

What is handled well: `credits-table-card` / `capacity-table-card` get an intentional `overflow-x: auto` scroll region with `width: max-content` inner tables (`globals.css:1529-1541`), and `.agency-workers__table` uses the same pattern (`:2505-2516`).

What is not: **`.team-table` (`globals.css:3326-3334`) has `overflow: hidden` and no scroll container** — on a narrow viewport its columns clip rather than scroll. The `plans` page table reuses `capacity-table-card` (`plans/page.tsx:139`) so it is fine.

Below 768px the portal is usable but unrehearsed: the DS primitives themselves have no responsive rules, so component-internal layout is fixed at whatever the desktop values are.

## 6.5 Accessibility

**Good, and worth preserving:**
- `Tabs` (`ds/tabs.tsx:97-124`) is a correct WAI-ARIA tablist: `role=tablist`/`role=tab`, `aria-selected`, **roving tabindex**, ←/→/↑/↓/Home/End, and optional `aria-controls`/`tabId()` panel wiring.
- Form label association is real, not decorative: `ds/forms.tsx:22-33` auto-generates an id and `FieldLabel` binds `htmlFor`; `Input`/`Select`/`Textarea` all pass it (`:169-176, :214-216, :255-256`). `Checkbox`/`Radio`/`Switch` wrap the control in a `<label>` (`:267-305`).
- Focus states are token-driven `box-shadow: var(--ring-focus)` on `:focus-visible` — 6 rules in `ds-components.css`, 8 in `globals.css`.
- 44 `aria-live` / `role="alert"` / `role="status"` regions across the app.
- Every Phosphor glyph is `aria-hidden` with a text label beside it (`ds/forms.tsx:11-12` states the contract).
- `loading.tsx:11-12` uses `aria-busy` + `sr-only`.

**Gaps:**
- **`Dialog` has no focus management.** `ds/dialog.tsx:39-46` wires Esc-to-close and nothing else: **no focus trap**, **no initial focus move into the dialog**, **no focus restore on close**, **no body scroll lock**. Keyboard focus stays behind the scrim; a screen-reader user is not moved into the modal.
- **`Dialog`'s title id is a hardcoded constant** — `ds/dialog.tsx:57` `const titleId = title ? "bb-dialog-title" : undefined`. Two dialogs mounted at once emit duplicate DOM ids and `aria-labelledby` resolves to the wrong heading.
- **The scrim is a `<div onClick>`** (`ds/dialog.tsx:60`) with no keyboard equivalent — mitigated by Esc, but it is a non-interactive element carrying a handler.
- **No skip link anywhere.** grep for `skip-link` / `skip to` across all CSS and TSX → 0 hits. Every page forces a keyboard user through the full header (brand link, nav, theme toggle, account menu, logout) before reaching `<main>` (`layout.tsx:78`).
- **`Toast` is always `role="status"`** (`ds/toast.tsx:35`) regardless of tone — a `tone="danger"` toast is announced politely rather than assertively.
- Colour contrast: the DS shows real awareness here — `ds-components.css:237-251` documents a measured ≈1.6:1 failure on soft badges and re-points the ink-theme foregrounds. No systematic contrast audit exists.

## 6.6 Consistency

- **Feedback rendering is split.** `Toast` is used on only 5 surfaces (`account-form.tsx:208`, `capacity-panel.tsx:98-99`, `capacity/page.tsx:124`, `credits-panel.tsx:178-180`, `credits/page.tsx:214,220`, `plans/page.tsx:123`). Everywhere else errors render as bespoke `<p className="…">` — e.g. `postings-manager.tsx:186-187` uses `.posting-card__soon`.
- **Empty states are handled** and are good: `postings-manager.tsx:97-108` renders a flat Card with a next-action link; `team-manager.tsx:86` has a `.team-empty` Card.
- **Currency is centralised and correct** — `formatInr` (`format.ts:21-28`) with `en-IN` lakh grouping, one source, no hand-built `₹` strings.
- **Dates are not centralised and are wrong** — §5.3.
- **Status badges are honest** — `postings-manager.tsx:39-45` maps the real `status` to a tone and never invents one.

---

# 7. ERROR HANDLING MATRIX

Trace: `payer-http.ts` → `payer-api.ts` → Server Action `catch` → `error.tsx`.

The single hinge is `payer-http.ts:61-65`:

```
if (res.status === 401) throw new PayerUnauthorizedError();
if (!res.ok) throw new Error(`payer API ${path} returned ${res.status}`);
```

**Every non-401 status becomes the same untyped `Error`.** There is no `.status`, no `.body`, no error class.

| Condition | What `payerFetch` does | What a **page-level read** shows | What a **Server Action** shows |
|---|---|---|---|
| Network failure / API down | `fetch` rejects (**no timeout** → may hang first) | layout's `requirePayer` → `currentSession()` swallows → `redirect("/login")` — **the user is logged out** | `{ok:false, error:"Could not … right now. Please retry."}` |
| **Timeout** | **never** — no `AbortSignal`; the render hangs | hangs behind `loading.tsx` | hangs; the action never resolves |
| **400** | generic `Error` | page's own `catch` → "Service unavailable" card (`dashboard/page.tsx:47-64`) or `error.tsx` "Something went wrong" | generic retry line |
| **401 expired session** | `PayerUnauthorizedError` | layout catches via `currentSession()` → `/login` ✅ | **swallowed** → "Could not … Please retry." **forever**. No re-auth, no redirect. `account/actions.ts:69` names 401 explicitly as intentionally collapsed |
| **403** | generic `Error` | "Something went wrong" | generic retry line |
| **404** | generic `Error` | 21 call sites regex-match `/returned 404/` → `null` → the page renders a neutral not-found ✅ | neutral "could not be found" ✅ |
| **409** | generic `Error` | — | **one** case is distinguished (`payer-api.ts:1298` → `QuotaTopUpNoPlanError` → actionable copy at `postings/actions.ts:93-95`). Every other 409 is a generic retry line, incl. pause-a-non-open-posting (`actions.ts:48` says so) |
| **422** | generic `Error` | "Something went wrong" | generic retry line |
| **429** | generic `Error` | — | 2 sites (`payer-api.ts:713,757`) return `{ok:false}` with **no message distinguishing throttling from failure** |
| **500** | generic `Error` | "Something went wrong. This is on our side" ✅ | generic retry line |
| **Empty body** | `text.length === 0` → `{}` → `schema.parse({})` → **ZodError** unless the schema tolerates it (`payer-http.ts:68-71`) | "Something went wrong" | generic retry line |
| **Invalid data / zod parse failure** | `ZodError` thrown from `schema.parse` | **identical** to a 500 | **identical** to every other failure |

**Two structural consequences:**

1. **An expired session inside a Server Action is a dead end.** `isPayerUnauthorized` is exported at `payer-http.ts:29` and referenced in exactly **one** file — `http-provider.ts:134`. No Server Action checks it. The payer clicks "Pause", sees "Please retry", clicks again, sees it again. Only a full navigation (which re-runs the layout's `requirePayer`) recovers them. The comments frame this as no-oracle discipline (`account/actions.ts:69`), but a 401 on *your own* session is not an oracle — it is the one status the user must be told about.

2. **A contract drift is indistinguishable from an outage.** If the API changes a field's shape, `schema.parse` throws a `ZodError` that renders the same "This is on our side — please try again" as a 500, with nothing logged anywhere (no Sentry, and the boundaries state "Nothing is logged client-side"). The failure is invisible to engineering and unactionable for the user.

**What is done well here:** the no-leak discipline is genuinely rigorous — `error.tsx:6-10`, `app/error.tsx:11-16`, `global-error.tsx:20-24` each refuse to surface `cause`/`message`/`digest`/stack, and `payer-http.ts:63` deliberately discards the deny reason. The trade-off is the one above: the same rigour that prevents a leak also erases the signal.
