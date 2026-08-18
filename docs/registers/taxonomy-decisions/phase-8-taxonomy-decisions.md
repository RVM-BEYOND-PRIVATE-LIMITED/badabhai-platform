# Phase 8 taxonomy decisions — DRAFT register

**Status: DRAFT, except TD-01, TD-02, TD-03, TD-04 and TD-06 (see below), which are RATIFIED
AND APPLIED.** No alias has been added or removed, no vector embedded, and every other entry
(TD-05, TD-07, §3's alias add/remove list, §4's canonical-label writes) remains exactly as it
was — nothing else has been applied.

**2026-08-18 (later still) — TD-04 and TD-06 ratified by Prakash (Backend Platform owner, TL)
directly, confirming the JD/line-inspector conditions the register asked for are satisfied.**
Both `skill_go_no_go_gauge_checking` (TD-04) and `skill_chassis_fitting` (TD-06) are
**provisional, never-promoted** skills that live only in the growth corpus
(`packages/db/data/taxonomy/skills.jsonl`), not in `SKILL_CORPUS` — a DIFFERENT mechanism from
TD-01/02/03, which all dissolved an *active, shipped* `SKILL_CORPUS` skill. See §9 for the full
application record, including why the TAX-9 `status: "deprecated"` + `replacedBy` pattern was
extended to the growth corpus itself rather than reused as-is, and why the `domain-skills.jsonl`
edges were (again) left unrepointed — for a stronger, mechanically-grounded reason than
precedent alone this time.

**2026-08-18 — TD-02 and TD-03 ratified by Prakash (Backend Platform owner, TL) for immediate
application, scoped to `packages/taxonomy` + `packages/db` only.** Applied as a corpus
`status: "deprecated"` + `replacedBy` pointer (ADR-0030 TAX-9 crosswalk — the codebase's
established non-destructive retire pattern: the row and its immutable `skill_id` are kept
forever per SG-5, nothing is deleted, and `pnpm db:retag:skills` is the separate, later,
explicitly-gated step that moves any *stored* worker/job-posting references and re-homes the
alias rows onto the terminal skill in a live database). At the time, TD-01 stayed exactly as
drafted below — its per-alias split of `skill_cad_interpretation` was still undecided and
nothing about it was touched. See §7 for exactly what shipped.

**2026-08-18 (later the same day) — TD-01 also ratified by Prakash (Backend Platform owner,
TL), directly, in a DIFFERENT SHAPE than drafted below.** The register's original TD-01 was a
*split*: "CAD software usage stays a separate skill", blocked on assigning each of
`skill_cad_interpretation`'s 4 aliases to a reading-vs-CAD-usage side. Prakash's direct
ratification supersedes that framing: **a FULL merge, not a split.** All 8 aliases of both
`skill_gdt_reading` and `skill_cad_interpretation` move to the new `skill_drawing_reading`, and
`skill_cad_interpretation` ceases to exist as an active skill — there is no surviving "CAD
software usage" skill from this decision. Applied the same way as TD-02/TD-03 (TAX-9
`status: "deprecated"` + `replacedBy`, plus the new skill itself). See §8 for exactly what
shipped, including the `match-skills.ts` and `wedge-aliases.ts` consequences this merge has
that TD-02/TD-03 did not (a brand-new `skill_id` requires a new `ATTRIBUTE_TO_MATCH_SKILLS`
entry, and one TAX-5 wedge alias had to move).

Every entry requires RVM trade-trainer / ops ratification before it becomes actionable. This
register exists so that ratification happens against measured impact rather than against a
description, and so the order of operations is fixed before anything is irreversible.

Impact figures are computed offline against the live corpus by
`packages/db/data/taxonomy/decisions/phase-8-decision-impact.json`. Zero provider calls.

---

## 1. Inputs that did NOT arrive

Recorded because the gap changes what can be finalized, and because inventing any of it would
be manufacturing exactly the ground truth this phase exists to avoid.

| missing | consequence |
|---|---|
| The domain-review answer sheet itself | The 16 skills said to be "marked reviewed" cannot be identified. No case has been moved to `reviewed`. |
| The drafted paraphrases | All 52 slots remain empty and `pending_review`. |
| "Appropriate Devanagari transliterations where specified in the review sheet" | Only the transliterations given explicitly in the instruction are recorded below. |
| "Appropriate Fanuc model aliases" | **Not recorded.** Controller model numbers are factual claims about hardware; Mitsubishi (`M70`, `M80`) and Siemens (`828D`, `840D`) were given explicitly, Fanuc's were not, and guessing them would put fabricated model numbers into a worker-facing taxonomy. |
| TD-01's per-alias split of `skill_cad_interpretation` | **SUPERSEDED 2026-08-18.** Which of its 4 aliases are *reading* and which are *CAD usage* was undecided — but Prakash's direct ratification changed the shape from a split to a FULL merge, so the split question no longer applies. See TD-01, §8. |

---

## 2. Taxonomy decisions

### TD-01 — `skill_gdt_reading` + `skill_cad_interpretation` → `skill_drawing_reading` · **RATIFIED AND APPLIED (2026-08-18)**

**Shape changed from the original draft, by direct owner ratification.** This entry originally
proposed a SPLIT — "CAD *software usage* stays a separate skill" — blocked on assigning each of
`skill_cad_interpretation`'s 4 aliases to a reading-vs-CAD-usage side. Prakash (Backend Platform
owner, TL) ratified a different, simpler shape directly, not via the missing reviewer sheet:
**a FULL merge, not a split.** All 8 aliases from both skills move to the new
`skill_drawing_reading`, and **`skill_cad_interpretation` ceases to exist as an active skill** —
there is no surviving "CAD software usage" skill from this decision.

- `skill_gdt_reading` — was active, 4 aliases (4 embedded), **8 domains**, 0 fixture cases
- `skill_cad_interpretation` — was active, **4 aliases** (3 in `skill-corpus.ts` + 1 TAX-5 wedge
  alias, `drawing padhna` — see §8's alias-count note, the same pattern TD-02 found for
  `skill_quality_control`), 6 domains, 0 fixture cases
- `skill_drawing_reading` — **created**: 7 aliases in `skill-corpus.ts` + the 1 moved wedge
  alias = 8 total, matching both predecessors combined with zero overlap/dedup needed (no two
  of the 8 alias texts collide, even across languages)

Historical alias-split table — **SUPERSEDED, kept for the record.** The ratified shape is a
full merge, so no alias was ever actually assigned a side; every alias below went to the same
place:

| alias | destination |
|---|---|
| `read engineering drawings` | `skill_drawing_reading` (full merge) |
| `drawing padhna` (hi) | `skill_drawing_reading` (full merge — wedge alias, repointed) |
| `technical drawing` | `skill_drawing_reading` (full merge) |
| `CAD` | `skill_drawing_reading` (full merge) |

Measured support for the merge: `"read engineering drawings"` (cad) and `"blueprint reading"`
(gdt) sit at cosine **0.7985**, and `"drawing padhna"` vs `"drawing reading"` likewise at
**0.7985** — among the closest cross-skill pairs in the corpus.

**Applied as:** see §8 for the full application record (new-skill shape, `match-skills.ts` and
`wedge-aliases.ts` consequences, and the verification run).

### TD-02 — `skill_dimensional_inspection` → `skill_quality_control` · **RATIFIED AND APPLIED (2026-08-18)**

- source: active, 3 aliases (3 embedded), 2 domains
- target: active, **3 aliases** (see the alias-count note below — 2 in `skill-corpus.ts` +
  1 TAX-5 wedge alias), 1 domain

⚠️ **Broke a fixture case — repaired in the same change.** `US-04` (`unembedded_shipped`)
named `skill_dimensional_inspection` as its expected skill. `packages/db/data/taxonomy/eval/
retrieval-v2.jsonl` (the mutable "current" fixture — `retrieval-v1.jsonl` is the immutable
Phase-5 baseline instrument and is SHA-256-hash-pinned by
`taxonomy-eval-fixture.test.ts`, never edited) is the SOURCE that was re-pointed: US-04 now
expects `skill_quality_control`, rescoped from `jd_nco_7543_2001` to `jd_nco_7313_2601` — the
only domain `skill_quality_control` is actually wired to in `domain-skills.jsonl`
(`skill_dimensional_inspection`'s old domain has no `skill_quality_control` edge, so keeping
the old domain would have failed `EXPECTED_SKILL_NOT_IN_SCOPE`). The correction is declared in
the v2 manifest's `corrections` array (same convention as the existing DC-18 entry), which is
what keeps `taxonomy-eval-fixture.test.ts`'s "changes EXACTLY the declared cases and nothing
else" invariant green. `phase-8-decision-impact.json` and the `EXP-P8-*`/`EXP-BASELINE`/
`EXP-EVAL-CORRECTION` experiment JSON files are measured/generated snapshots, not sources, and
were left untouched.

**Applied as:** `skill_dimensional_inspection` in `packages/taxonomy/src/skill-corpus.ts` is
now `status: "deprecated"`, `replacedBy: "skill_quality_control"`. The row, its id and its own
`aliases` array are unchanged (SG-5 — ids are never deleted or renamed); a live-DB alias/row
move is `pnpm db:retag:skills`, a separate later step this change does not perform.

Measured support: `"quality check"` (dimensional_inspection) vs `"quality check karna"`
(quality_control) at cosine **0.8219** — the second-closest cross-skill pair in the corpus.

### TD-03 — `skill_boring` → `skill_turning` · **RATIFIED AND APPLIED (2026-08-18)**

Conditional on no JD requiring a dedicated boring-machine operator — condition accepted as
satisfied by the ratifying owner; no such JD exists in the corpus (`skill_boring` carries 0
fixture cases and a single generic alias).

- `skill_boring` — active, **1 alias**, 1 domain, 0 fixture cases
- `skill_turning` — active, 5 aliases, 2 domains

Lowest-risk merge on the list. `packages/taxonomy/src/match-skills.ts:454` already maps
`skill_boring: []` (no master-skill signal), so nothing is lost from matching, and the
`ATTRIBUTE_TO_MATCH_SKILLS` map did not need to change — it stays EXHAUSTIVE over
`SKILL_CORPUS` by id regardless of status, and `skill_boring`'s entry is unchanged.

**Applied as:** `skill_boring` in `skill-corpus.ts` is now `status: "deprecated"`,
`replacedBy: "skill_turning"`, row/id/aliases otherwise unchanged — same TAX-9 pattern as TD-02.

`skill_turning` is the skill that took GP-04 from `skill_coolant_management`; widening it
slightly increases that pressure, so GP-04 was re-measured for this merge specifically — see §7.

### TD-04 — `skill_go_no_go_gauge_checking` → `skill_measuring_instruments` · **RATIFIED AND APPLIED (2026-08-18)**

Line-inspector / JD condition (accepted as satisfied by the ratifying owner).

- source: **provisional**, 2 aliases (2 embedded), 2 domains
- target: active, 6 aliases, 9 domains

Measured: `"गेज से जांच"` vs `"gauge"` at cosine **0.7933**. This interacts with the approved-
but-NOT-YET-applied removal of the bare alias `gauge` from `skill_measuring_instruments` — see
§3 (untouched by this change; still gated on its own, separate authorization).

**Applied as:** `skill_go_no_go_gauge_checking` in `packages/db/data/taxonomy/skills.jsonl` now
carries `"status": "deprecated", "replaced_by": "skill_measuring_instruments"` — a NEW,
growth-corpus-native form of the same TAX-9 crosswalk TD-01/02/03 used on `SKILL_CORPUS`. See
§9 for why this shape (not deletion, not a hand-edited batch artifact) and the full record.

### TD-05 — `skill_fixture_setup` + `skill_tool_offset_setting` → `skill_cnc_setup` · **DEFERRED**

Only if RVM JDs do not distinguish workholding setup from tool-offset setting.

- `skill_fixture_setup` — active, 5 aliases (5 embedded), 1 domain
- `skill_tool_offset_setting` — active, 2 aliases (2 embedded), 2 domains
- `skill_cnc_setup` — does not exist; requires creation

⚠️ **Blocks one approved alias addition**: `offset lagana → skill_tool_offset_setting` (§3)
attaches vocabulary to a skill this decision may dissolve.

### TD-06 — `skill_chassis_fitting` → `skill_mechanical_assembly` · **RATIFIED AND APPLIED (2026-08-18)**

Condition — "confirm whether automotive JDs specifically require chassis-fitting experience" —
accepted as satisfied by the ratifying owner.

- source: **provisional**, 2 aliases (2 embedded), 1 domain
- target: active, 2 aliases, 3 domains

**Applied as:** `skill_chassis_fitting` in `packages/db/data/taxonomy/skills.jsonl` now carries
`"status": "deprecated", "replaced_by": "skill_mechanical_assembly"` — same growth-corpus TAX-9
crosswalk as TD-04. See §9.

### TD-07 — generic welding node · **GAP, not a merge**

There is no generic welding skill. Recorded as a taxonomy gap.

**Bare `welding` must not be mapped to `skill_arc_welding`.** The corpus currently holds
`skill_arc_welding`, `skill_mig_welding`, `skill_tig_welding` and `skill_gas_cutting`, with
`SMAW` vs `GMAW` at cosine **0.8405** — the closest cross-skill pair measured. A worker who
says only "welding" has not told us which, and silently resolving to arc welding would put a
specific process on their profile that they may not do.

---

## 3. Alias changes — frozen list, pre-checked, NOT applied

All 13 additions were checked against every existing alias: **no collisions, no missing target
skills**. Both removals match exactly one row and leave the skill with other aliases.

### Add

| text | skill | pre-check |
|---|---|---|
| `CO2 welding` | `skill_mig_welding` | ok |
| `CO2 वेल्डिंग` | `skill_mig_welding` | ok |
| `patra` | `skill_sheet_metal` | ok |
| `पतरे का काम` | `skill_sheet_metal` | ok |
| `M70` | `skill_mitsubishi` | ok |
| `M80` | `skill_mitsubishi` | ok |
| `828D` | `skill_siemens` | ok |
| `840D` | `skill_siemens` | ok |
| `thread marna` | `skill_tapping_threading` | ok |
| `offset lagana` | `skill_tool_offset_setting` | ⚠️ **held — TD-05 may dissolve this skill** |
| `assembly ka kaam` | `skill_mechanical_assembly` | ok |
| `असेंबली` | `skill_mechanical_assembly` | ok |
| `hydraulic ka kaam` | `skill_hydraulics_pneumatics` | ok |

Fanuc model aliases: **omitted, not forgotten**. See §1.

### Remove / demote

| text | skill | effect |
|---|---|---|
| `fitting` | `skill_bench_fitting` | 1 row; 2 aliases remain. No fixture case queries this text. |
| `gauge` | `skill_measuring_instruments` | 1 row; 5 aliases remain. No fixture case queries this text. |

Both are the single-token hazard the label audit flags: a bare token matches far too broadly,
which is precisely how GP-04 was lost to `turning`.

Prefer `is_searchable = false` over `DELETE`. Demotion preserves the row, its id, and its
`embedded_at` provenance while removing it from the unique index and from retrieval —
additive-only, per the database standards, and reversible without a re-embed.

---

## 4. Interaction with the 84 audit-approved canonical labels

**3 of the 84 must be held back** until their decision resolves — ingesting the canonical label
of a skill that is about to be dissolved creates a row that then has to be migrated or deleted:

| label | skill | blocked by |
|---|---|---|
| `Chassis fitting` | `skill_chassis_fitting` | TD-06 |
| `Go no-go gauge checking` | `skill_go_no_go_gauge_checking` | TD-04 |
| `Tool offset setting` | `skill_tool_offset_setting` | TD-05 |

**Writable set: 84 → 81**, pending the deferred decisions.

**Update 2026-08-18 — TD-04 and TD-06 applied, so 2 of the 3 are now definitely moot,** the
same way TD-01 made `skill_cad_interpretation`'s and `skill_gdt_reading`'s labels moot: neither
`skill_go_no_go_gauge_checking` nor `skill_chassis_fitting` is a skill any canonical label
should ever be written for now (both `status: "deprecated"`, both refused by
`promote-skills.ts`'s `IS_PROVISIONAL` criterion by default — overridable only via an
explicit, recorded `--waive IS_PROVISIONAL`, the same fail-closed-but-overridable posture
already governing TD-01/02/03's deprecated `SKILL_CORPUS` rows — see §9). Their labels are not reassigned to `skill_measuring_instruments` /
`skill_mechanical_assembly` either — both targets already have their own entries in the 84 (or
don't; that recompute is still un-authorized, unchanged by this update). `skill_tool_offset_
setting`'s label stays conditionally moot, unchanged, still gated on TD-05. **Writable set is
unaffected by this update** — the 3 held-back labels are still held back, now for a permanent
reason instead of a pending one for 2 of them.

Three further labels already carrying a `REVIEW` verdict were also flagged as moot if their
merge proceeded: `skill_cad_interpretation` ("CAD / technical drawing interpretation"),
`skill_fixture_setup` ("Fixture / job setup"), `skill_gdt_reading` ("GD&T / drawing reading").
All three are compound labels, which is consistent with them naming skills that turned out to
be two skills. **Update 2026-08-18:** TD-01 applied, so two of the three — `skill_cad_
interpretation` and `skill_gdt_reading` — are now definitely moot (both `status: "deprecated"`;
their canonical label, if ever written, belongs to `skill_drawing_reading` instead, and that
recompute is still un-authorized — see §4's `84 → 81` note, itself unrevised by this change).
`skill_fixture_setup` stays conditionally moot, unchanged, still gated on TD-05.

---

## 5. Order of operations

Each arrow is a stop. The sequencing is not bureaucracy — TD-02 breaks a fixture case and TD-05
invalidates a queued alias, so running these concurrently would corrupt one with the other.

```
1  taxonomy freeze      TD-01..TD-07 ratified; TD-07 gap resolved
                        — PARTIAL 2026-08-18: TD-01 + TD-02 + TD-03 + TD-04 + TD-06 ratified
                        and applied (§7, §8, §9; TD-01 in a different shape than drafted — a
                        full merge, not a split; TD-04/TD-06 via a DIFFERENT mechanism than
                        TD-01/02/03, see §9). TD-05 and TD-07 remain exactly as drafted; the
                        "freeze" as a whole is still open.
2  fixture repair       US-04 re-pointed in the same change as TD-02 — DONE 2026-08-18 (§7).
                        No TD-01, TD-04 or TD-06 fixture case existed to repair — checked,
                        see §8, §9.
3  alias update         13 additions minus any blocked; 2 demotions        [STOP — authorization]
4  canonical labels     the 81, re-audited after the merges                [STOP — authorization]
5  embed                approved set only, Gate B safeguards + fresh Langfuse
6  trainer review       16 draft skills ratified; 52 slots authored
7  fixture v3           reviewed cases promoted out of pending_review
8  fresh evaluation     new experiment record; EXP-P8-* never overwritten
9  gates                NO_REGRESSION, RESOLVABLE_ABOVE_FLOOR
10 promotion review     separate decision
```

Steps 3–5 and 7–8 must not be combined into one measurement. An evaluation that moves the
taxonomy, the aliases and the fixture at once cannot attribute its own result.

---

## 6. Unchanged

Except for TD-01, TD-02 and TD-03's `status`/`replacedBy` corpus writes, TD-01's new-skill
creation (§7, §8), and TD-04/TD-06's growth-corpus `status`/`replaced_by` writes (§9),
**everything below still holds exactly as before**: `skill_canonicalize_enabled = false` ·
floor **0.75** · `NO_REGRESSION` enforced · no skill promoted (TD-04/TD-06 are now refused by
`promote-skills.ts`'s default criteria, which is different from "promoted" — a recorded
`--waive IS_PROVISIONAL` could still override it, same as any other deprecated row — see §9) ·
4,071-domain generation NOT
AUTHORIZED · the 33 provisional-skill aliases remain unembedded (TD-04/TD-06's own 4 aliases
included — dissolving a skill's status does not embed it) · `EXP-P8-BASELINE` and
`EXP-P8-CANONICAL-LABEL` untouched · TD-05 and TD-07 untouched · the §3 alias add/remove list
NOT applied · the §4 canonical-label writes NOT applied · no vector embedded · no live-database
row moved or created (`pnpm db:retag:skills` and `pnpm db:seed:domain-skills --apply` were not
run against any shared/remote database — seeding this corpus, including its two now-deprecated
rows, is a separate, later, explicitly-gated ops step).

The measured GP-04 repair sits at **0.7509**, nine ten-thousandths above the floor. The floor
does not move to accommodate it.

---

## 7. TD-02 / TD-03 application record (2026-08-18)

Scope: `packages/taxonomy/src/skill-corpus.ts`, `packages/db/data/taxonomy/eval/
retrieval-v2.jsonl`, this register. Nothing in `apps/ai-service`, `apps/worker-app`, or
`domain-skills.jsonl`'s edges was touched (see the ownership-boundary + Mobile/AI findings in
[`phase-8-dependency-findings.md`](./phase-8-dependency-findings.md), PR #933 — merged; its
cross-boundary findings for TD-01/TD-04/TD-05 do not implicate TD-02/TD-03, confirmed
independently by a repo-wide grep for both skill ids outside `packages/`).

**Corpus (`skill-corpus.ts`).** `skill_dimensional_inspection` and `skill_boring` moved to
`status: "deprecated"` with `replacedBy` set to their TD-02/TD-03 successor. This is the
codebase's existing TAX-9 crosswalk pattern (`retag-skills.ts`, migration 0039) — additive and
reversible: the row, its immutable `skill_id`, and its own `aliases` array are untouched, so
every existing FK (`job_domain_skill.skill_id`, any stored `worker_profiles.skills` /
`job_postings.skill_ids` entry) stays valid. `ATTRIBUTE_TO_MATCH_SKILLS` in `match-skills.ts`
was deliberately NOT edited: the map is asserted EXHAUSTIVE over `SKILL_CORPUS` **by id**,
independent of status, so both ids keep their existing (harmless — see TD-03 above) entries.
`domain-skills.jsonl`'s edges to the two deprecated ids (`jd_nco_7223_0701`→`skill_boring`,
`jd_nco_7313_2601`/`jd_nco_7543_2001`→`skill_dimensional_inspection`) were left as-is: they
remain structurally valid (deprecated ids are legal edge targets — `SHIPPED_SKILL_IDS`
includes them by design) and re-pointing them is a `job_domain_skill` decision the register
never authorized; it is a known follow-up, not a defect this change introduced.

**Alias-count discrepancy, resolved.** The register said `skill_quality_control` carries "3
aliases"; `skill-corpus.ts` shows only 2 (`QC`, `quality control`). The third is a TAX-5
vernacular alias in `packages/taxonomy/src/wedge-aliases.ts:79` —
`{ skillId: "skill_quality_control", alias: hi("quality check karna"), ratified: true }` —
seeded by the SAME `pnpm db:seed:skills` run (`seed-skills.ts` inserts both `SKILL_CORPUS`'s
own aliases AND `ratifiedWedgeAliases()` into `skill_alias`). `wedge-aliases.ts` is a real,
separate source of alias vocabulary, not a duplicate of `skill-corpus.ts` — confirmed by the
same pattern on `skill_turning` (3 `skill-corpus.ts` aliases + 2 wedge aliases, `kharad` /
`kharad ka kaam` = the register's stated 5). Neither `skill_boring` nor
`skill_dimensional_inspection` has a wedge alias, so this discrepancy does not affect TD-03.

**US-04 fixture repair.** See TD-02 above for the full mechanics. Verified live by running the
suite, not merely edited-and-assumed: `pnpm --filter @badabhai/db test` — 35 files, **846/846
passed**, including `taxonomy-eval-fixture.test.ts`'s 60 cases (the v1-hash-pin, the "changes
EXACTLY the declared cases" invariant, and "both versions still pass the ground-truth gate
against the real corpus" — which loads `retrieval-v1.jsonl` AND the edited `retrieval-v2.jsonl`
against the live `domain-skills.jsonl`/`skills.jsonl` corpus with `validateEvalFixture`, with
zero problems on both). `pnpm --filter @badabhai/db exec tsx src/taxonomy-corpus.ts`
(`db:verify:taxonomy`, file-only, no DB) also PASSes post-change: 98 skills, 238 edges, 0
problems.

**GP-04 re-verification (TD-03).** GP-04 (`jd_nco_7223_6002`, query "keeping the coolant level
right on the turning machine") is the corpus's most fragile passing case — `skill_turning` is
exactly the competitor TD-03 widens. No local Postgres or `ai-service` was reachable in this
session (`Test-NetConnection localhost:5432` → false), so the live `db:sweep:floor` /
`db:experiment:alias` re-embed could not be executed here; that gap is stated rather than
papered over. The best available evidence is PR #933
(`docs/taxonomy-phase-8-dependency-findings`, merged), which recomputed this exact
case against real provider vectors:

```
 1. 0.7509  skill_coolant_management  "Coolant management" (proposed label, not yet applied)
 2. 0.7031  skill_turning             "CNC turning"
 3. 0.6661  skill_turning             "lathe operation"
 …
 7. 0.5307  skill_turning             "boring"  <- arrives via TD-03
```

`skill_boring`'s one alias scores **0.5307** against the GP-04 query — rank 7, below both
`skill_turning`'s own incumbent alias (0.7031, TODAY's top-1) and the corrected
`skill_coolant_management` score (0.7509, a SEPARATE, NOT-applied simulated fix —
`EXP-P8-CANONICAL-LABEL` — not part of this change; see §6). Important to state plainly:
GP-04 is ALREADY WRONG today, before this change (top-1 = `skill_turning` "CNC turning" at
0.7031, expected `skill_coolant_management` — the pre-existing Gate-B regression documented in
`docs/operations/taxonomy-gp04-diagnosis.md`, Recall@1 0.9912). TD-03 does not fix that and was
never claimed to. What it must not do is make it WORSE, and it provably does not: retrieval's
top-1 is an argmax over per-candidate cosine scores against a FIXED query vector and UNCHANGED
existing vectors (`taxonomy-retrieval-eval.ts`'s `CANONICAL_RETRIEVAL_SQL`,
`taxonomy-alias-experiment.ts`'s `topSkill`) — adding one more candidate that scores below the
current winner (0.5307 < 0.7031) cannot change which existing candidate wins the argmax, and
cannot itself become a new false-positive top-1. Whether or not `EXP-P8-CANONICAL-LABEL` is
ever separately applied, `skill_boring`'s arrival stays below both the current wrong answer and
the simulated fixed one, at every point checked by PR #933. **No regression is introduced by
TD-03**; the pre-existing GP-04/coolant-management gap is unrelated to and unmoved by this
change, and remains exactly as fragile (0.0009 over the floor, in the simulated-fixed state) as
it already was.

**Not run in this session (infra-gated, not code-gated):** `pnpm db:sweep:floor --run`,
`pnpm db:eval:taxonomy --run` and `pnpm db:retag:skills` all require a live `DATABASE_URL` +
reachable `ai-service`; neither was available. `pnpm --filter @badabhai/taxonomy test`,
`pnpm --filter @badabhai/db test`, `pnpm --filter @badabhai/match-engine test`, and
`typecheck`/`build` for all three packages were run and are green (see above).

---

## 8. TD-01 application record (2026-08-18)

Scope: `packages/taxonomy/src/skill-corpus.ts`, `packages/taxonomy/src/match-skills.ts`,
`packages/taxonomy/src/wedge-aliases.ts`, `packages/taxonomy/src/wedge-aliases.test.ts` (one
hardcoded assertion pinned the old target id — see below), this register, and
`phase-8-execution-state.md`. Confirmed by grep that nothing in `apps/ai-service` or
`apps/worker-app` was touched — both are explicitly out of scope for this change (AI and
Mobile are executing their own halves of TD-01 in parallel, per
[`phase-8-dependency-findings.md`](./phase-8-dependency-findings.md) §2, which already
identified this as a three-ownership-boundary change and opened #935/#936 for it).

**Corpus (`skill-corpus.ts`).** `skill_gdt_reading` and `skill_cad_interpretation` both moved
to `status: "deprecated"`, `replacedBy: "skill_drawing_reading"` — same TAX-9 pattern as
TD-02/TD-03. `skill_gdt_reading` is one of the 9 LEGACY placeholder ids (`LEGACY_SKILL_IDS`,
`index.ts` `SKILLS`) and the "stays present/stable regardless of status" invariant was checked
live: `skill-corpus.test.ts`'s "preserves the 9 legacy placeholder skill_* ids" case is
unchanged and still passes (see the full run below) because that test only requires the id to
remain IN `SKILL_CORPUS`, never that it stay `active` — deprecation does not violate it. Both
rows, their immutable ids, and their own `aliases` arrays are untouched, so every existing FK
(`job_domain_skill.skill_id`; 8 edges on `skill_gdt_reading`, 6 on `skill_cad_interpretation`,
14 total, re-verified by grepping `domain-skills.jsonl` directly rather than trusting the
register's prior count) stays valid, left as-is per the TD-02/TD-03 precedent (re-pointing them
is a separate, un-authorized `job_domain_skill` decision).

**New skill, `skill_drawing_reading` — exact shape:**

```ts
{
  skillId: "skill_drawing_reading",
  labelEn: "Drawing reading (GD&T / technical drawing)",
  labelHi: null,
  domainId: "cnc-machining",
  source: "rvm",
  status: "active",
  aliases: [
    en("drawing reading", "rvm"),
    en("GD&T", "rvm"),
    en("geometric dimensioning and tolerancing", "esco"),
    en("blueprint reading", "onet"),
    en("CAD", "esco"),
    en("technical drawing", "esco"),
    en("read engineering drawings", "esco"),
  ],
}
```

Plus the 8th alias, the moved TAX-5 wedge alias (`wedge-aliases.ts`):
`{ skillId: "skill_drawing_reading", alias: hi("drawing padhna"), ratified: true }`.

- **`domainId: "cnc-machining"`** — follows `skill_gdt_reading`, not `skill_cad_interpretation`
  (`cnc-programming`). Chosen on measured weight, not a coin flip: `skill_gdt_reading` carries
  8 `job_domain_skill` edges to `skill_cad_interpretation`'s 6, and several of
  `skill_gdt_reading`'s edges are `default_requirement: "required"` at relevance ≥80 (e.g.
  `jd_nco_7543_2001` relevance 88, `jd_nco_7223_6003` relevance 86), where
  `skill_cad_interpretation`'s edges top out at `preferred`/relevance 70. `SkillSeed.domainId`
  is a single field (no array), so one had to be picked; `skill-corpus.ts`'s own convention for
  this decision (used nowhere else yet, since TD-02/TD-03 pointed at *existing* skills rather
  than minting new ones) does not prescribe an algorithm, so this is a judgment call, recorded
  as one.
- **`source: "rvm"`** — follows the file's OWN established convention for a first-party,
  RVM-curated skill whose alias vocabulary mixes pillars: every one of the other 7 "legacy
  placeholder" entries in this block (`skill_program_editing`, `skill_fanuc`, `skill_siemens`,
  `skill_mitsubishi`, `skill_measuring_instruments`, `skill_fixture_setup`,
  `skill_cam_software`, and `skill_gdt_reading` itself before this change) is `source: "rvm"`
  while carrying `onet`/`esco`-sourced aliases — the top-level `source` records who curated the
  CONCEPT, not where every alias's text came from. `skill_drawing_reading` is exactly this
  shape, so it follows the same rule rather than inventing a new one.
- **`labelEn`** combines both predecessors' labels ("GD&T / drawing reading" +
  "CAD / technical drawing interpretation") without dropping either concept.
- **Alias dedup: none needed.** All 8 alias texts (7 English + 1 Hindi) are distinct after
  normalization — verified by inspection, not merely asserted: no two of `drawing reading`,
  `GD&T`, `geometric dimensioning and tolerancing`, `blueprint reading`, `CAD`,
  `technical drawing`, `read engineering drawings`, `drawing padhna` collide.

**`match-skills.ts` — required a NEW key, unlike TD-02/TD-03.** TD-02/TD-03 dissolved existing
ids into existing successors, so `ATTRIBUTE_TO_MATCH_SKILLS`'s existing entries for both were
already correct and untouched. TD-01 **mints** a new corpus id, and the map's exhaustiveness
(`Object.keys(ATTRIBUTE_TO_MATCH_SKILLS).sort()` must equal `SKILL_CORPUS.map(id).sort()`,
`match-skills.test.ts`) is a runtime — not compile-time — invariant (the type is
`Record<string, readonly MatchSkillId[]>`, not `Record<SkillId, …>`). Measured, not assumed: the
key was temporarily removed and the suite re-run, producing exactly one failure —
`bridge — ATTRIBUTE_TO_MATCH_SKILLS > is EXHAUSTIVE over SKILL_CORPUS`, diffing in
`skill_drawing_reading` as the missing key — then the key was restored and the suite went green
again (46/46). Added as `skill_drawing_reading: []`, matching both predecessors' `[]`: reading a
drawing (GD&T or CAD) is a near-universal shop-floor attribute and does not, alone, claim a
programmer's or an inspector's chair — the same "empty is the point" reasoning the file already
states for `skill_gdt_reading` and `skill_cad_interpretation`.

**`wedge-aliases.ts` — one wedge alias moved.** `skill_cad_interpretation` (not
`skill_gdt_reading`) carries a TAX-5 vernacular alias: `hi("drawing padhna")`, RATIFIED 2026-07-16
under ruling Q-B. This is the source of the register's TD-01 alias-count ("4 aliases") not
matching `skill-corpus.ts`'s 3 — the same discrepancy shape TD-02 found and documented for
`skill_quality_control`'s "3rd alias". Repointed `skillId: "skill_cad_interpretation"` →
`skillId: "skill_drawing_reading"` on that entry, appended a note explaining the repoint without
erasing the original Q-B ratification text (SG-5-style: append, never silently rewrite a
ratification record). This broke a hardcoded assertion in `wedge-aliases.test.ts` —
`ratified.find(w => w.alias.text === "drawing padhna")?.skillId` was pinned to
`"skill_cad_interpretation"` — verified live (the test failed with `expected
'skill_drawing_reading' to be 'skill_cad_interpretation'` before the fix) and updated in the same
change.

**Fixture check — nothing to repoint.** Grepped `packages/db/data/taxonomy/eval/retrieval-v1.jsonl`
and `retrieval-v2.jsonl` for both source skill ids: zero matches in either file, so unlike TD-02's
US-04, TD-01 has no fixture case naming either predecessor and nothing needed correcting.

**`domain-skills.jsonl` edges — left as-is,** per the TD-02/TD-03 precedent: the 14 edges to the
two now-deprecated ids remain structurally legal (deprecated ids are legal edge targets by
design), and re-pointing them to `skill_drawing_reading` is a separate `job_domain_skill`
decision this register does not authorize.

**Cross-team boundary — confirmed, not crossed.** `phase-8-dependency-findings.md` §2 already
found this merge touches three owners: `apps/ai-service/app/profiling/{signals.py,
canonicalization_gold.py, miss_attribution.py}` + `lexicon_data/skills.json` (AI), and
`apps/worker-app/lib/core/util/taxonomy_labels.dart` (Mobile). Per this task's explicit
instruction and CLAUDE.md §6, neither was touched here; AI and Mobile are applying their own
halves of TD-01 in parallel, in the same working session. Issues #935 (AI) / #936 (Mobile),
opened for the TD-02/TD-03 cluster, already cover the `skill_gdt_reading` cluster's file list —
whether their scope needs a TD-01-specific update is a cross-team follow-up, not resolved here.

**Full verification run, this session:**

```
pnpm --filter @badabhai/taxonomy test    4 files, 46/46 passed   (was 45/46 before the
                                          wedge-aliases.test.ts fix — the one real failure,
                                          reproduced live, not hypothesized)
pnpm --filter @badabhai/db test          35 files, 846/846 passed   (same count as the
                                          TD-02/TD-03 baseline — no regression)
pnpm --filter @badabhai/match-engine test   9 files, 209/209 passed
pnpm --filter @badabhai/db exec tsx src/taxonomy-corpus.ts (db:verify:taxonomy)
                                          98 skills, 238 edges, 0 problems — PASS
                                          (unchanged from TD-02/TD-03: this validates the
                                          growth-corpus jsonl files, which do not reference
                                          skill_drawing_reading)
pnpm --filter @badabhai/taxonomy build + typecheck     clean
pnpm --filter @badabhai/db build + typecheck           clean
pnpm --filter @badabhai/match-engine build + typecheck clean
```

Mutation check on the new `ATTRIBUTE_TO_MATCH_SKILLS` key specifically (see above): removed,
observed the single expected failure, restored, observed green — the exhaustiveness gate is
real and would have caught a forgotten entry.

**Not run in this session (infra-gated, not code-gated, same as TD-02/TD-03):**
`pnpm db:sweep:floor --run`, `pnpm db:eval:taxonomy --run` and `pnpm db:retag:skills` all
require a live `DATABASE_URL` + reachable `ai-service`; neither was available. No embedding, no
retrieval re-measurement was performed for `skill_drawing_reading` specifically — it is
un-embedded until a future Gate-B-safeguarded embed run, same as any newly-minted skill.

---

## 9. TD-04 / TD-06 application record (2026-08-18) — a DIFFERENT mechanism from TD-01/02/03

**Why this is not "apply the TD-02/TD-03 pattern again."** TD-01/02/03 all dissolved an
*active, shipped* `packages/taxonomy/src/skill-corpus.ts` (`SKILL_CORPUS`) skill — a row a
worker or a job posting could already have a stored reference to. TD-04's source
(`skill_go_no_go_gauge_checking`) and TD-06's source (`skill_chassis_fitting`) are neither:
both live ONLY in the growth corpus (`packages/db/data/taxonomy/skills.jsonl`), confirmed by
grep to be absent from `skill-corpus.ts` entirely, and both are **provisional** — per Phase 7
Gate A, `SkillsRepository.canonicalAliasRows` only ever returns `status = 'active'` rows
(`PRODUCTION_SKILL_STATUSES = ["active"]`, `taxonomy-retrieval-eval.ts`), so a provisional
skill has never been retrievable, never been canonicalized to, and cannot have a stored
worker-profile or job-posting reference. Re-applying TD-02/TD-03's exact recipe unmodified
("edit the corpus id's `status` field in `skill-corpus.ts`") is not even available here —
`taxonomy-corpus.ts`'s own header states **`SKILL_CORPUS` DOES NOT GROW**, in capitals, as a
deliberate design boundary (new canonical skills live in the JSONL growth corpus specifically
so they never need a hand-authored `match-skills.ts` bridge entry). Minting these two ids into
`SKILL_CORPUS` purely to borrow its deprecation mechanism would violate that boundary for no
reason — they were never promoted, so there is nothing "shipped" about them to record there.

**Options considered, and why each losing one lost:**

1. **Delete the two `skill` lines from `skills.jsonl` outright.** Rejected. `loadTaxonomyCorpus`
   accumulates every `*.jsonl` file in the directory into one corpus and `SKILL_ID_DUPLICATE`
   fires on any second record with the same `skill_id` ANYWHERE in it — which is what actually
   protects a growth-corpus id from being re-minted for a different concept by a future batch
   (SG-5: "`skill_id` is immutable and never reused"). Delete the line and that protection is
   gone: a future generation batch proposing a JD-derived skill labelled "Chassis fitting"
   again (`taxonomySkillIdFor` is a pure function of the label, so it re-derives the exact same
   id) would sail through as a brand-new `CORRECT_NEW` candidate, silently re-litigating a
   question this decision already answered.
2. **Re-point the `domain-skills.jsonl` edges to the successor and THEN delete the source skill
   record** (the task's own suggested reconsideration). Rejected, for a mechanical reason, not
   merely "TD-01/02/03 didn't do it": `validateTaxonomyCorpus`'s `SKILL_ORPHAN` check requires
   every corpus-declared skill to carry at least one `domain_skill` edge, and it is not a soft
   warning — `resolveTaxonomyCorpus` (the seeder's gate) and `db:verify:taxonomy` both treat
   ANY problem as a hard failure. Re-pointing the 3 edges away from a skill record we keep would
   orphan it and break `db:verify:taxonomy` for the WHOLE 98-skill corpus, not just these two
   rows. Combining re-pointing with deletion avoids the orphan but reintroduces option 1's
   id-reuse gap. There is no combination of "re-point" + "keep the record" that passes the
   corpus's own validator.
3. **Hand-edit `batches/batch_2026-08-16T14-30-41Z-remediation/accepted-skills.jsonl`** to drop
   both entries from the promotion candidate pool (`promote-skills.ts --batch <dir>` scopes
   `GATE_ACCEPTED` to exactly that file). Rejected. That file is the committed record of what a
   SPECIFIC quality-gate run (dedup/convergence checks — a different axis of judgment) accepted,
   and it is factually still correct: both ids ARE well-formed, non-duplicate, non-fragmenting
   skills by that gate's own criteria. TD-04/TD-06 are a JD-relevance call the quality gate never
   measures. Editing the batch artifact after the fact would misattribute a later human business
   decision as if it were an earlier quality-gate failure, and this repo's own convention for
   correcting a batch is a NEW, clearly-labelled batch/remediation directory (see
   `batch_2026-08-16T14-30-41Z` → `batch_2026-08-16T14-30-41Z-remediation` itself), never an
   in-place edit of a committed one.
4. **A new `promote-skills.ts` hard-coded exclusion list** (e.g. `WITHDRAWN_SKILL_IDS`, checked
   before `GATE_ACCEPTED`). Considered and set aside — not wrong, but unnecessary once (5) below
   makes the EXISTING `IS_PROVISIONAL` criterion do the job with zero new runner code, and a
   parallel exclusion mechanism living beside the criteria it would duplicate is exactly the
   kind of thing this file's own docstring warns against ("a second copy... is the copy that
   drifts").
5. **Extend the growth corpus with its OWN `status`/`replaced_by` fields, written through by
   `seed-domain-skills.ts` instead of `seed-skills.ts`.** Chosen. `skill.status` and
   `skill.replaced_by` are real, general `skill` table columns (migration 0039's TAX-9
   crosswalk, `skill_replaced_by_chk`) — nothing about them is specific to which SEEDER writes
   them. `promote-skills.ts`'s `IS_PROVISIONAL` criterion already refuses to promote a
   `deprecated` row ("promoting a deprecated one would resurrect something a human retired") —
   that logic is untouched, because it does not need to be. The only real gaps were (a)
   `TaxonomySkillRecord` (the `skills.jsonl` schema) had no `status`/`replaced_by` fields at
   all, and (b) `seed-domain-skills.ts` hard-coded `status: "provisional" as const` on every
   INSERT. Both are now closed:
   - `TaxonomySkillRecord` gained two optional fields, `status?: "deprecated"` and
     `replaced_by?: string`, with `validateTaxonomyCorpus` enforcing: `status`, if present, must
     be exactly `"deprecated"` (`SKILL_STATUS_INVALID` — promotion to `active` is
     `promote-skills.ts`'s job, never a corpus author's); `replaced_by` requires
     `status: "deprecated"` and vice versa is NOT required (`SKILL_REPLACED_BY_WITHOUT_STATUS`;
     a deprecated-with-no-successor row is legal per `skill.ts`'s own comment, "retired, nothing
     to re-tag to"); `replaced_by` must resolve to a SHIPPED `SKILL_CORPUS` id, never another
     corpus-authored draft (`SKILL_REPLACED_BY_UNKNOWN`) — this seeder inserts every corpus
     skill in one pass with no ordering guarantee between two draft rows, so only an
     already-guaranteed-to-exist shipped id is a safe target; and neither field may combine
     with `reuses_existing: true` (`SKILL_STATUS_ON_REUSE`) — a reuse record never gets its own
     `skill` row, so a lifecycle override on it is meaningless.
   - `seed-domain-skills.ts`'s `PlannedSkillRow`/`planSkillRows` now carry `status`/`replacedBy`
     through (defaulting to `"provisional"`/`null` exactly as before when the fields are
     absent), the `skill` INSERT writes them instead of the old hardcoded literal, and
     `shippedDependencies` was extended to also treat a deprecated draft's shipped `replaced_by`
     as a precondition dependency (belt-and-braces: both TD-04's and TD-06's targets already
     have `domain-skills.jsonl` edges that independently trigger the same precondition today,
     but the new general capability must not silently rely on that coincidence for the next
     skill that uses it without one).
   - Once seeded, a future `db:promote:skills --batch batches/batch_2026-08-16T14-30-41Z-
     remediation --apply` run against these two ids would report `IS_PROVISIONAL: status =
     deprecated` and refuse — the SAME code path, unmodified, that already refuses a deprecated
     `SKILL_CORPUS` row. No new runner logic, no exclusion list to keep in sync, no reliance on
     Gate B never having embedded them (which was the previous, accidental, non-durable reason
     they could not be promoted TODAY).

**`skills.jsonl` — exact change.** Both lines keep their `label_en`, `label_hi` and `aliases`
untouched (SG-5: an id's own row is never rewritten, only annotated) and gain two fields:

```json
{"kind":"skill","skill_id":"skill_chassis_fitting", ... ,"status":"deprecated","replaced_by":"skill_mechanical_assembly"}
{"kind":"skill","skill_id":"skill_go_no_go_gauge_checking", ... ,"status":"deprecated","replaced_by":"skill_measuring_instruments"}
```

**`domain-skills.jsonl` edges — left exactly as-is, reconsidered and reaffirmed, not merely
copied from precedent.** The three edges (`jd_nco_7231_0400`→`skill_chassis_fitting`,
`jd_nco_7313_2601`/`jd_nco_7543_2001`→`skill_go_no_go_gauge_checking`) still point at the
now-deprecated source ids. The task explicitly asked this to be reconsidered rather than
defaulted, because the TD-01/02/03 reasoning ("no stored-reference risk to protect") does not
by itself argue AGAINST re-pointing the way it argued against re-pointing a formerly-active
skill. Reconsidered on two independent grounds:
  - **Mechanical:** re-pointing requires either orphaning the (kept) source record — a hard
    `db:verify:taxonomy` failure — or deleting it, which reopens the SG-5 id-reuse gap (option 2
    above). There is no way to re-point that passes the corpus's own validator without a cost
    this decision was not asked to pay.
  - **Reachability is unchanged either way.** `PRODUCTION_SKILL_STATUSES = ["active"]` excludes
    BOTH `provisional` (today) and `deprecated` (after this change) from
    `SkillsRepository.canonicalAliasRows`. The edge was already functionally inert before this
    change (a provisional skill's own aliases have never been embedded or retrievable) and stays
    exactly as inert after it — dissolution does not make anything newly unreachable that was
    reachable a moment ago. Re-pointing to the ALREADY-ACTIVE successor would be the only way to
    make the requirement reachable at all, but doing so is a `job_domain_skill` edge-ownership
    decision this register was not asked to authorize (same boundary TD-01/02/03 drew), and here
    it is additionally blocked by the mechanical point above unless the source record is also
    deleted — which this decision explicitly rejected. Re-pointing `job_domain_skill` edges for
    these three rows is therefore a known, named follow-up, not a defect this change introduced,
    exactly like TD-01/02/03's edges.

**Canonical labels.** §4 updated: `Chassis fitting` / `Go no-go gauge checking` move from
"blocked, pending TD-06/TD-04" to "moot" — the same disposition TD-01 gave `skill_cad_
interpretation` / `skill_gdt_reading`. Neither label is written for the successor either; that
recompute stays un-authorized.

**Fixture check — nothing to repoint.** Grepped `packages/db/data/taxonomy/eval/retrieval-v1.jsonl`
and `retrieval-v2.jsonl` for both ids: zero matches in either file — no fixture case named
either predecessor, so unlike TD-02's US-04, nothing needed correcting.

**Cross-team boundary — confirmed, not crossed.** Grepped `apps/ai-service` and
`apps/worker-app` for both skill ids: zero references in either tree, confirmed independently
of the register's own prior claim to the same effect. This change is `packages/db` +
`docs/registers` only; no companion AI or Mobile PR is needed for TD-04/TD-06.

**Full verification run, this session:**

```
pnpm --filter @badabhai/db build                       clean
pnpm --filter @badabhai/db typecheck                    clean
pnpm --filter @badabhai/db test                         36 files, 897/897 passed
                                                          (was 846 at the TD-02/TD-03 baseline;
                                                          +13 of the delta is THIS change — 9 new
                                                          cases in taxonomy-corpus.test.ts, 4 in
                                                          seed-domain-skills.test.ts, file count
                                                          unchanged for both — the remaining +38
                                                          predates this session, from unrelated
                                                          work landed on main since the TD-02/
                                                          TD-03 baseline was recorded)
pnpm --filter @badabhai/db exec tsx src/taxonomy-corpus.ts (db:verify:taxonomy)
                                                          98 skills, 238 edges, 0 problems — PASS
                                                          (unchanged counts: only metadata was
                                                          added to 2 existing skill lines)
pnpm --filter @badabhai/taxonomy test                    4 files, 46/46 passed — unchanged
                                                          (skill-corpus.ts was NOT touched;
                                                          TD-04/TD-06 never lived there)
pnpm --filter @badabhai/match-engine test                9 files, 209/209 passed — unchanged
```

Mutation check on the new `SKILL_REPLACED_BY_UNKNOWN` guard specifically: the check was
disabled in place (`if (false)` in place of the real condition), the suite re-run, and it
produced EXACTLY the two expected failures (the two tests that assert this code fires) with
every other test — including the 60 unrelated cases in the same file — still green; the check
was then restored and the suite re-run clean. The guard is real, not vacuous.

**Not run in this session (infra-gated, not code-gated, same as every prior TD):**
`pnpm db:seed:domain-skills --apply` (would create the two `skill` rows as `deprecated` for the
first time), `pnpm db:sweep:floor --run`, `pnpm db:eval:taxonomy --run` and
`pnpm db:retag:skills` all require a live `DATABASE_URL` (the seed also needs `skill_measuring_
instruments`/`skill_mechanical_assembly` already present via `pnpm db:seed:skills`, an existing,
unrelated precondition); none was available. No live-database row was created, moved, or
deprecated by this change — it is corpus-file-only, exactly like TD-01/02/03's own file-only
scope.
