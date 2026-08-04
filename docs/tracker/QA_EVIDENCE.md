# QA Evidence Log

Proof for every progress claim. **A % move without a row here is invalid.** Append-only;
newest first. Paste real terminal output, test counts, API responses, manual notes.

Canonical artifact folder: [`docs/qa/evidence/`](../qa/evidence/). Keep screenshots,
logcat captures, event exports, and API response files there; use this tracker as the
written index.

---

## 2026-08-03 — AP-1 admin foundation gate: **PASS (13/13) on a genuinely empty database**

**Verifier:** Claude (backend thread), executed — not reasoned about. **Commit:** `a4348cbb`
+ the blocker fix in this PR. **Runbook:** [admin-foundation-verification-runbook.md](../admin-foundation-verification-runbook.md).

Environment created by `docker compose down -v` (volumes destroyed), then `pnpm db:up`,
`pnpm mail:up`. Postgres, Redis and Mailpit all reported healthy before step 1.

### It did NOT pass first time — a P0 blocker was found at step 2

`pnpm db:migrate` failed with **zero migrations applied and zero tables created**, and
`drizzle-kit` **exited 1 printing no error at all**. Running the migrator programmatically
surfaced it:

```
MIGRATE FAILED
message: Failed query: REVOKE ALL ON TABLE "workers" FROM anon;
cause  : PostgresError: role "anon" does not exist   (SQLSTATE 42704)
```

**26 of the 64 migrations** REVOKE/GRANT on `anon`, `authenticated`, `service_role` — the
Supabase PostgREST roles. Supabase ships them; the `pgvector/pgvector:pg16` container that
`pnpm db:up` starts does not. So the documented local path **could never have worked from an
empty database**; every existing developer database predates `0004` or was created against
Supabase. This is exactly the failure mode CLAUDE.md invariant #10 exists to catch, and it
was invisible until someone actually ran it.

Fixed in the **environment**, not the migrations: `infra/docker/postgres-init/00-supabase-roles.sql`
creates the three roles (NOLOGIN) on first boot. Editing 26 shipped migrations would change
their hashes and make databases that already ran them re-apply all 26.

### After the fix — the documented path, start to finish

| # | Step | Result |
|---|---|---|
| 1 | Empty DB (`down -v` → `db:up`) | 0 tables, no `drizzle` schema — verified, not assumed |
| 2 | `pnpm db:migrate` | ✅ **64 migrations applied, 55 tables** |
| 3 | Bootstrap CLI | ✅ created `super_admin` `80e2b2a0…`, status `active`; email never printed (hash prefix only) |
| 3b | **Bootstrap run a second time** | ✅ **REFUSED, exit 0**, `admin_users` count stayed **1** |
| 4 | Email delivery | ✅ real SMTP → Mailpit, subject "Your BadaBhai admin login code" |
| 5 | OTP verify | ✅ `{"status":"mfa_required","needs_enrollment":false}` — **no `access_token`** |
| 6 | TOTP enrolment | ✅ seed from `--with-totp` accepted by an RFC-6238 generator |
| 7 | Session | ✅ `access_token` minted **only after** the second factor |
| 8 | Refresh | ✅ 200, and the returned token **differs** from the old one (rotated) |
| 9 | Logout | ✅ 204 — **and the logged-out token then returned 401** (the assertion that matters) |
| 9b | Pre-refresh token | ✅ also 401 — rotation does not leave a live predecessor |
| 10 | Re-login | ✅ second code delivered (2 messages in Mailpit) |
| 11 | MFA challenge | ✅ `needs_enrollment: false` — the seed **persisted**, was not re-issued; still no session pre-MFA |
| 12 | Events | ✅ `admin.session_started` → `admin.session_revoked` → `admin.session_started`; **no email, no OTP code, no TOTP secret** anywhere in the payloads |
| 13 | Capabilities | ✅ `/admin/me` returned all **9** capabilities for `super_admin` |

`GET /health` during the run: `database: up`, `redis: up`, and `ai_posture: "mock"` — the
mocked-AI state is honestly reported rather than hidden behind a bare 200 (TD81's mitigation
visible in practice).

### Consequence

**The ADR-0038 foundation is proven reproducible from zero.** Admin Portal UI work (ADMIN-4)
is unblocked. The AP-1 P1 blocker in [BLOCKERS.md](BLOCKERS.md) is cleared.

### Noted, not fixed here (no opportunistic changes)

- **`drizzle-kit migrate` swallows the failure entirely** — silent exit 1, no message, while
  the same SQL applied fine under `psql`. This cost the whole diagnosis. Logged as **TD133**.
- CLAUDE.md and the ADMIN brief say **43 tables**; the real count from a clean migrate is
  **55**. Doc drift only — `schema.ts` is the source of truth.
- The admin OTP email's From identity resolved to an `@rvmcad.org` address from the local
  environment, not the `EMAIL_FROM_ADDRESS` passed for the run (`SMTP_FROM` wins in
  `sendViaSmtp`). Harmless locally; worth confirming for staging/production sender identity.
- The bootstrap CLI's refusal message points to `POST /admin/invite`; the route inventory
  records `POST /admin/admins`. Message text only, no behavioural impact.

---

## 2026-07-25 — B1 worker capstone + swipe handset (team attestation)

**Verifier:** Divyanshu Pant — **B1 worker capstone VERIFIED** (staging/real stack: worker
login through resume path accepted as complete for alpha tracking).

**Verifier:** Prakash Kantumutchu — **Swipe feed / apply / skip VERIFIED on a real handset**
(not emulator).

**Payer surfaces (same date, status only — not a gate pass):** Company (employer) and Agency
(payer-web / demand flows) remain **IN_PROGRESS**. **OTP login/send works**; post-login
features (full click-through gates 1 and 2) are **not yet verified end-to-end**.

**Artifacts:** No new files under `docs/qa/evidence/staging/` in this pass — attestation-only
(rows valid per team sign-off; capture screenshots + events export on next run to close P2 in
[BLOCKERS.md](BLOCKERS.md)).

**Tracker impact:** Updates [PROJECT_STATUS.md](PROJECT_STATUS.md), [TEST_MATRIX.md](TEST_MATRIX.md)
gate 3 + swipe row, [BLOCKERS.md](BLOCKERS.md), [DAILY_TRACKER.md](DAILY_TRACKER.md),
[.claude/project-memory.md](../../.claude/project-memory.md), [.claude/team-memory.md](../../.claude/team-memory.md).

---

## 2026-07-23 — Payer-web login fix verification (6 PNG screenshots, TD110)

**Source checked:** [`docs/qa/evidence/web app/`](../qa/evidence/web%20app/) (6 screenshots,
`115022`–`115233`), local dev against the shared Supabase DB (`localhost:3002` payer-web →
`localhost:3001` api).

**Context:** payer login (email OTP) was crashing on verify with `PostgresError: column
"org_id" does not exist`, masked client-side into a misleading "Invalid or expired code"
(no-enumeration verify handler collapses any exception to one message). Root cause was
shared-DB migration-journal drift — `payer_orgs`/`payer_members` were 14 migrations behind
`main` (see [TD110](../registers/tech-debt-register.md)). Fixed by hash-diffing every
migration against the DB journal and applying the 16 genuinely-missing ones.

**Artifacts present:** `115022` dashboard (0 unlocks/postings, fresh employer login) →
`115115` post-a-job form filled → `115142` manage-postings showing the created "CNC Operator
Urgent Requiement" draft → `115200` capacity page (concurrent-allowance + mock buy-capacity
tiers) → `115222`/`115233` dashboard in dark mode + account menu open (`RVM Beyond`,
`goldyjupiter@gmail.com`, role `EMPLOYER`, status `PENDING`).

**Verdict:** **Company/Employer login → dashboard → post-job → manage-postings → capacity
verified working end-to-end**, session persists across pages, dark-mode toggle works. Agent
(agency) role verified separately and independently via a direct `POST /payer/signup`
(role=`agent`) probe against the live API + a DB check confirming the solo org + owner
membership were created without error — the fix is role-agnostic (`verifyLogin` has no
role branch).

**Not staging** — this is local dev against the shared cloud DB, not a staging deploy; does
not itself move any B1/alpha percentage. It closes the payer-web login regression that was
blocking this at all.

### Follow-up (same day) — 5 more screenshots (`115509`, `120218`–`120311`), NOT agency evidence

A second capture round was added expecting to show the Agency portal (Agency tab selected
at login for `tech.rvmcad@gmail.com`). It doesn't: `115509` is a stale-code retry (same
"Invalid or expired code" as the earlier failure — expected, not a regression); `120218`
onward is a **second successful login for the SAME account, which is Employer-role** —
confirmed both by the DB (`payers.role = 'employer'`, `created_at` = this account's
original signup earlier the same session) and by the payer-web top-nav, which is
role-dynamic (`for {isAgency ? "Agencies" : "Employers"}`,
[`layout.tsx:53`](../../apps/payer-web/src/app/(portal)/layout.tsx#L53)) and reads "For
Employers" in every shot. Reason: `tech.rvmcad@gmail.com` already had an Employer account
from earlier testing, and re-running signup on the Agency tab with the same email hit
`createOrGet`'s no-enumeration conflict path, which silently keeps the EXISTING role/org
rather than creating a new Agency account or erroring — logged as
[TD111](../registers/tech-debt-register.md). **Net value of this round:** a second,
independent confirmation the TD110 fix holds on repeat use. Agency-role UI screenshots are
still open — needs a genuinely unused email signed up via the Agency tab.

---

## 2026-07-10 — B1 evidence refresh audit (60 PNG screenshots, PR #189/#190)

**Source checked:** [`docs/qa/evidence/b1/`](../qa/evidence/b1/) at `origin/main` `905fd1f`.

**Artifacts present:** 60 PNGs (`Screenshot from 2026-07-09 12-24-18.png` …
`14-44-38.png`), committed by PR #190; the 9 numbered JPEGs from 2026-06-30 were
**removed** in the same PR. Capture context: Android **emulator** inside VS Code on
Rishi's Linux desktop, apps pointed at a **local backend** (API JSON logs visible in
the IDE terminal). Two runs: worker-app 12:24–13:35 (25 shots), NEW Flutter
payer-app (Company + Agency, PR #189) 14:20–14:44 (35 shots).

**Method:** all 60 read + described by a 10-reader parallel visual audit
(per-shot app / screen / visible data / wiring verdict / PII / anomalies); flow map
now lives in [`docs/qa/evidence/README.md`](../qa/evidence/README.md).

**Verdicts:**

- **Worker-app: real client→local-API wiring evidenced** — mock-OTP round-trip
  (screen shows "(mock — any 4-6 digits)", §8-compliant), returning-worker resume
  carrying the tester's real name from the API, Applied Jobs list served by
  `GET /workers/me/applications` (A1), referral share link populated
  (`app.badabhai.in/i/2a4c2bcc5fdb` — the PR #189 HIGH empty-link fix proven).
  Profile tab still mock (seed persona ≠ resume identity), job-detail synthesized.
- **Payer-app: UI-complete, mock-mode** — Flutter DEBUG ribbon on every frame,
  "Mock"-style ribbon on several; static activity timestamps across retakes; credits
  buy shows a mock-state bug (balance 199→2199 vs toast "1,000 added", ledger
  static); Team roster org-mismatched to the login; payouts/KYC internally
  inconsistent (design-only surfaces per PR #189). Proves the 14 role-aware screens
  render on-brand with masking (`R•••• K.`, last-4 phone, masked emails) — does NOT
  prove live payer API wiring.
- **Design-iteration captured mid-session:** dashboard stat-tile overflow at 14:20
  fixed by the 14:30 retake; hand-redacted candidate names at 14:21 replaced by
  in-app masking at 14:31.

**Findings to act on:**

| # | Finding | Class |
| - | ------- | ----- |
| 1 | Tester's real phone `+918946991002` fully visible in 4 committed shots | Evidence hygiene — redact/re-shoot next run |
| 2 | Payer unlocked-candidate screen renders a **raw full phone** (dummy `+91 98765 43210`) | Design deviation from ADR-0010 in-app relay — fix in payer-app before real data |
| 3 | "Secure checkout · Razorpay · UPI / card" copy while payments are mock (ADR-0013/0016) | Copy overstates — align before alpha payers see it |
| 4 | Credits toast/balance/ledger mock bug (199→2199 vs "+1,000") | Payer-app mock-layer bug (adjacent to the PR #189 fetchCredits 0-mask fast-follow — the 0-mask itself was FIXED 2026-07-15 on `fix/td62-consent-routing-and-payer-fastfollows`: CreditsCubit now keeps last-known balance + error flag, never emits a fabricated 0) |
| 5 | Worker "ProFile" title casing; raw `cnc_operator` slug in Applied Jobs; seeded feed ignores distance filter | Polish (worker-app) |

**Verdict:** B1 evidence remains **PARTIAL — NO-GO unchanged.** The screenshot
family is refreshed and much richer, but all four missing families are the same:
staging `/health`, staging `events` chain, clean logcat, PDF-open +
`resume.downloaded`. Emulator+local ≠ handset+staging. **No % move from screenshots
alone; Worker App +2 (67→69) comes from the merged PR #189 wiring itself, evidenced
by this audit** (see [PROJECT_STATUS.md](PROJECT_STATUS.md)).

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
