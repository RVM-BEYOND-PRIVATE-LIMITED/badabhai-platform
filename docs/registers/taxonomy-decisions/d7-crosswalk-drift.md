# D-7 — deprecated-skill replacement state: code-vs-database drift, and what re-tagging would do

**2026-08-21 · main `80c9ddfd` · read-only · production mutation NONE · AI spend ₹0**

Reproduce: `pnpm db:seed:skills --plan` (non-mutating; `mutating: false` through `opsGuard`).
Static half: `pnpm --filter @badabhai/taxonomy test crosswalk-integrity`.

Evidence classes are marked throughout:
**MEASURED** production observation · **STATIC** repository inspection ·
**TESTED** automated assertion · **INFERRED** derived conclusion ·
**OWNER DECISION** · **BLOCKED**.

---

## 0. The original D-7 premise was right about production and stale about the corpus

D-7 read: *"`skill_cad_interpretation` and `skill_gdt_reading` are both `active` with 8 aliases
and 6 paid vectors between them and zero edges; neither carries `replaced_by`, so
`retag-skills.ts` will never reach them. Plus 3 edges pointing at `deprecated` skills."*

**MEASURED** — every number in that sentence still holds, and it undercounts:

| skill | status | `replaced_by` | aliases | embedded | edges |
|---|---|---|---:|---:|---:|
| `skill_gdt_reading` | **active** | **NULL** | 4 | 2 | **0** |
| `skill_cad_interpretation` | **active** | **NULL** | 4 | 4 | **0** |
| `skill_boring` | **active** | **NULL** | 1 | 1 | 1 |
| `skill_dimensional_inspection` | **active** | **NULL** | 3 | 3 | 2 |

8 aliases and 6 vectors across the two named skills — exactly as recorded. **But four skills
are affected, not two**, and 3 edges do point at deprecated skills (§3).

**STATIC** — the committed corpus disagrees with all four rows. `SKILL_CORPUS` marks each
`deprecated` with a `replacedBy`, all four targets exist and are `active`:

```
skill_gdt_reading            -> skill_drawing_reading
skill_cad_interpretation     -> skill_drawing_reading
skill_boring                 -> skill_turning
skill_dimensional_inspection -> skill_quality_control
```

**MEASURED** — `pnpm db:seed:skills --plan` states the drift exactly:

```
new skills            = 0
changed skills        = 4          status (active -> deprecated) x4
crosswalk pointers    = 4
WARNING: a status change is planned and --preserve-existing-status is NOT set.
```

**INFERRED** — the corpus was updated and never seeded. Not a defect in either artifact: the
seeder syncs `status`/`replaced_by` on conflict, so a deliberate run would close the gap. The
gap is that no run happened, and nothing signals that.

**INFERRED** — the consequence D-7 named is confirmed. `retag-skills.ts` selects
`WHERE status='deprecated' AND replaced_by IS NOT NULL`; none of these four matches, so the
re-tag cannot reach them. Their stored references stay on ids the corpus considers retired.

---

## 1. The finding D-7 did not contain: re-tagging can INVENT a match claim

**STATIC.** When a skill is re-tagged, every stored reference moves to the successor — so the
worker inherits the **successor's** bridge mapping. The impact analysis for such a decision
reliably asks whether a signal is *lost*. TD-03's does exactly that, for `skill_boring`:

> *"`ATTRIBUTE_TO_MATCH_SKILLS` already maps this to no master-skill — **no matching signal is
> lost**."*

True, and it answers only one direction. `skill_boring` maps to `[]`; `skill_turning` maps to
`["mskill_cnc_turner"]`. Nothing is lost — something is **created**.

> **A widening crosswalk does not lose a matching signal. It invents one.**

For BadaBhai that is the worse direction. Product principle #2 is *never show irrelevant
candidates for a job*: a loss narrows reach and shows up as a missing match, while a gain puts
a worker in front of an employer on a claim they never made. Boring is done on a machining
centre or a boring mill as readily as on a lathe — it is not evidence of turning competence,
which is exactly why the bridge maps it to `[]` on purpose.

### Both corpora, audited together — 6 crosswalks, 2 widening

**TESTED.** `SKILL_CORPUS` and the D2 growth corpus have zero id overlap, so the union is
well-defined:

| crosswalk | before | after | verdict |
|---|---|---|---|
| `skill_boring` → `skill_turning` | `[]` | `["mskill_cnc_turner"]` | **WIDENS** |
| `skill_chassis_fitting` → `skill_mechanical_assembly` | `[]` | `["mskill_fitter"]` | **WIDENS** |
| `skill_cad_interpretation` → `skill_drawing_reading` | `[]` | `[]` | safe |
| `skill_gdt_reading` → `skill_drawing_reading` | `[]` | `[]` | safe |
| `skill_dimensional_inspection` → `skill_quality_control` | `["mskill_quality_inspector"]` | same | safe |
| `skill_go_no_go_gauge_checking` → `skill_measuring_instruments` | `[]` | `[]` | safe |

**I found the second one only after correcting my own audit.** The first version ran over
`SKILL_CORPUS` alone and reported one widening crosswalk. `skill_chassis_fitting` is a
growth-corpus skill, so it was invisible to that scope — and it is the more urgent of the two.

---

## 2. The two are not equally urgent

**MEASURED** — production holds exactly two deprecated skills, both with pointers, both from
the growth corpus:

```
skill_chassis_fitting          deprecated -> skill_mechanical_assembly
skill_go_no_go_gauge_checking  deprecated -> skill_measuring_instruments
```

So `db:retag:skills` finds **2 rows today**, and one of them widens.

| crosswalk | state | why |
|---|---|---|
| `skill_chassis_fitting` → `mskill_fitter` | **LIVE** | production already `deprecated` + pointer; the next retag run acts on it |
| `skill_boring` → `mskill_cnc_turner` | **DORMANT** | deprecation exists only in the corpus; becomes live the moment `db:seed:skills` runs without `--preserve-existing-status` |

**INFERRED** — the sequencing hazard is the point. Seeding the corpus and then re-tagging would
arm the dormant one and fire both. Neither runner is wrong in isolation; the composition is
what needs a decision.

**STATIC** — `skill_chassis_fitting` is outside `SKILL_CORPUS`, so the bridge's exhaustiveness
test never asked about it. That is the same blind spot TASK 9B found for the 96 promotable
skills: the test's universe is `SKILL_CORPUS`, and a skill outside it is not unmapped-and-
failing, it is unexamined.

---

## 3. The 3 edges on deprecated skills

**MEASURED** — confirmed, and they belong to the two production-deprecated growth skills:

| domain | skill |
|---|---|
| `jd_nco_7231_0400` | `skill_chassis_fitting` |
| `jd_nco_7313_2601` | `skill_go_no_go_gauge_checking` |
| `jd_nco_7543_2001` | `skill_go_no_go_gauge_checking` |

**INFERRED** — these are inert for retrieval today: the live query filters `s.status='active'`,
so a deprecated skill yields nothing. They are authoring debt, not a serving defect.

**MEASURED** — production skill inventory: 111 provisional attribute, 34 active attribute,
18 active `match_skill`, 2 deprecated attribute.

---

## 4. What is tested now

**TESTED** — `auditCrosswalk` is a pure function over any corpus; two suites apply it:

- `packages/taxonomy/src/crosswalk-integrity.test.ts` (16) — the rules, plus the
  `SKILL_CORPUS` half, with its partial scope stated in the file.
- `packages/db/src/crosswalk-integrity-corpus.test.ts` (7) — the **union**, pinning
  `widening === ["skill_boring", "skill_chassis_fitting"]`.

The pin is deliberately two-way: a third widening crosswalk fails it, and so does fixing either
of these — in the commit that earns the change. It asserts the size of a known hazard, not that
the hazard must persist.

Also asserted: no dangling successor, no cycle, no dead end, no pointer on a non-deprecated
row, every chain one hop, and **nothing narrows** either.

---

## 5. Owner decisions

**Decision A — should `skill_boring` inherit `mskill_cnc_turner`?**
*Evidence:* the bridge maps boring to `[]` deliberately; TD-03 routes it to `skill_turning`,
which claims `mskill_cnc_turner`. The two decisions were made separately and never compared.
*Options:* (a) keep the crosswalk, accept the gain as intended; (b) re-point `skill_boring` at a
successor that maps to `[]`; (c) keep the crosswalk and drop `skill_turning`'s mapping —
**not recommended**, it would remove a legitimate claim from real turners.
*Recommendation:* **(b) or an explicit (a)** — the decision matters more than which way it goes.
*Risk if unaddressed:* dormant until a seed run, then silent.

**Decision B — should `skill_chassis_fitting` inherit `mskill_fitter`?**
*Same shape, and this one is LIVE.* Chassis fitting is mechanical assembly work, so `(a)` is
more defensible here than for boring — but it should be *decided*, not inherited from the fact
that nobody compared the two tables.
*Recommendation:* rule on it before the next `db:retag:skills` run.

**Decision C — seed the corpus deprecations to production?**
*Evidence:* 4 rows drift; the seeder warns that `--preserve-existing-status` is mandatory on
production precisely because the corpus deprecates rows production has active.
*Recommendation:* not until A and B are ruled on — seeding arms the dormant hazard.
*This is a production mutation and is not actioned here.*

---

## 6. Gates and scope

```
RESOLVABLE_ABOVE_FLOOR    FAIL — 62/96      unchanged
NO_REGRESSION             FAIL              unchanged
PROMOTION CANDIDATES      0                 unchanged
```

No skill status changed, no pointer written, no mapping edited, no seed or retag run, no
promotion, no floor or baseline touched. **AI spend ₹0.** The only production access was
`--plan` and read-only `SELECT`s.

**Not blocked.** The pooler was responsive for this task; both the static and database halves
completed. The `d5-junk-label-audit.json` owed from TASK 10 was delivered in the same window.
