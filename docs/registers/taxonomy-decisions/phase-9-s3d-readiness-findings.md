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

**Five live-path callers were pinned**, not one — pin 5 has since been removed (§1.1). The most
consequential:

| # | where | why it cannot follow the switch |
|---|---|---|
| 1 | `profile.py:295,309` | passed `settings.skill_canonicalize_default_domain` (`"cnc-machining"`) as the positional `domain_id`, blocked at the contract because `ProfileExtractionInput` had **no `job_domain_id` field at all**. **Unpinned** — the field exists and the router honours it; what remains is choosing what to put in it (§1.1) |
| 2 | `profile.py:358-404` | the SAME request resolves a real `jd_*` via `match_job_domain` — but **after** the canonicalize pass, and only returns it. Classic "resolves the domain, then does not use it" |
| 3 | `profile.py:365-372` | never passes `pinned_job_domain_id`, which `domain_match.match_domain` already accepts |
| 4 | `job-postings.service.ts:45,142` | the ternary is switch-ready, but both CREATE paths pass literal `null` and **nothing anywhere writes `job_postings.job_domain_id`** — no DTO field, no backfill. 100% legacy today |
| 5 | `skill_store.py:123-152` | **was circular — CLOSED, see below** |

### 1.1 Caller 5 was the one that blocked threshold derivation — and it is now wired

**As found.** `HttpSkillStore.record_unresolved` had **no `job_domain_id` parameter at all**,
matching its Protocol. `_safe_record` hard-returned when `domain_id is None`, and
`canonicalize_skill` called it with the legacy id only. The API side accepted `job_domain_id`
on that exact route — migration 0078 shipped for it — but nothing upstream could send one.

**So flipping the switch would have silently dropped every Path A MISS** before it reached the
queue built to catch misses. That closed a loop the plan does not acknowledge: S3-C's abort
thresholds are to be derived from shadow data about Path A's failures, and the recording path
for those failures discarded them. It was not one of five pins — it was a prerequisite of the
instrumentation the plan gates S3-D on. It is also why the 0078 work landed one layer short of
useful: the column, the widened key, the CHECK and the v2 event were all in place and correct,
and no producer could populate them.

**As fixed.** The scope now travels end to end and the seam is symmetric — both store methods
take the same keyword-only `job_domain_id`, defaulted, so a store predating the parameter keeps
working and one asked for a canonical scope degrades like an outage rather than 500-ing a
worker's turn:

```
ProfileExtractionInput.job_domain_id   (new, optional, bounded 1..64)
  → profile.py picks EXACTLY ONE scope for the pass
    → canonicalize_labels(job_domain_id=…)
      → canonicalize_skill → _safe_record(job_domain_id=…)
        → HttpSkillStore.record_unresolved → POST /internal/skills/unresolved
          → unresolved_phrase.job_domain_id + skill.phrase_unresolved_v2
```

**What is deliberately NOT in it.** Nothing populates `ProfileExtractionInput.job_domain_id`
— `profile-extraction.processor.ts:701` still sends `{worker_ref, transcript, messages}`, so
every extraction takes the legacy branch and is byte-identical. That one field IS the flip for
this caller, which is the property the plan wants: there is no flag to unwind, and reverting is
deleting a field rather than re-sequencing a deploy.

**The remaining sequencing question is a real one, and it is not engineering's.** For the
worker path there is no obvious value to put in that field: a worker has no job domain at
extraction time — `match_job_domain` is what *computes* one, and it runs after the canonicalize
pass. Two candidate producers exist and they differ in kind:

- **reorder in-request** — move the RAG match ahead of the canonicalize pass and feed its
  result in. Mechanically feasible (the query is built from `rich.skills` / `rich.machines` /
  `canonical_role_id`, all available earlier), but it makes canonicalization depend on a
  same-request classification that can itself be `unmatched_*`.
- **use the previously persisted match** — `worker_profiles.job_domain_id` from an earlier
  extraction. Stable and cheap, but absent on a first extraction and stale by construction.

Both change what a worker's skills are canonicalized *against*, so the choice is a taxonomy
decision rather than a wiring one. It is listed as such in the decision set.

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
| 4 | worker/profile caller has no switch | ✅ **wired** — §1.1. Contract field + router propagation + the miss path, end to end. Nothing populates it, which is the flip |
| 5 | retag guard keys on `NODE_ENV` | ✅ **fixed** — `ops-guard.ts`, database-aware, 25 tests |

**The shadow's headline number is the one to read first**: Path A returns nothing for **65 of 123**
scoring cases under production semantics, against Path B's 0. Most canonical skills are still
`provisional`, so Path A has no candidates in those domains. **S3-D cannot be flipped before
promotion** — not because a threshold was breached, but because there is nothing to rank.
