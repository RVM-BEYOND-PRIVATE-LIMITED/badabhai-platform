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
### 2026-06-15 — Alpha-gate: Reach **feed serving** approved (RANK only; faceless, ops-only)
Approved building the **serving layer** on top of the already-implemented deterministic
`@badabhai/reach-engine` RANK core — surfaced in the **internal ops console (read-only)**
as two views: a worker-facing ranked **job feed** and a payer-facing ranked **applicant
list**. There is no payer/worker app or auth yet, so the alpha surface is ops-only.
- **Applicant list** reuses `rankWorkersForJob(job, workers[])` over the `worker_profiles`
  pool. **Worker job feed** reuses `scoreWorkerForJob` per candidate job and orders jobs
  best-first (the core does NOT provide jobs-for-a-worker; derive it, do not reimplement
  ranking math or fork the package). **`@badabhai/reach-engine` stays untouched.**
- **Faceless output only:** opaque `worker_id`/`job_id` + explainable score `components`
  + `hot`/`pushEligible`. NO worker contact info, NO employer name — consistent with the
  existing PII-free `feed.*` / `application.*` payloads.
- **Event-first:** reuse the already-defined `feed.shown` (emitted per impression).
  `application.submitted` / `application.skipped` endpoints are **deferred** out of this
  alpha slice (no worker app to apply from yet).
- **Job source** for the worker feed = the `job_postings` entity (ADR-0010, ops-created
  banded postings), which is **NOT merged yet** → architect must gate/stub it behind a
  **clean seam**; do NOT invent a parallel job store. Hard dependency, flagged.
- **SORT-NEVER-BLOCK preserved at the serving boundary:** the serving layer must not
  filter — count in == count out; `hot`/`pushEligible`/order change order, never hide.
- **Out of scope (Phase-2 fences):** PACE (release waves), PROTECT (contact caps /
  scraper blocking), LEARN (behavioural re-ranking), unlock/contact/payments, and any
  change to the reach-engine package itself. No LLM enters the rank/serve path.
- Hands to **system-architect** for an ADR. Supersedes nothing; opens the first
  Reach-consuming surface within the alpha gate.

### 2026-07-18 — TAX-WELD-1 ships: `role_welder` / `dom_welding` minted ahead of ADR-0028 Phase 1 (owner)

**Ruling: proceed and merge** (owner, verbatim: *"solve PR 412 and merge to main"*). Recorded
here because it is a deliberate, knowing deviation from a written ADR gate — not drift, and
not something a future reader should have to reconstruct from a diff.

**What was escalated.** A welder was unmatchable: *"TIG aur MIG machine chala leta hun"* and
*"Welder hun main"* both extracted to `role: null, trade: null, skill_ids: []`. The five
welding **skills** (`skill_mig_welding`, `skill_tig_welding`, `skill_arc_welding`,
`skill_gas_cutting`, `skill_welder_occupation`) already existed `status: "active"` with
English aliases (TIG / MIG / GTAW / GMAW / SMAW / stick welding), so wiring them into the
ai-service gazetteer minted **zero new `skill_id`s**. But there was **no `role_welder` and no
`dom_welding`** — `packages/taxonomy` held exactly 7 roles / 5 domains, all CNC/VMC — so a
non-null role + trade was unreachable without minting a **role** id.

**Why that needed a ruling.** [ADR-0028](../decisions/0028-international-occupation-taxonomy-adoption.md)'s
phase table gates **Phase 2** — *"`signals.py` / `canonical_roles.py` target the expanded
closed set"*, precisely this change — on **"Phase 1 merged AND Track A's staging `--real`
negative-tier eval passes."** Phase 1 has **not** merged. `profile_extractor.py` also carried
an explicit comment that bringing adjacent trades in scope "is an ADR-gated backend
workstream". So this is a **one-role slice of Phase 2 taken without Phase 1**.

**Ruled: accepted deviation, merge now.** Rationale recorded for the ADR's eventual Phase-1
author: the change is *additive to a closed whitelist* (ADR-0028 §(d) — "a larger **enumerated**
whitelist, not free text… strictly safer, never looser"); `normalize_role_id` still rejects
everything outside the set (`"mig_tig_welder"` stays rejected, pinned by test); and the
no-regression is **structural, not merely tested** — welding entries sit LAST in `signals._ROLES`
and matching is first-keyword-wins, so welding can only ever ADD a role where there was `None`.
Measured: replaying all 56 pre-change gold texts changed **exactly one line**, the welding one.

**What this does NOT do** — so nobody mistakes the slice for the phase:
- It does **not** discharge ADR-0028 Phase 1. The shared NCO-2015/ISCO-08 id space, the
  crosswalk, and the WS4 mapper backfill all remain unbuilt and still gated.
- It does **not** make a welder matchable end-to-end: the reach RANK Role factor exact-matches
  `canonical_role_id` against a job's `roleIds`, and **no seeded job maps to `role_welder`**.
  A welder is now profiled and matchable *in principle*, with nothing to match against.
- `apps/api/src/resume/trade-content.ts` has **no welding trade content** —
  `resolveTradeContent` returns `undefined`, so a welder's résumé falls back to generic copy.
  Graceful and non-fabricating, but thin.
- The **wedge set was NOT extended**. `test_wedge_set_is_fully_scored_on_real_vectors` asserts
  `len(snapshot.cases) == len(WEDGE_SET)` and `model != "mock-embedding"`, so adding a case
  needs REAL `gemini-embedding-001@768` vectors — ADR-0030 §7 gates (b) + (e), real spend +
  the PII-egress retention gate. Escalated rather than faking a snapshot. Wedge numbers are
  therefore unchanged: **anchor-path precision 1.000 / recall 0.350**. Do **not** cite the
  0.800 oracle for launch.
- **No vernacular alias was shipped.** Candidates for RVM (ADR-0030 gate (d)) are listed in
  PR #412 — `welding karta hun`, `welding wala kaam`, `katai gas se`, and `jodna` / `jod ka
  kaam` (flagged **high false-positive risk**, do not ship without ratification).
- **Genuinely missing, reported not created:** `skill_spot_welding` (a distinct process; today
  falls through to the generic welding token), `skill_gas_welding` (the corpus has gas
  *cutting* only), and no welding `mach_*` id exists.

### 2026-07-17 — Context-drift register rulings (owner, all ten — verbatim mapping)
Owner answered the full [context-drift-2026-07-16](./context-drift-2026-07-16.md) decision
queue in one pass. Recorded here so no builder re-litigates them:

1. **A-1 (city ruling): the "cities are NOT PII" instruction is WITHDRAWN** — owner agreed
   with the register's analysis. Cities stay masked from LLM input; the local-gazetteer
   read (trusted service, no network) remains the matching path. No code change.
2. **A-2 (Skills-15 / weight-lock governance): the 2026-06-19 CEO weight lock IS OPERATIVE**
   — "the new decision supersedes the CEO's older decision" (i.e. it overrides ADR-0006's
   ratified code-wins direction for the weight ledger). Consequence: a deterministic
   **skills factor (weight 15) enters RANK via its own ADR**, which must edit
   `packages/reach-engine/src/no-skills-in-rank.test.ts` in the same diff (the lock test
   anticipates exactly this). LLMs/embeddings still never rank (invariant #4) — the factor
   is closed-set `skill_id` overlap, deterministic.
3. **B-1 (payer verification gate): DEFERRED** — "change this later when we move closer to
   absolute production; right now let it be." `payers.status="pending"` stays unenforced
   for the alpha; the register row stands as the tripwire.
4. **B-9/B-10 (cost target + rollup + auto-downgrade): DEFERRED** — "no change in pricing,
   decide later." Code stays ₹4/call target; the "4 paise" headline must NOT be cited
   until a per-profile rollup exists.
5. **B-7 (caps): DOCS ADOPT CODE** — "change it in the docs." The real numbers are ratified:
   5 unlocks/worker/**day**, 30/payer/**hour** (no daily account ceiling), 10 distinct
   payers/worker/week. The external context doc must be corrected to these.
6. **B-8 (attribution key): STAYS invite-code-keyed** for now; no phone tie-break, no
   90-day window column. Revisit explicitly, not by drift.
7. **B-2 (LLM résumé-prose path): KEEP, as a gated add-on feature** — not deleted. It stays
   behind default-false `AI_ENABLE_REAL_CALLS`; PDF remains deterministic-only.
8. **D-2 (voice 30s vs 120s): BUILD IT PROPERLY = ASYNC STT** — owner wants the async
   transcription path for 30–120s notes, not a UI cap. Real Sarvam creds remain §7.
9. **D-3 (smoke/dev login): APPROVED — a gated test-login (session-mint) seam** "by default
   just for testing." Hard constraints: env-gated OFF in production, strong token, never
   `DEV_QUICK_LOGIN` (that stays dead), and it becomes the staging-smoke's auth path +
   unblocks the RUN_E2E-skipped HTTP suites.
10. **§13.1 (Flutter IAP) + §13.2 (Grievance Officer / production DPDP copy): DEFERRED**
    to near-production.

*Execution note:* B-4/B-5/B-6/B-11/B-12/D-1/D-6 + the in-repo doc-drift strings were
greenlit wholesale ("complete all the tasks now") and ship as the 2026-07-17 build wave.

### 2026-07-17 — A-2 EXECUTED: the 06-19 CEO weight lock is in the code (ADR-0033)
Ruling 2 above is **built**, same day, as
[ADR-0033](../decisions/0033-rank-skills-overlap-factor.md). This row exists so the
**2026-06-12 row above is not read as current** — it is **superseded on the weight ledger
only**, and the supersession chain (06-12 code-wins → 06-19 CEO lock → 07-17 owner
confirmation) is recorded in the ADR.
- **Shipped ledger:** Trade .35 / Location .20 / **Skills .15 (NEW)** / Experience .15 /
  Pay .10 / Availability **.05** (was .10) / Activity **0** (was .10). Σ = 1.00 — the CEO
  table verbatim; no renormalization was needed (the lock listed a full ledger).
- **The factor is deterministic:** `|worker ∩ jobRequired| / |jobRequired|` over canonical
  closed-set `skill_id` tokens, **exact equality only — no embeddings, no similarity, no
  model call, no clock** (invariant #4 absolute; the vector layer assigns ids UPSTREAM at
  profiling/posting time). SORT-NEVER-BLOCK preserved; skill ids are faceless (no PII).
- **Zero-set semantics:** a job listing **no** skills → the .15 is **redistributed**, so the
  **skills factor** cannot rank it (chosen over "score 1.0", which would have inflated every
  such job +0.15); a worker with **no** confirmed skills → **0 on that factor only**, never a
  block (a deliberate, ruling-mandated trim of ADR-0006's neutral-default rule — max −0.15,
  sort-only, chat can confirm later).
- **⚠️ THIS DEPLOY RE-RANKS EVERY LIVE FEED — know before merging.** Redistribution neutralizes
  the skills factor only; the same ledger's **availability .10→.05** and **activity .10→0** hit
  every job, and with the demand side unwired every job takes that path. **Measured: 5000/5000
  scores changed, max |Δ| 0.109538, 413/5000 (8.3%) pushEligible flips, 200/200 fleet orders
  changed.** Example inversion: active-but-mid-availability 0.950→0.9706 loses to
  available-but-inactive 0.920→1.000. This is the **ledger's intent** (activity is not a CEO
  signal) — shipping skills alone would leave availability/activity still violating the lock,
  i.e. perpetuating the very drift A-2 exists to close. Pinned by a golden regression test.
  *(An earlier version of this row and the ADR claimed "byte-identical" / "zero behaviour
  change today" — FALSE, retracted; the claim was never measured before it was written.)*
- **The TAX-6 CI lock was edited in the same diff** (its own instruction) → now the
  **INVERSE lock**: the `/embedding/i` half is **KEPT and widened** (`cosine|similarity`),
  plus determinism greps and a pin on the full weight ledger. Filename kept so existing
  references still resolve.
- **The SKILLS FACTOR is inert in serving** (the `jobs` entity has no skill column — ids
  live on `job_postings`, no join path, **TD37**) — but see the re-ranking warning above:
  **inert factor ≠ unchanged output.** Supply side rides the existing single-query
  projection (no N+1). Knock-ons: PACE thin-supply counts shift (bounded — `PACE_ENABLED=
  false`); `feed.shown` **values** switch regime with no marker (schema unchanged → invariant
  #8 holds; the offline LEARN corpus mixes regimes across the deploy boundary);
  `db:verify:reach` check (a)'s published seeded-pool numbers need re-baselining.
- **Two interpretations flagged for veto** (the ledger was silent): **I1** "drop Activity"
  = weight 0 with the component retained (it is the recency tie-break + a LEARN feature
  axis); **I2** the skills-less-job redistribution. Both are in the ADR.
- `@badabhai/reach-learn` baseline **pinned to the pre-0033 six-signal set** — offline,
  unchanged, still no live influence (ADR-0017). Recalibration = tracked follow-up.
- No schema, no migration, no event-payload change. Rollback = revert the commit.
