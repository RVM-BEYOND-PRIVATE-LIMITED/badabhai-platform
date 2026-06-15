# Trade Content Ratification Register — RVM content gate

**Purpose.** Track the human review and sign-off of the per-trade, deterministic,
no-LLM content that BadaBhai renders into worker resumes and interview kits. This
register is the gate between *engineering-drafted copy* and *content RVM has
vouched is accurate* for CNC/VMC and the rest of the alpha trade set.

> **HUMAN GATE — drafted, pending RVM. NOT final / NOT approved.**
> Everything tracked below is **drafted by engineering** and **awaiting RVM
> ratification**. No row here may be described as "final", "approved", or
> "signed off" until a named RVM reviewer ticks its checklist and dates it.
> Until then the content is *live as the Phase-1 default* but **provisional** —
> any RVM correction supersedes it. RVM ratification is a human judgement call
> on trade accuracy; engineering cannot self-certify it.

Seeded 2026-06-15. Owner of the gate: **RVM (CNC/VMC subject-matter review)**.
Owner of the drafts: Prakash / engineering.

> **📦 The reviewable artifact RVM signs off is the
> [Trade Content Ratification Packet](./trade-content-ratification-packet.md)** (added
> 2026-06-15) — it embeds the full per-trade resume + interview-kit content for the 9
> drafted trades plus the authoritative PASS/CHANGES checklist. This register stays the
> high-level tracker; the **packet's checklist is where RVM records the trade-by-trade
> verdict**.

---

## 1. Scope — the 15 alpha trades

The alpha trade set is the 15 trades defined in
[`apps/api/src/resume/trade-content.ts`](../../apps/api/src/resume/trade-content.ts).
These 15 also cover all 7 alpha taxonomy roles in `@badabhai/taxonomy` (the
`role_*` ids map onto these trades via each row's `taxonomy_role_ids`). Every
alpha trade must have **both** resume content **and** interview-kit content before
the Phase-1 worker journey is content-complete.

Two source files, two content surfaces:

- **Resume content** → [`apps/api/src/resume/trade-content.ts`](../../apps/api/src/resume/trade-content.ts)
- **Interview-kit content** → [`apps/api/src/interview-kit/interview-kit-content.ts`](../../apps/api/src/interview-kit/interview-kit-content.ts)

---

## 2. Status matrix — 15 trades × 2 surfaces

Status values:
- **seeded (prior)** — content existed before 2026-06-15; not re-reviewed in this pass.
- **drafted 2026-06-15 (pending RVM)** — drafted in this content pass; awaiting ratification.

All cells are **pending RVM** regardless of when drafted — "seeded (prior)" only
records *when* the copy landed, not that it has been ratified.

| # | trade_key | Display name | Resume content | Interview-kit content |
| - | --------- | ------------ | -------------- | --------------------- |
| 1 | `cnc_operator` | CNC Operator | seeded (prior) | seeded (prior) |
| 2 | `vmc_operator` | VMC Operator | seeded (prior) | seeded (prior) |
| 3 | `cnc_vmc_setter` | CNC/VMC Setter | seeded (prior) | drafted 2026-06-15 (pending RVM) |
| 4 | `cnc_programmer` | CNC Programmer | seeded (prior) | drafted 2026-06-15 (pending RVM) |
| 5 | `vmc_programmer` | VMC Programmer | seeded (prior) | drafted 2026-06-15 (pending RVM) |
| 6 | `cad_designer` | CAD Designer | seeded (prior) | seeded (prior) |
| 7 | `solidworks_designer` | SolidWorks Designer | seeded (prior) | drafted 2026-06-15 (pending RVM) |
| 8 | `autocad_draftsman` | AutoCAD Draftsman | seeded (prior) | drafted 2026-06-15 (pending RVM) |
| 9 | `quality_inspector` | Quality Inspector | seeded (prior) | seeded (prior) |
| 10 | `production_engineer` | Production Engineer | seeded (prior) | seeded (prior) |
| 11 | `maintenance_technician` | Maintenance Technician | seeded (prior) | seeded (prior) |
| 12 | `tool_room_technician` | Tool Room Technician | seeded (prior) | drafted 2026-06-15 (pending RVM) |
| 13 | `machine_operator` | Machine Operator | seeded (prior) | drafted 2026-06-15 (pending RVM) — see Flag A |
| 14 | `assembly_technician` | Assembly Technician | seeded (prior) | drafted 2026-06-15 (pending RVM) |
| 15 | `fitter` | Fitter | seeded (prior) | drafted 2026-06-15 (pending RVM) |

**Coverage:** resume content = 15/15 (complete before this pass); interview-kit
content = 15/15 (6 seeded prior + 9 drafted 2026-06-15). `REQUIRED_KIT_TRADE_KEYS`
now lists all 15 and tests are green — but green tests prove *presence and shape*,
**not** trade accuracy. Accuracy is exactly what this gate is for.

---

## 3. Flags for RVM attention

These two items came out of the 2026-06-15 drafting pass and need an explicit RVM
call. They are **not** blockers to reviewing the rest — they are pointed asks.

**Flag A — `machine_operator` kit is intentionally GENERIC.**
The Machine Operator kit is deliberately broad and machine-agnostic, because the
trade itself is defined generically in `trade-content.ts` (it is the catch-all
production-machine role, not a specific CNC/VMC seat). This is **not a gap** — it
is the least trade-specific kit by design. RVM should confirm the generic framing
is acceptable for this role and that nothing in it should be sharpened into a more
specific machine context.

**Flag B — "AutoCAD Draftsman" spelling.**
The interview kit uses the display name **"AutoCAD Draftsman"** verbatim from
`trade-content.ts`. If RVM prefers the British **"Draughtsman"**, the change must
be made in `trade-content.ts` **first** (it is the single source of the display
name; the kit mirrors it). Changing only the kit would desync the two surfaces.
That edit is **out of scope for this register** — log the RVM decision here and
hand it to engineering.

---

## 4. Per-role ratification checklist

One checklist per trade for the RVM reviewer to tick. **All boxes start
UNCHECKED.** A trade is *ratified* only when every box below it is ticked, signed
with the reviewer's name, and dated. Tick the surface(s) you reviewed in this
sitting — partial ratification is fine as long as the date/reviewer is recorded.

Checklist meaning (applies to every trade):
- **Vocabulary** — trade/machine vocabulary (CNC/VMC, tooling, controls,
  instruments) is accurate and current for this role.
- **Questions realistic** — common / practical / safety / drawing-measurement
  questions are ones a real interviewer for this role would actually ask.
- **Hinglish natural** — the `hinglish_note` reads naturally and is correct,
  respectful Hinglish (not awkward machine-translation).
- **No fabricated specifics** — no invented certifications, company names,
  numbers, or claims a worker hasn't made; content stays trade-level, not
  per-worker.
- **Safety correct** — PPE / LOTO / guarding / handling guidance is technically
  correct and complete for the role.
- **Resume copy accurate** — headline / summary / responsibilities / safety
  points / skills vocabulary for the resume surface are accurate (resume file).

### 1. CNC Operator (`cnc_operator`)
- [ ] Vocabulary accurate (CNC/VMC + instruments)
- [ ] Questions realistic
- [ ] Hinglish natural
- [ ] No fabricated specifics
- [ ] Safety correct
- [ ] Resume copy accurate
- Reviewer: ____________  Date: __________

### 2. VMC Operator (`vmc_operator`)
- [ ] Vocabulary accurate (CNC/VMC + instruments)
- [ ] Questions realistic
- [ ] Hinglish natural
- [ ] No fabricated specifics
- [ ] Safety correct
- [ ] Resume copy accurate
- Reviewer: ____________  Date: __________

### 3. CNC/VMC Setter (`cnc_vmc_setter`)
- [ ] Vocabulary accurate (CNC/VMC + instruments)
- [ ] Questions realistic
- [ ] Hinglish natural
- [ ] No fabricated specifics
- [ ] Safety correct
- [ ] Resume copy accurate
- Reviewer: ____________  Date: __________

### 4. CNC Programmer (`cnc_programmer`)
- [ ] Vocabulary accurate (CNC/VMC + instruments)
- [ ] Questions realistic
- [ ] Hinglish natural
- [ ] No fabricated specifics
- [ ] Safety correct
- [ ] Resume copy accurate
- Reviewer: ____________  Date: __________

### 5. VMC Programmer (`vmc_programmer`)
- [ ] Vocabulary accurate (CNC/VMC + instruments)
- [ ] Questions realistic
- [ ] Hinglish natural
- [ ] No fabricated specifics
- [ ] Safety correct
- [ ] Resume copy accurate
- Reviewer: ____________  Date: __________

### 6. CAD Designer (`cad_designer`)
- [ ] Vocabulary accurate (CAD/GD&T + instruments)
- [ ] Questions realistic
- [ ] Hinglish natural
- [ ] No fabricated specifics
- [ ] Safety correct
- [ ] Resume copy accurate
- Reviewer: ____________  Date: __________

### 7. SolidWorks Designer (`solidworks_designer`)
- [ ] Vocabulary accurate (CAD/GD&T + instruments)
- [ ] Questions realistic
- [ ] Hinglish natural
- [ ] No fabricated specifics
- [ ] Safety correct
- [ ] Resume copy accurate
- Reviewer: ____________  Date: __________

### 8. AutoCAD Draftsman (`autocad_draftsman`) — see Flag B (spelling)
- [ ] Vocabulary accurate (CAD/GD&T + instruments)
- [ ] Questions realistic
- [ ] Hinglish natural
- [ ] No fabricated specifics
- [ ] Safety correct
- [ ] Resume copy accurate
- [ ] Display-name spelling decision (Draftsman vs Draughtsman) recorded
- Reviewer: ____________  Date: __________

### 9. Quality Inspector (`quality_inspector`)
- [ ] Vocabulary accurate (CNC/VMC + instruments)
- [ ] Questions realistic
- [ ] Hinglish natural
- [ ] No fabricated specifics
- [ ] Safety correct
- [ ] Resume copy accurate
- Reviewer: ____________  Date: __________

### 10. Production Engineer (`production_engineer`)
- [ ] Vocabulary accurate (shop-floor / lean)
- [ ] Questions realistic
- [ ] Hinglish natural
- [ ] No fabricated specifics
- [ ] Safety correct
- [ ] Resume copy accurate
- Reviewer: ____________  Date: __________

### 11. Maintenance Technician (`maintenance_technician`)
- [ ] Vocabulary accurate (mechanical/electrical + LOTO)
- [ ] Questions realistic
- [ ] Hinglish natural
- [ ] No fabricated specifics
- [ ] Safety correct (LOTO / electrical)
- [ ] Resume copy accurate
- Reviewer: ____________  Date: __________

### 12. Tool Room Technician (`tool_room_technician`)
- [ ] Vocabulary accurate (jig/fixture/die + precision instruments)
- [ ] Questions realistic
- [ ] Hinglish natural
- [ ] No fabricated specifics
- [ ] Safety correct (grinding-wheel)
- [ ] Resume copy accurate
- Reviewer: ____________  Date: __________

### 13. Machine Operator (`machine_operator`) — see Flag A (generic by design)
- [ ] Generic framing confirmed acceptable for this role
- [ ] Vocabulary accurate (machine-agnostic + instruments)
- [ ] Questions realistic
- [ ] Hinglish natural
- [ ] No fabricated specifics
- [ ] Safety correct
- [ ] Resume copy accurate
- Reviewer: ____________  Date: __________

### 14. Assembly Technician (`assembly_technician`)
- [ ] Vocabulary accurate (assembly/BOM/torque)
- [ ] Questions realistic
- [ ] Hinglish natural
- [ ] No fabricated specifics
- [ ] Safety correct
- [ ] Resume copy accurate
- Reviewer: ____________  Date: __________

### 15. Fitter (`fitter`)
- [ ] Vocabulary accurate (bench work + measuring tools)
- [ ] Questions realistic
- [ ] Hinglish natural
- [ ] No fabricated specifics
- [ ] Safety correct
- [ ] Resume copy accurate
- Reviewer: ____________  Date: __________

---

## 5. Source files + how to apply RVM edits

| Surface | File | Notes |
| ------- | ---- | ----- |
| Resume content | [`apps/api/src/resume/trade-content.ts`](../../apps/api/src/resume/trade-content.ts) | `TRADE_CONTENT` rows; also the single source of every trade's `display_name`. |
| Interview-kit content | [`apps/api/src/interview-kit/interview-kit-content.ts`](../../apps/api/src/interview-kit/interview-kit-content.ts) | `INTERVIEW_KITS` rows; `REQUIRED_KIT_TRADE_KEYS` lists the required 15. |

**When RVM edits interview-kit copy:** bump
`INTERVIEW_KIT_CONTENT_VERSION` (typed env, default `1`, in
[`packages/config/src/server.ts`](../../packages/config/src/server.ts) and
[`.env.example`](../../.env.example)). Render-once identity is
`{trade_key}:v{INTERVIEW_KIT_CONTENT_VERSION}`, so a fresh PDF only renders if the
version changes — **never reuse an old value**. `trade_key` ids are STABLE; do not
rename them. The Machine Operator generic framing (Flag A) and any
Draftsman/Draughtsman rename (Flag B) both require a version bump because they
change rendered copy.

**When RVM edits the display name (Flag B):** change it in `trade-content.ts`
first (source of truth); the kit mirrors it. Treat the rename as a copy change →
bump `INTERVIEW_KIT_CONTENT_VERSION` too.

---

## 6. Cross-references

- Tech debt: [TD24a](./tech-debt-register.md) — per-trade content is curated
  static copy (no LLM); this register is its content-review gate.
- Sprint plan: [Phase-1 worker profiling](../sprint-plans/phase-1-worker-profiling.md).
- Content invariant: per-trade content is **deterministic, static, reviewed copy —
  no LLM**, and PII-free (per-trade, never per-worker).
