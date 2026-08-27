# Authoring a role pack

How to add deep, role-specific profiling for one trade — the thing that turns a generic
eight-question interview into a resume an employer will act on.

`qp_cnc_turning@1` is the worked example. Read it beside this guide.

> **Scope.** A role pack is **data**. Adding a role is authoring JSON + a review, not a code
> change and not a deploy of new logic. If you find yourself needing an engine change, stop and
> re-read [The ask budget](#3-the-ask-budget) and [Field routing](#5-field-routing) — nearly every
> "I need code" turns out to be a predicate or a target-kind choice.

---

## 1. When to author one

Author a role pack when a trade has **depth a generic pack cannot ask**: vocabulary, capability
levels, or equipment that only matter inside that role, and that an employer screens on.

Do **not** author one to add trade-agnostic questions (documents, languages, certificates). Those
belong in `qp_universal` and are covered in [Known gaps](#9-known-gaps).

The existing generic pack for the family stays exactly as it is. A role pack sits _beside_ it and
is picked only for workers who resolve to that specific occupation. Nothing else regresses.

---

## 2. Activation: bind to a job domain, never to an ISCO unit

This is the part that is easy to get wrong, and it fails loudly at build time.

Families and bindings live in `packages/db/data/question-packs/_families.jsonl`.

```jsonc
{"kind":"family","family_id":"fam_cnc_turning","label_en":"Turning (CNC and conventional)",
 "label_hi":"टर्निंग और खराद",
 "canonical_role_id":"role_cnc_turner_operator","industry_id":"ind_industrial_manufacturing"}
{"kind":"binding","family_id":"fam_cnc_turning","job_domain_id":"jd_nco_7223_6001"}  // CNC Setter cum Operator-Turning
{"kind":"binding","family_id":"fam_cnc_turning","job_domain_id":"jd_nco_7223_6002"}  // CNC Operator-Turning
{"kind":"binding","family_id":"fam_cnc_turning","job_domain_id":"jd_nco_7223_0601"}  // Turner/Conventional Turning
{"kind":"binding","family_id":"fam_cnc_turning","job_domain_id":"jd_nco_7223_0701"}  // Lathe Machinist
```

`label_hi` is what the worker is SHOWN when the engine confirms their trade, so it must be the word
they would use — "टर्निंग और खराद", not a transliteration of the NCO title.

**Two families may never claim the same target.** `fam_machining` already binds
`isco_unit_code: "7223"`, so a second family binding 7223 is rejected by the corpus validator:

> `target unit:7223 is already claimed by fam_machining. Two families cannot bind the same
target — most-specific-wins would silently pick one and that trade would get the wrong interview.`

Bind to the **NCO occupation(s)** instead. `job_domain_id` carries specificity **50**; an ISCO unit
carries **40** (`bindingSpecificity`, `question-pack-corpus.ts`). Most-specific-wins therefore picks
your role pack for exactly those occupations, and everyone else in the unit group keeps the generic
family pack. That is the whole activation mechanism — there is no special-casing anywhere in code.

### Finding the job_domain_id

Ids are **derived, never stored** (`jobDomainIdFor`, `packages/db/src/job-domain-corpus.ts`):

| source    | rule                                    | example                          |
| --------- | --------------------------------------- | -------------------------------- |
| `nco2015` | `jd_nco_<code with dots → underscores>` | `7223.6001` → `jd_nco_7223_6001` |
| `isco08`  | `jd_isco_<code>`                        | `7223` → `jd_isco_7223`          |
| `rvm`     | `jd_rvm_<slug>`                         |                                  |

Search `packages/db/data/job-domains/nco2015.jsonl` for the occupation title, then derive the id and
**verify it exists** before you rely on it — a binding to a non-existent domain is silently dead:

```bash
grep -oiE '"label_en":"[^"]*turning[^"]*"' packages/db/data/job-domains/nco2015.jsonl | sort -u
```

`db:verify:packs` runs the check `bindings whose job_domain_id is not in the catalogue`, so a typo
is caught — but only if you run it.

### Record the version

Append `<pack_id>@<version>` to `_published-versions.jsonl`. That ledger makes a version's
_disappearance_ a failing build, because a live session pins `(pack_id, version)` for the length of
an interview and a vanished version strands every worker mid-conversation with no rendered audio.

---

## 2b. Reachability — the step that decides whether the pack is ever used

> **Every structural gate can be green while the pack is dead.** This is the single most likely way
> to waste a week of authoring, and it happened on the first pack written under this guide.

`db:verify:packs` proves a pack is well-formed and that its family has a binding. It says nothing
about whether a real worker ever _lands_ on that binding. Those are different claims.

`qp_cnc_turning` was first bound to the two NCO codes whose titles say "Turning" — `7223.6001` and
`7223.6002`. Both exist, both resolve, every gate passed. But those codes carry exactly **one alias
each: their formal English NCO title.** The words an Indian turner actually uses —
`kharad`, `kharaad`, `खराद`, `lathe`, `लेथ`, `turning ka kaam` — all belong to a _different_ code,
`7223.0701` "Lathe Machinist". So the only worker who would ever have reached the pack was one who
typed the literal phrase "cnc turning". Every other turner would have got the six generic machining
questions, and no gate anywhere would have said a word.

The fix was to bind `7223.0701` (and `7223.0601`) as well: reach went from one phrase to six,
without touching the alias corpus at all.

### Do this before you author a single question

1. **List the phrases a worker would actually say** for this trade, in Latin and Devanagari.
2. **Find which job domain each phrase resolves to** in `packages/db/data/job-domains/rvm-aliases.jsonl`:
   ```bash
   grep -oiE '"job_domain_id": *"[^"]*", *"text": *"[^"]*(kharad|lathe|turner)[^"]*"' \
     packages/db/data/job-domains/rvm-aliases.jsonl
   ```
3. **Bind every code those phrases land on** that genuinely belongs to your trade.
4. **Write a characterization test** pinning phrase → family, modelled on
   `packages/db/src/question-pack-reachability.test.ts`. It reads as a report: every row that names
   another family is a worker your pack will never meet.

### Bind the specific, not the ambiguous

Resist binding a machine-agnostic code just to raise the number. `7223.5001` owns
`cnc` / `cnc operator` / `सीएनसी ऑपरेटर` / `cnc machine` — but a VMC and a milling operator say those
words too. It stays on the generic machining pack, whose first question disambiguates the machine
correctly. Routing it to turning would ask a milling operator about chucks and tailstocks.

The rule: **bind a code when every worker under it is unambiguously your trade.** Otherwise leave it
to the generic family pack and let its disambiguator do the work.

### The two guards that now catch this

- `packages/db/src/question-pack-reachability.test.ts` — pins which phrases reach which family.
- `packages/db/src/question-pack-coverage.test.ts` — asserts the specificity-50 count equals the
  number of job-domain bindings, so a binding pointing at a job domain that is not in the catalogue
  (which resolves nothing and silently falls back to the unit tier) fails the build.

---

## 3. The ask budget

**`MAX_ENGINE_ASKS = 24`** (`apps/api/src/profiling/next-question.ts`). `qp_universal@2` always
spends **8** of them. Your role pack therefore has **~16**, and going over does not error — it
**truncates the interview**, dropping your last questions for exactly the senior workers whose depth
you wrote the pack for.

Budget it explicitly, and write the arithmetic into the pack's `_budget` note. `qp_cnc_turning`:

| tier       | items | running total (+8 universal) |
| ---------- | ----- | ---------------------------- |
| base       | 8     | 16                           |
| `>= 2 yrs` | +3    | 19                           |
| `>= 5 yrs` | +4    | 23                           |

`qp_universal@2` already asks: `primary_trade`, `experience_years`, `current_city`,
`salary_expected`, `preferred_locations`, `availability`, `education`, `shift_preference`.
**Never duplicate these.**

---

## 4. The depth ladder

> A 2-year operator and an 8-year setter must not get the same interview. Tiers are **data**, not
> code — `PREDICATE_OPS` already has everything needed.

### The gate question

Ask it **first**, `is_core` + `is_mandatory`, as a `single_select` whose options carry a numeric
band. It must be **role-specific and inside your own pack**:

```jsonc
{
  "question_key": "turning_experience",
  "answer_type": "single_select",
  "target_kind": "attribute",
  "target_field": "turning_experience",
  "is_core": true,
  "is_mandatory": true,
  "max_asks": 2,
  "options": [
    { "option_key": "under_one", "label_text": "1 saal se kam", "value_number": 0 },
    { "option_key": "one_to_three", "label_text": "1 se 3 saal", "value_number": 2 },
    { "option_key": "three_to_seven", "label_text": "3 se 7 saal", "value_number": 5 },
    { "option_key": "over_seven", "label_text": "7 saal se zyada", "value_number": 10 },
  ],
}
```

**It cannot be `experience_years` from `qp_universal`.** Phase order is
`identify → disambiguate → occupation_specific → universal_tail → close`, so the universal answer
**does not exist yet** while your items are being selected. Gating on it yields a permanently-false
condition.

### Gating a question on the tier

```jsonc
"ask_if": { "op": "gte", "left": { "field": "turning_experience" }, "right": { "const": 2 } }
```

Use the contract shape `{op, left, right}` / `{op, field}`. **Not** `{op, args:[…]}` — that older
shape is what #776 was: every authored predicate evaluated false at runtime because
`predicate.field` was `undefined`, and two `qp_welding` questions were never asked for the life of
the pack. Both sides were well unit-tested; neither tested the other's shape.

### ⚠ The `value_text` trap — read this before you write a single option

`pack-registry.service.ts:530` resolves an option as:

```ts
const value: unknown = row.valueText ?? row.valueNumber ?? row.valueBool ?? null;
```

`value_text` **wins**. Put a `value_text` next to `value_number` on your gate chip and the captured
answer becomes the string `"10"`. `predicate.ts:compare()` refuses to order a string against a
number and returns `null`, so **every `gte` gate in your pack evaluates false forever** — every
tiered question silently never asked, no error anywhere.

> **On a tier-gate option, set `value_number` and nothing else.**

This is guarded by `apps/api/src/profiling/cnc-turning-depth.proof.test.ts`, which asserts
`value_text` is absent _and_ resolves options through the same `??` chain. Copy that test for your
pack. An earlier version of it fed the predicate a number directly, and injecting the trap left all
six tests green — a test that cannot fail on the defect it exists to prevent is not evidence. Verify
yours by actually injecting the mutation and watching it go red.

---

## 5. Field routing

`target_kind` decides where an answer lands, and it is the main reason a role pack needs no schema
change.

| `target_kind` | Where it lands                             | Vocabulary                |
| ------------- | ------------------------------------------ | ------------------------- |
| `rfs`         | `WorkerProfileDraft` via `FIELD_CROSSWALK` | **CLOSED — 16 ids only**  |
| `attribute`   | `worker_attributes` (typed EAV)            | **OPEN — any slug**       |
| `match_skill` | asserts a skill id                         | closed `skill` vocabulary |
| `none`        | captured, routed nowhere                   | —                         |

The **entire** RFS vocabulary (`packages/profiling-lexicon/src/values/crosswalk.ts`):

```
trade · skills · experience_years · current_city · preferred_locations · salary_expected
availability · tools_equipment · salary_current · education_level · education_field
certifications · work_history · languages · relocation_willingness
```

A `target_kind: "rfs"` question whose `target_field` is not in that list is **rejected** by the
validator. Almost everything role-specific is therefore an **`attribute`** — which is a feature, not
a workaround: `worker_attributes` is a typed EAV carrying full provenance (`question_key`, `pack_id`,
`pack_version`, `session_id`), so a new role adds zero columns and zero migrations.

There is a second reason to prefer `attribute`: `keepIfWellTyped` (`answer-capture.ts`) refuses a
chip value that contradicts its RFS field's declared type, and a refused chip is one a worker can
tap with **nothing recorded**. An attribute has no declared type to contradict.

---

## 5b. Getting the answers onto the resume

A pack captures answers; it does not decide how they print. That correspondence lives in
`apps/api/src/resume/trade-resume-map.ts`, keyed by `pack_id` — the per-role half of "adding a role
is data, not code".

**Why it is a separate file and not the pack.** A chip label is the worker's answer of record, in
their language: `"Khraad ya conventional lathe"`. A resume read by a hiring supervisor needs
`"Conventional lathe"`. Two vocabularies, one fact. The pack must stay in the worker's language and
the template must stay layout-only, so the dictionary sits between them.

```ts
{
  pack_id: "qp_cnc_turning",
  // The FIRST section's heading is per-trade, and therefore data. A turner's sheet says
  // "Machines, controllers & capability"; a welder's says "Processes, positions & capability";
  // a car mechanic's says "Vehicles, systems & tools". Sentence case — the template uppercases.
  section_title: "Machines, controllers & capability",
  capability: [
    {
      from: "turning_machine",     // the pack question_key / attribute key
      label: "Machines",           // the English label printed on the sheet
      kind: "chips",               // chips | ticks | fact
      values: {                    // slug -> printed English
        cnc_lathe: "CNC lathe / turning centre",
        conventional_lathe: "Conventional lathe",
      },
    },
  ],
}
```

**Only the first section's heading is yours.** `Availability & terms`, `Work history` and
`Qualification, documents & languages` are fixed by the design guideline's zone map and are
literals in the template — a mapper must not be able to rename "Work history". Section order is
fixed too, and Terms sitting _above_ Work history is deliberate: availability and expected pay
are two of the four things that actually reject a blue-collar candidate, so they come before the
employer list in a six-second scan. Do not "fix" it.

Three rules, each of which exists to stop something reaching a printed sheet:

1. **A value with no entry is DROPPED, never printed raw.** Every `is_none_of_above` chip carries
   `value_text: "unknown"`, so "Pata nahi" and "Inme se koi nahi" resolve to nothing and the row
   simply does not appear. A worker's _non-answer_ must never print as an answer.
2. **A row appears only if it has values.** "Does this row exist" is one testable line here, rather
   than a CSS `:empty` rule that has to behave identically in WeasyPrint.
3. **Values emit in the DICTIONARY's order, not the worker's selection order**, so two renders of
   one profile are byte-identical and a diff means something actually changed.

You may also deliberately omit a true answer. `drawing_reading: "none"` has no label: "cannot read
drawings" is real matching data, but a worker's own marketing document is not where a negative claim
belongs. Omission is a decision — write the comment saying so.

`trade-resume-map.test.ts` cross-checks the map against the pack in both directions: every `from` is
a real `question_key`, and every slug is a real option `value_text`. Copy those two tests for your
role — they are what catch a pack rename that would otherwise silently empty a resume section.

### What the sheet looks like, and what you may not change

The layout is `apps/api/src/resume/templates/bb_trade.v1.html`, and it is CEO-locked. Its
constraints are binding on every role and enforced by `bb-trade-template.test.ts`: one column, one
page, body ≥ 10.5pt, name ≥ 18pt, section label ≥ 9pt, margins ≥ 12mm, rules ≥ 0.5pt, no
information carried by colour alone, and **sizes expressed in `pt`, never `px`** — `px` hides
every one of those floors behind WeasyPrint's 0.75 conversion, which is how an earlier draft
shipped at 7.6pt body and looked fine.

One page is a contract, not a target. Overflow is handled by truncation in the mapper — four
employers in full and the rest collapsed to one counted line (`{{employments_more}}`) — never by
shrinking type and never by a second page. If a sheet overflows, the mapper is wrong, not the CSS.

There is no local WeasyPrint on Windows or macOS. To actually see a change, render through Docker
and confirm the page count; see the "Verifying a change" section of
`apps/api/src/resume/templates/README.md`. A structural test cannot check page count — the Node
test environment has no renderer.

---

## 6. Prompt rules — all validator-enforced

`checkPromptPersona` runs over every `prompt_text` at build time. These are hard failures:

- **Exactly one `?`.** Not zero, not two. Two questions in one turn loses a low-literacy worker.
- **At most 20 words.**
- **No `!`**, no emoji.
- **No `{{ }}` in `prompt_text`, `why_text` or `retry_text`.** Served text is pre-rendered to
  **shared** TTS audio keyed by `sha256(text)` — an interpolated value would put one worker's name
  into a clip every other worker hears.
- **No banned tokens** (`packages/profiling-lexicon/data/persona.json`): `bhai`, `bhaiya`, `beta`,
  `behen`, `yaar`; `tu`/`tum`/`tera`/`tere`/`tumhara`/`tumhare`; `waah`, `zabardast`, `shabaash`,
  `great`, `perfect`, `awesome`, `excellent`, `congratulations`, `badhai`; `guarantee`,
  `pakka job`, `job pakki`, **`interview`**; `aur usme`, `usme kitne`, `wahan kitne`,
  `uske baare mein`.

Always write `why_text` (served when a worker asks "why do you want to know?") and `retry_text` for
anything with `max_asks: 2`.

### Keys

| field          | pattern                 | note                                                                                                                                                                                                           |
| -------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pack_id`      | `^qp_[a-z0-9_]+$`       |                                                                                                                                                                                                                |
| `family_id`    | `^fam_[a-z0-9_]+$`      |                                                                                                                                                                                                                |
| `question_key` | `^[a-z_]+$`, ≤ 40 chars | **no digits**; over-length ids are dropped by the event-payload filter, which drops a completed interview                                                                                                      |
| `option_key`   | `^[a-z_]+$`             | **no digits either** — `basic_2d` passes the corpus validator historically but is REFUSED by `slugKey` at runtime, which makes the whole pack unparseable. Both regexes are now identical; keep them that way. |

---

## 7. Chip rules

- **The label IS the worker's answer of record, verbatim.** That is why chips are reviewed static
  data and never model output.
- A select needs **≥ 2 options**; a non-select must carry **zero**.
- Labels must be unique within an item, and must not contain `?` — options are answers, never
  questions.
- **One** `is_none_of_above` per item, at most.
- Keep to ~6. `persona.json` sets `maxChips: 4` for generated turns; authored packs run slightly
  wider, but a worker scanning ten chips on a phone is a worker who abandons.
- One script per item — never mix Latin and Devanagari in one option list.
- Follow-ups via `parent_item_key` are **depth 1**. The validator rejects cycles and depth > 1.

---

## 8. Checklist

1. Confirm the trade has depth worth 8–16 questions that `qp_universal` does not already ask.
2. **Do the reachability work in §2b FIRST** — list the phrases a worker says, find which job
   domains own them, and decide which of those codes are unambiguously your trade. Authoring before
   this step is how you write a pack nobody reaches.
3. Find and **verify** every NCO `job_domain_id` exists in the catalogue.
4. Add the family + one binding per occupation to `_families.jsonl`.
5. Author `packs/<pack_id>.json` (v1; later versions are `<pack_id>@<n>.json` — a shipped version is
   immutable and is never overwritten).
6. Gate question first; tier the rest; keep the arithmetic inside the ask budget.
7. Append to `_published-versions.jsonl`.
8. Author a **Devanagari twin for every served string** you wrote — each `prompt_text`, `why_text`
   and `retry_text` — in `apps/api/src/profiling/question-tts-text.ts` (prompts and retries go in
   `QUESTION_TTS_TEXT`, why-texts in `WHY_TTS_TEXT`). The clarify twins compose themselves from the
   why-prefix, so you never author those. Skip this and a voice-form worker meets **silence** at
   your questions.
9. Regenerate the two golden manifests, which is expected and additive for a new pack:
   ```bash
   cd apps/api
   UPDATE_PACK_SERVED_TEXT=1 npx vitest run src/profiling/pack-served-text.golden.test.ts
   UPDATE_REPLY_CLOSURE=1    npx vitest run src/profiling/reply-closure.golden.test.ts
   ```
   Check the diff is **additive only** — a deletion means you changed a shipped pack's wording,
   which you may not do.
10. Run the gates:
    ```bash
    cd packages/db && pnpm run db:verify:packs   # corpus + 12 structural checks
    cd packages/db && npx vitest run             # reachability + coverage + predicate corpus
    cd apps/api    && npx vitest run src/profiling
    ```
11. **Inject the `value_text` mutation into your gate and watch the proof test go red.** A green
    test you have never seen fail is not evidence.
12. Send the pack to a **practising worker in that trade** for vocabulary review. The validator
    checks structure; only a turner knows whether "Khraad" is the word used on that shop floor.

---

## 9. Known gaps

Honest state of the rails as of `qp_cnc_turning@1`:

- **Work history (employer, city, dates, role stints) cannot come from a pack.** The engine asks
  each `question_key` once, so a multi-employer loop would need one fixed block of keys per
  employer — roughly 6 questions each, which does not fit inside `MAX_ENGINE_ASKS = 24` alongside
  real trade depth. This needs either a dedicated post-interview form screen or an engine-level
  loop, and is an open decision, not something to solve inside a pack.
- **Trade-agnostic resume fields** — documents held, languages spoken, structured education
  (board / year / institution), certificates (issuer / year) — belong in a `qp_universal@3`, not in
  each role pack. Duplicating them per role is cheap to unwind later (`question_key` is stable
  across packs, so answers carry over), but it is still duplication. Promote them once two or three
  role packs prove the pattern.
- **The resume has no slot for these attributes yet.** `ResumeRenderInput` currently exposes ~12
  slots; materials, setting operations, tolerance, sector, workholding and capability have nowhere
  to render until that work lands.
- **The chat cannot render a multi-select or a boolean yet.** `TurnResult.answerType` is computed
  server-side and dropped by `chat.dto.ts`, so today a `multi_select` shows as a flat chip row and a
  `boolean` as a bare text field. Until that ships, prefer `single_select` where the distinction
  matters to data quality.
