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
   from the handset's network, and mock-OTP login works against it.
2. **The handset run is the one human step.** It cannot be done from CI or this environment.

Until #1 is delivered and #2 executed, **B1 stays NO-GO** — the verdict is not flipped on
prep alone.

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
