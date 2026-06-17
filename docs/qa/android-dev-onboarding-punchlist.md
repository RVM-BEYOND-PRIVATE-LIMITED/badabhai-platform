# Android Dev — Day-1 Onboarding Punch-List (TD29 alpha worker-app gaps)

> **Who this is for:** the Android developer joining **2026-06-25** with zero prior context.
> **What it is:** an execute-top-down punch-list, not a diagnosis to redo. Every card is
> self-contained — problem, exact files, repro, acceptance tied to a concrete runbook check,
> the privacy control that ships in the same change, owner, order, date.
>
> **This builds on (does not replace):**
> - [alpha-capstone-fixlist.md](../registers/alpha-capstone-fixlist.md) — the triage SoT (buckets, owners, GO condition).
> - [b1-device-capstone-runbook.md](b1-device-capstone-runbook.md) — **THE acceptance test** (copy-paste evidence pipeline).
> - [phase-1-alpha-device-capstone.md](phase-1-alpha-device-capstone.md) — the original per-flow test plan + gap hand-off.
> - [TD29](../registers/tech-debt-register.md) — the register row this mirrors into.
>
> **Lenses:** `bb-testing` (qa-engineer owns acceptance) · mobile-engineer (repro/files) · product-manager (sequence).
> **Scope:** DOCUMENTATION ONLY — no code is changed by this doc. Read [CLAUDE.md](../../CLAUDE.md) first (esp. §1 Phase-1 exit, §2 invariants).

---

## 1. DAY-1 SETUP — be productive in under an hour

Goal: clone → build → run `apps/worker-app` on a real handset against **staging** → run the
device-capstone runbook once as a smoke test. If you finish this section, you are productive.

### 1.1 Prerequisites (install once)

| Tool | Pinned version | Why exactly this |
| ---- | -------------- | ---------------- |
| **Flutter SDK** | **3.27.4 (stable)** | CI gate is pinned to 3.27.4 ([`worker-app.yml`](../../.github/workflows/worker-app.yml), TD7). `pubspec.yaml` only floors `>=3.22.0` — **ignore the floor, match CI** or `flutter analyze` will diverge from the merge gate. |
| **pnpm + Node** | repo root toolchain | Only if you also touch the API. Worker-app work alone needs only Flutter. |
| **Android SDK + `adb`** | current stable | Build/install/logcat. A **physical** Android device (Android-first); emulator does NOT count for the capstone. |

```bash
# 1. Clone + install the JS workspace (skip if you only touch apps/worker-app).
git clone https://github.com/RVM-BEYOND-PRIVATE-LIMITED/badabhai-platform.git
cd badabhai-platform && pnpm install

# 2. Get the worker app building.
cd apps/worker-app
flutter --version          # MUST report 3.27.4 — if not, switch channels/versions first
flutter pub get
flutter analyze && flutter test    # the exact CI gate — must be green BEFORE you change anything
```

### 1.2 Point at STAGING and run on a real handset

The app's `API_BASE_URL` defaults to `http://localhost:3001`
([api_client.dart:24-32](../../apps/worker-app/lib/core/api/api_client.dart#L24)). The **only**
supported way to point at staging is `--dart-define` — never hardcode.

```bash
adb devices -l    # MUST show a physical device, not "emulator-5554"

# Replace <staging-api> with the real HTTPS URL from DevOps (see the gating note below).
flutter run --release --dart-define=API_BASE_URL=https://<staging-api>
# pre-flight from the handset's network first:  curl https://<staging-api>/health  -> {"status":"ok"}
```

> ⛔ **Gating reality (read before you expect staging to work):** as of the last runbook
> revision, **staging may not be deployed** — every staging reference in the repo is a
> `<staging-api>` placeholder and DevOps must stand up the API + Supabase + Redis and hand you
> the concrete HTTPS URL ([runbook prereq #1](b1-device-capstone-runbook.md)). If `GET
> /health` does not return `200 {status:ok}` from the handset, **stop and escalate to
> devops-engineer** — do not work around it by pointing at a local box for acceptance. (Local
> `localhost:3001` is fine for your own dev loop; it is NOT valid capstone evidence.)

### 1.3 Smoke test = run the capstone runbook once

Run [b1-device-capstone-runbook.md](b1-device-capstone-runbook.md) end-to-end **as your
onboarding smoke test**: login → consent → chat (≥3 turns) → profile-confirm → resume-text,
then capture the 3 artifacts (screenshots, staging `events` chain, clean logcat). This is **THE
acceptance test** every card below ties back to — once you've run it once, you know the
evidence pipeline cold and every "done when…" check becomes mechanical.

---

## 2. PER-GAP CARDS

Each card is independently executable. The PII control is **part of the same change** — never
a follow-up. Severity/acceptance wording is the qa-engineer's, kept verbatim from the fix-list.

---

### CARD B1 — core-path device-verify *(context: NOT yours to build — know its status)*

- **Status:** the **sole alpha blocker**; **owner = qa-engineer**, not the Android dev. You are
  not building this — but it is the GO line (§5), so you must know where it stands and unblock it.
- **Problem:** the built login→consent→chat→profile→resume-**text** path has never been verified
  on a real handset against staging with evidence. CI green + emulator do **NOT** count.
- **Your involvement:** mobile-engineer **supports** the run (build/install/logcat per §1).
  If the run surfaces a **real built-path failure**, it converts into a debugging-engineer
  task and you may own the fix + re-run.
- **Acceptance:** runbook [Phase 3 validation table](b1-device-capstone-runbook.md) all
  blocking rows PASS → fix-list HEADLINE VERDICT flips NO-GO → GO.
- **Open B1 follow-up you can clear on Day-1:** confirm with DevOps that **staging is deployed
  with a real URL** (runbook prereq #1) and that **mock-OTP login works against it** — this is
  the single thing most likely to still be blocking B1 when you arrive.

---

### CARD G1c — in-app "Download PDF" (resume) — **DO THIS FIRST**

- **Problem (observed vs expected):** the resume screen shows **text only**; tapping for a PDF
  does nothing. *Expected:* a "Download PDF" action fetches the worker-auth signed URL and opens
  the branded PDF (which carries the worker's real name).
- **Backend is already done** — do NOT rebuild it: `GET /resume/:id/download` is
  `WorkerAuthGuard` + ownership-checked (`resume.workerId === worker.id`), no-oracle 404, emits
  `resume.downloaded` (**commit 8314dfc**, security PASS). This is a **mobile-only** card.
- **Exact files/paths to touch:**
  - [resume_preview_screen.dart](../../apps/worker-app/lib/features/resume/resume_preview_screen.dart) — add the "Download PDF" action/button.
  - [api_client.dart](../../apps/worker-app/lib/core/api/api_client.dart) — add `downloadResume(resumeId, authToken)` → `GET /resume/:id/download` with `Authorization: Bearer <authToken>` (reuse the existing `_get(path, authToken:)` + bearer header plumbing already there for `getFeed`).
  - [pubspec.yaml](../../apps/worker-app/pubspec.yaml) — add `url_launcher` (NOT currently a dependency) to open the signed URL.
- **Repro a stranger can follow:** build per §1.2 → log in → finish chat → confirm profile →
  on the resume screen, tap "Download PDF" → today: nothing happens / no PDF / no route call.
- **Acceptance — done when:** `resume_preview_screen.dart` invokes the new
  `ApiClient.downloadResume(resumeId, authToken)` → `GET /resume/:id/download` with bearer,
  opens the signed URL, **URL never logged**; `flutter analyze` + `flutter test` pass; **AND a
  handset run shows the PDF opening + a `resume.downloaded` event** in staging `events` (verify
  with the runbook's [(b) events query](b1-device-capstone-runbook.md) filtered to your `worker_id`).
- **Privacy control SHIPPED IN THIS SAME CHANGE (non-negotiable):** the PDF carries the
  worker's **real name** ([TD21](../registers/tech-debt-register.md)). It MUST go over the
  **closed worker-auth route** (bearer, ownership-checked) and the **signed URL must never be
  logged** (no `print`/logcat of the URL). CLAUDE.md §2 invariant 2.
- **Owner:** mobile-engineer · **Order:** 1st (no dependency on G2/G3) · **Target:** **2026-06-27**.
- **Override:** if product/RVM require the branded PDF **in alpha**, G1c **promotes into the GO
  set** (MUST-LAND-BEFORE-JUN-25) — same privacy control. Until that call, it's a Day-1 inherit.

---

### CARD G2 — voice note flow (record → upload → transcribe) — **DO SECOND**

- **Problem (observed vs expected):** the voice entry point is a placeholder
  ([voice_note_placeholder_screen.dart](../../apps/worker-app/lib/features/voice/voice_note_placeholder_screen.dart))
  — no record/upload/transcribe. *Expected:* record → upload → transcript returns and is usable
  in profiling.
- **Backend is wired** — do NOT rebuild STT: `POST /voice/transcribe` → 202 + poll, async via
  BullMQ, **mock-by-default**, real Sarvam call fail-closed behind `AI_ENABLE_REAL_CALLS` +
  `SARVAM_API_KEY` ([TD6](../registers/tech-debt-register.md)). This is a **mobile** card (plus
  confirming the bucket is PRIVATE).
- **Exact files/paths to touch:**
  - [voice_note_placeholder_screen.dart](../../apps/worker-app/lib/features/voice/voice_note_placeholder_screen.dart) — replace placeholder with record → upload → poll UI.
  - [api_client.dart](../../apps/worker-app/lib/core/api/api_client.dart) — add the `POST /voice/transcribe` call + a poll on the returned job (mirror the existing `enqueueProfileExtraction` → `awaitProfileId` poll pattern).
  - Add an audio-record/upload dependency to [pubspec.yaml](../../apps/worker-app/pubspec.yaml).
  - Verify the **PRIVATE** voice bucket exists in staging (DevOps; mirror the `worker-resumes` PRIVATE pattern, TD24).
- **Repro:** build per §1.2 → in chat, open the voice note → today: placeholder screen, no
  record/upload, no `/voice/*` call.
- **Acceptance — done when:** placeholder replaced by record → `POST /voice/transcribe` → poll;
  audio uploaded to the **PRIVATE** voice bucket; `flutter analyze` + `flutter test` pass; **AND
  a handset run shows `voice_note.uploaded → transcription_requested → transcription_completed`
  (or `_failed → safe empty transcript`)**, with **no PII in logs** (runbook [(c) logcat grep](b1-device-capstone-runbook.md) returns nothing).
- **Privacy control SHIPPED IN THIS SAME CHANGE:** audio is PII → upload **only** to the
  **PRIVATE** voice bucket (never public/object URL), and **fail-closed pseudonymization** runs
  on the transcript before any LLM/profiling use (CLAUDE.md §2 invariants 2 & 3). No
  audio path / transcript with PII in logs.
- **Owner:** mobile-engineer · **Order:** 2nd (after G1c) · **Target:** **2026-07-02**.

---

### CARD G3 — interview-kit screen (per-trade kit) — **DO THIRD**

- **Problem (observed vs expected):** no in-app interview-kit screen. *Expected:* per-trade kit
  renders (questions / checklist / Hinglish).
- **Content is done AND ratified** — do NOT re-author content: backend content covers all
  **15 alpha trades** (`REQUIRED_KIT_TRADE_KEYS`, [TD24a](../registers/tech-debt-register.md),
  PR #34). **RVM ratification is CEO-approved 2026-06-17** ([rvm-followup-nudge.md](../registers/rvm-followup-nudge.md))
  — the external content gate that previously blocked G3 is **CLEARED**. Remaining gate is only
  a **product scope-confirm** ("is the kit in the alpha worker-app scope?").
- **Exact files/paths to touch:**
  - New screen under [apps/worker-app/lib/features/](../../apps/worker-app/lib/features/) (e.g. `interview_kit/interview_kit_screen.dart`).
  - [api_client.dart](../../apps/worker-app/lib/core/api/api_client.dart) — consume the per-trade kit endpoint (PR #34 content) **or** download the kit PDF via a worker-auth signed URL (same pattern as G1c).
- **Repro:** build per §1.2 → there is no entry point to an interview kit for the worker's trade.
- **Acceptance — done when:** new interview-kit screen consumes the PR #34 content (or
  worker-auth signed URL like G1c); `flutter analyze` + `flutter test` pass; **a handset renders
  the kit**. (No PII event chain required — the kit is per-trade and PII-free.)
- **Privacy control:** none specific — the kit is **per-trade, PII-free**. If you deliver it as a
  PDF, use the signed-URL pattern (URL never logged), same as G1c.
- **Owner:** mobile-engineer · **Order:** 3rd · **Gate:** product scope-confirm (RVM gate now
  cleared) · **Target:** **2026-07-04**.

---

## 3. SEQUENCE — do them in this order, never decide what's next

1. **DAY-1 SETUP (§1)** → run the capstone runbook once as a smoke test.
2. **G1c (Download PDF)** — *first.* Highest user value (completes the §1 "get a generated
   resume" exit criterion as a real artifact), backend is already done, zero dependency on
   G2/G3, and it's the one item that can be **pulled into the alpha GO set** by an override —
   so derisking it first protects the cut.
3. **G2 (voice)** — *second.* Additive, off the critical path, heavier (records audio + new
   PRIVATE-bucket + pseudonymization surface). Do it after G1c so the PDF win lands first.
4. **G3 (interview-kit)** — *third.* Lowest severity, content is ratified, needs only a product
   scope-confirm; safe to do last without blocking anything.

Rationale (product): **value × readiness × risk-of-pull-forward**. G1c wins on all three; G3
loses on all three. Never reorder G2 ahead of G1c — G1c is the override candidate.

---

## 4. WHAT'S ALREADY DONE / OUT-OF-SCOPE — don't redo, don't overreach

**CLOSED in code (do NOT rebuild):**
| Item | What | Closed by |
| ---- | ---- | --------- |
| **G1a** | Backend worker-auth resume download (`GET /resume/:id/download`, `WorkerAuthGuard` + ownership, no-oracle 404, emits `resume.downloaded`, security PASS) | **commit 8314dfc** |
| **G1b** | Mobile session/bearer-token plumbing (`ApiClient` threads `Bearer authToken`, memory-only, never logged) | [ADR-0009](../decisions/0009-alpha-swipe-to-apply-seeded-jobs.md) Stream C |
| **Swipe (code)** | Alpha swipe-to-apply screen + `getFeed`/`applyToJob`/`skipJob` + tests, consent-gated | [ADR-0009](../decisions/0009-alpha-swipe-to-apply-seeded-jobs.md) Stream C |
| **Voice STT backend** | `POST /voice/transcribe` async (BullMQ), mock-by-default, real call fail-closed | [TD6](../registers/tech-debt-register.md) |
| **Interview-kit content** | All 15 alpha trades authored; **RVM ratification CEO-approved 2026-06-17** | [TD24a](../registers/tech-debt-register.md) / [rvm-followup-nudge.md](../registers/rvm-followup-nudge.md) |

**OUT-OF-SCOPE for the alpha worker-app (do NOT touch — Phase-2 surfaces, CLAUDE.md §8):**
- **Reach feed ranking / employer console / unlock + reveal / payments** — these live in
  `apps/web` (ops console) + the Reach Engine, owned elsewhere. The worker app only has the
  ADR-0009 **swipe producer**; the Phase-2 Reach feed stays absent by design.
- **Job posting** — owned by another developer; consume read-only if ever needed, never build/modify.
- Swipe **device-verify** is non-blocking and folds into the qa-engineer's B1 handset session — not your card.

---

## 5. THE GO LINE — what flips alpha to GO

> **Alpha is GO when, and ONLY when:** **B1 is device-verified on a real Android handset
> against staging, with all three evidence artifacts.** CI green and emulator runs do NOT count.

B1's three required artifacts (verbatim):
1. **(a)** per-screen **screenshots**: login → consent → chat (≥3 turns) → profile-confirm → resume-text.
2. **(b)** staging **`events` rows** for the run's `worker_id` showing the full validated chain
   `otp_verified → worker.created → consent.accepted → chat.session_started → message_sent(×N) →
   message_received → extraction_requested → extraction_ready → extraction_completed →
   profile.confirmed → resume.generated`.
3. **(c)** **logcat showing NO raw phone / name / OTP.**

That is the COMPLETE GO set. **G1c / G2 / G3 do NOT block the alpha cut** (resume **text**
preview already satisfies CLAUDE.md §1 "get a generated resume"). **The one override:** if
**product / RVM require the branded PDF in alpha**, **G1c promotes into the GO set** — and by the
PII rule it must then ship over the closed worker-auth route with the signed URL never logged,
in the same change.

---

## What the Jun-25 dev does in their first 3 days

**Day 1:** install Flutter **3.27.4** (match CI, not the pubspec floor), clone, `flutter pub get`,
get `flutter analyze && flutter test` green, then build the app onto a **real handset** pointed at
**staging** via `--dart-define=API_BASE_URL` and run the [device-capstone runbook](b1-device-capstone-runbook.md)
once as a smoke test — confirming with DevOps that staging is actually deployed (this is the one
thing most likely to still be blocking B1). **Day 2:** start **G1c (Download PDF)** — the only
mobile work; the backend route already exists (commit 8314dfc), so wire `ApiClient.downloadResume`
+ a button in `resume_preview_screen.dart` + `url_launcher`, keeping the signed URL out of logs,
and prove it with a handset PDF-open + a `resume.downloaded` event. **Day 3:** begin **G2 (voice)**
— replace the placeholder with record → `POST /voice/transcribe` → poll, audio to the PRIVATE
bucket with fail-closed pseudonymization, verified by the `voice_note.*` event chain and a clean
logcat. **G3 (interview-kit)** follows once a product scope-confirm lands (RVM content gate is
already cleared). Throughout, the GO line is unchanged: it's **B1**, owned by qa-engineer — your
job is to unblock and support it, then ship G1c → G2 → G3 in that order.
