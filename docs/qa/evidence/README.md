# QA Evidence Artifacts

This folder is the canonical home for manual QA artifacts: screenshots, logcat
captures, staging event exports, API responses, and smoke-test output.

The tracker file `docs/tracker/QA_EVIDENCE.md` is the written index. Keep large
artifacts here and link to them from the tracker.

## 2026-07-23 Verification — `web app/` contents (payer-web login fix, TD110)

### `web app/` — 6 PNG screenshots, captured 2026-07-23, local dev vs. the shared Supabase DB

Company/Employer payer-web login round-trip, captured right after fixing the shared-DB
migration-journal drift documented in [TD110](../../registers/tech-debt-register.md)
(`payer_orgs`/`payer_members` were 14 migrations behind `main`, crashing every payer login
on verify). Full index + verdict in
[QA_EVIDENCE.md](../../tracker/QA_EVIDENCE.md#2026-07-23--payer-web-login-fix-verification-6-png-screenshots-td110).

| Shot | Screen | Verdict |
| ---- | ------ | ------- |
| `115022` | Dashboard, fresh login | 0 unlocks / 0 postings — clean new-account state |
| `115115` | Post a job form | CNC Operator role filled in |
| `115142` | Manage postings | Created posting shows as DRAFT |
| `115200` | Capacity page | Concurrent allowance (0/15) + mock buy-capacity tiers render |
| `115222` | Dashboard, dark mode | Theme toggle works, session persists |
| `115233` | Account menu open | `RVM Beyond` / `goldyjupiter@gmail.com` / role `EMPLOYER` / status `PENDING` |

**Gap:** Agency-tab click-through not captured here — the agent role was verified at the
backend/DB level only (a direct signup probe + org/membership check), not with an
equivalent screenshot sequence. Add one in the next capture pass for parity.

**5 more shots added same day** (`115509`, `120218`, `120255`, `120304`, `120311`) —
attempted as Agency evidence but are actually a **second successful Employer login** for
the same pre-existing `tech.rvmcad@gmail.com` account (`115509` a stale-code retry, the
rest a clean success). Confirmed by `payers.role = 'employer'` in the DB and the
role-dynamic top-nav reading "For Employers" throughout. Re-signing-up an already-registered
email on a different role tab silently keeps the existing role (`createOrGet`'s
no-enumeration conflict path) rather than creating a new account — see
[TD111](../../registers/tech-debt-register.md). Real Agency-portal screenshots still need a
genuinely unused email signed up via the Agency tab.

---

## 2026-07-10 Verification — current `b1/` contents

### `b1/` — 60 PNG screenshots, captured 2026-07-09 (PR #190; supersedes the 9 numbered JPEGs)

One capture session on Rishi's Linux desktop: **Android emulator inside VS Code**,
apps pointed at a **local backend** (API JSON logs visible in the IDE terminal
alongside the emulator). Two runs:

- **Worker-app run** — `Screenshot from 2026-07-09 12-24-18` → `13-35-01` (25 shots)
- **Payer-app run** (NEW Flutter Company/Agency app, PR #189) — `14-20-41` → `14-44-38` (35 shots)

All 60 were visually audited on 2026-07-10 (10-reader parallel audit; per-shot
descriptions indexed in [QA_EVIDENCE.md](../../tracker/QA_EVIDENCE.md)).

#### Worker-app coverage (what the shots show)

| Flow | Shots | Verdict |
| ---- | ----- | ------- |
| Login → mock-OTP → session | 12-24-18, 13-13-01, 13-14-24 | **Live local API round-trip** — OTP screen says "(mock — any 4-6 digits)" (mock provider by design, §8); backend OTP log lines visible in terminal |
| PIN gate + PIN reset (ADR-0026) | 12-32-37, 13-16-05 | Screens render; reset pre-submit only |
| Splash / language | 13-12-43 | Static UI |
| Resume (returning worker) | 13-14-39, 13-25-08 | **Wired** — shows the logged-in tester's real name from the API ~60s after login; body still "(to be confirmed)" drafts (no chat extraction done this session) |
| Alerts | 13-25-25 | Seeded-looking list; badge count dynamic |
| Profile tab | 13-25-40, 13-29-59 | **Mock** (known gap — shows seed persona "Ramesh Kumar" while resume shows the real tester; "ProFile" title typo) |
| Settings + DPDP delete dialog (ADR-0026 P5) | 13-26-19, 13-26-52 | Entry points render; pre-action only |
| Referral invite (A3) | 13-26-29, 13-26-37 | **PR #189 HIGH fix proven** — non-empty link `https://app.badabhai.in/i/2a4c2bcc5fdb` in the native share sheet |
| Interview kit list + Q&A | 13-27-08, 13-27-18 | Renders; content indistinguishable from bundled static |
| Applied jobs (A1) | 13-27-44 | **Wired** — 2 application rows over seeded jobs from `GET /workers/me/applications`; raw slug `cnc_operator` shown verbatim (polish) |
| Job detail + swipe deck (ADR-0009) | 13-28-51, 13-30-35, 13-34-03, 13-34-13 | Seeded feed renders, live mid-swipe gesture, per-job "spots left"; distance filter not constraining the seeded feed (Pune 15 km shows Coimbatore/Gujarat jobs) |
| Jobs filter sheet | 13-30-50, 13-31-45 | Client-side selection state works |
| Resume safe-fields edit | 13-35-01 | UI works; save round-trip not evidenced (known mock gap) |

#### Payer-app coverage (what the shots show)

The payer-app shots are a **debug build with the Flutter DEBUG ribbon**, largely in
**mock mode** (`kUseMocks` seam; an orange "Mock"-style ribbon is visible on several
frames). They prove the 14-screen role-aware UI (Desi Vernacular Pop) end-to-end —
**not** live backend wiring.

| Flow | Shots | Verdict |
| ---- | ----- | ------- |
| Company dashboard | 14-20-41 (4 stat tiles OVERFLOWED), 14-30-40 (fixed retake) | Layout bug caught + fixed mid-session; identical "12 min ago" timestamps across 10 min ⇒ static activity data |
| Browse & unlock (masked candidates) | 14-21-00 (names hand-redacted with black bars), 14-31-00 (in-app `R•••• K.` masking retake), 14-44-38 | Masking implemented between takes; final shot shows per-candidate unlock state (1 revealed, 4 at ₹40) |
| Unlock dialog + unlocked candidate | 14-31-11, 14-31-25 | ⚠️ unlocked detail displays a **raw full phone** (`+91 98765 43210` — dummy seed) — deviates from ADR-0010 Stream A in-app relay / no-raw-phone-reveal; fix before any real data |
| Postings + post-job (Company) | 14-31-53, 14-32-18, 14-32-30 | All card states render; pre-submit only |
| Credits buy | 14-32-49, 14-33-03 | **Mock-state bug:** balance 199→2199 while toast says "1,000 added"; ledger static (+209 ≠ balance) |
| Account + edit | 14-33-20, 14-33-26, 14-43-47, 14-43-52 | demo@badabhai.in; phone masked last-4 |
| Team (b5x UI) | 14-33-36, 14-33-45, 14-33-52, 14-44-05 | Masked emails; mock mismatch — `@kalyani.in` members under the Apex Staffing login |
| Hiring capacity (ADR-0016) | 14-34-01, 14-34-09, 14-43-59, 14-44-14 | Tier/price sheet matches config; "Razorpay · UPI / card" copy while payments are mock (copy overstates) |
| Agency: signup → dashboard | 14-40-56, 14-42-06, 14-42-23 | Role-aware login; seeded "Apex Staffing" dashboard ~17s after Get OTP |
| Agency: post-job, jobs list | 14-42-36, 14-43-36 | Banded posting form; Open/Closed states |
| Agency: Earn / referrals / payouts / KYC | 14-42-48, 14-42-57, 14-43-04, 14-43-11, 14-43-21, 14-43-27 | **Design-only surfaces per PR #189** (payouts/KYC have no backend route); referral link `badabhai.in/r/APEX-7K2` populated; masked worker rows; KYC "Not started" vs payout history = mock inconsistency |

#### What this proves

- Worker-app **client→local-API wiring is real** for login/OTP(mock)/resume/applied-jobs/referral (PR #189 claims hold on the flows captured).
- The payer-app's **14 screens exist and are on-brand**, with masking + ₹ patterns rendering; the mid-session iteration (overflow fix, in-app masking) is visible across retakes.
- The PR #189 HIGH referralLink fix produces a real link in both apps.

#### What this does NOT prove (B1 stays PARTIAL / NO-GO)

- **Emulator, not a real handset. Local backend, not staging.** No staging `/health`, no staging `events` chain, no clean-logcat capture, no PDF-open + `resume.downloaded` proof — the four missing B1 families are unchanged.
- Payer-app shots are mock-mode: no live payer API round-trip is evidenced.
- No chat → extraction → profile-confirm sequence was captured (resume body is all "(to be confirmed)").

#### Evidence-hygiene notes (fix in the next capture run)

1. A real personal phone number `+918946991002` is fully visible in 4 worker-app shots (login/OTP/PIN-reset). It is the tester's own number, but committed evidence should use a masked or synthetic number — re-shoot or redact next run.
2. `14-21-00` needed manual black-bar redaction (pre-masking build) — superseded by the in-app-masked retake; prefer dropping the redacted original from future sets.
3. Crop future captures to the emulator frame — IDE panels leak terminal/logcat fragments and the desktop username.
4. Several payer screens are byte-duplicates (14-43-21, 14-44-14) — trim on capture.

---

## 2026-06-30 Verification (superseded)

The original `b1/` set — 9 numbered JPEGs (`01-splash-language.jpeg` …
`09-jobs-swipe-card-2.jpeg`) verified on 2026-06-30 — was **removed and replaced**
by the 2026-07-09 set in PR #190. The historical index row remains in
[QA_EVIDENCE.md](../../tracker/QA_EVIDENCE.md) (2026-06-30 entry).

Current B1 evidence status: **PARTIAL**. Do not mark B1 GO until a **real handset**
run against **staging** produces screenshots + staging events + clean logcat + the
PDF-open proof (D5).
