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
- **Reconciled 2026-07-18** against [BLOCKERS.md](../tracker/BLOCKERS.md) (commit `86b4f6e`), which is the
  **newer source of truth** for blocker state. This file had gone a month stale (last real edit
  2026-06-19) and was still asserting a NO-GO that BLOCKERS.md had already cleared — that
  contradiction is what this rev fixes.

---

## HEADLINE VERDICT

> **SUPERSEDED 2026-06-19 → 2026-07-18.** The "Alpha is NO-GO, the ONLY blocker is B1" verdict
> below stood from 2026-06-16 and is **no longer current**. Read the 2026-07-18 verdict first.

### Current verdict (2026-07-18)

**B1 is CLOSED — by owner ATTESTATION, not by captured artifacts.** On 2026-07-18 the owner
attested (commit `86b4f6e`, [BLOCKERS.md](../tracker/BLOCKERS.md) §"P0 CLEARED"): staging live,
migrations `0042`+`0043` applied, the R27 box finding triaged, **real OTP (Fast2SMS)** working,
and **resume download verified** on the box. The P0 that had been open 19 days (cost: 14 days of
schedule) is cleared and alpha moved **NO-GO → IN PROGRESS**.

**Three things a reader must not misread this as:**

1. **The three evidence artifacts were NEVER CAPTURED.** `docs/qa/evidence/staging/` does not
   exist — there are no per-screen screenshots of the staging run, no exported `events` chain
   for the run's `worker_id`, and no clean logcat. The enumerated GO condition below was
   therefore **not** satisfied on its own terms; it was **substituted with an owner
   attestation**. BLOCKERS.md carries this as its own **P2** ("Staging artifacts uncaptured",
   owner Rishi/QA, "capture on next run"). Nobody other than the attesting owner can reproduce
   or re-check this result today. Recorded plainly, not as a challenge to the result.
2. **Swipe device-verify is UNKNOWN — do NOT read it as verified.** The attestation enumerates
   OTP and resume download and **never mentions feed/apply/skip on the handset**. No artifact
   exists to check it against. It rode the B1 session on paper only.
3. **A closed B1 does NOT mean a verified stack.** Alpha GO did **not** land with B1. The
   critical path moved to **[TD81](./tech-debt-register.md)** (issue
   [#453](https://github.com/badabhai/badabhai-platform/issues/453)): the **`ai-service` is not
   deployed on staging** — it is absent from [`docker-compose.yml`](../../docker-compose.yml) —
   so **chat and profile-extraction on the box run SILENTLY MOCKED while `/health` returns 200**.
   That directly undercuts the middle of the evidence chain B1 was designed to produce: the
   `chat.session_started → message_sent → extraction_requested → extraction_ready →
   extraction_completed` span cannot be read as proof of real profiling, because on that box it
   is the mock answering. B1's attested span (OTP, resume download) sits at the two **ends** of
   the chain, not through it. Plus gates 1/2/4/5 (payer-company, agency, OTP-safety half,
   RBAC/admin smoke) have still never run on the real stack.

### Original verdict (2026-06-16 — historical, superseded)

**Alpha is NO-GO. The ONLY blocker is B1** — a real-handset device run of the core path
(login → consent → chat → profile → **resume text preview**) against staging, with the
three evidence artifacts. CI green and emulator runs do **NOT** count.

Everything else is either **closed in code** (G1a backend worker-auth download, G1b mobile
bearer-token plumbing, swipe screen) or a **Jun-25-dev-inherits** add-on that does **not**
block the cut at the current bar (resume **text** preview satisfies CLAUDE.md §1 "get a
generated resume"): **G1c** in-app PDF download, **G2** voice flow, **G3** interview-kit.

Today is **2026-06-16**; alpha cut target is **2026-06-25**.

> **Update (2026-06-16) — Phase-1 turnkey prep DONE; verdict UNCHANGED (still NO-GO).** A
> copy-paste runbook + evidence pipeline (build/install commands, the validated-chain SQL +
> a dry-run seed script, the logcat PII grep, the screenshot checklist, the consent-gate
> assertion, swipe fold-in, and the validation table) is ready:
> [b1-device-capstone-runbook.md](../qa/b1-device-capstone-runbook.md). **Two prerequisites
> gate the actual run and are NOT yet met:** (1) **DevOps must deploy staging + provide the
> concrete `API_BASE_URL`** — every staging reference today is a `<staging-api>` placeholder
> (app defaults to `localhost:3001`); (2) the **handset run is a human step** (not CI/emulator,
> not runnable from the build env). B1 flips to CLOSED / GO only after the human run yields the
> three artifacts (Phase 3 of the runbook). Schema note baked into the query: `events` has **no
> `worker_id` column** — the chain links via `payload->>'worker_id'`.

> **Update (2026-06-19) — Phase-1 RE-VERIFIED against current `main`; verdict UNCHANGED (still
> NO-GO).** Re-traced the device happy-path after four merges since the 06-17 pre-flight (#91 P0
> auth+consent, #92, #95, #96). Findings: the runbook is **current** and the recent auth work is
> **correctly wired in the app** (OTP-verify → token; **consent POSTed before chat**; chat sends
> the bearer) — so the handset flow still completes, and #91 now makes the **consent-gate
> server-enforced** (`ConsentGuard`), *strengthening* B1's b.4 evidence. The two hard
> prerequisites are **unchanged and still unmet:** (1) **DevOps must deploy staging + provide
> `API_BASE_URL`** (the critical path), (2) the **human handset run**. ⚠️ **The 2026-06-20 target
> is AT RISK** until staging is deployed — that is the gating action. Detail:
> [b1-device-capstone-runbook.md](../qa/b1-device-capstone-runbook.md) "Phase 1 RE-VERIFICATION — 2026-06-19".

> **Update (2026-07-18) — the gating prerequisite finally landed; B1 CLOSED by owner
> attestation.** The prerequisite that had held this file hostage since 2026-06-16 — "DevOps must
> deploy staging + provide the concrete `API_BASE_URL`" — was met on 2026-07-18: **staging is
> live**, `0042`+`0043` applied, R27 triaged, **real OTP (Fast2SMS)** sending, **resume download
> verified**. Owner closed B1 on that basis (commit `86b4f6e` →
> [BLOCKERS.md](../tracker/BLOCKERS.md)). **The human handset run's artifacts were NOT written:**
> `docs/qa/evidence/staging/` still does not exist, so the closure rests on **attestation, not
> files** — logged as a standing **P2** in BLOCKERS.md. **Swipe device-verify is not mentioned in
> the attestation and is recorded here as UNKNOWN.** Note also that this file sat 29 days
> asserting a stale NO-GO after the fact; the lesson is that a register nobody re-reads becomes a
> liability the moment its subject moves — hence the reconciliation note in Provenance.

---

## NO-GO → GO CONDITION (enumerated — this is the complete set)

> **STATUS 2026-07-18:** this condition was **NOT met on its own terms**. B1 was closed by
> **owner attestation** substituting for artifacts (a) (b) (c) below — none of which exist on
> disk. The enumerated set is retained verbatim because it is still the definition of what a
> *reproducible* B1 pass looks like, and it is exactly what step 6 of BLOCKERS.md's
> "Remaining path to full alpha GO" is asking someone to go capture.

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

**None of (a) (b) (c) were captured** (2026-07-18). Artifact **(b)** in particular is now
weaker than it looks even if someone goes and exports it: with **TD81** open, the
`extraction_requested → extraction_ready → extraction_completed` segment of that chain is
produced by the API's **safe mock**, not by a real `ai-service` — the rows appear and the chain
looks whole, but it proves plumbing, not profiling. Capture (b) anyway (it still proves the
event spine end-to-end), and re-capture it after TD81 is settled for the real-profiling claim.

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

> **Bucket status 2026-07-18:** the Jun-25 cut date is long past and both rows have moved off
> OPEN. **B1 → CLOSED (attested).** **Swipe device-verify → UNKNOWN (never evidenced).**

| ID | Flow | Done when… (qa-engineer, verbatim acceptance) | Severity | PII/consent | Owner | Status (2026-07-18) |
| -- | ---- | --------------------------------------------- | -------- | ----------- | ----- | ------------------- |
| **B1** | core path — device-verify (login → consent → chat → profile → **resume text**) against staging | Real **handset** (not CI/emulator) pointed at staging completes login → consent → chat (≥3 turns) → profile-confirm → resume-text with evidence = **(a)** per-screen screenshots, **(b)** staging `events` rows for the run's `worker_id` showing the full validated chain `otp_requested→otp_verified→worker.created→consent.accepted→chat.session_started→message_sent(×N)→message_received→extraction_requested→extraction_ready→extraction_completed→profile.confirmed→resume.generated`, **(c)** logcat showing NO raw phone/name/OTP. | **High (blocker)** | **YES** — consent-gate + PII-in-logs assertions | **qa-engineer** (owns the run + verdict; devops supports staging build/access, product signs off — qa is THE owner) | ✅ **CLOSED 2026-07-18 — by OWNER ATTESTATION, not artifacts.** Attested: staging live, `0042`+`0043` applied, R27 triaged, **real OTP (Fast2SMS)**, **resume download verified** (commit `86b4f6e` → [BLOCKERS.md](../tracker/BLOCKERS.md)). ⚠️ **(a)/(b)/(c) were never captured** — `docs/qa/evidence/staging/` does not exist; standing **P2** in BLOCKERS.md, owner Rishi/QA. Not independently reproducible. |
| **Swipe (device-verify)** | feed/apply/skip on a real handset — **folds into the B1 session** | Handset run of feed/apply/skip produces apply/skip evidence + events; folds into B1. | **Low** | NO (PII-free surface) | **qa-engineer** (rides the same B1 handset session) | ❓ **UNKNOWN — do NOT record as verified.** The 2026-07-18 attestation enumerates OTP + resume download and is **silent on feed/apply/skip**; no artifact exists to check. It "folded into the B1 session" on paper only. Re-verify on the next handset run (cheap — same session). |

> If the B1 run surfaces a **real failure in the built path**, re-engage
> **debugging-engineer** (see below) and re-run before the cut.

> **B1 closing did NOT produce alpha GO.** The critical path moved to
> **[TD81](./tech-debt-register.md)** / issue
> [#453](https://github.com/badabhai/badabhai-platform/issues/453) — `ai-service` is absent from
> [`docker-compose.yml`](../../docker-compose.yml), so staging chat + profile-extraction run
> **silently mocked behind a 200 `/health`**. Anyone who reads "B1 closed" as "the stack is
> verified" will be wrong about the exact middle of the flow this gate was built to prove.
> Remaining path to full GO is enumerated in [BLOCKERS.md](../tracker/BLOCKERS.md): TD81, gates
> 1/2/4/5 on staging, then capture the artifacts.

---

## ANDROID-DEV-INHERITS-DAY-1 (post-cut; do NOT block the alpha)

These do not block the cut at the current bar (resume **text** preview, CLAUDE.md §1).
Day-1 = Jun-25 onward; the dated targets are in the inheriting dev's first window.

> **Bucket status 2026-07-18 (the dated targets below are all past; read this instead):**
> - **G1c — SHIPPED and device-verified.** `ApiClient.downloadResume()` exists
>   ([`api_client.dart:399`](../../apps/worker-app/lib/core/api/api_client.dart)) and PR #256 was
>   run on a real OPPO CPH2585 / Android 16 handset on 2026-07-17: PDF saves to MediaStore, opens
>   in a viewer, **no browser hand-off**, and the **signed URL never appears on screen or in
>   logcat** (0 matching lines) — the privacy control the PII rule demanded shipped with it.
>   Evidence: [`pr-256-inapp-pdf-download/`](../qa/evidence/pr-256-inapp-pdf-download/). ⚠️ Honest
>   caveat carried from that README: the run used `USE_MOCKS=true`, so the **byte-fetch over the
>   real worker-auth signed URL was skipped** — the MediaStore-save + open path is real, the
>   network leg is not yet handset-proven. The owner's 2026-07-18 "resume download verified"
>   attestation is the closest thing to that leg, and it is an attestation.
> - **G2 (voice) / G3 (interview-kit)** — status not re-verified in this pass; treat the rows
>   below as of their 2026-06-19 vintage until someone re-checks them. G3's separate note (RVM
>   content gate CLEARED 2026-06-17) still stands.

> **Day-1 execution doc (for the incoming Android dev):**
> [android-dev-onboarding-punchlist.md](../qa/android-dev-onboarding-punchlist.md) — turns this
> triage into a top-down punch-list (Day-1 setup with pinned Flutter **3.27.4** + per-gap cards
> G1c/G2/G3 with exact files, repro, and acceptance tied to the B1 runbook). Note: **G3's RVM
> content gate is now CLEARED** (CEO-approved 2026-06-17, [rvm-followup-nudge.md](./rvm-followup-nudge.md));
> only a product scope-confirm remains.

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

| Item | Owner | Bucket | Status (2026-07-18) |
| ---- | ----- | ------ | ------------------- |
| **B1** (core-path device-verify) | **qa-engineer** | MUST-LAND-BEFORE-JUN-25 | ✅ **CLOSED 2026-07-18 — owner-attested, artifacts NOT captured** (`86b4f6e`; `docs/qa/evidence/staging/` absent → P2 in BLOCKERS.md) |
| **Swipe device-verify** | **qa-engineer** (folds into B1 session) | MUST-LAND-BEFORE-JUN-25 | ❓ **UNKNOWN** — absent from the attestation, no artifact; **not verified** |
| **G1c** (in-app Download PDF) | **mobile-engineer** | ANDROID-DEV-INHERITS-DAY-1 | ✅ **SHIPPED + handset-verified 2026-07-17** (PR #256; signed URL never logged). Caveat: run in `USE_MOCKS=true`, so the real signed-URL byte-fetch is unproven |
| **G2** (voice flow) | **mobile-engineer** | ANDROID-DEV-INHERITS-DAY-1 | not re-verified this pass (was: target 2026-07-02) |
| **G3** (interview-kit screen) | **mobile-engineer** (RVM + product gated) | ANDROID-DEV-INHERITS-DAY-1 | not re-verified this pass (was: target 2026-07-04; RVM content gate CLEARED 2026-06-17) |
| G1a backend download | — | CLOSED (8314dfc) | done |
| G1b mobile bearer plumbing | — | CLOSED (ADR-0009 C) | done |
| Swipe code | — | CLOSED (ADR-0009 C) | done (code only — **device-verify is the UNKNOWN row above**) |

Support roles (not the single owner): **devops-engineer** — B1 staging build/access;
**product-manager** — B1 sign-off, the G1c branded-PDF override call, G3 scope confirm;
**security-engineer** — gates the G1c/G2 privacy controls when built; **ai-engineer** —
STT backend for G2 (done/gated, [TD6](./tech-debt-register.md)).

Cross-links: [TD29](./tech-debt-register.md), [R11/R13/TD4](./risks-register.md) (download authz),
[capstone test plan](../qa/phase-1-alpha-device-capstone.md),
[ADR-0009](../decisions/0009-alpha-swipe-to-apply-seeded-jobs.md),
**[BLOCKERS.md](../tracker/BLOCKERS.md) (newer source of truth for blocker state)**,
[TD81](./tech-debt-register.md) / issue [#453](https://github.com/badabhai/badabhai-platform/issues/453)
(mocked AI on staging — the current critical path).

---

## What is still open on this file (2026-07-18)

1. **Capture the three B1 artifacts** → `docs/qa/evidence/staging/`. Cheap, and it converts an
   attestation into something a later verifier can re-check. Owner: Rishi/QA (BLOCKERS.md P2).
2. **Device-verify swipe** (feed/apply/skip) — rides the same handset session. Currently UNKNOWN.
3. **Settle TD81** before anyone claims "real profiling verified on staging": either deploy the
   `ai-service` into compose, or make the mock **LOUD** in `/health`. Until then the extraction
   segment of the B1 event chain proves plumbing, not profiling.
4. **Re-verify G2 / G3** rows — they were not re-checked in this reconciliation pass.

**GitHub issue [#257](https://github.com/badabhai/badabhai-platform/issues/257) ([B1] alpha GO
gate) is STALE and can close:** its subject was closed on 2026-07-18 by owner attestation. Close
it with a pointer to items 1 and 2 above, which are the honest residue — not with a claim that
the gate's evidence condition was met.
