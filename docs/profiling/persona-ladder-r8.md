# R8 — what the live render found, and what fixing it changed

> Packet R8. Five synthetic turners re-run end to end after §1–§4. Every number below is
> measured — the estimator's own numbers are labelled as predictions and checked against the
> millimetres WeasyPrint produced.
>
> Source artifacts: `scripts/persona-harness/out/` (five HTMLs, five PDFs, five `render.json`,
> `manifest.json`, `tier-ladder.json`).

---

## 0 · The correction that comes first

**The five R7 PDFs were rendered on the wrong template.** The persona harness passed
`"bb_trade.v1"` as the template id. The registry id is `bb_trade`; `bb_trade.v1.html` is the
FILE. `getResumeTemplate` resolves an unknown id to the generic fallback rather than throwing —
deliberately, so a bad id degrades a résumé instead of failing it — so all five sheets were
`fallback.v3`, and were measured, reported and delivered as trade sheets.

The harness could not see it. Its assertions were "the HTML contains the worker's name" and
"the HTML is longer than 2000 characters", both true of either layout. It is the same class of
failure the repo has now recorded four times: a verification that cannot observe what it claims.

**What this invalidates from R7:**

| R7 claim                                                             | Status                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| "p4 is 312 mm in a 273 mm page at `degradationStage: 0`"             | **WRONG.** That was the fallback layout. On `bb_trade`, p4 needs 253.74 mm and has **43.26 mm of headroom**. |
| "the one-page contract broke and the degradation ladder never fired" | **WRONG.** No persona degrades; all five are stage 0 and all five are one page.                              |
| "total years wrong on every persona who has any"                     | Stands — mapper-level, template-independent.                                                                 |
| "the own-words block fires for nobody"                               | Stands — mapper-level.                                                                                       |
| "the 9-row cap drops `Tolerance held` for every senior persona"      | Stands — mapper-level. Confirmed again below.                                                                |
| "all six tasks are armed by the local env file"                      | **WRONG in detail.** Five of six. `profile_parse` is not armed.                                              |

The harness now asserts the layout (two markers that exist only in `bb_trade.v1.html`), so this
cannot recur silently.

---

## 1 · Total years — before and after

`experience_years` is a mandatory universal ask (`qp_universal@2`, answer type `duration`) and the
container branch never read it. It printed the sum of the model's per-employment
`duration_months` instead.

| persona            | stated | summed | headline BEFORE         | headline AFTER                                |
| ------------------ | ------ | ------ | ----------------------- | --------------------------------------------- |
| p1 fresh ITI       | 0      | —      | duration not stated     | duration not stated _(unchanged — see below)_ |
| p2 2-year operator | 2      | _null_ | **duration not stated** | **2 yrs**                                     |
| p3 5-year → setter | 5      | 1.7    | **1 yr 8 mo**           | **5 yrs**                                     |
| p4 8-year setter   | 8      | 5.3    | **5 yrs 4 mo**          | **8 yrs**                                     |
| p5 12-year, no ITI | 12     | 9.9    | **9 yrs 11 mo**         | **12 yrs**                                    |

**The rule: the stated figure wins outright; the sum only fills its absence.** Not `Math.max` of
the two — that would satisfy the "never below his stated figure" floor and still print a tenure
larger than the one he claimed, resolving a genuine ambiguity upward, which §8.3 forbids in
exactly those words. Preferring the stated figure satisfies the floor by construction, because
the figure and the floor are the same number.

**Why nothing caught it.** Every term in the sum is worker-stated. Set-membership passes, the
fabrication gate sees only strings it can source, and the sheet's arithmetic is not a string. It
is the provenance-not-placement bound, biting: the gate can tell you a number came from the
worker; it cannot tell you the number answers the question the label asks.

**And the asymmetry rule only guards over-claim.** §8.3 is one-directional by design — "a man
under-described gets a trial and proves himself" — and that is right for a capability. It is not
right for a TOTAL, because a total is not a claim that can be tested at a trial: it is a filter
an employer applies before there is a trial. §5.1 ranks total experience third; a senior man
printed as junior is filtered out and never learns why.

**RECOMMENDATION — yes, the gap deserves its own gate, and it is narrow.** Not a general
"under-representation" checker; a specific invariant with three instances today:

> Where the worker stated a scalar and the sheet prints a derived one, the printed value may not
> be lower than the stated one.

The three are total years (`experience_years` vs summed months), expected salary
(`salary_expected` vs `expected_salary`) and tolerance (`tolerance_band` vs whatever a future
capability row derives). It is checkable in the mapper, it is a property test rather than a
per-field assertion, and it would have failed on four of five personas the day the container
branch shipped. **Proposed, not built** — it is a new gate, and R8 did not ask for one.

**One open wording question, not taken.** p1 stated ZERO years and the sheet prints "duration not
stated". `yearsPhrase` maps 0 to the unknown text, pinned by a test whose comment reserves
"fresher" for a worker who SAID he has no experience — which is precisely p1. Distinguishing a
stated zero from an absent answer is a one-line change and a wording ruling. Recorded, not made.

---

## 2 · The own-words block, wired

**The mechanism: the model proposes, the transcript disposes.** Candidates are the extraction's
own sentences — choosing which of a worker's sentences says something about his trade is exactly
the job §8 licenses the model to do. The veto is the stored transcript: a phrase prints only when
it occurs verbatim inside something the worker actually said. That turns "verbatim" from a claim
about the prompt into a property checked phrase by phrase against bytes the model never touched.

| persona            | quotes printed | candidates vetoed            |
| ------------------ | -------------- | ---------------------------- |
| p1 fresh ITI       | 0              | — (no `experiences` at all)  |
| p2 2-year operator | **3**          | 1                            |
| p3 5-year → setter | 0              | 0 — see the correction below |
| p4 8-year setter   | 0              | 0                            |
| p5 12-year, no ITI | 0              | 0                            |

p2's sheet now carries, in his own Hinglish:

> "CNC lathe chalata hoon" · "Programme load karke part banata hoon" ·
> "Pump ka housing aur shaft banate hain hum, MS aur EN8 me"

**The veto earned its place on the first run.** The model returned seven sentences for p2. Six are
literal fragments of his turns. One — _"Vernier aur micrometer, plug gauge use karta hoon"_ — is a
fusion of two separate answers with a verb he never used. It reads perfectly and it is not his.
Nothing else on the sheet could have caught it.

> **CORRECTION (R9, from an adversarial re-verification of this packet).** The section below
> generalises correctly for p4 and p5 and is WRONG for p3. His `work_done` values are 0 and 8
> characters ("" and "job work") — both under `OWN_WORDS_MIN_CHARS = 18` — so he has no candidates
> at all and the veto never runs on him. The cause is the length floor, not composition.
>
> And the "candidates vetoed" column above reads 0 for p4 and p5 because `notVerbatim` is computed
> but never written to `render.json`. Re-derived, it is **10 for p4 and 6 for p5**. The column was
> unmeasured rather than measured-as-zero, which is the worse of the two errors: it read as
> evidence that the model quotes those workers faithfully, when in fact it composed sixteen
> sentences the veto threw away.

### The finding underneath, and it is the reason the other four are empty

**The extraction only preserves the worker's voice for the shortest transcript.** p2's `work_done`
is his Hinglish. p3's, p4's and p5's are English prose the model composed:

> p4: _"Full setting including tool offset, work offset, nose radius compensation, jaw change,
> tailstock set करना, first piece approval. Setting up new jobs. Operating CNC lathe with Fanuc
> and Siemens controllers…"_ — 600 characters, English, with one Devanagari verb left in.

So the veto is doing its job by giving them nothing: none of it is what those men said. §8.4's
block is wired and correct; the extraction is what is not producing quotable material for anyone
past a short interview.

**p1 is the sharper gap.** The fresh ITI pass-out has 124.99 mm of headroom — the emptiest page in
the set — and cannot get a quote at all, because candidates come from `experiences[]` and a
fresher has none. He is exactly the worker §8.4's "off-wedge résumés work on day one" is about.
Filling his page needs a transcript-side selector, and _which_ sentence to print is a design
decision rather than a mechanical one, so it is raised rather than guessed.

---

## 3 · The one-page contract, measured rather than estimated

The old check was `sheetContentLines(sheet) <= SHEET_LINE_BUDGET` — the estimator marking its own
homework. A model that under-counts a term passes that on every shape while the PDF is two pages.

**What replaced it.** The emit test now writes the estimator's PREDICTED headroom beside each
sheet, and `measure-sheet-headroom.py` compares it with the millimetres WeasyPrint produced,
failing when the prediction is OPTIMISTIC by more than 2 mm — the one direction that ships a
two-page résumé. Verified by tampering a manifest entry: exit 1 with the sheet named. The personas
now write the same manifest shape, so the same gate covers them.

### Re-measured — 56 fixture sheets

```
sheets=56  one-page=56  over=0  floor=5.00mm
worst headroom: 11.17 mm            (future-09-worker, stage 5)
estimator residual (measured − predicted):
    worst  +8.47 mm (shape-08-worker)
    best  +39.57 mm (shape-14-worker)
```

**The floor holds, and the R2/R3 numbers stand unchanged.** The 11.17 mm worst case is the same
number R2 recorded.

**Every residual is POSITIVE — the estimator is conservative everywhere**, by 8 to 40 mm. It never
believes it has room it lacks. That is the safe direction and the one `SHEET_LINE_BUDGET` was
deliberately rounded toward.

It is also over-conservative, and that has a cost worth recording: `shape-09-worker` degrades to
**stage 3**, dropping materials chips, languages AND documents-ready, on a sheet whose real render
has **16.56 mm** to spare. Three §5.1-ranked rows come off a page that could hold them. Not a
defect — the ladder is doing what it was told — but the budget is fitted to a worst-case constant
of 209 mm when the measured constants run 217–249, and re-fitting it would give several sheets a
row back. **Proposed, not done:** it changes what every worker's sheet contains, and the residual
data to re-fit it now exists in one place for the first time.

### Re-measured — the five personas

```
sheets=5  one-page=5  over=0  floor=5.00mm
worst headroom: 43.42 mm
```

| persona            | measured headroom | predicted | residual | stage |
| ------------------ | ----------------- | --------- | -------- | ----- |
| p1 fresh ITI       | 124.99 mm         | 115.76    | +9.23    | 0     |
| p2 2-year operator | 66.13 mm          | 58.44     | +7.69    | 0     |
| p3 5-year → setter | 75.17 mm          | 62.65     | +12.52   | 0     |
| p4 8-year setter   | **43.42 mm**      | 28.42     | +15.00   | 0     |
| p5 12-year, no ITI | 54.09 mm          | 38.20     | +15.89   | 0     |

**No persona degrades and none is close to the floor.** The senior profile the ladder was supposed
to be failing is 43 mm clear.

### Tolerance held — recorded against Q2, order unchanged

`CAPABILITY_ROW_BUDGET` is 9, measured from the three ratified sheets. `qp_cnc_turning` defines 14
capability rows, and the budget keeps the 9 with the LOWEST §5.1 rank. `tolerance_band` is rank
62; the 9 that survive on p4 are ranks 21–51 plus 42/41/43/44. So:

> **p4 (8-year setter, ±0.01 mm) and p5 (12 years, ±0.02 mm) both hold a tolerance and neither
> sheet prints it.**

That is measured evidence on the exact question NEEDS_PRAKASH **Q2** puts to RVM — whether
tolerance held or machine capability is the stronger pay signal for a turner. If tolerance ranks
above `workholding` (42) or `measuring_tools` (51) for a hiring supervisor, the rank is wrong, not
the budget. **Recorded against Q2. The drop order is unchanged.**

---

## 4 · The transcript veto

A chip tick is a claim; an explicit negation in the worker's own transcript withdraws it.

**Result across all five personas: 0 vetoes, 0 false vetoes.** Their authored chip sets are honest
— which is the correct outcome and the more important half of the measurement. A veto DELETES a
claim from a man's résumé, so what the rule PERMITS matters more than what it catches.

### The false veto it produced first, and what it changed

The first version fired once, on p3, and it was **wrong**:

> p3: _"Naya programme nahi likhta, **par** jo chal raha hai usme edit kar leta hoon."_
> — I don't WRITE new programmes, but I EDIT the running one.
>
> Vetoed: `programming_level = edit_program` — the claim that sentence AFFIRMS.

The negated clause carries the attribute-wide term "programme", so an attribute-wide veto reached
every programming slug. That is the total-years failure pointed the other way: a true claim
deleted from a man's résumé by his own honest qualification of it.

**The rule that fixed it:** _"naya programme"_ is a `write_program` term, so the clause is a
statement about THAT slug and the attribute-wide reach does not apply to any other. Three tiers:

1. a negation naming the slug is **final** — nothing rescues it;
2. an attribute-wide negation reaches a slug only when the clause names no OTHER slug;
3. a slug the worker separately affirmed by name **survives** an attribute-wide denial.

Tier 3 is what keeps p2's `Tool offset`: he says _"khud se setting nahi karta"_ two clauses after
_"Offset thoda bahut dekh leta hoon"_, and §8.3's own table maps that phrase to a setting
capability.

### What it catches, on the hostile claim sets

Against the R7 anchoring experiment's simulated over-claim sheets — the ones where the model,
role-playing p2 under job-seeking pressure, ticked `setting_operation | Tool offset` 5 runs out of
5 — the veto withdraws `first_piece` and `jaw_change` on the strength of _"khud se setting nahi
karta"_, and keeps `tool_offset`. That is the intended split.

### Deliberate limits

- **Clause scope, not turn scope.** "…jab supervisor bolte hain, **par** khud se setting nahi
  karta" is one sentence carrying a positive claim and a denial of a different capability. Scoped
  to the sentence, the denial cancels the offset claim.
- **`"dekha hai"` is a marker; `"dekh leta hoon"` is not.** "I have seen it done" vs "I do look at
  it". A stemmer collapses them and deletes a true capability. Phrases are matched whole.
- **No hedge is a marker.** §8.4: "sab kar leta hoon" resolves to nothing, not to a denial.
  "sirf", "thoda", "kabhi kabhi" are all absent from the list on purpose.
- **Only the CNC turning pack has a gazetteer.** An unauthored trade is not vetoed at all. The
  cost of no veto is an over-claim that reaches a trial; the cost of a guessed veto is a true
  claim deleted by a term list nobody in that trade reviewed.
- **Not a matching input.** It changes what PRINTS. The stored `worker_attributes` rows are
  untouched and the match engine still reads the tick as given — a veto that silently narrowed a
  worker's reach would cost him postings on a heuristic. Whether the same cross-check belongs in
  matching is a separate ruling.

Every veto is logged with the attribute, the slug and the triggering clause verbatim.

---

## 5 · Two unknowns

### 5.1 — How many real interviews were discarded as mock

**`is_mock` is not stored anywhere, so the question cannot be asked the way it was posed.** The
ai-service computes `is_mock = not meta.real_call`, and `profile-extraction.processor.ts`
documents at length why it is deliberately NOT persisted or keyed off: it is a reachability probe,
true for every good deterministic extraction while `AI_ENABLE_REAL_CALLS=false`, which is the
committed default. Keying anything off it would mean no worker reaches "extracted" outside a
real-provider environment.

The question has to be asked **structurally** instead, and it can be, from three tables that do
persist:

```
a real extraction   ai_jobs.job_type='profile_extraction' AND real_call IS TRUE
a real interview    >= 4 inbound chat_messages with body text
nothing stored      worker_profiles.raw_profile -> 'resume_profile' IS NULL
```

`scripts/count-discarded-interviews.sql` is that query. **Validated against the real schema on a
local database with a three-worker fixture** — one discarded, one healthy, one who abandoned after
two turns — and it discriminates all three correctly. It is read-only and returns ids and counts
only, never a name or a number.

**I have not run it against production, and I am not going to without a decision.** The root env
file's `DATABASE_URL` points at production — the TD65 boot guard exists because of exactly that —
and reading live worker rows is outside what R8 authorises. What is needed:

- **a read-only connection string to the production database**, or someone running the file and
  pasting back the six-column summary. The per-worker listing is the repair list; the summary
  alone answers the question.

**One caveat, stated rather than buried:** it is a CANDIDATE count. A genuinely `blocked`
extraction (a pseudonymisation failure) and a deadline breach also store a null overlay. Both are
rarer than this bug and both are worth finding anyway; splitting them means reading
`ai_jobs.output_ref` / `error_message` on the sample.

### 5.2 — One command for effective flag state

`scripts/effective-ai-flags.py`. It resolves the whole chain in precedence order — code default →
ai-service env file → process environment — reports which layer won for each name, prints the two
compose files' literals **separately and labelled as a container's environment rather than this
process's**, and never prints a secret value (keys are reported as `set (NN chars)`).

Run on this box right now:

```
BOOT REFUSAL (the service would NOT start as configured)
  REFUSING TO BOOT: skill canonicalization is ENABLED and the skill-store seam is
  wired at a LOOPBACK api.

EFFECTIVE ON THIS MACHINE
  real calls        : ENABLED
  armed tasks       : profile_extraction, profiling_chat_turn, skill_embedding,
                      stt_transcription, tts_synthesis
  unarmed tasks     : profile_parse
  chat model tier   : pro
  synthetic persona : off

WHICH LAYER WON
  AI_ENABLE_REAL_CALLS         apps/ai-service env file
  AI_REAL_CALLS_KILL_SWITCH    code default
  AI_REAL_CALL_TASKS           apps/ai-service env file
  AI_CHAT_MODEL_TIER           code default
```

It corrects R7's own report in its first four lines: **five of six tasks, not six.**
`profile_parse` is not armed.

It also surfaces something no previous report mentioned: **the ai-service will not boot as
configured on this machine.** The TD65 guard refuses, and every AI result produced here has come
from a process that stepped around it with `SKILL_CANONICALIZE_ENABLED=false`. That is the correct
developer answer and it is now printed rather than known.

---

## 6 · Model tier — measured, not re-tiered

`ai_chat_model_tier` is `pro`; `default_pro_model` is `gemini-2.5-pro`, which the provider has
**retired**: `404 — "no longer available to new users … use models/gemini-3.1-pro-preview"`. Every
chat turn therefore fails twice on Gemini and falls through to `claude-haiku-4-5`.

Harness only. Nothing staged or deployed was touched. Two runs, and they answer two different
questions — the second one accidentally, and better.

**Run A — the tier comparison** (first run, before the account's Gemini quota was exhausted):

| arm                | model that answered               | median      | p90     |
| ------------------ | --------------------------------- | ----------- | ------- |
| `pro` (production) | `claude-haiku-4-5`, after 2× 404  | **3306 ms** | 3335 ms |
| `capable`          | `gemini-2.5-flash`, first attempt | **1963 ms** | 2063 ms |

**Run B — the retry cost, isolated.** A later paired run found Google under a 60-second rate-limit
cooldown, so the `capable` arm SKIPPED its Gemini candidate outright and both arms were answered
by Haiku. As a tier comparison that is worthless and the script says so. As a measurement of the
404 retries it is cleaner than run A, because the answering model is now a control:

| arm       | model that answered | Gemini attempts             | median      |
| --------- | ------------------- | --------------------------- | ----------- |
| `pro`     | `claude-haiku-4-5`  | 2 × 404 to `gemini-2.5-pro` | **4306 ms** |
| `capable` | `claude-haiku-4-5`  | 0 (candidate skipped)       | **2410 ms** |

**~1.9 s per turn is pure retry waste** — same model, same prompt, same turns; the only difference
is two round-trips to an endpoint that cannot answer. On every message, on a mid-range Android on
a shop floor. An 11-ask interview pays it eleven times.

Run A's 1.35 s gap is the smaller number of the two because a reachable Flash is also faster than
Haiku; run B says how much of the delay is the dead endpoint alone.

**Quality: no measurable difference, and the mechanical checks are not sensitive enough to say
more.** Both arms produce one question per turn within the word limit at similar rates. Two real
observations:

- Haiku wraps its reply in a ` ```json ` fence with a `reply_text` key; Flash returns a bare
  string. Production parses through `coerce_json_text`, so both work — but they are different
  response shapes and only one of them was ever validated.
- The account's Gemini quota rate-limits at roughly ten requests in quick succession, and each 429
  arms a 60-second provider cooldown that sends the rest of the arm to Anthropic. That is a real
  operational fact about a Flash-tier chat path, and it belongs in the ruling.

**The tier comparison collapsed twice and the script now refuses to present it as one.** Under a
provider cooldown the `capable` arm is answered entirely by Haiku — the same model as `pro` — and
every per-turn check still passes, because `meta.real_call` is TRUE for a cross-provider fallback.
The table read as a clean A/B of two tiers that were one model. `tier_ladder.py` now errors when
both arms share a model set and exits non-zero. Run B above is that failure, kept and reported for
the different question it does answer — but it is not, and is not offered as, a tier comparison.

### Does this change any earlier conclusion?

**Every quality judgement made about this interview has been about Haiku, unknowingly** — R5's
persona work, R6's ask-budget corpus reasoning, R7's five extractions. Two answers:

- **The EXTRACTIONS are unaffected.** `profile_extraction` routes through `default_capable_model`
  = `gemini-2.5-flash`, which is reachable and is what actually answered all five personas
  (`run.model_name` in each artifact says so). Everything in §1–§4 above stands.
- **The CHAT-TURN judgements are all about Haiku.** #1237's stated purpose — "this is the model a
  worker actually meets" — has not been true since it merged. Nothing in R5–R8 evaluated
  `gemini-2.5-pro` on a single turn, because no such turn ever happened.

---

## 7 · Acceptance — does a real turner look like the Ramesh sample?

Five new PDFs, all `bb_trade`, all one page, all stage 0.

|                          | p1 fresh ITI | p2 2-year    | p3 5-year  | p4 8-year  | p5 12-year |
| ------------------------ | ------------ | ------------ | ---------- | ---------- | ---------- |
| total years              | _stated 0_   | **2 yrs**    | **5 yrs**  | **8 yrs**  | **12 yrs** |
| own words                | —            | **3 quotes** | —          | —          | —          |
| capability rows          | 4            | 7            | 9 (capped) | 9 (capped) | 9 (capped) |
| `Tolerance held` printed | n/a          | n/a          | **no**     | **no**     | **no**     |
| work history             | —            | 1 employer   | 2          | 3          | 3          |
| headroom                 | 124.99 mm    | 66.13 mm     | 75.17 mm   | 43.42 mm   | 54.09 mm   |
| pages                    | 1            | 1            | 1          | 1          | 1          |

**Does p2's page still have a hole in it? Yes, but a smaller one.** 66 mm of a 297 mm page is
still empty — the quotes bought him about 15 mm. What is missing from his sheet is not layout, it
is capture: no certificates, no languages, no documents-ready row, no tolerance, and no work-done
detail beyond one line. His transcript contains at least one strong claim nobody stores —
_"do saal me ek bhi din bina batae nahi chhoda"_ (two years, not one unexplained absence) — which
is precisely the kind of thing a small employer hires on and which the extraction drops entirely.

**p1's page is the real hole.** 125 mm empty, four capability rows, no employment, no quotes. The
fresh ITI pass-out is the worker this product exists for and the one the sheet currently serves
worst.

---

## 8 · Proposed, not applied

Per R8 §8 and R7 §7 — nothing below is built:

- the R7 branching proposal, persona-2 skip list and `16 + tier_bonus` budget rule
  (`persona-ladder-r7.md`, still awaiting review);
- the under-representation gate (§1);
- re-fitting `SHEET_LINE_BUDGET` against the residual data (§3);
- a transcript-side own-words selector for workers with no `experiences[]` (§2);
- any tier change (§6) — measured only;
- the drop order (§3) — unchanged, `Tolerance held` recorded against Q2.
