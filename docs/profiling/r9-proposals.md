# R9 — three proposals for owner ruling

> None of this is built. Each item states the change, the reasoning, the cost, and what I would
> do if the ruling goes the other way.

---

## Q5 — ask for a salary BAND

**What Yadav prints:** `Salary expected  ₹24,000 – ₹28,000 / month`
**What we print:** `Salary expected  ₹32,000 / month`

### Why deriving a band is not an option

§4.4 is explicit that a point figure invites anchoring against the worker. The obvious fix —
render `x` as `x − 10%` to `x + 10%` — is the derived claim §8 forbids: the worker stated one
number and the sheet would print two he never said. That reading still holds, so **parity
requires asking for a band**, and that is an upstream ask change rather than a render change.

### The proposal

Change `qp_universal@2`'s `salary_expected` from one `duration`-style number to a **two-part
ask**, and store both ends.

```
  current   "Aap kitni salary expect karte hain?"        -> 32000
  proposed  "Kam se kam kitni salary chahiye?"           -> 24000   amount_min
            "Aur zyada se zyada kitni mil jaye to theek?" -> 28000   amount_max
```

**It costs ONE extra engine ask**, and the budget can absorb it: `MAX_ENGINE_ASKS` is 28 after
R6 §5 and the worst measured case is 26.

**The storage already exists.** `worker_profiles.salary_expectation` is a jsonb object and
`SalaryExpectationSchema` already carries `amount_min` AND `amount_max`; only the min is ever
written. So this is a capture change and a render change, with no migration.

**`formatMonthlySalary` becomes a range formatter.** One function, one call site, both audiences
already gated (the payer copy prints neither end).

### Three things I would want ruled with it

1. **A single-answer worker must still print a point figure.** A man who says "32 hazaar" and
   nothing else has stated one number, and inventing the other end is the thing we just refused
   to do. So the row must render `₹32,000 / month` when only the min exists — which means the
   band is a _better_ answer, not a _required_ one.
2. **Which end anchors.** Yadav's band is `24,000 – 28,000` and his stated current pay is not on
   the sheet. If a worker gives a band whose lower end is below his current pay, printing it
   costs him money. I would ask the _minimum acceptable_ first, as above, because that is the
   number he will not go below.
3. **The second ask is skippable.** If he answers only one, we have the current behaviour and
   have lost nothing.

**If the ruling is no:** the point figure stays and Zone 3 stays one field short of parity. No
other work is blocked.

---

## Q1 — ask about promotions

**What Yadav prints:**

```
Sandhar Technologies Ltd · Gurugram, Haryana      Jan 2023 – Present · 3 yrs 6 mo
    VMC Setter-cum-Operator  ·  Jul 2024 – Present · 2 yrs
    VMC Operator             ·  Jan 2023 – Jun 2024 · 1 yr 6 mo
    VMC 3 & 4-axis, Fanuc · EN8, EN31 · automotive components
```

### Everything except the ask is already built

| Layer       | State                                                                                |
| ----------- | ------------------------------------------------------------------------------------ |
| Schema      | `worker_employment_role`, many-per-employment — **built**                            |
| Mapper      | `roleStints()` gives each stint its own range and refuses to inherit one — **built** |
| Template    | indented `.role` lines under the employer block — **built**                          |
| Ladder      | models the extra lines — **built**                                                   |
| **Capture** | `EmploymentEntrySchema.role_label` is a **single** role, per the Q1 v1 ruling        |

Our turner parity sheet renders the promotion correctly today when the rows are seeded. The
`worker-employment.dto.ts` docstring says so in as many words: _"the two-level schema stays
exactly as built and §11 #14 already renders a second role whenever one appears, so nothing has
to change to support them later."_ Later is now.

### The proposal

Extend the work-history form's employer card with **one optional repeat**: "Is employer ke paas
promotion hua?" → a second role label plus the month it started.

```
  employer_name, employer_city, start_ym, end_ym, role_label, work_done      (today)
                                     + roles: [{ role_label, start_ym }]     (proposed, max 2)
```

**Two roles, not N.** §11 #14's case is a promotion, and a third stint inside one employer is
rare enough that the render budget (Zone 4 is 62–86% of the page) is the binding constraint
rather than the schema. Capping at two keeps the worst case one line longer than today.

**Cost:** one optional sub-form on a screen the worker already fills, no engine ask, no
migration, and the sheet gets strictly better for exactly the seniors it currently under-serves.

### Why it matters more than it looks

An 8-year turner with one employer and no promotion capture renders as _one_ role for four years.
The same man with capture renders as an operator who became a setter — which is the single
strongest progression signal on the most-scanned zone, and it is the difference between "he has
been there a while" and "they promoted him".

**If the ruling is no:** the promotion path stays dormant and correct. Nothing regresses; seniors
keep losing the signal.

---

## §5 — the Zone 2 row budget

### 5.1 The re-fit recovers NOTHING, and the data says so

R9 §5 assumed the 56 positive residuals meant the estimator was systematically over-predicting
and that re-fitting would buy rows back. **Measured, it does not.**

The estimator's model is `headroom = C − LINE_MM × lines`, so each measured sheet yields its own
fitted `C`. Across all 56 (`docs/profiling/sheet-headroom-measurements.json`):

```
fitted C   min 208.97   median 218.03   max 240.03
residual   min  +8.47   median  +17.54  max  +39.57
```

The residual is not evidence of slack. It is **arithmetically identical** to `C_sheet − 200.49`:
the prediction uses the worst-case `C` for every sheet, so a sheet with a roomier `C` shows a
proportionally larger residual by construction. Every residual being positive means the worst
case is _correctly_ the worst case, not that there is headroom to reclaim.

Testing the budget directly:

| budget           | needs `C ≥` | sheets below the 5 mm floor                                          |
| ---------------- | ----------- | -------------------------------------------------------------------- |
| **41 (shipped)** | 205.49 mm   | **0**                                                                |
| 42               | 210.38 mm   | **2** — `shape-08-worker` at 3.59 mm, `shape-08-employer` at 4.47 mm |
| 43               | 215.27 mm   | **19** — including two that OVERFLOW                                 |

**`SHEET_LINE_BUDGET = 41` is exactly right and must not be raised.** The shipped value was
fitted to `C = 209.0`; the measured worst is `208.97`. It was correct to three significant
figures before anyone measured 56 sheets.

> **This also corrects R8 §3.** I recorded there that "the measured constants run 217–249" and
> proposed a re-fit. That range was estimated, not computed. The real range is 208.97–240.03 and
> the minimum is _below_ the fitted constant. The recommendation was wrong; the data now exists
> in the repo so the next person does not have to take my word for either version.

**So §5's conflict is real and cannot be dodged.** The turner cannot have Yadav's nine rows and
his completeness. Something must go.

### 5.2 The proposed turner nine

The turner map defines fourteen rows. Ranked (lower survives), the budget currently cuts here:

| #   | rank | row                   | in the nine? |
| --- | ---- | --------------------- | ------------ |
| 1   | 21   | Machines              | ✓            |
| 2   | 22   | Controllers           | ✓            |
| 3   | 23   | Machine capability    | ✓            |
| 4   | 41   | Setting               | ✓            |
| 5   | 42   | Workholding           | ✓            |
| 6   | 43   | Programming           | ✓            |
| 7   | 44   | Drawings              | ✓            |
| 8   | 51   | Measuring instruments | ✓            |
| 9   | 61   | Materials             | ✓            |
| —   | —    | —                     | **cut**      |
| 10  | 62   | **Tolerance held**    | ✗            |
| 11  | 63   | **Operations**        | ✗            |
| 12  | 71   | Quality               | ✗            |
| 13  | 72   | Troubleshooting       | ✗            |
| 14  | 81   | Sector worked         | ✗            |

**Proposed turner nine, with the reasoning for each:**

| #   | row                   | why it earns a slot on a TURNER's sheet                                                                                                                                                            |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Machines              | §5.1 rank 2 — the literal vocabulary of the advert                                                                                                                                                 |
| 2   | Controllers           | the same; a Fanuc man and a Siemens man are different hires                                                                                                                                        |
| 3   | Machine capability    | live tooling / bar feeder / sub-spindle is the turner's seniority marker. Yadav has no Zone 2 equivalent because milling puts axes in the Verdict Line instead                                     |
| 4   | Setting               | the operator→setter boundary IS the biggest pay step in the trade                                                                                                                                  |
| 5   | **Tolerance held** ⬆  | **promote 62 → 45.** The strongest pay signal a turner has, and the ratified MILLING sheet prints it at position eight of nine. A turner's sheet omitting what a miller's includes is indefensible |
| 6   | **Operations** ⬆      | **promote 63 → 46.** Facing / boring / threading / grooving — turning's core work vocabulary, with no milling counterpart at all. It is what a turner job advert lists                             |
| 7   | Programming           | one enum line, as the sample has it                                                                                                                                                                |
| 8   | Drawings              | GD&T is a real capability step                                                                                                                                                                     |
| 9   | Measuring instruments | how he PROVES the tolerance — it pairs with row 5 and is weaker alone                                                                                                                              |

**Dropped: Materials, Workholding, Quality, Troubleshooting, Sector worked.**

### 5.3 The structural answer that makes the choice less painful

**Materials does not have to lose its information.** Yadav's own sheet carries materials TWICE —
once as a Zone 2 row (`EN8 EN31 MS Aluminium`) and once inside every per-employer detail line
(`… · EN8, EN31 · automotive components`). Our turner sheet already prints the second:

```
CNC lathe, bar feeder and live tooling, Fanuc · EN8, EN31, SS316 · oil and gas fittings
```

So dropping the Materials ROW costs the reader nothing on a worker with any work history, and it
frees the ninth slot for Tolerance held. That is my recommendation: **move materials to the
detail line and promote tolerance**, rather than trading two ranked rows against each other.

### 5.4 The two closest calls, for the RVM redline

1. **Workholding versus Measuring instruments.** A miller clamps to a table; a turner's whole
   setup problem _is_ workholding, so 4-jaw and steady-rest work is arguably a stronger signal
   than owning a micrometer. I kept instruments because they pair with tolerance — but if a
   practising turner says workholding is more decisive, it is a one-line rank change.
2. **Machine capability versus Materials.** I rate live tooling / bar feeder / sub-spindle as the
   seniority marker; a shop that runs only chuck work may rate materials higher.

**Neither the drop order nor any rank has been changed.** The ladder is untouched; this is a
proposal with measured evidence attached (`yadav-parity.emit.test.ts` asserts that Tolerance
held, Operations and Sector worked are absent from a fully-answered turner's sheet today).

### 5.5 What the row budget is NOT

It is not the reason the turner sheet is short of parity. The fully-answered turner renders at
**275.67 mm of a 297 mm page — 21.33 mm of headroom, `degradationStage: 0`**. Zone 2 is capped by
`CAPABILITY_ROW_BUDGET = 9`, a _design_ budget quoted from the three ratified samples, and the
page would physically hold more. Raising that budget is a separate question from raising
`SHEET_LINE_BUDGET`, and the measurements say the page can afford roughly four more lines
(21.33 mm ÷ 4.89 mm) before the floor is in play — enough for **two or three more Zone 2 rows**
on this shape.

That is the option nobody has costed: **raise `CAPABILITY_ROW_BUDGET` from 9 to 11 for the turner
pack**, keep the drop order, and let the ladder take rows back on the sheets that cannot afford
them. It preserves the ratified design for every shape that matches the samples, and gives the
turner the two rows his trade needs. **Proposed, not applied** — it changes a number quoted from
the ratified samples, which is an owner call.
