# `job_domain_alias` → `skill_alias` coverage — investigation and reconciliation

> **Read-only.** Nothing here mutated production. Every statement carries a `file:line` or the
> SQL that produced it, run inside a `SET TRANSACTION READ ONLY` transaction against the
> production cluster on 2026-08-21.
>
> **Classification: DATA COVERAGE / ARCHITECTURE QUESTION — not a blocker.**

---

## 0. The answer, up front

**No. The 9,121 `job_domain_alias` rows are not supposed to acquire `skill_alias` counterparts,
and building them would be the wrong work — in two documented cases it would be actively
harmful.** The two tables hold two different vocabularies that meet only through the edge table
`job_domain_skill`.

Three corrections to the premise, in order of importance:

1. **`job_domain_alias` is 9,121 rows in production, not "4,000+".** 4,035 is the
   `is_searchable = false` subset; 4,021 is the searchable NCO subset. The retrieval surface is
   **5,086**.
2. **They are not one vocabulary at two granularities.** `job_domain_alias` holds *occupations*
   ("Admiral", "darji", "बढ़ई", "jcb", "कुली"); `skill_alias` holds *units of work*
   ("bead check", "conduit bending", "first piece check", "kharad"). ADR-0030 states the split
   in one line: *"occupation-classification standards code **jobs**, not **what a person can
   do**."* Measured: **0 of 8,762** distinct `job_domain_alias.text_norm` values appear among the
   197 distinct `skill_alias.text_norm` values.
3. **The real coverage gap is `job_domain_skill`, and it is far larger than the one you found.**
   **3,857 of 3,885** selectable-active domains (**99.28 %**) have zero skill edges. The live
   Path A query can return a candidate for only **19 of 3,885** (**0.49 %**).

One thing the premise gets *right in spirit but wrong in target*: the 5,086 searchable domain
aliases are **not** inert. They drive the interview today — question-pack selection, question
predicates, the worker's `trade` answer of record, and the `occupation_label` echoed back in chat
(§6.3). What they do not reach is the job feed, and they are severed from it **two layers above**
`job_domain_skill` (§6.3b).

And the finding that outranks all three:

> **The bridge's skill vocabulary and the live matching engine's skill vocabulary are disjoint id
> spaces with zero overlap.** All 236 `job_domain_skill` edges point at `kind='attribute'`
> skills (130 `skill_*` ids). The feed matches on `kind='match_skill'` (18 `mskill_*` ids).
> `SELECT count(*) FROM job_domain_skill WHERE skill_id LIKE 'mskill\_%'` → **0**. All 18
> `mskill_*` rows have **zero aliases** and **zero edges**. The only join between the two id
> spaces is `ATTRIBUTE_TO_MATCH_SKILLS` — a hand-authored TypeScript constant
> ([match-skills.ts:436](../../../packages/taxonomy/src/match-skills.ts#L436)) that never
> consults the database.
>
> **Filling `job_domain_skill` to 100 % would still emit ids that nothing downstream reads.**

---

## 1. Semantic purpose of each object — in the repository's own words

| object | what it is | citation |
|---|---|---|
| `job_domain` | The **occupation catalogue** — 4,071 published ISCO-08 + NCO-2015 rows. Exists to answer *"which trade WE SUPPORT is this worker in"*; "13 hardcoded roles cannot express a cook, a tailor, a driver, or a warehouse picker". Levels 1–3 are navigation buckets, and `job_domain_selectable_leaf_chk` enforces that "a bucket is not an occupation". | [occupation.ts:24-33](../../../packages/db/src/schema/occupation.ts#L24-L33), [:205-208](../../../packages/db/src/schema/occupation.ts#L205-L208) |
| `job_domain_alias` | **The ways a worker says their occupation.** Official title, the standards' "occupations classified here" examples, and Hinglish/vernacular forms — "kharad operator", "silai wala". Aliases carry the vectors, not the canonical label, because "the official title … is the one phrasing nobody uses". This is the L0/L1/L2/L3 **search surface** for occupation identification. | [occupation.ts:227-235](../../../packages/db/src/schema/occupation.ts#L227-L235) |
| `skill` | The **closed, immutable unit-of-work vocabulary** (ADR-0030 / TAX-1). `skill_id` is a text PK, never reused. Bimodal since ADR-0036: `kind='match_skill'` (the closed `mskill_*` set — the only thing that may ever be matched on) vs `kind='attribute'` (controls, machines, certifications — "shown on a profile, NEVER matched"). | [skill.ts:62-77](../../../packages/db/src/schema/skill.ts#L62-L77), [match-skills.ts:6-13](../../../packages/taxonomy/src/match-skills.ts#L6-L13) |
| `skill_alias` | **The ways a worker says a unit of work.** Label variants, spellings, Hinglish/regional forms. Its `is_searchable` carries only **one** of the three jobs the same column does on the domain side — duplicate election — because "skills have no bucket rows and no ISCO shadowing". | [skill.ts:151-153](../../../packages/db/src/schema/skill.ts#L151-L153), [:174-179](../../../packages/db/src/schema/skill.ts#L174-L179) |
| `job_domain_skill` | **The edge between the two vocabularies** — "the taxonomy: what this trade normally needs". Materialised offline; read at runtime as `WHERE job_domain_id = $1 AND status='active'`. Its content is precisely what an NCO definition lacks: "an NCO definition names TASKS, not the controls, machines and certifications a shop floor hires on." | [taxonomy.ts:4-10](../../../packages/db/src/schema/taxonomy.ts#L4-L10), [:39-41](../../../packages/db/src/schema/taxonomy.ts#L39-L41), [generate-domain-skills.ts:4-8](../../../packages/db/src/generate-domain-skills.ts#L4-L8) |

```
 job_domain  ──<  job_domain_skill  >──  skill
     │             (the ONLY bridge)       │
 job_domain_alias                     skill_alias
 "what a worker calls                 "what a worker calls
  their TRADE"                         a UNIT OF WORK"
```

The two alias tables are **leaves of two different branches**. Neither is upstream of the other.

---

## 2. Are they the same vocabulary? — No, and the record says so five ways

### 2.1 The ADRs draw the line explicitly

- **ADR-0028 OQ#1** — "**NCO-2015/ISCO-08 classify *occupations*, not skills.** The current
  `skill_*` / `mach_*` ids … **have no direct ISCO home.** … must be resolved before Phase 2
  canonicalizes skills."
- **ADR-0030 Context** — "ADR-0028 gave workers and jobs a shared **occupation** id space … but
  explicitly stopped at **skills**: **occupation-classification standards code *jobs*, not *what
  a person can do*.**"
- **ADR-0030 Amends** — "**occupations stay ADR-0028's job; skills get their own
  standard-backed, embedding-canonicalized id space.**"
- **ADR-0030's four pillars** name ESCO as "the skills skeleton … **ESCO explicitly separates
  skills from occupations**."
- **ADR-0036 §Skill vs Attribute** adds a third axis: V1's "Skill" is *role-level* (CNC Turner);
  the ADR-0030 corpus is *operation-level* (turning, GD&T) — which V1 calls an **Attribute**,
  "shown on the card, never matched, never ranked."

### 2.2 The decisive sentence — one phrase, two vocabularies, two different repairs

[`schema/skill.ts:283-286`](../../../packages/db/src/schema/skill.ts#L283-L286):

> "The two scopes must NOT share rows: **"fitter" is an unresolved SKILL and an unresolved
> OCCUPATION at the same time, with different follow-up work — one becomes a `skill_alias`, the
> other a `job_domain_alias`.** Merging them would let a resolved skill silently close an open
> occupation gap."

A CHECK enforces the split (`unresolved_phrase_one_domain_chk`). The two growth runners are
separate for the same reason —
[`growth-occupation.ts:12-21`](../../../packages/db/src/growth-occupation.ts#L12-L21):
"an unresolved SKILL is usually a near-miss on a skill we already have — the vector is what finds
the neighbour. **An unresolved OCCUPATION is the opposite situation by construction.**"

### 2.3 "Two tables, one concept" means one **lifecycle**, not one vocabulary

`phase-9-unified-alias-architecture.md:51` is the sentence that most plausibly reads the other
way. It does not:

1. The document's own title — "**one lifecycle** for job-domain and skill aliases".
2. §3 names the concept: `raw ▶ normalized ▶ elected ▶ embedded ▶ retrievable`.
3. §4 builds "a single engine **parameterized by table**, not two runners", with *different*
   per-table eligibility rules.
4. The shipped engine repeats it verbatim —
   [`alias-lifecycle.ts:99-135`](../../../packages/db/src/alias-lifecycle.ts#L99-L135):
   `JOB_DOMAIN_ALIAS_SPEC.parentEligible = selectable && active` plus the ISCO shadow rule;
   `SKILL_ALIAS_SPEC.parentShadowed = () => false` — "**EXPLICIT NO-OP, STATED RATHER THAN
   OMITTED.** `skill` has no parent/child hierarchy."

Nothing anywhere proposes merging the tables' contents or treating one as a coarser view of the
other. §4 even preserves their separate legacy columns: "`skill_alias.domain_id` reads | retire;
**column stays**".

### 2.4 There is **no documented intent** to derive `skill_alias` from `job_domain_alias`

Searched `docs/` and `packages/db/src` for every phrasing of the idea — `derive .{0,30}skill_alias`,
`skill_alias .{0,30}from .{0,30}job_domain_alias`, `domain alias.{0,40}(into|becomes|seed).{0,30}skill`.
**Zero hits.** The only lines naming both tables together are four *comparison* tables and one
engine type signature, all contrasting them.

### 2.5 The data agrees — and two matches would be actively harmful

```sql
SELECT (SELECT count(DISTINCT text_norm) FROM job_domain_alias) AS jda,   -- 8762
       (SELECT count(DISTINCT text_norm) FROM skill_alias)      AS sa,    -- 197
       (SELECT count(*) FROM (SELECT DISTINCT text_norm FROM skill_alias
                              INTERSECT
                              SELECT DISTINCT text_norm FROM job_domain_alias) x) AS shared; -- 0
```

**Normalized overlap: 0.** Falling back to raw lowercased text gives **19 rows / 18 distinct
strings = 0.21 % of 9,121**, and *all 19 land on the 139 un-normalized legacy skill-alias rows*.
Every one is explicable:

| shared string | why it is in both |
|---|---|
| `welder` `carpenter` `fitter` `plumber` `machinist` `designer` `interior designer` `sewer` `machine tool operator` | **Occupation nouns that leaked into `skill_alias`.** Production holds 7 `skill_*_occupation` rows, all `kind='attribute'`; the master plan already flags three as "active skills with NO active edge" (`phase-9-master-plan.md:107`). A recorded defect, not the design. |
| `kharad` `ghisai` | Wedge terms deliberately seeded into both registers |
| `arc welding` `mig welding` `tig welding` `cnc turning` `pipe fitting` | Techniques named identically as an occupation-alias and as a skill |

**Two of the 19 are genuine false friends — and they are the argument against ever doing this
mapping mechanically:**

| domain alias | its occupation | would map to | actual meaning |
|---|---|---|---|
| `threading` on `jd_nco_5142_0200` | **Manicurist** | `skill_tapping_threading` | eyebrow threading ≠ cutting a screw thread |
| `sewer` on `jd_isco_7533` | **Sewing, Embroidery and Related Workers** | `skill_drainage_systems` | one who sews ≠ a sewer pipe |

A pipeline that turned domain aliases into skill aliases would put *drainage-system work* on a
seamstress's profile. This is not hypothetical — the strings already collide in the live tables.

---

## 3. The coverage report

**The honest denominator is 5,086** (`is_searchable = true`). The ANN index is *partial*
(`WHERE is_searchable`, [occupation.ts:310-313](../../../packages/db/src/schema/occupation.ts#L310-L313)),
so a non-searchable row cannot be returned by L0/L2/L3 at all; counting it flatters coverage by
~44 %. 9,121 is honest for exactly two claims: corpus size and embedding spend. Both are given.

### 3.1 The whole table, decomposed

| # | bucket | n (all) | % of 9,121 | n (searchable) | % of 5,086 |
|---|---|---|---|---|---|
| 1 | **TOTAL `job_domain_alias`** | **9,121** | 100 % | **5,086** | 100 % |
| 2a | `text_norm` **=** `skill_alias.text_norm` | **0** | **0 %** | **0** | **0 %** |
| 2b | matches `lower(btrim(skill_alias.text))` (legacy fallback) | 19 | 0.21 % | 14 | 0.28 % |
| 2c | …of which land only on the 139 un-normalized legacy rows | 19 | 0.21 % | 14 | 0.28 % |
| 3 | parent domain has ≥1 **active** `job_domain_skill` edge | 127 | 1.39 % | **82** | **1.61 %** |
| 3b | parent domain answerable by the **live** Path A query | — | — | **56** | **1.10 %** |
| 4 | parent not selectable / not active (bucket rows) | **0** | 0 % | 0 | 0 % |
| 5 | `is_searchable = false` | **4,035** | 44.24 % | — | — |
| 5a | ⠀reason (a) parent ineligible | 0 | 0 % | — | — |
| 5b | ⠀reason (b) ISCO unit shadowed by selectable NCO children | 3,989 | 43.73 % | — | — |
| 5c | ⠀reason (c) duplicate-election loser | 70 | 0.77 % | — | — |
| 5d | ⠀in more than one reason | 24 | 0.26 % | — | — |
| 5e | ⠀non-searchable with **no** reason (anomaly) | **0** | 0 % | — | — |
| 5f | ⠀searchable **despite** a disqualifying reason (anomaly) | **0** | 0 % | — | — |
| 6 | `text_norm` occurring under more than one domain | 562 | 6.16 % | 331 | 6.51 % |
| 7a | occupation-shaped — narrow role tokens | 4,055 | 44.46 % | 2,021 | 39.74 % |
| 7b | ⠀+ glued suffixes (`…smith/…keeper/…maker/…man`) | 4,592 | 50.35 % | 2,399 | 47.17 % |
| 7c | ⠀+ *wala*-family particle on raw `text` | 4,598 | 50.41 % | 2,405 | 47.29 % |
| 7d | ⠀broad agent noun (`-er/-or/-ist/-man`) | 6,993 | 76.67 % | 3,807 | **74.85 %** |
| 7e | ⠀**residual** (none of 7a–7d) | 1,249 | 13.69 % | 827 | 16.26 % |
| 8 | **UNRESOLVED** — searchable ∧ unbridged ∧ no lexical match | 8,981 | 98.47 % | **4,996** | **98.23 %** |
| 9 | invalid/stale — `text_norm` NULL · `embedding` NULL · wrong model · deprecated parent | **0 · 0 · 0 · 0** | 0 % | 0 | 0 % |

`3,989 + 70 − 24 = 4,035` — the non-searchable decomposition reconciles exactly against the
shipped recompute predicate
([normalize-job-domain-aliases.ts:82-110](../../../packages/db/src/normalize-job-domain-aliases.ts#L82-L110)).
70 duplicate groups, 140 rows, max group size 2 — exactly the "70 alias pairs" the schema comment
predicts at [occupation.ts:266-268](../../../packages/db/src/schema/occupation.ts#L266-L268).

**Coverage as a percentage — the headline numbers:**

| question | answer |
|---|---|
| domain aliases with any skill representation | **0.21 %** (19 / 9,121) — and 0 % on normalized text |
| searchable domain aliases with **any** path to a skill | **1.77 %** (90 / 5,086) |
| searchable domain aliases whose domain is bridged | **1.61 %** (82 / 5,086) |
| searchable domain aliases the live query can answer for | **1.10 %** (56 / 5,086) |
| selectable-active domains with any skill edge | **0.72 %** (28 / 3,885) |
| selectable-active domains the live query can answer for | **0.49 %** (19 / 3,885) |
| **UNRESOLVED share of the retrieval surface** | **98.23 %** |

### 3.2 The corpus is thin exactly where the product lives

| level | domains | with exactly 1 alias | of which the alias **is** `label_en` | % single-alias |
|---|---|---|---|---|
| ISCO L4 selectable | 436 | 0 | — | 0 % |
| **NCO L5 selectable** | **3,449** | **2,911** | **2,899** | **84.4 %** |

**For 84.1 % of the leaf catalogue the "vernacular alias overlay" does not exist** — the embedded
text is the official NCO title, which [occupation.ts:232-234](../../../packages/db/src/schema/occupation.ts#L232-L234)
itself calls "the one phrasing nobody uses". The whole `rvm` overlay is **426 rows over 102
domains — 2.96 % of the 3,449 leaves**, and only **142 of 9,121** aliases (1.6 %) are Hindi.

Meanwhile the ISCO side carries 4,644 aliases over 436 units (avg 10.7) — and reason (b)
shadowing then removes 370 of those units from retrieval. **The alias mass is concentrated
precisely where it is subsequently discarded.**

### 3.3 Quality defects visible in the corpus

- **96 of 4,071 `job_domain` rows have a non-title `label_en`** (18 end with `:`, 78 start
  lowercase). All 96 are `selectable` + `active` and they carry **206 searchable alias rows
  (4.05 % of 5,086)**. Examples: `label_en = "ISCO 08 Unit Group Details:"` on 12 distinct NCO L5
  domains; `"Qualification Pack Details:"` on 4; `jd_nco_8155_0201` =
  `"skins or hides and keeps them near machine; spreads skin or hide with hair"` — **and a live
  worker is currently matched to that last one.**
- The two largest cross-domain `text_norm` collisions are that same scrape residue —
  `isco 08 unit group details` under **12** domains, `qualification pack details` under 4, all
  searchable.
- 272 normalized strings (3.10 % of 8,762) map to more than one domain, dragging in 562 rows.
  Only 45 of those collisions survive inside the retrieval surface (105 rows, 2.06 %) — ISCO
  shadowing incidentally kills most cross-domain ambiguity.

---

## 4. Top 50 representative unresolved `job_domain_alias` values

Definition: `is_searchable = true`, parent domain has **no** `job_domain_skill` edge, and the text
matches **no** `skill_alias`. Population: **4,996 rows across 3,490 domains.** One row per domain
(the raw ordering degenerates — it returns 20 consecutive `jd_isco_0110` armed-forces ranks),
richest-alias domains first.

```sql
WITH unresolved AS (
  SELECT a.* FROM job_domain_alias a
  WHERE a.is_searchable
    AND NOT EXISTS (SELECT 1 FROM job_domain_skill s WHERE s.job_domain_id = a.job_domain_id)
    AND NOT EXISTS (SELECT 1 FROM skill_alias sa
                     WHERE sa.text_norm = a.text_norm
                        OR lower(btrim(sa.text)) = a.text_norm)),
one_per_domain AS (SELECT DISTINCT ON (job_domain_id) * FROM unresolved
                    ORDER BY job_domain_id, length(text) ASC, text ASC)
SELECT text, text_norm, job_domain_id, label_en, source, level, domain_alias_count
FROM one_per_domain JOIN job_domain USING (job_domain_id)
ORDER BY domain_alias_count DESC, text ASC LIMIT 50;
```

| # | alias | domain | occupation | src | aliases |
|---|---|---|---|---|---|
| 1 | Admiral | `jd_isco_0110` | Commissioned Armed Forces Officers | isco | 61 |
| 2 | Airman | `jd_isco_0310` | Armed Forces Occupations, Other Ranks | isco | 43 |
| 3 | Publisher | `jd_isco_1349` | Professional Services Managers NEC | isco | 33 |
| 4 | Zookeeper | `jd_isco_5164` | Pet Groomers and Animal Care Workers | isco | 28 |
| 5 | Hospital matron | `jd_isco_1342` | Health Service Managers | isco | 27 |
| 6 | Store Cashier | `jd_isco_5230` | Cashiers and Ticket Clerks | isco | 27 |
| 7 | Lifeguard | `jd_isco_5419` | Protective Services Workers NEC | isco | 22 |
| 8 | Manager, aged care | `jd_isco_1343` | Aged Care Service Managers | isco | 22 |
| 9 | Survey interviewer | `jd_isco_4227` | Survey and Market Research Interviewers | isco | 22 |
| 10 | Sergeant major | `jd_isco_0210` | Non-commissioned Armed Forces Officers | isco | 20 |
| 11 | Manager, crèche | `jd_isco_1341` | Child Care Service Managers | isco | 19 |
| 12 | Camp site manager | `jd_isco_1439` | Services Managers NEC | isco | 18 |
| 13 | Manager, social work | `jd_isco_1344` | Social Welfare Managers | isco | 18 |
| 14 | Ayah, hospital | `jd_isco_5321` | Health Care Assistants | isco | 16 |
| 15 | **फ्रिज** | `jd_nco_7127_0100` | Mechanic, Refrigeration and Air Conditioning | rvm | 16 |
| 16 | Trawler manager | `jd_isco_1312` | Aquaculture and Fisheries Production Managers | isco | 15 |
| 17 | **खेती** | `jd_nco_6111_0100` | Cultivator, General | rvm | 13 |
| 18 | **bai** | `jd_nco_5152_0100` | House Keeper (Domestic) | rvm | 12 |
| 19 | Club host | `jd_isco_5169` | Personal Services Workers NEC | isco | 12 |
| 20 | **Darban** | `jd_nco_5414_0501` | Gateman / Unarmed Security Guard | nco | 12 |
| 21 | Dental secretary | `jd_isco_3344` | Medical Secretaries | isco | 12 |
| 22 | Invigilator | `jd_isco_5312` | Teachers' Aides | isco | 12 |
| 23 | **juta** | `jd_nco_7536_0300` | Shoe Repairer / Cobbler / Shoemaker | rvm | 12 |
| 24 | **कुली** | `jd_nco_9333_0100` | Loader and Unloader | rvm | 12 |
| 25 | **khana** | `jd_nco_5120_0200` | Cook, Institutional | rvm | 11 |
| 26 | Valet | `jd_isco_5162` | Companions and Valets | isco | 11 |
| 27 | **चिनाई** | `jd_nco_7112_0200` | Bricklayer, Construction | rvm | 11 |
| 28 | **मेकअप** | `jd_nco_5142_0100` | Beautician | rvm | 11 |
| 29 | **सफाई** | `jd_nco_9112_0200` | Cleaner, Hospital | rvm | 11 |
| 30 | Salad bar attendant | `jd_isco_5246` | Food Service Counter Attendants | isco | 10 |
| 31 | **कालीन** | `jd_nco_7318_0300` | Carpet Weaver | rvm | 10 |
| 32 | **बैरा** | `jd_nco_5131_0300` | Bearer, Domestic / Household Workers | rvm | 10 |
| 33 | Clerk, ward | `jd_isco_4229` | Client Information Workers NEC | isco | 9 |
| 34 | **darji** | `jd_nco_7531_0100` | Tailor, General | rvm | 9 |
| 35 | **electronics** | `jd_nco_7421_0100` | Electronics Fitter, General | rvm | 9 |
| 36 | Grocer | `jd_isco_5221` | Shopkeepers | isco | 9 |
| 37 | Herbalist | `jd_isco_3230` | Traditional & Complementary Medicine Assoc. Prof. | isco | 9 |
| 38 | **jcb** | `jd_nco_8342_0301` | Scrapper Loader Operator / Loader Operator | rvm | 9 |
| 39 | **petrol pamp** | `jd_nco_5245_0101` | Petrol Pump Salesman / Fuel Dispensing Attendant | rvm | 9 |
| 40 | **putai** | `jd_nco_7131_0100` | Painter, Building | rvm | 9 |
| 41 | **ट्रक** | `jd_nco_8332_0100` | Driver, Truck | rvm | 9 |
| 42 | **बेकर** | `jd_nco_7512_0100` | Baker (Baking Products) | rvm | 9 |
| 43 | Filing clerk | `jd_isco_4415` | Filing and Copying Clerks | isco | 8 |
| 44 | **gaadi** | `jd_nco_8322_0100` | Driver, Car | rvm | 8 |
| 45 | Wage inspector | `jd_isco_3359` | Government Regulatory Assoc. Prof. NEC | isco | 8 |
| 46 | **बढ़ई** | `jd_nco_7115_0100` | Carpenter, General | rvm | 8 |
| 47 | **dukan** | `jd_nco_5223_0100` | Shop Assistant | rvm | 7 |
| 48 | Flesher, Machine | `jd_nco_8155_0201` | *(junk label — see §3.3)* | nco | 7 |
| 49 | **lainman** | `jd_nco_7413_0100` | Lineman, Light and Power | rvm | 7 |
| 50 | **machine silai** | `jd_nco_8153_0101` | Sewing Machine Operator, General | rvm | 7 |

**Read the list.** Every entry is an **occupation noun** — a job someone holds. Not one is a unit
of work. Making `skill_alias` rows out of "Admiral", "Zookeeper", "darji", "बढ़ई", "jcb" or
"कुली" would put *"I am a carpenter"* into the table that answers *"what can this person do"* —
exactly the confusion the 7 stray `skill_*_occupation` rows already demonstrate is harmful.

**What these 50 actually need is a `job_domain_skill` edge set.** "Carpenter, General" needs
`skill_wood_joinery`, `skill_hand_tool_use`, `skill_measurement_marking`. It does not need an
alias called "बढ़ई" — it already has one.

Because "richest domain first" biases toward ISCO white-collar units, here is the same
construction restricted to **ISCO majors 7/8/9 — the platform's actual market**:

> `फ्रिज` (RAC Mechanic, 16) · `juta` (Cobbler, 12) · `कुली` (Loader and Unloader, 12) ·
> `चिनाई` (Bricklayer, 11) · `सफाई` (Cleaner Hospital, 11) · `कालीन` (Carpet Weaver, 10) ·
> `darji` (Tailor General, 9) · `electronics` (Electronics Fitter, 9) · `jcb` (Loader Operator, 9) ·
> `putai` (Painter Building, 9) · `ट्रक` (Driver Truck, 9) · `बेकर` (Baker, 9) ·
> `gaadi` (Driver Car, 8) · `बढ़ई` (Carpenter General, 8) · `lainman` (Lineman, 7) ·
> `machine silai` (Sewing Machine Operator, 7) · `कचरा` (Garbage Collector, 7) ·
> `पैकर` (Packer Hand, 7) · `CALL BOY` (Transport Service Operator, 6) · `dairy` (6) ·
> `Kettle Operator` (Extraction Attendant Chemical, 6) · `Water blaster` (Other Cleaning Workers, 6) ·
> `असेंबलर` (Assembler Bicycle, 6)

**Distribution of the 4,996 unresolved rows by ISCO major group:**

| major | group | searchable | unresolved | domains |
|---|---|---|---|---|
| **7** | **Craft and related trades** | 1,243 | **1,160** | 843 |
| **8** | **Plant and machine operators** | 982 | **980** | 713 |
| 2 | Professionals | 728 | 728 | 654 |
| 3 | Technicians / associate professionals | 716 | 715 | 561 |
| 5 | Services and sales | 406 | 405 | 164 |
| 1 | Managers | 349 | 349 | 188 |
| **9** | **Elementary occupations** | 225 | **225** | 123 |
| 4 | Clerical support | 174 | 171 | 119 |
| **6** | **Skilled agricultural** | 154 | **154** | 122 |
| 0 | Armed forces | 109 | 109 | 3 |

The industrial core (majors 7/8/9) is 2,450 searchable rows, **2,365 unresolved (96.5 %) across
1,679 domains**. All 28 bridged domains sit in majors 4/7/8; majors 0, 1, 2, 3, 6 and 9 have
**zero** bridged domains.

---

## 5. Reconciliation table

| Metric | Current | Expected / target | Gap | Explanation |
|---|---|---|---|---|
| `job_domain_alias` | **9,121** (5,086 searchable) | 9,121 + vernacular growth on the 2,911 single-alias leaves | **not a deficit** | 100 % normalized, 100 % embedded, one model, 0 election mismatches. Complete for its purpose. "4,000+" was the `is_searchable=false` subset. |
| `job_domain` | **4,071** (3,885 selectable-active) | 4,071 | 0 | Catalogue complete. 96 rows carry a junk `label_en` (§3.3). |
| `skill` | **165** — 52 active · 111 provisional · 2 deprecated | **~1,200–2,500** at full domain coverage (§8) | ~1,000–2,300 | Driven by domain→skill **generation**, not by domain aliases. No numeric target exists anywhere: `PROVENANCE.md:9-16` calls the corpus "a curated STARTER subset … not the full bulk import of ESCO (~13k skills)". |
| `skill_alias` | **336** — 197 searchable · 332 embedded · 139 legacy un-normalized | **≈2 × skill count ≈ 2,400–5,000** | ~2,100–4,700 | A *consequence* of skill count (corpus averages 2.01 aliases/skill). **Zero of it derives from `job_domain_alias`.** |
| `job_domain_skill` | **236 edges / 28 domains / 130 skills** (97 = distinct skills on a `required` edge) | **≈8.4 × 3,885 ≈ 32,600 edges over 3,885 domains** | **~32,400 edges · 3,857 domains** | **This is the gap.** 99.28 % of selectable-active domains have no edge. |
| ⠀…effectively reachable | **24 domains / 204 edges** | — | — | 4 of the 28 are ISCO units with **zero searchable aliases** (`jd_isco_7213`, `_7127`, `_7233`, `_4321`) — the bridge exists but retrieval can never arrive at it. |
| domain aliases representable as skills | **19 (0.21 %)**, **0 on normalized text** | **~0 by design** | 0 | All 19 explainable as leakage, shared technique names, or the 2 false friends. |
| domain aliases intentionally occupation-only | **9,102 (99.79 %)** | 100 % | 0 | 74.85 % of the retrieval surface carries an explicit agent noun; the 16.26 % residual is mostly short vernacular *occupation* nouns (`bai`, `juta`, `mochi`, `कुली`), not tasks. |
| unresolved **skill** candidates | **2** `unresolved_phrase` rows, last written **2026-07-14** | n/a | — | The skill growth queue is empty. At the documented `--min-count 3` floor it would emit at most one candidate. |
| unresolved **occupation** candidates | **34** rows, all `open`, live daily | n/a | — | Low signal — many are conversational fragments (`nhi`, `hlo`, `sab kuch`). |
| `worker_profile_skill` | **0 rows** | — | — | The destination table for domain-derived skills has never been written. |
| **bridge ↔ match-engine vocabulary overlap** | **0** (130 `skill_*` vs 9 live `mskill_*`) | must be > 0 for any of this to matter | **the whole thing** | See §6.5. |

---

## 6. The production matching path — traced, with verdicts

### 6.1 What actually serves a worker's job feed today

`GET /feed` ([api_client.dart:693](../../../apps/worker-app/lib/core/api/api_client.dart#L693)) →
`ApplicationsController.feed` →
[`applications.service.ts:87`](../../../apps/api/src/applications/applications.service.ts#L87) →
`isMatchV1Enabled` is **false** →
[`applications.repository.ts:137-158`](../../../apps/api/src/applications/applications.repository.ts#L137-L158):

```sql
SELECT id, trade_key, title, city, area, min_experience_years, max_experience_years,
       pay_min, pay_max, shift
FROM jobs
WHERE status = 'open'
  AND NOT EXISTS (SELECT 1 FROM applications
                   WHERE worker_id = $1 AND job_id = jobs.id AND action = 'applied')
  [AND trade_key = $2] [AND city = $3]
ORDER BY created_at ASC, id ASC
LIMIT $4
```

**No skills. No domains. No reach. No score. No ranking.** A chronological scan of the 19-row
legacy `jobs` table minus already-applied. Event proof:

| event | count | window |
|---|---|---|
| `feed.shown` (legacy path) | **7,652** | 2026-06-20 → **2026-08-21 07:13** (live today) |
| `feed.shown_v2` (Matching V1 path) | **28** | 2026-08-03 → 2026-08-04 (a 23-hour window; dead since) |

### 6.2 The transition table

| # | transition | verdict | implementation | gate | caller |
|---|---|---|---|---|---|
| 1a | free text → `job_domain_alias` **L0 exact** | **ACTIVE** | [occupation.service.ts:156](../../../apps/api/src/occupation/occupation.service.ts#L156) + [occupation.repository.ts:126-136](../../../apps/api/src/occupation/occupation.repository.ts#L126-L136) | none | request path (`POST /chat/message`) |
| 1b | → **L1 skeleton** | **ACTIVE code, ZERO production hits** | same `matchSpan` call | none | — |
| 1c | → **L2 trigram** | **ACTIVE** | [occupation.repository.ts:301-311](../../../apps/api/src/occupation/occupation.repository.ts#L301-L311) | none | request path |
| 1d | → **L3 vector ANN** | **UNUSED — dead by construction** | `occupation.service.ts:200-204` → `skills.repository.ts:269-306` | `options.vector`, which no caller ever supplies (`apps/api` has no embedding client) | — |
| 1e | → ai-service RAG classifier | **DISABLED** | [domain_match.py:260](../../../apps/ai-service/app/profiling/domain_match.py#L260) | `DOMAIN_MATCH_ENABLED=false` | — |
| 2 | alias → domain → **`OccupationPin` on `conversation_state.occupation`** | **ACTIVE — five live consumers, see §6.3** | `identify.service.ts:125` / `:214` | none | request path |
| 2b | pin → `worker_profiles.job_domain_id` | **WRITE-ONLY — the column has ZERO readers anywhere in the repo**, not even profile display | [profile-extraction.processor.ts:1281](../../../apps/api/src/profiles/profile-extraction.processor.ts#L1281) | pin allow-set + `isSelectableDomain` | queue worker |
| 3 | `job_domain` → `skill` via `job_domain_skill` | **DISABLED** — one runtime statement, unreachable | [skills.repository.ts:213-226](../../../apps/api/src/skills/skills.repository.ts#L213-L226) | `SKILL_CANONICALIZE_ENABLED=false`; **and** only 19/3,885 domains could answer | — |
| 4a | phrase → skill, **Path A** (canonical) | **SHADOW** — armed, dark | `processor.ts:798-801` sends `job_domain_id`; `canonicalScopeForPin` at `:1219-1248` | same flag | queue worker |
| 4b | phrase → skill, **Path B** (legacy slug) | **LEGACY + DISABLED** | [skills.repository.ts:113-124](../../../apps/api/src/skills/skills.repository.ts#L113-L124), anchored to `cnc-machining` | same flag | — |
| 5 | skill → `worker_profile_skill` | **UNUSED — 0 rows, never written** | the canonicalization pass | same flag | — |
| 5b | profile → `worker_skill` (`mskill_*` projection) | **ACTIVE** — 8 rows / 6 workers | `derive.ts:52-88` + the checked-in `ROLE_TO_MATCH_SKILL` / `ATTRIBUTE_TO_MATCH_SKILLS` maps | **not** flag-gated; **never reads `job_domain_skill`** | queue worker |
| 6 | `worker_skill` → `job_reach` | **ACTIVE but near-empty** — 6 rows, 1 posting | `worker-skills.repository.ts:198-236`, `:280-322` | none | queue worker |
| 7 | `job_reach` → relevance / ranking | **SHADOW** — rank key computed, feed never reads it | `match-engine/rank.ts`, `reach-engine/scoring.ts` | `MATCH_V1_ENABLED=false` for the read | — |
| 8 | ranking → worker feed / visibility | **LEGACY serving** | `applications.repository.ts:137-158` | `MATCH_V1_ENABLED=false` | request path |
| — | `job_domain` anywhere in ranking | **UNUSED** | `grep -c "job_domain"` → `match-engine` **0**, `reach-engine` **0**, `reach-learn` **0**, `taxonomy` **0** | structural | — |
| — | employer "recommended skills" reader (`job_domain_id → job_domain_skill → skill`, promised at [job.ts:101-103](../../../packages/db/src/schema/job.ts#L101-L103)) | **DOES NOT EXIST** | the shipped payer picker reads the 18-row `MATCH_SKILLS` TS constant, no database | — | — |

### 6.3 Where the chain actually stops — and what the domain DOES drive

**The matched domain is not inert.** It has **five live consumers**, all on the interview / chat
hot path, and they are the real product value the 5,086 searchable aliases deliver today:

| # | consumer | file:line | what it decides |
|---|---|---|---|
| 1 | **Question-pack selection** | `pack-registry.service.ts:156` → `pack.repository.ts:117-122` | **which questions the worker is asked.** Matches on `jobDomainId` **or** `iscoUnitCode` **or** the coarser rungs — and in production it is *never* the id: of the 101 committed bindings in `data/question-packs/_families.jsonl`, **0 are domain-keyed**; 41 are ISCO-unit, 59 ISCO-minor, 1 universal. The domain drives the pack through its **ISCO code**, not its id. |
| 2 | Question predicates | `predicate.ts:202-205` — `case "occupation_is"` | whether an individual question fires |
| 3 | **Answer settlement** | `orchestrator.service.ts:2563` + `:2590` — `const trade = (draft.role_label ?? draft.domain_label ?? occupationLabel ?? "").trim(); … if (trade) settle("trade", trade, trade)` | **the matched domain's label becomes the worker's `trade` answer of record** |
| 4 | The OIE parse call | `profile-extraction.processor.ts:856-864` | the whole pin crosses to `/profile/parse` as `oie.v1` |
| 5 | Worker-facing chat reply | `chat.service.ts:643` — `occupation_label` | what the worker is told we understood |

**`worker_profiles.job_domain_id`, by contrast, is written and never read.** Exhaustive sweep:
`grep -rn "workerProfiles\.jobDomainId"` → zero; every raw-SQL mention of
`worker_profiles.job_domain_id` is a `packages/db` prose comment. It is pulled into memory by
three star-selects but no mapper or DTO emits it, and `apps/api/src/workers/` and both Flutter
clients contain **zero** `job_domain` tokens. **It is not read even for profile display.**

### 6.3b The two cuts that sever the domain from the feed — both ABOVE `job_domain_skill`

The last consumer whose output could in principle have reached the feed is #3 — the domain label
becoming the `trade` answer. It dies at two independent points, and neither of them is the
taxonomy bridge:

**Cut 1 — the profile projection** ([profile-extraction.processor.ts:1801-1807](../../../apps/api/src/profiles/profile-extraction.processor.ts#L1801-L1807)):

```ts
const profile = DraftProfileSchema.parse({
  // CANONICAL IDS ARE NOT INVENTED HERE. Skill/role canonicalization is the taxonomy's job …
  canonical_trade_id: null,
  canonical_role_id: null,
  skills: [],
```

Those are **exactly** the two fields the match engine reads
([derive.ts:54-65](../../../packages/match-engine/src/derive.ts#L54-L65):
`matchSkillForRole(input.canonicalRoleId)` ∪ `matchSkillsForAttribute(...)` over
`input.profileSkills`; `if (skillIds.size === 0) return []`).

> **The OIE path — the only branch that carries the occupation — derives ZERO `worker_skill`
> rows and therefore zero `job_reach` rows. The legacy `/profile/extract` branch, which *does*
> populate `canonical_role_id` and `skills`, carries no occupation at all.** The two paths are
> mutually exclusive, which is why 6 profiles have a `canonical_role_id` and 19 have a
> `job_domain_id` and the sets barely meet.

**Cut 2 — the feed flag** ([applications.service.ts:87](../../../apps/api/src/applications/applications.service.ts#L87)):
`MATCH_V1_ENABLED` is absent from `ci.yml` entirely and `:-false` in compose, so `getFeed` never
reads `job_reach`.

**Net effect on which jobs a worker sees today: zero — but via the profile projection and the
feed flag, not via `job_domain_skill`.** The taxonomy bridge is two layers below the first cut;
fixing it changes nothing until both cuts are addressed.

### 6.4 Live evidence for every verdict

| measurement | value |
|---|---|
| `worker_profiles` | 44 |
| — with `job_domain_id` | **19** (43 %) |
| — `matched_lexical` / `l0_exact` | 11 |
| — `matched_lexical` / `l2_trigram` | 4 |
| — `matched_worker_confirmed` (chip tap, layer NULL) | 4 |
| — `matched_auto` · `matched_llm` · `l3_vector` · `l1_skeleton` | **0 · 0 · 0 · 0** |
| — with an embedding | **0 / 44** |
| of the 19 pinned profiles, on a domain with any edge | **3** (15.8 %) |
| `profile.occupation_identified` events | **128** (l0_exact 96 · l2_trigram 16 · chip 16) |
| `profile.occupation_unresolved` events | 44 |
| `worker_profile_skill` · `job_posting_skill` | **0 · 0** |
| `job_postings` with a `job_domain_id` | **0 / 8** |
| `applications` referencing a `job_postings` row | **0 / 25** (all point at legacy `jobs`) |
| `ai_call_traces` with `task_type='skill_canonicalization'` | **0** |
| `skill.phrase_unresolved`, most recent | **2026-07-14** |

`matched_auto = 0` and `l3_vector = 0` across 44 profiles is the strongest available proof that
`DOMAIN_MATCH_ENABLED` is `false` in the deployed environment — `domain_match.py:249` would emit
`matched_auto` for a pinned worker if that path ran at all.

### 6.5 The finding that makes the coverage question secondary

```sql
WITH bridge AS (SELECT DISTINCT skill_id FROM job_domain_skill),
     live AS (SELECT skill_id FROM worker_skill
       UNION SELECT matched_skill_id FROM job_reach WHERE matched_skill_id IS NOT NULL
       UNION SELECT jsonb_array_elements_text(match_skill_ids) FROM job_postings WHERE match_skill_ids IS NOT NULL
       UNION SELECT jsonb_array_elements_text(reach_skill_ids)  FROM job_postings WHERE reach_skill_ids  IS NOT NULL)
SELECT (SELECT count(*) FROM bridge) AS bridge_skills,   -- 130
       (SELECT count(*) FROM live)   AS live_skills,     -- 9
       (SELECT count(*) FROM bridge JOIN live USING (skill_id)) AS overlap;  -- 0

SELECT count(*) FROM job_domain_skill WHERE skill_id LIKE 'mskill\_%';       -- 0
SELECT kind, count(*) FROM skill GROUP BY 1;         -- attribute 147 | match_skill 18
```

All 18 `mskill_*` rows have 0 aliases and 0 edges; `skill_alias` contains no `mskill_*` row at all.

> The taxonomy branch (`job_domain → job_domain_skill → skill_* → skill_alias`) and the matching
> branch (`worker_skill → job_reach → mskill_*`) are **two disconnected systems that both call
> their nodes "skills"**. The only join is `ATTRIBUTE_TO_MATCH_SKILLS`, a hand-authored TypeScript
> constant that never consults the database. **A database join between them does not exist and is
> not scheduled by any ADR.**

---

## 7. Why D2 created only 238 aliases

**Because 238 is exactly what the corpus contains.** Nothing was truncated, failed, or
under-delivered. Every count reconciles to the row:

| table | production | = corpus artifacts on disk |
|---|---|---|
| `skill` | **165** | 49 `SKILL_CORPUS` + 98 `skills.jsonl` + 18 `MATCH_SKILLS` = **165** |
| `skill_alias` | **336** | 116 corpus + 22 ratified wedge + 197 `skills.jsonl` + 1 orphan = **336** |
| `job_domain_skill` | **236** | 236 records in `domain-skills.jsonl` = **236** |
| distinct domains | **28** | 28 records in `sample-domains.jsonl` = **28** |

D2's own steps: **step 0** wedge = 16 skills + 41 aliases; **step 1** growth = 98 skills + 197
aliases + 236 edges. **41 + 197 = 238.** Before D2: 51 / 98 / 0. After: 165 / 336 / 236. The
runbook predicted every one of those numbers before the run, and `created_at` forensics confirm
each seeder's contribution to the day.

### The constraint is a 28-line committed file

`packages/db/data/taxonomy/domain-skills.jsonl:1`:

```
# Domain->Skill taxonomy corpus — 28-domain controlled run (Phase 3).
```

The generator's domain universe is
[`sample-domains.jsonl`](../../../packages/db/data/taxonomy/sample-domains.jsonl) — 28 lines,
hand-picked, 2–3 domains across each of 12 trade groups.
[`generate-domain-skills.ts:255-267`](../../../packages/db/src/generate-domain-skills.ts#L255-L267)
reads `corpus.domains` from that file and only ever *narrows* it (`--trade-group`, `--limit`).
**There is no widening path** — no batch cursor over `job_domain`, no industry filter, no `--all`.
Exactly one generation batch has ever been run (`batch_2026-08-16T14-30-41Z`, `model:
claude-opus-5`, `domain_count: 28`, 5m39s end to end, 8.4 edges/domain).

The runbook recorded the scope consequence in advance:

> "Two trade groups have no shipped coverage to reuse (`construction`, `warehouse_logistics`)
> and two are thin (`electrical`, `hvac`). **Recorded because it predicts where Path A will
> retrieve worst after this lands.**"

### The missing piece — ISCO inheritance was designed and never built

Migration 0076 shipped the column, the FK, the index and two CHECKs for `source='inherited'` +
`inherited_from_job_domain_id`.
[`taxonomy-corpus.ts:183`](../../../packages/db/src/taxonomy-corpus.ts#L183) asserts *"the ISCO
ladder resolver writes them"*.

**No such resolver exists.** A repo-wide grep returns zero write sites — every hit is a schema
definition, a CHECK, a test of that CHECK, an enum member, or a comment excluding it from an
`ON CONFLICT`. Production agrees: `SELECT source, count(*) FROM job_domain_skill GROUP BY 1` →
`llm_bootstrap | 236`, and `inherited_from_job_domain_id` is NULL on all 236.
[`seed-domain-skills.ts:75-78`](../../../packages/db/src/seed-domain-skills.ts#L75-L78) defers it
explicitly: *"Resolving the ISCO ladder into `source='inherited'` rows is the materializer's job."*

**This is the single highest-leverage missing component in the area.** If the 28 authored domains
inherited down the ISCO tree:

| inheritance level | selectable-active domains covered | % |
|---|---|---|
| none (today) | 28 | 0.72 % |
| by `isco_unit_code` (4-digit) | **397** | **10.2 %** |
| by `isco_minor_code` (3-digit) | **752** | **19.4 %** |
| by `isco_submajor_code` (2-digit) | **1,047** | **26.9 %** |

A 14–37× coverage improvement for **zero new model calls**. It cannot reach 100 %; the rest needs
generation.

### Cost is not the constraint

`gemini-embedding-001` is **₹0.0125 / 1k input tokens**; D2's 260-alias embed cost **~₹0.012**
(≈ ₹0.000046 per alias). Embedding the whole projected corpus would cost **₹1–2 total**. The
constraints are corpus authorship, the review gates, and the missing materializer — never spend.

---

## 8. If the work were authorised — current → target → transformation → validation → rollout

**Scoped as `job_domain_skill` edge generation, not `skill_alias` generation.** This is the master
plan's node **N15** (`phase-9-master-plan.md:192`, §14), which already prescribes *"Pilot first:
one NCO major group, measured end-to-end, before anything wider."*

### Sizing — domains needed for alias-weighted coverage of the 5,086-row retrieval surface

| target | domains needing edges |
|---|---|
| 50 % | **972** |
| 80 % | **2,498** |
| 90 % | **3,007** |
| 95 % | **3,261** |
| 100 % | 3,515 (every domain with a searchable alias) |

**Recommended target: 80 % alias-weighted, restricted to ISCO majors 6–9 first** — 1,801 domains,
2,519 unresolved alias rows, and the market the product actually serves.

### Expected record counts

Derived from the one measured batch (8.4 edges/domain; 130 distinct skills over 28 domains, 98 of
them new — a 70 % new-skill rate at zero prior coverage, which falls steeply as the vocabulary
saturates):

| artifact | at 1,800 domains (majors 6–9) | at 3,885 domains (all) |
|---|---|---|
| `job_domain_skill` edges | ~15,000 | ~32,600 |
| new `skill` rows | ~1,000–1,600 | ~1,200–2,500 |
| new `skill_alias` rows (≈2.0/skill) | ~2,000–3,200 | ~2,400–5,000 |
| generation prompts | 1,800 | 3,885 |
| embedding spend | ~₹0.15 | ~₹0.25 |

**Note the shape:** `skill_alias` does end up in the low thousands — but as a *consequence* of the
skill vocabulary widening, never by transforming domain aliases.

### Phasing

| # | step | mutates | authorisation |
|---|---|---|---|
| **P0** | **Decide the ceiling first** — will the taxonomy branch ever join the match engine (§6.5)? If not, nothing below is worth doing. | no | **owner** |
| P1 | Build the ISCO inheritance materializer (`source='inherited'` + `inherited_from`). Dry-run only. | no | merge |
| P2 | Run it read-only against production; measure the true fan-out (predicted 397 / 752 / 1,047). | no | autonomous |
| P3 | Apply inheritance — the cheapest coverage in the programme, no model call. | **yes** | owner |
| P4 | **Pilot:** generate edges for one NCO major group (recommend **major 7** — 843 unresolved domains). Two gates + human commit, exactly as the 28-domain run. | corpus files | owner |
| P5 | Measure the pilot: Path A recall, `NO_COLLISION`, `taxonomyQualityVerdict`, reuse rate. | no | autonomous |
| P6 | Seed + normalize + elect + embed the pilot corpus. | **yes + provider** | owner |
| P7 | Repeat P4–P6 per major group: 6 → 9 → 8 → 5. | | |
| P8 | Promotion (`db:promote:skills`) — currently **BLOCKED** on `EVAL_COVERED` and the P1 Path-B decision. | **yes** | owner |

### Effort

| stage | effort |
|---|---|
| ISCO inheritance materializer + tests + verify runner | **M** — 2–4 days |
| Pilot: one major group (843 domains) through the existing two-gate pipeline | **M** — generation is a batch; the **human diff review is the long pole** |
| Full majors 6–9 (1,801 domains) | **L** — weeks of review, not compute |
| Joining the taxonomy branch to the match engine (§6.5) | **unscoped — and it is the actual prerequisite.** Needs an ADR, not a batch. |

### Validation gates (all already exist)

`validateTaxonomyCorpus` (structural) → `analyzeTaxonomyQuality` + `taxonomyQualityVerdict`
(semantic; a BLOCK writes `blocked-*.jsonl` and exits non-zero) → human git commit →
`db:seed:domain-skills --apply` under `opsGuard` (two independent signals) →
`db:verify:taxonomy` / `db:report:taxonomy` / `db:eval:taxonomy`.

---

## 9. Documentary defects found along the way

| # | defect | correct state |
|---|---|---|
| 1 | `phase-9-d2-seed-embed-promote-runbook.md:8-11` says step 2 (embed) "wrote nothing" | **The embed ran.** 332 `gemini-embedding-001` vectors stamped 2026-08-21 05:29–05:31Z. `project-status.md` is current; the runbook is stale. |
| 2 | `phase-9-path-a-activation-plan.md:109-110` says production has "0 `text_norm`" on `skill_alias` | **197 normalized + elected.** The 139 legacy rows remain un-normalized. |
| 3 | `apps/ai-service/app/routers/profile.py:265-267` — "NOTHING POPULATES `body.job_domain_id` TODAY" | **False since OIE O2.** `profile-extraction.processor.ts:801` populates it. The pass is inert because of the flag, which `processor.ts:1198-1201` states correctly. Anyone reading the Python file will wrongly conclude S3-C is unwired. |
| 4 | `ci.yml:1859-1862` and `docker-compose.staging.yml:465-467` — "INERT: no secret exists for either name" | **Both secrets now exist** at `environment: production` (created 2026-08-18). Values are unreadable, so the `:-false` defaults and the guard test remain the only written record that they are `false` — but flipping either is now a one-click secret edit with no code review. |
| 5 | `skills.repository.ts:180-182` — "all 238 edges are active and all 98 skills are provisional" | Production reads **236 edges / 130 skills**, of which 29 are active. Stale on all three numbers. |
| 6 | Migration-number drift: partial HNSW attributed to "0068" (it is 0067); `unresolved_phrase.scope` attributed to "0070" (it is 0072) | Both renumbered in-flight; the comments were not updated. |
| 7 | `S3-A` / `S3-B` mean different things in `phase-9-s3-deployment-plan.md` vs `project-status.md` | `project-status.md` declares itself authoritative. |

---

## 10. Decisions required

| # | decision | why it must be a human call | recommendation |
|---|---|---|---|
| **D-1** | **Do the taxonomy branch and the match engine ever join?** 130 `skill_*` vs 9 live `mskill_*`, overlap 0, no ADR schedules a join. | Until this is answered, every `job_domain_skill` edge is inert by construction and further edge generation buys nothing. | **Answer this before anything else.** It is an ADR, and it gates D-2 and D-3. |
| **D-2** | Authorise the **ISCO inheritance materializer** — designed in migration 0076, never built. | A DB write across 3,857 domains. | **Build and dry-run it regardless of D-1** — 14–37× coverage for zero model spend, and it is the cheapest way to make D-1's answer measurable. |
| **D-3** | Authorise a **one-major-group edge-generation pilot** (recommend ISCO major 7 — 843 domains). | Provider spend plus a large human review diff. | Only after D-1 is `yes`. |
| **D-4** | Accept or deprecate the **7 `skill_*_occupation` rows** (`skill_welder_occupation`, `skill_fitter_occupation`, `skill_machinist_occupation`, …) — occupation nouns living in the skill vocabulary. | A taxonomy boundary ruling. | **Deprecate.** They are the leakage that makes the two vocabularies look like one, and three already have no active edge. |
| **D-5** | Clean the **96 junk-labelled `job_domain` rows** (206 searchable aliases, 4.05 % of the surface) — including `jd_nco_8155_0201`, to which a live worker is currently matched. | Corpus edit + re-election. | Low cost; fold into the next alias write. |
| **D-6** | Close the **vernacular gap**: 2,899 of 3,449 NCO leaves (84.1 %) carry only a copy of their official title; 142 of 9,121 aliases are Hindi; the whole `rvm` overlay covers 2.96 % of leaves. | Needs trainer/ops-authored terms. | **Higher product value per rupee than edge generation, and independent of D-1.** `db:mine:aliases` (report-only, over real worker messages) is the runner that already exists for this. |

---

## Appendix — how every number here was produced

```bash
# temporary read-only runner; every statement inside SET TRANSACTION READ ONLY
cd packages/db && pnpm exec tsx src/ro-query.tmp.ts <file.sql>
```

```bash
# repository corpus counts
node -e "const fs=require('fs');const L=f=>fs.readFileSync(f,'utf8').split('\n')
  .filter(l=>l.trim()&&!l.startsWith('#')).map(JSON.parse);
  const ds=L('packages/db/data/taxonomy/domain-skills.jsonl'),
        sk=L('packages/db/data/taxonomy/skills.jsonl');
  console.log(ds.length, new Set(ds.map(r=>r.job_domain_id)).size,
              sk.length, sk.reduce((n,s)=>n+(s.aliases||[]).length,0));"
# -> 236 28 98 197
```

Code paths cited: `apps/api/src/skills/skills.repository.ts`,
`apps/api/src/applications/{applications.service,applications.repository}.ts`,
`apps/api/src/occupation/{occupation.service,occupation.repository}.ts`,
`apps/api/src/profiling/identify.service.ts`,
`apps/api/src/profiles/profile-extraction.processor.ts`,
`apps/api/src/match/worker-skills.{service,repository}.ts`,
`apps/ai-service/app/{routers/profile.py,profiling/domain_match.py,config.py}`,
`packages/db/src/{generate-domain-skills,seed-domain-skills,alias-lifecycle,normalize-job-domain-aliases}.ts`,
`packages/db/src/schema/{occupation,skill,taxonomy,job}.ts`,
`packages/taxonomy/src/match-skills.ts`, `packages/match-engine/src/derive.ts`.
