# B1 — Alpha device-capstone: turnkey runbook + evidence pipeline

> **Purpose:** make the B1 handset run a copy-paste exercise. B1 is the SOLE alpha
> blocker ([alpha-capstone-fixlist.md](../registers/alpha-capstone-fixlist.md)). GO requires
> a **real Android handset** (NOT CI, NOT emulator) pointed at **staging** completing
> login → consent → chat (≥3 turns) → profile-confirm → resume-text, with **3 evidence
> artifacts**. Builds on [phase-1-alpha-device-capstone.md](phase-1-alpha-device-capstone.md).
>
> **Owner:** qa-engineer (run + verdict). **Support:** devops (staging), mobile (build/install),
> product (sign-off), debugging-engineer (only on a real built-path failure).

## ⛔ Two prerequisites that gate the run (not yet satisfied)

1. **STAGING IS NOT DEPLOYED / NO URL EXISTS.** Every staging reference in the repo is a
   `<staging-api>` placeholder. The app's `API_BASE_URL` defaults to `http://localhost:3001`.
   **DevOps must stand up the staging API + Supabase + Redis and provide the concrete HTTPS
   URL** before the phone is touched. Acceptance: `GET <staging-api>/health` → `200 {status:ok}`
   from the handset's network, and mock-OTP login works against it. Turnkey path:
   [staging-service-deploy-runbook.md](../ops/staging-service-deploy-runbook.md) +
   [staging-cd.yml](../../.github/workflows/staging-cd.yml) (the guarded CD + `pnpm staging:smoke`).
2. **The handset run is the one human step.** It cannot be done from CI or this environment.

Until #1 is delivered and #2 executed, **B1 stays NO-GO** — the verdict is not flipped on
prep alone.

---

## Phase 1 pre-flight — VERIFIED 2026-06-17 (turnkey status; B1 still NO-GO)

What was checked **today** so the handset session can't stall, and what still blocks:

| Pre-flight item | Status | Detail |
| --------------- | ------ | ------ |
| App staging wiring | ✅ verified | `ApiClient` reads `String.fromEnvironment('API_BASE_URL', defaultValue:'http://localhost:3001')` — `--dart-define=API_BASE_URL=https://<staging-api>` is the (only) correct switch. |
| Evidence query (b.2/b.3/b.4) | ✅ **validated on real data** | Ran the chain query **read-only** against the live Supabase DB for an existing completed worker chain: all **11 events present + non-decreasing**, `chat.message_sent`≥3, and **consent ≤ first-AI** (gate holds). The query shape is proven on the real schema — it will return the chain in the handset session. |
| `events` timestamp column | ✅ confirmed | Table has **both** `occurred_at` and `created_at`; the queries here use `occurred_at` (valid). |
| psql var gotcha | ⚠️ note | `:'wid'` interpolation can fail via `-c` on some shells — if so, **inline the UUID** directly into the SQL string (what was done to validate). |
| logcat no-PII grep + screenshot checklist | ✅ ready | See §2(c)/§2(a) below — copy-paste ready. |
| **Staging API deployed** | ⛔ **BLOCKER (prereq #1)** | `NEXT_PUBLIC_API_URL=http://localhost:3001`, `NEXT_PUBLIC_ENVIRONMENT=development` — **no HTTPS staging API exists**. DevOps must deploy it; the handset has nothing to point at until then. |
| Flutter build in this env | ⛔ n/a | Flutter is **not installed** in the prep environment — the APK build (§1) is the **mobile-engineer** step on a machine with the Flutter+Android toolchain. |
| Real Android handset run | ⛔ BLOCKER (prereq #2) | The one human step; cannot be done from CI/this env. |

**Net:** the evidence pipeline is **de-risked and proven**; B1 remains **NO-GO** on two unchanged
hard prerequisites — **(1) staging API not deployed** and **(2) the human handset run**. Deliver #1,
run #2, capture the 3 artifacts, then flip per Phase 3. *(The read-only validation above used a
pre-existing worker chain to prove the query — it is NOT a handset run and is NOT B1 evidence.)*

---

## Phase 1 RE-VERIFICATION — 2026-06-19 (against current `main` @ d0eaad8; B1 still NO-GO)

Four PRs merged since the 2026-06-17 pre-flight (#91 P0 auth+consent on chat/profile/voice,
#92 thin resume controller, #95 controller tests, #96 chat-history cap). **The device
happy-path was re-traced against current `main` to confirm none of them broke or stalled the
B1 flow — and one materially STRENGTHENS the consent evidence.**

| Re-check (post-merge) | Status | Detail (current `main`) |
| --------------------- | ------ | ----------------------- |
| App staging wiring (line ref refresh) | ✅ still correct | `ApiClient` base URL = `String.fromEnvironment('API_BASE_URL', defaultValue:'http://localhost:3001')` now at [api_client.dart:26-28](../../apps/worker-app/lib/core/api/api_client.dart#L26) (was 24-32). `--dart-define=API_BASE_URL=https://<staging-api>` unchanged as the only switch. |
| **P0 auth+consent (#91) didn't break the device path** | ✅ verified | The worker AI routes now require a **bearer token + prior consent** server-side. The app already satisfies both: OTP-verify captures `access_token` → `AppState.sessionToken` ([otp_verify_screen.dart:31](../../apps/worker-app/lib/features/auth/otp_verify_screen.dart#L31)); the **consent screen POSTs `/consent/accept` BEFORE navigating to chat** ([consent_screen.dart:23-29](../../apps/worker-app/lib/features/consent/consent_screen.dart#L23)); chat/profile/voice calls now send the token (#91). Router order splash→login→otp→**consent→chat**→profile→resume is intact. So the handset flow still completes — a missing token would 401 and missing consent would 403, neither of which the happy-path hits. |
| Consent-gate evidence (b.4) is now SERVER-ENFORCED | ✅ stronger | `ConsentGuard` now blocks chat/profile/voice until `consent.accepted` exists (#91) — b.4 ("consent strictly precedes first AI") is enforced at the API, not just asserted post-hoc. A consent-after-chat ordering is now structurally impossible on-device. |
| Chat-history cap (#96) | ✅ transparent | `ChatRepository.listMessages` is bounded (`CHAT_HISTORY_MAX=500`, recency-preserving) — a ≥3-turn interview is far under the cap, so the chain + reply behaviour is byte-identical. No effect on B1. |
| Resume-text path (#92) | ✅ unchanged | `POST /resume/generate` (the app's resume-text source) is unchanged; the #92 refactor moved only the ops read/download/share logic into the service. Resume-text preview still renders. |
| Event chain names | ✅ unchanged | No event was renamed/versioned by the four PRs — the §2(b) validated chain (`otp_verified`…`resume.generated`) is current. |
| **Staging API deployed** | ⛔ **BLOCKER (unchanged)** | Still no HTTPS staging URL; app defaults to `localhost:3001`. **DevOps action — the critical path to the Jun-20 target.** |
| Real Android handset run | ⛔ **BLOCKER (unchanged)** | The one human step. |

**Net (2026-06-19):** turnkey prep is current and re-confirmed against `main`; the recent auth
work is correctly wired in the app (and improves the consent evidence). **B1 stays NO-GO on
the two unchanged hard blockers.** ⚠️ **Jun-20 target is at RISK** until DevOps deploys staging
and hands over the concrete `API_BASE_URL` — nothing downstream can start without it.

---

## Phase 1 — turnkey (do all before touching the phone)

### 1. Build + install (copy-paste)

```bash
# From repo root. Confirm a real device is attached (NOT an emulator):
adb devices -l                      # must list a physical device, not "emulator-5554"

cd apps/worker-app
flutter pub get

# Point at STAGING (never hardcode; default is localhost:3001).
# Replace <staging-api> with the real HTTPS URL from DevOps (prereq #1).
flutter build apk --release --dart-define=API_BASE_URL=https://<staging-api>

# Install on the attached handset:
adb install -r build/app/outputs/flutter-apk/app-release.apk

# OR build+run+install in one step (keeps a log stream attached):
flutter run --release --dart-define=API_BASE_URL=https://<staging-api>
```

- **Base-URL wiring (verified):** `ApiClient` reads `String.fromEnvironment('API_BASE_URL',
  defaultValue: 'http://localhost:3001')` ([api_client.dart:24-32](../../apps/worker-app/lib/core/api/api_client.dart#L24)).
  The `--dart-define` is the ONLY supported way to point at staging.
- **Pre-flight the API from the handset's network:** `curl https://<staging-api>/health`
  → `{"status":"ok",...}`. Then confirm mock-OTP: the app's OTP screen accepts the staging
  `dev_otp` (console SMS provider in non-prod) — do a throwaway login first.

### 2. Evidence pipeline

#### (b) EVENTS — the validated chain

**Schema fact:** the `events` table has **no `worker_id` column**
([schema.ts:289](../../packages/db/src/schema.ts#L289)). The cross-chain link is
**`payload->>'worker_id'`**, carried by every payload from `worker.created` onward (verified
in [payloads.ts](../../packages/event-schema/src/payloads.ts)). `worker.otp_requested` is
pre-worker (no `worker_id`) — match it separately by `phone_hash` if you need the bookend; it
is not load-bearing for the consent/PII assertions.

Run against the **staging** DB (psql or Supabase SQL editor). Set the worker UUID once
(get it from `worker.created`’s `subject_id`/payload, or the app):

```sql
\set wid 'PASTE-WORKER-UUID'

-- (b.1) Ordered timeline — eyeball + attach to evidence.
SELECT event_name, occurred_at
FROM events
WHERE payload->>'worker_id' = :'wid'
ORDER BY occurred_at;

-- (b.2) PASS/FAIL: every required event present, in time order.
WITH req(seq, name) AS (VALUES
  (1,'worker.otp_verified'), (2,'worker.created'), (3,'consent.accepted'),
  (4,'chat.session_started'), (5,'chat.message_sent'), (6,'chat.message_received'),
  (7,'profile.extraction_requested'), (8,'profile.extraction_ready'),
  (9,'profile.extraction_completed'), (10,'profile.confirmed'), (11,'resume.generated')
),
seen AS (
  SELECT event_name, min(occurred_at) AS first_at
  FROM events WHERE payload->>'worker_id' = :'wid' GROUP BY event_name
)
SELECT r.seq, r.name, (s.event_name IS NOT NULL) AS present, s.first_at
FROM req r LEFT JOIN seen s ON s.event_name = r.name
ORDER BY r.seq;
-- PASS = every row present=true AND first_at non-decreasing down the list.

-- (b.3) ≥3 chat turns.
SELECT count(*) AS message_sent_count
FROM events WHERE payload->>'worker_id' = :'wid' AND event_name = 'chat.message_sent';
-- PASS if >= 3.

-- (b.4) CONSENT GATE — consent.accepted strictly before any chat/extraction.
SELECT
  (SELECT min(occurred_at) FROM events WHERE payload->>'worker_id'=:'wid' AND event_name='consent.accepted') AS consent_at,
  (SELECT min(occurred_at) FROM events WHERE payload->>'worker_id'=:'wid'
     AND event_name IN ('chat.session_started','chat.message_sent','profile.extraction_requested')) AS first_ai_at;
-- PASS if consent_at IS NOT NULL AND consent_at <= first_ai_at.
```

**Dry-run the query (so you KNOW it returns the chain) — run on any throwaway/local DB:**

```sql
-- Seed a synthetic chain for a throwaway worker, then run (b.2) above with this wid.
\set wid '00000000-0000-0000-0000-0000000000b1'
INSERT INTO events (event_name,event_version,occurred_at,actor_type,subject_type,correlation_id,payload)
SELECT name, 1, now() + (seq * interval '1 second'),
       'worker','worker', gen_random_uuid(),
       jsonb_build_object('worker_id', :'wid')
FROM (VALUES
  (1,'worker.otp_verified'),(2,'worker.created'),(3,'consent.accepted'),
  (4,'chat.session_started'),(5,'chat.message_sent'),(6,'chat.message_received'),
  (7,'profile.extraction_requested'),(8,'profile.extraction_ready'),
  (9,'profile.extraction_completed'),(10,'profile.confirmed'),(11,'resume.generated')
) AS t(seq,name);
-- Now (b.2) must show all 11 present=true, non-decreasing. Clean up: DELETE FROM events WHERE payload->>'worker_id' = :'wid';
```

> NOTE: this dry-run was **authored against the real schema but NOT executed here** (no
> Docker/Postgres in the prep environment). Run it once on staging/local before the handset
> session to confirm the query shape on your DB.

#### (c) LOGCAT — the PII invariant (not a formality)

```bash
adb logcat -c                                   # clear before the run
# ... perform the full flow on the handset ...
PKG=$(adb shell pm list packages | grep -i badabhai | sed 's/package://' | tr -d '\r')
adb logcat -d > b1_logcat.txt                   # dump after the run

# ASSERT NO raw PII. Each of these must return NOTHING (exit 1):
grep -nE '(\+?91)?[6-9][0-9]{9}' b1_logcat.txt          # Indian phone numbers
grep -nE '"otp"|\b[0-9]{6}\b' b1_logcat.txt             # OTP codes
grep -niF '<REAL_NAME_ENTERED>' b1_logcat.txt           # the worker's real full name
```
- **PASS = all three return no matches.** Any hit = a PII leak → FAIL, do not GO; file a bug.
- Tie the dump to the app: `adb logcat -d --pid=$(adb shell pidof -s "$PKG")` to scope to the
  app process if device noise is high.

#### (a) SCREENSHOTS — per-screen checklist

`adb exec-out screencap -p > NN_screen.png` at each step. Must capture:

| # | Screen | Must show |
|---|--------|-----------|
| 1 | Login — phone entry | phone field + send-OTP |
| 2 | Login — OTP | OTP entry + verify (no real OTP visible in any shared shot) |
| 3 | Consent | consent text + the accept control (BEFORE any chat) |
| 4–6 | Chat (≥3 turns) | 3 distinct worker→assistant exchanges |
| 7 | Profile confirm | extracted fields + the confirm control |
| 8 | Resume — text | the generated resume text rendered in-app |

**Captured so far (2026-06-27) — [docs/qa/evidence/b1/](evidence/b1/):** a **partial, mock-mode UI walkthrough**, NOT a B1 GO artifact. The screens were captured in **mock mode** (the fixture **"Ramesh Kumar"** + raw `role_cnc_*` / `dom_*` tokens in the resume), **not** a real staging handset run, so they prove only that the screens render. PII-safe (no real phone/name in any shot). They cover a few checklist rows and **miss every blocking one**.

| Captured screen | File | B1 checklist row |
|---|---|---|
| Splash / language select | [01-splash-language](evidence/b1/01-splash-language.jpeg) | — (pre-login, bonus) |
| Login — phone entry | [02-login-phone](evidence/b1/02-login-phone.jpeg) | ✅ #1 |
| Profile **tab** + logout dialog | [03-profile-tab-logout](evidence/b1/03-profile-tab-logout.jpeg) | — (shell tab, **not** #7 profile-confirm) |
| Jobs — filter sheet | [04-jobs-filter](evidence/b1/04-jobs-filter.jpeg) | — (§4 swipe, non-blocking) |
| Alerts | [05-alerts](evidence/b1/05-alerts.jpeg) | — (bonus) |
| Profile **tab** + interview kit | [06-profile-tab-kit](evidence/b1/06-profile-tab-kit.jpeg) | — (shell tab) |
| Resume — text + Download PDF | [07-resume-text](evidence/b1/07-resume-text.jpeg) | ⚠️ #8 (but **mock** raw-token resume) |
| Jobs — swipe card 1 | [08-jobs-swipe-card-1](evidence/b1/08-jobs-swipe-card-1.jpeg) | — (§4 swipe, non-blocking) |
| Jobs — swipe card 2 | [09-jobs-swipe-card-2](evidence/b1/09-jobs-swipe-card-2.jpeg) | — (§4 swipe, non-blocking) |

> **Still required for B1 GO (absent from this set):** **#2 OTP**, **#3 Consent**, **#4–6 Chat (≥3 turns)**, **#7 Profile-confirm** — captured from a **real staging handset run** (not mock mode), alongside the (b) event-chain query, (c) logcat no-PII grep, and §4 swipe events. Until those land, B1 stays **NO-GO** (the two §⛔ prerequisites are also still unmet).

### 3. Consent gate on-device

Server-side the gate is enforced by `ConsentGuard` (no profiling/AI before
`consent.accepted`; ADR-0009). On-device, confirm the app does not expose chat before the
consent screen is accepted, and prove it server-side with query **(b.4)** (consent strictly
precedes the first chat/extraction event).

### 4. Swipe device-verify (folded into the SAME session, non-blocking)

After resume-text, open the swipe screen; **apply** to ≥1 job and **skip** ≥1. Then assert:

```sql
SELECT event_name, count(*) FROM events
WHERE payload->>'worker_id' = :'wid'
  AND event_name IN ('feed.shown','application.submitted','application.skipped')
GROUP BY event_name;
-- Expect feed.shown >=1, application.submitted >=1, application.skipped >=1.
```
This is **non-blocking** — it does not gate the alpha GO; capture it while the phone is in hand.

---

## Phase 3 — validation + verdict (after the human run)

Fill this from the captured artifacts:

| Criterion | Source | Result |
|-----------|--------|--------|
| Chain complete + in order (11 events) | query (b.2) | ☐ |
| ≥3 chat turns | query (b.3) | ☐ |
| Consent precedes all AI | query (b.4) | ☐ |
| Zero raw PII in logcat | grep (c) | ☐ |
| Screenshots cover all 8 screens | checklist (a) | ☐ |
| (non-blocking) swipe events present | query §4 | ☐ |

- **All blocking rows PASS →** flip [alpha-capstone-fixlist.md](../registers/alpha-capstone-fixlist.md):
  B1 → CLOSED (cite the evidence), HEADLINE VERDICT NO-GO → **GO**; mirror into TD29.
- **Any blocking row FAIL →** if it's a real built-path failure, re-engage debugging-engineer,
  root-cause, fix, re-run (buffer window to 06-21). Do NOT flip the verdict.

## Evidence handling (PII)

The run uses a real worker identity. Keep the **real phone/name out of committed evidence**:
redact them in screenshots, store `b1_logcat.txt` outside the repo, reference the worker by
UUID only in the fix-list. The logcat grep is the proof that the *app* keeps PII out of logs.
