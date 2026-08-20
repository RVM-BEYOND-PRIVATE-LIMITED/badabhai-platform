# `cnc-programming` at S3-D — the decision package

> **2026-08-19.** One page, so the decision is answerable in a single read. Every number here
> is measured read-only against production, not forecast from the corpus. Nothing is chosen —
> the recommendation section states what engineering can and cannot say.
>
> Owner of the decision: **taxonomy / product**. Owner of this page: Backend Platform.

---

## The question in one paragraph

S3-D deprecates `skill_cad_interpretation` in favour of `skill_drawing_reading`, and the two
sit under **different legacy slugs** — `cnc-programming` and `cnc-machining`. The retag moves
`skill_cad_interpretation`'s aliases onto the terminal skill, and the terminal's slug travels
with them. So a caller scoped to `cnc-programming` loses every drawing-reading phrase and gains
nothing back. Options A, B and C are three ways of answering "does that matter?".

---

## What production holds right now

`db:verify:path-b-parity`, read-only, 2026-08-19 — **PASS** against the committed pre-S3
baseline, so these are live numbers and not a stale snapshot:

```
legacy slugs          = 10
Path B candidate rows = 76
overall digest        = d7f6cd4ec713ae52…

cnc-programming       candidates = 11   skills = 4   b98478d463fd…
```

A *candidate row* is what Path B's predicate actually returns:
`sa.domain_id = $1 AND s.status = 'active' AND sa.embedding IS NOT NULL`.

---

## The measured impact of each option

| | before S3-D | after S3-D (A, C) | after S3-D (B) |
|---|---|---|---|
| Path B candidate rows | **11** | **8** | 9 |
| distinct skills reachable | **4** | **3** | 3 or 4 (target-dependent) |
| alias rows carrying the slug | 14 | 10 (retag moves 4) | 11 |
| slug digest | `b98478d4…` | changes | changes, differently |

**The rows that leave** — all `skill_cad_interpretation`, `en`, embedded:
`02776ee2…` CAD · `0c6caf0d…` technical drawing · `580d7d5b…` read engineering drawings.

**`drawing padhna` (hi) is not one of them.** Its `embedding IS NULL`, so it was never a
candidate: Hindi drawing-reading is unserved under this slug **today**, before S3-D touches
anything. The retrievable loss is **3, not 4**.

**What survives** — 3 skills, 10 alias rows (8 embedded), none of them about reading a drawing:
`skill_cam_software`, `skill_cnc_programming`, `skill_program_editing`.

---

## The measurement that reframes the question

**No live caller can scope a query to `cnc-programming`.** Every production path that reaches
the canonicalizer hard-codes `cnc-machining` or supplies a `jd_*` id that nothing populates:

| caller | scope it sends | evidence |
|---|---|---|
| job posting create/update | `job_domain_id` if the posting has one, else the literal `"cnc-machining"` | [job-postings.service.ts:139-142](../../../apps/api/src/job-postings/job-postings.service.ts#L139-L142), anchor defined at [:45](../../../apps/api/src/job-postings/job-postings.service.ts#L45) — and **nothing writes `job_postings.job_domain_id`**: no DTO field, no backfill |
| `/profile/extract` canonicalize pass | `body.job_domain_id` if supplied, else `settings.skill_canonicalize_default_domain` | [profile.py:268-271](../../../apps/ai-service/app/routers/profile.py#L268-L271) — nothing populates the request field ([profile-extraction.processor.ts:701](../../../apps/api/src/profiles/profile-extraction.processor.ts#L701)) |
| `map_rich_to_legacy` backfill | the same default | [profile_extractor.py:653](../../../apps/ai-service/app/profiling/profile_extractor.py#L653) — and its own comment records that it "is not wired to any route today" |
| `POST /skills/canonicalize` | whatever the body carries | its only caller is row 1 |

`skill_canonicalize_default_domain` is `"cnc-machining"`
([config.py:389](../../../apps/ai-service/app/config.py#L389)) and **is not bridged into the
deploy at all** — it appears in neither the `envs:` list in `ci.yml` nor
`docker-compose.staging.yml`, so the container runs the code default. Verified, not assumed.

**So the loss is real in the data and unobservable in production traffic.** That does not make
it moot — it makes the question "when does a caller start scoping to `cnc-programming`?", which
is a roadmap question rather than a retrieval one.

---

## Option B's real cost

Not "one additive row", and this is where the option is most often mis-priced:

- **No shipped runner can write it.** Every `skill_alias` writer derives `domain_id` from the
  parent skill — `seed-skills.ts:182,204`, `retag-skills.ts:487`, `seed-domain-skills.ts:606`.
  A cross-slug row is currently **inexpressible**, and needs a new dedicated runner with its
  own manifest and rollback.
- **It works, mechanically.** Path B filters `sa.domain_id`, never `skill.domain_id`, and
  nothing downstream re-checks that the returned skill belongs to the requested slug — so a row
  carrying `domain_id='cnc-programming'` on a `cnc-machining` skill *is* returned. That is why
  the row has to be justified on taxonomy grounds rather than feasibility.
- **It needs an embedding to be retrievable at all**, and `db:embed:skills` has no per-row
  scope. One row plus one provider call, not one row.
- **The only semantically correct target does not exist in production until S3-A.**
  `skill_drawing_reading` is not there yet, so B is sequenced strictly after S3-A and
  at-or-after S3-D.
- **No precedent exists** in the repo for a cross-slug compatibility alias. B establishes a new
  data pattern rather than following one.

---

## The three options, costed

| option | what it does | cost to execute | cost to undo | what it leaves |
|---|---|---|---|---|
| **A — accept the loss** | nothing | none | n/a — the rows are recoverable from the S3-D rollback manifest | `cnc-programming` reaches 3 skills / 8 rows; drawing-reading unreachable under that slug until S10 |
| **B — cross-slug compatibility alias** | one `skill_alias` row on `skill_drawing_reading` carrying `domain_id='cnc-programming'` | a **new runner** (nothing shipped can express it) + one embed call + its own rollback | delete one row — but the pattern it establishes outlives it | `cnc-programming` keeps a drawing-reading route; a new cross-slug data pattern exists |
| **C — treat it as moot** | nothing, and stops tracking it | none | n/a | Only defensible if S10 is near. **Nobody has dated S10** — that is the whole weakness of C, and it is unchanged |

---

## What engineering can and cannot say

**Can say:**

- the loss is 3 retrievable rows and 1 skill, not 4 and not 1;
- Hindi is already unserved under this slug and S3-D does not change that;
- no production query has ever been scoped to `cnc-programming`, so A costs nothing
  *observable* today;
- B costs a new runner, not a row, and establishes a pattern with no precedent;
- A and C are byte-identical in the database and differ only in whether the gap stays tracked;
- rollback exists either way — `db:rollback:s3d` restores the pre-S3 alias homes from a
  captured manifest, and refuses to delete any row that existed at capture.

**Cannot say** — and these are the decision:

- whether a `cnc-programming`-scoped caller is on the roadmap, and when;
- whether "a CNC programmer should match drawing-reading phrases" is true as taxonomy, or an
  artifact of the pre-merge corpus splitting one competency across two slugs;
- whether S10 lands close enough for C to be honest.

---

## If the answer is B — the implementation, specified

Written out so choosing B is a decision rather than a research project. **Not built**: a runner
that can only ever be used under one unchosen option is speculative code, and every existing
alias writer would have to be taught a concept the taxonomy has not agreed to.

**Sequence.** 1. S3-A (so `skill_drawing_reading` exists in production) → 2. S3-D (so the retag
has run and the alias homes are final) → 3. the new runner → 4. `db:embed:skills` → 5.
`db:verify:path-b-parity`, committing the new baseline in the same PR so the next parity run
stays meaningful.

**Why a new runner and not a flag on an existing one.** `seed-skills.ts:182,204`,
`retag-skills.ts:487` and `seed-domain-skills.ts:606` each derive `domain_id` from the parent
skill. Teaching any of them to accept an override would put a cross-slug capability on three
paths that run routinely, to serve one row — the blast radius is the wrong shape. A dedicated
runner keeps the capability where the exception is.

**`db:add:compat-alias`, specified:**

| property | requirement |
|---|---|
| input | a committed manifest — `{skillId, text, lang, domainId, reason, decidedBy, decidedOn}` — never CLI-supplied ids, so the row's justification is reviewable in the diff |
| id | `deterministicAliasId(skillId, text, lang)` — the same function every other writer uses, so a re-run is a no-op rather than a duplicate |
| refusal 1 | refuse unless `skill.status = 'active'` for the target — a compat alias on a deprecated skill is a row that can never be reached |
| refusal 2 | refuse if `domainId` equals the parent skill's own slug — that is an ordinary alias and belongs to `seed-skills` |
| refusal 3 | refuse if the id already exists with a **different** `domain_id` — the cross-slug case must never silently re-home an existing row (the `retag-skills` data-loss lesson) |
| guard | `opsGuard({mutating: true})` — production writes need the flag plus `OPS_ALLOW_PRODUCTION` naming the script |
| dry run | default, printing the exact row and the `cnc-programming` digest before/after |
| rollback | delete by deterministic id, and only when the row's `domain_id` still matches the manifest |
| embedding | left NULL by the runner; `db:embed:skills` fills it. A row without one is inert, so the two steps are separable and the ordering is not load-bearing |

**The test that matters** is not that the row inserts — it is that Path B returns it: seed the
manifest row, run `pathBCandidates(corpus, "cnc-programming", …)`, and assert
`skill_drawing_reading` is among the candidates. That is the whole point of the option, and it
is the assertion that would catch the row being written correctly and still not working.

**What would make B unnecessary.** If a caller ever scopes by `job_domain_id` instead of the
legacy slug, Path A resolves `skill_drawing_reading` through `job_domain_skill` with no compat
row at all. B is a bridge for the legacy scope's remaining lifetime, and its cost should be
weighed against how long that is.
