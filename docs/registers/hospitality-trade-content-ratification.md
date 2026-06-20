# Hospitality Trade Content Ratification — DRAFTED, PENDING RVM

> **CONTENT DRAFTED — PENDING RVM. NOT LIVE.** This mirrors the manufacturing
> [trade-content-ratification.md](./trade-content-ratification.md) gate for the **hospitality
> vertical**. Following product sign-off (PRD) + CEO approval (2026-06-18), all 9 trades are
> **authored** (resume `TradeContent` + interview-kit `InterviewKitContent`, exact structure
> parity, no adjacency map) and the per-trade content is transcribed verbatim in the companion
> [ratification packet](./hospitality-trade-content-ratification-packet.md). **Nothing
> hospitality renders live** — it is not wired into the live resolver and has no profiling/job
> surface; each trade flips to production-ready only on a named-reviewer **RVM PASS** (§4).

- **Status:** **DRAFTED — pending RVM (per-trade PASS). Not live.**
- **Date:** 2026-06-17 (shell) · 2026-06-18 (content drafted) · Gate owner: **RVM (hospitality subject-matter review)** · Drafts: ai-engineer/technical-writer/engineering.

---

## 1. Scope — the 9 hospitality trades (proposed; confirm at PRD sign-off)

| # | Display name | `trade_key` | Resume content | Interview-kit content |
| - | ------------ | ----------- | -------------- | --------------------- |
| 1 | Steward / Waiter | `hosp_steward_waiter` | ✅ drafted | ✅ drafted |
| 2 | Commis Chef / Cook | `hosp_commis_cook` | ✅ drafted | ✅ drafted |
| 3 | Room Attendant (Housekeeping) | `hosp_room_attendant` | ✅ drafted | ✅ drafted |
| 4 | Front Office Associate | `hosp_front_office` | ✅ drafted | ✅ drafted |
| 5 | F&B Captain | `hosp_fnb_captain` | ✅ drafted | ✅ drafted |
| 6 | Bartender | `hosp_bartender` | ✅ drafted | ✅ drafted |
| 7 | Kitchen Steward (Utility) | `hosp_kitchen_steward` | ✅ drafted | ✅ drafted |
| 8 | Banquet Server | `hosp_banquet_server` | ✅ drafted | ✅ drafted |
| 9 | Barista | `hosp_barista` | ✅ drafted | ✅ drafted |

> ✅ drafted = authored in source + transcribed in the [packet](./hospitality-trade-content-ratification-packet.md); **pending RVM PASS** (§4). Drafted ≠ approved ≠ live.

Structure = **exact parity** with manufacturing `TradeContent` + `InterviewKitContent` (no new
fields; no adjacency map — PRD §5). Source files (once authored):
[trade-content.ts](../../apps/api/src/resume/trade-content.ts) (`TRADE_CONTENT`) ·
[interview-kit-content.ts](../../apps/api/src/interview-kit/interview-kit-content.ts) (`INTERVIEW_KITS`).

## 2. What RVM's PASS gates (same rules as manufacturing)

RVM **PASS** (named reviewer + date) flips a trade from *provisional draft* → *production-ready*.
Green CI tests prove **presence/shape only — NOT accuracy**. RVM judges hospitality trade accuracy:
vocabulary, realistic questions, natural Hinglish, no fabricated specifics, correct hygiene/safety,
accurate resume copy. **CHANGES** keeps a trade provisional; partial (trade-by-trade) ratification
is allowed.

## 3. Per-trade content (×9) — DRAFTED (in the companion packet)

The full per-trade content (resume `TradeContent` + interview-kit `InterviewKitContent`) for
all 9 trades is transcribed verbatim — generated directly from the source files — in the
companion [hospitality-trade-content-ratification-packet.md](./hospitality-trade-content-ratification-packet.md),
exactly like the manufacturing packet. Review the content there; record verdicts in §4 here.

## 4. Ratification checklist — one row per trade (verdicts START EMPTY)

A trade is ratified only when its row carries an explicit **PASS** with reviewer + date.

| Trade | Resume OK? | Kit OK? | RVM verdict (PASS / CHANGES) | Changes requested | Reviewer | Date |
| ----- | ---------- | ------- | ---------------------------- | ----------------- | -------- | ---- |
| Steward / Waiter (`hosp_steward_waiter`) | [ ] | [ ] |  |  |  |  |
| Commis Chef / Cook (`hosp_commis_cook`) | [ ] | [ ] |  |  |  |  |
| Room Attendant (`hosp_room_attendant`) | [ ] | [ ] |  |  |  |  |
| Front Office Associate (`hosp_front_office`) | [ ] | [ ] |  |  |  |  |
| F&B Captain (`hosp_fnb_captain`) | [ ] | [ ] |  |  |  |  |
| Bartender (`hosp_bartender`) | [ ] | [ ] |  |  |  |  |
| Kitchen Steward (`hosp_kitchen_steward`) | [ ] | [ ] |  |  |  |  |
| Banquet Server (`hosp_banquet_server`) | [ ] | [ ] |  |  |  |  |
| Barista (`hosp_barista`) | [ ] | [ ] |  |  |  |  |

## 5. Per-trade RVM checklist (applies to every trade)

- [ ] Vocabulary accurate (hospitality service/kitchen terms + equipment)
- [ ] Questions realistic (a real interviewer for this role would ask them)
- [ ] Hinglish natural (correct, respectful — not machine-translated)
- [ ] No fabricated specifics (no invented certs/employers/numbers; trade-level, not per-worker)
- [ ] Hygiene/safety correct (food safety/HACCP, fire/spill, guest safety as relevant)
- [ ] Resume copy accurate (headline/summary/responsibilities/skills for the resume surface)

## 6. Cross-references

- [Hospitality PRD](../sprint-plans/hospitality-vertical-prd.md) (scope, structure parity, enum approach, sequence).
- Manufacturing gate this mirrors: [trade-content-ratification.md](./trade-content-ratification.md) · [trade-content-ratification-packet.md](./trade-content-ratification-packet.md).
- Content invariant: per-trade content is **deterministic, static, reviewed copy — NO LLM**, PII-free.
- Trade_key wiring: **mirror-and-sync** (PRD §6, Q10/TD31 deferred).
