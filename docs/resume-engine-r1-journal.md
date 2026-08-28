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

**Second instance of a file's own comment forbidding what its code did.** After `EMOJI_RE` (whose
comment warned that a reflow would move the lint directive off the regex, which is exactly what
happened), the render processor's employments block carried "a failure here must cost the work
history and nothing else" one level below a `try` that took down the phone, the QR, the ref code
and the footer. Both were found by acting on the comment rather than reading past it. A comment
that states an invariant is a test that has not been written yet.
