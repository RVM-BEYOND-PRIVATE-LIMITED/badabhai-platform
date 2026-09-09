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
   > **SUPERSEDED 2026-08-03 by [ADR-0037](../decisions/0037-payer-lifecycle-and-suspension.md)**
   > (owner rulings 2026-08-02/03). The tripwire fired: an audit found `payers.status` was
   > not merely unenforced but *unwritable* — nothing ever set `active`, so the shipped
   > admin suspend route returned 409 for 100% of real payers while no request path read
   > the column. Deferring enforcement had left a documented admin capability that could
   > not work. `payers.status` is now read by `PayerAuthGuard` on every payer request.
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

### 2026-07-31 — Release endgame: eight owner rulings (Prakash, on the ratified 2026-07-30 doc set)

Source of truth for the release is the five ratified documents (Sales & Marketing Plan v4,
Growth-Tech Playbook v1.0, Persona System v3.2, MASTER CONTEXT 2026-07-30, Matching Algorithm
V1). Where a document disagrees with audited code, **the code wins**; where the code disagrees
with a ruling below, **the ruling wins and the code changes.**

1. **Matching V1 REPLACES the weighted Reach Engine** — both surfaces (worker feed and the
   company's paid candidate list). The 35/20/15/15/10/5 ledger, `hot`, and `pushFloor` retire
   with it. Supersedes the ranking halves of ADR-0011 / ADR-0015 / ADR-0033.
2. **E3 sharp edge → tier-with-floor, threshold 36 months.** A related-skill worker enters
   tier-1 ordering once his related-skill months ≥ 36. This deliberately inverts the strict-tier
   illustration printed in the V1 doc's E3 (a 6-month VMC operator no longer outranks a
   ten-year CNC turner). The threshold is config (`match_config.tier_floor_months`), not code.
3. **`job_postings` becomes THE served job entity.** The legacy `jobs` table and its seeded
   fixtures retire from the worker path; open seeded rows are converted to postings at cutover
   so the feed is never empty. Resolves the two-entity split (TD37) in the serving direction.
4. **Production only — no staging.** Every change ships straight to production behind
   expand-only migrations and reversible flags, verified by a canary account, not a staging env.
5. **All real-provider flips authorized**: `AI_ENABLE_REAL_CALLS` (LLM + embeddings, which
   `SKILL_CANONICALIZE_ENABLED` depends on), Razorpay (`PAYMENTS_ENABLE_REAL`), and Sarvam STT.
   Flipped one at a time, each with a named abort lever. **`AGENCY_PAYOUTS_ENABLED` stays OFF**
   (ADR-0022 gate — explicitly not in scope).
6. **Question bank keeps all 14 topics.** The Persona sheet's Law #4 (six fields only) is
   overridden for the ask-set: education ×3 and certifications remain MUST-ASK. Every other
   persona law stands unchanged.
7. **Worker history is COARSE at launch.** `worker_skill` rows are derived from the extracted
   profile (total experience → months bucketed to 6, `wants` defaults true, `last_worked_at`
   null = the doc's E4 duration-unknown semantics). No per-stint interview change ships now;
   the application snapshot preserves replayability either way.
8. **Boost is wired and repriced** — ₹499 / ₹999 / ₹1,799 for 7 / 15 / 30 days, replacing the
   ₹1,200-for-2-days SKU in code (Q26). Boost lifts a job **within** the worker feed only:
   never past the skill gate, never into the company's candidate list, supply-gated so it is
   never sold into a thin trade. Retires TD42.

**Migrations remain manual (Divyanshu).** Authored here, applied by him in production from an
ordered runbook with a verify query and rollback note per step — the locked convention holds.

*Open at the time of ruling, to be answered at the relevant gate:* whether `org_label` is
visible on the worker feed card; whether R32 (un-cued name reaching LLM input) is
owner-accepted-at-launch or hardened first; PACE retirement acknowledgement; and the
"Namaste!" exclamation in the opener.

### 2026-08-01 — `AI_REAL_CALL_TASKS` empty allowlist is FAIL-CLOSED (empty = NO tasks)
Owner ruling (Prakash). The shipped semantics — empty allowlist = no per-task
restriction, ALL tasks real — meant the master-flag flip armed `stt_transcription`
and `profiling_chat_turn` alongside extraction, and a stray `SARVAM_API_KEY` alone
would have flipped real worker audio live across the unsigned Sarvam DPA (P0-1).
`real_call_enabled_for` now requires the task to be **explicitly listed**; there is
no wildcard. Rejected alternative: a `*` escape hatch (kept the footgun). The
security review of this change found the same bypass pattern live in **transcript
translation** (`translate.py` read the raw flag + Sarvam key, so neither the
allowlist nor `AI_REAL_CALLS_KILL_SWITCH` reached it) — closed in the same PR;
translation rides the `stt_transcription` allowlist key (one flip per Sarvam leg,
same DPA gate). Deploy
consequence, accepted: an env still running an empty allowlist drops to mock until
`AI_REAL_CALL_TASKS` is set — set `AI_REAL_CALL_TASKS=profile_extraction` in prod
**before** the deploy carrying this change. See the production release runbook
("AI real calls went LIVE") for the deployed-vs-repo split.

### 2026-09-08 — Résumé: "Fresher" for a worker with no work history, the registered location under the name, and proper-noun casing
Three owner rulings on the `bb_trade` sheet. The first two are about what a **form-first** worker's
page says about him when the pipeline has nothing to say; the third is about how what he typed is
printed.

**1. "Fresher" instead of "duration not stated."** The tenure segment had two outputs: a stated
figure, or §11 #3's honest unknown. §6.2's status word was reachable only through a role that
DECLARES a fresher rung (`RoleFresherVocabulary.tenureValue`), which is `qp_cad_drafting` and
nothing else — so on the other twenty roles every genuine fresher printed "duration not stated"
over the top of his own résumé. The ruling: *"In resume for Freshers (someone not added work
experience) 'duration not stated' is written, I want 'Fresher' mentioned there."*
Implemented as a SECOND, NARROWER route in `fresherTenureLabel`: the role's own tenure gate
answered at its lowest rung (stored 0 — the same value every pack's fresher questions are gated
on, `ask_if <tenure> <= 0`), **and** no `worker_employment` rows. A stated figure still wins
outright, so the eleven-month man that the earlier refusal was written to protect keeps his
experience the moment he records any of it — which is what makes this a bounded exception to §11
#3's "never inferred" rather than a repeal of it. The premise that rung 0 is the lowest rung is
pinned per role in `role-corpus-parity.guard.test.ts`.

**2. The worker's registered city and state print under his name.** *"In all the 21 profiles, that
is form-based profiling, there is nowhere that the current location of the candidate is asked but
we do ask that while registering — show the current location just below the Full Name in small
letter."* The gap was structural: the trade form runs no extraction, so
`location_preference.current_city` is never written for a form-first worker (P-018) and the Verdict
Line's city segment — the sheet's only location — collapsed for all of them. A résumé with no place
on it cannot be acted on by a supervisor hiring for one plant. Source is
`workers.current_city` / `current_state`, the first-party answer typed at onboarding (#1428), on
BOTH audiences: a city is on the never-redact list (2026-07-31, *"cities as PII → a 20-point
matching input"*) and the Verdict Line has printed one on the payer copy since the sheet shipped.
The three things the employer copy withholds stay exactly three.
*Not merged with the Verdict Line's city, deliberately:* that segment is the model's reading of a
conversation and keeps composing from the snapshot. Two sources, two lines; a chat-extracted
profile can therefore print its city twice, which is the accepted cost of leaving §6.2's ratified
line untouched.

**3. Company names and places print as proper nouns.** *"Work history where company name is there I
want the first letter of each word in company letter to be capital. Also the location's first letter
should be capital."* Employer names and cities are typed by hand on a phone, so `sandhar
technologies pvt ltd` and `gurugram` are ordinary input, and printed verbatim they read as
carelessness by the worker on the one document he hands across a gate. `titleCaseName`
(`resume-text-case.ts`) raises a lowercase letter in a leading position and **never lowercases
anything** — which is what keeps `TVS`, `JBM` and `L&T` from becoming `Tvs`, `Jbm` and `L&t`, a
worse error than the one being fixed. Applied to the employer name, its city/state suffix and the
new masthead line; NOT to role labels (`cnc turner` → `Cnc Turner` is a misspelt trade) or to the
worker's own words, which are verbatim by contract. The §11 #4 literal "Contract work" is exempt —
it is a guideline label, not a company the worker named. §8 is unaffected: the source and the word
are unchanged, and the fabrication gate's containment is now case-insensitive to say so.

**What the location line costs the page, measured.** The line model charges it 4.99 mm against a
4.89 mm body line (9 pt × 1.32 + 0.8 mm margin), i.e. one line, under-counting by 2% of a line. On
the fourteen-shape matrix that flips three synthetic stress sheets from one page to two —
`shape-11-worker`, and the payer copies of 5 and 6, whose "employers beyond three" collapse used to
reach exactly 41.19 lines and now cannot buy the page. The ratified corpus measures 24–37 lines and
is unaffected. That outcome is the 2026-09-03 ruling working as written (spill rather than shed a
ratified row), and it is asserted rather than described, in `sheet-shape-matrix.test.ts`.

**The residual risk on ruling 1, recorded because it should not have to be rediscovered.** A
form-first worker has no surface on which to state months: the universal `experience_years` ask
never runs for him, the finishing form has no experience key, and the work-history screen is the one
this rule reads as empty. So "under a year, nothing filed" is the whole of what the system knows
about him, and an eleven-month operator prints as `Fresher` beside a genuine pass-out. The ruling
was taken against the alternative he gets today — `duration not stated`, which in this market reads
as something withheld. The follow-up that would end the inference is a **corpus** change, not a
renderer one: give the eight non-drafting packs a real bottom rung ("koi tajurba nahi" beside "1
saal se kam", the shape `qp_cad_drafting` already has) and declare it as `fresher.tenureValue`.
Route 1 then covers every role and route 2 can be deleted.

### 2026-09-08 — The worker picks his own PIN: no strength policy, client or server (#1462)
*"The worker chooses their own PIN. No strength policy, client or server. `1234`, `1111`, `0000` —
all must be accepted."* The API's weak-PIN denylist (`PinHasher.isWeakPin` + `WEAK_PINS`, plus the
all-same-digit and consecutive-run rules) is **deleted**, not flagged off — a switch nobody may turn
on is dead config. `PinService.assertPinPolicy` now enforces the exact-length format gate and
nothing else; that gate stays because a 3-digit typo is a malformed value, not a choice.

**Why it is safe to drop.** ADR-0026's first principle is PIN-never-authenticates-from-scratch — the
PIN unlocks a session on a device the worker already OTP-bound — so the attacker a denylist imagines
already holds the handset. Everything that actually bites him is untouched: the slow-KDF hash,
`PIN_MAX_ATTEMPTS` + exponential lockout, the durable force-OTP escalation that survives a Redis
flush, device binding, and the step-up OTP on reset.

**The two halves, and where each one actually is.** #1462 was raised by Frontend, who has removed
the app-side block **in their own tree** — it is NOT on `main`. As `main` stands,
`bb_set_pin_form.dart` still calls `_blockWeakPin()`, which clears the field and never invokes
`onConfirmed`, so `1234` cannot be submitted from the shipped app at all. **This API change is
therefore a no-op for the shipped client until Frontend's half lands** — and the moment it lands
without this one, a worker who types `1234` gets past the client and hits a server 400 surfaced as
"PIN set nahi hua", a dead end where there used to be an explanation. That is the sequencing the
issue is about, and it is why the API half should not wait. Recorded as an amendment on
[ADR-0026](../decisions/0026-production-worker-auth-pin-and-tiered-sessions.md); the worker-app half
(`weak_pin.dart` and the set-PIN block) is Frontend's and is not in the API change.

**Residual risk, measured and accepted — see R25 in [risks-register.md](./risks-register.md).** The
security gate put a number on it: against the one attacker who reaches the PIN screen (unlocked
handset, bound refresh token, SIM removed or SMS unreachable), 25 guesses against the public top-25
PIN list is ~25-30% success versus ~0.25% uniform. Accepted, because that same attacker holding the
handset *with* its SIM has a deterministic bypass through `/auth/pin/reset/request` → OTP →
`reset/confirm`, and one who can read `flutter_secure_storage` skips the PIN entirely via
`POST /auth/token/refresh`.

### 2026-09-09 — The tenure segment prints the rung the worker tapped, not "duration not stated"
Follow-up to the 2026-09-08 "Fresher" ruling, taken on a **rendered sheet**: a CNC turner who had
filed no work history still read `CNC turner · duration not stated · Siemens`. The owner: *"I made a
resume now, and I didn't mention work history — 'duration not stated' showing instead of 'Fresher'.
Fix that."*

**Why the first ruling did not cover him.** It made "Fresher" reachable only for the pack's LOWEST
tier rung. That sheet showed neither the `>= 2` depth answers nor the `<= 0` fresher answers, so his
gate was either unanswered or at a higher rung — and in both cases the label withheld and §11 #3's
text printed over a man the form HAD asked.

**The rule now.** The tier gate is the only tenure question a form-first worker is ever asked (the
universal `experience_years` ask never runs for him), so every rung of it prints, as the band that
chip names: `0 → Fresher` (when no work history was filed) / `Under 1 yr` (when one was), `1 → Under
1 yr`, `2 → 1–3 yrs`, `5 → 3–7 yrs`, `10 → 7+ yrs`. A worker who answered nothing and filed nothing
reads "Fresher" — the owner's own definition. A stated figure still outranks every band.

**Why it is not simply "no work history → Fresher", which is what was asked.** Read literally, that
puts "Fresher" on a man who tapped *"7 saal se zyada"* and skipped the work-history screen — deleting
seven years of his own stated experience from his own résumé, §8.3 broken in the direction that
costs him the job. Printing his rung answers the complaint (nobody who answered should meet
"duration not stated") without ever contradicting him. Asserted as its own test.

**§11 #3 is narrowed, not repealed.** "Duration not stated" is now for the workers it was written
for: a legacy chat profile with no pack — nobody asked — and a worker who HAS a work history whose
dates he could not give. Printing "nobody asked" over an answer was not §11 #3 being honest; it was
§11 #3 being wrong about its own subject.

**A range, never a point figure.** `resume-employment-rows.ts` forbids reading this gate as a NUMBER
of years ("10 yrs" for *"7 saal se zyada"*). "7+ yrs" respects that exactly: it is the chip, printed
as the closed-vocabulary label it is, and it never reaches `experienceYears`, which stays sourced
only from a number the worker gave. The value→band scale is pinned per role in
`role-corpus-parity.guard.test.ts`, so a pack authored later that numbers its rungs differently goes
red in CI instead of printing the wrong band on a résumé.

### 2026-09-09 (later) — Total experience is the SUM of the work history, and the bands are withdrawn
**Supersedes the entry above it**, which was wrong about where the figure comes from. The owner, on
reading it: *"This is not how experience is calculated, it is not a range taken from any question.
It is calculated from the work history that is filled by the individual and the total calculated
from the work history itself"* — 1 yr 2 mo + 10 mo + 2 yrs is 4 years.

**What was measured before changing anything**, on that exact example as three dated employments:

| path | headline |
| --- | --- |
| `totalEmployedYears` (raw) | `4` — the arithmetic was always right |
| container branch (chat interview) | `CNC Turner · 4 yrs · turning` |
| **legacy branch (form-first)** | **`CNC Turner · duration not stated`** |

**That is the whole defect.** `employedYears` was computed above the branch and handed to
`fromResumeProfile` alone; the legacy return composed `years: draft.experience.total_years` and
never consulted the sum. A form-first worker takes the legacy branch by construction — the trade
form runs no extraction, so there is no container — which made the twenty-one-role population
exactly the population whose filled-in work history was discarded. Both branches now read
`renderedTotalYears(stated, employedYears)`, so they cannot disagree about one worker's tenure, and
a stated total still outranks the sum (R8 §1 and the under-representation gate are untouched).

**The bands are gone.** The earlier entry's `1–3 yrs` / `7+ yrs`, read off the pack's tier gate, are
exactly the range-from-a-question the ruling rejects. The rung is now read for ONE purpose and it is
negative: it withholds "Fresher" from a worker whose own form claims a year or more, so the sheet
neither calls a self-declared seven-year man a fresher nor invents a figure for him. Nothing derived
from that question reaches the page, and the four band strings are out of the fabrication gate's
vocabulary — if one ever appears in a printed atom again, the gate going red is the correct outcome.

**"Fresher" survives, and now it is simply true.** No work history means nothing for the sum to
find. It is bounded to pack workers (a legacy chat profile was never asked), withheld from a worker
who claims a year or more, and withheld when the work-history read FAILED rather than came back
empty — an infrastructure miss must not put the word on a man's résumé.

**One cost is pinned rather than fixed: a partially-dated history voids the whole total.**
`totalEmployedYears` is all-or-nothing by design ("a total that quietly omits the employments whose
dates the worker could not give is a false total"), so two dated jobs plus one undated print
"duration not stated" and lose 2 yrs 10 mo of real, dated experience. That is now asserted in
`resume-fresher-rows.test.ts` so it is a decision somebody makes on purpose rather than a behaviour
that drifts. **Open for the owner**, and it will recur at the form layer.

**Coordination:** the separate work-experience question (`<role>_experience`, the mandatory first
item of each `qp_*` pack) was under review for deletion in a parallel session — **ruled the next
day, and it stays** (see 2026-09-09b below). That session had measured that deleting the gate item
*shows* the 87 items currently gated on it rather than hiding them, taking a turner's form from 11
to 17 screens, which is the opposite of the intent; the owner's ruling keeps the question for
exactly that reason and takes it off the résumé instead.

### 2026-09-09b — The tier gate leaves the résumé entirely; no work history means Fresher, full stop
**Closes the question the entry above left open**, and does it by rejecting the premise both earlier
entries shared. Shown the four rungs of `qp_cnc_turning`'s gate, the owner: *"This is a different
metric. It is for setting the number of questions in the profiling — I don't want to remove it. What
I want instead is to fix the total experience shown on the resume to restrict only to the work
history details. The work history calculation should be the core of the experience displayed on the
resume top summary. If there is someone who has no work experience, no work history, then it will be
considered as a fresher, and it should not become like duration not stated or some other text."*

**Two rulings in one, and they pull apart cleanly.**

1. **The tier gate stays in the form, and it is a profiling-depth control.** `turning_experience`
   and its twenty siblings size the questionnaire: `lte 0` opens the three fresher items that become
   a pass-out's whole Zone 4, `gte 2` and `gte 5` open the depth tiers a setter answers. That is
   what it is for, it is mandatory and asked first on every enabled pack, and it is not going
   anywhere.
2. **It reaches the sheet nowhere at all.** `tenureStatusLabel` no longer takes an attribute bag —
   the withhold rule is deleted, not narrowed — so the rung cannot be read because it cannot be
   passed. §6.2's tenure segment is now composed from the work-history sum, or from the one word
   for a worker who has no history, or from §11 #3's honest unknown. No pack answer enters it.

**What this reverses, stated plainly.** The entry above withheld "Fresher" from a worker whose rung
claimed a year or more, on §8.3: the sheet must not call a self-declared seven-year man a fresher.
The owner overrules that on a factual ground rather than a stylistic one — a bracket a worker taps
to size his own questionnaire was never a claim about his career, so there is nothing being
contradicted. He now reads "Fresher", and the way he stops reading it is by filing the work history
he has. That is a real trade-off and it is kept visible in its own test rather than buried.

**The declared fresher chip loses its override too**, which is the same rule holding in the other
direction. `qp_cad_drafting`'s *"course kiya hai, kaam ka tajurba nahi"* used to print the word
UNCONDITIONALLY, including beside an employment block — a page reading "Fresher" three rows above
two employers, which is the contradiction §6.2 exists to prevent. Her ratified sheet is unchanged:
it carries no work history, so she reaches the word through the general rule.

**What is left is one line.** A worker whose form pack is one a role actually serves, and whose work
history was READ and is EMPTY, is a Fresher. Everyone else gets no label. The two bounds survive
untouched, and both are fail-closed: a profile with no role pack is a legacy chat profile nobody
handed a form to, and a work-history read that THREW is not an empty one — an infrastructure miss
must never put a claim on a man's résumé.

**Unchanged by this ruling**, and worth saying because it is the obvious next question: a STATED
total still outranks the sum (`renderedTotalYears`). That figure is the universal `experience_years`
ask — the worker's own sentence about his own career, in a free-form duration — not a bracket, and
it never runs for a pure form-first worker anyway, which is why the sum is what fills his headline.
The partially-dated cost pinned in the entry above is also still open and still all-or-nothing.
