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

## P-002 · No `matching_catalog.published` event — the event catalog is frozen

**Found:** 2026-09-02, phase P1 (`matching_catalog`)
**Location:** [apps/api/src/match/matching-catalog.service.ts](apps/api/src/match/matching-catalog.service.ts) `publish()` — the point where a sibling service would emit
**Owner ruling:** parked by Prakash, 2026-09-02

**What is missing.** Every important business action emits a validated event
(engineering contract §3, "Event First"). Publishing a matching catalog is one: it
changes, platform-wide, which workers are visible for which jobs. The sibling path
emits `pricing.changed` on exactly the analogous write.

**Why it is not built.** The event schema is frozen under ADR-0014 with CEO signature.
Additive or not, a new event type is a change to a frozen catalog, and that is not an
engineering decision to make inside a build phase.

**What ships instead.** The publish path logs the new revision at INFO
(`MatchingCatalogService`) and the row itself is the durable record — `revision` is
unique and never reused, `updated_by` and `updated_at` are stamped, and no revision is
ever deleted. So the audit trail exists in the table; what is missing is the
_notification_, not the record.

**The specific thing to watch for.** No consumer needs cache invalidation on publish
today, because nothing reads `matching_catalog` yet — P2's tier resolver is the first
consumer and is not built. **If a consumer caches the active catalog, this stops being
a documentation gap and becomes a correctness bug**: a published revision would not
take effect until restart, with no signal that it had not. The standing instruction is
to HALT and raise it rather than work around it, because a cache that needs
invalidation changes the answer on whether the event is optional.

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
**Location:** [apps/admin-web/next.config.ts](apps/admin-web/next.config.ts) — `output: "standalone"`
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
