# Team Decisions

Lightweight decisions that aren't worth a full ADR but should not be re-litigated
from memory: priorities, scope calls, vendor leans, process choices. Append-only;
supersede with a new dated row rather than editing history.

---

### 2026-06-09 — Revenue model: employer-pays-to-unlock
Employers and staffing agencies pay to **unlock** profiled candidates' contact
details / full profiles. **Workers are free.** This is the intended monetization
behind the deferred unlock/payments work and frames the Phase-2 PRD.
*Implication:* worker-side experience optimizes for completeness and trust;
employer-side optimizes for unlock conversion. Pricing shape is [open Q2](./open-questions.md).

### 2026-06-09 — Team size assumption: 2–5 engineers
Quality gates and process are calibrated for a small team: **automation-first
checks + exactly one human reviewer**. Where a dedicated human role (security,
performance) would normally review, the corresponding **agent** performs it and
the human reviewer confirms it happened. Revisit if the team grows past ~6.

### 2026-06-09 — Immediate priority: close Phase-1 "next" items
Before any Phase-2 work, finish the 🔜 items in the
[Phase-1 plan](../sprint-plans/phase-1-worker-profiling.md): move extraction/
transcription to BullMQ jobs, real OTP provider, finalize Supabase RLS, real
Sarvam STT, and enable real LLM in **staging**. Phase 2 (Reach Engine, employer,
payments) does **not** start without a new decision row here.

### 2026-06-09 — Adopted the engineering-org layer
Stood up `.claude/agents` (15 roles), `.claude/skills` (16 `bb-*` skills), the
[development workflow](../engineering-org/development-workflow.md),
[quality gates](../engineering-org/quality-gates.md), and these registers as the
operating model. Skills are `bb-`-prefixed to avoid shadowing Claude Code
built-ins (`/code-review`, `/security-review`, etc.).
