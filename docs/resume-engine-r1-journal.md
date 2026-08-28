# Resume Engine R1 — engineering journal

Branch: `feat/cnc-turner-role-track`. Design of record: **BadaBhai Resume Engine Design Guideline
v1.0** (CEO, 2026-08-27). Clause references below (`§4.3`, `§11 #7`) are to that document.

This file records what was **decided and why**, what is **interim**, and what was **measured
rather than reasoned**. Open questions live in `NEEDS_PRAKASH.md`; defaults taken without a ruling
live in `ASSUMPTIONS.md`.

---

## 1 · What shipped

| Zone                     | State                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------- |
| 1 — Identity             | Name, phone, Devanagari slot, verification badge slot. **Done.**                      |
| 1 — Verdict Line (§6.2)  | Composed on **both** source paths. Was rendering blank. **Done.**                     |
| 2 — Capability           | Pack answers → reviewed English labels, 9-row page budget, §5.1 drop order. **Done.** |
| 3 — Availability & terms | Available from, salary, preferred locations, relocation, shift. **Done.**             |
| 4 — Work history         | Reader + render block against `worker_employment`. **Reader done, writer blocked.**   |
| 5 — Credentials          | Education, certificates, languages, documents. **Render done, source seeded.**        |
| 6 — Footer               | QR, short link, generated date, ref code, disclaimer. **Done.**                       |

---

## 2 · Interim, and must not be read as done

### 2.1 · Zone 4 falls back to the tag-derived line

**The rule:** render from `worker_employment` when rows exist; otherwise fall back to
`resume_profile.experiences[]` — a role and the worker's own words for a duration, with **no
employer and no dates**. The mapper populates exactly one; never both.

**Why precedence rather than a cutover.** Nothing writes `worker_employment` yet
(`NEEDS_PRAKASH.md` Q1). Precedence means the capture surface, whenever it lands, flips workers
over **one at a time** — no backfill, no migration, no flag, no coordinated release.

**This is not the designed shape.** The guideline's Zone 4 is "up to four employers, reverse
chronological: employer · role and function · city · months · machine run", and §5.1 ranks
employer and dates seventh of eleven. The fallback prints neither. It exists so the zone is
populated today and it is the largest remaining gap between what we print and what was ratified.

### 2.2 · Overseas country rides in `employer_state`

§11 #15 says render the country, and Gulf experience is a genuine differentiator. There is no
`country` column and adding one was not in this change's scope, so capture writes "UAE" / "Saudi
Arabia" into `employer_state` and the location suffix prints it verbatim. Correct on the page,
wrong in the model. A `country` column is the fix if this data is ever queried.

### 2.3 · Salary is a point figure

§4.4 asks for a band. `resume_profile.expected_salary` is a single number, so a band could only
be manufactured — the derived claim §8 forbids. See `NEEDS_PRAKASH.md` Q5.

### 2.4 · Zone 5's source is the caller, not the extractor

Phase C returns nine keys and none is a credential. The render block and its fixtures are built
against caller-supplied values; widening Phase C is a separate item against a different surface
(`apps/ai-service` — the AI privacy boundary, and `ai-contracts` is frozen, so it needs a joint
TS + Python + fixture PR). Opened and parked; not chased here.

---

## 3 · Closed, not parked

**Devanagari transliteration will not be built.** §4.1 says store both scripts _where the worker
gives a Devanagari form_; §11 #17 says render Latin on the employer artifact and both on the
worker's own copy. Neither asks us to _generate_ one. Auto-transliterating a person's name is
error-prone in the way that matters most — getting it wrong is a dignity failure on the one
artifact he forwards to people who know him. Finished state: font in the image, slot nullable and
audience-gated inside the mapper, renders correctly when populated.

The font is load-bearing and easy to lose: `fonts-noto-core` in `apps/api/Dockerfile`. DejaVu
carries no Devanagari at all, so without it the name line renders as a row of empty boxes and
**nothing fails** — the PDF generates, uploads and downloads exactly as it should.

---

## 4 · Defects the work found (none of these were on the list)

1. **`.sec-work` could never be `:empty`.** `<div class="emp-more">` sat inside the container and
   outside both repeats, so an ITI fresher with no employment rows got the WORK HISTORY heading
   with nothing under it — the one outcome §11 #1 forbids by name. Fixed by making the overflow
   tail a 0-or-1 region. Found by fixture shape 1, not by review.
2. **The container's availability token printed raw.** `Available from immediate` — the #963
   defect again (`education_level` once printed `below_10`). The container deliberately keeps the
   model's own vocabulary so it stays diffable against its Langfuse trace; that is a storage
   decision, and §8 stage 5 renders a _label_. Humanised at the edge. Found by the fabrication
   gate.
3. **A formatter broke a lint suppression.** `EMOJI_RE` in `question-pack-corpus.ts` was reflowed
   onto two lines, moving `eslint-disable-next-line` off the regex literal — precisely what that
   file's own comment warned would happen. Replaced with a block disable, which is invariant
   under reflow.
4. **`findReachRow(workerId, jobPostingId)`, not the reverse.** The reach gate called it
   backwards and reported "not reachable" against a database that _did_ hold the row. Only
   running it against a real Postgres exposed that; the assertion would otherwise have looked
   like evidence for B0b while actually testing nothing.
5. **Three shapes rendered TWO PAGES.** The content budgets held and the _page_ did not — shapes
   5, 6 and 9, on both audiences, spilled the footer onto a second sheet. This is the finding the
   whole matrix existed for: the budgets were measured against the three ratified sample résumés,
   and all three are well-formed mid-length profiles. A budget checked only against the design's
   own examples has been checked against the easy cases. See §7.
6. **§11 #9's auto-fit was never implemented.** The rule is "auto-fit down to the 18pt floor,
   _then_ wrap" and the sheet only ever did the wrapping half. Not cosmetic: shape 9's worker
   copy is two pages at 20pt and one page at 18pt.

---

## 5 · RLS posture on the two new tables — intentional

`worker_employment` and `worker_employment_role` are **RLS-enabled, FORCED, with zero policies**
and `REVOKE ALL` from `PUBLIC`, `anon`, `authenticated` and `service_role`. This is deny-by-
default and it is deliberate, matching `worker_attributes`: nothing reaches these rows except the
API's `BYPASSRLS` connection. `FORCE` matters because it applies to the table **owner** too, so a
future `postgres`-owned job cannot read a worker's employment record by accident. A policy is not
merely absent — with FORCE and no policy the table is closed, and any later policy is an explicit,
reviewable decision rather than a widening of something already open.

Verified on a database migrated from empty: `relrowsecurity=t`, `relforcerowsecurity=t`,
`policies=0` on both tables; `information_schema.role_table_grants` lists only the owner.

---

## 6 · Evidence

Every claim below was executed, not reasoned. Commands and results are in §7 of the handoff.

- **API suite** — 6310 passed / 84 skipped, 372 files, exit 0.
- **packages/db** — 107 files, 2330 passed / 12 skipped. _(Run it from inside `packages/db`: several
  suites resolve `data/taxonomy/...` relative to `cwd`, so `vitest --root packages/db` from the
  repo root fails 8 files for a path reason that has nothing to do with the code.)_
- **§11 work-history suite** — 23 tests, and 5 mutations each kill it (budget 4→5; inclusive
  month `+1` dropped; overflow total ignoring unstated rows; "Duration not stated" → "Fresher";
  work-line cap 2→1).
- **Fabrication gate (§8)** — 32 tests over all 14 shapes × both audiences. Killed by: an
  injected adjective (13 failures), a tenure rounded up a year (7), a raw token reaching the page
  (13). _Not_ killed by the silent-overflow-total mutation — that one is caught by the §11 suite
  instead, and no shape mixes stated and unstated durations at the overflow boundary.
- **Shape matrix** — 65 tests, 14 shapes, both audiences. Shapes 5, 6, 8, 9, 11 each genuinely
  exceed a budget before truncation (asserted, so a "stress" fixture cannot quietly stop being one).
- **Migration 0094** — applied from empty via the SQL train (87 tables) and via `drizzle-kit
migrate` (95 recorded, `max(created_at)=1787749973672` — the pinned value).
- **DB-backed CI gates** — all 9 files pass together under `--no-file-parallelism`, on both a
  psql-migrated and a drizzle-migrated database.
- **XFAIL(B0b)** — proven in both directions: without the marker both assertions fail today with
  the stated messages; with the role bridge simulated, both go red with "Expected test to fail".

- **ONE PAGE — measured, all 28 sheets.** Every content shape, both audiences, rendered through
  WeasyPrint: **28/28 on exactly one A4 page (794×1123pt).**

---

## 7 · The one-page contract, and how it was actually won

The first real render found **six sheets on two pages** — shapes 5, 6 and 9, worker and employer.
The content budgets were all satisfied; what did not fit was the footer, by a few millimetres.
That is the whole argument for rendering the stress shapes rather than reasoning about row counts.

Two mechanisms fixed it, and both are load-bearing — reverting either puts sheets back onto a
second page (measured, not assumed):

| Mechanism                                                                            | Revert it and…                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| A lone **undated** role rides the employer line instead of taking one of its own     | **6 sheets** over one page (shapes 5, 6, 9 × both audiences) |
| §11 #9 auto-fit: a name past the measured one-line width drops to the **18pt floor** | **1 sheet** over one page (shape 9, worker)                  |

**Neither weakens a ruling, and the first one had to be written carefully so it could not.**
§11 #14 requires a promotion to render as one employer block with two _dated_ function lines, and
the obvious version of this change — "put the role on the employer line" — would have flattened
exactly that, turning five continuous years at one company into something that scans as a
job-hop. The condition is therefore narrow: **exactly one stint, and that stint renders no dates
of its own.** A promotion fails both halves. A single role whose dates differ from the
employment's also keeps its line, because that difference is a fact the worker stated. Both cases
are pinned by their own tests, so a future page-budget squeeze cannot quietly widen the condition.

The auto-fit threshold (`NAME_ONE_LINE_MAX = 27`) was **measured in WeasyPrint against the real
sheet**, not estimated. A character count is a proxy for a width, and it is the only proxy
available — CSS cannot measure text and WeasyPrint runs no JavaScript. The proxy is safe in the
direction that matters: the smaller size is the guideline's floor, so a mis-measured wide name
drops to 18pt and wraps (which §11 #9 explicitly permits) and can never be shrunk below the floor
or truncated at any length. A test pins 18pt as the minimum heading size anywhere in the sheet,
because the obvious next move on the next overflow is to add a third, smaller step.

### How to re-measure

```bash
EMIT_SHEETS=<dir> pnpm --filter @badabhai/api run test sheet-shape-emit
docker run --rm -v <dir>:/w -w /w bb-weasy:local python3 -c   "import glob; from weasyprint import HTML;    print([f for f in sorted(glob.glob('shape-*.html')) if len(HTML(filename=f).render().pages)!=1])"
```

Counting `/Type /Page` in the PDF bytes does **not** work — WeasyPrint writes compressed object
streams, so a byte scan reports zero pages for every file and reads as "all clear".

### What is NOT verified here

- **Glyph-level fidelity.** Page count and layout are measured; nobody has looked at all 28
  sheets. The Devanagari line in particular renders from a font that is present in the API image
  but is not exercised by any fixture (`nameDevanagari` is null throughout — see §3).
- **The `<300KB` and filename rules of §6.3.** Rendered sizes are 7–19KB, comfortably inside the
  cap, but the `Name_Trade_City_BadaBhai.pdf` filename convention is applied by the download
  surface and was not touched here.

---

## 8 · Digest — R1 packet complete

| Packet item                                            | State                                                                                                                |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| §1 Work-history reader + render block, seeded fixtures | Done. §11 #3/#4/#5/#6/#7/#14/#15 each pinned by name. Precedence rule in force; fallback recorded as interim (§2.1). |
| §1 Qualification render block + fixtures               | Done. Phase C crosswalk extension opened and parked (§2.4).                                                          |
| §2 Devanagari                                          | Closed, not parked (§3).                                                                                             |
| §3 Tier vocabulary                                     | Default taken: five in the schema, two in the UI. `ASSUMPTIONS.md` A1.                                               |
| §3 Drop order                                          | Default taken and flagged for RVM redline. `ASSUMPTIONS.md` A2, `NEEDS_PRAKASH.md` Q2.                               |
| §4.1 Match assertion, XFAIL(B0b)                       | Built and proven in both directions.                                                                                 |
| §4.2 Fabrication gate                                  | Built. 32 tests, three mutations kill it.                                                                            |
| §4.3 14-fixture matrix                                 | Built. **Found three shapes on two pages.** Fixed and re-measured.                                                   |
| §4.4 Milling regression                                | Green in the same run.                                                                                               |
| §4.5 0094 whitespace claim                             | Shown, not asserted — and the original claim was incomplete.                                                         |
| §5 ASSUMPTIONS / comments / RLS confirmation           | Done.                                                                                                                |

### The commands, and what they printed

```
apps/api      : npx vitest run                    → 360 files, 6314 passed / 85 skipped   exit 0
packages/db   : npx vitest run   (from packages/db) → 107 files, 2330 passed / 12 skipped  exit 0
typecheck     : npx turbo run typecheck           → 29 successful, 29 total                exit 0
eslint        : npx eslint apps/api/src packages/db/src → no output                        exit 0
prettier      : --check on every file this branch owns → "All matched files use Prettier code style!"
one page      : 28 sheets rendered in WeasyPrint   → one-page: 28   over: none
DB gates (9)  : RUN_DB_TESTS=1 vitest --no-file-parallelism … turner-reach.db
                                                   → Test Files 9 passed (9), Tests 76 passed
migration     : drizzle-kit migrate from empty     → 95 recorded, max(created_at)=1787749973672
```

**Milling regression (§4.4).** `skill_milling` fixtures live in `resume-render-input.test.ts`
(7 assertions) and `resume-render.processor.test.ts`; `qp_machining` is covered by the pack corpus
suites in `packages/db`. All are inside the two suite runs above — the turner pack **adds** a map
entry and a pack file and edits nothing in the wedge.

**§4.5 — the 0094 claim, corrected.** "Only whitespace inside `CHECK (`" was true of the DDL and
**not** of the file: regeneration also dropped two comment blocks, which I had not noticed and
have now restored. There is no `git diff` to paste — 0094 is a new, untracked file — so the
comparison is against the hand-written copy that was actually applied:

```
executable DDL, comments and whitespace stripped:
  applied  sha256 b1f973b9adee8791   len=3987
  repo     sha256 b1f973b9adee8791   len=3987      → IDENTICAL
formatting difference : the two ym_format CHECKs collapsed from 3 lines to 1
comment difference    : 2 blocks dropped by regeneration → RESTORED
```

**§5 RLS confirmation, in one line.** Deny-by-default on both new tables is intentional and
matches `worker_attributes`: `ENABLE` + `FORCE ROW LEVEL SECURITY`, **zero policies**, `REVOKE ALL`
from `PUBLIC`/`anon`/`authenticated`/`service_role` — verified on a from-empty database as
`relrowsecurity=t, relforcerowsecurity=t, policies=0`, with only the owner holding grants (which is
exactly why `FORCE` is there).

### Known gaps in the evidence, stated rather than left to be found

- **The silent-overflow-total mutation survives the fabrication gate.** It is killed by the §11
  suite instead. No content shape mixes stated and unstated durations _at the overflow boundary_,
  which is the fixture that would close it.
- **`packages/db` must be run from inside the package.** Several suites resolve
  `data/taxonomy/...` against `cwd`, so `vitest --root packages/db` from the repo root fails 8
  files for a path reason that has nothing to do with the code. Worth knowing before anyone reads
  that as a regression.
- **Nobody has looked at all 28 sheets.** Page count and layout are measured; glyph-level fidelity
  is not, and the Devanagari line is exercised by no fixture.

---

## §9 — Landing the branch: CI as the verification, and three gaps closed

Everything above §8 was verified on a developer machine. This section is the first time these
gates ran in the environment that gates merges, plus the three verification gaps that reading
exposed. Branch pushed at `66e2f72e`; PR **#1292**.

### 9.1 — What CI found that the local run could not

Two failures, both real, neither visible locally.

**SAST (semgrep `p/typescript`) — `detect-non-literal-regexp`, 2 blocking findings.**
`new RegExp` composed from the slot name, at the two region-engine sites. The construct PREDATES
this branch — `origin/main` has both — but moving them into `fillObjectRegion` /
`fillStringRegion` changed their fingerprint, so the baseline diff surfaced them as introduced.
Semgrep is not run by any local gate, so nothing here could have caught it.

Suppressing was the cheap read and would have been wrong. The rule is right about this code for a
reason that is not ReDoS: **a slot name carrying regex metacharacters stops being a name and
becomes a pattern.** A list called `a.*b` compiles to a wildcard, matches a region it does not
own, and splices one worker's list into another section of the sheet — rendering perfectly, and
wrong. One hardcoded literal now matches any region, and the name is captured and compared with
`===`. Escaping would have fixed the same bug and left a composed regex behind; the literal
removes the class.

The backreference fell out of it as a correctness upgrade rather than plumbing — the closing tag
must repeat the opening name, so a region opened with one name and closed with another is no
longer a region at all. **Measured:** dropping it fails four behavioural tests plus the new guard.
A third, unflagged copy of the same construct in the legacy list path was folded into
`fillStringRegion` in the same change; semgrep never fingerprinted it because the diff did not
touch it, and leaving it would have handed the finding to whoever refactored nearby next.

**Node — `db:eval:occupation`: family precision 95.7%, floor 97.0%.**
Lint, typecheck and the whole test suite passed; the retrieval eval did not. 17 wrong-family rows
against main's 7.

It is **not** a quality regression, and the difference matters. Bisected by reverting
`_families.jsonl` alone: main scores 98.2%. Then `--failures` named all ten new rows:

```
want fam_machining  got fam_cnc_turning  "kharad ka kaam karta hun"
want fam_machining  got fam_cnc_turning  "lathe machine chalata hun"
want fam_machining  got fam_cnc_turning  "cnc turning ka kaam"
...ten of them, every one a turning utterance
```

The retrieval was **righter than the label**. The cause is structural: the gold set is labelled to
an ISCO unit, so the eval resolves the expected family through a _synthetic_ domain id and only
unit-and-above bindings can match it. `fam_cnc_turning` binds by `job_domain_id` inside unit 7223,
alongside `fam_machining` which binds the whole unit — so every utterance that family exists to
serve scores as WRONG, permanently and by construction. The metric could not express a sub-unit
family, and until one existed nothing revealed that.

The fix is in the metric, and the floor was not touched. A hit whose unit equals the gold row's
unit but whose family differs is counted as a **refinement**, not an error, and reported
separately in the CI log — always, never behind a flag, because the one way a counted-as-correct
category can do harm is by being invisible. Same-unit is a sound test rather than a convenient
one: the expected family cannot resolve below unit level, so if the units agree and the families
differ, the only thing that can have caused it is a domain-level binding inside that unit.
**Measured:** deleting the same-unit condition fails three tests, including `"darzi"` under unit
7223, which must stay a failure. Result: **98.2%, exactly main's baseline, with main's same 7
failures.**

### 9.2 — §3.1 Page fit: the margin, not the verdict

`28/28 on one page` was a binary and the directive was right that it hides the distribution.
Re-measured properly: binary-search the shortest page height at which each sheet still renders on
ONE page, using WeasyPrint's own layout (`headroom = 297 mm − that height`), resolution 0.25 mm.
This is a whole-page measurement, so margins, break behaviour and the footer's flex row are all in
it — which "bottom of the last box" is not.

| headroom    | sheet             | headroom  | sheet             |
| ----------- | ----------------- | --------- | ----------------- |
| **0.00 mm** | shape-09-worker   | 32.00 mm  | shape-08-worker   |
| 3.76 mm     | shape-06-worker   | 37.77 mm  | shape-08-employer |
| 5.65 mm     | shape-09-employer | 102.02 mm | shape-07-worker   |
| 9.41 mm     | shape-06-employer | 105.79 mm | shape-02-worker   |
| 9.91 mm     | shape-05-worker   | ...       | ...               |
| 15.56 mm    | shape-05-employer | 162.51 mm | shape-13-worker   |
| 20.96 mm    | shape-11-worker   | 168.15 mm | shape-13-employer |
| 26.73 mm    | shape-11-employer | 231.53 mm | shape-14 (both)   |

**Worst case: shape 9's worker copy, 0.00 mm.** It fits at exactly 297 mm and spills at 296.75 mm.
The one-page contract holds on that sheet by nothing at all. Only five of the fourteen shapes are
under 20 mm, and they are exactly the five built to overflow — the design's own examples all sit
above 100 mm, which is precisely why measuring against them proved so little.

**Does the reserve survive what is queued? No — and that is the answer, not a caveat.** Both items
land inside Zone 4 and Zone 5. Measured directly on shape-09-worker:

```
+ one Zone 5 row (a Phase C certificate line)   -> pages@A4 = 2
+ one Zone 4 block (a captured employer)        -> pages@A4 = 2
```

So **work-history capture and Phase C each break the one-page contract on the worst-case sheet on
their first row.** Not eventually: immediately. Whichever lands first has to arrive with a
degradation stage for the shapes at the bottom of that table — a fifth capability row dropping, or
the employment block collapsing to the count line earlier. That is a real design item, it belongs
to the change that spends the margin, and flagging it now is the whole point of having measured.

Seeded fixtures are also shorter and more regular than real data. These sheets use realistic
employer names and a full credentials block, but nothing here has met a real Hinglish certificate
string, so the numbers above are an optimistic bound on the shapes at the top of the table.

### 9.3 — §3.2 The QR: a real fixture gap whose conclusion survived

**The gap was real.** Every fixture carried `qrDataUri: null`, so none of the 28 sheets had a QR
and the footer being measured was not the one production prints. Nothing asserted otherwise.

**The inference from it was wrong, and the two get separated.** `.qr` reserves 18 mm × 18 mm in
the section that was overflowing, so the expected cost was ~12 mm of page and a re-broken one-page
contract. Measured across the sheets, with and without:

```
sheet                     no-QR (mm)  with-QR (mm)   delta
shape-09-worker.html            0.00        0.00      0.00
shape-06-worker.html            3.76        3.76      0.00
shape-05-worker.html            9.91        9.91      0.00
shape-08-worker.html           32.00       32.00      0.00
shape-11-worker.html           20.96       20.96      0.00
shape-01-worker.html          133.14      133.14      0.00
```

**Zero, on every sheet.** `.foot` is a flex ROW and `.foot-txt` is five lines at 8.6 pt / 1.43 —
about 21.7 mm — so the text column is already taller than the image and the QR costs width, not
height. The fixture was wrong; the page-fit conclusion it fed was not. It also means any future
change that SHORTENS the footer text silently hands the 18 mm box back its ability to drive the
page height.

`sheet-qr.gate.test.ts` — 31 tests — now asserts, on every sheet:

- exactly one QR, as an inline SVG data URI, never a raster and never a remote fetch;
- a legal module count (`17 + 4v`), which is also what proves no quiet zone was baked into the
  symbol — with the spec's 4-module margin the viewBox would be `N + 8`, never a legal size, and
  the modules would have shrunk INSIDE the reserved box instead of gaining space around them;
- **module size ≥ 0.5 mm.** Today: 25 modules in 18 mm = **0.720 mm**;
- the CSS box equals `RESUME_QR.RENDERED_MM`, so the constant every margin is reasoned from cannot
  drift from the box that actually prints;
- the bytes are the **level-Q** encoding — compared against what L, M, Q and H actually produce,
  not read off a constant. Q and L land on the same version for today's short URL, so size alone
  cannot tell them apart; asserting `!= L` and `!= H` is what makes the equality mean "level Q";
- the **scheduled** deep link stays above the floor: `/w/<code>` → 29 modules → 0.621 mm.

The 0.5 mm floor is from the QR printing literature, not from the guideline — §6.3's photocopy
clause governs fills and hairlines and says nothing about a symbol. Flagged for redline as
`NEEDS_PRAKASH` Q7.

**And it found a defect on its first run.** One `try` in `resume-render.processor.ts` wrapped the
attributes load, the phone decrypt, the QR build, the employments load and the entire footer. A
throw from `loadTradeSheet` left the context null — costing the sheet its phone (owner-ruled onto
both copies), its QR, its ref code and its footer, none of which read a single trade attribute.
The file's own comment one level down states the rule this broke: _"a failure here must cost the
work history and nothing else."_ Now four independent steps, each degrading alone, and the context
is never null. The sheet rendered perfectly without any of it, which is why nothing had noticed.

**One asymmetry surfaced and deliberately not fixed:** the payer disclosure path supplies no QR at
all. That is `NEEDS_PRAKASH` Q6, because putting a scannable link on a payer-facing artifact is a
disclosure decision. Worth recording separately: the 14-shape matrix asserts the payer copy
withholds exactly three things and **could not have caught this**, because it builds both
audiences from ONE context — an asymmetry introduced by two different callers is invisible to it.

### 9.4 — §3.3 Is the DB step actually gated?

**It runs on every `pull_request` to `main` whose diff touches the relevant paths — no runner
label, no manual arming.** The step itself is unconditional; the gating is one level up.

- `.github/workflows/ci.yml` triggers on `pull_request: branches: [main]`.
- The step lives in the `e2e` job, whose only condition is
  `if: needs.changes.outputs.e2e == 'true'` — a `dorny/paths-filter` on `apps/api/**`,
  `packages/**`, `tests/**`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`,
  `apps/ai-service/**`, and `.github/workflows/ci.yml`.
- The step carries no `if:` and no `continue-on-error:`.

**The XFAIL flip is safe.** `turner-reach.db.test.ts` is in `apps/api/`, and the B0b bridge will be
too, so any change that could make the turner reachable also fires the filter. It cannot land
while the gate sits skipped.

The step's own internal assertions are what make its green non-vacuous: it asserts per FILE that
each gate ran and was not `skipped` (`describe.skipIf` would otherwise exit 0 reporting "skipped"),
and that exactly `Test Files 9 passed (9)` ran — so an arg-forwarding slip that reruns the whole
suite fails loudly instead of passing on unrelated tests.

**Verified on PR #1292, not reasoned:** the `e2e` job's step conclusions are all `success`,
including `DB-backed gates (... + turner reach)`.

### 9.5 — CI status, by job

Run `33128894992` on `a2e925e3`:

| job                                                | result                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| changes                                            | pass                                                                                                               |
| Node (lint / typecheck / test / build)             | **fail** — `db:eval:occupation` (§9.1); lint / typecheck / test all passed                                         |
| AI service (pytest / ruff)                         | pass                                                                                                               |
| E2E (Phase 1 onboarding flow)                      | **pass** — incl. the 9-file DB-gated step                                                                          |
| sast / SAST (semgrep OSS)                          | pass (after the fix; failed on `66e2f72e`)                                                                         |
| worker-app / payer-app (analyze / test)            | pass                                                                                                               |
| deps-audit                                         | pass                                                                                                               |
| Image gate (ai-service / payer-web / admin-web)    | pass                                                                                                               |
| Migration drift · Migration sequence               | pass — **but both assertions are `continue-on-error: true`**; the drift STEP genuinely succeeded, checked directly |
| Payer app (build + release APK) · Supabase Preview | **skipping**                                                                                                       |
| ci-required                                        | fail (Node)                                                                                                        |

Two `skipping` entries, named because a skipped gate reads green and is not one. `Payer app (build

- release APK)`runs only on`main`, and `Supabase Preview` is the vendor integration, not a gate
  in this repo.

### 9.6 — Local gates after the fixes

```
apps/api      vitest run              361 files   6347 passed | 85 skipped   exit 0
packages/db   vitest run (from pkg)   107 files   2333 passed | 12 skipped   exit 0
apps/api      tsc --noEmit                                                    exit 0
db:eval:occupation   hit rate 97.0% >= 95.0% · family precision 98.2% >= 97.0%  exit 0
WeasyPrint    28 sheets / 28 one-page / 0 over · worst headroom 0.00 mm
```

---

## §10 — Packet digest

**Landed.** Branch `feat/cnc-turner-role-track` pushed and PR **#1292** open against `main`,
parked for the owner: it touches `packages/db`, `packages/taxonomy` and `packages/validators`.
Three commits — the R1 body, the SAST fix, and the three-gap close.

**What the work was at risk of, and no longer is.** The whole packet sat uncommitted on a
working tree containing an APPLIED migration. 0094 existed in a live database and in no version
control. That is closed first and confirmed four ways: `HEAD` equals the remote, the tree is
clean, 95 `.sql` files reconcile with 95 journal entries, and the pinned `when` (`1787749973672`,
still the `MAX`) plus both restored comment blocks are present in the committed blob.

**CI found two things the local run structurally could not, and the QR gate found a third.**

1. **SAST — `detect-non-literal-regexp`.** Pre-existing on `main`; my refactor re-fingerprinted
   it so the baseline diff read it as introduced. Fixed rather than suppressed: a slot name
   carrying regex metacharacters stops being a name and becomes a pattern, and would splice one
   worker's list into another section of the sheet. Semgrep runs in no local gate.
2. **`db:eval:occupation` — 95.7% against a 97.0% floor.** Not a regression. The gold set is
   labelled at ISCO-unit granularity, so a family bound BELOW unit level is unrepresentable and
   scores wrong by construction; all ten were turning utterances and the retrieval was righter
   than the label. Fixed in the metric, floor untouched, back to **98.2% — exactly main's
   baseline, with main's same seven genuine failures.**
3. **One `try` cost the sheet its phone, QR, ref code and footer.** A throw from
   `loadTradeSheet` left the render context null and took down four things that read no trade
   attribute. The file's own comment one level down forbids exactly this.

**The three verification gaps.**

- **§3.1 Page fit.** Worst case is **0.00 mm** — shape 9's worker copy fits at exactly 297 mm and
  spills at 296.75. Only five of fourteen shapes are under 20 mm and they are precisely the five
  built to overflow; every shape resembling the design's own samples sits above 100 mm. **The
  reserve does not survive what is queued:** one Zone 5 row OR one Zone 4 block takes that sheet
  to two pages. Work-history capture and Phase C each break the one-page contract on their first
  row, so whichever lands first must bring a degradation stage with it.
- **§3.2 QR.** Now asserted on every sheet — one inline SVG, a legal module count (which also
  proves no baked-in quiet zone), module size ≥ 0.5 mm (today 0.720), the ratified 18 mm pinned
  on its own terms, and level Q proven against what L/M/Q/H actually produce. The scheduled
  `/w/<code>` deep link is measured too: 0.621 mm, still above the floor.
- **§3.3 Gating.** The DB step is unconditional inside a job gated only by a `dorny/paths-filter`
  covering `apps/api/**` and seven more paths. No runner, no label, no `continue-on-error`. B0b
  lands in `apps/api`, so the XFAIL cannot flip while the gate sits skipped. Verified on the run,
  not reasoned: the `DB-backed gates (… + turner reach)` step conclusion is `success`.

**One correction to my own record.** I wrote that `supabase-checks.yml` is `disabled_manually`
(TD97) and that no drift gate exists. It is **active**, and its drift assertion genuinely
succeeded here — `drizzle-kit generate` produced no diff, which independently confirms schema.ts
↔ 0094 are in sync and that the hand-edited journal survives a regenerate. But both its assertion
steps are `continue-on-error: true`, so the check is green either way, and neither job reads
`when`. The pin conclusion stands for a different reason than I gave. `ASSUMPTIONS.md` A7 records
the class: four claims now that ran, exited 0, and answered a different question than the one
being asked.

**Final CI state — run `33130115614` on `7502027c`: `ci-required` SUCCESS, every job green.**
`Node`, `E2E` (including the nine-file DB-gated step), `SAST`, both image gates, both Flutter
apps, deps-audit and the two `supabase-checks` jobs all pass. Five `skipped` entries are named
in §9.5 rather than left to read as green; all five are main-only or vendor.

One failure on the way there was **not** this branch: `worker-app` failed on
`voice_form_interruptions_test.dart:191` with `Bad state: No element`. Measured rather than
waved off — this branch changes ZERO files under `apps/worker-app`, the identical tree passed on
the previous run, and re-running the job with no change passed. Filed as **#1293** for the owner
rather than fixed here, because `apps/worker-app` is not backend's to touch.

**Still not bought, and still the whole gap:** work-history capture (Q1), Phase C, and B0b. The
sheet is verified; the turner is not reachable. None of those is on this branch and none is fixed
by merging it.

---

## §11 — R2: the degradation stage, and the control run behind the metric change

### 11.1 — The control the metric change needed

The R1 case for changing `db:eval:occupation` was: the gold set is labelled at ISCO-unit
granularity, so a family bound below unit level is unrepresentable and scores wrong by
construction; the floor was untouched; three tests pinned the rule; `"darzi"` under 7223 was the
negative control. All true. It also compared **new metric on the branch** against **old metric on
main** — two variables at once — and no amount of internal consistency fixes that. A change that
edits the measurement cannot be validated from inside itself.

Run properly: a detached worktree at `origin/main` (`f33736c5`), with **only** the two metric files
copied in and `node_modules` junctioned from the main checkout (`packages/profiling-lexicon` is
byte-identical across the branch, so nothing else could differ).

| run         | data   | metric  | precision | correct / wrong | refined | failures |
| ----------- | ------ | ------- | --------- | --------------- | ------- | -------- |
| baseline    | main   | main    | 98.2%     | 388 / 7         | —       | 12 rows  |
| **control** | main   | **new** | **98.2%** | **388 / 7**     | **0**   | 12 rows  |
| branch      | branch | new     | 98.2%     | 378 + 10 / 7    | 10      | 12 rows  |

All three failure lists are **byte-identical** — `diff` clean, twelve rows each. The decisive
number is the control's `refined = 0`: `main` has no sub-unit family bindings, so the new branch of
code executes **zero times** there. The change is not merely score-neutral on main, it is
structurally inert, and the branch sits at genuine parity carrying main's same seven real failures.

Recorded as a HALT trigger in `AGENT_LOOP.md` §4 so the next one gets a control before the argument
gets made, not after.

### 11.2 — The floor, measured across renderers and fonts

"28/28 on one page" is a binary and it hid a knife edge: the worst sheet fit at exactly 297.00 mm
and spilled at 296.75. `scripts/measure-sheet-headroom.py` replaces it with a millimetre floor.

**The floor is measured, not chosen.** Rendering the matrix across three WeasyPrint versions and
two font-fallback tiers:

| configuration                            | max spread vs shipped | effect                   |
| ---------------------------------------- | --------------------- | ------------------------ |
| WeasyPrint 63.1 / 66.0 / 69.0            | **0.00 mm**           | version is not the risk  |
| `fonts-noto-core` absent → DejaVu Sans   | **3.64 mm**           | both directions          |
| both font packages absent → DejaVu Serif | 15.18 mm              | five sheets to two pages |

**5 mm** sits above the realistic tier and is within a rounding error of one 4.89 mm text line —
the smallest unit this page can shed. The third row is reported rather than floored against: the
API image installs both packages, so that is a broken image, not a fallback. But the declared stack
is `"Noto Sans", "DejaVu Sans", Arial, sans-serif` and in the shipped image `Arial` does not exist
while generic `sans-serif` resolves to a **serif** — the last link of the chain is a latent trap.

### 11.3 — R2: what comes off the sheet, and in what order

Built as its own item, ahead of both features that need it. Handing the §5.1 drop order to whoever
happens to land first would design it under an unrelated feature's schedule pressure, and the loser
of the race would inherit a contract it did not write.

**The model.** The mapper is pure and WeasyPrint is out of process, so "does this fit" is answered
by counting rendered lines against a budget, calibrated from real renders:

- `LINE_MM = 4.89` — the atomic unit, straight off WeasyPrint's box tree. Every `.emp-when`,
  `.lab`, `.ticks` and `.chips` line lays out at exactly this, and each extra wrapped line in a
  `.row` adds exactly this (10.58 → 15.47 → 20.36 across a widening row).
- `CHARS_PER_LINE = 88` — measured by widening one row until it broke: 90 chars stayed on one line,
  107 went to two, 223 to three, 307 to four. Pinned below the observed ~91 on purpose:
  over-estimating costs a row, under-estimating costs a second page.
- `SHEET_LINE_BUDGET = 41` — fitted. Solving `headroom = C − 4.89 × lines` per shape clusters `C`
  at **209–216 mm**; taking the worst and requiring the floor gives `(209.0 − 5) / 4.89 = 41.7`,
  rounded **down** because the residual spread is ~7 mm and a budget fitted to the average puts the
  tightest shapes under the floor.

**The masthead term is why the first model was wrong.** Counting only content sections predicted the
long-name sheet as roomier than one that measured 9.87 mm, while it measured 0.00. The whole
difference is a name past the one-line limit auto-fitting to 18 pt (§11 #9) and then wrapping — an
18 pt line is 8.53 mm against the body's 4.89. Before that term, `C` ranged 156–232 and the model
was fitting noise.

**The ladder** is reverse §5.1 with the turner-pack additions slotted per the R1 §3 default:
optional volunteered fields → production mode → sector tag → materials beyond two → languages →
documents → certificates → education → employers beyond three/two/one → capability rows by
descending rank. **Two steps are unreachable today and that is stated rather than hidden:**
`surface_finish_ra`, `fit_class_held`, `bar_diameter_range_mm` and `production_mode` exist in
neither the pack nor the map, so steps 1 and 2 match nothing. They are built in their correct
positions anyway — when those fields land they must drop FIRST, and a ladder that acquired them
later would acquire them at the end.

**Never droppable**, stated positively rather than as an absence, and asserted: the Verdict Line
(§5.1 rank 1), the name, availability and expected salary (rank 6 — two of the four things that
actually reject a candidate), the verification badge, and the QR footer. Nothing shrinks type or
truncates; the ladder only removes whole elements.

**A real gap the tests caught:** the ladder had a hard-coded 12 rank-drop steps and the turner map
has 14 rows, so a maxed-out worker would have run out of ladder two rows before running out of
sheet — returning a still-overflowing page while reporting a stage as though it had succeeded. The
count is now derived from the widest map.

### 11.4 — Acceptance: verified against the content that is coming

A ladder tuned to seeded fixtures passes its own tests and breaks on real data — which is exactly
what the `qrDataUri: null` fixture already demonstrated. So the acceptance run injects **realistic**
Zone 4 and Zone 5 content at the length real records have: registered company names with their
suffixes and plant qualifiers ("Sandhar Technologies Limited, Plant II", "Endurance Technologies
Private Limited"), full NCVT/NSQF certificate strings with issuer and year, three languages and
seven documents. 56 sheets: 28 as they render today, 28 as they will render once work-history
capture and Phase C land.

**Where every shape lands.** Headroom and applied stage, both audiences, both variants:

| #   | shape                                                            | today (worker / payer)          | with Zone 4+5 (worker / payer)  |
| --- | ---------------------------------------------------------------- | ------------------------------- | ------------------------------- |
| 1   | ITI fresher, zero employment rows                                | 133.14 mm st.0 / 138.79 mm st.0 | 44.80 mm st.0 / 50.45 mm st.0   |
| 2   | Twelve years on the machine, no ITI                              | 105.79 mm st.0 / 111.43 mm st.0 | 36.52 mm st.0 / 42.29 mm st.0   |
| 3   | Duration unknown throughout                                      | 139.92 mm st.0 / 145.57 mm st.0 | 50.57 mm st.0 / 56.34 mm st.0   |
| 4   | Contract / thekedar work, no company name                        | 125.49 mm st.0 / 131.26 mm st.0 | 50.57 mm st.0 / 56.34 mm st.0   |
| 5   | OVERFLOW — employment gaps beside a fully-answered pack          | 26.48 mm st.2 / 21.33 mm st.1   | 17.44 mm st.3 / 23.22 mm st.3   |
| 6   | OVERFLOW — nine employers in four years                          | 20.33 mm st.2 / 25.98 mm st.2   | 17.44 mm st.3 / 23.22 mm st.3   |
| 7   | Promoted inside one employer                                     | 102.02 mm st.0 / 107.67 mm st.0 | 42.42 mm st.0 / 48.06 mm st.0   |
| 8   | OVERFLOW — every pack row answered, every chip at its cap        | 32.00 mm st.0 / 37.77 mm st.0   | 17.44 mm st.3 / 23.22 mm st.3   |
| 9   | OVERFLOW — very long name, long employers, five preferred cities | 16.56 mm st.2 / 11.42 mm st.1   | 25.47 mm st.4 / 16.82 mm st.3   |
| 10  | Single name, no surname                                          | 123.35 mm st.0 / 129.00 mm st.0 | 48.31 mm st.0 / 53.96 mm st.0   |
| 11  | OVERFLOW — overseas history plus a full credentials block        | 20.96 mm st.0 / 26.73 mm st.0   | 17.44 mm st.3 / 23.22 mm st.3   |
| 12  | Two trades, the stronger by months leading                       | 137.54 mm st.0 / 143.31 mm st.0 | 48.31 mm st.0 / 53.96 mm st.0   |
| 13  | Off-pack trade — no capability map exists                        | 162.51 mm st.0 / 168.15 mm st.0 | 73.16 mm st.0 / 78.93 mm st.0   |
| 14  | Name only — everything else absent                               | 231.53 mm st.0 / 231.53 mm st.0 | 231.53 mm st.0 / 231.53 mm st.0 |

Stage 0 is nine of the fourteen shapes today. The five that degrade are exactly the five built to
overflow. With the queued content injected, eight shapes degrade and the deepest is
`future-09-worker` at stage 4 — the very long name, a full employment history and a full
credentials block on one sheet.

**56 sheets / 56 one-page / 0 over / worst headroom 11.42 mm** against the 5 mm floor.

### 11.5 — §4: three findings, reported not fixed

**The path filter covers everything it needs to.** Eight paths gate the `e2e` job: `apps/api/**`,
`packages/**`, `tests/**`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`,
`apps/ai-service/**`, `.github/workflows/ci.yml`. `packages/match-engine`, `packages/db` and
`packages/taxonomy` all exist and are **all covered** by the `packages/**` glob — matching cannot
break from a package change with the DB gate silently not running. The glob is doing real work
here; naming the three packages explicitly would be no stronger, but a future narrowing of
`packages/**` to specific packages would be exactly the silent-skip trap, and there is nothing
asserting against it.

**The fabrication gate proves provenance, not placement — and that limit is now written down.**
The `detect-non-literal-regexp` defect would have spliced one worker's list into a different
section of the sheet. Every string involved is legitimate: a closed-vocabulary label or a verbatim
worker phrase. All 32 gate tests pass while the sheet is wrong. The gate answers "did every printed
string come from a permitted source" and says nothing about whether it is printed under the right
heading, next to the right label, or on the right worker's sheet. Reading it as a guarantee of
correctness rather than of sourcing is the mistake it invites, and it is the mistake its own name
encourages.

**The SAST baseline hides almost nothing — one finding, tree-wide.** Scanned the full tracked
tree with CI's four rulesets and no baseline: **2787 files, 1108 rules, 1 finding.** It is the same
rule that surfaced by accident — `detect-non-literal-regexp` — at
`packages/db/src/audit-deployed-flags.ts:169`, one more regex composed from a loop variable
(`new RegExp(\`${f.name}: ...\`)`). Reported, not fixed: it is in `packages/db` and §4 asked for a
report.

So the answer to "discovery by accident is not a control" is reassuring rather than alarming:
there is no backlog behind the baseline, and the accident found the only class of finding present.

**With one qualification that matters, because it is the A7 class again.** Seven files did not
fully parse: one outright syntax error (`bb-trade-template.test.ts` — semgrep read _none_ of it),
five partial-parse failures (including `jobs.repository.ts` on a drizzle `sql<...>` generic and
`sheet-shape-matrix.test.ts` on a regex literal), and one rule timeout on
`packages/event-schema/src/payloads.ts`. Those files contribute zero findings because they were
not read, not because they are clean — and semgrep reports that in `errors`, not in the finding
count. **The honest statement is "1 finding among what parsed", and a file semgrep cannot parse is
a file the SAST gate does not cover.** Nothing surfaces this today; the exit code is driven by
findings alone.

**Second instance of a file's own comment forbidding what its code did.** After `EMOJI_RE` (whose
comment warned that a reflow would move the lint directive off the regex, which is exactly what
happened), the render processor's employments block carried "a failure here must cost the work
history and nothing else" one level below a `try` that took down the phone, the QR, the ref code
and the footer. Both were found by acting on the comment rather than reading past it. A comment
that states an invariant is a test that has not been written yet.

---

## §12 — R2 packet digest

**Two PRs, stacked.** [#1292](https://github.com/RVM-BEYOND-PRIVATE-LIMITED/badabhai-platform/pull/1292)
`feat/cnc-turner-role-track` carries R1 plus the §2 corrections and is **green on every CI job**.
[#1294](https://github.com/RVM-BEYOND-PRIVATE-LIMITED/badabhai-platform/pull/1294)
`feat/resume-degradation-stage` is stacked on it and carries R2.

**#1294 gets no CI, and that is not a green check.** `ci.yml` triggers on
`pull_request: branches: [main]`, so a PR based on another branch never fires it — confirmed
empirically: the only check on #1294 is `Supabase Preview / skipping`. An empty check list means
"nothing ran". Its gates were run locally and are recorded above.

### The control (§1)

The metric change is **provably neutral**. New metric on `origin/main`: 98.2%, 388 correct, 7
wrong, `refined = 0`, and a byte-identical twelve-row failure list against both the old-metric
baseline and the branch. The new code path executes **zero times** on main — not merely
score-neutral there, structurally inert. The branch carries main's same seven real failures and
nothing new.

### The floor (§2.1)

Binary fit replaced with a measured 5 mm headroom floor. Renderer version contributes **0.00 mm**
of variance across WeasyPrint 63.1/66.0/69.0; font fallback contributes up to **3.64 mm**, in both
directions. Reported but not floored against: losing both font packages resolves the stack's
generic terminal to a **serif** and takes five sheets to two pages — a broken image rather than a
fallback, but a latent trap in the declared stack.

### The ladder (§3)

|                                        | before             | after        |
| -------------------------------------- | ------------------ | ------------ |
| worst headroom, current sheets         | **0.00 mm**        | **11.42 mm** |
| worst headroom, with Zone 4+5 injected | _3 would overflow_ | **17.44 mm** |
| one-page                               | 28 / 28            | **56 / 56**  |

Deterministic, minimal, ordered by reverse §5.1 with the turner-pack additions first. Six things
are never droppable and that list is asserted positively. Two ladder steps are unreachable today
because their fields do not exist yet, built in their correct positions and recorded as such.

**The tests caught a real gap:** a hard-coded 12 rank-drop steps against a 14-row map, which would
have returned a still-overflowing page while reporting a stage as though it had succeeded.

### The three read-only findings (§4)

- **Path filter: covered.** Eight paths gate the `e2e` job, and `packages/match-engine`,
  `packages/db` and `packages/taxonomy` are all inside `packages/**`. Matching cannot break from a
  package change with the DB gate silently skipped.
- **SAST baseline: one finding, tree-wide.** 2787 files, 1108 rules, no baseline → **1** result,
  and it is the same `detect-non-literal-regexp` rule at
  `packages/db/src/audit-deployed-flags.ts:169`. No backlog hides behind the baseline. **But
  seven files did not fully parse** — one total syntax error, five partial, one rule timeout — and
  they contribute zero findings because they were not read. A file semgrep cannot parse is a file
  the gate does not cover, and nothing surfaces that today.
- **The fabrication gate proves provenance, not placement.** The regex defect would have spliced
  one worker's list into another section with all 32 gate tests green, because every string
  involved was legitimately sourced. Recorded so nobody reads it as a correctness guarantee.

### Two corrections to my own reporting

- I wrote that **three** sheets fail the new floor and named shape 5's employer copy. Measured, it
  sits at 15.56 mm and passes; it is **two** — `shape-09-worker` (0.00 mm) and `shape-06-worker`
  (3.76 mm). Corrected in #1292 with the correction left visible.
- The harness was checked against its own negative control: over the pre-degradation sheets it
  exits **1** and names exactly those two. Its green result is therefore worth something — and
  note that those sheets are all still **28/28 one-page**, which is precisely how the binary
  assertion hid a 0.00 mm margin.

### What I could not do, and said so

- **Q7 needs a photocopier.** The 0.5 mm module floor is from the printing literature, not from
  the guideline, and validating it is a physical act — print, xerox, scan with a mid-range Android.
  I have none of those. The protocol is written out; it needs five minutes of someone's hands.
  It is also **coupled to B3**: the interim `sslip.io` origin is 45 characters against
  `badabhai.ai`'s 19, taking the same payload from 0.720 mm to 0.545 mm per module.
- **`AGENT_LOOP.md` did not exist** — not at the root, not under `docs/` or `.claude/`, never in
  any commit. Created carrying only the §4 HALT trigger, labelled as a creation rather than an
  amendment, sections 1–3 deliberately absent rather than invented (Q9).

### The question queue

Nine open, none of which blocked this work. Two are new and one was mis-filed:

- **Q8 · Conflict B** — one spine versus a template per trade family. Raised as its own question
  after I mapped the stale cost line onto the drop order by mistake. Its reversal cost has risen
  because the work went well: 56 fixtures, a render block, three gates and a ladder now assume one
  spine. That is the worst shape an open question can have.
- **Q2 gains a sharper edge** — reverse §5.1 sheds a worker's entire credentials block before one
  capability row. Right for an experienced turner, much less obviously right for a young worker
  whose NCVT certificate is the signal.
- **Q6, Q7, Q9** as above.

---

## §13 — R3: closing out the render track

### 13.1 — Where every shape lands, and whether the ladder is too coarse

Owed from R2 and reported here as a table rather than a summary. Headroom in mm above the 5 mm
floor, and the degradation stage that produced it, for all 14 shapes × 2 audiences × 2 content
variants:

| #   | shape                                            | today W       | today E       | +Zone 4/5 W   | +Zone 4/5 E   |
| --- | ------------------------------------------------ | ------------- | ------------- | ------------- | ------------- |
| 1   | ITI fresher, zero employment rows                | 133.14 st0    | 138.79 st0    | 44.80 st0     | 50.45 st0     |
| 2   | Twelve years on the machine, no ITI              | 105.79 st0    | 111.43 st0    | 36.52 st0     | 42.29 st0     |
| 3   | Duration unknown throughout                      | 139.92 st0    | 145.57 st0    | 50.57 st0     | 56.34 st0     |
| 4   | Contract / thekedar work, no company name        | 125.49 st0    | 131.26 st0    | 50.57 st0     | 56.34 st0     |
| 5   | OVERFLOW — employment gaps, pack fully answered  | 26.48 **st2** | 21.33 **st1** | 17.44 **st3** | 23.22 **st3** |
| 6   | OVERFLOW — nine employers in four years          | 20.33 **st2** | 25.98 **st2** | 17.44 **st3** | 23.22 **st3** |
| 7   | Promoted inside one employer                     | 102.02 st0    | 107.67 st0    | 42.42 st0     | 48.06 st0     |
| 8   | OVERFLOW — every pack row answered, chips at cap | 32.00 st0     | 37.77 st0     | 17.44 **st3** | 23.22 **st3** |
| 9   | OVERFLOW — very long name, five preferred cities | 16.56 **st2** | 11.42 **st1** | 25.47 **st4** | 16.82 **st3** |
| 10  | Single name, no surname                          | 123.35 st0    | 129.00 st0    | 48.31 st0     | 53.96 st0     |
| 11  | OVERFLOW — overseas history + full credentials   | 20.96 st0     | 26.73 st0     | 17.44 **st3** | 23.22 **st3** |
| 12  | Two trades, the stronger by months leading       | 137.54 st0    | 143.31 st0    | 48.31 st0     | 53.96 st0     |
| 13  | Off-pack trade — no capability map exists        | 162.51 st0    | 168.15 st0    | 73.16 st0     | 78.93 st0     |
| 14  | Name only — everything else absent               | 231.53 st0    | 231.53 st0    | 231.53 st0    | 231.53 st0    |

**16 of 56 sheets degrade; 40 land at stage 0.** The tightest sheet in the whole matrix is
`shape-09-employer` at 11.42 mm, and it got there by dropping exactly one thing.

**Is the ladder too coarse?** The question was raised by the injected matrix reporting a worst of
17.44 mm against the uninjected 11.42 — more content, more headroom, which reads like a step
overshooting. `degradeToFit` now returns a per-step trace of `over` (lines the sheet needed) and
`gain` (lines the step took), so this is measurable rather than arguable.

Worst overshoot across all 56 sheets: **2.93 lines** — `future-09-worker` dropping `education`
(3.86 lines) to close a 0.93-line gap. Every other applied step overshoots by under 2 lines, and
many undershoot. Post-degradation sheets land at **38.07–40.93 lines against a budget of 41**.

So the overshoot is real but small, and it is not what produces the 17.44-vs-11.42 inversion.
Two other things do:

- **The budget is deliberately conservative.** 41 was rounded down from a fitted 41.7 because the
  per-shape constant `C` spreads across 209–216 mm. A sheet sitting at exactly 41 lines therefore
  has anywhere from 8.5 to 15.5 mm of headroom depending on which shape it is. That spread is
  larger than the entire overshoot.
- **The injected sheets degrade three steps instead of one**, so they land nearer 38 lines than 41. More content ends up with more headroom because it triggered more of the ladder.

**The finding is not coarseness. It is what the ladder never reaches.** Across the 16 degrading
sheets:

| shed                   | on how many sheets |
| ---------------------- | ------------------ |
| languages              | 16                 |
| documents ready        | 14                 |
| certificates           | 10                 |
| education              | 1                  |
| **any capability row** | **0**              |

The ladder consumed the credentials block **entirely** — languages, documents, certificates,
education — and never once reached a capability row. `future-09-worker` prints no education line
while carrying every capability row it started with. That is the Q2 defect, and it is now
measured rather than inferred from the ordering. See §13.8.

### 13.2 — What the control did NOT prove

`refined = 0` on `origin/main` proves the new occupation metric is structurally inert on a corpus
with no sub-unit family bindings: the new branch of code executes zero times there, so it cannot
change any such corpus. That is a stronger claim than matching scores.

**It is also a claim about one direction only.** A code path that never executed cannot have been
tested by the run that never executed it. The control says nothing about whether the refinement
logic is _correct_ when it does fire — and on the branch it fires ten times.

Correctness of those ten still rests on two weaker things: reading them (all ten are a sub-unit
family correctly bound under its ISCO unit, e.g. a turner family under 7223) and three unit tests
pinning the rule, with `"darzi"` under 7223 as the negative control. That is reasonable evidence.
It is not what the control proved, and stating it as though it were would be the same conflation
the control existed to prevent. Same treatment as the fabrication gate's provenance-not-placement
bound in §11.5.

### 13.3 — The QR's two uncertainties compound

Recorded against Q7 rather than repeated here. The short version: the measured 0.545 mm module on
a 45-character `sslip.io` host sits **9% above** a 0.5 mm floor that is itself an unratified
engineering guess awaiting the photocopier test. Two unresolved variables stacked on the one
element §12.2 rests the acquisition thesis on, and the recommendation is now explicit — **run the
xerox protocol at the `sslip.io` payload length, not the short one**, because that is the length
the sheet in the field will carry until B3 is decided.

### 13.4 — Font resolution now fails closed

**This was the second silent font failure in this pipeline.** The first was the worker's
Devanagari name line rendering as empty boxes with nothing failing — which is why
`fonts-noto-core` is in the API image at all. The second was found in R2: with the sans faces
gone, `sans-serif` at the end of the stack resolves to DejaVu **Serif**, and five of the 28
shapes spill to a second page. Same class twice, and both times WeasyPrint exited 0.

**What is actually observable.** Not the exit code, not the byte count, not the page count — the
set of faces the PDF embeds. WeasyPrint writes `/BaseFont /XXXXXX+Noto-Sans` per face, inside
Flate object streams. `embeddedFontFaces` scans the raw buffer and inflates every stream in it,
so it reads compressed output and needs no `--uncompressed-pdf`: the probe takes the **same
argv** as the render it is vouching for, which is asserted by a test.

Measured on the shipped image, with the font files removed one tier at a time:

| container                           | faces embedded                                        | what the worker gets            |
| ----------------------------------- | ----------------------------------------------------- | ------------------------------- |
| shipped                             | `Noto-Sans`, `Noto-Sans-Bold`, `Noto-Sans-Devanagari` | the locked design               |
| minus `fonts-noto-core`             | `DejaVu-Sans`, `DejaVu-Sans-Bold`                     | his name in .notdef boxes       |
| minus the DejaVu **sans** faces too | `DejaVu-Serif`, `DejaVu-Serif-Bold`                   | a serif sheet, 5 shapes 2 pages |

All three PDFs are checked in as fixtures under `apps/api/src/resume/__fixtures__/font-probe/`,
with the probe HTML beside them and a test asserting the HTML is byte-identical to the shipped
constant — edit the probe without re-rendering and the fixtures become bytes from a document that
no longer exists, still passing.

**It refuses rather than degrades.** Everything else in `PdfRenderer` returns null on failure; a
font violation throws. A missing PDF is a visible incident — the row is marked failed, the
download 409s, and the processor now logs it at **error** level as an image defect rather than a
per-résumé fault. A wrong PDF is invisible: it renders, uploads, downloads and gets forwarded on
WhatsApp. Success is memoised for the process; **failures are not**, because "could not measure"
(binary missing, timeout) must never harden into a verdict about fonts.

**Removing both font packages entirely is not a fourth tier** — Pango segfaults, exit 139. Loud,
and needs no guard.

**Mutation-tested, five ways, each in isolation** (26 tests at baseline):

| mutation                                      | tests failed |
| --------------------------------------------- | ------------ |
| allowlist disabled (`unexpected` always `[]`) | 4            |
| inflate path removed                          | 10           |
| guard stops throwing on a violation           | 2            |
| unmeasurable probe treated as a pass          | 1            |
| Devanagari dropped from the contract          | 2            |

**A real bug the run surfaced in the test file itself.** `beforeEach(() => spawnMock.mockReset())`
returns the mock — `mockReset` returns it for chaining, and an arrow with an expression body
passes it on — and vitest treats a value returned from `beforeEach` as a **teardown function**, so
it called the spawn mock a second time after the test, producing a child nobody was listening to
and an unhandled `ENOENT`. The suite still reported all tests passing. Fixed with a block body and
the reason written above it.

### 13.5 — §4: the SAST parse gap, named and measured

R2 reported "seven files did not fully parse". Re-run on this branch with `--json` and counted
from the `errors` array: **10 distinct files, 19 error records** — 1 whole-file syntax error, 3
rule timeouts across 2 files, 15 partial parses across 7 files. The earlier seven was an
undercount and is corrected here.

| file                                                      | kind              | scope                                   | sensitive surface? |
| --------------------------------------------------------- | ----------------- | --------------------------------------- | ------------------ |
| `apps/api/src/resume/templates/bb-trade-template.test.ts` | **Syntax error**  | **the entire 196-line file, unscanned** | no — a test        |
| `packages/event-schema/src/payloads.ts`                   | Timeout ×2        | 2 rules skipped, rest ran               | no                 |
| `packages/event-schema/src/event-schema.test.ts`          | Timeout           | 1 rule skipped, rest ran                | no — a test        |
| `.github/workflows/ci.yml`                                | PartialParsing ×8 | bash snippets at L477/509/613/644       | CI, see below      |
| `.github/workflows/cleanup-issues-prs.yml`                | PartialParsing ×2 | bash snippet at L396–397                | CI                 |
| `apps/admin-web/src/app/layout.tsx`                       | PartialParsing    | L21 — a Google Fonts URL                | no                 |
| `apps/api/src/jobs/jobs.repository.ts`                    | PartialParsing    | L172 — `sql<string[] \| null>` generic  | a DB repository    |
| `apps/api/src/resume/sheet-shape-matrix.test.ts`          | PartialParsing    | L58                                     | no — a test        |
| `apps/payer-web/Dockerfile`                               | PartialParsing    | L104–105                                | no                 |
| `scripts/deploy/staging-deploy.sh`                        | PartialParsing    | L537                                    | a deploy script    |

**None sits in auth, guards, crypto, unlocks, payments or the pseudonymisation boundary.** Two
are adjacent enough to name: `jobs.repository.ts` is where SQL-injection rules would look, and
`staging-deploy.sh` is where secret-handling rules would. In both the gap is one line, not the
file.

**The distinction the table is drawing matters more than the count.** Fifteen of the nineteen are
partial parses of a _snippet inside a rule_ — semgrep parsed `ci.yml` as YAML fine and only failed
to parse an embedded bash fragment for two GHA rules (`curl-eval`, `gha-curl-pipe-shell`). That
is one rule missing one line. The whole-file syntax error is a different thing entirely: semgrep
never read `bb-trade-template.test.ts` at all, so it could contain anything.

**And the cause generalises.** It is the regex idiom `[^]` — an empty negated character class,
valid JavaScript meaning "any character including newline" — which semgrep's TypeScript grammar
mis-parses. `sheet-shape-matrix.test.ts:58` fails on the same construct. **Any file that adopts
`[^]` drops out of SAST coverage**, and nothing anywhere says so. Today they are all test files.
Nothing keeps it that way.

**Can the step be made to fail on parse errors? Yes — `--strict`.** Documented as "return a
nonzero exit code when WARN level errors are encountered". Measured in the pinned semgrep
container across the four cases that matter, plus two controls:

| scenario                                           | `--strict` | exit  |
| -------------------------------------------------- | ---------- | ----- |
| whole tree, existing parse errors                  | no         | **0** |
| whole tree, existing parse errors                  | **yes**    | **3** |
| a clean file                                       | yes        | 0     |
| diff gate, parse error **already on the baseline** | yes        | **0** |
| diff gate, PR **introduces** the unparseable file  | no         | **0** |
| diff gate, PR **introduces** the unparseable file  | **yes**    | **3** |

That composes correctly with the existing `--baseline-commit` design: it fails only PRs that
introduce a file the scanner cannot read, and does not punish a PR for a pre-existing one. The
weekly whole-tree run would go red on the ten above until they are fixed or ignored.

**Not applied here, on purpose.** It is a `.github/` change, the last `ci.yml` edit produced
churn, and turning the weekly job red is a decision rather than a commit. Written up so it is a
ruling away, not a rediscovery away.

### 13.6 — §5.1: what #1294 would need to get CI, and what it costs

`ci.yml` triggers on `pull_request: branches: [main]`, and that filter matches the PR's **base**.
So a PR targeting a feature branch fires nothing — confirmed on #1294, whose only check is
`Supabase Preview / skipping`. Every R2 and R3 gate is therefore local-only, and local-versus-CI
is exactly the gap that produced both the SAST finding and the eval finding on #1292.

Two ways out, neither taken here:

**A · Retarget #1294 at `main` once #1292 merges.** No workflow change; the gate that runs is the
real one; #1294's diff collapses to just R2+R3 because #1292's commits are then on `main`. Costs a
sequencing dependency — R2 and R3 stay ungated until #1292 lands — and a retarget needs a
close/reopen to actually fire CI, which is a known trap in this repo.

**B · Add the feature branch (or all branches) to `ci.yml`'s `pull_request.branches`.** Gets CI
immediately, but it is a repo-wide trigger change: every PR to any base fires the full pipeline,
`ci.yml` is the file with the ~20.5 KB per-step-input compile cliff, and the SAST baseline
(`github.event.pull_request.base.sha`) would become the feature branch, which changes what
"introduced" means for every stacked PR.

**Recommendation: A.** B buys a few days of coverage at the price of a permanent change to how
every PR in the repo is gated, and it changes the meaning of the one gate that already found real
problems. **No third stack layer was opened**, per §8.

### 13.7 — §5.2: which loop state files actually exist

Two of the four named are phantom. Measured against `git ls-files`, `origin/main`, and
`git log --all --diff-filter=A`:

| file               | on disk    | on `origin/main` | ever added, any branch |
| ------------------ | ---------- | ---------------- | ---------------------- |
| `NEEDS_PRAKASH.md` | yes        | **no**           | once — on this stack   |
| `ASSUMPTIONS.md`   | yes        | **no**           | once — on this stack   |
| `AGENT_LOOP.md`    | yes (stub) | **no**           | once — on this stack   |
| `LOOP_QUEUE.md`    | **no**     | no               | **never**              |
| `LOOP_JOURNAL.md`  | **no**     | no               | **never**              |

`LOOP_QUEUE.md` and `LOOP_JOURNAL.md` have never existed in this repository. Not created.

**The sharper half:** the other three are not on `main` either. The whole question queue, every
assumption, and the HALT trigger live on an unmerged stack. `AGENT_LOOP.md` stays exactly as it
is — Prakash has the canonical version outside the repo and will commit it, so reconstructing
§1–3 would create the second competing copy the entry warns about.

### 13.8 — §6: the drop order's default is revised, and now measured

Reverse §5.1 is the wrong ordering to derive a drop order from. §5.1 ranks by decisiveness for the
₹40 unlock — Job 1 — so dropping strictly by it optimises Job 1 and destroys Job 3, surviving the
gate, where documents-ready is the entire point. §13.1 shows it is not hypothetical: 16 sheets
degraded, the credentials block absorbed all of it, and no capability row was ever touched.

**Revised default, in force, awaiting ruling and RVM's redline:** capability blocks compress
before whole blocks drop — exhaust compression inside Zone 2 before dropping any Zone 5 block,
extending §4.3's existing per-row caps. Recorded in full at `NEEDS_PRAKASH.md` Q2 with its
reversal cost, which splits: re-ordering the ladder is mechanical, but **compression is a
mechanism that does not exist** — every step today removes a whole element, and a compressing step
needs a per-row cap, an intra-row ordering, and a rule for what the removed chips do to the row's
meaning. Logged as proposed, not built, per §8.

---

## §14 — R3 packet digest, and the render track stops here

**One build item, four reports, no new render work opened.** Everything below lands on
[#1294](https://github.com/RVM-BEYOND-PRIVATE-LIMITED/badabhai-platform/pull/1294)
(`feat/resume-degradation-stage`), stacked on
[#1292](https://github.com/RVM-BEYOND-PRIVATE-LIMITED/badabhai-platform/pull/1292), which is
green on every CI job at `73b9e162`. **#1294 still gets no CI and that is still not a green
check** — see §13.6 for what it would take and what each option costs.

### The build item: font resolution fails closed (§3)

The second silent font failure in this pipeline, closed by measuring what the renderer _did_
rather than trusting that it ran. `PdfRenderer.assertFontsResolve` renders a fixed probe through
the same `weasyprint` invocation as the real render, reads the faces the PDF embeds out of its
Flate streams, and **throws** unless they match the sheet's contract. A missing PDF is a visible
incident; a serif sheet in a worker's WhatsApp forward is not.

Three real containers, three checked-in fixtures, five isolated mutations all killed, and a
teardown-hook bug in the new test file found and fixed along the way (§13.4).

### The three answers owed (§2)

- **Per-shape landing, all 56 sheets** (§13.1). 16 degrade, 40 sit at stage 0. Worst overshoot
  **2.93 lines** — the ladder is fine-grained. The real finding is what it never reaches:
  **languages 16, documents 14, certificates 10, education 1, capability rows 0.**
- **The control's bound** (§13.2). `refined = 0` proves the metric cannot change a corpus without
  sub-unit bindings. It could not have caught a bug _inside_ the refinement path, which never
  ran. The ten refinements rest on a read and three pinning tests — different evidence, stated as
  such.
- **The QR compounds** (§13.3). 0.545 mm is 9% above a 0.5 mm floor that is itself a guess. Run
  the xerox at the `sslip.io` length.

### The two read-only reports (§4, §5)

- **SAST**: **10 files, 19 error records** — the R2 "seven" was an undercount and is corrected.
  None in auth, guards, crypto, unlocks, payments or pseudonymisation. One file is unscanned
  entirely, and the cause — the `[^]` regex idiom — generalises to any file that adopts it.
  `--strict` fixes it and the six-case exit-code matrix is measured, including that it does _not_
  punish a PR for a pre-existing parse error. Not applied: `.github/` needs a ruling.
- **Loop state files**: `LOOP_QUEUE.md` and `LOOP_JOURNAL.md` **have never existed** here. The
  other three exist only on this unmerged stack — the entire question queue is one abandoned
  branch away from gone.

### Where this leaves the product, stated plainly

The render half is well built. It is not the critical path, and none of these has moved:

- **Work-history capture has not moved.** `worker_employment` still has no writer —
  `worker-employment.repository.ts` reads and never inserts. Every worker's Zone 4 still prints
  the interim fallback, with no employer and no dates (Q1).
- **Phase C extraction has not moved.** No `employments` in the extraction prompt, no
  `EmploymentEntry` in `ai-contracts`. Nothing extracts a work history from a transcript.
- **B0b has not moved.** `turner-reach.db.test.ts` is still `it.fails`, still gated behind
  `RUN_DB_TESTS=1`, which CI does not set. A fully-answered turner still derives zero
  `worker_skill` rows and appears in no posting's reach (Q4).
- **A real interviewed turner is still not reachable.** Every sheet measured on this track — all
  56 — is a fixture. No worker has walked the pack end to end and held the paper.

### Nine open questions, and the track stops

The queue on the render track is now dry: Q1, Q4 and Q8 are the ones with cost, and all three
want a decision rather than more code. **Q8 is the alarm** — 56 fixtures, a render block, three
gates and a degradation ladder now assume one spine, and its reversal cost rises with every
commit. Continuing to build is how nine questions becomes fifteen.

No further render item is opened.

---

## §15 — R4 rulings: the question queue is closed

All nine ruled. `NEEDS_PRAKASH.md` carries each one inline with its consequence; the two that
change the code or its description are here.

**Q8 · ONE SPINE IS RATIFIED.** Not deferred — confirmed. §7.1 already forbids skins from varying
field order, section order, column count or page count, which is most of what a per-family
template would have existed to change, so this ratifies what the guideline implies rather than
adding a constraint.

What changes is how four files get described. The render block, the fabrication gate, the QR gate
and the degradation ladder were all built on one spine. That is no longer "load-bearing on an
open question" — it is four files implementing a ratified design, and varying the spine per trade
family now needs a ruling to undo this one. `ASSUMPTIONS.md` should not be read as covering it any
more.

**Q2 · One rider, built.** The highest ITI/NCVT qualification line is never dropped, the way
availability and expected salary are never dropped. `NEVER_DROPPED` gains `top_qualification`.

- **What counts as a credential** is a closed five-token vocabulary — ITI, NCVT, SCVT, NTC, NSQF —
  matched as whole words. A worker whose education line reads "10th pass" has no credential to
  protect, so nothing is reserved and the rider costs his sheet nothing. Protecting any education
  text would be a larger promise than the one that was ruled.
- **Education is searched before Certificates**, and that is not arbitrary: the Education row's
  leading segment is `humanizeEducationLevel(education_level)`, one field holding the worker's
  highest stated qualification. So "the first credential segment in Education" already means "his
  highest" without anyone inventing a seniority ordering across ITI, NCVT and NSQF — which would
  be a derived claim about his credentials rather than a restatement of one (§8).
- **Restoration runs after every ladder step**, not only after the two that drop credential rows,
  so a step added later cannot quietly take it.

**It cost 0.25 mm on the tightest sheet**, not the ~5 mm estimated: 56/56 still one-page, worst
headroom **11.17 mm** against 11.42 before. The estimate was for sheets that actually shed
credentials, and the tightest sheet degrades at stage 1 without reaching them.

**A stale predicate the rider exposed.** A ladder step counted as a stage when
`sheetContentLines` FELL — the line count standing in for "did anything change". Reserving a
credential line costs one line and returns one, so dropping an Education row now leaves the count
unchanged while the row loses its issuer and year: a real content change that would have been
recorded as no stage at all, and a provenance stamp that understated what the sheet had lost. The
predicate now compares the sheet itself.

**Deferred by name**, so nobody rediscovers them as findings: drop-order ratification, capability
compression, semgrep `--strict`, the `ci.yml` trigger, the payer QR, salary bands.

---

## §16 — R5: finishing CNC-turner profiling

### 16.1 — Inventory (§1.1)

| #   | question              | answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Turner alias seed     | **SHIPPED, but inert.** `packages/taxonomy/src/wedge-aliases.ts` — **22 aliases / 16 skill ids, 22 ratified, 0 unratified**; the flag is `ratified`, not `rvm_ratified` (`rvm` is the `source`). **2** are turner-specific (`kharad`, `kharad ka kaam` → `skill_turning`), both self-retrieving at 1.0. With `SKILL_CANONICALIZE_ENABLED=false` **nothing in any request path reads them** — the flag is Python-only and all three readers return before `get_skill_store()`. The one SQL reader (`skills.repository.ts`) is token-gated, not flag-gated, so the table is dead by caller absence rather than by a second wall. |
| 2   | Turner chips          | **SHIPPED on the branch, not on `origin/main`.** 15 items / 81 options, all `target_kind: attribute`. Full ordered table with every chip set is in the ask-budget audit. Three tiers behind one `gte` gate on `turning_experience`.                                                                                                                                                                                                                                                                                                                                                                                            |
| 3   | Budget                | `MAX_ENGINE_ASKS` **24**; `qp_universal@2` spends **8**, all unconditional; the pack has **15**. **A senior turner is asked 23. One spare.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | Profile Strength §9.1 | **ABSENT as specified; something else ships under the name.** See §16.4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 16.2 — What was built

- **Work-history writer** (§1.2) — `PUT /workers/me/employment`, four employers, one role each.
  Replace-in-one-transaction (the unique index makes positional upserts collide), employer name
  encrypted before the DB touch, `duration_stated` derived rather than asked, PII-free event.
- **Zone 5** (§1.3) — education and certificates now render on the live path. The data was never
  missing: the crosswalk carries `education_level` and `certifications` onto the draft and the
  container path simply never read them. **Languages stay empty** — `draftPath: null`, no column.
- **Three enforcement tests** (§1.5) — city survival (with a real fix), the §8.3 asymmetry
  property, the §8.5 prompt lint.

### 16.3 — Two live defects found and fixed

**Cities were being redacted as person names.** `^\s*([A-Z][a-z]+)\s*,` matched
"Faridabad, Haryana…" and produced `[PERSON_1], Haryana…`. **33 of the 36 canonical cities**
masked this way; the three survivors survived only because the pattern cannot span a space. That
contradicted an owner ruling recorded four lines below it in the same file. `city_current` and
`cities_preferred` are Required and distance is a rejection filter, so the worker silently lost
the signal deciding whether he is reachable. Fixed by deferring the no-cue guess to the gazetteer
the module already imported and never consulted; the cue rule ("mera naam X") is untouched.
**Touches the AI privacy boundary — wants an ai-engineer review.**

**Zone 5 rendered empty for every real worker** while showing populated on all 56 fixtures,
because the fixtures were the only thing in the repo that set `qualification`. This also means the
R4 credential floor had never been able to fire on a live sheet — `topQualificationLine` scans
rows that were always empty.

### 16.4 — Profile Strength: the deltas (§1.6). NOTHING CHANGED.

Something called profile strength ships end-to-end — `computeStrength`
(`apps/api/src/workers/profile-summary.mapper.ts:192`) → `GET /workers/me/profile-summary` → a
Flutter card. It is **not** §9.1:

| §9.1 as specified                          | what ships                                                       |
| ------------------------------------------ | ---------------------------------------------------------------- |
| 8 **weights** summing to 100               | an **unweighted count** of 9 signals                             |
| bounded 0–100                              | **unbounded** — `skills.length + machines.length`                |
| 3 bands (Weak <40, Fair 40–69, Strong 70+) | **no bands**                                                     |
| one nudge, largest missing weight at Weak  | **no nudge**; `missing_fields` ships with **no client consumer** |
| `low_tag_worker` flag at Weak              | spec'd in `matching-algorithm-v1.md`, **never emitted**          |

Per the directive this is reported, not rebuilt. Building §9.1 alongside it would put two
different "strength" numbers on the same worker, which is worse than either.

**§9.2's four hard rules hold today, by accident rather than design** — the count never reaches a
payer payload, is not a ranking input, does not gate the download, and is not phrased as a grade.
Worth pinning as tests whenever §9.1 is actually built.

### 16.5 — Cost per profile (§1.7)

Priced from the real engine's ask sequence and the ai-service's own INR rate table
(`scripts/price-interview.py`). Chat turn is `gemini-2.5-pro` (₹0.104 in / ₹0.83 out per 1k).

| band   | asks | shipped default | chat armed, ~20-word replies | at the 512-token cap | extraction |
| ------ | ---- | --------------- | ---------------------------- | -------------------- | ---------- |
| 0      | 16   | **₹0.00**       | ₹0.96                        | ₹7.23                | ₹0.23      |
| 5 / 10 | 23   | **₹0.00**       | **₹1.76**                    | ₹10.77               | ₹0.23      |

**₹0.23 per profile shipped; ₹1.99 worst realistic case.** Under the ₹4 target either way.

Three things behind that number:

- **The shipped default spends nothing on the chat turn.** `AI_REAL_CALL_TASKS` defaults to empty
  (fail-closed, owner-ruled), and COST-4 serves the templated question directly on the
  straight-line path — which is every chip-tapping turner.
- **A stale comment says otherwise.** `config.py:337` claimed the allowlist "defaults to that task
  alone"; the field default is `""`. **RESOLVED (R6 §6)** — the claim was true of
  `docker-compose.staging.yml`, which supplies `${AI_REAL_CALL_TASKS:-profiling_chat_turn}`, and
  false of the Settings default. The comment now names the layer.
- **The ₹4/₹6 target was deliberately superseded in code** — `ai_target_profile_cost_inr` is
  **15.0** and the alert **20.0**, with the rationale in `config.py`: "Rs 4 was not a budget for
  that shape of work; it was a budget for not doing it." Meanwhile `real-llm-flip-go-no-go.md`
  still asserts "≤ ₹4 target ✅", validated at **₹0.023/call on Flash-Lite** — a model the chat
  turn no longer uses. Three sources, three different numbers. Reported, not re-tiered.
  **RESOLVED (R6 §6)** — `real-llm-flip-go-no-go.md` now carries a "cost target, reconciled"
  section naming `config.py` authoritative, marking its own ₹4 row superseded, and recording why
  the ₹0.023 figure cannot be carried forward (it was Flash-Lite; the chat turn is Pro, ~4× on
  both legs). No threshold was changed.

### 16.6 — Scorecard (§2)

|               | verdict                                                                                                                                                                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Capture**   | **PARTIAL.** Work history writes employer, city and dates (API side; Flutter is Rishi's). Zone 5 populates for education and certificates. **Languages, documents-ready and certificate detail have no ask anywhere in the 143-pack corpus** — ~15 of the 100 §9.1 points are unreachable by any question that exists. |
| **Honesty**   | **MET.** Asymmetry enforced as a property over all chip combinations, §8.5 linted with its one real conflict recorded rather than suppressed, city/name/phone intact through extraction and proved both ways.                                                                                                          |
| **Quality**   | **PARTIAL.** Aliases seeded, 22/22 ratified — but inert at runtime. Profile Strength drives **zero** nudges; the shipped count is not §9.1.                                                                                                                                                                            |
| **Economics** | **MET.** ₹0.23 shipped, ₹1.99 worst realistic.                                                                                                                                                                                                                                                                         |
| **Proof**     | **ABSENT, and unchanged.** Every number here comes from fixtures, the engine and the packs. No real transcript, no real turner.                                                                                                                                                                                        |

**#1292 has not moved** — still open, not merged. So B0b, a matching-path change, is running on a
branch with no CI, along with everything above.
