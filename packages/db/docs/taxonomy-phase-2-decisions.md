# Taxonomy Phase 2 — decision record

**Scope:** the offline Domain→Skill generation harness and its quality gate
(`taxonomy-corpus.ts`, `taxonomy-lexical.ts`, `taxonomy-reuse-analysis.ts`,
`taxonomy-convergence.ts`, `taxonomy-quality-gate.ts`, `generate-domain-skills.ts`,
`seed-domain-skills.ts`).

**Status at the time of writing:** no data generated, no prompts emitted, no model called, no
ingest run, no seed run. This record exists so the first controlled 28-domain generation can
proceed against a gate whose limits are written down rather than rediscovered.

## Read this before "fixing" anything below

Five known weaknesses were **deliberately not fixed**. Each was found by adversarial review,
each was understood, and each was deferred by an explicit human decision. They are not
oversights and they are not TODOs waiting for a spare afternoon.

If you are about to change one of them, the bar is: **demonstrate that it blocks real
generated data**, not that it is theoretically imperfect. Several of the obvious "fixes" make
the gate strictly worse — lowering `MIN_TOKENS_FOR_SET_EQUALITY` and weakening
`strict_token_subset` both trade a detection gap for a false-accusation class, and a gate that
falsely accuses is one an operator learns to override.

The objective was never a theoretically perfect harness. It was a deterministic, auditable,
mutation-tested gate safe enough to run a first controlled 28-domain generation.

---

## FIXED BEFORE GENERATION

Each is covered by regression tests and verified by mutation — the test suite fails when the
fix is reverted.

| Area                                 | What it does                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Within-batch duplicate detection** | Two new skills minted in one run that mean the same thing. No shipped row is involved, so an against-catalogue check is structurally blind to it. Both ends are reported (`MISSED_REUSE_WITHIN_BATCH`, `WITHIN_BATCH:` evidence) so the reviewer picks the survivor.                                 |
| **Catalogue reuse detection**        | A new skill minted although a shipped equivalent existed. Distinguished from the above **structurally** — by whether the matched id is in `SKILL_CORPUS` — never by reading an evidence prefix.                                                                                                      |
| **Script-aware alias coherence**     | A Devanagari alias can never share a token with a Latin label. Treating that as concept divergence made every bilingual skill with two Hindi synonym families a confident `FALSE_REUSE` — while the prompt _requires_ Hindi aliases. Clustering is per script; genuine Latin divergence still fires. |
| **Reuse attribution**                | Authored skills own skill-level findings; edged skills own convergence findings. Collapsing them made a batch inherit the faults of every skill it pointed at, so correct reuse blocked and lazy synonym-minting passed.                                                                             |
| **Filesystem isolation**             | `--out` cannot target the corpus directory (`loadTaxonomyCorpus` globs `*.jsonl` there, so it would absorb unreviewed output with no commit and no reviewer). Stale `accepted-*.jsonl` is deleted from both the batch dir and `--out` on a BLOCK.                                                    |
| **Idempotent seeding**               | `buildClaimedSet` subtracts the seeder's own planned alias ids, so run 2 does not read run 1's winners as foreign claims and oscillate. The call site is pinned at source, because the bug lived in the caller, not the function.                                                                    |
| **Convergence enforcement**          | Five probe groups over 13 domain ids, every one re-checked against the corpus at runtime. A group naming an absent domain **blocks** rather than reporting a vacuous `ABSENT`.                                                                                                                       |
| **Mutation coverage**                | 21 mutations, 21 caught. Includes hardcoding the verdict to PASS, dropping a code from `BLOCKING_CODES`, disabling sibling detection, and letting a blocked batch still write `accepted-*.jsonl`.                                                                                                    |

Also fixed, from the same review: `severity` derived from policy rather than hand-typed;
`QUALITY_GATE_CODES` exhaustive by construction; committed records' problems no longer erased
by a colliding rejected candidate; one tokenizer instead of two; the `inherited` CHECK
violation in the edge upsert; `label_hi` no longer deleted by a re-seed; all three writes in
one transaction; `retag-skills.ts` carries the columns migration 0076 added.

---

## DEFERRED BY DESIGN

### 1. O(n²) analyzer

```
Finding:            analyzeReuse compares every decided skill against every other; runtime
                    grows ~n^2.3.
Current behavior:   Measured on the dev machine, real code path, synthetic corpus —
                      200 skills      49 ms      <- the 28-domain batch is 168-392 skills
                      400 skills      64 ms
                      1 000 skills   291 ms
                      2 000 skills  1 315 ms
                      4 000 skills  7 025 ms
Risk:               At the eventual 4 071-domain target (~40 000 skills) the projection is
                    ~200x the 4 000 figure, i.e. 20-25 minutes — paid on EVERY --ingest and
                    on every db:seed:domain-skills including the dry run, because the gate
                    analyses committed union candidates rather than the batch alone.
Why not fixed:      The 28-domain gate costs ~0.06 s. Optimising against a projection, before
                    any real generated data exists to profile, would redesign the hot path
                    using a synthetic distribution that the real corpus may not resemble.
Recommended decision: DEFER. Re-measure on the first real batch.
Impact if deferred: None at 28 domains. Revisit before any batch above ~2 000 skills.
```

**Measurable gate for the next reviewer:**

|                               |                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| current corpus size           | 0 skills committed; 168–392 projected for the 28-domain batch                                                                                          |
| current runtime               | ~0.06 s at that size                                                                                                                                   |
| target corpus size            | ~40 000 skills (4 071 domains × 6–14)                                                                                                                  |
| projected runtime             | 20–25 min, extrapolated at n^2.3 — **a projection, not a measurement**                                                                                 |
| acceptable batch-gate runtime | **≤ 60 s** (proposed). Above it, index the strong relations by `label_norm` / surface form and restrict the pairwise scan to token-sharing candidates. |

### 2. Inflectional duplicates

```
Finding:            "Boiler Operation" / "Boiler Operations" are not detected as equivalent.
Current behavior:   VERIFIED, not assumed — both are reported as POTENTIAL_AMBIGUITY,
                    ADVISORY, with WITHIN_BATCH:high_token_overlap evidence and both ends
                    named. They are surfaced as weak-band candidates, never silently treated
                    as canonical equivalence, and never blocked. Pinned by test.
Risk:               Plural drift is the single most likely real duplicate shape, and two rows
                    for one concept split it permanently once seeded.
Why not fixed:      The obvious fix is lowering MIN_TOKENS_FOR_SET_EQUALITY from 2 to 1. That
                    threshold is load-bearing: with the stoplist absorbing the second word,
                    "Boiler Operation" and "Boiler Cleaning" BOTH reduce to {boiler}, so a
                    size-1 set equality would confidently merge two genuinely different
                    skills. Trading a detection gap for a false-accusation class is a
                    downgrade.
Recommended decision: DEFER. The eventual fix is evidence-based normalization (comparing raw
                    label tokens under a morphological fold), not a threshold change.
Impact if deferred: A plural pair reaches the reviewer as an advisory finding naming both
                    ids. It is caught by a human reading the diff, not by the gate.
```

### 3. `strict_token_subset` on short labels

```
Finding:            "Torch Cutting" is a strong token-subset of "Underwater Torch Cutting",
                    so the pair blocks as MISSED_REUSE_WITHIN_BATCH and FRAGMENTED — but
                    underwater cutting is a separately hired, separately certified trade.
Current behavior:   Blocking. MAX_SUBSET_EXTRA_TOKENS = 2, absolute rather than relative.
Risk:               A false accusation on a genuinely distinct skill, with no override, forces
                    a human to either merge two real skills or edit the detector.
Why not fixed:      The same relation catches the fragmentation the harness exists to find:
                    "Fanuc CNC" vs "Fanuc CNC Control" is lexically identical in shape and
                    semantically the opposite case. Nothing lexical separates them, so
                    weakening the relation globally trades a real detection for this one
                    false positive. A relative cap does not help either — the failing example
                    is one extra token, not two.
Recommended decision: DEFER. When real generated data exposes actual false positives, add a
                    git-visible reviewed exception file carrying base skill / candidate skill
                    / reason / reviewer / date / decision. Do NOT build that mechanism for
                    hypothetical data, and do NOT weaken the global detector.
Impact if deferred: A legitimate specialisation pair blocks a batch and needs a human ruling.
                    Visible and loud, which is the safe direction.
```

**Real-data evidence — 2026-08-16, first controlled 28-domain run.** The deferral above was
written against a hypothetical (`Torch Cutting` / `Underwater Torch Cutting`). The relation has
now fired on actual generated output, and it was **right**:

```
Batch:              batch_2026-08-16T14-30-41Z  (28 domains, prompt v1)
Finding:            MISSED_REUSE_WITHIN_BATCH, both ends, BLOCKING
Pair:               skill_mixing_machine_operation  <->  skill_mortar_mixing
Evidence:           WITHIN_BATCH:strict_token_subset
Mechanism:          "mixing machine operation" reduces to the single informative token
                    {mixing} once the stoplist absorbs `machine` and `operation`, making it a
                    strict subset of {mortar, mixing}.
Adjudication:       TRUE POSITIVE. On a site these are one activity, and a reviewer merges
                    them. Neither id was shipped, so no against-catalogue check could have
                    seen the pair — this is the class within-batch detection exists for.
Outcome:            Batch blocked before any write. Remediated by removing
                    skill_mixing_machine_operation and keeping skill_mortar_mixing as the
                    canonical concept. Re-gated: PASS.
```

This is **evidence supporting the detector, not a reason to weaken it.** The first real
exercise of the sensitivity this deferral describes — a 3-word label collapsing to one
informative token — produced a correct block, not a false accusation. `MIN_TOKENS_FOR_SET_EQUALITY`,
the stoplist, and `MAX_SUBSET_EXTRA_TOKENS` are **unchanged**, and the bar for changing them is
unchanged too: a demonstrated false positive on real data. One correct block is the opposite of
that. The reviewed-exception file still does not exist and still should not be built until
something actually needs an exception.

### 4. Live-database taxonomy verifier

```
Finding:            There is no live-DB verifier for the taxonomy write, unlike
                    verify-job-domains.ts for the sibling relation. db:verify:taxonomy and
                    db:report:taxonomy both prove the FILES are coherent, never the database.
Current behavior:   The seeder's header claims "the DB half is covered by db:verify:taxonomy",
                    which is not true — that command explicitly has no DATABASE_URL.
Risk:               Nothing proves the database received what the corpus described. A partial
                    or stale apply is invisible.
Why not fixed:      The architecture is deliberately offline corpus -> validate -> quality
                    gate -> seed. A live verifier expands Phase 2 scope materially and needs
                    its own connection handling, CI wiring and fixture strategy.
Recommended decision: DEFER.
Impact if deferred: Acceptable at 28 domains, where the diff is human-reviewable. Mark as a
                    PREREQUISITE before the taxonomy pipeline is considered production-grade
                    at larger scale.
```

---

## BLOCKED ON FUTURE ARCHITECTURAL DECISION

### 5. Seeded-alias lifecycle

```
Finding:            A seeded alias that is later edited or removed never re-takes its
                    is_searchable claim. deterministicAliasId hashes the RAW text, so
                    correcting "Fanuc " to "Fanuc" mints a NEW id; the old row is still
                    is_searchable and is read as a foreign claim; the corrected alias is
                    written is_searchable=false, permanently. The typo stays retrievable and
                    the correction never does.
Current behavior:   Converges (it does not oscillate — that was a separate, fixed bug) but
                    converges to the STALE winner. Re-running never repairs it. Nothing is
                    deleted and nothing reports the drift.
Risk:               The corpus stops being the source of truth for retrieval. Correcting a
                    seeded alias currently requires hand-written SQL.
Why not fixed:      Answering "should it re-take the claim?" alone is not enough, and guessing
                    would bake in a policy. The seeder cannot safely distinguish its own
                    orphan from a legitimately-claiming shipped alias (both carry
                    source='rvm'), so any auto-demotion risks demoting a row it does not own.
Recommended decision: BLOCKED — requires a taxonomy lifecycle policy covering what happens to
                    an existing searchable alias when it is renamed, deprecated, merged,
                    split, manually edited, or marked non-searchable. That belongs to taxonomy
                    governance, not to the offline generator.
Impact if deferred: None before the first seed, because no alias exists to edit yet. It
                    becomes real the first time anyone corrects seeded vocabulary — so the
                    policy is needed before the corpus is treated as maintainable, not before
                    the 28-domain generation.
```

---

## Generation gates

Updated 2026-08-16, after the first controlled 28-domain run (Phase 3).

```
External generation: EXECUTED   — 28 domains, prompt v1 e43b9fcf…dc2a, session-based,
                                  no AIRouter call and no provider key in packages/db
Prompts:             EMITTED    — batch_2026-08-16T14-30-41Z/prompts.jsonl
Model:               CALLED     — outside this process; ₹0 metered spend, 0 provider tokens
Ingest attempt 1:    BLOCKED    — 3 blocking findings, nothing written
Ingest attempt 2:    PASS       — batch_2026-08-16T14-30-41Z-remediation, 0 findings
Corpus:              APPENDED   — 98 skills, 197 aliases, 238 edges over 28 domains
Seed:                see the Phase 3 record
```

The 4 071-domain corpus is **not** authorized off the back of this. The 28-domain run is a
sample, and deferral #1 (the O(n²) analyzer) has its own re-measurement gate before any batch
above ~2 000 skills.

CI verification is **not available** for this work — the three Phase 1/1.5/2 commits bypassed
branch protection and `ci-required`, and the follow-up sits on a branch. Every number in this
document is from a local run on a dev machine and must not be represented as CI-verified.
(PR #898 itself did run `ci-required` green before merge; that is the one exception, and it
covers the gate code, not the generated data.)
