# PRD — Hospitality vertical (scope + plan, PENDING PRODUCT SIGN-OFF)

> **HUMAN GATE — SCOPE DOC, NOT A BUILD.** This is the product-manager scope/PRD for a
> **second vertical** beyond manufacturing. **No per-trade content is authored yet** and
> **no code/enum is changed.** Per the product call (2026-06-17), the sequence is:
> **this PRD + the ratification-packet shell → product sign-off → THEN author the content**
> (drafted, pending RVM) → RVM PASS (human gate) → live. Opening hospitality is **net-new
> product surface, NOT alpha** (CLAUDE.md §1: Phase-1 is narrow/locked to CNC/VMC
> manufacturing).

- **Status:** **DRAFT — pending product sign-off** to authorize authoring.
- **Date:** 2026-06-17 · **Owner:** product-manager (scope) + ai-engineer/technical-writer (draft, later) + backend-engineer (taxonomy wiring, later) + database-architect (trade_key touch, later).
- **Relates:** [trade-content.ts](../../apps/api/src/resume/trade-content.ts) · [interview-kit-content.ts](../../apps/api/src/interview-kit/interview-kit-content.ts) (the manufacturing pattern to mirror) · [trade-content-ratification.md](../registers/trade-content-ratification.md) (the RVM gate pattern) · Q10 / TD31 (trade_key enum drift / shared taxonomy).

---

## 1. Problem & opportunity

BadaBhai's content engine (per-trade resume + interview-kit copy, deterministic, no-LLM,
RVM-ratified) is proven for **manufacturing** (15 trades, 9 RVM-ratified). The same engine
generalizes to other blue/grey-collar verticals at near-zero marginal infra cost — the
content is the moat. **Hospitality** (hotels, restaurants, catering, QSR) is a large
India blue/grey-collar segment with the same need: turn a worker's chat into a credible
resume + interview kit. This PRD scopes hospitality as the **second vertical**, reusing the
exact content structure and the RVM ratification gate.

## 2. Scope

**In scope (this PRD authorizes, after sign-off):**
- A defined hospitality **trade list** (§3) with, per trade, the **same content structure**
  as manufacturing: resume `TradeContent` + interview-kit `InterviewKitContent` (§5).
- **Taxonomy/trade_key wiring** for the new trades (§6), backward-compatible — manufacturing
  unaffected.
- **Presence/shape tests** covering the hospitality trades exactly as manufacturing (§7).
- An **RVM-style per-trade ratification packet** (the shell ships with this PRD; content
  fills after authoring sign-off). Content is **"drafted, pending RVM" — not live** (§8).

**Out of scope (explicitly):**
- **Not alpha.** Hospitality does not enter the Phase-1 alpha; it ships behind the RVM gate.
- **No live serving** of hospitality content before per-trade RVM PASS.
- **No adjacency map** (product call 2026-06-17 — "leave it for now"): hospitality mirrors
  the **exact** existing `TradeContent`/`InterviewKitContent` structure; **no new field** is
  added to either vertical. (A related-trade adjacency map is a possible later enhancement.)
- **No TD31 refactor now** (product call): the trade_key enum is handled by **mirror-and-sync**
  (§6), not by extracting a shared taxonomy package. TD31 stays deferred.
- No new ranking/matching, no employer surface, no payments — content only.

## 3. Trade list (proposed — confirm/adjust at sign-off)

Nine trades, mirroring the 9 ratified manufacturing trades (entry/mid, chat-profilable,
resume-worthy). `trade_key` slugs are **stable** once authored.

| # | Display name | `trade_key` (proposed) | Notes |
| - | ------------ | ---------------------- | ----- |
| 1 | Steward / Waiter | `hosp_steward_waiter` | F&B service, core volume role |
| 2 | Commis Chef / Cook | `hosp_commis_cook` | Kitchen production |
| 3 | Room Attendant (Housekeeping) | `hosp_room_attendant` | Housekeeping core |
| 4 | Front Office Associate | `hosp_front_office` | Reception / guest service |
| 5 | F&B Captain | `hosp_fnb_captain` | Service team lead |
| 6 | Bartender | `hosp_bartender` | Bar service |
| 7 | Kitchen Steward (Utility) | `hosp_kitchen_steward` | Dishwash / kitchen utility |
| 8 | Banquet Server | `hosp_banquet_server` | Events / catering service |
| 9 | Barista | `hosp_barista` | Café / coffee service |

> Naming: a `hosp_` prefix keeps hospitality keys unambiguous next to manufacturing keys and
> makes the vertical filterable. Final list/keys are **product's call at sign-off**.

## 4. Success criteria

- All 9 trades have resume + kit content matching the manufacturing structure (§5), and
  **green presence/shape tests** (§7) — green tests prove *shape*, not accuracy.
- A complete **RVM ratification packet** (§8); content stays **provisional** until per-trade
  RVM PASS.
- **Zero impact on manufacturing** — no manufacturing content, test, or type changes; the
  trade_key change is purely additive.

## 5. Content structure — EXACT parity with manufacturing (no new fields)

Hospitality reuses the **existing** interfaces unchanged (zero type/schema churn):
- **Resume:** `TradeContent` — `trade_key, display_name, headline_template, summary_template,
  core_skills, machine_tools, inspection_tools, responsibilities, safety_points,
  experience_phrases, fresher_phrases, certification_phrases, keywords, taxonomy_role_ids?`.
- **Interview kit:** `InterviewKitContent` — `trade_key, display_name, overview,
  common_questions, practical_questions, safety_questions, drawing_measurement_questions,
  skill_checklist, revise_before, documents_to_carry, common_mistakes, hinglish_note`.

**Field-semantics mapping (proposed; confirm at sign-off).** The field *names* stay identical
for structural parity and zero churn; their *content* adapts to hospitality:

| Field (manufacturing flavor) | Hospitality reading |
| ---------------------------- | ------------------- |
| `machine_tools` | service/kitchen **equipment** (POS, coffee machine, chafing dishes, bar tools, housekeeping cart) |
| `inspection_tools` | service **tools/checks** (order pad/KOT, checklists, thermometer, hygiene/HACCP checks) |
| `safety_points` | **hygiene + safety** (food safety/HACCP, fire/spill, guest safety, PPE where relevant) |
| `drawing_measurement_questions` | **standards/measurement** questions (portion control, recipe/spec adherence, billing accuracy, room-readiness standards) |

> If product prefers renamed/added fields for hospitality, that becomes a typed-contract
> change (Zod/Pydantic + the @badabhai/db touch) and a bigger task — flagged, not assumed.
> The default is **reuse-as-is** (the EXACT structure the task asked to mirror).

The content invariant is unchanged: **deterministic, static, reviewed copy — NO LLM**, and
**PII-free** (per-trade, never per-worker), with `{{role}}`/`{{years}}`/`{{primary_machine}}`-style
template vars filled by the renderer from profile facts.

## 6. Taxonomy / trade_key wiring (Q10 / TD31) — MIRROR-AND-SYNC (product call)

- Add the 9 hospitality `trade_key`s to `REQUIRED_TRADE_KEYS` (`trade-content.ts`) +
  `REQUIRED_KIT_TRADE_KEYS` (`interview-kit-content.ts`), and to the **mirrored `TradeKey`
  union in `@badabhai/db` (`schema.ts`)**, preserving the existing "keep in sync" comment.
- **Backward-compatible / additive only:** no existing key renamed/removed; `jobs.trade_key`
  accepts the new values; **manufacturing trades are untouched**.
- **TD31 stays deferred** (product call): we do **not** extract a shared taxonomy package now.
  Q10's drift risk is unchanged (still two synced copies) — re-evaluate TD31 when a third
  vertical or a real divergence forces it.
- `taxonomy_role_ids` is **optional** and may be empty for hospitality (the `@badabhai/taxonomy`
  role-set is CNC/VMC today); populating hospitality role ids is a later, separate taxonomy task.

## 7. Test plan (gate: bb-testing + quality-gate)

Mirror the manufacturing presence/shape suites for the hospitality trades:
- Every hospitality `trade_key` in `REQUIRED_TRADE_KEYS` has a `TradeContent` row; every
  required field present, non-empty, correct shape; lists meet min-length; template vars only
  the allowed set.
- Every hospitality `trade_key` in `REQUIRED_KIT_TRADE_KEYS` has an `InterviewKitContent`;
  all sections present/non-empty; `documents_to_carry` includes the COMMON_DOCS baseline;
  `hinglish_note` present.
- A render parity test (like the manufacturing approved-content render tests) once content is
  authored. **Green = shape, not accuracy** — accuracy is the RVM gate.

## 8. RVM ratification (HUMAN gate — content is "drafted, pending RVM", not live)

Mirrors the manufacturing gate: the
[hospitality ratification packet](../registers/hospitality-trade-content-ratification.md)
(shell shipped with this PRD) carries the per-trade resume + kit content (filled after
authoring sign-off) + a per-trade **PASS/CHANGES** checklist. **RVM PASS by a named reviewer
is the only signal that flips a trade from provisional draft to production-ready.** Until then
each trade renders nowhere live; partial ratification is allowed (trade-by-trade).

## 9. Sequence & gates

1. **THIS PRD + ratification-packet shell → product sign-off** (you are here).
2. ai-engineer/technical-writer **author** the 9 trades (drafted, pending RVM); technical-writer
   confirms **parity** with manufacturing; bb-testing green.
3. backend-engineer + database-architect land the **mirror-and-sync** trade_key wiring (§6),
   backward-compatible.
4. RVM ratification pass (per-trade PASS) — **human gate**; then go-live decision.

**Do not author content or change the enum before step 1 sign-off.**
