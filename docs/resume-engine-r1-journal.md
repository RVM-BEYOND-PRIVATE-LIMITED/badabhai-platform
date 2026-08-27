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
