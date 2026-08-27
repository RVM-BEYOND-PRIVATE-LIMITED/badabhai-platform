# Skill Discovery — the complete lifecycle

> **Scope.** How a phrase becomes a canonical skill, from the row it was observed in to the
> vocabulary the matcher consumes. This is the contract document: every stage names the module
> that owns it and the gate that stands after it.
>
> Companions — the measurement is in
> [`docs/registers/skill-discovery/coverage-report-2026-08-26.md`](../registers/skill-discovery/coverage-report-2026-08-26.md),
> the ordered production steps are in
> [`docs/operations/skill-discovery-activation-plan.md`](../operations/skill-discovery-activation-plan.md),
> and the pre-implementation survey is in
> [`skill-discovery-assessment.md`](./skill-discovery-assessment.md).

## The one-sentence version

`job_domain_alias` is a catalogue of **occupation titles**, not a skill corpus — measured, only
**1.1%** of its 8,819 distinct phrases name an activity directly — so nothing in it may become a
skill without a named human saying so, and this pipeline exists to make that judgement cheap
rather than to avoid it.

## The three id spaces, which must never be conflated

| space | table | population | who authors it |
|---|---|---|---|
| `jd_*` | `job_domain` | 4,071 | the occupation catalogue (NCO-derived) |
| `skill_*` | `skill` | 165 | the taxonomy corpus chain, behind a human commit |
| `mskill_*` | `skill` (`kind = 'match_skill'`) | **18, closed** | a CEO ratification. Nothing else. |

Every recurring hazard in this workstream is one of these three being mistaken for another. Four
walls hold them apart, and they are stated in four different places on purpose:

1. `buildExistingSkillIndex` drops `kind = 'match_skill'` rows, so a match skill can never even be
   *shown* to a reviewer as an option.
2. `validateCandidate` fails `MATCH_IS_MATCH_SKILL` / `RESULTING_IS_MATCH_SKILL` /
   `PROPOSED_LABEL_IS_MATCH_SKILL`.
3. The admin DTO refuses `mskill_` at the pipe, by prefix **and** by `MATCH_SKILLS` membership.
4. Migration 0093 carries `skill_candidate_not_match_skill_chk` and
   `skill_candidate_match_not_match_skill_chk`.

A discovered skill is an **attribute**. It stays unmapped to the match vocabulary until a separate
owner decision, which this pipeline has no path to make.

---

## Stage 1 — DISCOVER

**Owner:** `packages/db/src/discover-skills.ts` (`pnpm db:discover:skills`). Read-only; it has no
`--apply` flag and no write path, asserted against its own source by
`skill-discovery-guardrails.test.ts`.

Sources are pluggable by `source_type`, which is what keeps the next source from becoming a second
pipeline. Six are declared; two are wired:

| `source_type` | wired | notes |
|---|---|---|
| `job_domain_alias` | ✅ 9,121 rows | the published occupation vocabulary |
| `job_domain_label` | ✅ 3,885 rows | the domain's own `label_en` |
| `unresolved_phrase` | ✅ 48 rows | **the inverse of a corpus write** — a phrase the taxonomy did not have. Captured on the request path by `skills/skills.repository.ts`. |
| `worker_phrase` | declared | pseudonymized upstream, by contract |
| `job_posting_text` | declared | — |
| `chat_message` | declared | — |

Adding a source means adding a row to `DiscoverySourceRow[]` and a `source_type` value. It does not
mean touching the classifier, the clusterer, the review queue, the admin API, or the export path.

**Privacy at the door.** `FORBIDDEN_CHARS` runs *first*, before every taxonomy question, and
refuses any phrase carrying a digit, an `@` or a URL. A contact detail that survived
pseudonymization still cannot become a source row. There is no `worker_id` column on any of the
four 0093 tables — deliberately, so this never becomes a per-worker DSAR surface.

## Stage 2 — NORMALIZE and CLASSIFY

**Owner:** `skill-discovery-classify.ts` + `skill-discovery-heads.ts`. Deterministic, no model, ₹0.

Normalization is `normalizeOccupationText` from `@badabhai/profiling-lexicon` — NFKC, lowercase,
punctuation stripped, Indian occupational particles removed. 13,054 source rows collapse to 8,819
distinct phrases.

The classifier answers one question — *does this phrase name work, or name a person who does
work?* — using an **occupation-head lexicon derived from the catalogue itself** (1,089 heads),
not a hand-written stoplist. Five verdicts:

| class | measured | meaning |
|---|---|---|
| `OCCUPATION_WITH_SKILL_EVIDENCE` | 7,005 | a title whose modifier names the work ("Dyer, Leather") |
| `OCCUPATION_ONLY` | 908 | a title and nothing else ("Magician"). **Never becomes a skill.** |
| `AMBIGUOUS` | 557 | shape gives no signal. A reviewer's call, queued as one. |
| `REJECTED_NON_SKILL` | 253 | forbidden characters, prose, all-generic, too long |
| `ACTIVITY_PHRASE` | **96 (1.1%)** | names the work directly |

**Vernacular is first-class, and it took two fixes to become so.** The head lexicon is Latin
agent-noun morphology, so Hindi phrases found no heads; and `isProse` decides "starts lowercase"
by `first === first.toLowerCase()`, which is **true for every Devanagari character** because the
script is unicase — so that one rule reported prose for 100% of Hindi input. Both are fixed
(`DEVANAGARI_ROLE_NOUNS`, `DEVANAGARI_ACTIVITY_SUFFIXES`, and a Devanagari exemption from the prose
test). वेल्डिंग, सिलाई, घिसाई, चिनाई, पुताई, शटरिंग and नानबाई are now in the highest-yield tier.
`riksha` and `plumbing` are not scrape noise either — `MIN_TOKENS_FOR_PROSE_TEST = 3` is why.

## Stage 3 — MATCH against the shipped taxonomy

**Owner:** `skill-discovery-match.ts`. Still deterministic, still ₹0. **This runs BEFORE any AI**,
which is the entire cost argument: 8,819 phrases reduce to 6,673 candidates and 3,009 review
screens before a model is asked anything.

Five relations, graded in two strengths:

- **strong** — `exact_surface`, `skeleton_surface`, `normalized_label_equal`,
  `surface_form_shared`, `informative_tokens_equal`
- **weak** — `strict_token_subset`, `high_token_overlap`

> **Similarity is evidence, not authorization.** A weak match may be **shown** to a reviewer. It
> may never be the reason the machine suggests a resolution — `validateCandidate` fails
> `WEAK_MATCH_DROVE_ACTION` if it is. This is not a stylistic preference: the measured false
> matches in this repository are `ducting_installation → plumber`,
> `visual_defect_identification → quality_inspector`, `split_unit_installation → fitter`. Each is
> a defensible-looking number attached to a wrong answer, and each would have been auto-mapped by
> a threshold.

The review screen shows **every** competing match, not the top one. Two shipped skills answering
to one phrase is the `ALIAS_AMBIGUOUS` condition, and collapsing it to a single suggestion is how
the coin gets flipped on the reviewer's behalf.

## Stage 4 — CLUSTER and BATCH, without transitivity

**Owner:** `skill-discovery-match.ts` (`clusterPhrases`) and `skill-discovery-groups.ts`.

Clustering is union-find over `MERGE_RELATIONS` — **identity relations only**. Two rungs were
removed after they were measured:

- **`strict_token_subset` made merging transitive.** `wood ↔ wood metal ↔ metal ↔ …` produced one
  cluster holding 8,478 source rows, 5,706 distinct phrases and 2,814 of 3,885 domains.
- **The consonant-skeleton rung collided.** `pile`/`pool`/`ply` all fold to `pl`, which put
  "pile-driver operator", "swimming pool cleaner" and "ply bander" in one cluster;
  `battery`/`butter` in another. The skeleton is a *candidate generator*, as its own docblock says
  — not a decider.

Everything the merge rung refuses is still reported, as `weakCollisions`. Nothing is dropped
silently.

**Batching is a lens, not a merge.** `groupCandidates` keys on `${tier}|${family}|${anchor}` — no
transitive closure, no group id in any table, no group-level decision. 6,673 candidates become
**3,009 review screens** (1,979 singletons; largest batch 60). Verified order-independent and
stable under corpus growth. A "decide all in this group" affordance must issue N individual
decision calls, because each one gets its own reason and its own audit row.

## Stage 5 — the CANDIDATE, and what it can never be

**Owner:** `skill-discovery-candidate.ts` + migration 0093.

A candidate is a **claim**, never a skill. Four tables:

```
skill_discovery_run  1 ──< skill_candidate  1 ──< skill_candidate_source
                                  │
                                  └──< skill_candidate_match
```

**19 provenance fields are frozen and digested** (sha256, declared order). `assertProvenanceIntact`
compares before and after every decision; `PROVENANCE_DIGEST_MISMATCH` is the alarm when one moves.
`provenance_digest` is **served** on the review screen — it is not a secret, and it is the only way
a reader can tell that a row's lineage still checks out. It must never be recomputed on an update
path to make a mismatch go away; that launders the lie it exists to expose.

Four fields are deliberately **outside** the digest — `proposed_skill_name`,
`proposed_description`, `approved_job_domain_ids`, `approved_requirement`. They are the proposal a
reviewer is invited to correct, and correcting one is a new fact in the review columns rather than
a change to what the run observed.

**No threshold moves a status.** Every status this stage writes is `pending` or `needs_review`;
`assertDryRunSafe` **throws** (never filters) if a run somehow produced an approval, because a run
that did has a bug whose blast radius is the production vocabulary.

### The status ladder

```
pending ──> needs_review ──> approved_create | approved_map | approved_merge | rejected | deferred
   └──────> rejected                              deferred ──> (any of the four terminal states)
```

Three properties, and the database enforces **none** of them:

- **`canTransition` is the only enforcement.** No CHECK in 0093 stops `pending → approved_map`,
  which skips human review entirely. The API is therefore the enforcement point.
- **A `hold` on a `pending` row is a two-step.** `canTransition('pending','deferred')` is false, so
  the service runs `pending → needs_review → deferred` inside **one** transaction. Writing
  `deferred` straight onto a `pending` row satisfies every DB CHECK and violates the code ladder
  silently, which is the worst combination available.
- **Terminal means terminal.** The four terminal statuses have no outbound edge, because the
  decision was recorded against a specific `corpus_fingerprint` and re-opening the row would
  silently re-scope it to a corpus the human never saw. Re-deciding is a **new candidate in a new
  run**. `deferred` is *not* terminal — a held candidate is re-openable.

## Stage 6 — HUMAN REVIEW

**Owner:** `apps/api/src/admin/admin-skill-discovery.{controller,service,repository,dto}.ts`.
UI: GitHub issue **#1260** (`apps/admin-web`, Frontend Platform).

| method | path | capability |
|---|---|---|
| `GET` | `/admin/skill-discovery` | `read_entities` |
| `GET` | `/admin/skill-discovery/metrics` | `read_entities` |
| `GET` | `/admin/skill-discovery/groups` | `read_entities` |
| `GET` | `/admin/skills` | `read_entities` |
| `GET` | `/admin/skill-discovery/:id` | `read_entities` |
| `GET` | `/admin/skill-discovery/:id/audit` | `read_entities` |
| `POST` | `/admin/skill-discovery/:id/decision` | **`review_skill_candidates`** |

The six reads sit on the ADR-0025 read floor: they serve normalized phrases, enums, counts and a
backlog age — the operational question. The write is on a **newly minted** capability
(`super_admin` + `ops_admin`), because taxonomy **authorship** is a different data class from
entity moderation, money, a worker's standing or admin identity. Folding it into `flag_worker`
would grant vocabulary authorship as a side effect of a moderation grant, and `GET /admin/me`
would start telling the console so, with nothing in CI saying it had happened.

> **Owed to a human, not to the code:** ADR-0025 §3.1 has no cell for `review_skill_candidates`.
> The allow-set is the backend's reasoned default and `admin-roles.guard.test.ts` records that it
> pins the code against the code, which is drift detection but not ADR compliance.

**A reviewer never sees a cosine score.** `AdminSkillRelatedSkill` has no `score` key even though
the repository reads the column, and the type split is the mechanism: building a response means
naming fields, and naming fields means somebody has to type `score:` on a type that does not have
it. `rank` survives because it is an **order**, not a measurement.

### The five decisions

| button | wire | status | extra body |
|---|---|---|---|
| CREATE NEW SKILL | `create` | `approved_create` | `proposed_skill_name`, `approved_job_domain_ids` (**min 1**), `approved_requirement`, `proposed_description?` |
| ADD AS ALIAS | `alias` | `approved_map` | `resulting_skill_id` |
| MERGE | `merge` | `approved_merge` | `resulting_skill_id` |
| REJECT | `reject` | `rejected` | — |
| HOLD | `hold` | `deferred` | — |

Every decision carries `expected_status` (the optimistic-concurrency token) and `review_reason`
(≥ 12 chars, required on **every** branch including `reject`, which is the one a future reviewer is
most likely to want explained). The reviewer and the timestamp are **not** in the body — an actor a
caller can type is not an actor.

The body is a discriminated union of five `.strict()` members, so the database's conditional CHECKs
become unrepresentable states rather than 500s naming a constraint. `create` does **not** accept
`resulting_skill_id`: that column stays NULL until the offline chain actually mints the skill,
which makes it the honest answer to *"did this approval ever ship?"*.

**Every named trade is resolved against `job_domain` before the transaction opens** —
`assertLiveJobDomains`, requiring `selectable AND status = 'active'`, refusing partial resolution
and naming the unknown ids. Nothing else catches a typo: `approved_job_domain_ids` is `text[]`, and
Postgres cannot put a foreign key on an array element, so `skill_candidate_create_domain_chk`
counts the array and stops while the DTO checks only the shape. Without this, a plausible `jd_`
typo is recorded as a decision and surfaces weeks later as an FK violation halfway through a seed.

**`approved_job_domain_ids` is mandatory on `create`, and that requirement was learned the hard
way.** The first export path emitted no edges, on the defensible-sounding grounds that a discovery
pipeline must not *infer* what a trade requires — and every batch it produced was permanently
`BLOCKED` by `SKILL_ORPHAN`: *"Nothing reaches this skill: it is not on any trade's picker and no
posting can be built from it. It seeds, it embeds, and it is invisible."* The validator was right
and the design was wrong. The resolution is neither to infer the edge nor to weaken the gate, but
to ask the human already looking at the answer — which is exactly the judgement
`job_domain_skill.source = 'curated'` represents.

### Re-run safety and idempotency

| situation | outcome |
|---|---|
| same decision resubmitted on a row already in that state | `200`, `changed: false`, `already_decided: true`. **Nothing written**, no event, and the first reviewer's authorship is not overwritten. |
| a *different* decision on a terminal row | `409 already_decided`. That is a disagreement, not a retry, and not this route's job to resolve. |
| a concurrent racer got there first | the guarded `WHERE status = <expected>` matches no row → rollback, `changed: false`, no event. |
| `expected_status` stale on a still-undecided row | `409 stale_expected_status` |
| `canTransition` refuses the move | `409 illegal_transition` — the DB would **not** have caught this one |
| a re-run of discovery | `ON CONFLICT (run_id, cluster_key) DO UPDATE … WHERE status IN ('pending','needs_review')`. A reviewed decision is never overwritten by a later run; a new phrase becomes new review work. |

`updated_at` is deliberately **not** the concurrency token. It is `timestamptz` (microseconds) and
a JS `Date` is milliseconds, so a token minted from a row's timestamp and bound back does not equal
the row it came from — migration 0083's finding. A concurrency token that never matches turns every
decision into a 409; one that matches by luck is worse.

### Audit

One value-free `admin.action_performed` per decision, on the **same transaction** as the row write.
Events and SoR are the same Postgres database, so an emit failure rolls the decision back — an
admin decision with no spine row is a taxonomy change with no audit trail.

Five action codes, not one plus a payload field, because the spine is value-free and *which way a
reviewer decided* **is** the value: `skill_candidate_approved_create`, `_approved_map`,
`_approved_merge`, `_rejected`, `_deferred`. Each is named for the SoR **status** it records, not
for the wire word, so the code is a total function of `statusForDecision` and an auditor needs no
translation table. `skill_candidate` is a registered `SUBJECT_TYPES` member; the subject is the
**candidate**, not the reviewer's session, because "what happened to this candidate" is the
question a taxonomy decision has to survive being asked years later.

The reason text, the proposed label, the target skill id and the confidence band stay **on the
row**. None of them may ride an event.

## Stage 7 — EXPORT to the corpus (offline, gated)

**Owner:** `skill-discovery-export.ts`, `export-approved-skills.ts`
(`pnpm db:export:approved-skills`). **No `--apply`, ever.**

| decision | produces |
|---|---|
| `approved_create` | a new `TaxonomySkillRecord` (id from `taxonomySkillIdFor`) + one `source:'curated'` edge per reviewer-named trade |
| `approved_map` | a `reuses_existing: true` record — aliases only |
| `approved_merge` / `rejected` / `deferred` | nothing |

Both shipped gates run: `validateTaxonomyCorpus` (structural) then `taxonomyQualityVerdict`
(semantic). Neither is weakened, and two findings were resolved by **supplying facts the gate
needed** rather than by relaxing it:

- `SKILL_ORPHAN` on an alias-only batch — fixed by passing the reused skill's **real existing**
  `job_domain_skill` rows through with their actual values, which makes a re-seed a provable no-op.
  A target with genuinely no edges still blocks, correctly.
- `CONVERGENCE_GROUP_UNKNOWN_DOMAIN` on a small batch — fixed by `applicableConvergenceGroups`,
  which runs the groups whose trades are all present and **names the skipped ones in the
  manifest**. Passing `groups: []` would have disabled a gate; padding the corpus would have traded
  one blocking finding for `DOMAIN_ORPHAN`.

**The gates bite.** In the Phase-5 dry run a simulated reviewer's decision to create *"Arc Welding
(Vernacular)"* beside the shipped `skill_arc_welding` was refused as `MISSED_REUSE_CATALOGUE`. The
same batch re-run with a genuinely new skill (शटरिंग → `skill_shuttering_erection`) passed with
zero structural problems.

## Stage 8 — SEED, EMBED, EVALUATE, PROMOTE

Unchanged, pre-existing, and this workstream adds no shortcut to any of it:

```
accepted-*.jsonl → HUMAN COMMIT → db:seed:domain-skills → db:embed:skills
                 → db:eval:taxonomy → db:promote:skills (C1..C5)
```

C1–C5 are `GATE_ACCEPTED`, `IS_PROVISIONAL`, `ACTIVE_EDGE`, `FULLY_EMBEDDED`, `EVAL_COVERED`.
Freshness is **not waivable** — corpus-fingerprint equality, never a timestamp.

`resulting_skill_id` on an `approved_create` row is backfilled only after this chain actually
ships the skill. Until then it is NULL, and that NULL is the honest answer.

---

## The write surface, as a property

**One scanner, two consumers.** `packages/db/src/lifecycle-writer-scan.ts` walks every workspace
that can reach the database and returns the writer set keyed by repo-relative path.
`skill-lifecycle.test.ts` asks the repo-wide question of it; `apps/api`'s
`taxonomy-write-surface.test.ts` asks the request-path question of the same answer.

**Measured, repo-wide (2026-08-27):**

| table | writers | where |
|---|---:|---|
| `skill` | 6 | all `packages/db` |
| `skill_alias` | 8 | all `packages/db` |
| `job_domain_alias` | 3 | all `packages/db` |
| `job_domain` | 1 | `packages/db` |
| `job_domain_skill` | **1** | `seed-domain-skills.ts` |
| `unresolved_phrase` | 4 | 3 in `packages/db`, **1 in `apps/api`** |

The single app-side writer is `apps/api/src/skills/skills.repository.ts` → `unresolved_phrase`, the
inverse of a corpus write: the row that says a worker used a phrase the taxonomy does not have.
**Zero** files anywhere write `skill`, `skill_alias`, `job_domain`, `job_domain_alias` or
`job_domain_skill` from a request path.

**The guarded set is the taxonomy spine, and that is a choice.** `SPINE_TABLES` is the six tables
above. `worker_skill`, `worker_profile_skill` and `job_posting_skill` are deliberately outside it:
they are not vocabulary, they have legitimate owners elsewhere in the product
(`apps/api/src/match/worker-skills.repository.ts` writes `worker_skill` — the worker's own
MATCH_SKILLS picker), and putting them on a forbidden list would fail on a writer that is supposed
to exist. So the scanner proves the discovery surface writes no VOCABULARY; that it also writes no
worker- or posting-owned skill row is true and was verified by hand, not by this guard.

Three things make that claim hold up rather than merely sound good:

- **The root list is derived, not remembered.** A writer needs the Drizzle models or a connection,
  and both arrive through `@badabhai/db`. `workspacesDependingOnDb` re-reads the workspace
  manifests every run and the test fails if a third consumer appears, so a new one becomes a
  decision about `SPINE_WRITER_ROOTS` rather than a hole in it.
- **Comments are stripped first.** The three review-layer files each explain at length that they do
  not write those tables, naming all three. Counting prose would flag exactly the files most
  careful to say what they refuse to do.
- **Direction of error is stated.** A dynamically assembled statement would be missed, so a hit is
  proof and a miss is not. It is a floor under the promise, not the promise.

> **Why this was worth doing.** The scan previously read one directory while asserting a
> repo-wide property, and `apps/api` — 198 files importing `@badabhai/db`, every HTTP request path
> in the product — was outside it. And the first repo-wide run was itself wrong: `packages/db`
> imports drizzle's `sql` as `dsql` and the matcher was built for that, so pointed at `apps/api` it
> read 437 files and reported **zero** writers. An audit that returns "nothing found" because it
> cannot read the syntax in front of it is worse than no audit, because the empty result gets
> quoted.

## Row-level security on the four new tables

`0093` gives all four the house posture: `ENABLE` + `FORCE ROW LEVEL SECURITY`, **zero policies**,
and `REVOKE ALL` from `PUBLIC`, `anon`, `authenticated` and `service_role` — 16 REVOKEs, four per
table. Identical to what `0052` did for `skill_related`, `0066` for the job-domain tables and
`0076` for the canonical taxonomy tables.

**What that means for a client, and why the failure is quiet.** `anon` and `authenticated` have
`rolbypassrls = false`, so RLS denies them whatever the grants say. `service_role` has
`rolbypassrls = TRUE`, so for that role the REVOKE is the only control — which is exactly why the
pattern revokes rather than trusting RLS alone. A Data-API client hitting these tables gets an
**empty result, not an error**. Nothing logs, nothing 500s, and a zero row count from that path is
never evidence about the data.

The backend reaches the tables through the owner connection, which is what the rest of the spine
already relies on; `FORCE` is what governs the owner, and revoking its grant would take the
application down.

**Measured, not assumed (`pnpm db:audit:rls`, 2026-08-27):** 81 live public tables, **81 fully
locked**, zero deviations. 0093 makes it 85 of 85 — the posture is the established default here,
not a new risk this feature introduces. `0088`'s `rls_auto_enable` event trigger applies the same
three conditions on every `CREATE TABLE` in `public`, so the statements are expected to be
idempotent no-ops where that trigger is live; they are written out anyway, because the trigger
exists in one environment's catalogue and a migration that depended on it would silently ship
unlocked tables everywhere else.

## What has NOT been decided, and by whom

| # | question | why it is not the backend's call |
|---|---|---|
| 1 | Which of the 6,673 candidates become skills | 7,038 candidates are not 7,038 skills. Every one is a judgement about the ontology. |
| 2 | Whether any discovered skill joins `MATCH_SKILLS` | The 18 `mskill_*` members are a CEO ratification. No code path here can reach them. |
| 3 | The ADR-0025 §3.1 cell for `review_skill_candidates` | An authorization decision. The current allow-set is a reasoned default, and the tests say so. |
| 4 | Applying migration 0093 | Production DDL. Authored, reviewed, **not applied**. |
| 5 | Any paid embedding or extraction run | 8,762 of 8,819 phrases are already embedded; the 57 missing cost ≈ ₹0.034. Extraction is ≈ ₹0.47 for the direct tier. **₹0 has been spent.** |
| 6 | Whether the grouped queue leads with `undecided` instead of `candidates` | An ordering is a statement about what a reviewer should do next. The server sorts by batch SIZE today; sorting by remaining WORK is defensible and is a product call, not a backend one. Recorded rather than changed — see below. |
| 7 | Whether `source_id` stays on the detail response at all | It is a catalogue id on today's pipeline and safe to serve. Removing it anyway is the stricter option and costs a coordinated `apps/admin-web` change, because the console keys its source list on it. Not a backend decision alone (CLAUDE.md §6). |

Tier sequencing is a product rule, not a preference: `direct` (82 candidates / 74 screens ≈ 1 hour)
is reviewed and validated first. `derived` (6,074) stays closed until then, and the UI must make
that visible — a banner or a disabled tab with a reason, never a silent default filter.

### Group ordering, stated once so two clients cannot disagree

**The server orders the batches and is the authority.** `GET /admin/skill-discovery/groups` returns
`groups[]` sorted by:

1. `candidates` **descending** — batch size;
2. ties broken by `key` **ascending**, compared by **UTF-16 code unit**.

Step 2 is a code-unit comparison and not `localeCompare`. `localeCompare` is neither total — it
returns `0` for keys differing only by a collation-ignorable code point, after which a stable sort
falls back to the grouping query's row order, and that query deliberately has no `ORDER BY` — nor
host-independent: Latin versus Devanagari flips sign between an `en-*` and a `hi` ICU default, and
Devanagari anchors are a supported case. Code units make the response byte-identical for identical
input on every host, which is what a reviewer returning to "the wood batch" relies on, since a
group has no id in any table and exists only as a recomputed lens.

**The console must not add a second ordering.** The anchor a candidate is batched on is computed
across the whole filtered population, so an order derived client-side from one response is a
different function, not a re-application of the same one.

**The open question is `undecided` versus `candidates`** (row 6 above). Sorting by size means a
fully-decided 35-member batch outranks a 10-member batch nobody has opened. `undecided` is served
per group precisely so that ordering is *possible* — but switching to it changes what "the first
batch" means, so it is a decision to record, not a default to flip.
