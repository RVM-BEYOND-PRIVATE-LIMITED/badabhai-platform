# ASSUMPTIONS

Decisions taken WITHOUT a ruling, so work could continue. Each one names what was assumed, why
that default was chosen, and **what it costs to reverse** — because the cost of reversal is the
only number that tells you whether the assumption was safe to make.

An entry leaves this file when it is ruled on. It does not leave because it stopped being
inconvenient.

---

## A1 · Verification-tier vocabulary — five in the schema, two in the UI

**Assumed.** `verification_state` reserves the full five-value vocabulary from Resume Engine
Part 10 — `self-declared · RVM-attested · document-verified · EPFO-verified · employer-rated` —
while the rendered sheet shows only two: an unverified worker (no badge at all) and
`BadaBhai Verified`.

**Why.** The guideline already answers this and I was treating it as open. Part 10.2 says
_"Reserve the schema now. `verification_state`, `verified_at`, `verification_source` and
per-claim verification flags cost nothing to add today and are expensive to retrofit across a
live corpus."_ Part 13 decision 6 says _"V2 for the build; V1 for the schema."_ Those two
sentences settle it: five in the schema, and the UI ships whatever is actually earnable, which
today is two. The earlier two-tier owner ruling and the guideline's five tiers were never in
conflict — one is about the page, the other about the column.

**Cost of reversal.** Near zero today and rising fast. The template treats the badge as a plain
string slot (`{{trust_badge}}`), so changing the printed vocabulary is a mapper edit and nothing
else. Nothing is stored yet: no `verification_state` column exists on this branch, so collapsing
the schema to two values is free **until the first migration writes it**. After that it is a
value migration across every worker row plus a re-render of every issued PDF.

**Live constraint that must survive any ruling.** Part 10.2: _"Absence of verification must never
read as doubt… The unverified state is rendered neutrally, never as a warning."_ The masthead's
right slot collapses when the badge is absent — it never prints "Unverified".

---

## A2 · Capability-row drop order under the nine-row page budget

**Assumed.** When a worker answers more capability rows than the page holds
(`CAPABILITY_ROW_BUDGET = 9`, measured from the three ratified sheets), rows survive by the
`rank` in `apps/api/src/resume/trade-resume-map.ts`, whose tens digit is the guideline's §5.1
decisiveness rank:

| Survives (a maxed-out CNC turner)                                                                                                        | Drops, in this order                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Machines · Controllers · **Machine capability** · Setting · **Workholding** · Programming · Drawings · Measuring instruments · Materials | Tolerance held → Operations → Quality → Troubleshooting → **Sector worked** (first out) |

**Why.** Two rows moved, and both moves are trade truth rather than layout preference:

- **Turning configuration** (live tooling, bar feeder, sub-spindle, C/Y-axis) is a statement
  about what the _machine_ can do — §5.1 rank 2, _"the literal vocabulary of the job
  advertisement, highest-signal attribute in the wedge"_ — and it moves the pay band. The
  earlier ordering dropped it before materials, which was a layout judgement standing in for a
  trade judgement.
- **Workholding** (chucks, collets, steady rests) is setting capability, §5.1 rank 4.
- **Sector worked** drops first because §4.3 says of `sector_tag`: _"Display only. Never a
  matching input — locked."_

**Not implemented, and stated rather than hidden.** The intended tail includes degrading
_materials chips beyond two_ before dropping the materials row. With a row-count budget that
stage is unreachable — 14 rows minus 5 drops is exactly 9 — so no per-value degradation stage
exists. If the row budget or the pack's row count changes, that stage has to be built rather
than assumed.

**Cost of reversal.** One number per row in one file, plus the one exact-list assertion in
`trade-resume-map.test.ts`. No migration, no stored data, no re-render obligation. Deliberately
cheap: this is the entry most likely to be redlined.

**This is flagged for RVM redline.** It is a shop-floor question — which fact a hiring supervisor
would rather lose — and nobody on this side of the fence is the right person to answer it.

---

## A3 · Zone 4 renders from `worker_employment`, else falls back to the tag-derived line

**Assumed.** Work history renders from `worker_employment` when rows exist and from the existing
flat `resume_profile.experiences[]` (role + the worker's own words for a duration, no employer)
when they do not. The mapper populates exactly one; never both.

**Why.** The _writer_ is blocked on an owner ruling (see `NEEDS_PRAKASH.md` Q1); the _reader_ is
not. Precedence rather than a cutover means the capture surface, whenever it lands, flips workers
over one at a time — no backfill, no migration, no flag.

**Cost of reversal.** Delete one boolean branch in `resume-render-input.ts`. Nothing is stored
either way.

**The fallback is INTERIM and is recorded as such** in `docs/resume-engine-r1-journal.md`. It
exists so Zone 4 is populated today. It is not the designed shape and must not be read as done.

---

## A4 · Zone 5 is caller-supplied, not extracted

**Assumed.** Education, certificates, languages and documents reach the sheet through
`TradeSheetContext.qualification`, supplied by the caller. On the résumé-container path that is
the _only_ source; on the legacy path the context wins per field and the snapshot fills the rest.

**Why.** Phase C returns nine keys and none of them is a credential, so this section rendered
empty for every worker whose interview ran. Widening Phase C is a change to a different surface
(`apps/ai-service`, the AI privacy boundary, `ai-contracts` is frozen and needs a joint TS +
Python + fixture PR). Building the render block now against seeded values means that widening
lands into a block already verified.

**Per field, not all-or-nothing.** `languages` exists only on the context; education exists only
on the snapshot for every profile written before capture. An all-or-nothing rule would blank one
of the two whichever way it fell. `??` and not `||`, so an explicitly empty list ("no
certificates") is a real answer and does not fall through.

**Cost of reversal.** One optional field on one interface. No stored data.

---

## A5 · Six files and one directory left unformatted, on purpose

**Assumed.** Five `packages/db` files are left unformatted — `src/schema/index.ts`,
`src/reencrypt-pii-backfill.ts`, and the three the occupation-eval fix touches
(`src/occupation-retrieval-eval.ts`, `src/occupation-retrieval-eval.test.ts`,
`src/eval-occupation-retrieval.ts`). `apps/api/src/resume/templates/` stays in `.prettierignore`.

**Why.** All five `packages/db` files are **already unformatted on `main`** — verified in-repo,
so the config actually resolved (see A7 for why that qualifier is load-bearing) — and
`prettier` is not a CI gate: `format:check` exists in the root `package.json` and no workflow
runs it. running prettier over
them would bury this change's real edits in a whole-file reflow, and a reviewer cannot see a PII
rotation target — or a change to how a quality gate SCORES — land inside hundreds of lines of
churn. The templates directory is excluded because
`prettier --check` really does report style issues on `bb_trade.v1.html` and on the shipped
`classic.v3.html` (measured), and reformatting either would break the `:empty` collapse: every
collapsible container is written on one line flush against its tags, because `:empty` does not
match an element holding a single space. A reflow silently un-hides every section a sparse
profile is meant to collapse — the PDF still renders, nothing logs, and a worker with no
certificates gets a bare "Certificates" heading on the sheet he hands to a supervisor.

**Cost of reversal.** For the `packages/db` pair: run prettier, take a large diff, no behaviour
change. For the templates directory: it is not a formatting preference and must not be reversed
without replacing `bb-trade-template.test.ts`, which is the guard that survives someone removing
the `.prettierignore` entry.

---

## A6 · Migration 0094's journal timestamp is pinned to the applied value

**Assumed.** `meta/_journal.json` keeps `when: 1787749973672` for 0094 — the value it was
actually applied under on 2026-08-28 — rather than the value a later `drizzle-kit generate`
stamped.

**Why.** Drizzle skips any entry whose `when` is below `MAX(created_at)` in
`__drizzle_migrations`. A re-stamped 0094 is therefore re-run against a database that already has
those tables, dies on "relation already exists", and blocks **every later migration behind it** —
on the deploy, silently.

**Verified, not reasoned.** The executable DDL of the applied file and the repo file are
byte-identical once comments and whitespace are removed (sha256 `b1f973b9…`, 3987 chars, both
sides). The only formatting change is the two `ym_format` CHECKs collapsing from three lines to
one. Two comment blocks the regeneration dropped have been restored. A fresh `drizzle-kit
migrate` from an empty database records 95 migrations with `max(created_at) = 1787749973672`.

**Cost of reversal.** There is no safe reversal while any database has 0094 applied. Un-pinning
breaks the deploy.

**WHAT CI ACTUALLY DOES, corrected.** I wrote that `supabase-checks.yml` is `disabled_manually`
(TD97) and that no schema↔migration drift gate exists. **That is wrong** — the workflow is
`active` and both its jobs ran on PR #1292. The claim came from a stale note rather than from
the live workflow state, which is the same class of error as A7 below: a fact asserted from a
source that could not observe the thing it described.

The corrected picture is more useful than either version:

- `migration-drift` DID run and its assertion step genuinely SUCCEEDED — `drizzle-kit generate`
  produced no diff under `packages/db/migrations`, which independently confirms schema.ts and
  0094 are in sync and that the hand-edited `_journal.json` (the `_note` key, the pinned `when`)
  survives a regenerate.
- **But both assertion steps carry `continue-on-error: true`** — "NON-BLOCKING — flip to blocking
  after a clean baseline" — so the job reports green whether the assertion passed or failed. Read
  the STEP conclusion, never the check. It is a signal, not a gate.
- **And neither job looks at `when` at all.** `migration-sequence` validates `idx` and `tag` and
  reads nothing else from the journal. A re-stamped 0094 would show up only as a `migration-drift`
  diff, on a step that cannot fail the build.

So the conclusion stands and the reason changed: the pin is protected by the header comment in
the `.sql` and the `_note` key, because the one gate that could notice is non-blocking and the
one that is blocking does not look.

---

## A7 · A verification that cannot observe what it claims — the recurring class

**Assumed.** Every gate on this branch is treated as unproven until it has been observed
FAILING, and every "X is clean / X is absent / X passed" claim is treated as unproven until it
was produced by a run that could actually have said otherwise.

**Why this is an entry and not a note.** It is now the fourth instance of one failure, and the
instances look nothing like each other, which is exactly why naming the instance never helped:

| #   | The claim                             | Why it could not be observed                                                                                                                              |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `db:verify:match-v1` passes           | It ran against an EMPTY database, so it verified nothing and said so in the affirmative.                                                                  |
| 2   | `/health` returns 200                 | It returned 200 with a dependency missing, so the check was insensitive to the thing it existed to detect.                                                |
| 3   | `main`'s `ci.yml` is prettier-clean   | I copied the file OUTSIDE the repo before checking, so prettier resolved no config and applied defaults. The answer described a file that does not exist. |
| 4   | No schema↔migration drift gate exists | Read off a stale TD note instead of the live workflow list. `supabase-checks.yml` is active and ran (see A6).                                             |

The shape they share is not carelessness. In every case a real command ran, exited 0, and
printed something true — about a different question than the one being asked. A green result is
evidence only when you can state what a red one would have required.

**The two that were caught the same way** are worth recording because they are the method: the
QR fixture (`qrDataUri: null`, so all 28 page-fit measurements were taken on a footer production
does not print) and the `it.fails` XFAIL. Both were caught by asking "what would this have looked
like if it were broken?" and then MAKING it broken. The QR answer was a genuine surprise: the
expected cost was ~12 mm of page and it measured 0.00 mm, because `.foot` is a flex row whose
text column is already taller than the 18 mm image. The fixture was wrong; the conclusion it fed
was not. Both halves of that get stated, because "I was wrong" and "the result was wrong" are
different claims and only one of them was true.

**The standing operational facts** this leaves behind:

- **`main` is not prettier-clean.** `.github/workflows/ci.yml` and at least two `packages/db`
  files are unformatted ON MAIN. Any agent that runs `pnpm format` will produce hundreds of files
  of churn that has nothing to do with its change — and, on `ci.yml`, will reflow a `needs:` array
  it never touched. Check formatting IN the repo, on the files you actually changed.
- **A `continue-on-error: true` step reports a green check.** Read step conclusions
  (`gh api .../actions/jobs/<id> --jq '.steps[]'`), not the check list, before believing a gate.

**Cost of reversal.** None — it constrains how claims are made, not what the code does.
