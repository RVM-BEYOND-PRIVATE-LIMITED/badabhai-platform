# BadaBhai — Matching Algorithm V1 (ratified source spec)

> **Transcribed into the repo 2026-07-31 from the ratified document dated 2026-07-30**
> (`engine_version: v1.0`). Checked in because the implementation must be **diffable
> against the spec** — the first build of `packages/match-engine` reconstructed the
> worked examples from a prose brief and got `industry_months` wrong in a way every
> test still passed. The normative content below is transcribed faithfully; editorial
> notes added during transcription are marked **[repo note]** and are not part of the
> ratified text.
>
> Decision of record: [ADR-0036](../decisions/0036-matching-algorithm-v1.md).
> Owner rulings that modify this spec: [team-decisions.md](../registers/team-decisions.md),
> 2026-07-31 — **E3 is answered as tier-with-floor at 36 months** (Part 9 ruling #1, option b).

---

## Part 1 · Nomenclature

| Term | Meaning |
| --- | --- |
| **Industry** | Manufacturing · Quick-commerce delivery · Construction · … |
| **Skill** | What a company posts a job for. CNC Turner · VMC Operator · HMC Operator · CNC Setter-Operator · CNC Programmer · CAM Programmer · CNC Grinding Operator · MIG Welder · Fitter · Delivery Rider |
| **Related Skills** | A short curated list hanging off each Skill. VMC Operator → HMC Operator · CNC Setter-Operator · CNC Turner. **A flat lookup table, not a taxonomy level.** |
| **Attribute** | Detail describing the work. Shown on the card. **Never matched, never ranked.** Fanuc/Siemens · tool offset setting · GD&T · machine make · tolerance · shift · employers · last worked |
| **Visibility Algorithm** | Decides what a worker sees in his feed |
| **Filters** | The worker's own search controls. Not algorithm inputs. |
| **Recommendation Algorithm** | Decides the order of the company's paid candidate list |
| **Match Tier** | 1 = worker has the posted skill · 2 = worker has a related skill only |
| **skill_months** | Worker's months in the skill he matched on |
| **industry_months** | Worker's total calendar months in the job's industry |
| **Rank Key** | The sort tuple used by the Recommendation Algorithm |
| **wants** | Worker's flag: does he want work in this skill |

Still two levels: **Industry** and **Skill**. Related Skills is data attached to a skill,
not a domain, family or hierarchy.

## Part 2 · The Visibility Algorithm

```
SHOW job TO worker IF:
    worker.skills ∩ job.reach_skills ≠ ∅
    AND worker.wants[matched skill] = true

where job.reach_skills = job.skills ∪ related(job.skills) ⊖ company's unticks
```

**Two conditions. Nothing else.**

At posting, the company names its skill. The form then shows the related skills
**pre-ticked**, with a live reach count; the company unticks what it does not want.
**Breadth is the company's choice — the platform only offers the list, and the reach
counter is the control.**

- Nothing is hidden by score. There is no score at this layer.
- The Related Skills list is curated by Akshit / RVM instructors. It is trade truth, not
  engineering judgment. Roughly 45 skills × 2–4 relations each.

**Feed order:** newest first, boosted jobs lifted, maximum 2 consecutive cards from the
same company.

## Part 3 · Filters — the worker's, not ours

| Filter | Default |
| --- | --- |
| Distance | his city, wide |
| Salary | **off** |
| Shift | off |
| Job type | off |
| Company / area | off |

**Every default is wide or off.** A ₹22,000 expectation captured at registration must
never silently become a filter that hides ₹20,000 jobs. Defaults that narrow are a
volume leak.

## Part 4 · The Recommendation Algorithm

```
RANK KEY = ( match_tier        ASC ,   -- 1 = has the posted skill, 2 = related only
             skill_months      DESC ,
             industry_months   DESC ,
             last_worked_at    DESC ,
             last_active_at    DESC ,
             stable_hash       ASC )
```

**Two governing invariants**

- **A ·** A worker with the posted skill always ranks above a worker with only a related
  skill. Tier before everything.
- **B ·** Industry experience can never promote a worker above another worker with more
  months in the matched skill. Industry months speak only when skill months are equal.

Both are **structural**. There is no weight, no coefficient, no blend — so neither can be
broken by tuning, and no future config change can silently violate them. Both are
release-gated by automated tests.

**Ranking never removes anyone.** It orders the list the company paid to see.

> **[repo note — owner ruling 2026-07-31]** Invariant A ships **modified**: a related-skill
> worker enters tier-1 ordering once his `skill_months ≥ tier_floor_months` (default 36).
> This is Part 9 ruling #1 option (b), and it deliberately inverts the E3 illustration below.
> Implemented as `effective_tier` replacing `match_tier` as the first sort key; raw
> `match_tier` is still carried for the E18 badge.

### Proof against the three required cases

**① Industry breaks ties but never crosses**

| | | Rank Key | Order |
| --- | --- | --- | --- |
| X | 48 mo VMC | (1, 48, 48) | 1 |
| Y | 24 mo VMC + 24 mo CNC Turner | (1, 24, **48**) | 2 |
| Z | 24 mo VMC | (1, 24, 24) | 3 |

Y beats Z on his CNC years — because their VMC months are level.

> **[repo note]** Y's `industry_months` of 48 is **24 + 24 summed across two skills in the
> same industry**. `industry_months` is a SUM of merged stints, never a max over rows. This
> is the case the first implementation got wrong.

**② Six months never crosses two years**

| | | Rank Key | Order |
| --- | --- | --- | --- |
| A | 24 mo VMC, nothing else | (1, 24, 24) | 1 |
| B | 6 mo VMC + 240 mo factory work | (1, 6, 246) | 2 |

Twenty years cannot buy eighteen months on the machine.

**③ Related skills are reached, and ranked below**

| | | Rank Key | Order |
| --- | --- | --- | --- |
| Z | 24 mo VMC | (1, 24, 24) | 1 |
| R | 24 mo CNC Turner, no VMC | (2, 24, 24) | 2 |

R sees the job and can apply. He appears in the company's list, below every man who has
actually run a VMC, tagged on the card as a related skill.

## Part 5 · Configuration surface

```yaml
engine_version:             v1.0
month_bucket:               6      # round all durations to 6-month steps
max_skills_per_posting:     3      # skills the company types; retire once quotas live
related_skills_default:     on     # pre-ticked on the posting form
max_consecutive_same_company: 2    # feed
applicant_quota:            off    # alpha only
```

Six lines. Ships as Remote Config. **Never hard-coded.**

Related skills are **not** capped by `max_skills_per_posting` — that cap governs what the
company types. Related expansion is bounded by the curated list and controlled by the live
reach counter.

> **[repo note]** Three values are added by owner ruling: `tier_floor_months: 36`,
> `free_unlock_credits: 50`, `boost_supply_floor`. Stored in the `match_config` table
> (the `pricing_catalog` pattern) rather than Firebase Remote Config, because the values
> are read server-side; RC cannot gate server behaviour.

## Part 6 · Behind the scenes

**Governing rule: everything is computed on WRITE. Every read is an indexed sort.**

```
skill                   skill_id · industry_id · label
skill_related           skill_id · related_skill_id          ← flat, curated, symmetric
worker_skill            worker_id · skill_id · industry_id · months_bucketed
                        started_at · ended_at · wants · source
worker_industry_tenure  worker_id · industry_id · calendar_months · computed_at
job_posting             job_id · industry_id · skill_ids[] · reach_skill_ids[]
                        filters · boosted
job_reach               job_id · worker_id · match_tier · matched_skill_id
application             application_id · job_id · worker_id
                        match_tier · skill_months · industry_months   ← STORE THE INPUTS
                        last_worked_at · engine_version · created_at
```

**The six moments**

① **Worker profiled.** Bada bhai extracts every past job as a `worker_skill` row. `wants`
defaults true. Months bucketed to 6.

② **`worker_industry_tenure` rebuilt.** **Merge overlapping date ranges per industry, sum
the merged length.** *A man who ran a VMC and set tools in the same job has 24 months, not
48.* Runs on profile write.

③ **Company publishes.** `reach_skill_ids` is resolved on the form; one indexed query
writes the whole reach set with its tier:

```sql
INSERT INTO job_reach (job_id, worker_id, match_tier, matched_skill_id)
SELECT :job_id, ws.worker_id,
       MIN(CASE WHEN ws.skill_id = ANY(:posted_skill_ids) THEN 1 ELSE 2 END),
       ...
FROM   worker_skill ws
WHERE  ws.skill_id = ANY(:reach_skill_ids)
AND    ws.wants = true
GROUP  BY ws.worker_id;
```

`MIN(...)` gives **best tier wins** — a worker holding both an exact and a related skill is
tier 1.

④ **Worker opens feed.** No scoring:

```sql
SELECT j.* FROM job_reach r JOIN job_posting j USING (job_id)
WHERE  r.worker_id = :me AND j.status = 'open'
AND    <his filters> AND NOT EXISTS (applied / passed)
ORDER  BY j.boosted DESC, j.published_at DESC;
```

⑤ **Worker swipes apply.** Snapshot the rank inputs onto the application row and freeze
them with `engine_version`.

⑥ **Company opens the list.** Pure indexed sort:

```sql
SELECT * FROM application WHERE job_id = :job
ORDER BY match_tier ASC, skill_months DESC, industry_months DESC,
         last_worked_at DESC, last_active_at DESC, stable_hash ASC;
```

**Why store the inputs and not a score:** you can replay every historical list under any
future rule and check whether it would have ranked the Kept candidates higher. **This is
the only irreversible decision in the document — history not captured on day one is gone
permanently.**

## Part 7 · Policies

**A · Ranking**
1. Three things order a company's list, in this order: match tier, then `skill_months`, then `industry_months`.
2. **Tier never inverts.** A related-skill worker never outranks a posted-skill worker. *(Modified by the 2026-07-31 tier-floor ruling.)*
3. **Industry months never cross skill months.**
4. **Nothing else may enter the rank.** Not education, not age, not gender, not caste, not religion, not RVM affiliation, not attributes, not money.
5. **Attributes are display-only.** They inform the ₹40 decision, never a position.
6. **Ranking never removes anyone.**
7. **The sort must be stable.** A list that reorders between page loads is a bug.
8. Policies 2 and 3 are release-gated by automated tests.

**B · Visibility**
9. A worker sees a job only if he holds a reach skill and wants it.
10. **Breadth belongs to the company.** The platform offers the related list; the company unticks. It never silently widens beyond the curated relations.
11. The Related Skills list is **trade truth**, owned by Akshit / RVM instructors, and changes to it are versioned like any other locked decision.
12. **Filters belong to the worker.** Every default wide or off.
13. **Boost reorders jobs in a worker's feed. Boost never adds a job** that failed the skill gate, and never touches the company's candidate list.
14. **The LLM never ranks, filters, or rejects.** It extracts phrases. That is all.

**C · Money**
15. Workers never pay.
16. **No re-charge** for a worker a company has already unlocked.
17. Contact caps in code: 5 reveals/worker/day · 10 payers/worker/week · 3 attempts/unlock.
18. **Alpha quotas off.** No revenue to protect yet — only liquidity. A paused job stops feeding the worker app.

**D · Data**
19. Every skill tag comes from conversation, never a form.
20. **Months bucket to 6.** No false precision on a number a man estimated.
21. **Nothing is verified.** The company reads the attributes and decides. Repeat-unlock rate punishes bad profiles, not a verification team.
22. Consent at registration covers `model_training` from day one. Deletion overrides everything. DPDP is a launch gate.

**E · Change control**
23. Any change to the Rank Key, bucket size, feed order, or the Related Skills table = **new `engine_version`, CEO sign-off, ADR**.
24. Every application stores the `engine_version` that ranked it.
25. **Config, never code.**
26. **Migrations run manually by Divyanshu. Never by a coding agent.**

**F · Ops**
27. **Ops may widen a reach set, never narrow one.** Expiring, audited, evented.
28. Three overrides with the same reason in 30 days auto-files a product bug.

**G · Claims**
29. **Never sell the ranking as prediction.** No pre-hire experience measure reliably predicts who performs or who stays. Sell the gate: *"everyone in this list has actually done this work."* That claim is true. *"Our AI finds you the best worker"* is not.

## Part 8 · Worked examples & edge cases

**Reference job — VMC Operator · Manufacturing.** `skills: [VMC Operator]` ·
`related: [HMC Operator, CNC Setter-Operator, CNC Turner]`

**E1 · The founder's case — Zomato + CNC.**
Ramesh: Delivery Rider 24 mo (Quick-commerce) · CNC Turner 24 mo (Manufacturing)

| Job | Result |
| --- | --- |
| VMC Operator, CNC Turner **ticked** | **Visible** · Rank Key **(2, 24, 24)** |
| VMC Operator, CNC Turner **unticked** | Not visible |
| CNC Turner | **Visible** · Rank Key **(1, 24, 24)** |

His delivery months contribute nothing to a factory job either way.

**E2 · Full ordering on one job.**

| | | Rank Key | Order |
| --- | --- | --- | --- |
| X · 48 mo VMC | exact | (1, 48, 48) | 1 |
| Y · 24 mo VMC + 24 mo CNC | exact | (1, 24, 48) | 2 |
| Z · 24 mo VMC | exact | (1, 24, 24) | 3 |
| R · 24 mo CNC Turner | related | (2, 24, 24) | 4 |

**E3 · 🔴 The sharp edge — RULED 2026-07-31.**

| | | Rank Key | Order (as printed) |
| --- | --- | --- | --- |
| B · 6 mo VMC, nothing else | exact | (1, 6, 6) | 1 |
| C · 120 mo CNC Turner | related | (2, 120, 120) | 2 |

*A man with six months on a VMC outranks a man with ten years on a CNC lathe.* The document
flagged this as "the most consequential decision left in V1" and asked for a ruling.

> **[repo note — RULED]** Tier-with-floor, threshold 36. C's `effective_tier` becomes 1 and
> **C ranks above B**. The order printed above is the strict-tier behaviour that was
> rejected. The test asserts the ruled order, not the printed one.

**E4 · Duration unknown.** *"Maine VMC chalaya hai"* — cannot say how long. →
`skill_months = 0`, card shows **"duration not stated."** Rank Key `(1, 0, …)` — last within
tier 1, but still **above every related-skill worker**. Never dropped.

**E5 · Multi-skill posting.** Job lists `[CNC Turner, VMC Operator]`. Worker has CNC Turner
36 mo, VMC 12 mo. → Tier 1 (holds a posted skill). `skill_months` = **max across matched
posted skills = 36**.

**E6 · Worker holds both an exact and a related skill.** VMC 12 mo + CNC Turner 60 mo, on a
VMC job. → **Best tier wins: tier 1.** `skill_months` = **12** (the exact skill), **not** 60.
Rank Key **(1, 12, 72)**. His CNC years still lift him via `industry_months`.

> **[repo note]** `industry_months = 72 = 12 + 60`. Again a SUM within the industry.

**E7 · Same skill, two industries.** A Fitter with 24 mo in Manufacturing and 18 mo in
Construction, on a Manufacturing Fitter job. → `skill_months = 42` (a fitter is a fitter,
wherever he fitted) → `industry_months = 24` (Manufacturing only).

> **[repo note]** E7 and E8 conflict if E8's clamp is read across industries: here
> `skill_months` (42) legitimately exceeds `industry_months` (24). The clamp is therefore
> **per-industry** — it compares a skill's months against tenure in *that skill's own*
> industry, never against a cross-industry sum.

**E8 · Data integrity — skill exceeds industry.** Impossible in reality, common in
voice-extracted data. → **Clamp: `industry_months = MAX(industry_months, skill_months)`.**

**E9 · Overlapping stints.** VMC Operator Jan 2023–Dec 2024, and tool-setting in the same
job. → `industry_months = 24`, **not 48**. Interval merge, computed on write.

**E10 · Job-hopper vs long-stayer.** Both 24 mo VMC — one stint versus four six-month jobs.
→ **Identical Rank Key.** Number of employers appears as an attribute. Job-hopping is not
scored: prior experience has essentially zero correlation with whether a man stays.

**E11 · Complete tie.** → `last_active_at`, then `stable_hash(worker_id, job_id)`. **Never
random at read time** — a list that reorders between page loads looks broken to a man who
just paid.

**E12 · Nobody wants the skill.** Ten men hold it, none has `wants = true`. → Reach falls to
the related skills. If that is also zero → **ops alert**. Men are never force-fed a job.

**E13 · Zero reach at posting.** → **Tell the company on the form, before they pay.** The
reach counter reads 0. **Never take money for a posting into a void.**

**E14 · One company floods the feed.** → Maximum 2 consecutive cards from one company.

**E15 · Worker matches on two skills of the same job.** → **One application per (worker,
job).** Best tier, highest `skill_months`.

**E16 · Worker updates his profile after applying.** → The company's list does **not** move.
Inputs frozen at apply.

**E17 · The one-tag worker.** A man leaves the conversation with a single skill tag. →
Related Skills now rescue him — one tag reaches roughly three to four times as many jobs as
before. Still flag `low_tag_worker` and queue a re-profiling nudge. Track
`avg_skill_tags_per_worker`; **below 2, the conversation is the bug, not the algorithm.**

**E18 · Related-skill workers on the company's card.** → Badge it: **"CNC Turner — related
to VMC Operator."** The company opted in, so it should see plainly what it is looking at
before spending ₹40.

## Part 9 · Open rulings (and how they were answered)

| # | Question | Recommendation | **Ruling (2026-07-31)** |
| - | --- | --- | --- |
| 1 | **E3 — does tier strictly dominate?** Should ten years of a related skill outrank six months of the posted skill? | (a) strict tier — simplest, unbreakable, but produces E3. (b) **tier-with-floor** — a related-skill worker enters tier 1's ordering once his related months exceed a threshold (e.g. 36). *"I lean (b) with threshold 36."* | **(b), threshold 36.** |
| 2 | Are relations symmetric? | Start **symmetric** — simpler, and tier 2 already ranks them below. Revisit if payers complain about over-qualified men appearing. | Symmetric. |
| 3 | E7 — does Construction fitting count toward `skill_months` on a Manufacturing Fitter job? | **Yes.** A skill tag is a skill tag. Industry governs `industry_months` only. | Yes. |
| 4 | Related skills pre-ticked or unticked by default? | **Pre-ticked.** Volume is the objective; the reach counter and the untick boxes are the control. | Pre-ticked. |
| 5 | Month bucket | **6 months** | 6. |
| 6 | Max skills per posting | **3 now**; retire when quotas go live — a company listing more fills its quota faster and pays again. Monetisation is the abuse control. | 3. |
| 7 | Alpha quotas | **Off** until `jobs_visible_per_worker_per_week > 10` for 3–4 weeks | Off. |

## The whole thing

```
VISIBLE     = holds a reach skill  AND  wants it
RANK        = tier → skill_months → industry_months → recency
FILTERS     = his, not ours
ATTRIBUTES  = shown, never scored
```

The posted skill decides who is in the room and who stands at the front. Related skills
decide who else gets in. Industry decides the order among equals. Nothing else touches any
of it.
