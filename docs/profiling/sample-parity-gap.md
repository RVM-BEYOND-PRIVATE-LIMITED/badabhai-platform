# Sample parity — the ratified sheet against what a turner interview produces today

**R6 §3.** A field-by-field diff of the ratified **Ramesh Kumar Yadav** sheet against what a real
CNC turner can actually come out of the interview with. This table is the work plan for §4 and §5.

Measured, not recalled: the pack columns come from driving the shipped packs, the render columns
from reading the two branches of `buildResumeRenderInput`, and the sample column from the ratified
PDF itself.

## Three things that decide half the table

**1 · The sample is a VMC setter; the pack is turning.** `Ramesh-Kumar-Yadav_VMC-Setter-cum-Operator`
is a milling sheet. Where a field is trade-specific I compare against the turner equivalent —
"3 & 4-axis" against `advanced_capability`'s `c_axis` / `y_axis`, which is the same statement about
what the machine can do. Nothing in the layout differs; §7.1 forbids that.

**2 · A real turner takes the LEGACY branch, not the résumé-container branch.** `fromResumeProfile`
fires only when Phase C returned values, and Phase C is `profile_extraction` — armed in no compose
file (see NEEDS_PRAKASH Q10), so it returns `{}` and the mapper falls through. Every row below is
scored against the branch a worker actually reaches, which is why several fields that are visibly
wired on one path read "unwired" here.

**3 · Captured is not rendered.** Four fields are asked, stored, and never reach the page. That is
its own class of gap and it costs nothing to close — no ask, no model, no migration.

## The table

`capturable` = a real turner ends the interview (or the §4 form) with this on the sheet ·
`partial` = something renders but not what the sample shows · `no ask` = nothing in the
143-pack corpus asks it, or nothing carries the answer to the page.

| zone | field on the sample               | sample value                                                      | source today                                                                                                                            | verdict                  |
| ---- | --------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 1    | `BADABHAI` wordmark               | —                                                                 | template literal                                                                                                                        | capturable               |
| 1    | trust badge                       | "RVM-attested"                                                    | `trustBadge` slot; processor passes `null`; **no verification field exists**                                                            | **no ask**               |
| 1    | full name                         | Ramesh Kumar Yadav                                                | `workers.full_name_enc`, decrypted per render                                                                                           | capturable               |
| 1    | phone                             | +91 98765 43210                                                   | `workers.phone_e164`, decrypted; both audiences by ruling                                                                               | capturable               |
| 1    | Devanagari name                   | रमेश कुमार यादव                                                   | slot exists; **no transliteration is built**; processor passes `null`                                                                   | **no ask**               |
| 2    | role + function modifier          | VMC **Setter-cum-Operator**                                       | `primary_trade` (free text) or the taxonomy label. §8.3 forbids raising the modifier from a chip                                        | **partial**              |
| 2    | total years                       | 8 yrs                                                             | `experience_years` (universal)                                                                                                          | capturable               |
| 2    | controllers inline                | Fanuc, Siemens, Mitsubishi                                        | `controller_brand`, `inHeadline`                                                                                                        | capturable               |
| 2    | axis / machine capability         | 3 & 4-axis                                                        | `advanced_capability` → `c_axis`, `y_axis` (turner equivalent)                                                                          | capturable               |
| 2    | current city                      | Faridabad                                                         | `current_city` (universal)                                                                                                              | capturable               |
| 2    | availability                      | available in 15 days                                              | `availability` (universal)                                                                                                              | capturable               |
| 2    | salary **range**                  | ₹24,000–28,000                                                    | `salary_expected` is one number; the schema has `amount_min`/`amount_max` and only min is written                                       | **partial**              |
| 3    | Available from                    | 15 days                                                           | as above                                                                                                                                | capturable               |
| 3    | Salary expected                   | ₹24,000 – ₹28,000 / month                                         | asked, stored on `salary_expectation.amount_min` — **legacy branch passes `salary: null`**                                              | **unwired**              |
| 3    | Preferred locations               | Faridabad, Gurugram, Manesar                                      | `preferred_locations` (universal **v2**)                                                                                                | capturable               |
| 3    | Willing to relocate               | · Willing to relocate                                             | `buildAvailabilityRows` takes `willingToRelocate`; **nothing passes it**, and universal **v2 dropped the `relocation` ask that v1 had** | **no ask**               |
| 3    | Shift                             | Rotational shifts                                                 | `shift_preference` asked → `worker_attributes`; the sheet reads `rp.shift` (model-only) and the legacy branch passes `shift: null`      | **unwired**              |
| 3    | Job type                          | · Permanent                                                       | no field on any schema, no ask                                                                                                          | **no ask**               |
| 3    | Accommodation                     | (not on this sample; §4.4 names it)                               | `buildAvailabilityRows` takes `accommodationNeeded`; **nothing passes it**                                                              | **no ask**               |
| 4    | employer name                     | Sandhar Technologies Ltd                                          | `PUT /workers/me/employment` (R5 §1.2), encrypted at rest                                                                               | capturable               |
| 4    | employer city / state             | Gurugram, Haryana                                                 | same form                                                                                                                               | capturable               |
| 4    | date range + computed tenure      | Jan 2023 – Present · 3 yrs 6 mo                                   | same form; tenure computed against the render clock                                                                                     | capturable               |
| 4    | per-employment detail line        | VMC 3 & 4-axis, Fanuc · EN8, EN31 · automotive components         | the form's `work_done`, typed by the worker                                                                                             | capturable               |
| 4    | **promotion inside one employer** | Setter-cum-Operator, then VMC Operator, one tenure                | schema supports two roles; **Q1 ruled the form asks one role each**                                                                     | **no ask**               |
| 4    | ">4 employers" collapse line      | (not on this sample)                                              | `employmentsMore` is built and rendered — but the form caps at **4**, so nothing can ever produce a fifth                               | **dead by construction** |
| 5    | education level                   | ITI                                                               | `education` (universal), 5 options                                                                                                      | capturable               |
| 5    | ITI trade                         | — Machinist                                                       | `education_field` is on the crosswalk; **no pack in 143 asks it**                                                                       | **no ask**               |
| 5    | council                           | NCVT                                                              | **no field anywhere** — not on the draft, not in the corpus                                                                             | **no ask**               |
| 5    | year                              | 2018                                                              | **no field anywhere**                                                                                                                   | **no ask**               |
| 5    | institute                         | Govt. ITI, Faridabad                                              | **no field anywhere**                                                                                                                   | **no ask**               |
| 5    | certificates — name, issuer, year | CNC / VMC Programming & Setting (RVM CAD, Faridabad, 2021)        | `certifications` is `string[]`; **no pack asks it**; no structure for issuer or year                                                    | **no ask**               |
| 5    | languages spoken                  | Hindi · Haryanvi · English                                        | `crosswalk.ts` records `draftPath: null` — **no ask, and no column**                                                                    | **no ask**               |
| 5    | documents ready                   | Aadhaar · PAN · Bank · UAN/PF · ITI cert                          | `qualTickRows` renders it; **no pack asks it**                                                                                          | **no ask**               |
| 6    | QR                                | scans to the profile                                              | `resume-qr.ts`, self-contained data URI                                                                                                 | capturable               |
| 6    | short link                        | badabhai.in/w/rk8m2q                                              | `RESUME_PROFILE_ORIGIN`                                                                                                                 | capturable               |
| 6    | generated date · ref code         | 27 August 2026 · Ref RK8M2Q                                       | `buildSheetFooterMeta`                                                                                                                  | capturable               |
| 6    | disclaimer                        | Details as stated by the worker                                   | template literal                                                                                                                        | capturable               |
| —    | **"in the worker's own words"**   | (Sunil sample) "denting-painting ka basic kaam bhi kar leta hoon" | `ownWords` exists on `ResumeRenderInput` and is rendered — but **`TradeSheetContext` has no field for it and no mapper sets it**        | **no ask**               |

## What the table says

**Zone 4 is done.** The work-history writer closed the largest single gap on the sheet. What
remains there is the promotion case (ruled out of v1 capture, and therefore the one place the
ratified sample is genuinely unreachable) and an overflow line that nothing can trigger.

**Zone 3 is the cheapest win on the sheet and it is almost entirely wiring.** Of its six rows,
one renders. Two are asked and stored and simply never passed (`salary`, `shift`), and three have
no ask at all (`relocate`, `job type`, `accommodation`) — but every one of the three is a
closed-set answer that needs no model. §4.4 calls this "the block every competitor omits"; we omit
it too, by accident.

**Zone 5 is the largest remaining hole and it is all capture, not rendering.** Every row already
renders — R5 fixed the education/certificates path — and five of its seven fields have no ask
anywhere in 143 packs. `languages` has no column either.

**Three fields are structurally unreachable without a model** and no pack authoring changes that:
the function modifier in the verdict line (§8.3 forbids inferring it), the promotion case, and the
own-words block. All three are the Q10 decision, not this table's.

**One field needs neither** — the Devanagari line is a deterministic transliteration of a name we
already hold, and nothing has been built.

## Where each row goes

| destination                   | rows                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **§4 — the finishing form**   | languages, documents ready, job type, relocate, accommodation, shift (re-asked in the form so the answer reaches the page) |
| **§4 — pure render wiring**   | salary (legacy branch), shift (legacy branch)                                                                              |
| **§5 — the revised ask list** | ITI trade, council, certificate detail — Zone 5 credential structure                                                       |
| **Q10 — the flip**            | function modifier, promotion case, own-words block                                                                         |
| **not scheduled**             | trust badge (Phase 2 verification), Devanagari transliteration, salary range, the dead overflow line                       |
