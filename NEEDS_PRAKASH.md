# NEEDS PRAKASH

Questions that are genuinely the owner's to answer. Each one states the options, a
recommendation, and **the cost of silence** — what continues to happen while it stays open, so
"not yet" is a decision made with its price visible rather than by default.

Everything answerable from the repo, the Resume Engine guideline, or a documented default went
into `ASSUMPTIONS.md` instead. Nothing here blocked the work it appears beside; all of it was
built around.

---

## Q1 · How does a worker give us their work history?

**Status:** open. Blocks the WRITER only — the reader, the render block and the schema all
shipped.

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

**Status:** open. **Not blocking** — a default is in force and documented at `ASSUMPTIONS.md`
A2.

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

**Cost of silence.** Low and fully reversible: one number per row in one file, no stored data, no
re-render obligation. But it is wrong on some sheets in the meantime, and only a turner can say
which ones.

---

## Q3 · Devanagari — confirming this is CLOSED, not parked

**Status:** treated as **done**; flagging only because an earlier note listed it as outstanding.

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

**Status:** open, **out of scope on this branch** (`apps/api`, Divyanshu's tree). Recorded here
because it is the largest thing standing between this work and a placement.

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

**Status:** open, low priority, **not blocking**.

§4.4 is explicit: _"Bands, never a point figure — a point figure invites anchoring against the
worker."_ `resume_profile.expected_salary` is a single number, so a band could only be
manufactured from it, and inventing a range around a figure the worker gave is exactly the
derived claim §8 forbids. The sheet prints what they actually said.

The fix is a `salary_expected_band` field upstream, not arithmetic in the renderer.

**Cost of silence.** Every worker's asking price is anchorable. It reaches the worker's own copy
only — the payer disclosure withholds it — so the exposure is limited to sheets a worker hands
over himself, which is most of them.
