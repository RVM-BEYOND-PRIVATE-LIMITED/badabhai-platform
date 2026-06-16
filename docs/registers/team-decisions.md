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

### 2026-06-12 — Reach RANK weights: implemented set is authoritative; Skills + embeddings deferred
The **implemented** `scoring.ts` weights — Trade .35 / Location .20 / Experience .15 /
Pay .10 / **Availability .10** / **Activity .10**, **no Skills signal, no embeddings** — are
the **source of truth**. The master-context ledger's "locked" Σ100 (Trade 35 · Location 20 ·
**Skills 15** · Experience 15 · Salary 10 · **Availability 5**) and the idea of **Vertex
embeddings for skills-similarity** are treated as a **draft / Phase-2 direction**, NOT
day-one: the day-one engine is deterministic, dependency-free, and never calls a model
(Vertex embeddings serve the *profiling* AI service, not Reach ranking). Ratified in
[ADR-0006](../decisions/0006-reach-foundation-rank-core.md) ("Ratified scope vs the locked
weight columns"). Don't re-open from the ledger without a new row here. *(Re-confirms the
2026-06-12 "leave code as-is; the doc is the draft" call.)*

### 2026-06-15 — Alpha gate: ops Job Posting flow (banded, stored-only) — APPROVED
A new, **strictly additive** Job Posting flow is approved for the alpha gate. An
**ops actor** (not an employer) creates internal job postings via the web ops console;
each posting is **stored only** — no matching, no ranking, no Reach Engine, no payments,
no employer/payer self-serve. **Decisions logged (not re-litigated):**
- **Vacancy is banded**, exactly one of `"1" | "2-5" | "6-10" | "11-25" | "25+"` — a
  constrained enum, **not** a free integer and **not** salary bands.
- **No Employer entity** (dead decision). The row stores an **opaque `created_by`** (the
  ops actor id) + **NON-PII** org/role free text. No `employers` table.
- New module `apps/api/src/job-postings`, new `job_postings` table, new `job_posting.*`
  v1 event(s) (`actor_type = "ops"`), new ops-console route (list + banded form,
  internal, read-no-PII), plus unavoidable wiring (root module import, event-registry +
  domain/subject enum entry, nav link). **No existing table/column/event-payload/module
  is mutated.**
- Endpoints: **create / list / get / update / close** — each important endpoint emits a
  validated `job_posting.*` event. CLAUDE.md §2 invariants hold: event-first; **no PII**
  in events/`ai_jobs`/`audit_logs`/logs.
- **Lifecycle (minimal):** `draft → open → closed` (close is terminal).
*Coexistence flag (for the ADR stop point):* this is **distinct from the `jobs` entity
in open PR #42** (`feat/jobs-entity-lifecycle`) — that one is Reach-Engine-facing
(opaque **payer**, **integer** `vacancy_count`, applicant quota/lifecycle/boost,
`job.*` events). Recommendation: **keep them as two separate additive concerns** per the
requester's decision, but the human should confirm at the ADR that the overlap is
intentional and naming stays unambiguous (`job_posting.*` vs `job.*`). Scope brief handed
to system-architect for the ADR (no ADR written here).
