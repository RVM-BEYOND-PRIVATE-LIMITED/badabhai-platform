# NEEDS PRAKASH

Questions that are genuinely the owner's to answer. Each one states the options, a
recommendation, and **the cost of silence** — what continues to happen while it stays open, so
"not yet" is a decision made with its price visible rather than by default.

Everything answerable from the repo, the Resume Engine guideline, or a documented default went
into `ASSUMPTIONS.md` instead. Nothing here blocked the work it appears beside; all of it was
built around.

---

## Status — all nine ruled, 2026-08-28 (R4)

The queue is closed. Nothing on the render track is waiting on a decision any more.

| #      | ruling                                                               | leaves behind           |
| ------ | -------------------------------------------------------------------- | ----------------------- |
| **Q1** | Option A, simplified — form screen, 4 employers, **one role each**   | build item 2.2          |
| **Q2** | One rider: the highest ITI/NCVT line is never dropped. Nothing else. | **built** — R4          |
| **Q3** | Closed as framed.                                                    | nothing                 |
| **Q4** | **Top item.** Build the bridge, turner-scoped.                       | build item 2.1          |
| **Q5** | Defer. Point figure keeps rendering.                                 | revisit at payer-salary |
| **Q6** | Defer with the Phase 3 deep link.                                    | nothing                 |
| **Q7** | Prakash runs the xerox test at the `sslip.io` length.                | nothing waits           |
| **Q8** | **One spine RATIFIED.** A decision now, not an assumption.           | nothing                 |
| **Q9** | Prakash commits the canonical file. Stub untouched.                  | nothing                 |

Deferred by name, so nobody rediscovers them as findings: drop-order ratification, capability
compression, semgrep `--strict`, the `ci.yml` trigger, the payer QR, salary bands.

---

## Q1 · How does a worker give us their work history?

**RULED (R4): Option A, simplified.** A post-interview form screen capped at four employers,
capturing three fields each — employer name (typed), city (chip), from/to month-year (chips) —
and writing **one role per employment**.

Capture does not ask about promotions in v1. The two-level `employments[] → roles[]` schema stays
exactly as built: §11 #14 already renders a second role correctly whenever one appears, so nothing
has to change to support promotions later. That is the point of having built it two-level.

Mobile work, `apps/worker-app`, **Rishi's tree** — PR and park. Build item 2.2.

**Status:** ruled; the WRITER is now a scheduled build item rather than an open question. The
reader, the render block and the schema all shipped.

`worker_employment` and `worker_employment_role` exist, are migrated, and render correctly
against seeded rows for every §11 case. Nothing writes to them, because how the question gets
asked is a product decision:

| Option                                          | What it costs                                                                                                                                                                                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Post-interview form screen** (recommended) | Mobile work (`apps/worker-app`, Rishi). A tap-and-chip flow: employer name typed, city chip, month/year chips, "add another?" gate, capped at 4–5. The worker is already in a finishing state and the sheet is the reward, so completion should be high. |
| **B. Extend the role pack**                     | **Not viable as-is.** `MAX_ENGINE_ASKS` is 24 and `qp_universal` already spends 8. A multi-employer loop needs ~6 keys per employer, so two employers exhausts the budget and the trade questions — the whole point of the pack — never get asked.       |
| **C. Ops-assisted capture**                     | Contradicts the "zero human ops" guardrail (§11 #11).                                                                                                                                                                                                    |
| **D. EPFO/UAN pull**                            | Part 10: V2 for the build, and it needs its own DPDP consent purpose, its own screen and its own revocation path. Not a V1 answer.                                                                                                                       |

**Recommendation: A**, scoped to four employers, matching the page budget.

**Cost of silence.** Every worker's Zone 4 keeps rendering the interim fallback — a role and the
worker's own words for a duration, with **no employer and no dates**. The guideline puts employer
and dates in the top six scanned elements (§5.1 rank 7), so this is the single largest remaining
gap between the sheet we print and the sheet that was ratified. It costs nothing structurally to
wait — precedence means workers flip over one at a time whenever the writer lands — but it costs
every worker who generates a résumé in the meantime.

---

## Q2 · Capability drop order — RVM redline needed

**RULED (R4): one rider, nothing else.** The highest ITI/NCVT qualification line is never
dropped, exactly the way availability and expected salary are never dropped. Costed at ~5 mm on
the tightest sheets; taken. **Built in R4** — `NEVER_DROPPED` now carries a seventh entry and the
ladder's education step preserves the top qualification line.

**Explicitly NOT built:** capability compression, and any re-derivation of the drop order. The
measurement is the reason it can wait — all 16 degrading sheets are overflow fixtures and their
injected variants, and no realistic profile reaches a capability row. The ratified list and the
tolerance-versus-machine-capability question both go to RVM at their next redline.

**Status:** the rider is closed and shipped. The two RVM items below are recorded for that
redline, not for this track.

A fully-answered CNC turner produces 14 capability rows and the page holds 9. Five must go. The
current order is derived from the guideline's §5.1 ranks, but which fact a hiring supervisor
would rather lose is a shop-floor question, not a layout one.

Currently surviving: Machines · Controllers · Machine capability · Setting · Workholding ·
Programming · Drawings · Measuring instruments · Materials.
Currently dropped, in order: Tolerance held → Operations → Quality → Troubleshooting → Sector
worked.

**The specific thing worth a second opinion:** **Tolerance held** (±0.01 mm) now drops while
**Machine capability** (live tooling, bar feeder, sub-spindle) survives. Both are strong pay
signals for a turner and I do not know which one a supervisor scans for first.

**A SECOND, SHARPER VERSION OF THE SAME QUESTION, surfaced by building the degradation ladder.**
Reverse §5.1 puts languages (rank 10), documents (9) and certificates/education (8) BELOW every
capability row (ranks 2–7). Measured on the ladder against realistic Zone 5 content, that means a
credentialled worker sheds his **entire credentials block — ITI, NCVT certificate, NSQF Level 4,
languages, documents — before he sheds one capability row.** `future-09-worker` lands at stage 4
and prints no education at all.

That is what the guideline's own ordering mandates, and it may well be right for an experienced
turner whose machines are the signal. It is much less obviously right for a young worker whose
NCVT certificate IS the signal. Today the question is latent — a fresher's sheet is nowhere near
the budget, so it never degrades — but it becomes live the moment work-history capture lands.

**The specific ask:** should the ladder protect ONE credential line (the highest ITI/NCVT
qualification) the way it protects availability and expected salary? One line, never dropped,
would cost about 5 mm on the tightest sheets and is trivially implementable — but it is a
shop-floor judgement about what an employer scans for, and that is yours.

**Cost of silence — REVISED UPWARD, and the earlier estimate is left visible rather than edited
away.** It said "low and fully reversible: one number per row in one file, no stored data, no
re-render obligation." The mechanical part is still true. The window it assumed has closed, and
it closed _because the work went well_:

- There are now **28 rendered sheets** and a page-fit measurement behind each one.
- The worst of them, shape 9's worker copy, has **0.00 mm of headroom** — it fits at exactly
  297 mm and spills at 296.75 mm (measured in WeasyPrint, journal §9).

A drop-order change alters WHICH capability rows survive, and rows differ in height once one of
them wraps. So a redline is no longer "one number per row": it is one number per row **plus a
re-measurement of all 28 sheets**, and on the shapes at the bottom of that table it can change
the answer to the one-page contract rather than just the content. That is a Docker WeasyPrint
run, not a unit test — cheap in effort, but it is no longer free and it is no longer local.

Still worth doing, and still the entry most likely to need it. It just wants doing in the same
change rather than as a follow-up.

### The default is REVISED — and it is now measured, not argued

Prakash's reasoning on the sharper version — given in the R3 directive, and explicitly NOT a
ruling; he asked for it logged as a proposed default. Reverse §5.1 is the wrong ordering to
derive a drop order from, because §5.1 ranks by **decisiveness for the ₹40 unlock** — Job 1 of §1.1. Dropping
strictly by it optimises Job 1 and destroys Job 3: the worker arrives at the gate and the sheet
no longer says he has his documents, which at that gate is the whole point. It also strips the
credential floor from exactly the ITI holder an MSME asks for.

**What the ladder actually did, across the 56-sheet matrix** (this is the evidence, not an
inference from the order):

| shed                   | on how many of the 56 sheets |
| ---------------------- | ---------------------------- |
| languages              | 16                           |
| documents ready        | 14                           |
| certificates           | 10                           |
| education              | 1                            |
| **any capability row** | **0**                        |

Sixteen sheets degraded. The ladder consumed the credentials block **entirely** and never once
reached a capability row. `future-09-worker` lands at stage 4 with no education line at all
while carrying every capability row it started with.

**REVISED DEFAULT, in force from now, and still awaiting your ruling and RVM's redline:**

> **Capability blocks compress before whole blocks drop.** A maxed-out turner carries 13
> operations, 12 setting capabilities, 10 workholding entries and 14 instruments. §4.3 already
> caps chips at 3–4 per row; the cascade extends that principle — exhaust compression inside
> Zone 2 before dropping any Zone 5 block. A turner listing eight setting capabilities instead
> of twelve loses almost nothing; a worker losing his ITI line loses the credential floor.

**This is a PROPOSED default, not a settled one.** The drop order needs to be its own ratified
list rather than derived from a ranking built for a different purpose — that is the actual ask,
and it is larger than "reorder the ladder".

**Reversal cost of the revision itself.** Lower than the reversal cost above, and worth stating
because it is the reason for logging it rather than building it:

- The ladder is a list of steps in one file with a per-step cost trace, so re-ordering steps is
  mechanical.
- Compression is NOT mechanical. Every step in the ladder today removes a whole element; a
  compressing step needs a per-row cap, an ordering within the row, and a rule for what the
  removed chips do to the row's meaning — none of which exists, and §4.3's caps are per-section,
  not per-degradation-stage.
- So the revision costs a re-measurement of 56 sheets (Docker WeasyPrint), and building
  compression costs a new mechanism. Those are different sizes and only the first is cheap.

**It is not urgent, and the measurement says why.** All 16 degrading sheets are the OVERFLOW
fixtures plus their injected variants. No realistic profile in the matrix reaches a capability
row. The revision changes nothing that renders today; it changes what happens the first time a
real turner's full history lands.

---

## Q3 · Devanagari — confirming this is CLOSED, not parked

**RULED (R4): closed, exactly as framed.** No transliteration engine. Recorded here only so the
decision is findable.

**Status:** **done.**

The guideline asks us to **store both scripts where the worker gives a Devanagari form** (§4.1)
and to render Latin on the employer-facing artifact and both on the worker's own copy (§11 #17).
It never asks us to _generate_ a transliteration, and auto-transliterating a person's name is
error-prone in exactly the way that matters — getting it wrong is a dignity failure on the one
artifact he forwards to people who know him.

Finished state, all three in place: the Devanagari font is in the API image
(`fonts-noto-core` — without it the line renders as empty boxes and _nothing fails_), the slot is
nullable and audience-gated inside the mapper, and it renders correctly when populated. No
transliteration engine is being built.

**Say so if you disagree** — that would make it a real item rather than a closed one.

---

## Q4 · B0b — the turner is unreachable, and that is not a résumé bug

**RULED (R4): this is now the TOP item.** Build item 2.1, turner-scoped.

The turner pack's fourteen answers are **closed-set chips**, so mapping them to
`canonical_role_id` and `skills[]` is a deterministic lookup — no LLM, no embeddings, no
confidence floor — and it does not touch the extraction path or the general canonicalization
problem. Done when `turner-reach.db.test.ts` goes green and its `it.fails` is deleted.

If a CNC-turning role id is not in the matchable set, that goes first as its own taxonomy change
(`packages/db` / `packages/taxonomy`, PR to Divyanshu).

**Status:** ruled and in progress.

A fully-answered CNC turner derives **zero** `worker_skill` rows and appears in **no** posting's
`job_reach`. `deriveWorkerSkills` reads `worker_profiles.canonical_role_id` and `.skills`; the
role-pack path writes neither (`toExtractionOutput` hardcodes both canonical ids to null —
deliberately, since an invented taxonomy id in the one place the match engine trusts absolutely
is worse than none), and the pack's fourteen answers land in `worker_attributes`, which no bridge
reads.

Measured, not inferred: `apps/api/src/resume/turner-reach.db.test.ts` asserts it against a real
Postgres, marked `it.fails` so CI stays green today and goes red the moment the bridge lands.

**Cost of silence.** A perfect résumé that no employer search can reach. The résumé work on this
branch does not move this number at all.

---

## Q5 · Salary renders as a point figure; the guideline wants a band

**RULED (R4): defer.** The point figure keeps rendering on the worker copy. Exposure is limited
to sheets a worker hands over himself, and the fix is an upstream field rather than anything the
renderer can do. **Revisit before any payer surface displays salary** — not before.

**Status:** deferred with a named trigger.

§4.4 is explicit: _"Bands, never a point figure — a point figure invites anchoring against the
worker."_ `resume_profile.expected_salary` is a single number, so a band could only be
manufactured from it, and inventing a range around a figure the worker gave is exactly the
derived claim §8 forbids. The sheet prints what they actually said.

The fix is a `salary_expected_band` field upstream, not arithmetic in the renderer.

**Cost of silence.** Every worker's asking price is anchorable. It reaches the worker's own copy
only — the payer disclosure withholds it — so the exposure is limited to sheets a worker hands
over himself, which is most of them.

---

## Q6 · The payer copy carries no QR at all — deliberate, or an omission?

**RULED (R4): defer, and decide it with the Phase 3 deep link.** Free while the QR points at the
homepage; by the time it points at `/w/<code>` the real question is what that page shows an
unauthenticated scanner, which is the review that page needs anyway.

**Status:** deferred, bound to Phase 3.

The worker's own sheet prints the footer QR. **The employer disclosure never does** —
`resume-disclosure.service.ts` builds its `TradeSheetContext` from the trade attributes and the
work history and sets no `qrDataUri`, `qrCaption`, `shortLink` or `footerMeta`. So the payer copy
prints a footer with no acquisition loop on it.

**Why it matters both ways, which is why it is a question and not a fix:**

- Part 12.2 makes QR-attributed signups the number the whole free-résumé investment is judged on
  at ninety days. The employer copy is the one that gets forwarded around a company, so it is
  plausibly the higher-traffic surface of the two.
- But it is also a scannable link on an artifact we hand to a party who has paid to unlock ONE
  worker. Where it points, and what it exposes to someone who scans it, is a disclosure-surface
  decision with the same shape as the three things that copy already withholds. Today the target
  is the bare site root (ruling 14), which is harmless; Phase 3 makes it `/w/<code>`, which is
  not obviously harmless.

**Recommendation: decide it WITH the Phase 3 deep link, not before.** While the QR points at the
homepage the choice costs nothing either way, and by the time it points at a worker's page the
question is really "what does `/w/<code>` show to an unauthenticated scanner", which is the same
review that page needs anyway.

**Cost of silence.** The payer copy keeps printing a footer with a gap where the QR sits on the
worker copy. Measured: it costs no page height (the footer text column is the taller element), so
this is an acquisition question and not a layout one.

**Noted alongside it:** the 14-shape matrix asserts the payer copy withholds exactly three things,
and it could not have caught this — it builds both audiences from ONE context, so an asymmetry
introduced by two different CALLERS is invisible to it. That is a real limit of that test and it
is recorded in the journal rather than quietly fixed.

---

## Q7 · The QR module floor is EMPIRICAL — it needs a xerox, not a ruling

**RULED (R4): Prakash runs it**, at the `sslip.io` payload length. **Nothing waits on it.**

**Status:** assigned. The protocol below is the deliverable; the result comes back to
`sheet-qr.gate.test.ts`'s `MIN_MODULE_MM` if it fails.

`sheet-qr.gate.test.ts` asserts a floor of **0.5 mm per module** on every sheet. That number is
from the QR printing literature (ISO/IEC 18004 and the GS1 print specifications), **not** from the
Resume Engine guideline — §6.3's photocopy clause governs fills and hairline rules and says
nothing about a symbol. So it is a plausible engineering default standing in for a measurement.

**The measurement is a physical act and I have no printer, no photocopier and no phone.** What it
needs is five minutes and a shop-floor-realistic setup:

1. Print `future-09-worker.pdf` (the tightest sheet) on ordinary paper at 100%, no scaling.
2. Photocopy it once on a ₹2 machine — the real one, not a good office copier.
3. Scan the QR off the **photocopy** with a mid-range Android at arm's length, indoor light.
4. Repeat with a photocopy of the photocopy, because sheets get re-copied.

Pass or fail on step 3 is the answer. If it fails, the floor is too low and the fix is a bigger
box, not a longer URL.

**It is coupled to B3 and only one of the two has been decided.** The 0.621 mm figure I reported
for the deep link assumes a SHORT host. Today's interim origin is not short:

| QR payload                                                                    | chars | modules | module size  |
| ----------------------------------------------------------------------------- | ----- | ------- | ------------ |
| `badabhai.ai` (what the sheet prints today)                                   | 19    | 25      | **0.720 mm** |
| `badabhai.ai/w/rk8m2q` (Phase 3, short host)                                  | 28    | 29      | **0.621 mm** |
| `payer.43-204-36-199.sslip.io/w/rk8m2q` (the interim origin, if it were used) | 45    | 33      | **0.545 mm** |

Same payload, denser code, smaller modules — and the box never changes size, so the sheet keeps
looking perfect while the modules shrink underneath it. **Deciding the final origin is therefore
part of deciding the QR floor**, not a separate question: a long host spends most of the margin
before the photocopy has spent any of it.

**Recommendation:** run the xerox test on the `sslip.io`-length payload, not the short one. If
that scans, every shorter origin is safe and the question closes for good.

**THE TWO UNCERTAINTIES COMPOUND, and that is the part worth reading twice.** The 0.545 mm the
`sslip.io` origin produces is **9% above** a 0.5 mm floor that is itself an unratified
engineering guess. So the sheet the acquisition thesis rests on carries two unresolved variables
stacked on one element:

| variable          | state                                                        | direction           |
| ----------------- | ------------------------------------------------------------ | ------------------- |
| the 0.5 mm floor  | from the printing literature, never met a photocopier        | unknown             |
| the origin length | B3 open; interim host is 45 chars against `badabhai.ai`'s 19 | pushes modules DOWN |

Neither alone is alarming. Together, a 9% margin against an unvalidated floor is not a margin —
and nothing on the sheet or in the gate would look any different if it were already too small.
The QR is the one element on the page whose failure is completely invisible until a worker holds
a photocopy under a phone in a factory gate queue.

**Cost of silence:** the floor holds against the literature but has never met a real
photocopier, and the acquisition metric §12.2 rests on it. Running the test at the SHORT payload
length would answer a question nobody is asking — the sheet in the field will carry whichever
origin B3 settles on, and today that is the long one.

---

## Q8 · Conflict B — one spine, or a template per trade family?

**RATIFIED (R4): ONE SPINE. Closed.**

Confirmed, not deferred. §7.1 already forbids skins from varying field order, section order,
column count or page count — which is most of what a per-family template would have existed to
change — so this is a confirmation of what the guideline already implies rather than a new
constraint.

**What this changes in how the code is described.** One spine has stopped being an assumption and
is now a decision. The render block, the fabrication gate, the QR gate and the degradation ladder
were all built on it; that is no longer load-bearing-on-an-open-question, it is four files
implementing a ratified design. Anything that would vary the spine per trade family now needs a
new ruling to undo this one, not merely a preference.

**Status:** **CLOSED.** The reversal analysis below is kept for the record, not as a live cost.

**The question.** Does every trade render through ONE spine — the layout `bb_trade.v1` fixes, with
the trade only supplying its capability vocabulary — or does each trade family eventually get its
own template, so a welder's sheet can be shaped differently from a turner's?

**The stale estimate, quoted so the change is visible.** It previously read that reversal was
cheap now and would get expensive "once a second template has fixtures." That was true when it
was written and the window has closed — because the work went well, not because it was ignored:

- **28 rendered sheets** exist, plus 28 more with the queued Zone 4/Zone 5 content in them.
- A render block, a fabrication gate, a QR gate and a degradation ladder all now assume **one
  spine**: the ladder's drop order is expressed in §5.1 ranks against a single section layout, and
  the headroom budget is fitted to that layout's chrome.
- Every one of those was built as though one spine were already ratified. That was the right way
  to build them — the alternative was building nothing while the question sat open — but it means
  the assumption is now load-bearing across four files rather than one.

**What a per-family template would now cost**: a second set of fixtures, a re-fitted line budget
(the chrome term is layout-specific), and a drop order per family rather than one. Not
catastrophic; no longer free.

**Recommendation: ratify one spine.** §7.1 already forbids skins from varying field order, section
order, column count or page count, which is most of what a per-family template would exist to
change. If that reading is right, this is a confirmation rather than a decision — and confirming
it explicitly costs nothing, while leaving it open keeps four files resting on an assumption.

**Cost of silence.** Everything keeps being built to one spine, so the cost keeps rising at the
rate the work goes well. That is the worst possible shape for an open question.

---

## Q9 · `AGENT_LOOP.md` does not exist — where is the real one?

**Status:** open, **low stakes, thirty seconds to answer**, and it blocks nothing.

R2 §5 asked for one line added to `AGENT_LOOP.md` §4. There is no such file: not at the repo root,
not under `docs/`, not under `.claude/`, and `git log --all --name-only` shows it has never
existed in any commit in this repository.

There is precedent for the canonical copy living outside the repo — the Resume Engine Design
Guideline is a `.docx` in a local Downloads folder rather than a tracked file — so it may simply
be somewhere I cannot see.

**What I did instead of dropping the rule:** created `AGENT_LOOP.md` at the root containing ONLY
§4 with the requested HALT trigger, with a header saying it was created rather than amended.
Sections 1–3 are deliberately absent; I do not know what they say and inventing them would be
worse than an incomplete file.

**RULED (R4), reconfirming R3 §5.2.** Prakash: the real file exists outside the repo and he will commit it.
The stub stays exactly as it is and must not be reconstructed — sections 1–3 arrive with the
canonical version. **This entry stays open only until that commit lands**, at which point the
stub's §4 merges into it.

**Cost of silence.** Now near zero, and bounded: two files claiming to be the agent loop, for as
long as it takes one commit.

### While looking: what the loop's state files actually are

Asked in the same breath, and the answer is not the expected one. Measured against
`git ls-files`, `origin/main` and `git log --all --diff-filter=A`:

| file               | on disk    | on `origin/main` | ever added, any branch |
| ------------------ | ---------- | ---------------- | ---------------------- |
| `NEEDS_PRAKASH.md` | yes        | **no**           | once — on this stack   |
| `ASSUMPTIONS.md`   | yes        | **no**           | once — on this stack   |
| `AGENT_LOOP.md`    | yes (stub) | **no**           | once — on this stack   |
| `LOOP_QUEUE.md`    | **no**     | no               | **never**              |
| `LOOP_JOURNAL.md`  | **no**     | no               | **never**              |

**Two are phantom.** `LOOP_QUEUE.md` and `LOOP_JOURNAL.md` have never existed here — not on
disk, not on `main`, not in any commit on any branch. They were not created, per the directive.

**And the other three are not on `main` either.** They exist only on the unmerged
`feat/cnc-turner-role-track` stack. Every question in this file, every assumption in
`ASSUMPTIONS.md`, and the HALT trigger itself live on a branch that has not landed. Worth saying
plainly: if this stack is abandoned, the entire question queue goes with it.
