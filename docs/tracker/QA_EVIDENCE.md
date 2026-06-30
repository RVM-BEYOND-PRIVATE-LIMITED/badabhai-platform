# QA Evidence Log

Proof for every progress claim. **A % move without a row here is invalid.** Append-only;
newest first. Paste real terminal output, test counts, API responses, manual notes.

Canonical artifact folder: [`docs/qa/evidence/`](../qa/evidence/). Keep screenshots,
logcat captures, event exports, and API response files there; use this tracker as the
written index.

---

## 2026-06-30 — Evidence-folder verification

**Source checked:** [`docs/qa/evidence/b1/`](../qa/evidence/b1/)

**Artifacts present:** 9 JPEG screenshots:
`01-splash-language.jpeg`, `02-login-phone.jpeg`, `03-profile-tab-logout.jpeg`,
`04-jobs-filter.jpeg`, `05-alerts.jpeg`, `06-profile-tab-kit.jpeg`,
`07-resume-text.jpeg`, `08-jobs-swipe-card-1.jpeg`, `09-jobs-swipe-card-2.jpeg`.

**Visual spot-check:** splash/language, login, profile/logout, jobs filter, alerts,
profile/kit, resume text preview with Download PDF button, and jobs swipe-card screens
are present.

**Verdict:** B1 evidence is **PARTIAL**, not GO. The screenshots satisfy the screenshot
artifact family, but the B1 gate still needs:

- staging `/health` proof for the API used by the handset,
- staging `events` export for the worker run,
- clean logcat showing no raw phone/name/OTP/PIN/token,
- PDF-open proof plus `resume.downloaded` event because D5 made PDF required for alpha.

No progress percentage was moved from this evidence alone.

---

## 2026-06-29 (b) — Re-verify after concurrent ADMIN-3b commit

**Trigger:** A **concurrent session committed ADMIN-3b** during this audit. HEAD moved `44aa62a` → `0635aee`
("ADMIN-3b — reason-gated, audited, rate-capped worker-PII reveal"). That git activity also **deleted 7 of
the 12 untracked tracker files** I had just written (collateral loss of untracked files; they were re-created).

**Re-verify of the committed state (`0635aee`):**
| Gate | Command | Result |
| ---- | ------- | ------ |
| Lint | `pnpm lint` | ✅ **exit 0** — 0 errors, 1 pre-existing warning (`tests/e2e/helpers/payer-session.ts:46` `no-explicit-any`) |
| Typecheck | `pnpm typecheck` | ✅ **exit 0** — 23/23 tasks |

→ The lint/typecheck errors recorded in the first pass (below) were **transient mid-edit WIP**; the committed
ADMIN-3b is clean. dto.ts:42 escape fixed; service.ts no longer references the missing imports.

**⚠️ Operational note for the team:** running a second session in the same working tree caused **uncommitted/untracked
file loss**. Recommend: one session per working tree, and **commit the tracker** so it is not vulnerable as untracked.

---

## 2026-06-29 (a) — Baseline audit (Phases 1–4, read-only, local)

**Env:** Windows, no Docker, branch `feat/admin-3b-pii-reveal`; at audit start HEAD `44aa62a` + uncommitted ADMIN-3b WIP. No staging.

### Static + build gates (first pass — see (b) for the corrected, committed state)
| Gate | Command | Result | Detail |
| ---- | ------- | ------ | ------ |
| Lint | `pnpm lint` | ❌→✅ | First pass: 1 error in uncommitted ADMIN-3b WIP. **Now green** (see (b)). |
| Typecheck | `pnpm typecheck` | ❌→✅ | First pass: `TS2304` ×2 in uncommitted WIP. **Now green** (see (b)). |
| Format | `pnpm format:check` | ❌ | "Code style issues in 469 files". **NOT a CI gate** (ci.yml runs lint/oxlint/typecheck/test/build, not format:check). Hygiene only. |
| DS token gate | `pnpm lint:oxlint` | ✅ | payer-web no raw hex/px |
| Build | `pnpm build` | ✅ | 13/13 turbo tasks. NOTE: `@badabhai/api` build = `nest build` (transpile) — does not full type-check; `typecheck` is the real type gate (now green). |

### Tests
| Suite | Command | Result | Counts |
| ----- | ------- | ------ | ------ |
| TS unit/integration | `pnpm test` | ✅ (exit 0, 23/23 turbo tasks) | **api 1141/1141**, **payer-web 517/517** (55 files), + shared pkgs. Nest ERROR/WARN lines = intentional fail-closed test assertions, not failures. |
| E2E | `@badabhai/e2e test` | ⏭️ **143 SKIPPED** (10 files) | Need real Postgres + Redis (`RUN_E2E=1`). Run only in CI `e2e` job. Not locally verified. |
| AI service | `pytest` | ✅ | ~220 passed, 1 skipped. `ruff` not installed locally (exit 127) — CI covers lint. |
| Flutter | `flutter analyze && test` | ⚠️ NOT RUN | Flutter not installed on this machine. CI `worker-app.yml` (blocking) covers it; 46 test files present. |

### Repo / git findings
- `DEV_QUICK_LOGIN`: **0 references** in `apps/api/src` — confirmed removed (real-only OTP, commit `d2f228e`). Recorded **DEAD**.
- Schema: **32 `pgTable`** in `packages/db/src/schema.ts` vs CLAUDE.md "30 tables" — doc drift to reconcile.
- Migrations: **29** SQL files (0000–0028), contiguous.
- Stray untracked root file `DB_COMPARE_bug2-staginf_vs_main.md` (move into docs/ or remove).

### Sub-agent audit reports (read-only) captured
- payer-web: 13 flows; Login/Dashboard/Post-Job/Applicants/Unlock/Reveal/Credits/Capacity/Agency = live+tested; Team + Account = stubbed/PARTIAL.
- worker-app: default mode = **REAL** (`USE_MOCKS=false`); core onboarding→resume = real+tested; profile-tab/notifications/settings/voice = mock/placeholder.
- backend: 27 modules; **posting-plans money route UNGUARDED (IDOR, P1)**; unlocks rides InternalServiceGuard + body payer_id (LC-1); OTP breaker/kill-switch/health/credit-idempotency verified.
- infra/security: master CI blocking+green; staging CD **inert until wired**; security-scan advisory; no NEXT_PUBLIC secret leak; fail-closed boot gates; 24 DS primitives + ~90 tokens; RLS = service-role today (deferred).

### NOT yet evidenced (cannot claim > listed cap)
- ❌ Any staging deploy / public `/health` 200 from a real host.
- ❌ Real OTP delivery (SMS/email) end-to-end.
- ❌ Worker-app run on a real handset (alpha B1).
- ❌ E2E suite green against real PG+Redis locally.
- ❌ Manual click-through of any payer/agency/worker flow on real infra.

---
_Next evidence to capture: (1) local e2e against scoop PG+Redis; (2) staging deploy + /health; (3) handset B1 run; (4) posting-plans guard test._
