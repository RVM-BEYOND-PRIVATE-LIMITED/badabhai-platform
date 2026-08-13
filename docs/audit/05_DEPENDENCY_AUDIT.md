# 05 — Dependency Audit

Three independent toolchains, audited separately: TypeScript/Node (pnpm workspace), Python (apps/ai-service), and Dart/Flutter (apps/worker-app, apps/payer-app). Every `SUSPECTED_UNUSED` claim below is a static-grep heuristic, not proof — a candidate for human verification, not a removal recommendation. Nothing was removed or modified.

---

## Part 1 — TypeScript/Node (pnpm workspace)

Scope: `apps/api`, `apps/web`, `apps/payer-web`, `apps/admin-web`, all `packages/*`, and the workspace root. `apps/ai-service` and the Flutter apps are not pnpm workspace members (`pnpm-workspace.yaml` says so explicitly) — covered in Parts 2 and 3.

**Method**: `pnpm list --depth 0` at root and every workspace, `pnpm why <pkg>` for every package resolving to more than one version, direct `package.json` inspection for all 17 TS workspaces, `pnpm audit`, `pnpm outdated -r`, targeted `grep` of each package's `src/` for the import name of every declared dependency. 96 packages resolved across 18 pnpm-recognized projects, 625 unique package names in the lockfile.

### 1.1 Workspace inventory

| Workspace | Prod deps | Dev deps |
|---|---|---|
| root (`badabhai-platform`) | 0 (no `dependencies` key) | 12 |
| `apps/api` | 23 (11 workspace links) | 4 |
| `apps/web` | 5 (2 workspace links) | 3 (1 workspace link) |
| `apps/payer-web` | 8 (3 workspace links) | 3 |
| `apps/admin-web` | 6 (0 workspace links) | 3 |
| `packages/db` | 8 (6 workspace links) | 4 (1 workspace link) |
| `packages/config` | 1 (zod) | 1 |
| `packages/event-schema`, `ai-contracts`, `match-engine`, `pricing`, `taxonomy`, `validators` | 1–2 (mostly zod + workspace links) | 0 |
| `packages/reach-engine`, `types`, `profiling-lexicon` | **0** | 0 |
| `packages/reach-learn` | 1 (workspace link only) | 0 |
| `tests/e2e` | 1 (workspace link) | 3 |

`packages/types`, `packages/reach-engine`, `packages/profiling-lexicon` have **zero** external dependencies — confirmed by direct `package.json` read and a `grep` across each package's `src/` for any non-relative, non-`@badabhai` import (zero hits in all three). `apps/ai-service`, `apps/worker-app`, `apps/payer-app`, `apps/android` are correctly **absent** from `pnpm list` — Python/Flutter manage their own toolchains by design.

### 1.2 Dependency classification (representative — full detail per workspace omitted where the pattern is "REQUIRED_RUNTIME, confirmed by N import hits")

**apps/api** — `@nestjs/{common,core,platform-express}`, `@nestjs/bullmq`+`bullmq`, `@nestjs/jwt`, `drizzle-orm` (75 files), `zod`, `reflect-metadata`, `nodemailer`, `razorpay` (gated by `PAYMENTS_ENABLE_REAL`, but genuinely exercised in tests) all REQUIRED_RUNTIME. 11 `@badabhai/*` workspace links, all resolved via `link:../../packages/*` (not npm-published, no version drift possible by construction). One notable INDIRECT_RUNTIME: **`multer`** is not in `package.json` at all — pulled in only transitively via `@nestjs/platform-express`; `grep -r "FileInterceptor\|from 'multer'" apps/api/src` → zero hits. The `pnpm-workspace.yaml` override (`multer: ">=2.2.0"`, closing a GHSA) is a defensive supply-chain patch for a dependency the app doesn't call directly, not evidence of an unused feature.

**apps/web, apps/payer-web, apps/admin-web** — `next`/`react`/`react-dom` (single resolved version each, `next@15.5.22`/`react@19.2.7`, zero drift), `zod`, `qrcode.react` (payer-web, admin-web), `server-only` (confirmed used in both, correcting an initial grep-pattern miss during this audit), `@badabhai/{config,pricing,validators,types}` all REQUIRED_RUNTIME. No app-level `package.json` declares its own `eslint`/`typescript` (root-hoisted pattern).

**packages/\*** — nine of twelve declare only `zod` as a runtime dependency, all REQUIRED_RUNTIME (they exist specifically to be imported by `apps/api` or `packages/db`). `packages/db` is the outlier with real tooling weight: `postgres` (the driver, confined to exactly 2 files: `client.ts`, `score-wedge.ts` — `apps/api/src` never imports `'postgres'` directly), `drizzle-orm`, `drizzle-kit` (dev, REQUIRED_BUILD), `tsx` (dev, backs ~35 `db:*` CLI scripts).

**Root devDependencies** — `turbo`, `typescript` (root-hoisted, consumed by every package's own `tsc` script via Node's parent-directory resolution — a deliberate shared-tooling pattern, not a phantom dependency), `eslint`/`@eslint/js`/`typescript-eslint` (single flat config), `oxlint` (a second, faster lint pass scoped to `apps/payer-web` only), `prettier`, `vitest`/`@vitest/coverage-v8`, `rimraf`, `@types/node`, and **`supabase` CLI** — real, documented (`infra/supabase/local-dev.md`), but **not invoked by any CI workflow** (zero matches for `supabase ` CLI invocation across `.github/workflows/*.yml`) — real, human-run local tooling, simply not exercised by any automated pipeline.

### 1.3 SUSPECTED_UNUSED — zero found

After grepping every declared dependency's import name against its own workspace's `src/`, **zero SUSPECTED_UNUSED direct dependencies were found** anywhere in the TS/Node side. Every declared production and dev dependency resolved to at least one real, non-test-only import site. This is a genuinely low-bloat dependency surface for a 96-package, 18-project TypeScript monorepo.

### 1.4 Duplicate-resolved-version findings (from `pnpm-lock.yaml`)

46 package names resolve to more than one version in the tree. All traced to a **devDependency-only/build-tool fork** except two that reach into `apps/api`'s **production** graph:

| ID | Package(s) | Root cause | Runtime risk |
|---|---|---|---|
| DUP-1 | `type-is`, `mime-types`, `media-typer`, `content-type` (2 versions each) | `type-is@1.6.18` reaches production via `multer@2.2.0` (unused per §1.2); `type-is@2.1.0` via `body-parser@2.2.2` → `express@5.2.1`. Two major lines of the same Express-adjacent helpers live in the same production tree. | Low in practice (neither invoked by app code), but real disk/audit-surface duplication — a human decision on dropping the `multer` transitive is out of scope for a single agent to make unilaterally. |
| DUP-2 | `vitest` + `@vitest/*` satellites | `tests/e2e/package.json` pins `vitest: "^3.0.0"` instead of the root's `^3.2.7`; resolves to `3.2.6` vs `3.2.7` elsewhere. | None functionally (same minor line); one-line fix candidate for whoever owns `tests/e2e` (QA). |
| DUP-3 | `rxjs` | `7.8.1` via `@nestjs/cli`'s dev-only Angular-schematics chain vs `7.8.2` via `apps/api`'s direct dependency. | None — `nest build` uses `tsc`, not a bundler; the dev-only copy never reaches `dist/`. |
| DUP-4…46 | `ajv`, `commander`, `glob`, `minimatch`, `semver`, and 39 others | Two independently-versioned build-tool ecosystems (`eslint` vs `@nestjs/cli`/webpack/`@angular-devkit`) sharing transitive utility packages. | None — confirmed via representative `pnpm why` checks that none of these names appear in any production `src/` import graph. Not itemized individually per the "describe the pattern once" instruction. |

### 1.5 Supply-chain policy (`pnpm-workspace.yaml`) — re-verified live this session

| Setting | Value | Re-verification |
|---|---|---|
| `blockExoticSubdeps` | `true` | `grep -cE "tarball:\|repo:\|git\+\|https://github" pnpm-lock.yaml` → 0 |
| `minimumReleaseAge` | 10080 min (7 days) | Mirrored correctly in `.npmrc` (`minimum-release-age`/`min-release-age`, units differ but both present) |
| `trustPolicy` | `no-downgrade` | — |
| `trustPolicyExclude` | `chokidar@4.0.3`, `undici-types@6.21.0` | Both re-verified as single resolved versions, no drift since the policy was written |
| `overrides` | `multer>=2.2.0`, `esbuild>=0.28.1`, `sharp>=0.35.0`, others | All re-verified: `pnpm why` shows exactly one resolved version each, landed as intended |
| `pnpm audit --audit-level high` | **0 vulnerabilities** | Matches Batch 1's `15_SECURITY_AUDIT.md` note (#788/#792 took this to zero) |
| `pnpm audit` (no floor) | **1 LOW** | `body-parser <2.3.0` — GHSA-v422-hmwv-36x6 (DoS via invalid `limit` silently disabling size enforcement), reached via `apps/api → @nestjs/platform-express → express@5.2.1 → body-parser@2.2.2`. Below the CI gate threshold, not currently blocking. No override exists for it. |

### 1.6 Version currency (informational)

`zod` 3.25.76→4.4.3 (1 major, affects 9 workspaces), `next` 15.5.22→16.3.0, `bullmq` 5.78.0→6.0.8, `vitest` →4.1.10, `eslint` →10.8.0, `typescript` 5.9.3→7.0.2 (major native-port transition), `@nestjs/*` and `react`/`react-dom` are patch-only gaps. None advisory-driven — pure release-cadence lag, most concentrated in `zod`.

---

## Part 2 — Python (apps/ai-service)

No lockfile (no `requirements*.lock`, `poetry.lock`, `uv.lock`, `.python-version`). Dependencies declared as version-range floors across `requirements.txt` (base, always installed), `requirements-ai.txt` (optional real-mode extras, chains `-r requirements.txt`), `requirements-dev.txt` (test/lint, chains only `requirements.txt`) — `pyproject.toml` holds pytest/ruff config only, zero `[project.dependencies]`.

**Python version pin — three-way, not unified**: `pyproject.toml` `>=3.11`; CI job pins `3.12`; Dockerfile pins `python:3.12-slim-bookworm` (deliberate — matches the CI interpreter exactly, per the Dockerfile's own comment). **This local checkout's `.venv`/`__pycache__` artifacts are tagged `cpython-314`** — one minor ahead of both pins; no `.python-version` file anchors local dev.

### 2.1 Classification

| Package | Range | Classification | Notes |
|---|---|---|---|
| `fastapi` | `>=0.115,<1.0` | REQUIRED_RUNTIME | 32 files |
| `uvicorn[standard]` | `>=0.32,<1.0` | REQUIRED_RUNTIME | ASGI server; `[standard]` pulls `uvloop`/`httptools` transitively, 0 direct imports (expected, internal to uvicorn) |
| `pydantic` | `>=2.9,<3.0` | REQUIRED_RUNTIME | Contract layer |
| `pydantic-settings` | `>=2.6,<3.0` | REQUIRED_RUNTIME | Single call site (`app/config.py`) but load-bearing — the entire fail-closed `Settings` object is built on it |
| `httpx` | `>=0.27,<1.0` | REQUIRED_RUNTIME | 48 files — direct Gemini REST transport + test-client transport |
| `redis` | `>=5.0,<6.0` | REQUIRED_RUNTIME | Global AI spend ledger (TD27); lazy-imported only when `AI_SPEND_REDIS_URL` is set, but a top-level `pip install` dependency regardless |
| `langfuse` | `requirements-ai.txt`, `>=4.14,<5.0` | REQUIRED_RUNTIME (conditional) | Guarded local import wrapped in `try/except Exception` — module import succeeds with the package absent, tracing becomes a no-op |
| `anthropic` | `requirements-ai.txt`, `>=0.40,<1.0` | REQUIRED_RUNTIME (conditional) | Same pattern — local import guarded by `except ImportError` → treated as a failed provider, not a crash |
| `pytest` | `>=8.3,<9.0` | REQUIRED_TEST | 126 hits |
| `ruff` | `>=0.8,<1.0` | REQUIRED_BUILD | `select = ["E","F","I","UP","B"]`, line-length 100 |
| `fakeredis[lua]` | `>=2.20,<3.0` | REQUIRED_TEST | In-memory Redis stand-in for spend-ledger concurrency tests |

No package appears with 0 grep hits — **no `SUSPECTED_UNUSED` or `UNKNOWN` entries found** in this manifest.

### 2.2 CI dependency-hygiene coverage

- **`requirements-ai.txt` (langfuse, anthropic) is never installed by the CI `ai-service` job** — that job installs only `requirements-dev.txt`, which chains `requirements.txt`, not `requirements-ai.txt`. CI's ruff/pytest run never actually imports either package; correctness of the guarded-import fallback paths is exercised only once real-mode is armed with the extras installed.
- **No `mypy`** or any static type checker configured anywhere under `apps/ai-service` — typing enforced by ruff's pyupgrade/bugbear rules and code review only.
- **No Python dependency-vulnerability scan.** `.github/workflows/dependency-audit.yml` runs `pnpm audit` only (Node/pnpm exclusive); `.github/dependabot.yml` is scoped to `github-actions` only, with its own comment stating "npm/pip ecosystems are a separate future decision." `security-scan.yml`'s Semgrep ruleset includes `p/python` but that's a code-pattern scan, not a CVE/advisory check against the manifest.
- **No lockfile** — reproducibility across CI/Docker runs depends on PyPI's current latest-matching release within the declared ranges, not a pinned hash set.

### 2.3 Flags

1. No pip/PyPI vulnerability scanning anywhere in the pipeline.
2. No lockfile for the Python manifest.
3. Python version pin is three-way but not centralized, and this checkout's actual venv (3.14) is one minor ahead of the CI/Docker pin (3.12) — no `.python-version` file to anchor local dev.
4. `requirements-ai.txt` never installed by CI — the guarded-import fallback paths for `langfuse`/`anthropic` are unexercised by any automated gate.
5. No `mypy` despite the service's own engineering-contract language ("Python stays typed and ruff-clean").
6. `httpx` redundantly re-declared identically in both `requirements.txt` and `requirements-dev.txt` — harmless, flagged only as manifest duplication.

---

## Part 3 — Flutter (apps/worker-app, apps/payer-app)

**Local toolchain this session**: Flutter 3.27.4 / Dart 3.6.2. Both apps' `pubspec.yaml` floors exceed this (worker-app needs Dart ≥3.9.0, payer-app needs Flutter ≥3.35.0) — `flutter pub get` **failed for both apps this session** with explicit version-solving errors. `flutter pub deps` could **not** be run for either app. Everything below is derived from static `pubspec.yaml` + committed `pubspec.lock` reading + `Grep`-tool import scans, not an executed resolver. `SUSPECTED_UNUSED` = 0 import hits for that package's import prefix — a candidate flag, not a certainty (a package can be consumed transitively via generated code, e.g. `intl`/`flutter_localizations`, without a literal import line — called out explicitly where this applies).

### 3.1 apps/worker-app — SUSPECTED_UNUSED: `cupertino_icons`

24 runtime dependencies checked; all classified REQUIRED_RUNTIME with confirmed import hits **except**:

| Package | Classification | Evidence |
|---|---|---|
| `cupertino_icons` `^1.0.8` | **SUSPECTED_UNUSED** | 0 hits for `package:cupertino_icons` or `CupertinoIcons.` anywhere under `lib/` or `test/` — the stock `flutter create` scaffold dependency, no glyph referenced |
| `flutter_localizations`, `intl` | REQUIRED_RUNTIME (indirect) | 0 direct imports, but consumed transitively via `l10n/gen/app_localizations.dart` (generated at `flutter pub get` time, not committed) — `app.dart:100` wires the delegate into `MaterialApp` |

dev_dependencies (`flutter_test`, `flutter_lints`, `bloc_test`, `mocktail`, `fake_async`) all REQUIRED_TEST/BUILD, confirmed used.

### 3.2 apps/payer-app — SUSPECTED_UNUSED: `cupertino_icons`, `uuid`

| Package | Classification | Evidence |
|---|---|---|
| `cupertino_icons` `^1.0.8` | **SUSPECTED_UNUSED** | Same stock-scaffold pattern as worker-app |
| `uuid` `^4.5.1` | **SUSPECTED_UNUSED** | 0 import hits anywhere. Corroborated by the pubspec's **own comment**: "Random PII-free ids / idempotency keys for future API binding" — declared ahead of use, by the app's own admission |

### 3.3 Cross-app version drift

**`firebase_crashlytics` — real drift, with dueling unreconciled in-repo commentary.** worker-app: `^5.2.6` → locked `5.2.6`. payer-app: `5.2.4` (exact pin) → locked `5.2.4`. payer-app's own comment: "5.2.5's artifact is broken... 5.2.4 is the last compiling build." worker-app's own comment shows the underlying defect was since investigated and resolved by moving to `^5.2.6`. **payer-app's comment still describes the pre-fix state** — flagged as drift; the payer-app owner has worker-app's own reasoning already available to re-check against.

**`firebase_core` — minor lockfile drift on an identical declared constraint.** Both declare `^4.12.0`; worker-app's lockfile resolves `4.12.1`, payer-app's resolves `4.12.0`. Same caret range, no conflict — the two lockfiles were generated at different times and haven't converged. Could not be regenerated locally this session (both apps fail `flutter pub get` on this toolchain).

All other shared dependencies (`flutter_bloc` 8.1.6, `equatable` 2.0.8, `get_it` 7.7.0, `flutter_secure_storage` 9.2.4, `uuid` 4.5.3, `url_launcher` 6.3.2, `http` 1.6.0, `google_fonts` 6.3.0, `cupertino_icons` 1.0.8, `flutter_lints` 5.0.0) declare identical constraints and resolve identically in both apps.

**Adjacent SDK/toolchain floor drift** (not a package dependency, flagged for completeness): worker-app's `sdk: ">=3.9.0 <4.0.0"` traces to TD71 (#462), a deliberately strict floor after a prior incident where a loose floor produced a misleading error. payer-app's `sdk: ^3.6.2` is already self-flagged by its own comment (TD61) as looser than what the app's code actually needs (Flutter 3.35 APIs like `Switch.activeThumbColor`). Matches this engineer's own prior-session TD61 finding — not re-litigated, noted for dependency-audit completeness.

### 3.4 What could not be verified

`flutter pub deps` (full resolved transitive tree) for either app; transitive-dependency CVE exposure (would need a matching toolchain or a dedicated SCA tool); exact locked versions for 14 packages whose **usage** was confirmed but whose **resolved version** was not individually cross-checked against `pubspec.lock`.
