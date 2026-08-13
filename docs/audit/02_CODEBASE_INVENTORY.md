# 02 — Codebase Inventory

Machine-generated-style structural inventory: file counts by convention, module-registration/DI/routing patterns per app, and a Rule-4 (dynamic/convention-based reachability) reference table for future dead-code judgments. Builds on [01_SYSTEM_BOUNDARY.md](01_SYSTEM_BOUNDARY.md) (component purpose/ownership) — this document does not repeat purpose/ownership, only structure. All counts are `git ls-files` / `grep -c` output against the working tree, not estimates.

---

## 1. apps/api (NestJS) — 686 files under `src/`, 39 top-level feature directories

| Convention | Count | Notes |
|---|---|---|
| `*.controller.ts` | 62 | HTTP layer only, per CLAUDE.md §4 |
| `*.service.ts` | 88 | business logic |
| `*.repository.ts` | 48 | DB access only |
| `*.module.ts` | 45 | one per feature dir, plus `app.module.ts` |
| `*.dto.ts` | 45 | request/response validation shapes |
| `*.guard.ts` | 13 | see §1.2 |
| `*.interceptor.ts` | 1 | `referrals/worker-activity.interceptor.ts` — but global-scoped, see §1.2 |
| `*.processor.ts` | 9 | BullMQ consumers, see §1.3 |
| `*.test.ts` | 293 | suffix is `.test.ts`, not `.spec.ts` (repo convention) |

Directory sizes (file count, all types) for the 10 largest of 39 feature dirs: `admin` 78, `profiling` 52, `match` 31, `agency` 32, `common` 32, `auth` 43, `payer-portal` 38, `resume` 41, `referrals` 25, `unlocks` 26. Full dir list: `actions, admin, agency, ai, applications, auth, chat, common, config, consent, database, disclosures, events, health, interview-kit, job-postings, jobs, match, messaging, notifications, occupation, pace, payer-portal, payers, posting-plans, pricing, profiles, profiling, push, queue, reach, referrals, resume, skills, sms, storage, unlocks, voice, workers`.

Representative feature-dir breakdown (controller/service/repository/dto/module/test): `admin` 8/11/7/8/1/35, `auth` 3/7/3/3/1/20, `agency` 5/4/5/3/1/13, `resume` 1/3/1/1/1/14, `profiling` 1/6/2/1/1/29.

### 1.1 Module-registration pattern (the reachability root)

A feature module is a plain `@Module({ controllers: [...], providers: [...], exports: [...] })` class (example, `apps/api/src/pricing/pricing.module.ts`). **Reachability is the `imports: []` array of `app.module.ts`.** A controller/service/repository is "used" in the NestJS sense only if its owning module is reachable, directly or transitively, from `AppModule.imports`. `app.module.ts`'s own comment documents this exact failure mode having happened before: `ProfilingModule` "spent months in this repository reachable from nothing, behind a boot test that asserted it had no controllers and was happy about it" — now imported explicitly into `AppModule` even though `ChatModule` already pulls it in transitively, specifically so a reader checking "is this wired up?" has one place to look. **Consequence for dead-code judgment: grepping for a class's imports across the repo is necessary but not sufficient — the module graph from `app.module.ts` down must also resolve.**

### 1.2 Providers used without a direct import — two mechanisms

1. **`@Global()` modules (11 found)**: `ai.module.ts`, `common/crypto.module.ts`, `common/pdf/pdf.module.ts`, `common/rate-limit/rate-limit.module.ts`, `config/config.module.ts`, `database/database.module.ts`, `events/events.module.ts`, `match/match.module.ts`, `notifications/email-notification.module.ts`, `queue/queue.module.ts`, `sms/sms.module.ts`, `workers/workers.module.ts`. Once imported ONCE into `AppModule`, every provider these export is injectable in EVERY other module without that module listing an import edge to the defining one. **A grep for `import { X } from ".../y.module"` in a consuming file will find zero hits for a `@Global()` export — check whether the DEFINING module carries `@Global()`, not whether the consumer imports it.**
2. **`APP_GUARD` / `APP_INTERCEPTOR` / `APP_FILTER` / `APP_PIPE` DI tokens**: exactly one live instance in the codebase — `referrals/referral-attribution.module.ts` registers `{ provide: APP_INTERCEPTOR, useClass: WorkerActivityInterceptor }`. This fires on every authenticated worker request with **zero** `@UseInterceptors()` decorator anywhere in the codebase — a grep for the class name as a decorator argument returns nothing even though it is live. This is the only DI-token global; the global exception filter (`AllExceptionsFilter`) and CORS/trust-proxy config are instead wired **imperatively** in `main.ts` via `app.useGlobalFilters(...)`, not through the module graph at all — a third reachability path (bootstrap code, not `@Module` metadata).

All 13 `*.guard.ts` files are applied per-controller/route via `@UseGuards()` decorators — no `APP_GUARD` token exists, so guard reachability IS decorator/import-visible, unlike the one interceptor.

### 1.3 BullMQ producer/consumer pattern (a string, not an import, connects them)

9 processors: `auth/account-deletion-sweep.processor.ts`, `pace/pace.processor.ts`, `profiles/ai-jobs-retention-sweep.processor.ts`, `profiles/profile-extraction.processor.ts`, `push/push.processor.ts`, `referrals/referral-bonus.processor.ts`, `resume/resume-generate.processor.ts`, `resume/resume-render.processor.ts`, `voice/voice-transcription.processor.ts`. `queue/queue.module.ts` is the single `@Global()` root (`BullModule.forRootAsync`, in-process). A **producer** module calls `BullModule.registerQueue({ name: QUEUE_CONST })`; the **consumer** module separately registers the same named queue plus a `@Processor(QUEUE_CONST)` class in its own `providers: []`. The two feature modules producing and consuming a given queue have **no import edge between them at all** — the queue-name string constant in `queue/queue.constants.ts` is the only link. **A class-name/import grep cannot find a processor's trigger; grep the queue-name constant instead.**

---

## 2. apps/ai-service (FastAPI) — 134 `.py` files under `app/`

| Convention | Count |
|---|---|
| Router modules (`app/routers/*.py`, excl. `__init__.py`/`_shared.py`) | 10 handler files (`embeddings, growth, health, job_posting, privacy, profile, profiling, resume, skills, voice`) |
| Pydantic `BaseModel` classes | 67, all in one file: `app/contracts.py` (1,413 lines) |
| `app/ai/*.py` (LLM routing, cost tracking, canonicalization, growth, retag, embeddings) | 15 files |
| `app/profiling/*.py` (lexicon, prompts, interview logic, canonicalization gold set) + `lexicon_data/*.json` | 31 files (incl. 13 JSON lexicon data files) |
| `app/job_posting_chat/*.py` | 5 files |
| `app/cli/*.py` (manual-invoke STT/TTS smoke tools) | 4 files |
| `app/corpus/*.py` (DC-3, dormant per Batch 1) | 5 files |
| Top-level `app/*.py` (config, contracts, pseudonymize, stt, tts, translate, llm, extraction, storage, logging, main, audio_chunk, spoken_digits, reply_closure) | 15 files |
| Test files (`apps/ai-service/tests/` + inline) | 62 |

### 2.1 Route-registration pattern — fully explicit, single choke point

Unlike NestJS's module-graph or Next.js's filesystem routing, FastAPI here has **no dynamic discovery whatsoever**. Every router module exposes a module-level `api_router = APIRouter()`; `app/main.py` explicitly imports each router module by name and calls `app.include_router(x.api_router)` once, in a fixed, commented order (health, privacy, embeddings, skills, growth, job_posting, profile, profiling, resume, voice). A router file present under `app/routers/` but never named in this list is unreachable — a stronger and simpler guarantee than either NestJS or Next.js. The one global cross-cutting concern (TD67 service-bearer auth) is a single `@app.middleware("http")` function in `main.py`, also not per-router. This is consistent with Batch 1's DC-4 finding (`embed_aliases`/`AliasStore` — a function with real code but no router ever calling it, confirmed dead by exactly this "not in the `include_router` list, not called from any live route" check).

`packages/ai-contracts` (Zod, TypeScript side of the same contract, Architect-owned) has 14 `src/` files (13 non-test) mirroring `app/contracts.py`'s 67 Pydantic classes: `common.ts, conversation.ts, job-posting.ts, occupation.ts, oie.ts, profile.ts, skills.ts, voice.ts` + 4 `__fixtures__/*.keys.json` cross-language parity fixtures.

---

## 3. Next.js apps (3): apps/web, apps/payer-web, apps/admin-web

| Metric | web | payer-web | admin-web |
|---|---|---|---|
| Total `src/` files | 46 | 219 | 65 |
| `page.tsx` (routes) | 17 | 25 | 17 |
| `layout.tsx` | 1 | 2 | 2 |
| `route.ts` (Next.js API-route handlers) | 0 | 0 | 0 |
| `components/**/*.tsx` | 3 | 24 (19 in `components/ds/`) | 14 |
| `lib/*.ts` (non-test) | 13 | 55 | 13 |
| Custom hooks (`export function/const use[A-Z]…`) | 0 | 0 | 0 |
| `"use client"` files | 7 | 46 | 10 |
| `*.test.ts(x)` | 7 | 85 | 9 |

**Zero `route.ts` files across all three apps** confirms 01_SYSTEM_BOUNDARY.md's "consumers: apps/api exclusively" claim structurally — none of the three Next.js apps has its own server-side API surface (no BFF layer); every data fetch goes to `apps/api` over HTTP from client/server components.

**Zero custom-hook files** in any of the three apps (no `hooks/` directory, no `use*()`-named export anywhere) — state/data-fetch logic lives inline inside `"use client"` components, or in pure, hook-free `lib/*-view.ts` / `lib/*-api.ts` functions called directly from `useState`/`useEffect`. This is a structural absence, not a gap to fix without product signal.

### 3.1 File-based routing convention — reachable by path, not import

Next.js's App Router resolves `app/**/page.tsx` to a URL by directory path alone, at build time — **no import anywhere else in the codebase references a `page.tsx` file for it to be live.** `(portal)` is a **route group** — parentheses are stripped from the URL, purely organizational. Framework-special filenames (`layout.tsx`, `error.tsx`, `global-error.tsx`, `not-found.tsx`, `loading.tsx`) are loaded the same way. **This is the sharpest Rule-4 case in the repo: a `page.tsx` with zero grep hits for its own filename anywhere else is not evidence of deadness** — Batch 1's DC-2 (`payer-web/(portal)/profile/page.tsx`) is the concrete precedent: deliberately dropped from `nav-model.ts`'s in-app navigation but still resolves as a bookmarkable URL, and correctly NOT flagged as a delete candidate for that reason. Future dead-page checks must verify against nav/redirect logic and intended deep-link surfaces, never against import graph alone.

### 3.2 API-client convention

No app has a "client" directory or generated SDK. The pattern is per-domain hand-written files: a shared low-level transport wrapper per app (`apps/web/src/lib/api.ts`, `apps/payer-web/src/lib/payer-http.ts`, `apps/admin-web/src/lib/admin-http.ts`), a domain-scoped client (`lib/<domain>-api.ts` or `lib/<domain>.ts`), and pure view/derivation logic separated into `lib/*-view.ts` files with matching `.test.ts` (e.g. `unlock-view.ts` in both `web` and `payer-web` — confirmed in 06_DEAD_CODE_AUDIT.md as two intentionally-parallel implementations, not duplication).

---

## 4. Flutter apps (2): apps/worker-app, apps/payer-app

| Metric | worker-app | payer-app |
|---|---|---|
| Total `lib/*.dart` files | 199 | 83 |
| `*_screen.dart` | 27 | 18 |
| Files under `*/widgets/*` | 32 | 21 |
| `*_cubit.dart` / `*_bloc.dart` | 23 | 15 |
| `*_repository.dart` (domain interface) | 17 | 1 |
| `*_repository_impl.dart` (data layer) | 16 | 1 |
| `test/**/*_test.dart` | 143 | 36 |

`lib/` top-level: both apps split into `app.dart`, `main.dart`, `core/`, `features/`. worker-app additionally has `router.dart` (top-level, single file) and `l10n/`.

`core/` subdirs — worker-app: `api, auth, config, di, error, nav, observability, otp, push, referral, session, theme, util, widgets`. payer-app: `auth, config, data, di, observability, session, theme, util, widgets` (no dedicated `api/`, `otp/`, `push/`, `referral/`, `error/`, `nav/` — thinner core).

`features/` — worker-app: `applications, auth, chat, consent, invite, kit, name, notifications, profile, profile_tab, resume, settings, splash, swipe, voice, voice_form` (16). payer-app: `account, agency, auth, capacity, credits, find, home, job_posting_chat, jobs, org, referral, shell` (12).

### 4.1 DI pattern — `get_it`, single composition root, zero code-gen

Both apps use `get_it` with one process-wide `final GetIt locator = GetIt.instance;`, wired in `lib/core/di/locator.dart`. **Every registration is a literal, hand-written call** — `registerLazySingleton<T>(() => ...)` or `registerFactory<T>(() => ...)`, each with an explicit `import`. `grep -rn "build_runner|injectable|@injectable"` across both `pubspec.yaml` files returns no matches — **no code-generation/annotation-based DI exists in this repo.**

**Consequence for dead-code judgment**: a repository/cubit/bloc class is reachable in production if and only if it is (a) named inside `locator.dart`'s registration functions, AND (b) the screen that resolves it via `locator<T>()` is itself reachable from routing (§4.2). This is exactly the two-step check Batch 1's DC-1 (6 orphaned widget files) and its "voice_form unreachable from router.dart" ruled-out case both used. Neither app has any `export` barrel file, so there is no second reachability path a static import/DI-registration check could miss.

### 4.2 Routing — differs between the two apps

- **worker-app**: `lib/router.dart` (667 lines) uses `go_router`, with every screen imported explicitly and mapped to a `Routes.x` string constant — import/reference-based, not filesystem-based. A screen absent from this file's route table is unreachable regardless of `get_it` registration.
- **payer-app**: no `go_router`, no dedicated router file. `lib/app.dart`'s `_RootState.build()` is a single conditional: `session == null ? LoginScreen() : AppShell(session: session)` — top-level navigation is a state-driven widget swap, not a route table. **Genuine structural difference from worker-app, not a gap** — payer-app has no one file that enumerates every reachable screen the way `router.dart` does.

payer-app's repository layer is essentially unbuilt outside one feature: only `features/job_posting_chat/{domain,data}/job_posting_chat_repository{,_impl}.dart` follow the worker-app data/domain/presentation split. Every other payer-app feature calls the single shared `core/data/payer_api_client.dart` directly from its cubit. **UNKNOWN whether this is deliberate (thin client mirroring payer-web) or an unfinished layering pass — worth a direct question to the mobile owner (Rishi).**

---

## 5. Scripts inventory

### 5.1 Root `scripts/` (6 files)

| File | Purpose |
|---|---|
| `scripts/staging-smoke.mjs` | Persistent-staging health + optional gated authed-flow smoke check. Wired: `pnpm staging:smoke`. |
| `scripts/staging-smoke.test.mjs` | Node test-runner coverage for the smoke script itself. |
| `scripts/smoke.mjs` | Fast API-liveness + front-of-happy-path check. **No `package.json` alias, no CI workflow reference** — reachable only via direct invocation, referenced from `docs/registers/risks-register.md` and inline comments. |
| `scripts/prod-canary.mjs` | Read-only, write-free production posture canary. **No alias, no CI reference** — manual-ops-runbook only. |
| `scripts/chat-cli.sh` / `scripts/chat-cli.ps1` | Interactive terminal client for the deterministic profiling interview. Dev tool, no CI/package.json wiring. |

### 5.2 App/package-local `scripts/` dirs

| Path | Purpose |
|---|---|
| `apps/ai-service/scripts/build_lexicon_corpus.py` | Builds the profiling lexicon corpus artifact from source data. |
| `apps/payer-web/scripts/verify-assetlinks-release.mjs` | Verifies the Android App Links `assetlinks.json`. No workflow invokes it. |
| `packages/profiling-lexicon/scripts/sync-mirror.mjs` | Byte-identical mirror sync of the shared Hinglish lexicon into `apps/ai-service`'s own tree. |

### 5.3 `packages/db/src` — 83 files (67 non-test, 16 `*.test.ts`), 35 `package.json` script aliases

All CLI-style runners follow `async function main() { ... } main().catch(...)`. Grouped: **Seed** (`seed.ts`, `seed-questionnaire.ts`, `seed-jobs.ts`, `seed-demand.ts`, `seed-skills.ts`, `seed-job-domains.ts`, `seed-question-packs.ts`, `seed-match-vocabulary.ts`, `seed-reach-pool.ts`); **Verify** (`verify-job-domains.ts`, `verify-question-packs.ts`, `verify-demand.ts`, `verify-reach.ts`, `verify-match-v1.ts`); **Embed** (`embed-skill-aliases.ts`, `embed-job-domain-aliases.ts`, `embed-response.ts`); **Backfill/migration-support** (`backfill-worker-skills.ts`, `backfill-job-postings-v1.ts`, `reencrypt-pii-backfill.ts`, `convert-seed-jobs.ts`); **Growth/retag/canonicalization** (`growth-cluster.ts`, `growth-occupation.ts`, `retag-skills.ts`, `generate-domain-aliases.ts`, `mine-chat-aliases.ts`, `normalize-job-domain-aliases.ts`); **Eval** (`eval-occupation-retrieval.ts` wraps `occupation-retrieval-eval.ts` — same-sounding filenames, different roles); **Admin ops** (`bootstrap-admin.ts`, `reset-admin-mfa.ts`, `grant-free-tier.ts`); **Materialize/audit** (`materialize-job-reach.ts`, `audit-job-domains.ts`).

**Naming gotcha for future audits**: `match-v1-cli.ts` sounds like a standalone CLI by its filename but is actually the shared argument-parsing/logging **harness** imported by 7 other runners — it has no `main()` of its own and no `package.json` alias. **Filename suffix (`-cli`, `-eval`) does not reliably indicate standalone-runnable vs. library in this package; check for a trailing `main().catch(...)` and/or a `db:*` alias before classifying a file as dead or as an entrypoint.**

**Confirmed no-alias runnable script**: `score-wedge.ts` (Batch 1's DC-9) — has `main().catch(...)`, is a genuine manually-invoked CLI, but has zero `package.json` script entry.

---

## 6. Migrations — `packages/db/migrations/`

74 numbered SQL files, `0000` through `0073`, contiguous, one-to-one with `meta/_journal.json`'s 74 entries. Naming: `drizzle-kit generate`'s default `NNNN_<adjective>_<name>.sql`, occasionally overridden with an explicit descriptive name (e.g. `0003_harden_workers_pii.sql`). `meta/_journal.json` is the authoritative apply order consumed by `drizzle-kit migrate`; **filename numbering has no meaning to Drizzle independent of the journal** — reachability here is entirely journal-driven, not filesystem-scan-driven.

**Observation, not a finding**: `meta/*_snapshot.json` files are missing for index `32` and `59` — jumps `0031_snapshot.json → 0033_snapshot.json` and `0058_snapshot.json → 0060_snapshot.json`, while the corresponding SQL migrations exist and ARE present in `_journal.json`. **UNKNOWN whether this reflects a `drizzle-kit generate --custom`-style manual SQL migration that intentionally skips a snapshot regeneration, or a real gap in the migration chain's reproducibility.** Flag to Backend Platform / the `migration-reviewer` gate to confirm `drizzle-kit`'s chain resolves cleanly end to end (invariant #10, reproduce-from-empty-DB) before treating it as either benign or a defect.

---

## 7. Rule 4 — dynamic / config-driven / convention-based reachability, by category

| Category | Dynamically/conventionally loaded? | Mechanism | Consequence for dead-code judgment |
|---|---|---|---|
| NestJS provider (controller/service/repository) | **No** — but two sub-patterns defeat a naive import grep | `@Module({ providers: [...] })`, resolved from `app.module.ts`'s `imports` graph | Check whether the DEFINING module is `@Global()` (11 found, §1.2) before concluding "no importer = dead"; check `APP_INTERCEPTOR`/`APP_GUARD`/`APP_FILTER`/`APP_PIPE` tokens (1 found) before concluding "no `@UseX()` decorator = dead" |
| NestJS BullMQ processor | **No**, but the producer→consumer edge is a **string constant**, not an import | `BullModule.registerQueue({ name: X })` in one module, `@Processor(X)` in another | Grep the queue-name constant, not the processor class name, to find its trigger |
| FastAPI router | **No** — fully static, single choke point | Explicit `import` + explicit `app.include_router(x.api_router)` call, both in `app/main.py` | The strongest static guarantee in the repo: absence from `main.py`'s `include_router` list is conclusive deadness (cf. DC-4) |
| Next.js App Router page/layout/error/loading/not-found | **Yes** — filesystem/path convention | Next.js build resolves `app/**/{page,layout,error,global-error,not-found,loading}.tsx` by directory path alone | Import-graph search is **invalid** for these files; check nav/redirect logic and intended deep-link/bookmark surfaces instead (cf. DC-2) |
| Next.js API route (`route.ts`) | Would be filesystem-based if present | N/A — **zero exist across all 3 Next.js apps** (verified) | Not a live category in this repo today |
| Flutter `get_it` DI registration | **No** — no code-gen/reflection found | Literal `register*<T>()` calls in `locator.dart`, each with a hand-written import | A class not named in `locator.dart` is unreachable; combine with the router check below |
| Flutter routing | **worker-app: No** (import/reference-based `go_router` table) — **payer-app: partially** (state-driven widget swap, no enumerable route table) | worker-app: `Routes.x` constants + explicit screen imports. payer-app: `app.dart`'s conditional + ad hoc `Navigator.push` | worker-app has one file to check for screen reachability; payer-app does not |
| `packages/db/src` CLI scripts | **Partially** — reachable via `package.json`'s `scripts` string keys, not an import graph | `"db:x": "tsx src/x.ts"` in `packages/db/package.json` | A file with no matching `db:*` alias (`score-wedge.ts`, confirmed) is not dead, but is invisible to any sweep that only enumerates aliases |
| Root/app-level `scripts/*.{mjs,sh,ps1}` | **Partially** — some via `package.json`, some via docs/runbook reference only | No `.github/workflows/` reference for 4 of the 6 root scripts; reachable only via manual invocation named in `docs/registers/`/inline comments | A CI-workflow-only reachability sweep would misclassify all four as dead; they are live, human-invoked operational tooling |
| Drizzle migrations | **Yes** — filename-number + journal order, no import graph applies at all | `meta/_journal.json`'s `entries[].tag`, consumed by `drizzle-kit migrate` | A migration is reachable iff it is journaled, full stop |

---

## Files referenced as evidence

`apps/api/src/app.module.ts`, `apps/api/src/main.ts`, `apps/api/src/pricing/pricing.module.ts`, `apps/api/src/referrals/referral-attribution.module.ts`, `apps/api/src/queue/queue.module.ts`, `apps/api/src/push/push.module.ts`, `apps/ai-service/app/main.py`, `apps/ai-service/app/contracts.py`, `apps/worker-app/lib/core/di/locator.dart`, `apps/worker-app/lib/router.dart`, `apps/payer-app/lib/core/di/locator.dart`, `apps/payer-app/lib/app.dart`, `apps/payer-app/lib/core/data/payer_api_client.dart`, `packages/db/package.json`, `packages/db/src/match-v1-cli.ts`, `packages/db/src/eval-occupation-retrieval.ts`, `packages/db/migrations/meta/_journal.json`.

Not re-derived (see Batch 1): `01_SYSTEM_BOUNDARY.md`, `06_DEAD_CODE_AUDIT.md`, `19_PROJECT_SNAPSHOT.md`, `BRANCH_BASELINE.md`.
