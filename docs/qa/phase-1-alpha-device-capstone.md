# Phase-1 Alpha Device Capstone — test plan, gaps, go/no-go

> **STATUS (2026-06-15): NO-GO — capstone DEFERRED, fixing gaps first.**
> The worker app does not yet implement all named flows, and no device run has
> been executed. This doc is (1) the **device test plan** to run once the gaps
> close, and (2) the **gap hand-off** to mobile/backend. No flow may be marked
> "works" without device evidence (screenshot/log/event row).

Owners: mobile-engineer + backend-engineer (gaps) · qa-engineer (device run).
Lenses applied: `bb-ui-review`, `bb-testing`.

---

## 0. Current app reality (static inventory)

Implemented flow: **splash → login → OTP → consent → chat → profile → resume (text preview)**.
ApiClient ([api_client.dart](../../apps/worker-app/lib/core/api/api_client.dart)) calls only:
`/auth/otp/request`, `/auth/otp/verify`, `/consent/accept`, `/chat/session`,
`/chat/message`, `/profile/extract`, `/profile/confirm`, `/resume/generate`.

| Capstone flow | App status | Gap |
| --- | --- | --- |
| **chat** | ✅ built | needs device verification |
| **voice** | ⚠️ placeholder | no record/upload/transcribe; no `/voice/*` call |
| **swipe** | ❌ not built | Reach-Engine/employer scope — **deferred (CLAUDE.md §8)**, NOT a Phase-1 gate |
| **resume** | ⚠️ partial | text preview only; **no PDF download** via TD24 signed URL |
| **kit** | ❌ not built | backend content exists (PR #34); no app screen |

---

## 1. Preconditions for the device run

- [ ] **Point at STAGING** — build with `--dart-define=API_BASE_URL=https://<staging-api>`
  (default is `http://localhost:3001`; never hardcode staging). Confirm with the
  human owner before pointing at shared infra.
- [ ] **TD24 resume rendering ON** in staging (`RESUME_RENDER_ENABLED=true`, WeasyPrint
  present, `worker-resumes` bucket PRIVATE — see [storage-buckets.md](../../infra/supabase/storage-buckets.md)).
- [ ] **Consent gate precedes profiling** — verified in app flow (consent screen → chat)
  and enforced backend-side (§2.6).
- [ ] Real Android handset (Android-first), a real SIM/phone for OTP, low-bandwidth
  profile available for the bandwidth checks.

Build:
```bash
cd apps/worker-app
flutter run --release --dart-define=API_BASE_URL=https://<staging-api>
```

---

## 2. Per-flow device test plan

Each flow: **pass/fail steps** + **events that MUST appear** in the `events` table
(query staging DB filtered by the run's `worker_id`) + **security checks** (no raw
PII in logcat; no secret/token in app storage).

### 2.1 Chat profiling  *(app: built)*
1. Login (enter phone → receive OTP → verify). **PASS:** lands on consent.
   **Events:** `worker.otp_requested`, `worker.otp_verified`, `worker.created` (first login).
2. Accept consent. **PASS:** cannot proceed without ticking; lands on chat.
   **Events:** `consent.accepted`.
3. Send ≥3 chat turns answering trade/experience. **PASS:** replies render; interview
   advances (never repeats Q1); auto-extraction triggers.
   **Events:** `chat.session_started`, `chat.message_sent` (×N), `chat.message_received`,
   `profile.extraction_requested` → `profile.extraction_ready` → `profile.extraction_completed`.
4. **Security:** logcat shows **no phone/name** (only hashes/ids); no OTP code in logs.
   **FAIL** if any raw PII or the OTP appears in logcat.

### 2.2 Voice note  *(app: PLACEHOLDER — expected FAIL until built)*
1. Open voice note from chat. **PASS:** record → upload → transcript returns and is
   usable in profiling.
   **Events:** `voice_note.uploaded`, `voice_note.transcription_requested`,
   `voice_note.transcription_completed` (or `_failed` → safe empty transcript).
2. **Security:** audio uploaded to the PRIVATE voice bucket; no transcript/audio path
   with PII in logs.
> Current expected result: **FAIL/blocked** — screen is a placeholder.

### 2.3 Swipe  *(out of Phase-1 scope)*
Not a Phase-1 worker-profiling flow — employer feed / Reach Engine, **deferred (§8)**.
Record as **N/A (out of scope)** for the alpha gate unless product re-scopes it.

### 2.4 Resume preview + download  *(app: partial)*
1. After `profile.confirmed`, resume generates. **PASS:** resume **text** renders.
   **Events:** `profile.confirmed`, `resume.generated`.
2. Tap **Download PDF**. **PASS:** app fetches a short-TTL signed URL and opens/saves
   the PDF; the worker's name is on it.
   **Events:** `resume.downloaded`.
3. **Security:** the signed URL is **not** logged; PDF served only via the signed URL
   (no public object URL); URL stops working after `RESUME_SIGNED_URL_TTL_SECONDS`.
> Current expected result: step 1 demoable; **steps 2–3 FAIL** — download not wired
> (and the route is ops-guarded; see gap G1).

### 2.5 Interview kit  *(app: not built)*
1. Open the interview kit for the worker's trade. **PASS:** per-trade kit renders
   (questions/checklist/Hinglish) and/or downloads as PDF via signed URL.
2. **Security:** kit is per-trade, PII-free; PDF via signed URL only.
> Current expected result: **FAIL/blocked** — no app screen (backend content exists).

---

## 3. Gap hand-off (build BEFORE the capstone re-runs)

**G1 — Resume PDF download in the app (mobile + backend).**
`GET /resume/:id/download` is behind **`InternalServiceGuard`** (ops/internal only) —
the worker app cannot call it. Backend: add a **worker-authenticated** download path
(`WorkerAuthGuard`, added in PR #32) that verifies `resume.workerId === authenticated
worker.id` before minting the signed URL — this closes part of the per-worker authz
launch gate (**TD4 / R11 / R13**). Mobile: call it, open/share the PDF, don't log the URL.

**G2 — Voice note flow (mobile).** Replace the placeholder with record → `POST
/voice/transcribe` → poll `voice_note.transcription_*`. Backend STT is wired (TD6,
gated). Upload to the PRIVATE voice bucket; no PII in logs.

**G3 — Interview-kit screen (mobile, optional for alpha).** Consume the per-trade kit
(PR #34 content, pending RVM). Either render in-app or download the kit PDF via a
worker-auth signed URL (same pattern as G1). **Confirm with product whether the kit is
in the alpha worker-app scope** before building.

**G4 — Swipe scope (product).** Confirm **out of Phase-1** (Reach Engine, §8) so it is
not an alpha-gate blocker. Tracked here for the record; no build in Phase 1.

---

## 4. Alpha go/no-go (to be completed AFTER the device run)

| Flow | App-ready | Device-verified | Go/No-go |
| --- | --- | --- | --- |
| chat | ✅ | ⬜ pending | conditional-go |
| voice | ❌ (placeholder) | ⬜ | **no-go** (G2) |
| swipe | n/a | n/a | **out of scope** (G4) |
| resume | ⚠️ partial | ⬜ | **no-go** for download (G1) |
| kit | ❌ | ⬜ | **no-go** (G3) |

**Overall: NO-GO** until G1–G3 close and a device run produces evidence.
