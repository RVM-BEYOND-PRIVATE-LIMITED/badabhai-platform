# S3-D readiness — the four investigations, and what they found

> **2026-08-19.** Four adversarial lenses over the S3 plan and the code, each serious finding
> independently refuted-or-confirmed. All four confirmed. Read-only throughout; nothing in
> production was touched.
>
> Authoritative evaluation numbers, unchanged: **scored 113 · R@1 0.9912 · 0 false negatives ·
> Path A cross-domain isolation 0 false positives · US-04 coverage 3/4 → 4/4 after the separate
> retag step.**

---

## 1. The read switch has no flag — it *is* the request shape

This reframes the whole "worker/profile caller" item.

Per `phase-9-s3-deployment-plan.md`, the S3-C switch is *"which field the caller populates —
`job_domain_id` (Path A) or `domain_id` (Path B)"*. There is **no feature flag** for it. So "this
caller would not follow the switch" does not mean "it reads the wrong flag" — it means it
**structurally cannot populate `job_domain_id`**.

**The seam below is ready.** `canonicalize_labels` and `canonicalize_skill` already accept a
keyword-only `job_domain_id`, and the entire NestJS path — DTO, controller, service, repository,
migration 0078, `skill.phrase_unresolved_v2` — is S3-C-ready. Every pin is *upstream* of it.

**Five live-path callers are pinned**, not one. The most consequential:

| # | where | why it cannot follow the switch |
|---|---|---|
| 1 | `profile.py:295,309` | passes `settings.skill_canonicalize_default_domain` (`"cnc-machining"`) as the positional `domain_id`. Blocked at the contract: `ProfileExtractionInput` has **no `job_domain_id` field at all** |
| 2 | `profile.py:358-404` | the SAME request resolves a real `jd_*` via `match_job_domain` — but **after** the canonicalize pass, and only returns it. Classic "resolves the domain, then does not use it" |
| 3 | `profile.py:365-372` | never passes `pinned_job_domain_id`, which `domain_match.match_domain` already accepts |
| 4 | `job-postings.service.ts:45,142` | the ternary is switch-ready, but both CREATE paths pass literal `null` and **nothing anywhere writes `job_postings.job_domain_id`** — no DTO field, no backfill. 100% legacy today |
| 5 | `skill_store.py:123-152` | **see below — this one is circular** |

### Caller 5 is the one that blocks threshold derivation

`HttpSkillStore.record_unresolved` has **no `job_domain_id` parameter at all**, matching its
Protocol. `_safe_record` hard-returns when `domain_id is None`, and `canonicalize_skill` calls it
with the legacy id only. The API side accepts `job_domain_id` on that exact route — migration
0078 shipped for it — but nothing upstream can send one.

**So flipping the switch would silently drop every Path A MISS** before it reaches the queue
built to catch misses.

That closes a loop the plan does not currently acknowledge: S3-C's abort thresholds are to be
derived from shadow data about Path A's failures, and the recording path for those failures
discards them. **The `unresolved_phrase` volume signal cannot be collected until this caller
carries `job_domain_id`** — so it is not merely one of five pins, it is a prerequisite of the
instrumentation the plan gates S3-D on.

This is also why the 0078 work landed one layer short of useful: the column, the widened key,
the CHECK and the v2 event are all in place and correct, and the producer cannot populate them.

**What this means for sequencing.** The switch cannot be exercised for the worker path until
`ProfileExtractionInput` carries a `job_domain_id` and the resolve happens *before* the
canonicalize pass, not after. That is a contract change plus a reordering — engineering-safe,
additive, and not yet done. It is the honest reason S3-D's "everything is tied to the switch"
property does not hold today.

---

## 2. `promote-skills` EVAL_COVERED — confirmed, and the previous fix was a no-op

**The mismatch is real and not subtle.** The C5 spec says in prose *"Mechanical `corpus_alias:*`
cases do NOT count"*; the implementation uses `isScoreable(c)`, which is
`reviewStatusOf(c) !== "pending_review"`. `reviewStatusOf` returns one of three values and the
implementation excludes exactly one — the one the spec never mentions.

**Measured, from the shipped fixture (127 cases):**

| review status | count |
|---|---|
| mechanical | **39** |
| reviewed | 88 |
| pending_review | **0** |

The 39 is correct. All 39 are `corpus_alias:*` — 24 `exact_alias` + 15 `devanagari_alias`. No
case carries an explicit `review_status`; all 127 are derived from provenance.

**Because there are zero `pending_review` cases, the earlier PR-1 fix (#953) is a behavioural
no-op on the shipped fixture.** The covered set is 65 skills with the filter and 65 without it;
`coverageOnly` is always empty and the operator warning is unreachable. The commit message
asserts the opposite.

**Blast radius: 6 skills** are EVAL_COVERED only via a mechanical case.

**Not fixed here, deliberately.** Replacing `isScoreable` with
`reviewStatusOf(c) === "reviewed"` is a two-word edit, and it makes a live promotion gate
**stricter** — six skills stop being promotable. That is a policy change wearing a bug fix's
clothes, and which of the two readings is correct is the eval owner's call:

- *the spec is right* — a mechanical case is tautological (the query is the skill's own alias) and
  proves nothing about retrieval, so it must not unlock promotion;
- *the code is right* — a mechanical case does prove **reachability**, which may be all the gate
  was ever asking for.

Both are defensible. The evidence is above; the decision is one line either way.

---

## 3. `cnc-programming` — the measured decision table

Path B predicate: `sa.domain_id = $1 AND s.status = 'active' AND sa.embedding IS NOT NULL`.

| | before S3-D | after S3-D (A, C) | after S3-D (B) |
|---|---|---|---|
| Path B candidate rows | **11** | **8** | 9 |
| distinct skills reachable | **4** | **3** | 3 or 4 (target-dependent) |
| alias rows carrying the slug | 14 | 10 (retag moves 4) | 11 |
| slug digest | `b98478d4…` | changes | changes, differently |

**Rows that leave** — all `skill_cad_interpretation`, `en`, embedded:
`02776ee2…` CAD · `0c6caf0d…` technical drawing · `580d7d5b…` read engineering drawings.
`drawing padhna` (hi) was **never a candidate** — `embedding IS NULL` — so it is inert before and
after; it merely moves to `cnc-machining`.

**Option B's real cost.** Not "one additive row":

- **No shipped runner can write it.** Every `skill_alias` writer derives `domain_id` from the
  parent skill (`seed-skills.ts:182,204`, `retag-skills.ts:487`, `seed-domain-skills.ts:606`).
  A cross-slug row is currently *inexpressible*, and needs a new dedicated runner with its own
  manifest and rollback.
- **It works, mechanically.** Path B filters `sa.domain_id`, never `skill.domain_id`, and nothing
  downstream re-checks that the returned skill belongs to the requested slug — so a row carrying
  `domain_id='cnc-programming'` on a `cnc-machining` skill *is* returned. That is why the row must
  be justified on taxonomy grounds, not feasibility.
- **It needs an embedding** to be retrievable at all, and `db:embed:skills` has no per-row scope.
- **The only semantically correct target, `skill_drawing_reading`, does not exist in production
  until S3-A.** So B is sequenced strictly after S3-A and at-or-after S3-D.
- **No precedent exists** in the repo for a cross-slug compatibility alias. B establishes a new
  data pattern rather than following one.

---

## 4. TD-07 — seven routes to a silent MIG assignment, five of them live

**Validated by executing the real code**, not by reading it: `signals.detect` in the ai-service,
then `deriveWorkerSkills` from `packages/match-engine`.

Two independent bridges converge on the same specific process, and there is **no generic
`mskill_welder_*` id to land on** — unlike CNC, which has `mskill_cnc_operator_general`:

- `match-skills.ts:488` — `skill_welder_occupation → mskill_mig_welder`
- `match-skills.ts:404` — `role_welder → mskill_mig_welder`

**Measured outputs:**

| a worker says | what is written |
|---|---|
| `"welder hun main"` | `mskill_mig_welder` |
| `"welding ka kaam karta hu"` | `mskill_mig_welder` |
| **`"tig welding karta hu 5 saal"`** | **`mskill_mig_welder`, `mskill_tig_welder`** |
| `"arc welding aur gas cutting"` | `mskill_arc_welder`, `mskill_mig_welder` |
| `"cnc operator hun, welding bhi kar leta hun"` | `mskill_cnc_operator_general`, `mskill_mig_welder` |

**The third row is the finding.** A worker who said *only TIG* is written as a MIG welder too,
with the **identical bucketed experience total** — 96 months on both rows. Their profile now
claims five years of a process they never mentioned.

The last row shows the guard is partial: `_assign_welding_role` has a machining guard, but it
protects only the ROLE bridge. `_detect_welding` is ungated, so the attribute bridge fires anyway.

The write lands in `worker_skill.skill_id` with `source='derived_coarse'`, plus
`job_reach.matched_skill_id`.

**Engineering has no view on the remedy.** What it can say is that TD-07 was framed as a *gap* —
"there is no generic welding skill" — and the measured behaviour is not a gap but an **incorrect
specific assignment that already ships**. Those call for different decisions, and the register's
framing predates this measurement.

---

## Status of the five S3-D blockers

| # | blocker | state |
|---|---|---|
| 1 | no S3-D rollback | ✅ **built** — `db:rollback:s3d`, capture/restore, 18 tests |
| 2 | `--preserve-existing-status` missing | ✅ **built** — 14 tests, merged |
| 3 | abort thresholds uninstrumented | ▲ **instrument built** — `db:report:s3d-shadow`. Thresholds still un-set, deliberately |
| 4 | worker/profile caller has no switch | ⏸ **scoped** — §1. Contract change + reordering, engineering-safe, not done |
| 5 | retag guard keys on `NODE_ENV` | ✅ **fixed** — `ops-guard.ts`, database-aware, 25 tests |

**The shadow's headline number is the one to read first**: Path A returns nothing for **65 of 123**
scoring cases under production semantics, against Path B's 0. Most canonical skills are still
`provisional`, so Path A has no candidates in those domains. **S3-D cannot be flipped before
promotion** — not because a threshold was breached, but because there is nothing to rank.
