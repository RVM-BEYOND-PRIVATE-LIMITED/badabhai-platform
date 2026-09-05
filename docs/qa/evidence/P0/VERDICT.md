FAIL

# P0 — RVM Taxonomy Worksheet · VERDICT

## Header — what was checked, and the staleness of it

| | |
|---|---|
| **PHASE-ID** | P0 |
| **INVARIANT** (from `docs/agent/phases/P0_CHECK.md`) | *the worksheet contains zero decisions. Only proposals.* |
| **SHA checked** | `fb134c4a18e07f523511b0148eebc1eeb3b6beed` |
| **That SHA is STALE, and grew staler during the check** | At 13:40 `origin/main` was `3ad78b2926b6e0a8c8e49e993dc482f9e04c65d2` — **48 commits ahead**. By 14:0x it was `38213481badff181fc6d4d145d7eeffa56caa531` — **52 commits ahead**. The branch moved twice while this check ran. No remote object was ever fetched into this clone. |
| **Staleness reviewed — and the exact limit of that review** | I reviewed the delta `fb134c4a…3ad78b29`: 139 files, **none** a Part D deliverable; three migrations (0095, 0096, 0097), none `matching_catalog` or draft tables. That review is complete **for that range only**. It does **not** cover the 4 commits that landed afterwards, one of which is `6f377032` (#1385) — see *Rulings partly answered in code* below. |
| **Scope of every "at HEAD" statement below** | **A snapshot claim, not a branch claim.** Every assertion in this VERDICT describes `fb134c4a`. None of them is an assertion about `origin/main`. |
| **Artifact** | `docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md` — 768 lines, 67,321 bytes, **untracked** |
| **Artifact sha256** | `50e8a7df64ca6816c2d3348532ff6bd2eb0d244308d40df7e3502fd8a54e62d4` |
| **Artifact mtime** | 2026-09-02 13:18:26.908418800 +0530 |
| **`PARKED.md` sha256** | `e0d1cb18f9ad8983fb161abadbfc90580c1fe74c875dcf757b62b1c620a235ea` (mtime 13:02:25) |
| **Artifact stability** | sha256 re-taken at 13:42 was byte-identical to the sha256 taken at 13:27. The artifact did not change during the check. |

Existence gate passed — the artifacts exist. The check proceeded.

**The INVARIANT itself holds.** The phase fails on item 4 and on defects 1–4 below, not on the invariant.

---

## Result of each P0_CHECK item

| Item | Subject | Result |
|---|---|---|
| 1 | Function values against the locked list | PASS |
| 2 | Collar tiers among the four allowed | PASS |
| 3 | Every VERDICT and signature column empty | PASS |
| 4 | R1–R7 each have ≥2 options and a stated later cost | **FAIL** |
| 5 | Three overlapping roles named with colliding aliases | PASS |
| 6 | The 21-vs-22 and Design-domain questions both raised | PASS |

---

## Defects — ranked by consequence (owner's confirmed ranking)

| Rank | Defect | Why here |
|---|---|---|
| **4** | R5's recall benefit is illusory | Signature obtained on a false premise, invisible after the fact. |
| **2** | Helper blast radius stated 8; it is 11, enumerated two different ways | Sets the platform floor. RVM signs against a number wrong three ways. |
| **1** | R7 option (a) states no later cost | Recoverable — RVM can ask. |

**Two candidate defects were raised during this check and retracted before this document was
final** — the alias pre-approval claim, and defect 3 (the count question's two boxes), which was
at one point ranked most severe. Both are recorded in full under *Retracted findings*, with the
measurements that killed them. Neither was deleted.

### The evidence behind these three is uneven, deliberately

Defects 4, 2 and 1 have **not** faced the adversarial verification stage. That is an owner ruling
on consequence, not an oversight:

- Defect 3 was sent to verification because it drove **immutable `skill_id` allocation** — the one
  thing in P0 that cannot be undone. It did not survive.
- Defects 4, 2 and 1 are each recoverable in one correction round. A wrong count, a missing cost
  cell and an overstated benefit each cost RVM a question; none costs anything permanent.
  Asymmetric consequence justified asymmetric scrutiny; verifying all three would have been
  scrutiny for its own sake.

**They are therefore unrefuted, not confirmed-by-challenge.** Both findings that did face that
stage died — 17 of 17 in the first round, 4 of 4 in the second. The build agent should know the
evidence is uneven and act on these three anyway.

---

## DEFECT 4 — R5's recall benefit is illusory (signature on a false premise)

Two claims must stay separate. The build agent must **not** "fix" the first.

- **CORRECT — leave alone.** The worksheet's correction of the spec. Spec §A10 says welders are
  unmatchable; they are matchable at HEAD. Verified: commit `41d0cb7` exists and its own subject
  reads `fix(ai-service): TAX-WELD-1 — welding is invisible to the gazetteer [HOLD: needs owner
  ruling on role_welder] (#412)`; `_assign_welding_role` is at
  `apps/ai-service/app/profiling/signals.py:1695`; `apps/ai-service/tests/test_welding_gazetteer.py`
  exists; `packages/reach-engine/src/scoring.ts:155` returns `{ raw: 0.4, reason: "trade not stated
  yet (can ask in chat)" }`.
- **WRONG — defect 4.** The account of what remains open.

Worksheet line 647 names three phrases as not shipped and needing RVM ratification. Executed against
the live matcher at `fb134c4a`:

```
$ python -c "
import sys; sys.path.insert(0,'apps/ai-service')
from app.profiling.signals import _WELDING_RE
for p in ['welding karta hun','welding wala kaam','gas wali welding','welding ka kaam',
          'TIG aur MIG machine chala leta hun','main fitter hun']:
    hits=sorted({sk for rx,lab,sk in _WELDING_RE if rx.search(p)})
    print('  %-38s -> %s' % (repr(p), hits if hits else 'NO MATCH'))"

  'welding karta hun'                    -> ['skill_welder_occupation']
  'welding wala kaam'                    -> ['skill_welder_occupation']
  'gas wali welding'                     -> ['skill_welder_occupation']
  'welding ka kaam'                      -> ['skill_welder_occupation']
  'TIG aur MIG machine chala leta hun'   -> ['skill_mig_welding', 'skill_tig_welding']
  'main fitter hun'                      -> NO MATCH          <-- NEGATIVE CONTROL
```

The negative control returns no match, so the harness is not vacuous. All three phrases already
resolve today, via a bare word-bounded pattern:

```
  pattern={'source': 'welder',  'flags': 'i'} label=welding skill=skill_welder_occupation
  pattern={'source': 'welding', 'flags': 'i'} label=welding skill=skill_welder_occupation
```

The TAX-WELD-1 header comment in `signals.py` says so itself: *"is covered by the plain 'welding'
keyword."*

**Consequence.** R5 option (a)'s stated benefit — *"Recall improves on the phrases workers actually
use"* — buys nothing. The CEO signs expecting a recall gain that does not exist, and nothing in the
sheet would ever reveal it.

---

## DEFECT 2 — Helper blast radius: stated 8, actually 11, enumerated two different ways

**Fix from this list. Do not re-derive it — that risks a fourth number.**

### Ground truth — `BadaBhai_Role_Taxonomy_Master.pdf`, page 3, 11 roles

| # | Role | Ladder as printed |
|---|---|---|
| 1 | Conventional Machinist | Helper → Operator → Skilled |
| 2 | Welder | Helper → Welder → Certified Welder |
| 3 | Fitter | Helper → Fitter → Senior Fitter |
| 4 | Sheet Metal Worker | Helper → Operator → Skilled |
| 5 | Assembly Line Worker | Helper → Operator → Skilled |
| 6 | Maintenance Technician | Helper → Technician → Senior Technician |
| 7 | Industrial Electrician | Helper → Electrician → Senior |
| 8 | Press / Machine Operator | Helper → Operator → Setter |
| 9 | Painter / Powder Coating | Helper → Operator → Skilled |
| 10 | Blow Moulding / Extrusion Operator | Helper → Operator → Setter |
| 11 | Rubber Moulding / Compression Operator | Helper → Operator → Setter |

```
  TOTAL Helper ladders in source: 11
```

### The three conflicting figures in the worksheet, with the line each came from

| Figure | Source line | What it is |
|---|---|---|
| **8** | line 155 — *"**Affects 8 roles** — see R1 sub-question (i)"* | stated number, Unmapped-rungs table |
| **8** | line 357 — *"It appears in **8 of 21 ladders**"* | stated number, R1 sub-question (i) |
| **10** | lines 357–359 — the parenthesised list | enumeration in R1(i) |
| **7** | lines 155, 162, 166 — the Helper rows of the Unmapped-rungs table | enumeration in the table |

### Set deltas

```
SOURCE (Role_Taxonomy_Master p3):        11 roles
worksheet line 357-359 enumeration:      10 roles
worksheet lines 155/162/166 (unmapped):   7 roles
worksheet STATED number (lines 155,357):  8

MISSING from line 357-359 list (1):
   - Painter / Powder Coating

MISSING from unmapped table (4):
   - Fitter
   - Industrial Electrician
   - Maintenance Technician
   - Welder

CONCLUSION: four distinct numbers in play -> 7, 8, 10, and the true 11
```

**Consequence.** Sub-question (i) says *"One answer settles all of them"*, and §21 Axis B makes collar
tier *"how you decide what's too low for the platform."* RVM signs against a stated blast radius that
is wrong, and two of the highest-supply trades — Welder and Fitter — are absent from one of the two lists.

---

## DEFECT 1 — R7 option (a) states no later cost

`P0_BUILD.md`: each R-block states *"what **each** option costs later."*

```
| **(a)** | **Facet.** `?facet=controller:fanuc` → same candidate set, same count; matching
           candidates lead; badge reads "14 of 62 match Fanuc." Never scored, never ranked,
           never removes anyone.
         | Satisfies "relevance sorts, never blocks" while giving the employer what they
           need **before** spending. Config-driven per role from the closed attribute whitelist.

| **(b)** | Pure display-only (status quo).
         | The employer discovers the mismatch **after** paying. Repeat-unlock rate and the
           hero metric both absorb it.

| **(c)** | Hard filter.
         | Violates "relevance sorts, never blocks." Also shrinks lists below the 70-candidate
           floor where the hot tag is already suppressed for small-pool honesty — a filtered
           list of 6 is worse than a sorted list of 62.
```

(b) and (c) state real costs. **(a) — the recommended option — states two benefits and one
implementation note.** The only post-table sentence is a further benefit: *"It is the only option
that changes order without changing membership."* Nothing in R7 prices (a).

Same empty cost cell occurs at R5(a) and R6(a), but both are rescued by prose outside the table
(R5 at lines 657–662, R6 at 691–699). R7 is not rescued. Recorded as CONCERN, not FAIL.

**Promoted to STANDS by owner ruling.** Raised as brief-dependent (see process finding 5); the owner
ruled that the "what each option costs later" requirement is theirs, present in every version issued,
and that the provenance problem affects who wrote the file I checked against, not whether the
requirement was real.

---

## Retracted findings

Recorded rather than deleted, because a retracted finding is part of the record.

### RETRACTED — "the 21-vs-22 count has two independently signable boxes" (was ranked defect 3, most severe)

Raised by me, ranked **first** on the grounds that it drove immutable `skill_id` allocation, and
sent alone to the adversarial verification stage on exactly that consequence logic. **It did not
survive.** Four of four independent lenses refuted it on the same ground, and I then verified the
decisive fact myself.

**What was claimed**, in three parts:

- **(a)** Part 2 "Question 1" (answer box line 243) offers two options; R4-d (verdict box line 611,
  signature 613) offers three, adding *"(c) Row 15 splits into two per §23 … which makes 22."*
- **(b)** The cross-reference is one-way — R4-d cites "Question 1", Q1 never points forward.
- **(c)** Both boxes are independently signable, so RVM can sign "there are 21" in one and "the
  split makes 22" in the other and produce a complete-looking, self-contradicting sheet.

**(a) and (b) are true.** Verified:

```
$ sed -n '215,247p' <worksheet> | grep -c '\*\*(\w)\*\*'     # Question 1 block
2
$ sed -n '596,613p' <worksheet> | grep -c '\*\*(\w)\*\*'     # R4-d block
3
$ sed -n '215,247p' <worksheet> | grep -c "R4"
0
$ sed -n '596,613p' <worksheet> | grep -n "Question 1"
3:The full arithmetic is in **Question 1** above — 1A(4) + 1B(1) + 1C(11) + 1D(5) = 21
```

**(c) is false, and (c) was the entire harm.** Part 2 contains no signature line at all:

```
$ grep -n "^# Part" <worksheet>
96:# Part 1 — The role table
213:# Part 2 — Two direct questions
288:# Part 3 — Rulings R1 to R7
739:# Part 4 — What engineering did NOT decide

$ sed -n '213,287p' <worksheet> | grep -n "Signed"
(no output — Part 2 has NO signature line)

$ sed -n '288,768p' <worksheet> | grep -c "Signed"      # POSITIVE CONTROL
7

every "Signed" line in the document: 385, 441, 464, 613, 665, 705, 734  — all in Part 3
```

Line 243 reads `RVM / CEO answer:` — an **answer** line, not a signature. The count question is
signed exactly **once**, at line 613, under `Signed for all of R4 (RVM):`. The contradictory-
signature scenario cannot occur, because only one of the two boxes is under a signature.

**What survives: nothing, as a defect.** The adjudicating agent returned `claim_survives = false`
and found the claim does not survive narrowing either, because all three sub-assertions are anchored
to the Q1/R4-d pair and that pair cannot produce the described failure. Both remaining
sub-assertions are weaker than I framed them:

- **(a) is a refinement, not a divergence.** R4-d(c) *"Row 15 splits into two…"* is a named
  instantiation of Q1(a) *"A 22nd role exists … **Name it**"*, with R4-a supplying the two names.
  Q1's (a)/(b) is an exhaustive binary over the count, so no R4-d answer is unrepresentable at Q1.
- **(b) is the document's declared convention, applied uniformly.** Question 2 → R3 is the identical
  restate-then-rule shape: `\bR3\b` occurs exactly once in 768 lines (its own heading at 446), so Q2
  never points forward to R3 either, while R3 at 450 points back at Q2. Both ruling blocks state the
  convention in their own voice — line 452 *"The options are restated inline so this block can be
  signed without scrolling"*, line 602 *"Options inline so this block can be signed on its own"*.
  And the sheet declares the hierarchy at lines 19–20: *"**A recommendation is not a ruling.** R1–R7
  are settled only by a signature on the line provided."*

**Basis for closing.** Four refuting lenses returned, all four refuting on sub-assertion (c); a fifth
lens died on an API safeguard error and returned nothing; the adjudicator returned `false`. The
retraction does not rest on that count — it rests on the Part-2 signature measurement above, which I
ran and controlled myself.

**One adjacent observation, surfaced by the adjudicator and NOT verified — do not act on it as a
finding.** It concerns a *different* pair and a smaller mechanism: the count is also decidable at
**R4-a**'s verdict box (line 512) via that block's option (b), and the R4-a ↔ R4-d interlock is
stated in only one direction — line 608 says *"Do not pick (c) here without also picking R4-a (b)"*,
with no reciprocal note at R4-a. This check did **not** test it, and two findings in this session
were raised and retracted; it is recorded at that confidence and nothing more.

### RETRACTED — "40 of 105 aliases were accepted on RVM's behalf" (proposed as an invariant break)

Raised by three of four adversarial hunts, entered into an earlier draft of this VERDICT as the
top-ranked defect, then **killed by the verification stage and by my own re-checking.** Item 3 was
briefly recorded as FAIL on this basis and is restored to PASS.

**What was claimed:** the `[E]` marker ("already exists in code — no RVM effort needed") plus line 173
("only the 65 `[N]` rows strictly need a verdict") pre-approved 40 of 105 aliases and left RVM no row
to strike them; and two `[E]` markers (`welder`, `tool maker`) were factually false.

**Why it dies — three independent grounds, each measured:**

1. **The tick-list is not the record, and says so.** Eleven lines above the quoted text:

   ```
   $ sed -n '170p' docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md
   ## Alias tick-list (an aid — the table above is the record)
   ```

2. **The record table carries all 105 aliases with a verdict column**, so RVM can strike any of them:

   ```
     alias cells across the 21 Part-1 rows: 105
     RVM VERDICT column present in Part 1 : True
   ```

   The claim "the 40 `[E]` aliases have no row anywhere in the document where RVM could strike them"
   is **false**.

3. **Both disputed `[E]` markers are true.** The legend at line 84 says "already exists in **code**",
   not "exists in the two files named at lines 175–181". I scoped my grep to those two files. Widened:

   ```
   $ python -c "... from app.profiling.signals import _WELDING_RE ..."
      'welder' matches -> skill_welder_occupation          <-- a LIVE matching pattern

   $ git show HEAD:packages/db/data/job-domains/nco2015.jsonl | grep -i "tool maker"
   {"source":"nco2015","code":"7222.0200",...,"label_en":"Tool Maker",...,
    "aliases":[{"text":"Tool Maker","lang":"en","source":"nco2015"}]}
   ```

   `welder` is a live pattern resolving to `skill_welder_occupation`; `Tool Maker` is a real alias
   record in the NCO corpus. (The `occupation-gold.jsonl` hit is a comment header, not a record.)

**Consequently also retracted:** the em-dashes at lines 185 and 191 are not pre-filled verdicts. `—`
is not a token in that column's vocabulary (line 174 defines the marks as `A` / `S` / a replacement),
the rows in question have an empty option set, and the column is an aid rather than the record.

**Retained as a CONCERN, unscored:** the phrase "no RVM effort needed" and "not because they need
re-approval" softens the ask on 40 aliases whose provenance is an admitted OR — "seeded … or
ratified" (lines 175–181) — where seeding is an engineering act and only 24 `ratified: true` rows
exist in `wedge-aliases.ts` against 428 seeded aliases in `rvm-aliases.jsonl`. RVM retains the
ability to strike them in the record table, so this is framing, not a decision. Flagged for the
owner, not scored against the phase.

### Not scored — R2 option (c) "Not viable."

Two hunts called this engineering striking an option from RVM's menu, since (a) and (b) both open
"Adopt the §A3 re-cut". Verification refuted it: `BUILD_RULES` itself lists `{Setting/Programming}`
as a dead idea, so engineering is reporting a pre-existing bar rather than issuing a novel verdict.
Both readings recorded; not scored.

---

## What held

Recorded so the build agent does not "fix" things that are correct.

- **The INVARIANT.** No settled decision was found in the worksheet. The one candidate break was
  raised, verified, and retracted (above).
- **Function values** — all inside the locked enum. Distinct values used: `apprentice`, `inspector`,
  `maintenance`, `operator`, `programmer`, `setter`, `setter_programmer`. Out-of-enum: NONE.
  Positive control: the validator flags `engineer`, `helper`, `Senior Fitter` as out-of-enum.
- **Collar tiers** — exactly the four allowed: `elementary`, `semi-skilled`, `skilled trade`,
  `technician`. Out-of-enum: NONE. Positive control: flags `skilled`, `highly skilled`, `trainee`.
- **Part 1 role table** — all 21 RVM VERDICT cells empty (positive control detects a synthetic
  `ACCEPTED`). 7 signature lines, 4 `RVM verdict:` lines and 15 Unmapped-rungs instruction cells all
  blank; positive control confirms the grep catches a filled signature line.
- **No `skill_id` allocated, renamed or deprecated.** Every mention is a reference to the
  immutability rule, an existing code identifier, or a conditional inside an option.
- **Blank function cells** on rows 5, 7, 8, 21 correctly route to Unmapped rungs rather than being
  force-fitted — which is what `P0_BUILD` asked for.
- **Scope.** The build agent wrote exactly two files, both in scope. `docs/operations/COMMANDS.md`
  (mtime 2026-09-01 17:39) and `BADABHAI-CODEBASE-INTELLIGENCE-REPORT.md` (2026-09-01 14:44) both
  predate it by a day.
- **Verified factual citations:** `rvm-aliases.jsonl` lines 411–415 hold the die-maker collision
  exactly as quoted, and `die maker` appears once in the file, at line 414, bound to
  `jd_nco_7222_0200`. All seven role ids named at lines 322–327 exist in code (14–49 files each;
  control id `role_does_not_exist_xyz` = 0). `collar_tier` absent from `packages/db/src` at
  `fb134c4a` (control on that path returns 20 files).
- **No test weakened, skipped or deleted by P0. No migration written or executed by P0.**

---

## Claims that hold only by scope

A claim whose truth depends on `--scope` is the shape of thing that gets quoted later with the scope
stripped off. Each row below is **true as scoped and false if re-scoped**.

| Claim | True of | FALSE of | Measured |
|---|---|---|---|
| `matching_catalog` has **0 hits** | `fb134c4a` (commit) | the **working tree** | commit 0 · working tree **18** files |
| `collar_tier` has **0 hits** | `fb134c4a` (commit) | the **working tree** | commit 0 · working tree **3** files |
| Newest migration is `0094_worker_employment_history.sql` | `fb134c4a` | working tree **and** `origin/main` | HEAD `0094` · working tree `0095_matching_catalog.sql` · origin `0097_silly_roland_deschain.sql` |
| "No Part D artifacts exist" | `fb134c4a` (commit) | the **working tree** | P1 began writing `packages/matching-catalog/` at ~13:34 |
| Worksheet's *"no `function` or `collar_tier` column exists on any table yet"* | true **when written**, 13:18 | the working tree after ~13:34 | the build agent's own claim became false 16 minutes after it was written |
| `docs/decisions/` contains no RVM worksheet | `git ls-tree HEAD` (tracked) | the filesystem | the artifact is **untracked** — process finding 1 |
| `welder` / `tool maker` have **0 hits** | `rvm-aliases.jsonl` + `wedge-aliases.ts` only | **the codebase** | `welder` is a live `_WELDING_RE` pattern; `Tool Maker` is an nco2015 alias — process finding 7 |
| Every "at HEAD" claim in this VERDICT | `fb134c4a` | `origin/main` | 48 commits behind |

Raw:

```
SYMBOL                    HEAD(commit)  WORKING-TREE   origin/main(48 ahead)
-------------------------------------------------------------------------
matching_catalog          0             18             0
resolveMatchTier          0             0              0
collar_tier               0             3              0
job_posting_drafts        0             0              0
affects_matching          0             0              0
exposureBalance           0             0              0

newest migration, by scope
  fb134c4a (HEAD)   : packages/db/migrations/0094_worker_employment_history.sql
  working tree      : packages/db/migrations/0095_matching_catalog.sql
  origin/main       : packages/db/migrations/0097_silly_roland_deschain.sql
```

---

## What I could not verify

### THE LESSON — one class, six instances

> **A check is only as good as the match between its scope and its claim.**
> Every scope-related failure in this check was the same shape: a command was run over one
> scope, and its result was reported as a claim about a wider one. The command was correct.
> The scope was narrower than the sentence it was used to justify. Nothing in the output
> looks wrong when this happens — a narrow negative and a broad negative are the same empty
> result.
>
> **The rule that would have caught all six:** before reporting a negative, write down the
> scope the command actually ran over, and compare it word-by-word against the claim you are
> about to make. If the claim is broader, either widen the command or narrow the claim.
> A positive control proves the command works **inside its scope**; it says nothing about the
> scope being right.
>
> The three directions this took, all in one check: **tracked vs filesystem** (1),
> **presence vs content** (2, 6), **a snapshot vs the branch, and a named file vs the codebase**
> (3, 4, 7). The worst was 7, because a negative scoped too narrowly does not merely miss a
> defect — it **manufactures** one, and sends the build agent to "fix" correct work.

### THE SECOND LESSON — two correct checks that were never composed

> **A defect can hide in the gap between two checks that are each individually right.**
> Retracted defect 3 was not a scoping fault — both underlying checks were correctly scoped and
> both returned correct output. Item 3 enumerated every signature line and showed all seven at
> 385 or later. Item 4 observed that the count question has an answer box at 243 and another at
> 611. **Neither check was wrong. I never joined them** to ask the one question that decides the
> matter: *which of those two boxes is actually under a signature?* The answer was already in my
> own output.
>
> This is a **composition fault**, and it is more dangerous than the scope class, because it
> produced a **false defect ranked first** — scrutiny aimed at correct work — rather than a
> missed one. A scoping error leaves a gap; a composition error fabricates a finding and gives
> it a rank.
>
> **The rule:** when a defect's harm depends on two facts, verify the *conjunction*, not each
> fact separately. Before ranking a finding by consequence, state the harm as a single sentence
> and check every clause of that sentence against the page — including the clauses that feel
> like background.

The six instances below are evidence for the first class. Finding 5 is a third fault
(circularity — neither scope nor composition) and is recorded separately.

**1 · `git ls-tree` cannot see untracked files.**
My first artifact-existence sweep used `git ls-tree -r --name-only HEAD -- docs/decisions` and
reported "P0 not built." The artifact is **untracked**, so that command was structurally incapable of
observing it. **Could not observe:** any artifact created during the session under check.

**2 · The item-4 check counted column headers, not costs.**
I ran `grep -c "What it costs later"` and got 11, then concluded every ruling stated its costs. A
column header existing is not each option having a cost. **Could not observe:** an option whose cost
cell contains only benefits — which is exactly defect 1.

**3 · The HEAD given was 48 commits stale.**
`origin/main` = `3ad78b29`, never fetched here. Reviewed and found not to touch Part D, so P0's
verdict is unaffected. **Could not observe:** anything that landed on the branch after `fb134c4a`.
Per owner instruction the check was **not** re-run against `origin/main`; the finding is that this
check was scoped to a snapshot, not that the snapshot was wrong.

**4 · `git log --since=` silently returned zero commits.**
Git's approxidate fills an unspecified time-of-day from the **current clock**, so `2026-08-29`
resolved to 12:48 that day — 66 minutes after HEAD's 11:42 commit — and excluded everything.

```
$ date
Wed Sep  2 13:38:32 IST 2026
$ git log --all --since='2026-08-29' --oneline | wc -l
0
$ git log --all --since='2026-08-29 00:00:00 +0530' --oneline | wc -l
26
```

Same repo, same moment, 26-commit difference. **Could not observe:** every commit of that morning.
A filter returning zero is not evidence of nothing happening until the filter is proved to work.

**5 · I authored the brief I checked against.**
`docs/agent/phases/P0_BUILD.md` mtime is 13:25:05 — **six minutes after** the 13:18:26 artifact it
supposedly drove. I created it by running the owner's setup script. That is circular: the standard was
written by the judge, after the work. Per owner ruling the file is left exactly as it is — deleting
evidence of a process fault is worse than the fault. **Could not observe:** what the build agent
actually received. Defects 2, 3 and 4 do not depend on it — each is false or self-contradicting on
the worksheet's own terms. Defect 1 was brief-dependent and promoted to STANDS by owner ruling.

**6 · My item-3 check was pointed at the wrong column.**
I enumerated the Part 1 role table (lines 103–123) and grepped signature lines, and never touched the
alias tick-list's `A / S` column at lines 183–205. **Could not observe:** marks outside the Part 1
table. This led me to record item 3 as FAIL on the retracted finding; on re-checking, the Part 1
table is the record and item 3 is PASS. A positive control on the rows I did check proved nothing
about the rows I did not.

**7 · I scoped a negative grep more narrowly than the claim I was testing.**
The `[E]` legend (line 84) says "already exists in **code**". I tested it against only the two files
named in a different paragraph (lines 175–181) and reported `welder` and `tool maker` as 0 hits.
Widened to the codebase, both exist — `welder` as a live `_WELDING_RE` pattern, `Tool Maker` as an
`nco2015.jsonl` alias record. **Could not observe:** any alias seeded outside those two files. This
error reached an earlier draft of this VERDICT and is retracted above. Same class as findings 1 and
6: a negative result is only as broad as the scope it was run against, and a positive control inside
a narrow scope says nothing about a wider claim.

### Asymmetry in how these findings were tested

Only the four adversarial-hunt outputs were submitted to the verification stage. **All 17 verification
agents refuted all 17 candidates they were given — none stood.** That is what killed the retracted
finding.

Defects 1–4 did **not** pass through that stage: defect 1 came from the item-4 check, and defects 2,
3 and 4 from my own analysis, each reproduced here with raw output and controls. They have therefore
had less adversarial scrutiny than the finding that died. Given a verification stage with a 17-for-17
refutation rate, defects 1–4 should be treated as unrefuted rather than as confirmed-by-challenge.

### No executable test guards this invariant

There is no test anywhere that would fail if "the worksheet contains zero decisions" broke.
`git grep -il 'RVM_TAXONOMY_WORKSHEET'` over all tracked files exits 1 (control: `git grep -il 'RVM'`
returns 223 files). P0 is a documentation phase and no such test can exist.

Per the amended `CHECK_RULES.md`: for DOCUMENT phases, verify by direct inspection, record here that
no test guards the invariant, and **do not fail the phase on this criterion or invent a test to
satisfy it.** **P0 was not failed on this criterion.** It failed on item 4 and defects 1–4.

### The tree was contaminated mid-check by a concurrent phase

`git status --short` went from **3 entries at 12:42 to 22 entries at 13:42**. A different agent was
building **P1** in the same working tree: `packages/matching-catalog/`, five
`apps/api/src/match/matching-catalog.*.ts` files, `packages/db/migrations/0095_matching_catalog.sql`
(mtime 13:38:20), and modifications to `packages/db/src/schema/match.ts`, `schema/index.ts`,
`migrations/meta/_journal.json`, `pnpm-lock.yaml`, `tests/e2e/rls-spine.e2e.test.ts`, `README.md`,
`apps/api/package.json`.

Which observations fall on each side of ~13:34:

- **Before** — every worksheet check: sha256, the 21 empty Part 1 verdict cells, function and
  collar-tier extraction, the 7 signature lines, items 4/5/6, the R5 citations against HEAD, and the
  `rvm-aliases.jsonl:414` check.
- **After** — the vernacular execution (defect 4), the alias `[E]` measurements (retracted finding),
  the migration-collision observation, and the 22-entry status.

The worksheet's own sha256 was byte-identical before and after, so **no worksheet finding is affected**.
The repo-wide "0 hits" claims are affected and are itemised under *Claims that hold only by scope*.

**Not a P0 finding, recorded because it is cheap to say now and expensive to discover later:** P1's
`0095_matching_catalog.sql` collides with `origin/main`'s existing `0095_absurd_human_fly.sql`
(origin also has 0096 and 0097). Owner has confirmed this is being handled outside this session.

### Rulings partly answered in code while unsigned on paper

**Recorded as a scope limitation of this check. The check was not re-opened on it.**

The worksheet asks RVM to rule on the function enum, the family re-cut and the role count.
As of `6f37703240c6df10abdcb6d6596ceea8e6f8c14c` (#1385, *"one role descriptor for 21 trades,
Zone 5 capture, and a measurable form funnel"*), those are already defined in code on `main`
and pinned by tests. Verified read-only via the API, without fetching:

```
$ gh api repos/<repo>/contents/apps/api/src/profiling/roles?ref=6f377032 --jq '.[].name'
cam-programmer.role.ts
cnc-grinding.role.ts
cnc-machining-centre.role.ts
cnc-turner.role.ts
role-form-descriptor.ts
role-registry.test.ts
role-registry.ts

$ ... cnc-turner.role.ts | grep -n "levelLadder"
20:  levelLadder: ["Operator", "Setter", "Setter-cum-Programmer", "Programmer"],

$ ... role-form-descriptor.ts | grep -n "ROLE_CLUSTERS"
49:export const ROLE_CLUSTERS = ["machining", "design", "fabrication", "polymer"] as const;
```

Bearing on the open rulings:

- **R1** asks whether to add `setter_programmer` to the function enum. `"Setter-cum-Programmer"`
  already ships as a `levelLadder` rung at `cnc-turner.role.ts:20`.
- **R2** asks RVM to re-cut the families. Four buckets already ship as `ROLE_CLUSTERS` at
  `role-form-descriptor.ts:49`.
- **R4-d** asks whether the count is 21 or 22. The commit describes itself as *"one role
  descriptor for 21 trades"*, with roles **declared before they are enabled** (only `cnc_turner`
  enabled at that commit).

**Why this is a limitation and not a finding against P0.** The build agent worked at `fb134c4a`,
where none of this existed, and `6f377032` landed at 13:50 IST — 32 minutes **after** the
worksheet was written at 13:18:26. The build agent could not have seen it. It is also outside the
`fb134c4a…3ad78b29` delta this check reviewed, because it landed after that head.

**Why it matters anyway.** R1, R2 and R4-d are unsigned on paper while partly settled in code, and
`role-registry.test.ts` pins them. Whoever acts on those rulings must reconcile the signature with
what already ships, or the sheet ratifies one thing and the code enforces another.

### Other limits

- `BadaBhai_Role_Taxonomy_Master.pdf` is **not in the repo** (read from `~/Downloads`). Role-table
  cells marked plain — asserting a 1:1 ladder match — were spot-checked against it for the Helper
  rungs only. I did not verify every plain cell against the source.
- I did not verify all 105 aliases against the alias corpora. `welder`, `tool maker`, the five CNC
  Turner aliases and the five Welder aliases were tested individually; every one of them held once
  the grep was scoped correctly. The remaining `[E]` markers are unverified.
- `pypdf 6.16.2` was pip-installed into the repo's `.venv/` at 12:41:50 today (121 files), by an
  unattributed actor. Not the P0 build agent's output; noted for the record.
- `docs/agent/CHECK_RULES.md` was amended by the owner at 13:41:37, mid-check. The three amendments
  (untracked-artifact visibility, date-bounded git, document-phase invariants) appear **twice**, at
  both ends of the file; owner has confirmed this is their duplication and is deduplicating it
  outside this session. Both copies say the same thing. This VERDICT applies the amended rules.

---

## Nothing was fixed

Per `CHECK_RULES`: no defect in this document was fixed, and no wording was proposed for any of them.
`P0_BUILD.md` was not amended or deleted. The three defective areas of the worksheet — R5's
open-items paragraph, the Helper figures, and R7's cost cell — are left exactly as found for the
build agent.

## P0 is closed

**FAIL**, on item 4 and defects 4, 2 and 1, in that order of consequence.

Two candidate defects were raised and retracted with their measurements on the record. Three
fault classes of my own are named above: **scope-versus-claim** (six instances),
**composition** (one, which produced the retracted top-ranked defect), and **circularity**
(process finding 5). The invariant holds.
