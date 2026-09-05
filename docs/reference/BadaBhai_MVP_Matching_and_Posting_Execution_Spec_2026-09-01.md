> **NOT AN AUTHORITY. Historical snapshot. ADR-0036 (Accepted 2026-07-31) supersedes parts of
> this. Verify every claim against HEAD and against `docs/decisions/` before acting on it.**
>
> **Provenance.** Committed 2026-09-04, unmodified below this header, from the file
> `BadaBhai_MVP_Matching_and_Posting_Execution_Spec_2026-09-01.md` that was never in the
> repository. It is the document the phase briefs in `docs/agent/phases/` were written from —
> all fourteen (P0–P12 and PX, BUILD and CHECK) landed in one commit, `22d4b88c`, 2026-09-02.
> It is here so those briefs can be audited against their own source — not so it can be obeyed.
>
> **WHY THIS FILE IS DANGEROUS, stated plainly.** It is dated 2026-09-01, a month *after*
> ADR-0036 was accepted, and it does not mention ADR-0036 anywhere. It was written from the
> 2026-07-23 MASTER CONTEXT and a codebase report, both of which predate that ruling. Building
> from it without reconciling against `docs/decisions/` is what produced the 67 factual errors
> catalogued in the phase survey (`docs/decisions/PHASE_SURVEY_2026-09.md`, on PR #1416 — not on
> `main` as this file is committed).
>
> **KNOWN-SUPERSEDED CLAIMS. Each is an instruction in the body below that is now wrong:**
>
> 1. **§A4 — "Weights stay 35/20/15/15/10/5. Locked … Do not touch them."** Retired. ADR-0036
>    replaces the weighted engine with a lexicographic rank tuple and supersedes all of ADR-0033
>    and the ranking half of ADR-0011 / ADR-0015 — see
>    `docs/decisions/0036-matching-algorithm-v1.md:7` and `:17`. V1 has no weights at all.
> 2. **§A7 — "the TD42 fix."** TD42 is retired, not fixed
>    (`docs/decisions/0036-matching-algorithm-v1.md:7`, `:83`).
> 3. **§A8 — "hot tag … locked at ~12% with a min-absolute-70 floor"; §A9 — "PACE … Turn on
>    for MVP"; PART D — "push floor".** `hot` does not exist in V1 and PACE retires with the
>    weighted engine (`docs/decisions/0036-matching-algorithm-v1.md:97`, `:99`). The 70-floor was
>    never shipped either: `packages/reach-engine/src/ranking.ts` tags a fraction, not a floor.
> 4. **The title and §A2 — "22 roles."** The owner ruled **21** on 2026-09-04 (R4-d(a),
>    `docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md`). §A2 already found the count to be 21
>    — "Counting Sections 1A–1D gives 21" — while the title still says 22; the title lost.
> 5. **"Grounded in: codebase report 2026-09-01."** That report is
>    `docs/reference/BADABHAI-CODEBASE-INTELLIGENCE-REPORT.md`, and it is itself marked NOT AN
>    AUTHORITY. A third source it names, `BadaBhai_Role_Taxonomy_Master` (2026-08-09), is still
>    not in the repository.
>
> Where this document and a signed ADR disagree, **the ADR wins.** Where it and the code at HEAD
> disagree about what exists, **the code is the fact.** The rewritten phase briefs in
> `docs/agent/phases/` already apply both rules; this file does not.

---

# BadaBhai — MVP Execution Spec: 22-Role Matching & Unified Job Posting

**Date:** 2026-09-01
**Scope:** (A) matching + visibility for the 22 Section-1 roles · (B) the job posting flow, unified across payer-web / payer-app / ops with cross-device checkpoint state.
**Grounded in:** codebase report 2026-09-01 · `BadaBhai_MASTER_CONTEXT_2026-07-23` · `BadaBhai_Role_Taxonomy_Master` (2026-08-09).

---

# PART A — MATCHING & VISIBILITY FOR THE 22 ROLES

## A0 · The design fork is already closed. The Aug-9 sheet re-opened a settled question.

The taxonomy sheet ends with: *"is 'CNC Turner (Programmer)' a distinct skill_id from 'CNC Turner (Operator)', or one skill carrying a level attribute? … needs a deliberate ruling."*

It doesn't. §21 of the master context locked this on 2026-07-09:

> `function ∈ { operator (default), setter, programmer, trainer, supervisor, maintenance, inspector, manager, apprentice }`
> *"Anchor Industry/Domain to the TRADE, not the job's function."*
> *"Every work experience is its own tagged record. A worker = the sum of their tags."*
> *"A worker's fit to a job = their BEST-matching experience tag, never an average."*

`function` is a modifier on the role. Not a role. The locked adjacency table proves it — `higher-tier→operator 0.85` and `operator→higher-tier 0.25` are directional arithmetic on a modifier, which is only expressible if level lives *on* the role rather than *as* the role. And `same domain, function differs 0.85 × skill-overlap` is already the Setter↔Programmer mechanism.

**So: one skill_id per role, function + level as modifiers. Ruled, not open.**

## A1 · But the Aug-9 ladders conflate two locked axes, and that must be fixed before seeding

Look at what the sheet calls a single "level ladder":

| Role | Sheet's ladder | What it actually is |
|---|---|---|
| CNC Turner | Operator → Setter → Setter-cum-Programmer → Programmer | **function** (all at the same collar tier) |
| Welder | Helper → Welder → Certified Welder | **level** + a certification attribute |
| Fitter | Helper → Fitter → Senior Fitter | **level** |
| Tool & Die Maker | Trainee → Tool Maker → Senior | **level** |
| QC | Inspector → QC Engineer | **function** |
| CAD Designer | Draughtsman → CAD Designer → Design Engineer | **level** |

Two orthogonal locked axes have been flattened into one string. The master context keeps them separate and both are locked:

- **Axis B — collar tier:** elementary → semi-skilled → skilled trade → technician. *"A real matching input."*
- **function modifier:** the enum above.

A CNC Setter and a CNC Operator are the **same** collar tier, **different** function. A Helper Welder and a Certified Welder are the **same** function, **different** collar tier. Modelling both as "level" makes the adjacency multipliers unimplementable — you cannot apply `operator→higher-tier 0.25` to a Helper→Senior Fitter pair and get anything meaningful.

**Deliverable:** RVM decomposes each of the 22 ladders into `(function, collar_tier)` pairs. This is a data exercise on a spreadsheet, not an architecture decision. One enum addition needed: `setter_programmer`, since "Setter-cum-Programmer" is a real, distinct, commonly-advertised function and `function` is single-valued by lock.

## A2 · Three role-overlap traps inside the 22 that will corrupt canonicalisation

These will silently map the same worker to two different roles depending on phrasing. `skill_id` is immutable and never reused — get it wrong and you cannot cleanly undo it.

1. **Press/Machine Operator vs Injection Moulding Operator.** The sheet's attributes for Press/Machine Operator literally include *"injection moulding."* That is the entire scope of another role in the same list.
2. **Plastic Process/Quality Technician vs Quality Inspector.** Under the locked model the former is just QC with `function=inspector` in the Plastics domain. Two skill_ids for one coordinate.
3. **Tool & Die Maker vs Mould/Die Maker (Plastics).** Defensible as separate roles (different Skills[]), but the alias surface overlaps heavily — *"die maker," "die banane ka kaam."* Needs domain-scoped disambiguation at resolution, which §24 already mandates.

**Also:** the sheet says 22 roles (4 + 18). Counting Sections 1A–1D gives 21 (4 + 1 + 11 + 5). Reconcile before alias seeding — role count drives the seeding budget.

## A3 · The families need re-cutting — the locked set is stale

Locked families: `{Turning} {Milling: VMC, HMC} {Setting/Programming: Setter-Op, CNC Programmer, CAM Programmer} {Grinding} {Welding/Fab} {Moulding: injection, blow, extrusion}`.

`{Setting/Programming}` is an artifact of §23's older 45-role list, where CNC Setter-Operator and CNC Programmer were separate roles. Under §21's function model they are not roles at all. That family dissolves; only CAM Programmer survives it (correctly — a desk role with entirely different Skills[]).

Proposed re-cut for the 21–22, mapped onto the locked §23 domains:

| Family | Roles | Domain |
|---|---|---|
| Turning | CNC Turner | Machining & Cutting |
| Milling | CNC Machining Centre Op | Machining & Cutting |
| Grinding | CNC Grinding Op | Machining & Cutting |
| Conventional Machining | Conventional Machinist | Machining & Cutting |
| Programming Desk | CAM Programmer · CAD Designer | Machining & Cutting / **Design — domain gap, see below** |
| Welding & Fabrication | Welder · Sheet Metal Worker | Forming & Fabrication |
| Tooling | Tool & Die Maker · Mould/Die Maker (Plastics) | Tooling, Die & Mould |
| Moulding & Polymer | Injection Moulding · Blow/Extrusion · Rubber Moulding · Plastic Process Tech | Plastics & Polymer |
| Fitting & Maintenance | Fitter · Maintenance Technician · Industrial Electrician | Assembly & Integration / Maintenance & Plant |
| Quality | Quality Inspector | Quality & Inspection |
| General Production | Assembly Line Worker · Press/Machine Operator · Painter/Powder Coating | Production Support / Forming / Finishing |

**Open gap:** §23 lists 11 manufacturing domains but no **Design & Drafting** domain, and CAD Designer/Draughtsman is RVM's highest-volume warm supply. Either it's the unlisted 11th domain or it's missing. Confirm before seeding — a null domain breaks the domain-scoped vector search mandated by §24.

Grouping Tool & Die Maker with Mould/Die Maker is the highest-value judgement in the table: it is the one edge that creates liquidity between the metal cluster and the plastics cluster. RVM must confirm it, because it decides whether a tool-room worker sees moulding jobs.

## A4 · The trade factor — composition, not new weights

Weights stay **35/20/15/15/10/5**. Locked, and ADR-0006's divergence appears already reconciled (the Sept-1 report shows exactly 0.35/0.20/0.15/0.15/0.10/0.05 in `reach-engine`). Do not touch them.

What changes is how the 0.35 trade factor is *composed*:

```
tradeFactor = adjacency(role_w → role_j)
            × functionMultiplier(function_w → function_j)
            × collarTierBand(tier_w, tier_j)
            capped at 1.00
```

All three tables are **config, not schema** — §32 explicitly puts adjacency multipliers outside the schema. `functionMultiplier` is where `higher-tier→operator 0.85` and `operator→higher-tier 0.25` live. `collarTierBand` reuses the locked experience banding shape (meets 1.0 / one below 0.6 / two below 0.3 / fresher-OK 1.0).

**Null handling:** partial profiles work — a worker with unknown function scores `0.85` (the "function differs" class), never zero, and is surfaced to the employer as *"function not confirmed."* Honest to both sides, and it never excludes.

## A5 · Do NOT turn on embeddings for role resolution at MVP

This is the biggest schedule finding in the spec.

§19 locks skills scoring as `coverage × embedding multiplier bounded [0.90–1.00]`. **By design the embedding layer can move a score by at most 10%.** It is a nudge on a 0.15-weighted factor — a ceiling of 1.5 points out of 100.

For 21–22 roles a hand-curated alias gazetteer beats ANN on precision, costs nothing, is deterministic, and is testable with golden fixtures. §24 already says the hard part is hand-seeded Hinglish aliases ("no embedding model will ever place *kharad* next to *lathe operation*") — the model was never doing that work.

**Therefore `SKILL_CANONICALIZE_ENABLED=false` and `DOMAIN_MATCH_ENABLED=false` are the correct production posture through MVP, and TD-EMB-1 is not on the alpha critical path for matching.** Use embeddings only for the overflow path: cluster `unresolved_phrase` weekly for the existing admin skill-discovery review queue, where recall matters and precision is human-gated.

**Alias budget for MVP:** ~21 roles × ~15 skills × ~6 aliases ≈ **1,900 skill aliases + ~170 role aliases ≈ 2,100**. Bounded and finishable. Source order per §24: RVM WhatsApp corpus → own transcripts → RVM instructors → LLM variants, human-checked.

## A6 · One shared tier resolver, two engines

Today `match-engine` has its own `TIER_ORDER=["A","B","C"]` and `reach-engine` has its own scoring. Same 22 roles, two notions of "match," no way to explain either side's list.

Extract into a shared package:

```
resolveMatchTier(worker, job, catalog) → { tier, tradeFactor, reasons[] }

tier A  tradeFactor ≥ 0.85   exact · same family · higher-tier→operator
tier B  0.30 – 0.84          same domain function-differs · adjacent domain
tier C  0.15 – 0.29          distant domain, same industry
tier D  different industry   visible in search, never pushed
```

Worker feed consumes `tier` as the lexicographic head. Employer list consumes `tier` as a hard band and scores *within* it. Symmetry without merging the engines. No migration. `reasons[]` is what makes both lists explainable — and explainability is what protects repeat-unlock rate.

## A7 · Worker feed rank key — and the TD42 fix

Current: `tier | skillMonths | industryMonths | lastWorked | lastActive | workerId`

Proposed:

```
tier
| functionSatisfied            (bool — Setter+ ahead of Operators on a Setter job)
| skillMonthsBucket(6)         (existing TENURE_MONTHS=6 bucketing)
| boostTier                    ← TD42 lands here
| industryMonthsBucket(6)
| lastWorked
| exposureBalance              (least-recently-shown first)
| lastActive
| workerId
```

**Why boost goes exactly there.** Months are already bucketed at 6, which manufactures natural ties. Boost breaks ties *inside* a relevance bucket and can never cross one. That is literally *"reorders within relevance; never overrides a worker's relevance floor."*

It yields a mechanical release-gate invariant, which the sales plan explicitly asks for:

> For any boosted job B and unboosted job U: if `U.bucket > B.bucket` then U ranks above B. Always.

Write that as a property test over all 22 roles. It is the boost-versus-floor gate.

**`exposureBalance`** is deterministic rotation, not randomness — reproducible, testable, and it stops the same 30 Faridabad VMC workers appearing in all ten employers' lists in week one.

**Note the direction:** boost lifts a *job* toward *workers*. It never lifts a worker toward an employer. That is the integrity guardrail, and it is why boost is implementable at all.

## A8 · Employer candidate list — attributes as facets, not filters, not scores

The taxonomy sheet says attributes stay display-only. Correct as far as it goes, but display-only alone means a Fanuc-only shop pays ₹40 to discover a Siemens operator. That is a direct hit on the hero health metric.

**Implement attributes as a reordering facet that never excludes:**

```
GET /payer/reach/jobs/:id/applicants?facet=controller:fanuc
→ same candidate set, same count
→ matching-facet candidates lead
→ badge: "14 of 62 match Fanuc"
```

Never scored, never ranked, never removes anyone. Satisfies *"relevance sorts, never blocks"* and gives the employer what they need before spending. Attributes come from the closed per-role whitelist, so this is config-driven per role.

**Hot tag, small-pool honesty.** Locked at ~12% with a min-absolute-70 floor. With 22 roles across three belts most early lists will be under 70, so every candidate gets tagged hot and the signal dies at birth. **Below 70, suppress the tag entirely** and show *"small pool — all candidates shown."* A degraded signal is worse than none.

## A9 · PROTECT — not optional at this pool size

| Control | Status | Action |
|---|---|---|
| Contact caps 5/worker/7d, 15/30d | Not visible in the Sept-1 report | Enforce at unlock request; return `denied` with reason; emit event. The unlock lifecycle already has a `denied` state. |
| Exposure balancing | Not present | A7 rank key |
| PACE (Wave-1 ≈ 3× vacancies, widen 6–24h: area → adjacent trades → ops alert) | Built, `PACE_ENABLED=false` | **Turn on for MVP.** With 22 roles in three belts this is what stops a thin role returning an empty list. It consumes the A4 adjacency config for the "adjacent trades" wave. |
| Push floor 40/100 | Not visible in the report | Verify; if absent, add to the push processor. |
| Boost supply gate | Absent | Do not offer boost where `job_reach` count for that role+radius is below a floor. Sales plan rule #1: boost must not sell what supply cannot deliver. |

## A10 · Known blocker inside the 22

**`role_welder` ruling is open and TAX-WELD-1 means welders are currently unmatchable.** Welder is one of the 22. Either the ruling closes or Welder ships broken. Not a schedule item — a scope item.

## A11 · Do not

- Turn on embeddings for role/domain resolution at MVP (A5).
- Make attributes scored or filtering (A8).
- Merge the two engines (A6).
- Let boost cross a relevance bucket (A7).
- Add any demographic input, ever.
- Let RVM affiliation touch rank.
- Ship any of the above without bumping `engine_version` on `job_reach` — locked pillar, and it's the only way v1/v2 stay comparable.

---

# PART B — THE JOB POSTING FLOW

## B0 · What's actually wrong today

1. **Two producers of one object.** `POST /payer/job-postings` (form CRUD) and `POST /payer/job-posting-chat/sessions/:id/publish` (chat) both create postings. Two validation surfaces, two bug sets, two things to keep in sync.
2. **The chat has no LLM.** The report's own §XXXIV-14: *"job posting chat LLM rephrase (deterministic only, no LLM yet)."* It is a form wearing a chat costume.
3. **No real draft model.** A half-built posting sits as `job_postings.status=draft` — a partially-valid row in the table matching reads from.
4. **Three surfaces need to post**, and the wizard would be defined three times: payer-web (Next.js), payer-app (Flutter), ops console (locked business rules BR-O-01/02: *ops can post on behalf of employers; ops tool and employer pipeline are one system with two views*). **With zero contract tests in the repo, three hand-written wizards will drift and nothing in CI will catch it.**
5. **Money is tangled with content.** `/plan` requires a posting to exist, so a failed payment endangers content.

## B1 · Architecture: one draft, append-only checkpoints, publish as projection

```sql
job_posting_drafts(
  id, payer_id, created_by_member_id,
  source_posting_id      -- set when editing something already live
  status                 -- in_progress | ready | published | abandoned
  current_step_id, completed_step_ids text[],
  payload jsonb,         -- the materialised fold
  schema_version int,
  version int,           -- optimistic concurrency
  last_client,           -- web | flutter | ops
  created_at, updated_at, expires_at
)

job_posting_draft_checkpoints(
  id, draft_id, seq, step_id,
  payload_delta jsonb,
  client, member_id,
  idempotency_key,       -- UNIQUE (draft_id, idempotency_key)
  created_at
)
```

Append-only checkpoints, not a mutable blob. It matches the locked event-first philosophy, it gives cross-device audit (*who changed salary, on which device*), it gives undo, and the fold can be replayed if materialisation is ever wrong.

**The draft never enters matching.** `job_postings` stays always-valid. Publish is a single transactional projection.

**Do not put the draft in Redis.** The report names Redis buffer loss as an existing data-loss path for interview transcripts. Transcripts can be re-gathered from a worker. A half-built posting from a paying customer cannot. Postgres, with a long `expires_at`.

## B2 · Cross-device continuity — the actual mechanism

There is no magic. The draft is server-side. Continuity is three concrete things.

**(a) Discoverability.** `GET /payer/job-posting-drafts?status=in_progress` returns `current_step_id`, `last_client`, `updated_at`. Both clients render: *"Resume — Step 4 of 7 (Salary & Shift) · edited on Web, 12 min ago."*

Optional and cheap: `POST /payer/job-posting-drafts/:id/handoff` → 6-char code, 10-min TTL, reusing the existing OTP Redis primitives. Type it on the desktop, land on the exact step. Costs an afternoon, feels like magic.

**(b) Concurrency — optimistic, never last-write-wins.** Every checkpoint POST carries `expected_version`. Mismatch → **409** with the current payload and the conflicting step. Client shows *"Updated on another device"* and offers reload-or-overwrite. Last-write-wins silently destroys work and you find out from a customer, not a test. The codebase already uses CAS on Redis for chat turns — same discipline, different store.

**(c) Offline.** Flutter queues checkpoints locally with a client-generated `Idempotency-Key`, flushes in `seq` order on reconnect. Server dedupes on `(draft_id, idempotency_key)`. `Idempotency-Key` is already an established pattern on the auth endpoints. This satisfies the locked principle: *"clients are offline-tolerant; autosave each step; resume, never restart."*

## B3 · Server-driven wizard schema — the single highest-leverage decision here

```
GET /payer/job-posting-drafts/schema?version=N
→ step ids + order
→ field ids, input types, required-for-publish
→ chip option sets (the 22 roles, function enum, collar tiers, shifts, benefits,
   per-role attribute whitelists)
→ validation rules
→ conditional visibility
→ affects_matching: true|false per field
```

All three clients render from this. Not two hardcoded wizards in two languages.

**Why it matters more here than anywhere else in this codebase:** three clients, two languages, **zero contract tests**. Serving the schema converts a contract-test problem into a single-source-of-truth problem. It also means adding a field for a new role is a config publish — not two client releases, one of them through Play Store review.

Pin `schema_version` on each draft so an in-flight draft doesn't break mid-flight; migrate on next open with an explicit *"we've updated this form"* step.

## B4 · Chat becomes a renderer, not a second producer

Delete `/job-posting-chat/sessions/:id/publish`. The chat turn becomes:

```
payer utterance
  → LLM parses to field deltas: { field_id, value_raw, value_normalized,
                                  confidence, evidence_span }
  → same POST /checkpoints endpoint
  → same draft
```

The form view of that draft is instantly consistent, and the payer can switch between chat and form mid-posting.

This is the locked worker-side principle applied to the payer side: **the LLM parses, it does not write.** The delta shape is deliberately identical to `pack_answers`. Reuse the same validator — reject any model-emitted canonical ID; the model proposes phrases, the gazetteer resolves them to the 22 roles.

**Cost:** this is a `cheap`-tier parse task, short context. Route it accordingly. Do not repeat the `gemini-2.5-pro` interview-turn mistake flagged in the reconciliation.

## B5 · Publish — content and money separated

```
draft (ready)
  → POST /payer/job-posting-drafts/:id/publish        [one transaction]
      validate full payload against the publish schema
      insert job_postings (status=draft, verification_status=pending)
      emit job_posting.submitted
      draft.status = published

  → ops verification                                   BR-E-05, verification-gated
      POST /job-postings/:id/verify → verification_status=verified

  → plan
      free intro band  → implicit plan, applicant_quota stamped
      paid band        → Razorpay ON WEB → status=open, applicant_quota stamped at purchase

  → open → job_reach built (engine_version stamped) → visible in worker feed
```

Three properties this buys:

1. A failed payment never loses content.
2. An unverified posting never reaches a worker. Locked CEO decision: *company job posting is free through launch, **verification-gated***. An unverified posting in the feed is a trust incident on day one.
3. `applicant_quota` is stamped at the plan step — exactly the locked rule that *"quota is stamped on the job at purchase so later tier edits never mutate live jobs."*

## B6 · Edit-after-publish must not silently reorder a paid list

Editing a live posting reopens a draft carrying `source_posting_id`. Then:

- **`affects_matching=false`** (benefits text, description, contact person) → apply in place.
- **`affects_matching=true`** (role, function, collar tier, city, salary band, radius) → rebuild `job_reach` under a **new `engine_version`**, emit an event, and leave existing application snapshots frozen. The snapshot-freeze-on-insert behaviour already in `applications` exists precisely for this; edits must not break it.

The `affects_matching` flag lives in the B3 schema, which is why the schema has to be server-served rather than implied by client code.

## B7 · The payer-Flutter conflict — and the clean resolution

**Two locked facts collide with the request.**

1. **Two client surfaces [LOCKED 2026-06-19]:** worker Flutter app + **Company/Agency Next.js web app. One role-aware platform.** A payer Flutter app (`apps/payer-app`) exists in the repo anyway.
2. **Flutter IAP is an open CEO ruling.** Apple/Google take 15–30% of any in-app purchase. On a ₹40 unlock that is up to ₹12 — off the north-star metric itself. The standing instruction is that **zero IAP products should exist in Play Console / App Store Connect.**

**Resolution that delivers the cross-device flow without touching the open ruling:**

> **The Flutter payer app drafts, edits, and submits for verification. It never purchases.** When a draft needs a paid band, it shows *"Complete on web"* and issues the B2 handoff code into payer-web checkout.

Zero IAP products created. This is exactly the Netflix/Spotify pattern the CEO question names — manage on mobile, purchase on web — and it means the web↔Flutter posting flow can be built now regardless of how the IAP ruling lands.

**Ownership gap to close first:** single-owner-per-app is locked. Rishi owns the worker app; Prakash owns payer-web and the ops console. **No one is named as owner of `apps/payer-app`.** Making it a posting surface without an owner violates a locked convention and lands on Prakash — who is already standing risk #1.

## B8 · Ops console falls out for free

Third renderer of the same draft, with `created_by=ops, on_behalf_of=payer_id`. No new posting path. BR-O-01/BR-O-02 are locked business rules that currently have no clean home; B1–B3 give them one at near-zero marginal cost.

---

# PART C — RULINGS NEEDED BEFORE CODE

| # | Ruling | Owner | Blocks |
|---|---|---|---|
| R1 | Confirm A0/A1: one skill_id per role; the Aug-9 ladders decompose into `(function, collar_tier)`. Add `setter_programmer` to the function enum. | RVM / CEO | Everything in A |
| R2 | Re-cut the families (A3) and confirm the Tool & Die ↔ Plastics-Mould edge. | RVM | Adjacency config, alias seeding |
| R3 | Is **Design & Drafting** the unlisted 11th domain, or missing? CAD Designer is RVM's highest-volume supply and cannot carry a null domain. | RVM | Domain-scoped resolution |
| R4 | Resolve the three overlaps (A2): Press/Machine vs Injection Moulding · Plastic Process Tech vs QC · Tool&Die vs Mould/Die. And reconcile 21 vs 22. | RVM | `skill_id` allocation — immutable, so this is one-way |
| R5 | `role_welder` ruling (TAX-WELD-1). Welder is in the 22 and is currently unmatchable. | CEO | Welder ships or doesn't |
| R6 | Payer-app scope + **named owner**. Draft-only, no purchase (B7 recommendation). | CEO / Prakash | All of B on Flutter |
| R7 | Confirm attributes-as-facet (A8) rather than pure display-only. | CEO / RVM | Employer list UX |

---

# PART D — SEQUENCE

Rulings first — none of these are code.

1. **R1–R7 closed.** Spreadsheet work for RVM, one ruling for the CEO.
2. **`matching_catalog` table** — one migration, same shape as the existing `pricing_catalog` (`catalog` jsonb, `revision`, `is_active`, `updated_by`, `created_at`, `updated_at`) — *corrected 2026-09-02: the earlier parenthetical read `version, catalog_json, published_by, published_at, is_active`, which described no table that exists; `pricing_catalog` and its existing clone `match_config` both use the names above*. Adjacency, families, function/collar multipliers, per-role attribute whitelists, level ladders and the B3 wizard schema all become **published config**. After this, taxonomy churn is a data publish with RVM sign-off, not a deploy. *This is the highest-leverage single change in the spec.*
3. **Shared tier resolver** (A6) + golden fixtures across all 22 roles + `engine_version` bump.
4. **Function/collar-tier columns** on `worker_skills` and `job_postings` (migration — Divyanshu, Plan Mode).
5. **Rank key change** (A7) + the boost-vs-floor invariant as a **release gate**.
6. **Reach facets** (A8) + small-pool hot-tag suppression.
7. **PROTECT** (A9): contact caps, exposure balance, PACE on, push floor, boost supply gate.
8. **Draft + checkpoint tables** (migration) + **`GET /schema`** endpoint (B1, B3).
9. **Payer-web wizard onto the schema**; **chat → checkpoint parser** (B4); **publish/verify/plan split** (B5).
10. **Flutter payer draft/resume** (B7 — draft-only).

Alias seeding (~2,100, A5) runs in parallel from step 1 and is on the critical path for anything to actually match. It is RVM-corpus work, not engineering work, and it is the single largest non-code dependency.

**Golden fixtures across all 22 roles are the thing that makes any of this safe.** Changing matching without a golden set is how a trade silently breaks and nobody notices for a month. There is precedent to lean on — RC2 was verified at 197/197 schema checks and those counts were treated as part of the artifact, not supplementary.

---

*Every claim above about current code state derives from the 2026-09-01 codebase report, which carries no commit SHA. Confirm against HEAD before committing dates.*
