# Skill Discovery — Production Activation Plan

> **Nothing in this document has been executed.** It is the ordered, reversible sequence for
> turning the discovery + curation layer on, with the authorization each step needs stated
> against it. Every measurement quoted is from the dry run of **2026-08-26** (run
> `sdr_20260826-121201Z_final`, input fingerprint in the report).
>
> `SKILL_CANONICALIZE_ENABLED` stays **false** throughout. The 0.75 floor is not touched.
> No promotion gate is weakened. This plan is a *preparation* mechanism, not an activation of
> canonicalization.

---

## 0. What is already true (no action needed)

| fact | evidence |
|---|---|
| The discovery pipeline runs read-only against production and costs ₹0 | `pnpm db:discover:skills`, 5 runs to date |
| All 9,121 `job_domain_alias` + 336 `skill_alias` vectors are real, single-model, L2-normalized | `embedding_model = gemini-embedding-001` on 100% of rows |
| Nothing in the request path can create a skill or an alias | `crossVocabularyWriters() -> []` (#1256), plus the guardrail test on `discover-skills.ts`'s own source |
| Migration 0093 is authored, reviewed, and **not applied** | `drizzle.__drizzle_migrations` head = 0092 |
| The four new tables are declared in the RLS no-drift guard | `tests/e2e/rls-spine.e2e.test.ts` |

---

## 1. Sequence

Each step names its **authorization**, its **verification**, and its **rollback**. Steps are
ordered so that every one is reversible without touching the one before it.

### Step 1 — Apply migration 0093

**Authorization required: OWNER.** This is production DDL.

```bash
git fetch origin && git log --oneline origin/main -1        # confirm 0093 is ON main
pnpm --filter @badabhai/db db:migrate                       # applies 0093 only
```

- **Blast radius**: four new, empty tables. No existing table gains, loses, or re-types a
  column; no constraint is relaxed; no index is rebuilt.
- **Verify**:
  ```sql
  SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND tablename LIKE 'skill_candidate%' OR tablename='skill_discovery_run';   -- expect 4
  SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
   WHERE relname IN ('skill_discovery_run','skill_candidate','skill_candidate_source','skill_candidate_match');
  -- expect relrowsecurity AND relforcerowsecurity true on all four
  ```
  Then `RUN_E2E=1 pnpm --filter @badabhai/e2e test` — the no-drift guard asserts the live table
  set equals `LOCKED_TABLES` equals the Drizzle model, and that all three client roles hold no
  DML privilege on each new table.
- **Rollback**: `DROP TABLE skill_candidate_match; DROP TABLE skill_candidate_source; DROP TABLE
  skill_candidate; DROP TABLE skill_discovery_run;` (children first). The database is then
  byte-identical to 0092.
- **Note**: this repo applies migrations by hand and journal rows are routinely owed. Confirm
  with `SELECT max(created_at) FROM drizzle.__drizzle_migrations;` against
  `0093.when = ` the journal value, not with "the PR merged".

### Step 2 — Persist a discovery run

**Authorization: none beyond Step 1.** Still ₹0, still no taxonomy write.

The dry-run runner (`db:discover:skills`) has **no write path by design**. Persisting is a
separate runner, and it is the one piece of Phase 2 still to build (see §3).

- **Verify**: `SELECT status, source_count, candidate_count, input_fingerprint FROM
  skill_discovery_run;` — one row, `completed`, and the fingerprint equal to the report's.
- **Rollback**: `DELETE FROM skill_discovery_run WHERE run_id = '<id>';` — both child tables
  cascade. Nothing outside these four tables references a run.
- **Idempotency**: `skill_candidate_run_cluster_uq` makes a re-run of the same run id an upsert,
  not a duplicate. A *new* run against the same corpus produces the same
  `input_fingerprint`, which is how "this is a re-run, not new evidence" is visible.

### Step 3 — Grant the capability to one reviewer

**Authorization: OWNER** (it is an authorization-matrix change).

The `review_skill_candidates` capability is deny-by-default and pinned by the
`admin-capabilities` drift test. Grant it to **one** person for the first session, not to a
role class.

- **Verify**: `GET /admin/capabilities` returns it for that admin and for nobody else; the authz
  test proves every other role is denied on every route.
- **Rollback**: remove the role from the matrix entry. No data changes.

### Step 4 — Review the DIRECT tier (82 candidates, 74 screens)

**Authorization: none.** This is the intended use of the system.

Start here and nowhere else. Measured composition of the direct tier:

```
वेल्डिंग (3)  building (3)  plumbing (2)  सिलाई (2)  loading (2)  plant (2)
+ 68 singletons: ac, bearing, cutting, drilling, grinding, milling, welding, wiring,
  घिसाई, चिनाई, जोड़ाई, पुताई, पेंटिंग, मिलिंग, वायरिंग, शटरिंग, नानबाई …
```

- **Estimated effort**: ~1 hour at the assumed rates (see §4 — the rates are an assumption and
  this session is what replaces them with a measurement).
- **What to watch**: the `derived` tier is 6,074 candidates and must stay closed until the
  direct tier is validated. That sequencing is enforced by tiering — a group never mixes tiers,
  so a reviewer cannot decide a derived candidate while working the direct queue.

### Step 5 — Export the approved batch and read the diff

**Authorization: none.** Writes files only; there is no `--apply` and there will not be one.

```bash
pnpm --filter @badabhai/db db:export:approved-skills --run <run_id> --out .scratch/export
```

- Runs **both** shipped gates. A `BLOCK` is a normal outcome and removes any stale
  `accepted-skills.jsonl` rather than leaving it to be found.
- **Verify**: read `manifest.json` — `verdict`, `counts`, `refusals`, `provenance_map`
  (skill_id → candidate_ids), and `convergence_groups_skipped` with its reason.
- **Rollback**: delete the output directory. Nothing outside it changed.

### Step 6 — Commit the accepted file

**Authorization: the reviewing engineer's own commit.** This is the review gate.

```bash
cp .scratch/export/<run>/accepted-skills.jsonl \
   packages/db/data/taxonomy/skills-<date>-discovery.jsonl
# plus the accepted edges, as a separate file in the same directory
```

A separate, dated file rather than an append to `skills.jsonl` — a corpus update should be a
pure ADD in the diff, which is the property that makes it reviewable at all.

- **Verify**: `pnpm --filter @badabhai/db db:verify:taxonomy` over the whole corpus.
- **Rollback**: revert the commit. Nothing has reached a database.

### Step 7 — Seed as `provisional`

**Authorization: OWNER** (production write to `skill` / `skill_alias` / `job_domain_skill`).

```bash
pnpm --filter @badabhai/db db:seed:domain-skills                  # DRY RUN, default
pnpm --filter @badabhai/db db:seed:domain-skills --apply          # writes
```

- Skills seed `provisional`. `provisional` is **not retrievable** —
  `SkillsRepository.canonicalAliasRows` filters `status='active'` — so nothing reaches a worker
  or an employer at this step.
- **Verify**: `SELECT skill_id, status, kind FROM skill WHERE created_at > '<t>';` — all
  `provisional`, all `attribute`, none `mskill_*`.
- **Rollback**: the seeder is idempotent and additive. To undo, `DELETE FROM job_domain_skill
  WHERE skill_id IN (…); DELETE FROM skill_alias WHERE skill_id IN (…); DELETE FROM skill WHERE
  skill_id IN (…);` — safe **only** while the skills are still `provisional` and nothing
  references them. After promotion, the correct undo is deprecate-and-crosswalk (SG-5), not
  delete.

### Step 8 — Embed the new aliases

**Authorization: OWNER — this is the first paid step.** See §4 for the exact cost.

```bash
pnpm --filter @badabhai/db db:embed:skills --batch <dir> --plan   # inventory, calls nothing
pnpm --filter @badabhai/db db:embed:skills --batch <dir>          # real, gated
```

- `--batch` restricts the run to the approved skills' aliases. Without it the runner embeds
  every `embedding IS NULL` row in the table.
- Resumable: only NULL rows are fetched, so a `budget_stopped` run is re-run, not restarted.
- **Verify**: `SELECT embedding_model, count(*) FROM skill_alias WHERE skill_id IN (…) GROUP BY 1;`
  — one model, no `mock-embedding`.
- **Rollback**: `UPDATE skill_alias SET embedding=NULL, embedding_model=NULL, embedded_at=NULL
  WHERE …` — recoverable, at the cost of the spend.

### Step 9 — Evaluate

**Authorization: none** (may spend on query embeddings — check the plan output first).

```bash
pnpm --filter @badabhai/db db:eval:taxonomy
pnpm --filter @badabhai/db db:report:taxonomy
```

The evaluation must carry a `corpus_fingerprint` matching the corpus it measured. **Freshness
is not waivable** — that is `promote-skills.ts`'s rule and this plan does not change it.

### Step 10 — Promote `provisional` → `active`

**Authorization: OWNER.** This is the step that makes a skill retrievable.

```bash
pnpm --filter @badabhai/db db:promote:skills --batch <dir>            # PLAN, default
pnpm --filter @badabhai/db db:promote:skills --batch <dir> --apply
```

All five criteria unchanged and unwaived: `C1 GATE_ACCEPTED`, `C2 IS_PROVISIONAL`,
`C3 ACTIVE_EDGE`, `C4 FULLY_EMBEDDED`, `C5 EVAL_COVERED`.

- **C3 is the one to expect trouble from**, and it is why Step 4's reviewers must name trades:
  a skill with no active `job_domain_skill` edge is unreachable and C3 refuses it. The
  `approved_job_domain_ids` field exists precisely so this step does not fail.
- **Rollback**: `db:promote:skills --revert <report.json>` — the runner writes a git-tracked
  report designed for exactly this.

### Step 11 — MATCH_SKILLS mapping

**A SEPARATE OWNER DECISION. Not part of this plan and not implied by it.**

A discovered skill is an `attribute` and stays unmapped to `MATCH_SKILLS` indefinitely. The
existing Q1 work and the 96 promotable skills are untouched. Nothing in the discovery layer can
propose, reference, or mint an `mskill_*` — four independent walls enforce it (index filter,
`validateCandidate` ×2, two DB CHECKs).

### Step 12 — Canonicalization

**Out of scope. `SKILL_CANONICALIZE_ENABLED` stays false.** Turning it on is a separate,
separately-evidenced decision with its own floor sweep and its own gates.

---

## 2. The one-way doors

| step | reversible? | why |
|---|---|---|
| 1 apply 0093 | **yes** — four `DROP TABLE`s | nothing else changed |
| 2 persist a run | yes — `DELETE`, cascades | no external references |
| 3 grant capability | yes | matrix edit only |
| 4 review | yes-ish | a terminal decision is terminal *by design*; re-deciding is a new candidate in a new run, which the fingerprint makes visible |
| 5 export | yes | files only |
| 6 commit | yes | `git revert` |
| 7 seed | yes **while provisional** | after promotion, SG-5 says deprecate-and-crosswalk, never delete |
| 8 embed | yes, at the cost of the spend | vectors are re-nullable |
| 10 promote | yes — `--revert <report>` | the report exists for this |

**The only genuinely one-way door is minting a `skill_id`** (Step 7). An id is immutable and
never reused (ADR-0030 SG-5), so a wrong id is not a typo — it is a permanent false claim about
the vocabulary. That is what Steps 4–6 exist to prevent, and it is why the id is derived from the
approved label by a pure function rather than supplied by anyone.

---

## 3. What still has to be built before Step 2

| # | item | owner | status |
|---|---|---|---|
| 1 | `db:persist:discovery-run` — write a plan's candidates into `skill_candidate*` | backend | **built** |
| 2 | Admin APIs — queue / detail / decide / metrics | backend | **built** |
| 3 | Approval → `resulting_skill_id` backfill after Step 7 | backend | **built** — `db:backfill:resulting-skill` |
| 4 | Admin review UI | frontend (`apps/admin-web`) | issue [#1260](https://github.com/RVM-BEYOND-PRIVATE-LIMITED/badabhai-platform/issues/1260) raised |

**The backend is complete.** Item 3 closes the audit loop: after Step 7 mints the skill, the
`approved_create` candidate's `resulting_skill_id` is stamped, which is also the honest answer to
*"did this approval ever ship?"*.

Two things about item 3 are worth knowing before running it. It DERIVES its target —
`taxonomySkillIdFor(proposed_skill_name)`, the same pure function the export path mints with — and
there is no `--skill-id` flag, because an operator who can name the target can point any approval
at any skill in the corpus, which is `approved_map` without the review, the reason or the reviewer.
And it therefore reports a label/skill mismatch as `not_shipped_yet` rather than guessing: the run
prints the derived id so a human can see exactly what was looked for.

It is PLAN by default, and `--apply` against production additionally needs
`--i-am-authorised-to-write-to-production` and `OPS_ALLOW_PRODUCTION=backfill:resulting-skill`.
It writes one column on one table, and the guarded `WHERE` requires
`status = 'approved_create' AND resulting_skill_id IS NULL`, so it can never overwrite a
resolution somebody else recorded.

---

## 4. Cost, exactly

**Spent to date: ₹0.** No provider call has been made by any part of this workstream.

| step | model | quantity | cost |
|---|---|---:|---:|
| Discovery run (steps 1–5 of the pipeline) | — | any number of runs | **₹0** — stored vectors reused, lexical matching only |
| Embedding gap for a full semantic pass | `gemini-embedding-001` | 57 phrases of 8,819 | **₹0.034** |
| Label + description extraction — **direct tier only** | `gemini-2.5-flash-lite` | 82 calls | **≈ ₹0.47** |
| Label + description extraction — direct + ambiguous | `gemini-2.5-flash-lite` | 599 calls | **≈ ₹3.42** |
| Label + description extraction — **all candidates** | `gemini-2.5-flash-lite` | 6,673 calls | **≈ ₹38.08** |
| Step 8 embedding of approved aliases | `gemini-embedding-001` | ~2–3 per approved skill | **< ₹0.01** for the direct tier |

Rates: `gemini-embedding-001` ₹0.0125/1k input, no output; `gemini-2.5-flash-lite` ₹0.008 in /
₹0.033 out per 1k — both from `apps/ai-service/app/ai/model_config.py:180,192`.

**Recommendation: authorize ₹0.47 for the direct tier only.** It is the tier with the real
skills in it, the extraction is the only step that needs a model at all, and 82 labels is enough
to measure whether the extraction is worth ₹38 for the rest. Do not authorize the full ₹38 until
the direct tier has been reviewed and the derived-tier ontology question (§5) is answered.

---

## 5. The decisions this plan cannot make

1. **Apply 0093?** (Step 1 — production DDL.)
2. **₹0.47 for direct-tier extraction?** (Step 8 of the pipeline; the ₹38 full run is a
   separate, later question.)
3. **The derived-tier ontology question.** 6,074 candidates are occupation titles with a
   modifier — *"Dyer, Leather"* → is **leather dyeing** a canonical skill we want? That answer
   decides whether the derived tail is worth ~₹35 and ~150 review hours, and it is a product
   decision about what the taxonomy is for.
4. **Task F ownership** — `apps/admin-web` belongs to Frontend Platform (CLAUDE.md §5/§6).
   Default: a fully-specified GitHub issue. Override it and I build it.
5. **Grant `review_skill_candidates` to which roles?** (Step 3.) Recommended: `super_admin`
   only for the first session, widened after the workload is measured.

---

## 6. Review workload — the assumption, flagged as one

The 20s / 45s / 90s per high/medium/low-confidence candidate in
`REVIEW_SECONDS_BY_BAND` is **unmeasured**. Nobody has reviewed a skill candidate in this
system. It yields:

| scope | candidates | screens | est. hours |
|---|---:|---:|---:|
| direct | 82 | 74 | **~1** |
| direct + ambiguous | 599 | 491 | **~13** |
| all | 6,673 | 3,009 | **~167** |

Step 4 is the session that replaces the assumption with a number. Update the constant from that
measurement rather than defending it.

---

*Written 2026-08-26 against run `sdr_20260826-121201Z_final`. Nothing here executed.*
