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

## 4. TD-07 — the routes to a silent MIG assignment, and the fields they reach

**Validated by executing the real code**, not by reading it: `signals.detect` in the ai-service,
then `deriveWorkerSkills` from `packages/match-engine`. §4.1 and §4.2 then sweep every route and
every persisted field, verified at the source.

Two independent bridges converge on the same specific process, and there is **no generic
`mskill_welder_*` id to land on** — unlike CNC, which has `mskill_cnc_operator_general`:

- `packages/taxonomy/src/match-skills.ts:488` — `skill_welder_occupation → mskill_mig_welder`
- `packages/taxonomy/src/match-skills.ts:404` — `role_welder → mskill_mig_welder`

The bridge TABLES live in `packages/taxonomy`; the function that walks them is
`deriveWorkerSkills` in `packages/match-engine/src/derive.ts:50`. **The whole welding vocabulary
is three ids** — `mskill_arc_welder`, `mskill_mig_welder`, `mskill_tig_welder` — and a sweep of
`packages/taxonomy/src` and `packages/match-engine/src` for `mskill_*weld*` returns exactly those
three. There is no generic welder id to land on, which is why an unspecific signal has to pick a
specific process.

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

### The blast radius is wider than the write, because MIG is pre-ticked-related to the others

`MATCH_SKILL_RELATION_PAIRS` (`packages/taxonomy/src/match-skills.ts:315-343`) makes the welding
family **mutually related** — `(arc, mig)`, `(arc, tig)`, `(mig, tig)`, three edges — and
`relatedSkillsDefault` is **`"on"` by default** (`packages/match-engine/src/config.ts:46`), so
related skills arrive **pre-ticked** on the payer's side
(`apps/api/src/match/match-skills.service.ts:145`).

So the TIG-only worker in row 3 is not merely recorded as a MIG welder. Their MIG row is, by
default, related to arc welding as well — and the payer has to actively untick to exclude it.
The incorrect assignment propagates one hop further than the row it was written into.

**Engineering has no view on the remedy.** What it can say is that TD-07 was framed as a *gap* —
"there is no generic welding skill" — and the measured behaviour is not a gap but an **incorrect
specific assignment that already ships**. Those call for different decisions, and the register's
framing predates this measurement.

### 4.1 Every route, and the two that change the severity

A full sweep of the entry points, verified at the source rather than inferred. Three bridges
reach the id, not two — the third is the correct one:

| bridge | at | correct? |
|---|---|---|
| `skill_mig_welding → mskill_mig_welder` | `match-skills.ts:473` | **yes** — the worker said MIG |
| `role_welder → mskill_mig_welder` | `match-skills.ts:404` | no — the role is process-unspecific |
| `skill_welder_occupation → mskill_mig_welder` | `match-skills.ts:488` | no — **and this is the wide one** |

**The attribute bridge has no gate; the role bridge has four.** `_assign_welding_role`
(`signals.py:1663-1670`) refuses when a role is already set, when there is a machining signal,
when a blocker fires, or when no welding-domain skill id is present. `_detect_welding`
(`signals.py:1609-1621`) has none of that, and its gazetteer maps the bare word **`"welding"`**
to `skill_welder_occupation` (`lexicon_data/trades.json:349-350`).

**So an explicit denial still produces a MIG Welder row.** The repo already documents half of
this, in the gazetteer test's own "KNOWN, DELIBERATE LIMITATIONS":

> *Blockers suppress the welder ROLE only; welding SKILL ids are still recorded. A worker who
> says "welding nahi karta" keeps `skill_welder_occupation`.*
> — `tests/test_welding_gazetteer.py:52-54`

That was written when the consequence was a skill id. Through the ungated attribute bridge it is
now `mskill_mig_welder` on `worker_skill`, with the label **"MIG Welder"** shown to a payer. The
limitation was accepted at one severity and has since acquired another.

**The mainline interview path cannot produce the id at all** — and this narrows the live blast
radius sharply. `toExtractionOutput` hardcodes `canonical_role_id: null, skills: []`
(`profile-extraction.processor.ts:1613-1615`), deliberately: *"CANONICAL IDS ARE NOT INVENTED
HERE."* The only branch that can reach the bridges is the legacy `extractProfile` call at
`:701`, which fires only when `answerMap.length === 0` — a sessionless "make the profile anyway"
run, or a pre-cutover session. Everything else in the OIE path drops the signals first.

**Which means the platform asks the question and throws the answer away.** `qp_welding` has a
`welding_process` item with gas/arc/mig/tig options
(`packages/db/data/question-packs/packs/qp_welding.json:14-30`) — the exact question that would
resolve this — and its answer is `target_kind: "rfs"`, so it lands in free text and is discarded
by the hardcoded `skills: []` above. The schema does have a `target_kind: 'match_skill'` door
(`schema/question-pack.ts:298`), and **zero authored items use it.**

### 4.2 Every persisted field the id reaches

| field | write | human-visible? |
|---|---|---|
| `worker_skill.skill_id` (`source='derived_coarse'`) | `worker-skills.repository.ts:114-135`; batch `backfill-worker-skills.ts:190-208` | internal |
| `worker_skill.industry_id` | same | internal |
| `job_reach.matched_skill_id` | `worker-skills.repository.ts:216-234`, `:294-311`; `materialize-job-reach.ts:131,161` | feeds both surfaces below |
| feed card `matched_skill_label` → **"MIG Welder"** | `match-feed.service.ts:116` | **shown to the WORKER** |
| feed card `trade_key` → **the raw id** | `match-feed.service.ts:97` | **shown to the WORKER** — see below |
| payer candidate `matchedSkillLabel` → **"MIG Welder"** | `match-candidates.service.ts:92-93` | **shown to the PAYER** |
| `job_postings.match_skill_ids` / `reach_skill_ids` | `worker-skills.repository.ts:426-441` | payer picker |
| `feed.shown_v2` payload `matched_skill_id` | `match-feed.service.ts:128` | internal, permanent on the spine |

**Verified NOT to carry it** — this bounds the exposure, and the boundary is real:
`worker_profiles.skills` holds `skill_*` corpus ids and validates `mskill_*` out
(`taxonomy-corpus.ts:123-126`); `worker_profiles.canonical_role_id` holds `role_welder`, the
bridge *input*; `profiles.raw_profile` and `generated_resumes.source_profile_snapshot` store the
`DraftProfile`, which has no `mskill_*` field; and `buildResumeRenderInput` therefore cannot
render it — **the résumé and the masked employer disclosure never say "MIG Welder"**. No admin
surface reads `worker_skill` at all.

`MATCH_V1_ENABLED` is **default off** and gates only which source the feed / apply / candidate
list READ from. The write path runs regardless (`profile-extraction.processor.ts:455` is
explicitly not gated), so the rows accumulate now and become visible when the flag flips.

### 4.3 A separate defect found on the way, and it is not a taxonomy question

`match-feed.service.ts:97` sets `trade_key: row.matchedSkillId` — the **raw id**. The worker app
string-interpolates that field straight into a card subtitle
(`applied_jobs_screen.dart:181`, `'${job.tradeKey} · $place'`), on the stated assumption that
*"V1 feed postings carry no trade_key"* — which the API contradicts.

So with `MATCH_V1_ENABLED` on, a worker sees the literal string `mskill_mig_welder`. The label is
already on the same card as `matched_skill_label`, so nothing is missing — the two sides simply
disagree about what `trade_key` contains under V1. Raised as **#1027**; it crosses ownership, it
needs no taxonomy decision, and it should not wait on one.

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

---

## The pre-switch `unresolved_phrase` baseline — read now, so the post-switch count means something

The shadow report names this as a signal it structurally cannot produce: *"a production time
series, not a corpus property — needs the pre-switch count (read it now) compared against the
post-switch count."* Read-only against production, **2026-08-19**:

| scope | rows | occurrences | legacy `domain_id` | `job_domain_id` | earliest | latest |
|---|---|---|---|---|---|---|
| `occupation` | 14 | 14 | 0 | **0** | 2026-08-12 | **2026-08-19 10:29** |
| `skill` | 2 | 3 | 2 (both `cnc-machining`) | **0** | 2026-07-14 | 2026-07-14 |

All 16 rows are `status = 'open'`. Three things fall out of this table:

1. **`job_domain_id` is non-null on zero rows**, which is the correct pre-switch state and the
   thing the post-switch count is measured against. Any non-zero value after the flip is Path A
   miss volume, and there is now a producer that can create one (§1.1).
2. **The occupation arm is live and writing today.** The latest row is from this morning, after
   0078 landed — so the table, the write path, the v1 event and the widened unique index are all
   healthy in production. That is stronger evidence than a code read: the 0078 window had every
   `unresolved_phrase` write failing silently, and this is what recovery looks like.
3. **The skill arm has recorded nothing since 2026-07-14** — dormant by flag, not broken.
   `SKILL_CANONICALIZE_ENABLED=false`, so the pass does not run at all. The `skill`-scope
   baseline for the switch is therefore effectively **zero**, and any post-switch volume is new
   signal rather than a delta against a moving number.

The one row with `count = 2` (skill scope, 2 rows / 3 occurrences) is also the only direct
evidence in production that the `NULLS NOT DISTINCT` dedupe works on this table.
