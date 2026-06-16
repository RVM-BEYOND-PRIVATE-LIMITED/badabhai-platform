# Alpha Capstone Fix-List — single source of truth (sequenced, owned, gated)

> **Triage of the worker-app device-capstone NO-GO** (source:
> [phase-1-alpha-device-capstone.md](../qa/phase-1-alpha-device-capstone.md), [TD29](./tech-debt-register.md)).
> TRIAGE ONLY — no fixes here. Each remaining item has **exactly one owner**, a **dated
> bucket**, and a **target date**. Closed items are retired with their commit/ADR.
> Lenses: `bb-testing` (QA verdict, used verbatim) + product cut (Jun-25 split).

**Provenance / history:**
- **Seeded 2026-06-15.** First triage: gate labels (BLOCKS-NOW / JUN-25-DEV-INHERITS /
  OUT-OF-SCOPE), B1 named THE blocker, G1 backend done, swipe closed-in-code.
- **Re-issued 2026-06-16** as the **single source of truth** off the qa-engineer's
  authoritative reconciliation + discrete gap list + GO condition. Severities and
  "Done when…" acceptance checks are the **qa-engineer's, used verbatim** — this rev adds
  owners, two **dated** buckets, the enumerated NO-GO→GO condition, and the write-back to
  TD29. Prior triage retained below (closed-items + history), not discarded.
- QA verdict owner: **qa-engineer**. Sequencing + ownership + cut-line owner: **product-manager**.

---

## HEADLINE VERDICT

**Alpha is NO-GO. The ONLY blocker is B1** — a real-handset device run of the core path
(login → consent → chat → profile → **resume text preview**) against staging, with the
three evidence artifacts. CI green and emulator runs do **NOT** count.

Everything else is either **closed in code** (G1a backend worker-auth download, G1b mobile
bearer-token plumbing, swipe screen) or a **Jun-25-dev-inherits** add-on that does **not**
block the cut at the current bar (resume **text** preview satisfies CLAUDE.md §1 "get a
generated resume"): **G1c** in-app PDF download, **G2** voice flow, **G3** interview-kit.

Today is **2026-06-16**; alpha cut target is **2026-06-25**.

---

## NO-GO → GO CONDITION (enumerated — this is the complete set)

> **GO when, and ONLY when:** **{ B1 device-verified on a real Android handset against
> staging, with all three evidence artifacts }**.

"Device-verified" = **real-handset** evidence. **CI green and emulator runs do NOT count.**

B1's three required artifacts (qa-engineer, verbatim):
1. **(a)** per-screen **screenshots** of login → consent → chat (≥3 turns) → profile-confirm → resume-text.
2. **(b)** staging **`events` rows** for the run's `worker_id` showing the full validated chain:
   `otp_requested` → `otp_verified` → `worker.created` → `consent.accepted` →
   `chat.session_started` → `message_sent` (×N) → `message_received` →
   `extraction_requested` → `extraction_ready` → `extraction_completed` →
   `profile.confirmed` → `resume.generated`.
3. **(c)** **logcat showing NO raw phone / name / OTP**.

That is the COMPLETE GO set. **G1c / G2 / G3 do NOT block the alpha cut.** Swipe
device-verify folds into the same B1 handset session (non-blocking).

**Override trigger (the one thing that expands the GO set):** if **product / RVM require
the branded PDF in alpha**, **G1c promotes into the GO set** (→ MUST-LAND-BEFORE-JUN-25),
and — by the PII rule — it MUST ship over the closed worker-auth route with the signed URL
never logged, in the same change. Until that call is made, G1c stays a Jun-25 inherit.

---

## Buckets (gate labels)
- **MUST-LAND-BEFORE-JUN-25** — the alpha GO set. Must clear before the cut.
- **ANDROID-DEV-INHERITS-DAY-1** — the incoming Android dev picks it up Jun-25 onward.
- **CLOSED** — retired in code/commit/ADR (kept visible, not deleted).
- **OUT-OF-SCOPE** — not a Phase-1 worker-app flow; not an alpha gate.

**PII / consent / privacy / data-loss rule (CLAUDE.md), reconciled honestly with the cut:**
the rule says anything touching PII/consent/privacy/data-loss is **before-Jun-25 by
default**. Nothing unsafe ships today **because the risky paths (G1c PDF carrying the real
name, G2 audio/transcript) are NOT built** — there is no live exposure to pull forward. So
the PII default attaches to the two things that actually exist:
1. **It is honored before-Jun-25** via **B1's consent-gate assertion + clean-logcat
   assertion** (no raw phone/name/OTP) — these ARE in the GO set.
2. **It binds the future build:** whenever G1c/G2 are built, the privacy control ships in
   the **SAME change** — G1c over the **closed worker-auth route** with the **signed URL
   never logged**; G2 to the **PRIVATE voice bucket** with **fail-closed pseudonymization**.
This is why G1c/G2 can be Jun-25 inherits without silently breaking the PII rule.

---

## MUST-LAND-BEFORE-JUN-25 (alpha GO set)

| ID | Flow | Done when… (qa-engineer, verbatim acceptance) | Severity | PII/consent | Owner | Target |
| -- | ---- | --------------------------------------------- | -------- | ----------- | ----- | ------ |
| **B1** | core path — device-verify (login → consent → chat → profile → **resume text**) against staging | Real **handset** (not CI/emulator) pointed at staging completes login → consent → chat (≥3 turns) → profile-confirm → resume-text with evidence = **(a)** per-screen screenshots, **(b)** staging `events` rows for the run's `worker_id` showing the full validated chain `otp_requested→otp_verified→worker.created→consent.accepted→chat.session_started→message_sent(×N)→message_received→extraction_requested→extraction_ready→extraction_completed→profile.confirmed→resume.generated`, **(c)** logcat showing NO raw phone/name/OTP. | **High (blocker)** | **YES** — consent-gate + PII-in-logs assertions | **qa-engineer** (owns the run + verdict; devops supports staging build/access, product signs off — qa is THE owner) | **2026-06-20** (buffer before the Jun-25 cut; re-run window 06-21 if it surfaces a failure) |
| **Swipe (device-verify)** | feed/apply/skip on a real handset — **folds into the B1 session** | Handset run of feed/apply/skip produces apply/skip evidence + events; folds into B1. | **Low** | NO (PII-free surface) | **qa-engineer** (rides the same B1 handset session) | **2026-06-20** (same session as B1) |

> If the B1 run surfaces a **real failure in the built path**, re-engage
> **debugging-engineer** (see below) and re-run before the cut.

---

## ANDROID-DEV-INHERITS-DAY-1 (post-cut; do NOT block the alpha)

These do not block the cut at the current bar (resume **text** preview, CLAUDE.md §1).
Day-1 = Jun-25 onward; the dated targets are in the inheriting dev's first window.

| ID | Flow | Done when… (qa-engineer, verbatim acceptance) | Severity | PII/consent | Owner | Target |
| -- | ---- | --------------------------------------------- | -------- | ----------- | ----- | ------ |
| **G1c** | resume — in-app **Download PDF** action over the **closed** worker-auth signed URL | `resume_preview_screen.dart` invokes new `ApiClient.downloadResume(resumeId, authToken)` → `GET /resume/:id/download` with bearer, opens signed URL (launcher dep added), **URL never logged**, `flutter analyze`+`test` pass, AND a handset run shows the PDF opening + a `resume.downloaded` event. | **Medium** — text preview meets the alpha bar; **override → High** if product/RVM demand the branded PDF in alpha (then promotes to MUST-LAND, see GO condition) | **YES** — PDF carries the worker's real name ([TD21](./tech-debt-register.md)); MUST use the closed worker-auth route, never log the URL (privacy control ships in this SAME change) | **mobile-engineer** | **2026-06-27** |
| **G2** | voice — placeholder → record → upload → transcribe, usable in profiling | Placeholder replaced by record → `POST /voice/transcribe` → poll; audio to **PRIVATE** voice bucket; **fail-closed pseudonymization** runs; `flutter analyze`+`test` pass; AND a handset run shows `voice_note.uploaded → transcription_requested → transcription_completed` (or `_failed → safe empty`), no PII in logs. | **Medium** — additive, off the critical path | **YES** — audio/transcript PII; PRIVATE bucket + pseudonymization ship in this SAME change | **mobile-engineer** | **2026-07-02** |
| **G3** | interview-kit screen — per-trade kit rendered | New interview-kit screen consumes PR #34 content (or worker-auth signed-URL like G1c), `analyze`+`test` pass, handset renders the kit — **gated on RVM content ratification first**. | **Low–Medium** | NO (per-trade, PII-free) | **mobile-engineer** *(externally gated: RVM content ratification + a product scope confirm before build)* | **2026-07-04** (RVM-gated — slips with RVM content sign-off) |

---

## CLOSED items (retired with citation — visible, not lost)

| ID | What | Closed by |
| -- | ---- | --------- |
| **G1a** | Backend worker-auth resume download — `GET /resume/:id/download` is now `WorkerAuthGuard` + ownership check (`resume.workerId === worker.id`), 404/404 no-oracle, emits `resume.downloaded`; closes the download-IDOR of [R11/R13/TD4](./risks-register.md). **Security: PASS.** | **commit 8314dfc** |
| **G1b** | Mobile session / bearer-token plumbing — `ApiClient` threads `Bearer authToken` (memory-only, never logged). | **[ADR-0009](../decisions/0009-alpha-swipe-to-apply-seeded-jobs.md) Stream C** |
| **Swipe (code)** | Alpha swipe-to-apply surface (seeded jobs; `getFeed`/`applyToJob`/`skipJob` + 3 Flutter tests); consent-gated. The **Phase-2 Reach feed stays OUT-OF-SCOPE** (ranking/unlock/payments — Reach Engine, §8). | **[ADR-0009](../decisions/0009-alpha-swipe-to-apply-seeded-jobs.md) Stream C** |

> **Original G1** split three ways at the 2026-06-16 reconciliation: **G1a** (backend) +
> **G1b** (mobile plumbing) → CLOSED above; **G1c** (in-app Download-PDF action) → remains
> OPEN as a Jun-25 inherit.

---

## OUT-OF-SCOPE (not an alpha gate)

- **Phase-2 Reach feed** — ranking / unlock / payments (Reach Engine, CLAUDE.md §8). Only
  the ADR-0009 **alpha** swipe producer is built; the Reach feed remains absent by design.

---

## debugging-engineer assessment

**Not triggered.** Every remaining gap's cause is obvious from code — "not built / not
wired / can't-verify-without-a-handset" — none is a mysterious runtime defect.
**Re-engage only if the B1 run surfaces a real failure** in the built path.

---

## Ownership roll-up (item → owner → bucket → date)

| Item | Owner | Bucket | Target |
| ---- | ----- | ------ | ------ |
| **B1** (core-path device-verify) | **qa-engineer** | MUST-LAND-BEFORE-JUN-25 | **2026-06-20** |
| **Swipe device-verify** | **qa-engineer** (folds into B1 session) | MUST-LAND-BEFORE-JUN-25 | **2026-06-20** |
| **G1c** (in-app Download PDF) | **mobile-engineer** | ANDROID-DEV-INHERITS-DAY-1 | **2026-06-27** |
| **G2** (voice flow) | **mobile-engineer** | ANDROID-DEV-INHERITS-DAY-1 | **2026-07-02** |
| **G3** (interview-kit screen) | **mobile-engineer** (RVM + product gated) | ANDROID-DEV-INHERITS-DAY-1 | **2026-07-04** |
| G1a backend download | — | CLOSED (8314dfc) | done |
| G1b mobile bearer plumbing | — | CLOSED (ADR-0009 C) | done |
| Swipe code | — | CLOSED (ADR-0009 C) | done |

Support roles (not the single owner): **devops-engineer** — B1 staging build/access;
**product-manager** — B1 sign-off, the G1c branded-PDF override call, G3 scope confirm;
**security-engineer** — gates the G1c/G2 privacy controls when built; **ai-engineer** —
STT backend for G2 (done/gated, [TD6](./tech-debt-register.md)).

Cross-links: [TD29](./tech-debt-register.md), [R11/R13/TD4](./risks-register.md) (download authz),
[capstone test plan](../qa/phase-1-alpha-device-capstone.md),
[ADR-0009](../decisions/0009-alpha-swipe-to-apply-seeded-jobs.md).
