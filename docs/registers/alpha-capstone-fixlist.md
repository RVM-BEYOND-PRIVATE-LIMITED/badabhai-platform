# Alpha Capstone Fix-List — triaged, owned, gated

> **Triage of the worker-app device-capstone NO-GO** (source:
> [phase-1-alpha-device-capstone.md](../qa/phase-1-alpha-device-capstone.md), TD29).
> TRIAGE ONLY — no fixes here. Each item has an **owner** and a **gate label**.
> Lenses: `bb-testing` (QA verdict) + product cut (Jun-25 split).

Seeded 2026-06-15. QA verdict owner: qa-engineer. Cut-line owner: product-manager.

## Gate labels
- **BLOCKS-ALPHA-NOW** — must clear before the alpha cut.
- **JUN-25-DEV-INHERITS** — the incoming Android dev picks it up after alpha (target Jun 25).
- **OUT-OF-SCOPE** — not a Phase-1 worker-app flow; not an alpha gate.
- Rule applied: anything touching **PII / consent / privacy boundary / data loss is
  BLOCKS-NOW by default**. (Here those concerns attach to *how a gap is fixed*, not to a
  live exposure — nothing unsafe is shipping today because the risky paths aren't built.)

---

## HEADLINE VERDICT

**Alpha is NO-GO until the core path is device-verified.** The single thing standing
between us and an alpha cut is **B1** — a real-device run of
login → consent → chat → profile → **resume (text preview)** against staging, with the
PII-in-logs / insecure-storage checks green. Everything else is either out-of-scope
(swipe) or a polish/added-flow the **Jun-25 dev inherits** (voice, PDF download, kit).

**Must clear before alpha (BLOCKS-NOW):**
- **B1** — device-verify the core profiling→resume-text path on a real Android handset.

**Jun-25 dev inherits:** J1 resume PDF download (+ its per-worker authz), J2 voice flow,
J3 interview-kit screen.

**Out of scope:** swipe (Reach Engine, §8).

> **Cut decision (product):** the alpha bar is **resume TEXT preview**, which satisfies
> the Phase-1 exit criterion "get a generated resume" (CLAUDE.md §1). The polished
> **PDF download** is a Jun-25 inherit. **Override trigger:** if product/RVM require the
> branded PDF in alpha, **J1 promotes to BLOCKS-NOW** — and its per-worker authz becomes
> mandatory in the same change (PII rule).

---

## Triage table

| ID | Flow | Observed vs expected | Evidence | Severity | Root-cause hypothesis | Owner | Gate + one-line reason |
| -- | ---- | -------------------- | -------- | -------- | --------------------- | ----- | ---------------------- |
| **B1** | chat (+ the whole core path) | Built (login→consent→chat→profile→resume-text) but **never run on a device** — 0 functional evidence it works | Code wired ([api_client.dart](../../apps/worker-app/lib/core/api/api_client.dart)); **NO device/log/event evidence** | **Unverified — evidence MISSING** (core path; treat as High until proven) | Environmental: no device/emulator + Flutter not installed in CI, so no run happened. Not a code defect. | **qa-engineer** (run) + **devops** (staging build/access) + **product** (sign-off to point at shared staging) | **BLOCKS-ALPHA-NOW** — it's THE alpha flow; an unverified headline path cannot ship. |
| **J1** | resume — PDF download | App shows resume **text** only; **no signed-URL PDF download**. Route `GET /resume/:id/download` is `InternalServiceGuard`-only (ops), so the worker app cannot call it at all | [resume_preview_screen.dart](../../apps/worker-app/lib/features/resume/resume_preview_screen.dart) calls only `generateResume`; [resume.controller.ts:98-99](../../apps/api/src/resume/resume.controller.ts#L98) guard. Definitive (code) | **High** (feature) / **the authz sub-part is a privacy item**) | Not built mobile-side; backend route was scoped ops-only — needs a **worker-authenticated** download path | **backend-engineer** (worker-auth download path) + **mobile-engineer** (wire/open PDF); **security-engineer** gates | **JUN-25-DEV-INHERITS** — text preview meets the alpha bar. **BUT when built it MUST add per-worker ownership authz** (PDF carries the worker's real name → PII; closes part of TD4/R11/R13). That authz is blocks-the-download, by the PII rule. |
| **J2** | voice note | Placeholder screen; no record/upload/transcribe; no `/voice/*` call | [voice_note_placeholder_screen.dart](../../apps/worker-app/lib/features/voice/voice_note_placeholder_screen.dart); ApiClient has no voice method. Definitive (code) | **Medium** | Not built (Phase-1 scaffold deferred it). Backend STT is wired + gated (TD6) | **mobile-engineer** (UI + wiring); backend STT already **ai-engineer**-owned & done | **JUN-25-DEV-INHERITS** — chat alone covers profiling input; voice is additive, not on the critical path. **Privacy note for the build:** audio + transcript can carry PII → must upload to the PRIVATE voice bucket + run the pseudonymization gate (already fail-closed) when wired. No live exposure today (not built). |
| **J3** | interview-kit | No app screen | No feature dir/route/call; backend content drafted ([PR #34], pending RVM). Definitive (code) | **Low–Medium** | Not built; content itself still pending RVM ratification | **mobile-engineer** (screen) + **product-manager** (confirm alpha scope) + RVM (content) | **JUN-25-DEV-INHERITS** — prep value-add, off the core path; PII-free (per-trade). Also blocked on RVM content sign-off. |
| **—** | swipe | Absent | No screen/route/call; CLAUDE.md §8 lists Reach Engine as deferred | **N/A** | Out of Phase-1 scope (employer feed / Reach Engine) | **product-manager** (confirm + drop from the capstone flow list) | **OUT-OF-SCOPE** — not a Phase-1 worker-app flow; remove from the alpha gate. |

---

## Evidence-missing flags (per the "flag, don't guess" rule)
- **B1 / core path (chat, resume-text):** code shows it is *built*, but there is **no
  device evidence it works** — no run was possible from this environment. Its severity
  is "unverified"; a latent runtime/UX bug cannot be ruled out until the device run.
  **Not claimed as working.**
- **J1–J3 / swipe:** evidence is *code-definitive* (the feature is absent/placeholder),
  so severity there is not a guess.

## debugging-engineer assessment
Not triggered. Every gap's root cause is obvious from code — "not built / not wired /
ops-guarded / can't-verify-without-a-device" — none is a mysterious runtime defect
needing root-cause investigation. Re-engage debugging-engineer only if the **B1** device
run surfaces a real failure in the built path.

## Ownership roll-up
- **qa-engineer:** B1 (run + verdict).  **devops:** B1 (staging build/access).
  **product-manager:** B1 sign-off, J1 cut, J3 scope, swipe drop.
- **backend-engineer:** J1 worker-auth download.  **mobile-engineer:** J1 wire, J2, J3.
  **security-engineer:** gates J1 (and J2 when built).  **ai-engineer:** STT (J2) — done/gated.

Cross-links: [TD29](./tech-debt-register.md), [R11/R13/TD4](./risks-register.md) (J1 authz),
[capstone test plan](../qa/phase-1-alpha-device-capstone.md).
