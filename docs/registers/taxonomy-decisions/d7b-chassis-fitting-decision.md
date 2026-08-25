# D-7B — `skill_chassis_fitting`: semantic replacement vs matching equivalence

**Prepared against main `87af9381` · measured 2026-08-24 · read-only**
**Production mutation: NONE · AI spend: ₹0 · no gate, floor or baseline touched**

Reproduce: `pnpm db:audit:crosswalk-chain --skill=skill_chassis_fitting --json=<out>`
Artifact: [`d7b-crosswalk-chain.json`](./d7b-crosswalk-chain.json) (carries `measured_at`)

Evidence tags: **MEASURED** production · **STATIC** repository · **INFERRED** derived.

---

## 0. The correction that makes this legible

The shorthand **"`skill_chassis_fitting.replaced_by` is `mskill_fitter`" is FALSE**, and believing
it is what makes the risk invisible. There are two hops, authored in two places by two different
decisions:

```
skill_chassis_fitting  --replaced_by-------->  skill_mechanical_assembly     HOP 1  taxonomy
                                                       |                            (a DB column)
                                                       |
skill_mechanical_assembly  --ATTRIBUTE_TO_MATCH_SKILLS-->  mskill_fitter    HOP 2  matching
                                                                                   (a TS constant)
```

> **Hop 1 says two concepts are the same trade knowledge. Hop 2 says a worker may be offered a
> Fitter's vacancy.** Semantic replacement is not matching equivalence — and a crosswalk author
> who considers only hop 1 decides hop 2 without noticing.

Collapsing them also hides *where* the claim is created. `skill_chassis_fitting` has **no bridge
entry at all** (it is not in `SKILL_CORPUS`), so the claim cannot come from the subject. It can
only be acquired *through* the successor.

---

## 1. The chain, measured hop by hop

**MEASURED** — read-only session, role `postgres`, `rolbypassrls = true`.

| hop | | |
|---|---|---|
| **1 subject** | `skill_chassis_fitting` | `status=deprecated`, `replaced_by=skill_mechanical_assembly`, `kind=attribute`, `domain_id=NULL`, `source=rvm`, **2 aliases (2 embedded)**, 1 `job_domain_skill` edge, **not in `SKILL_CORPUS`**, **bridge entry: none** |
| **2 successor** | `skill_mechanical_assembly` | `status=active`, `replaced_by=NULL`, 2 aliases (2 embedded), 3 edges, **in `SKILL_CORPUS`** |
| **3 bridge** | *code, not data* | subject → `null` · successor → `["mskill_fitter"]` · **gained = `["mskill_fitter"]`** |
| **4 stored refs** | | `worker_skill` on either skill: **0** · `worker_skill` total: **0** · `job_reach` total: **0** |

**No link is absent.** The chain is complete and terminates in a real match skill.

**MEASURED** — the retag runner's own predicate (`status='deprecated' AND replaced_by IS NOT
NULL`) returns **2 rows today**, and this is one of them:

```
skill_chassis_fitting          -> skill_mechanical_assembly     <- widening
skill_go_no_go_gauge_checking  -> skill_measuring_instruments    <- neutral ([] -> [])
```

---

## 2. THE CORRECTION THAT MATTERS — the widening is already live, with no retag

My first draft of this brief said the retag creates the claim. **That is wrong**, and the
error is the same shape as the one D-7 exists to prevent: I reasoned about the columns instead
of measuring the query.

**MEASURED.** Scoring the shipped canonical retrieval statement with the subject's **own stored
alias vector** (`"chassis assembly"`) — free, no embedding call:

| scope | top-1 | score | outcome |
|---|---|---:|---|
| `jd_nco_7231_0400` **"Fitter Automobile"** | **`skill_mechanical_assembly`** | **0.7570** | **≥ 0.75 → ASSIGNED** |
| `jd_nco_8211_1200` "Assembler, Automobile" | `skill_mechanical_assembly` | 0.7570 | **ASSIGNED** |
| `jd_nco_8212_0100` "Battery Assembler" | `skill_mechanical_assembly` | 0.7570 | **ASSIGNED** |
| legacy slug `fitting-assembly` | `skill_mechanical_assembly` | 0.7570 | **ASSIGNED** |

Now remove one predicate — `s.status = 'active'` — and re-run the identical query:

| top-1 | score | bridge |
|---|---:|---|
| **`skill_chassis_fitting`** (deprecated) | **1.0000** | **`[]` — not a bridge key** |

> **The status guard inverts the outcome.** By hiding the deprecated subject's own exact match,
> it promotes the nearest *active* neighbour — which is the successor, which is bridged. The
> predicate every trace described as *the protection* is the *mechanism*.

**INFERRED, and load-bearing:** retrieval never reads `replaced_by`. The successor is reached by
**vector distance**, not by the crosswalk. So there is a route from the chassis concept to
`mskill_fitter` that **bypasses hop 1 entirely**. Deprecation alone was sufficient; the retag was
never necessary.

**The margin is 0.0070.** 0.7570 against a floor of 0.75, tested with `>=`. Any re-embed or
model change moves it.

## 3. What a retag would additionally do

**STATIC** — `retag-skills.ts`. `--apply` rewrites `worker_profiles.skills` and
`job_postings.skill_ids`, and **moves the deprecated skill's aliases onto the terminal**,
carrying the embedding, *"so future canonicalization assigns the successor"*.

**MEASURED** — today it would move **0 stored rows** (both surfaces are empty) but **4 alias
rows**, 2 of them the subject's. After that move, `"chassis assembly"` would resolve to
`skill_mechanical_assembly` at **1.0000** instead of 0.7570 — the retag makes an existing
widening *stronger*, it does not create it.

**MEASURED** — `--apply` is currently **refused** by the ops guard: production-like target with
neither `--i-am-authorised-to-write-to-production` nor `OPS_ALLOW_PRODUCTION=retag`. Only the
dry run is reachable, and no dry-run report has ever been committed.

## 4. The questions, answered

**A — what happens when `skill_chassis_fitting` is deprecated?** It already is, and §2 is the
answer: deprecation is not inert. It removes the subject from retrieval and thereby routes the
subject's own phrase onto the bridged successor.

**B — what happens when `retag-skills.ts` runs?** Dry run today (`--apply` is ops-guard refused).
It would move 0 stored rows and 4 alias rows, strengthening 0.7570 → 1.0000.

**C — which successor?** `skill_mechanical_assembly`, one hop, terminal, `active`. No chain, no
dead end, no cycle. **But retrieval does not use this hop at all** (§2).

**D — does the successor produce a MATCH_SKILLS signal?** Yes. **E — which?** `mskill_fitter`.

**F — does it reach the runtime feed?** **Partly, today.** `worker_profiles.skills` writes are
live and ungated (D-1), so a canonicalized `skill_mechanical_assembly` lands on a profile now.
`worker_skill`/`job_reach` are **0** and the feed reads `job_reach` only behind `MATCH_V1_ENABLED`
(off). So the claim is **recorded** today and **served** after a flag flip.

**G — can a worker become eligible for a vacancy they were not?**

| | today | after the flag flip |
|---|---|---|
| existing workers | 0 — `worker_skill` empty | — |
| a worker saying "chassis assembly" on an automotive/assembly domain | **canonicalizes to `skill_mechanical_assembly` at 0.7570 and it is written to their profile** | **offered Fitter vacancies** |

**MEASURED and moving:** `workers` went **1 → 37** and `worker_profiles` **1 → 22** between
2026-08-24 and 2026-08-25. The "empty population" mitigation is eroding in real time.

**MEASURED:** `unresolved_phrase` carries skill-scope misses timestamped **2026-08-24 07:59–08:14**
(`plumber`, `electrician`, `cnc operator`, `carpenter`, `milling`). `record_unresolved` is
reachable only from inside `canonicalize_skill`, and every caller is flag-gated — so
**canonicalization is running in production**, contradicting the `False` default at
`config.py:384`. That is a separate finding and is flagged below.

**H — intentional or accidental? ACCIDENTAL, and the audit trail proves it.**

- **2026-07-31 `5f8e0f56`** authored hop 2. Its own message scopes the bridge: *"exhaustive over
  SKILL_CORPUS"*. `skill_chassis_fitting` is a growth-corpus id — outside the question.
- **2026-08-18 `01fc510c`** authored hop 1 (TD-06). Its verification line reads: *"@badabhai/taxonomy
  and @badabhai/match-engine unchanged and still green (**neither package touches the growth
  corpus**)."* **The author checked for matching impact and concluded there was none.**
- The register's own ratification condition was never met — `phase-9-master-plan.md`: *"TD-06 …
  **evidence never supplied; applied by owner ratification**."*
- The question the team habitually asks is *"does the id I am creating need a bridge entry?"*
  (asked explicitly for TD-01). TD-06 creates no id — it points at one that already has one. The
  check never fired.
- **Negative evidence:** `grep -rn "chassis" packages/taxonomy/src/` → no hits. No ADR, register
  entry, commit or comment anywhere says chassis fitting should imply Fitter.

---

## 5. Safety classification and options

> ### **B — safe only after an additional owner decision.**

Not **A**: a live path confers a posting-level claim nobody reviewed. Not **C**: `mskill_fitter`
exists and is plausibly the right target. Not **D**: there is nothing to migrate. Not **E**: the
semantics genuinely support chassis fitting → mechanical assembly → Fitter, so "unsafe" overstates
it.

**It is B because the only missing thing is a human saying "yes, chassis-fitting experience
entitles a worker to be offered Fitter vacancies."** No measurement can supply that.

### Options — corrected for §2

- **A — ratify the widening.** Record that chassis fitting implies Fitter. Nothing to execute;
  the behaviour already exists. Cheapest, and the semantics support it.
- **B — break the route.** The only reliable break is at hop 2 or at the alias: remove the
  subject's aliases from retrieval, or give the successor a mapping that does not imply Fitter.
  Note re-pointing `replaced_by` **does not work** — retrieval never reads it.
- **C — re-point `replaced_by` to a `[]` successor.** Tidies the crosswalk and **does not contain
  the live route**. Cosmetic against this finding.
- **D — ~~forbid the retag until decided~~. FALSIFIED.** Measured in §2: the claim is reachable
  now, on three canonical domains and the legacy slug, with no retag. Forbidding the retag
  contains nothing.

**RECOMMENDATION: A, decided explicitly.** The behaviour is already live and the semantics are
defensible; what is missing is the record that a human chose it. If the answer is *no*, then the
work is **B**, and it is larger than a crosswalk edit.

**OWNER DECISION: PENDING.** Not actioned — every option is a production mutation or a code change
to the bridge.

### Separately, and not part of D-7B

`SKILL_CANONICALIZE_ENABLED` appears to be **on** in the running ai-service while `config.py`
defaults it `False` and the recorded owner posture says off. That governs whether §2's assignment
actually fires. **Escalated, not investigated here.**

---

## 6. What was built

- `db:audit:crosswalk-chain` — prints every hop separately and refuses to summarise them into
  one arrow. Read-only, zero spend, reproducible.
- `d7b-chassis-crosswalk.test.ts` — 13 tests. The load-bearing ones: **no `replaced_by` anywhere
  may name an `mskill_*`** (the schema would permit it — it is a self-FK to `skill`, and
  `mskill_*` rows live in the same table); the claim must come from the successor's entry, never
  the subject's; the widening must be surfaced and flagged for an owner; the audit universe must
  stay the **union** of both corpora, with an explicit assertion that the `SKILL_CORPUS`-only
  scope is blind to this skill; and the subject must not gain a direct bridge entry silently.
- D-7A and D-7C protections re-asserted unchanged in the same file.

## 7. Gates

```
RESOLVABLE_ABOVE_FLOOR    FAIL — 62/96      unchanged
NO_REGRESSION             FAIL              unchanged
PROMOTION CANDIDATES      0                 unchanged
```

§5a (the D6-0 anchor-path defect) is independent of this task and remains **OWNER DECISION:
PENDING**. Nothing here touched the 22 aliases, their domains, their embeddings, the floor, or
`skill_canonicalize_enabled`.
