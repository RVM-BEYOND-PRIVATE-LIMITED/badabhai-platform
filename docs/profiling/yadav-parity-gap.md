# R9 — the Yadav parity gap, field by field

> Target: `Ramesh-Kumar-Yadav_VMC-Setter-cum-Operator_Faridabad_BadaBhai.pdf`, one page.
> Every "Yadav" value below is quoted from the extracted PDF text. Every "ours" value is quoted
> from a real render of `scripts/persona-harness/out/turner-parity.html` — a fully-answered
> turner, rendered through the shipped mapper and the shipped `bb_trade` template.
>
> **The turner sheet is one page at 21.33 mm of headroom, `degradationStage: 0`.** Density is not
> the problem. What is missing is missing because nothing captures it.
>
> The eight §6 render rules are asserted executably in
> `apps/api/src/resume/yadav-parity.contract.test.ts`. Five are `it.fails` — the test runs, the
> assertion is real, and the moment someone implements the rule it goes red and forces the flip.
> **That file and this table must agree.**

---

## 0 · The two sheets, side by side

```
YADAV (ratified, milling)                     TURNER (ours, rendered)
─────────────────────────────────────────     ─────────────────────────────────────────
BADABHAI                    RVM-attested      BADABHAI                    (blank)
Ramesh Kumar Yadav    +91 98765 43210         Ramesh Kumar Yadav    +91 98765 43210
रमेश कुमार यादव                                 (absent)
VMC Setter-cum-Operator · 8 yrs ·             CNC Setter-cum-Operator · 8 yrs ·
  Fanuc, Siemens, Mitsubishi · 3 & 4-axis       Fanuc, Siemens, Mitsubishi
Faridabad · available in 15 days ·            Faridabad · available in 15 days ·
  expects ₹24,000–28,000                        expects ₹32,000 / month

MACHINES, CONTROLLERS & CAPABILITY            MACHINES, CONTROLLERS & CAPABILITY
Machines      VMC · 3-axis  VMC · 4-axis  SPM Machines      CNC lathe / turning centre …
Controllers   Fanuc Siemens Mitsubishi        Controllers   Fanuc Siemens Mitsubishi
Materials     EN8 EN31 MS Aluminium          Materials     MS  EN8 / EN31  Stainless  Cast iron
Setting       ✓ …five                        Workholding   ✓ …five
Measuring     ✓ …five                        Setting       ✓ …five
Programming   Edits programs (G/M-code)      Measuring     ✓ …four
Drawings      Reads 2D drawings and GD&T     Programming   Edits programs (G/M-code)
Tolerance held  ±0.02 mm                     Drawings      Reads 2D drawings and GD&T
Sector worked   Automotive components        Machine capability  Live tooling · Bar feeder …

AVAILABILITY & TERMS                          AVAILABILITY & TERMS
Available from  15 days                       Available from  15 days
Salary expected ₹24,000 – ₹28,000 / month     Salary expected ₹32,000 / month
Preferred locations … · Willing to relocate   Preferred locations … · Willing to relocate
Shift  Rotational shifts · Permanent          Shift  Rotational shifts · Permanent

WORK HISTORY                                  WORK HISTORY
Sandhar … · Gurugram   Jan 2023–Present·3y6m  Harsha … · Faridabad   Sep 2022–Present·4 yrs
  VMC Setter-cum-Operator · Jul 2024–…          CNC Setter-cum-Operator   Apr 2024–…
  VMC Operator · Jan 2023–Jun 2024               CNC Turner               Sep 2022–Mar 2024
  VMC 3 & 4-axis, Fanuc · EN8, EN31 · …          CNC lathe, bar feeder … · EN8, EN31, SS316 · …
Amtek … · Faridabad    Sep 2020–Dec 2022·2y    Kalyani … · Manesar — CNC Turner  Apr 2020–…
  VMC Operator · VMC 3-axis Siemens, SPM · …     CNC lathe, Siemens · alloy steel · …

QUALIFICATION, DOCUMENTS & LANGUAGES          QUALIFICATION, DOCUMENTS & LANGUAGES
Education   ITI — Machinist · NCVT · 2018 ·   Education  ITI ya diploma — Turner · NCVT ·
              Govt. ITI, Faridabad                        2018 · Govt. ITI, Faridabad
Certificates  Name (Issuer, City, Year) · …   Certificates  CNC Turning & Setting
Languages   Hindi · Haryanvi · English        Languages  Hindi · Haryanvi · English
Documents   ✓ …seven                          Documents  ✓ …seven

BADABHAI [QR]                                 BADABHAI [QR]
Scan to open this worker's live profile       Scan to open this worker's live profile
badabhai.in/w/rk8m2q                          badabhai.ai
Generated 27 Aug 2026 · RVM-attested · Ref    Generated 27 Aug 2026 · Self-declared · Ref
Details as stated by the worker.              Details as stated by the worker.
```

**Structurally the two are the same document.** Six zones, same order, same headings, same
typography, same tick and chip treatments, one page each, no empty section on either. The
differences are eleven specific fields, and every one of them is a capture gap rather than a
layout gap.

---

## 1 · Zone 1 — masthead and Verdict Line

| Field                 | Yadav                              | Verdict        | Where it breaks                                                                                                                                                                                                                   |
| --------------------- | ---------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wordmark              | `BADABHAI`                         | **CAPTURABLE** | template literal                                                                                                                                                                                                                  |
| Verification state    | `RVM-attested`                     | **NO ASK**     | Two slots exist and both render (`{{trust_badge}}`, footer meta). **Nothing can set them**: no verification column on `workers` or `worker_profiles`, and the render processor hardcodes `trustBadge: null`. Phase 2 by ruling 3. |
| Name                  | `Ramesh Kumar Yadav`               | **CAPTURABLE** | `workers.full_name_enc`, decrypted by the caller                                                                                                                                                                                  |
| Phone                 | `+91 98765 43210`                  | **CAPTURABLE** | decrypted by the caller; owner-ruled onto both audiences                                                                                                                                                                          |
| Devanagari line       | `रमेश कुमार यादव`                  | **NO ASK**     | slot is audience-gated and wired; the processor passes `null` with "Devanagari is not transliterated yet". Plan ruling 11 says auto-transliterate; nothing implements it.                                                         |
| Role                  | `VMC Setter-cum-Operator`          | **CAPTURABLE** | `role_label`                                                                                                                                                                                                                      |
| Total years           | `8 yrs`                            | **CAPTURABLE** | `experience_years` → fixed in R8 §1                                                                                                                                                                                               |
| Controllers, capped 3 | `Fanuc, Siemens, Mitsubishi`       | **CAPTURABLE** | `controller_brand`, `inHeadline`, cap asserted                                                                                                                                                                                    |
| **Axes appended**     | `3 & 4-axis`                       | **PARTIAL**    | The turner pack captures `advanced_capability`, but `buildVerdictLine` composes exactly three segments and has no axis parameter. The compression rule ("3-axis" + "4-axis" → "3 & 4-axis") has no implementation anywhere.       |
| City / availability   | `Faridabad · available in 15 days` | **CAPTURABLE** |                                                                                                                                                                                                                                   |
| **Salary band**       | `expects ₹24,000–28,000`           | **NO ASK**     | See §4.1. `qp_universal@2` asks one number; the contract holds one; the column holds `amount_min` and `amount_max` but only the min is ever written.                                                                              |

---

## 2 · Zone 2 — the capability block

All nine rows Yadav prints are **CAPTURABLE** for a turner in principle. The problem is not any
one field, it is the **budget**: `qp_cnc_turning` defines **fourteen** capability rows against
`CAPABILITY_ROW_BUDGET = 9`. See §5.

| Yadav row                         | Turner equivalent     | Verdict                 | Note                                                                                                                                                                                                                                                                     |
| --------------------------------- | --------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Machines                          | `turning_machine`     | **CAPTURABLE**          | renders                                                                                                                                                                                                                                                                  |
| **— with configuration appended** | `VMC · 3-axis`        | **PARTIAL**             | `buildTradeCapabilityRows` iterates ONE attribute's dictionary per row. There is no mechanism to append a second attribute's value to each chip, so an axis/configuration can only ever be its own row or nothing. Would land as a `configFrom` field on `TradeRowSpec`. |
| Controllers                       | `controller_brand`    | **CAPTURABLE**          | renders                                                                                                                                                                                                                                                                  |
| Materials, capped 4               | `material_worked`     | **CAPTURABLE**          | renders                                                                                                                                                                                                                                                                  |
| Setting (tick grid)               | `setting_operation`   | **CAPTURABLE**          | renders                                                                                                                                                                                                                                                                  |
| Instruments (tick grid)           | `measuring_tools`     | **CAPTURABLE**          | renders                                                                                                                                                                                                                                                                  |
| Programming (one enum)            | `programming_level`   | **CAPTURABLE**          | renders as a single fact line, same as the sample                                                                                                                                                                                                                        |
| Drawings                          | `drawing_reading`     | **CAPTURABLE**          | renders                                                                                                                                                                                                                                                                  |
| **Tolerance held**                | `tolerance_band`      | **CAPTURABLE, DROPPED** | rank 62 of fourteen → tenth by rank → outside the budget of nine. **A turner holding ±0.01 mm gets a sheet that does not say so, while the ratified milling sample prints tolerance at position eight.**                                                                 |
| **Sector worked**                 | `sector_worked`       | **CAPTURABLE, DROPPED** | rank 81, last. §4.3 calls it display-only.                                                                                                                                                                                                                               |
| _(no Yadav equivalent)_           | `turning_operation`   | **CAPTURABLE, DROPPED** | rank 63. Facing / boring / threading / grooving — turning's core work vocabulary, with no milling counterpart.                                                                                                                                                           |
| _(no Yadav equivalent)_           | `workholding`         | CAPTURABLE, renders     | rank 42                                                                                                                                                                                                                                                                  |
| _(no Yadav equivalent)_           | `quality_work`        | **DROPPED**             | rank 71                                                                                                                                                                                                                                                                  |
| _(no Yadav equivalent)_           | `troubleshooting`     | **DROPPED**             | rank 72                                                                                                                                                                                                                                                                  |
| _(Yadav puts axes in Zone 1)_     | `advanced_capability` | CAPTURABLE, renders     | rank 23                                                                                                                                                                                                                                                                  |

---

## 3 · Zone 3 — availability and terms

| Field                | Yadav                           | Verdict        | Note                                                       |
| -------------------- | ------------------------------- | -------------- | ---------------------------------------------------------- |
| Available from       | `15 days`                       | **CAPTURABLE** |                                                            |
| **Salary as a band** | `₹24,000 – ₹28,000 / month`     | **NO ASK**     | §4.1                                                       |
| Preferred locations  | `Faridabad, Gurugram, Manesar`  | **CAPTURABLE** | R6 form, cities canonicalised through the shared gazetteer |
| Willing to relocate  | appended to the same line       | **CAPTURABLE** | R6 form; renders exactly as the sample joins it            |
| Shift · job type     | `Rotational shifts · Permanent` | **CAPTURABLE** | R6 form; one line, both halves                             |

Zone 3 is the closest to parity of any zone — one field short, and that field is an owner ruling.

---

## 4 · Zone 4 — work history

| Field                            | Yadav                                                       | Verdict        | Note                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Employer name                    | `Sandhar Technologies Ltd`                                  | **CAPTURABLE** | work-history form, encrypted at rest                                                                                                                                                                                                                                                                                          |
| Employer city / state            | `· Gurugram, Haryana`                                       | **CAPTURABLE** |                                                                                                                                                                                                                                                                                                                               |
| Employer date range              | `Jan 2023 – Present`                                        | **CAPTURABLE** | month chips                                                                                                                                                                                                                                                                                                                   |
| Employer total months            | `· 3 yrs 6 mo`                                              | **CAPTURABLE** | computed against `asOf`                                                                                                                                                                                                                                                                                                       |
| **The per-employer detail line** | `VMC 3 & 4-axis, Fanuc · EN8, EN31 · automotive components` | **CAPTURABLE** | **The directive lists this as certainly missing; it is not.** `EmploymentEntrySchema.work_done` is a 300-char free-text field on the shipped work-history form, `workLine()` maps it, `{{work}}` renders it. Our turner sheet prints exactly this shape. What is genuinely absent is any _guidance_ on composing it — see §6. |
| **The promotion case**           | two dated roles under one employer                          | **PARTIAL**    | The schema supports it (`worker_employment_role`), the mapper builds it (`roleStints`), the template renders it indented, and our turner sheet prints it correctly. **Only the ASK is missing**: `EmploymentEntrySchema.role_label` is a single role by the Q1 ruling. See §4.2.                                              |
| Single-role placement            | role and detail on ONE line below the employer              | **PARTIAL**    | Ours appends the role to the EMPLOYER line and puts the detail on its own. Same line count, same information, different placement — and the difference was measured, not careless: `toEmployment` records that one role line per employment took shapes 5, 6 and 9 to two pages.                                              |

---

## 5 · Zone 5 — qualification, documents and languages

| Field                                    | Yadav                                                        | Verdict            | Note                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Education level                          | `ITI`                                                        | **CAPTURABLE**     | but prints `ITI ya diploma` — see the language conflict below                                                                                                                                                                |
| Education trade                          | `Machinist`                                                  | **CAPTURABLE**     | `education_field`                                                                                                                                                                                                            |
| **Education council**                    | `NCVT`                                                       | **BUILT IN R9 §3** | `education_council`, a closed set of 8. §4.5 forbids collapsing NCVT and SCVT and **until this landed nothing in the system could represent the distinction at all** — the rule was unenforceable rather than unimplemented. |
| **Education year**                       | `2018`                                                       | **BUILT IN R9 §3** | `education_year`, bounded 1950–2100                                                                                                                                                                                          |
| **Education institute**                  | `Govt. ITI, Faridabad`                                       | **BUILT IN R9 §3** | `education_institute`, free text — no national ITI register exists to validate against                                                                                                                                       |
| — institute's city as its own segment    | `, Faridabad`                                                | **PARTIAL**        | one free-text field holds both; splitting it is a form change with no ruling behind it, and deriving a city from an institute name is the inference §8 forbids                                                               |
| **Certificates with issuer, city, year** | `CNC / VMC Programming & Setting (RVM CAD, Faridabad, 2021)` | **NO ASK**         | `certifications` is a `string[]` on `DraftProfileSchema` — one opaque label with nowhere to put an issuer, a city or a year. Structured rows are a frozen-contract change (joint TS + Python + fixture PR).                  |
| Languages                                | `Hindi · Haryanvi · English`                                 | **CAPTURABLE**     | R6 form                                                                                                                                                                                                                      |
| Documents ready                          | seven ticks                                                  | **CAPTURABLE**     | R6 form; ticks are per-item list markers, so a wrap cannot strip them                                                                                                                                                        |

### The education-language conflict, and why it is not mine to settle

`KNOWN_EDUCATION_LEVELS` prints the pack's own **Hinglish** chip label — "ITI ya diploma", "Dasvi
paas", "Barhvi paas" — and its comment argues that the résumé should say back to the worker the
words he tapped. #963 names "10th se kam" explicitly and `education_label.dart` shows the same
string in the app.

`worker-preferences.vocabulary.ts` prints **English**, and says why: _"this half of the sheet is
read by a hiring supervisor."_

They now sit on the **same row**: `ITI ya diploma — Turner · NCVT · 2018 · Govt. ITI, Faridabad`.
The ratified sheet settles it in English. But flipping it changes every existing résumé,
contradicts a named issue, and would make the app and the PDF disagree for the one population
that currently agrees. **Recorded, asserted, not taken.**

---

## 6 · Zone 6 — footer

| Field                    | Yadav                                     | Verdict        | Note                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QR                       | present                                   | **CAPTURABLE** | server-side data URI                                                                                                                                                                                                                                                                                     |
| Caption                  | `Scan to open this worker's live profile` | **CAPTURABLE** |                                                                                                                                                                                                                                                                                                          |
| Short link               | `badabhai.in/w/rk8m2q`                    | **PARTIAL**    | Ours prints `badabhai.ai` — the site root. The per-worker `/w/<code>` page is Phase 3 and a QR resolving to a 404 is worse on paper than one resolving to the homepage. **The sample's domain is also wrong**: the registered domain is `badabhai.ai`, not `.in`. Ours is right and the sample is stale. |
| Generated date           | `27 August 2026`                          | **CAPTURABLE** |                                                                                                                                                                                                                                                                                                          |
| Verification state (2nd) | `RVM-attested`                            | **NO ASK**     | same unreachable slot as Zone 1                                                                                                                                                                                                                                                                          |
| Ref code                 | `Ref RK8M2Q`                              | **CAPTURABLE** |                                                                                                                                                                                                                                                                                                          |
| Disclaimer               | literal                                   | **CAPTURABLE** | template literal                                                                                                                                                                                                                                                                                         |

---

## 7 · The five fields §3 names — status

| Field                    | §3 said | Actually                                                                          |
| ------------------------ | ------- | --------------------------------------------------------------------------------- |
| Languages                | no ask  | **shipped in R6** — form, mapper, slot, all three                                 |
| Documents ready          | no ask  | **shipped in R6**                                                                 |
| Certificate detail       | no ask  | **confirmed NO ASK** — needs a structured contract change                         |
| ITI as four components   | no ask  | **BUILT in R9** — council, year, institute on the finishing form                  |
| Per-employer detail line | no ask  | **already capturable** — `work_done`, 300 chars, on the shipped work-history form |

Two of the five were already done and one more is done now. The routing rule §3 states — closed
sets to the form, interview asks only for what needs language — is what the three new components
follow: a council is a closed set, a year is a number, an institute is read off a certificate.
None needs a model; none can be misparsed.

---

## 8 · What is still missing from the turner sheet, and why

In descending order of what it costs a worker:

1. **Tolerance held** — captured, dropped by the row budget. The strongest pay signal a turner
   has. §5.
2. **Salary as a band** — a point figure invites anchoring against the worker (§4.4). Owner ruling
   Q5.
3. **The promotion ask** — renderer and schema both ready; only the question is missing. Q1.
4. **Certificates with issuer and year** — a frozen-contract change.
5. **The axis segment** in the Verdict Line, and configuration appended to the machine chip.
6. **Verification state** — two slots, nothing that can fill them. Phase 2.
7. **The Devanagari line** — slot wired, transliteration unimplemented.
8. **Operations** — turning's core vocabulary, dropped by the budget.
9. **The education level's language** — Hinglish on an English row.
10. **The institute's city** as its own segment.
11. **The per-worker QR path** — Phase 3.

Nothing on that list is a layout problem. The sheet has 21.33 mm of headroom.
