# PARKED

Real problems found during a build phase that were **not** in that phase's scope.
Recorded, not fixed. Each entry carries a file and a line.

---

## P-001 · Prettier silently corrupts markdown fill-in lines and never converges

**Found:** 2026-09, while producing `docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md`
**Location:** [package.json](package.json) line 12 — `"format": "prettier --write \"**/*.{ts,tsx,js,jsx,json,md,yml,yaml}\""` and line 13 `format:check`
**Severity:** low blast radius today, but silent and repeating

**What happens.** A markdown line containing a long run of underscores — the normal way to
write a signature or fill-in line —

```
Signed (RVM): ____________________  Date: __________
```

is parsed by Prettier as emphasis/strong delimiters and rewritten to garbage
(`**********\_\_**********`). It also corrupts bare `MASTER_CONTEXT` into
`MASTER*CONTEXT`. Worse, **the transformation is not idempotent**: each
`prettier --write` produces different output, so `pnpm format:check` can never pass on
such a file. Measured by writing twice and diffing — 36 differing lines between pass 1 and
pass 2.

**Why it matters.** Any signature sheet, decision record, or fill-in form committed as
`.md` will be mangled the first time anyone runs `pnpm format`, and will then fail
`format:check` permanently with no obvious cause.

**Workaround used** (not a fix): put fill-in and signature lines inside fenced code
blocks, and backtick any bare identifier containing underscores.

**Not fixed because:** the repo-wide fix is either a `.prettierignore` entry for
`docs/**/*.md` or a prose-wrap policy change, and both are formatting-policy decisions
outside this task's scope. Note the existing constraint that there is **no
`.prettierignore` today**, so `pnpm format` already reformats the drizzle migration
snapshots — any change here should be made deliberately, not as a side effect.

---

## P-002 · CORRECTED — this entry documented a BRANCH as if it were `main`

**Corrected:** 2026-09-03, phase-brief survey. **Owner ruling:** Prakash.
**Superseded on merge:** PR #1387 replaces this entry wholesale. Take ITS version.

**What this entry used to claim.** That no `matching_catalog.published` event existed,
that the event schema was frozen under ADR-0014 with CEO signature, and that adding one
was therefore not an engineering decision. It cited
`apps/api/src/match/matching-catalog.service.ts` as a live location.

**Both halves were wrong, in different ways.**

**1 — the file is not on `main`.** `apps/api/src/match/matching-catalog.service.ts` exists
only on branch `p1-matching-catalog`. So does the rest of P1: `packages/matching-catalog/`,
the controller, the DTO, the repository and migration `0099_overrated_fantastic_four.sql`.
On `main` (`git ls-tree`, any spelling) there is nothing. **This entry was written against
an unmerged branch and filed as if it described `main`** — which is worse than a stale
link, because every reader downstream inherited it. Five phase briefs and ten of eleven
phase surveys did.

**2 — the event ships, and the freeze premise was false.** `matching_catalog.published`
v1 is commit `a454fac0` on that same branch. ADR-0014 says the opposite of what the park
claimed, in its own words: *"we are **NOT hard-freezing** the schema … this is a
guardrail, not a freeze"*. The park was reasoned from a remembered summary of an ADR
rather than from the ADR.

**Where this actually stands.** P1 is **built, unmerged and unchecked** — open draft
**PR #1387, "[DO NOT MERGE — blocked on role-registry ruling]"**, held on the R1–R4
signatures, not on code. There is no `docs/qa/evidence/P1/`. Nobody has run P1_CHECK
against the branch.

**The cache-invalidation warning still stands, and now has an owner.** Nothing on `main`
reads `matching_catalog`, so no consumer needs invalidation yet. **The first consumer to
cache the active catalog turns this from a documentation gap into a correctness bug** — a
published revision would not take effect until restart, with no signal that it had not.
That consumer is P2. HALT and raise it rather than work around it.

**Lesson, and it is the reason this correction is this long:** a park that cites a file
must say which ref it read. This one cost a survey ten wrong conclusions about whether
P1 existed at all.

---

## P-003 · `pnpm-lock.yaml` is `-diff`, so a lockfile review silently reviews nothing

**Found:** 2026-09-02, while auditing an abandoned P1 duplicate for an installed dependency
**Location:** [.gitattributes](.gitattributes) line 15 — `pnpm-lock.yaml -diff linguist-generated`
**Severity:** low today, high the day it matters

**What happens.** `git diff -- pnpm-lock.yaml` prints
`Binary files a/pnpm-lock.yaml and b/pnpm-lock.yaml differ`, and `git diff --stat` reports
`Bin 222569 -> 222801 bytes`. The file is not binary — it is 6975 lines of plain YAML with
zero NUL bytes. The `-diff` attribute suppresses the textual diff.

**Why it matters.** A supply-chain review is exactly the review that must read this file.
The reviewer sees "binary, can't show you", accepts the summary, and a real dependency
change — a version bump, a new registry resolution, a changed integrity hash — passes
unread. The failure mode is silent and looks like normal tooling output.

**The workaround that works:** `git diff --text -- pnpm-lock.yaml`. Note this also applies to
patches: `git diff > x.patch` on a tree with lockfile changes produces a patch whose
lockfile hunk is a `Binary files … differ` stub and cannot be reapplied. Use `git diff --text`.

**Not fixed because:** removing `-diff` is a repo-wide `.gitattributes` policy change that
affects every reviewer's diff output and every generated patch, and `linguist-generated` on
the same line is doing wanted work (collapsing the file in GitHub's UI). That is a
deliberate decision, not a side effect of an audit.

---

## P-004 · `bootstrap-admin` tells the operator to call a route that does not exist

**Found:** 2026-09-02, fact-checking `docs/operations/COMMANDS.md`
**Location:** [packages/db/src/bootstrap-admin.ts](packages/db/src/bootstrap-admin.ts) lines
4, 153 and 240
**Severity:** low blast radius, but it is operator-facing and it 404s

**What happens.** The bootstrap CLI names `POST /admin/invite` as the way to create every
further admin — in its header comment (line 4), in its refusal message when a super_admin
already exists (line 153), and in the success message printed to the operator's terminal
(line 240: `Every further admin must come from POST /admin/invite`).

There is no such route. The real one is `POST /admin/admins` —
[`@Post("admins")`](apps/api/src/admin/admin-actions.controller.ts) on the controller mounted
at `@Controller("admin")`. `POST /admin/invite` returns 404.

**Why it matters.** This is the one moment the platform has the operator's attention and is
telling them what to do next, and the instruction is wrong. It is printed at exactly the
point where there is no second super_admin to ask.

**Not fixed because:** it is a string change in a file this task does not own, and the same
wrong route name appears in three places plus a refusal path that wants its own test. It is
a small, clean PR of its own, not a drive-by edit inside a cleanup. `docs/operations/COMMANDS.md`
now carries the correction so the doc does not repeat the error.

---

## P-005 · `pnpm build` cannot pass on Windows — `admin-web` dies on a symlink

**Found:** 2026-09-02, running the gates after the P1-duplicate cleanup
**Location:** [apps/admin-web/next.config.mjs](apps/admin-web/next.config.mjs) — `output: "standalone"`
**Severity:** none in CI, total locally. **Do not re-investigate this; it is known.**

**What happens.** `pnpm build` reports `15 successful, 17 total` / `Failed:
@badabhai/admin-web#build`, with:

```
[Error: EPERM: operation not permitted, symlink
 '…\node_modules\.pnpm\@jridgewell+trace-mapping@0.3.31\node_modules\@jridgewell\trace-mapping'
 -> '…\apps\admin-web\.next\standalone\node_modules\…'] { errno: -4048, code: 'EPERM' }
```

The named package differs run to run — it is whichever dependency the tracer reaches first,
not a problem with that package.

**It is not a build failure.** The build gets all the way through:

```
✓ Compiled successfully in 2.1s
  Checking validity of types ...
✓ Generating static pages (4/4)
  Collecting build traces ...
> Build error occurred
```

It compiles, type-checks and prerenders every page. It fails only at `Collecting build
traces`, where Next's `output: "standalone"` copies `node_modules` by **symlink**. Creating a
symlink on Windows needs Developer Mode or `SeCreateSymbolicLinkPrivilege`; without it every
attempt is `EPERM`. Deterministic — three consecutive runs, same stage.

**Why it is not a regression.** CI builds this surface on Linux on every push to main
(`.github/workflows/ci.yml` carries an `admin-web` image row), so the standalone output is
produced there. Confirmed on a branch whose entire diff versus `origin/main` was
documentation — 37 files, zero source — meaning `admin-web`'s build inputs were byte-identical
to upstream and the failure could not have been introduced by the change under test.

**What this means for a local gate.** `pnpm build` is **not** a usable green/red signal on a
Windows box. Use `pnpm typecheck` (29/29) and `pnpm test` (29/29), and read `admin-web`'s
build output for `✓ Compiled successfully` rather than its exit code.

**Not fixed because:** the candidate fixes are enabling Windows Developer Mode (a machine
setting, not a repo change) or dropping `output: "standalone"` (which the staging Dockerfile
depends on). Neither belongs in a cleanup.

---

## P-006 · `canary-coverage.test.ts` is one slow machine away from reddening CI

**Found:** 2026-09-02, full-suite run during the same cleanup
**Location:** [apps/api/src/common/canary-coverage.test.ts](apps/api/src/common/canary-coverage.test.ts) — the second test, `probes every ops-internal route`
**Severity:** low frequency, high blast radius — this test is CI-blocking

**What happens.** Under full-suite load the test times out:

```
FAIL  src/common/canary-coverage.test.ts > … > probes every ops-internal route
Error: Test timed out in 30000ms.
```

Run on its own it finishes in **2.15s** against that same 30s budget, and two subsequent
full-suite runs were green (`398 passed | 16 skipped (414)`, `7288 passed`). So it is
load-induced, not a real failure — but the margin is not as wide as 2.15s vs 30s suggests,
because the cost is not in the test body. It `await import()`s **every** `*.controller.ts`
on disk — 70 files — and under a parallel vitest run those imports queue behind every other
worker's transform. The suite reported `transform 104.90s` and `collect 1184.03s` cumulative
on the failing run versus `transform 29.00s` on a passing one.

**Why it matters.** A green run here is not evidence the guard coverage is intact; it is
evidence the machine was fast enough. And when it flips, it flips on the one test whose
whole purpose is to prove no ops route is unguarded — so the failure reads as a security
regression to whoever sees it in CI.

**Not fixed because:** the fix is a judgement call about the right number
(`{ timeout: … }` on that `it`, or a `testTimeout` for the file), and raising a timeout to
silence a red test is exactly the move that needs a deliberate decision rather than a
drive-by edit inside a cleanup. Raise it when it next bites, not now. Do **not** address this
by weakening what the test asserts.

---

## P-007 · ADR-0030 §7 gate (d) says zero unratified vernacular ships active — three phrases do

**Found:** 2026-09-02, P0 fix pass, correcting defect 4 of `docs/qa/evidence/P0/VERDICT.md`
**Location:** [apps/ai-service/app/profiling/signals.py](apps/ai-service/app/profiling/signals.py)
— the TAX-WELD-1 header comment and the two bare `welding` / `welder` entries in `_WELDING_RE`
**Severity:** not a matching bug — a record-versus-behaviour divergence in a ratification gate

**What the record says.** The TAX-WELD-1 header states _"ZERO unratified Hinglish/vernacular
alias ships active… Any further vernacular ('welding karta hun', 'welding wala kaam', 'gas wali
welding') needs RVM ratification (ADR-0030 §7 gate (d)) and is NOT here."_ Only
`welding ka kaam` is ratified, via the 2026-07-16 wedge packet.

**What the matcher does.** All three of those phrases resolve today. Measured by the P0 checker
against `_WELDING_RE` (this pass did not re-run it — see the VERDICT for the executed command):

```
'welding karta hun'   -> ['skill_welder_occupation']
'welding wala kaam'   -> ['skill_welder_occupation']
'gas wali welding'    -> ['skill_welder_occupation']
'main fitter hun'     -> NO MATCH          <-- negative control, so the check is not vacuous
```

They match incidentally: each contains the bare English token, and `{'source': 'welding'}` /
`{'source': 'welder'}` are word-bounded patterns already active. The header says as much itself
— the vernacular _"is covered by the plain 'welding' keyword."_

**Why it is worth recording.** The gate's guarantee is about aliases; the observable behaviour is
about phrases. Those are not the same claim, and the sheet's own R5 block was, until this pass,
offering the CEO a recall gain for ratifying phrases that already resolve. The same shape will
recur for any trade whose vernacular embeds the English token — the ratified list will keep
understating what the matcher already answers.

**Not fixed because:** the fix is a ruling, not an edit. Either gate (d) means "no unratified
*alias entry* is active" — in which case the record is correct and the header wording should say
so — or it means "no unratified *phrasing* resolves", in which case the bare-token patterns are
themselves the thing to re-examine. Picking one is settling an open ruling by default, which the
build rules forbid. R5 in the worksheet now states the divergence and leaves it open.

---

## P-008 · A shipped console is documented as unshippable, and the docblock invites rebuilding it

**Found:** 2026-09-03, PX scoping
**Location:** [apps/api/src/admin/admin-skill-discovery.controller.ts](apps/api/src/admin/admin-skill-discovery.controller.ts) lines 98-103
**Severity:** low as a fact, high as a trap

**What it says.** The controller docblock states that `apps/admin-web`'s `ADMIN_CAPABILITIES` +
exhaustive `CAPABILITY_LABELS` is Frontend Platform's file and that _"until that lands, the
console has a capability it cannot label, so the review UI cannot ship even though this route
can. That needs a Frontend issue, not a backend edit."_

**What is true at HEAD `6d1d979e`.** It landed. `review_skill_candidates` is present and
labelled — [apps/admin-web/src/lib/auth/capabilities.ts](apps/admin-web/src/lib/auth/capabilities.ts)
lines 50 and 83 (`"Decide skill-discovery candidates"`) — and the console shipped in full:
`apps/admin-web/src/app/(portal)/skills/discovery/` holds `page.tsx`, `filter-bar.tsx`,
`loading.tsx`, `page.render.test.tsx`, and its `[id]/` folder holds `page.tsx`,
`decision-panel.tsx`, `actions.ts`, `actions.test.ts` and its own render test.

**Why it matters more than a stale comment usually would.** It is load-bearing in the wrong
direction. Any agent scoping work against this surface reads "the review UI cannot ship",
concludes the review screen is missing, and builds one. `docs/agent/phases/PX_BUILD.md` line 12
forbids exactly that — _"Do not build a second review screen"_ — and `PX_CHECK.md` line 15 fails
a phase for it. So the docblock converts a check item that is already PASS into a FAIL, and
costs a build nobody wanted.

**Not fixed because:** it is a comment in a file this phase does not own a reason to touch, and
the honest correction also wants a line about what the console now does — a documentation pass
on the admin surface, not a one-word edit inside a scoping task.

---

## P-009 · The discovery reader ignores `unresolved_phrase.scope`, so occupation misses leak into the skill queue

**Found:** 2026-09-03, PX scoping
**Location:** [packages/db/src/discover-skills.ts](packages/db/src/discover-skills.ts) lines 384-387
**Severity:** correctness — it silently undoes the separation 0072 was written to create

**What happens.** The reader selects `id`, `phrase` and `job_domain_id` from `unresolved_phrase`
with a single predicate, `status = 'open'`. There is no `scope` predicate.

`scope` was added by
[0072_unresolved_phrase_scope.sql](packages/db/migrations/0072_unresolved_phrase_scope.sql)
line 49, with a CHECK restricting it to the two values `skill` and `occupation`, and a
scope-aware unique index at line 47 — precisely so the two queues stay distinct. Every
occupation-scope miss therefore arrives in the SKILL discovery corpus as if it were a skill
phrase.

**Why it matters now.** The owner ruled on 2026-09-03 that PX writes `skill_alias` only, and
that occupation vernacular is never a source for `skill_alias` — the directional rule. This
query is the one place that rule is not enforced in code: it is the seam through which
occupation language reaches the skill side.

**A second defect in the same three lines.** `unresolved_phrase.count` is the authoritative
observation counter — `packages/db/src/schema/skill.ts` line 271, incremented atomically on
conflict — and it is **not selected**. Downstream, occurrences are recomputed as source-row
multiplicity, so a phrase forty workers said is indistinguishable from one said once.
`PX_BUILD.md` line 7 asks for exactly this count.

**Not fixed because:** adding the predicate changes which phrases become candidates, which
changes a run's `input_fingerprint` and every count derived from it. That wants its own measured
change with a before-and-after dry run, not a one-line edit inside a scoping task.

---

## P-010 · The consonant-skeleton fold is banned from merging and trusted to silently drop

**Found:** 2026-09-03, PX scoping
**Location:** [packages/db/src/skill-discovery-match.ts](packages/db/src/skill-discovery-match.ts)
lines 233-243 (the emit), 274-276 (`isAlreadyCovered`), 322-356 (`MERGE_RELATIONS`), and
[packages/db/src/skill-discovery-plan.ts](packages/db/src/skill-discovery-plan.ts) line 707
(`needsDecision`)
**Severity:** silent — the failure produces no row, no error and no queue entry

**The contradiction, in one file.** A consonant-skeleton collision emits the relation
`skeleton_surface` with a pinned `SKELETON_SURFACE_SCORE = 0.95` and strength `strong`.
`isAlreadyCovered` returns true for that relation, the disposition becomes
`covered_by_existing_skill`, and `needsDecision` returns **false** for that disposition — so the
phrase never becomes a candidate, never reaches a reviewer, and never lands in
`unresolved_phrase`. It is simply gone.

One hundred lines lower, the **same fold** is removed from `MERGE_RELATIONS`, with the
measurement written into the comment: `skeletonKey` drops every interior vowel, so `pile`,
`pool` and `ply` all reduce to `pl` — producing one cluster holding _"pile-driver operator"_,
_"swimming pool cleaner"_ and _"ply bander"_ — and `battery` landed beside `butter`. The rung's
own docblock says it _"GENERATES candidates for L2/L3 to score rather than deciding anything."_

So the same evidence is judged too weak to **merge** two phrases and strong enough to **discard**
one unseen. Both cannot be right.

**Why a confidence floor cannot catch it.** The drop happens on RELATION, before any number is
consulted, and the score is pinned rather than measured, so it clears any floor by construction.
This is the one path in the pipeline where a phrase is lost without a human ever being asked,
and it is structurally invisible to the mechanism `PX_BUILD.md` line 16 proposes against it.

**Not fixed because:** the fix is a judgement about which side of the contradiction is right —
demote `skeleton_surface` to weak evidence so it reaches a reviewer, or keep the drop and justify
the asymmetry. Both change what a run produces, and the second needs the measurement the
merge-side comment already has and the drop-side does not.

---

## P-011 · Two consumers share one `unresolved_phrase` queue and starve each other with no watermark

**Found:** 2026-09-03, PX scoping
**Location:** [packages/db/src/discover-skills.ts](packages/db/src/discover-skills.ts) line 386
and [packages/db/src/growth-cluster.ts](packages/db/src/growth-cluster.ts) lines 26 and 31
**Severity:** low today, and it gets worse with each consumer added

**What happens.** Both runners read `unresolved_phrase` filtered on `status = 'open'`, and
`db:growth:cluster --apply` moves the member rows of emitted proposals from `open` to
`clustered`. Those rows then fall out of `discover-skills`'s predicate. Whichever runner applies
first removes work from the other — with no error, no log on the losing side, and nothing
recording that the second consumer saw a smaller queue than the first.

`--reopen-clustered` exists and moves everything back, but that is a recovery for rejected
proposals rather than coordination: running it un-starves discovery by also undoing growth's
bookkeeping.

**Why it is worth recording now.** `status` is being used as two things at once — a per-row
lifecycle, and a per-consumer read watermark. It works while there is one consumer and degrades
quietly with each addition. Any PX work that reads this queue would be the third.

**Not fixed because:** the fix is a per-consumer watermark or a consumption-log table — a schema
change plus a migration on a queue two shipped runners already depend on. That is a design
decision with an owner, not a fix to make inside a scoping task.

---

## P-012 · Should the discovery batch matcher be domain-scoped? An owner ruling, and it needs a measurement first

**Found:** 2026-09-03, PX scoping. Raised by owner ruling ④ (§24 means domain-scoped only).
**Location:** [packages/db/src/skill-discovery-match.ts](packages/db/src/skill-discovery-match.ts)
line 214 (`matchExistingSkills`) and
[packages/db/src/discover-skills.ts](packages/db/src/discover-skills.ts) lines 135-141
(`EXISTING_SKILL_SQL`)
**Severity:** not a bug — an inconsistency between a ruling and one layer, with a real cost either way

**The inconsistency.** At runtime, skill search is scope-REFUSING: the repository signature makes
"neither scope" unrepresentable and the request 400s if a scope is missing or doubled, and the
ai-service refuses again before spending an embed. In DISCOVERY, matching is GLOBAL-only:

```
matchExistingSkills(normalized, index, limit = 5)     // no domain parameter
EXISTING_SKILL_SQL: FROM skill s LEFT JOIN skill_alias a ...
                    WHERE s.status <> 'deprecated'    // no domain join
```

Under ruling ④ — domain-scoped only, the global tier retracted — the batch matcher is the one
place in the system inconsistent with the ruling.

**Why this is a ruling and not a build.** Scoping it is not a post-filter. The match result feeds
`disposition`, `proposeAction`, `confidenceBand` and `confidenceValue`
([skill-discovery-plan.ts](packages/db/src/skill-discovery-plan.ts)), so restricting the candidate
set changes **which phrases become candidates at all** — not merely how they are ranked. A phrase
whose true match lives in a domain it was not observed in stops being `covered_by_existing_skill`
and starts being a proposed new skill, which is the direction that mints duplicates.

**THE FIGURE EVERYONE WILL QUOTE IS A DOCUMENTATION CLAIM, NOT A MEASUREMENT.** The number that
makes this decision look obvious — that roughly **28 of 3,885** active job domains carry any
`job_domain_skill` edge — appears at
[docs/architecture/project-control.md](docs/architecture/project-control.md) line 191 and
[docs/architecture/project-status.md](docs/architecture/project-status.md) lines 41 and 527. It is
marked VERIFIED and attributed to a probe, but it is a **recorded result from a past run**, not
something re-measured for this park, and the surrounding table dates from a catalog version stamped
2026-08-07. **Nobody should act on it until it is re-measured.** If it is still near right, naive
domain-first matching over the discovery corpus returns nothing for the overwhelming majority of
trades — which would make scoping the matcher actively harmful rather than merely expensive. If it
has moved, the whole calculation changes.

**The measurement this needs, before any code.** Three read-only things, in order:

1. Re-run the coverage probe already written down at `project-control.md` line 187-191 — the
   `count(*) FILTER (WHERE EXISTS ...)` over `job_domain` — and record the date and the SHA.
2. Count how many rows in the discovery corpus carry a `job_domain_id` at all. A phrase with no
   domain cannot be domain-scoped, and `unresolved_phrase.job_domain_id` is nullable, so the
   answer bounds how much of the corpus the change could even reach.
3. A before-and-after **dry run** of `discover-skills` with and without scoping, comparing
   candidate counts and the disposition histogram — `covered_by_existing_skill` versus
   `alias_opportunity` versus proposed-new. The runner is dry-run by default and asserted to
   contain no mutation verb, so this costs nothing but time.

**Not fixed because:** ruling ④ settled what §24 means; it did not rule on whether the batch
matcher must follow the runtime, and those are different questions. Answering the second by
inference from the first is settling a ruling by default. The three measurements above are what
would let the owner answer it on evidence rather than on the shape of the argument.

---

## P-013 · The payer Flutter app hardcodes three role vocabularies, and they disagree

**Found:** 2026-09-04, phase-brief rewrite, while applying owner ruling R4-d(b) (the role
count is 21).
**Owner ruling:** PARK, do not fix — Prakash, 2026-09-04.
**Location:** [apps/payer-app/lib/features/jobs/presentation/post_job_screen.dart](apps/payer-app/lib/features/jobs/presentation/post_job_screen.dart)
lines 80-87 and 90, and
[apps/payer-app/lib/core/data/models.dart](apps/payer-app/lib/core/data/models.dart)
lines 554-570 (`kAgencyTradeKeys`) with its label map at 573.
**Severity:** low today, and it is the shape of the defect rather than its size that matters.

**What is there.** Three role vocabularies ship in one Flutter app, none derived from the
server:

- `post_job_screen.dart:80-87` — six DISPLAY STRINGS: `'CNC Setter'`, `'VMC Setter'`,
  `'CNC Operator'`, `'Quality Inspector'`, `'Welder / Fabricator'`, `'Fitter'`.
- `models.dart:554-570` — fifteen `trade_key` VALUES (`cnc_operator` … `fitter`) plus a
  display-label map, documented as *"the ratified manufacturing alpha trade keys."*
- `post_job_screen.dart:90` — the `vacancy_band` enum restated as five literal strings.

They do not agree with each other, and neither agrees with the server: the role registry
declares FIVE (`apps/api/src/profiling/roles/role-registry.ts:39-45`, all `formEnabled`).
Six, fifteen, and five are three answers to one question, and `'Welder / Fabricator'` has no
counterpart in either of the other two lists.

**Why it is a defect and not a preference.** Ruling ① of 2026-09-04 says a brief may not
assert a role count, because the taxonomy is RVM's and moves. A client that hardcodes one is
the same failure with a longer feedback loop: the day a role is added, renamed or disabled
server-side, this app keeps offering the old set and nothing fails — the payer picks a trade
that no longer exists, or never sees one that does. P10 and P12 both exist to make clients
render from a server-served schema; this is the surface they were written for.

**Why it is parked and not fixed.** Fixing it is not deleting the lists — it is giving the
payer app a served descriptor to read, which is P8's `GET /schema` (deleted from that phase,
blocked on PR #1387 and P3's columns) and P12's wizard (blocked on ruling R6, unsigned). The
fix has no landing place until those exist. Editing the three lists into agreement now would
also be an edit inside `apps/payer-app`, which has **no owner in `.github/CODEOWNERS`** — the
exact gap R6 exists to close.

**The specific thing to watch for.** `P12_CHECK` item 4 greps Dart for hardcoded role labels
and fails on any hit. It therefore fails TODAY, on this code, before P12 writes a line. That
item is scoped in the rewritten P12 to the new wizard's files for exactly this reason. **If
someone later widens it back to the whole app without removing these three lists first, P12
becomes unpassable** — and the failure will read as a defect in the new wizard rather than in
code that predates it by months.

---

## P-014 · A PDF converted to Markdown was invisible to ripgrep, and looked exactly like a clean search

**Found:** 2026-09-04, PR #1418, by `apps/api/src/common/source-hygiene.test.ts` in CI.
**Owner ruling:** PARK the general rule — Prakash, 2026-09-04. The instance is already FIXED
on PR #1418; what is parked is the practice that must follow every conversion.

**What happened.** `docs/reference/BadaBhai_Role_Taxonomy_Master_2026-08-09.md` — which lives on
PR #1418 and is NOT on `main` as this entry is written — was converted from a PDF so that
agents could read a document `docs/agent/BUILD_RULES.md` names. The PDF's
bullet glyph extracted as raw `0x7f` (DEL) at the head of four prose lines (386, 388, 390,
392). **ripgrep treats a file containing raw control characters as BINARY and skips it
silently.** The document committed specifically to be searchable could not be searched at all.

**Why this class is worse than a broken file.** A search over it returned nothing, and a search
that finds nothing is indistinguishable from a search over a file with nothing in it. There is
no error, no warning, and no failing step anywhere near the person doing the searching — the
next agent would have concluded the document does not mention what it in fact says on line 386.
Same shape as every check that runs, exits 0, and answers a different question than the one
asked: a real command ran and told the truth about the wrong thing.

**The rule to apply.** A conversion is not done when the text looks right. **Grep-verify it:**
pick a phrase from the middle of the converted body and confirm `rg` returns it, and scan the
output for C0/C1 characters before committing. Do not infer searchability from the fact that a
text editor renders the file — an editor is not ripgrep, and neither is a diff view.

**Why the local run missed it.** The branch was docs-only, so nothing about the diff suggested
an `apps/api` suite was relevant. The guard that caught it lives there. Relevance was the wrong
filter; CI does not use one.

---

## P-015 · `deps-audit` is a required check that almost never runs

**Found:** 2026-09-04, PR #1418, when a two-line `package.json` edit woke it.
**Owner ruling:** PARK, do not fix — Prakash, 2026-09-04.

**What is true today.** `deps-audit` sits in `ci-required`'s `needs` (`.github/workflows/ci.yml`),
so it can block any merge. It is path-filtered, and on every recent run against `main` it
reports `skipped` — no row at all. Adding two `scripts` entries to `package.json` — not a
dependency change — is what made it execute for the first time on that branch.

**And when it executed, it failed.** Three consecutive runs died the same way:

    POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk error (503)
    TimeoutError: The operation was aborted due to timeout

Reproduced locally on a different network, so it is npm's advisory API, not the runner and not
the diff. That is the immediate cause and it will pass; the parked defect is structural.

**Why it is a defect.** A gate that fires only when someone accidentally trips a path filter is
not a gate. Two things follow, and both are bad on their own:

1. **It is not protecting anything.** Between the filter and this outage, no recent merge to
   `main` has had its dependencies audited. The check's green record is mostly `skipped`.
2. **When it does fire, it blocks unrelated work.** It is `ci-required`, so a docs PR that
   happens to touch `package.json` inherits a network dependency on npm's advisory service.

**What a fix would have to decide** (not settled here): whether the audit runs on a schedule
against `main` rather than per-PR; whether a registry timeout should fail the job or be
retried/soft-failed distinctly from a real advisory — a timeout and a HIGH CVE currently
produce the identical red; and whether it belongs in `ci-required` at all if it cannot be
executed deterministically. Note the trap in that last one: **removing it from `ci-required`
to stop it blocking is escaping the gate, not fixing it.**

---

## P-017 · `db:audit:live-population` targets remote Supabase as `postgres` with `bypassrls=true`

**Found:** 2026-09-05, phase M1, on the first run of a command the phase brief named.
**Owner ruling:** PARK, do not fix — the owner rules on both the target and the role.

**What the command prints on its own first line:**

```
$ pnpm --filter @badabhai/db db:audit:live-population
[audit:live-population] READ-ONLY, ZERO SPEND, NO PII SELECTED.
  target = SUPABASE (remote)  role=postgres  bypassrls=true
```

**Why this is a defect and not a configuration detail.** It is a developer-facing command in the
root workspace, run by name from a brief, and it reaches a REMOTE database as a superuser role
with RLS bypassed. Three things follow:

1. **The safety is a convention, not a boundary.** The banner says READ-ONLY; the connection is
   not. `bypassrls=true` means the role can write every table and no row-level policy would stop
   it. A command that announces a property it does not enforce is the shape that gets trusted.
2. **The target is implicit.** Nothing in the invocation names an environment. Running
   `pnpm db:audit:live-population` from a clean checkout, expecting the local compose Postgres,
   silently reaches production instead — and the local one exists and is what every other
   `db:*` command in this session used.
3. **The blast radius is one typo wide.** The nearby `db:*` scripts include seeders and
   backfills. An engineer or an agent that reaches for the audit and hits an adjacent script name
   is writing to live with a superuser role.

**Measured, not inferred.** The audit reported live counts (`workers 4`, `worker_profiles 4`,
`worker_skill 3`, `job_reach 6`) that do not match the local compose database (`workers 2`,
`worker_profiles 0`, `worker_skill 2`, `job_reach 2`) — which is how the remote target was
noticed at all.

**AND THAT DETECTION WAS LUCK, NOT METHOD — this is the strongest argument for
target-as-argument, stronger than the `bypassrls` role itself.** The only reason the remote
target surfaced is that the two databases happened to hold different numbers. Had they agreed —
two fresh environments, or one seeded from the other — the counts would have been reported as
local, believed, and never questioned. "The numbers happened to disagree" is not a control. No
part of the invocation, the output, or the developer's expectation would have caught it, and the
next person has no reason to expect better luck. No write was attempted, and phase M1's five end-to-end trade-form runs were
STOPPED rather than executed, because completing a form creates worker rows.

**What a fix would have to decide** (not settled here): whether the audit reads a target from an
explicit, named argument rather than ambient environment; whether it refuses to run against a
non-local host without a confirmation flag; and whether any developer-facing script should ever
resolve credentials for a `bypassrls` role. Note the trap: making the banner louder is not the
fix — the banner is already accurate about intent and wrong about capability.

**Consequence for M1:** the phase's verification (five real trade forms end to end, then a
publish showing `job_reach` move) is UNRUN. It runs against the local database once the owner
confirms the target, never against the audit's.
