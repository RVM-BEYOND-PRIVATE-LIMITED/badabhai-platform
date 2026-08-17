# Phase 8 — dependency findings before any taxonomy mutation

Addendum to [`phase-8-taxonomy-decisions.md`](./phase-8-taxonomy-decisions.md). Read-only
investigation; nothing applied, no provider call made.

The decision register recorded *what* each merge would touch inside `packages/db`. This records
what a repository-wide search found outside it, which changes who can execute the merges.

---

## 1. The domain-review answer sheet was never supplied

Verified against the session transcript rather than from memory: exactly one message contains
the alias-list markers (`M70`, `offset lagana`, "answer sheet", "review sheet", "trainer"), and
it is a report echoed back. No message contains a per-skill sheet.

What **was** supplied, and is authoritative, is the decisions message itself: TD-01…TD-07 and
the alias add/remove list. Both are recorded in the register.

What is therefore **unreconstructable**, and has not been invented:

- which 16 of the 26 dark skills are proposed `reviewed`
- the drafted paraphrases (all 52 slots remain empty, `pending_review`)
- the Hindi / transliteration decisions beyond the ten given explicitly in the alias list
- the per-skill competitor and domain decisions
- TD-01's split of `skill_cad_interpretation`'s four aliases between reading and CAD usage

`reviewed` requires draft **plus** trainer validation. Neither half is present, so **no case has
moved out of `pending_review`.**

---

## 2. The merges are not a `packages/db` change — they cross three ownership boundaries

Repo-wide search for the eight skill ids under decision, excluding generated batch data, docs
and `dist`:

| surface | owner (CLAUDE.md §5) | what references the ids |
|---|---|---|
| `packages/db`, `packages/taxonomy`, `packages/match-engine`, `packages/reach-engine`, `apps/api` | Backend Platform | corpus data, `match-skills.ts` skill→mskill map, `skill-corpus.ts`, `wedge-aliases.ts`, tests |
| `apps/ai-service/app/profiling/*` | AI (ai-engineer) | `signals.py`, `canonicalization_gold.py`, `miss_attribution.py`, `lexicon_data/skills.json` |
| `apps/worker-app/lib/core/util/taxonomy_labels.dart` | **Mobile Platform** | display labels for 6 of the 8 skills |

Three consequences:

**a. Backend must not edit the Flutter file.** §6 of the operating contract is explicit: complete
only the Backend work and raise a GitHub Issue for the Mobile change. A merge that lands without
it leaves the worker app rendering a label for a skill id that no longer exists.

**b. `canonicalization_gold.py` is a canonicalization GOLD SET** and it names
`skill_gdt_reading`, `skill_fixture_setup` and `skill_tool_offset_setting`. Merging any of them
silently changes the reference answers for the very capability these gates exist to protect. The
gold set must be updated deliberately, by its owner, in the same change.

**c. The profiling keyword table is order-dependent and its source of truth is Python.**
`packages/profiling-lexicon/src/internal/data.generated.ts` is generated from
`apps/ai-service/app/profiling/signals.py`, and its own comment says
*"ORDER IS LOAD-BEARING and must not be sorted: a generic term must never shadow a specific one.
`tool offset` precedes `offset`"*. TD-05 dissolves `skill_tool_offset_setting`, which is the
target of both of those keywords.

One piece of evidence runs *in favour* of TD-01: that same table already maps `gd&t`, `gdt` and
`drawing` to `skill_gdt_reading` under the label **"drawing reading"**. The lexicon has been
treating this skill as drawing-reading all along, which is what TD-01 proposes to make explicit.

---

## 3. Fanuc model aliases — no supporting evidence exists

The instruction was to inspect existing taxonomy/vendor evidence and add only explicitly
supported models. Every Fanuc reference in the repository is one of `fanuc`, `Fanuc`,
`Fanuc controller`, `skill_fanuc`, or prose naming Fanuc alongside Siemens and Mitsubishi.

**No Fanuc model number appears anywhere in the repository.** No alias can be added on this
evidence, and none has been. (`M70`, `M80`, `828D` and `840D` are likewise absent from the repo,
but those were supplied explicitly in the instruction, so they stand as new vocabulary rather
than as inventions.)

---

## 4. GP-04 re-measured under TD-03 — the repair survives

Recomputed rather than reused, because merging `skill_boring` into `skill_turning` widens the
exact competitor that took GP-04 in the first place.

`skill_boring` is **not** currently in `jd_nco_7223_6002`, so its alias is unreachable there
today and the merge would carry it in under its new owner. Its single alias scores **0.5307**
against the GP-04 query — rank 7, well below the incumbents.

```
 1. 0.7509  skill_coolant_management  "Coolant management" (proposed label)
 2. 0.7031  skill_turning             "CNC turning"
 3. 0.6661  skill_turning             "lathe operation"
 …
 7. 0.5307  skill_turning             "boring"  <- arrives via TD-03
```

| | |
|---|---|
| GP-04 correct after TD-03 | **yes** |
| winning score | **0.7509** — unchanged |
| margin over the 0.75 floor | **0.0009** |
| margin over `skill_turning` | **0.0477** |

TD-03 is safe for GP-04. The margin over the floor remains nine ten-thousandths, so this stays
the most fragile result in the corpus and must be re-measured again after any further change to
`skill_turning` or `skill_coolant_management`.

---

## 5. State

| item | state |
|---|---|
| TD-01, TD-02, TD-03 decided in principle | **AWAITING AUTHORIZATION** — cross-team execution plan needed first |
| TD-04, TD-05, TD-06 | **PENDING HUMAN REVIEW** — trainer/ops JD decision |
| TD-07 generic welding node | **PENDING HUMAN REVIEW** — gap, no node to create without a decision |
| TD-01 alias split | **BLOCKED** — input missing |
| 13 alias additions | **AWAITING AUTHORIZATION** — pre-checked, 1 held by TD-05 |
| Fanuc model aliases | **BLOCKED** — no supporting evidence |
| 2 alias demotions | **AWAITING AUTHORIZATION** |
| 84 → 81 canonical labels | **AWAITING AUTHORIZATION** — recompute after merges |
| 52 paraphrase slots | **PENDING HUMAN REVIEW** |
| Embedding / fresh evaluation | **BLOCKED** — provider daily quota exhausted |
| Promotion | **NOT AUTHORIZED** |
| Canonicalization | **NOT AUTHORIZED** — off |
| 4,071-domain generation | **NOT AUTHORIZED** |
