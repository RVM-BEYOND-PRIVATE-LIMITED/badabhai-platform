# Approved-vs-Live trade content diff (resume + interview-kit)

> **Date:** 2026-06-17 · **Target: ZERO diff.** Reconciles the RVM-ratified + **CEO-approved**
> content (PR #65 record gate, [rvm-followup-nudge.md](./rvm-followup-nudge.md)) against what
> actually renders, for all 9 approved trades. Drives: product-manager (approved-content
> reconciliation) + technical-writer (this diff) + backend-engineer (render wiring).

## How the gate resolved
The ratification packet ([trade-content-ratification-packet.md](./trade-content-ratification-packet.md))
was **transcribed verbatim from** [`trade-content.ts`](../../apps/api/src/resume/trade-content.ts)
and [`interview-kit-content.ts`](../../apps/api/src/interview-kit/interview-kit-content.ts). The CEO
approval (PR #65) was a **record gate on that exact live content with NO edits requested**
("touch no code" unless a copy edit is later asked — rvm-followup-nudge.md). Therefore the
approved content **is** the live content by construction.

## Per-trade diff (9 approved trades) — resume + kit

| # | Trade (`trade_key`) | Resume row | Kit | Approved-vs-live diff |
|---|---------------------|:----------:|:---:|:---------------------:|
| 1 | `cnc_vmc_setter` | present | present | **zero** |
| 2 | `cnc_programmer` | present | present | **zero** |
| 3 | `vmc_programmer` | present | present | **zero** |
| 4 | `solidworks_designer` | present | present | **zero** |
| 5 | `autocad_draftsman` | present | present | **zero** |
| 6 | `tool_room_technician` | present | present | **zero** |
| 7 | `machine_operator` | present | present | **zero** |
| 8 | `assembly_technician` | present | present | **zero** |
| 9 | `fitter` | present | present | **zero** |

(All 9 are in `REQUIRED_TRADE_KEYS` + `REQUIRED_KIT_TRADE_KEYS`; the content files also carry 6
more non-ratified Phase-1 trades, unchanged and out of this gate's scope.)

## Post-RVM decisions (resolved as APPROVED AS-IS — no edit applied)
- **AutoCAD Draftsman-vs-Draughtsman** → role title (`display_name`) kept **"AutoCAD Draftsman"**
  (American) in both files. (The ITI qualification "Draughtsman (Mechanical)" still appears in a
  resume *certification phrase* — that is the official course name, not the role title.)
- **CAM tool names** (`cnc_programmer` / `vmc_programmer`) → kept **generic** ("CAM software
  (Mastercam / Fusion / etc.)") — no single locked vendor.
- **`machine_operator` machine-agnostic framing** → kept the deliberate **generic catch-all**.

## Render wiring (already live — no gating to remove)
- Resume: `resume-render.processor` → `resolveTradeContent(canonical_role_id, canonical_trade_id)`
  → `ResumeRenderer.buildResumeHtml` (headline = `display_name`, `responsibilities` = trade copy).
- Kit: `getInterviewKit(trade_key)` → `InterviewKitRenderer.buildHtml`.
- There is **no `ratified`/`pending-RVM`/`draft` gate** anywhere on these paths — the approved
  content is what renders (it always served as the provisional default; CEO approval ratified it).

## Masking invariant (held — untouched)
This change is trade-content only; it does not touch the name/PII path. The employer-facing
identity-masked resume (initials, no phone — commit eafcccc) remains a separate **build gate
(B-G)**: the renderer still binds `displayName` (the worker's own real name or null), and no
employer-masked render surface exists to regress. Nothing here weakens it.

## Tests (the render proof)
- Presence/shape (pre-existing): `trade-content.test.ts`, `interview-kit-content.test.ts`.
- **NEW render proof — approved content actually renders per trade:**
  [`resume-approved-content.render.test.ts`](../../apps/api/src/resume/resume-approved-content.render.test.ts)
  + [`interview-kit-approved-content.render.test.ts`](../../apps/api/src/interview-kit/interview-kit-approved-content.render.test.ts):
  for each of the 9 approved trades, pull the LIVE content, render via the real renderer, and
  assert the approved headline/responsibilities (resume) and overview/questions/checklist/Hinglish
  (kit) reach the HTML — plus targeted assertions for the three post-RVM decisions above.

**Net diff: ZERO.** Approved == live for all 9 trades; the new tests prove it renders.
