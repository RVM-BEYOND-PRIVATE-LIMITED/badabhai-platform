# RVM 9-trade ratification — follow-up nudge + go-live readiness

- **Date:** 2026-06-16 · **Status:** ✅ **RESOLVED — CEO-approved 2026-06-17.** The 9-trade
  content ratification is **approved by the CEO**; the RVM trade-by-trade chase is **closed —
  do NOT send the nudge below.** All 9 trades are ratified (record gate satisfied). The drafted
  nudge + bounce-prep below are retained as history only.
- **What this means mechanically:** content was already live as the provisional Phase-1 default
  (no per-trade `ratified` flag exists — see "Go-live readiness"), so approval is a **record
  gate**, now satisfied. No code flip. If any copy edits are later requested, bump
  `INTERVIEW_KIT_CONTENT_VERSION` then; otherwise touch no code.
- **Packet RVM signs:** [trade-content-ratification-packet.md](trade-content-ratification-packet.md)
  (§4 per-trade checklist — all verdict cells empty).
- **Companion register:** [trade-content-ratification.md](trade-content-ratification.md).
- **Content source of truth:** resume [`trade-content.ts`](../../apps/api/src/resume/trade-content.ts),
  interview-kit [`interview-kit-content.ts`](../../apps/api/src/interview-kit/interview-kit-content.ts).

**All 9 trades are COMPLETE and CEO-APPROVED** (content authored, `REQUIRED_KIT_TRADE_KEYS`
lists them, tests green for presence/shape; CEO ratification granted 2026-06-17). No
outstanding item remains.

## The 9 trades + one-liner status (all CEO-approved 2026-06-17)

| # | Trade | Status |
|---|-------|--------|
| 1 | cnc_vmc_setter | ✅ CEO-approved |
| 2 | cnc_programmer | ✅ CEO-approved |
| 3 | vmc_programmer | ✅ CEO-approved |
| 4 | solidworks_designer | ✅ CEO-approved |
| 5 | autocad_draftsman | ✅ CEO-approved |
| 6 | tool_room_technician | ✅ CEO-approved |
| 7 | machine_operator | ✅ CEO-approved |
| 8 | assembly_technician | ✅ CEO-approved |
| 9 | fitter | ✅ CEO-approved |

## Go-live readiness — IMPORTANT: there is no code flip to stage

Verified in code: there is **no per-trade `ratified`/`enabled` flag**. Both surfaces
(`getInterviewKit`, `getTradeContent`) already serve content for all 9 trades **live, as the
"provisional Phase-1 default."** So RVM's PASS is a **content-authority / record gate**, not
a switch. The only mechanical follow-on is:

1. **If RVM requests copy edits:** apply them in the source, then **bump
   `INTERVIEW_KIT_CONTENT_VERSION`** ([`packages/config/src/server.ts`](../../packages/config/src/server.ts),
   currently `1`) so a fresh PDF re-renders the ratified copy. *Leave it at `1` until then.*
2. **If RVM PASSes with no edits:** record the PASS in packet §4 + the register; touch no code.

**Open product question (flagged, not built):** if you want un-ratified trades to **hard-block**
rendering instead of serving provisionally, that is **new behavior** (`RATIFIED_TRADE_KEYS`
gate in the serving paths) needing a logged decision + a task. Recommended for the Jun-25
alpha: keep the provisional-default model; treat RVM PASS as the documentation gate.

## Drafted nudge — copy-paste and send AS-IS

> **Subject: BadaBhai — trade content sign-off needed by Sat 20-Jun (9 trades, ~30 min)**
>
> Hi [RVM reviewer],
>
> The 9-trade content packet for the BadaBhai alpha is ready for your sign-off — the gate
> between engineering-drafted copy and content you've vouched is accurate for CNC/VMC (green
> tests only prove the content is *present*, not *correct* — that's your review).
>
> **What we need:** a **trade-by-trade PASS / FAIL** on the 9 below. If a trade needs edits,
> mark **CHANGES** with what to fix. You can PASS some now and leave others pending — each
> row is independent.
>
> **Please read:** `docs/registers/trade-content-ratification-packet.md` — full resume +
> interview-kit copy for all 9 is embedded, so no code needed.
>
> **Two specific calls (flagged in the packet):** (1) **Machine Operator** is intentionally
> generic — confirm that's OK for a real placement or tell us to sharpen it; (2) **AutoCAD
> Draftsman** — "Draftsman" (current) or "Draughtsman"?
>
> | # | Trade | PASS | FAIL | CHANGES |
> |---|-------|:----:|:----:|---------|
> | 1 | CNC/VMC Setter | ☐ | ☐ | |
> | 2 | CNC Programmer | ☐ | ☐ | |
> | 3 | VMC Programmer | ☐ | ☐ | |
> | 4 | SolidWorks Designer | ☐ | ☐ | |
> | 5 | AutoCAD Draftsman (+ spelling) | ☐ | ☐ | |
> | 6 | Tool Room Technician | ☐ | ☐ | |
> | 7 | Machine Operator (+ generic OK?) | ☐ | ☐ | |
> | 8 | Assembly Technician | ☐ | ☐ | |
> | 9 | Fitter | ☐ | ☐ | |
>
> **Deadline: EOD Sat 20-Jun.** Alpha cut is 25-Jun; once your PASSes land we need ~2
> working days to record, re-render, and device-verify across all 9. Reply in this table or
> in the packet — happy to do a 15-min call.
>
> Thanks, [Prakash]

## Pre-empt — trades RVM is most likely to BOUNCE (+ our ready answer)

- **machine_operator** — thinnest + intentionally generic. *Answer ready:* we can add a
  machine-context line + a richer inspection/safety floor within a day if RVM wants it.
- **autocad_draftsman** — spelling (Draftsman/Draughtsman) + thin desk safety/measurement.
  *Answer ready:* one-line rename in `trade-content.ts` + a measurement/safety bullet on PASS.
- **solidworks_designer** — desk-only "workstation discipline" safety. *Answer ready:* it's a
  deliberate desk-role framing; we can add a shop-awareness line if RVM prefers.
- **cnc_programmer / vmc_programmer** — generic CAM naming + "CMM (basic awareness)".
  *Answer ready:* we can name specific CAM tools / tighten the awareness level on request.

Likely clean PASSes: cnc_vmc_setter, tool_room_technician, assembly_technician, fitter.

## Q&A — anticipated RVM questions (answers ready)

- **Q: Do I have to review code?** A: No — the full copy for all 9 is embedded in the packet.
- **Q: Can I PASS some and hold others?** A: Yes; each row is independent.
- **Q: What happens after I PASS?** A: We record it; if you asked for edits we apply them and
  re-render. Content is already live as a provisional default, so a PASS makes it
  vouched-for, not newly-visible.
- **Q: What if I miss the 20-Jun date?** A: Anything after ~22-Jun eats into the 25-Jun alpha
  window (we need ~2 days to apply + device-verify). Partial PASSes still help.
- **Q: Who fixes content I reject?** A: Engineering, same day for small copy edits; back to
  you for re-confirmation.
