# Development workflow — shared-file protocols

> Scope: the handful of files where two developers working in parallel will collide, and the
> protocol for each. Everything else follows the ordinary review flow in `CLAUDE.md`.

This document exists because of a specific failure mode: **a merge that resolves cleanly and is
still wrong.** Every protocol below guards one of those.

---

## 1. Database migrations

drizzle-kit writes three artefacts per migration — `NNNN_slug.sql`, an entry in
`meta/_journal.json`, and `meta/NNNN_snapshot.json`. Two developers generating concurrently
collide on all three.

### Reserved blocks

Claim a block before you generate. Announce it in the team channel and record it here.

| Range | Owner | Track |
|---|---|---|
| 0067–0074 | Divyanshu | Occupation Intelligence Engine |
| 0075–0079 | Prakash | Conversation & Profiling |

Blocks are **advisory in git and load-bearing in practice** — nothing mechanically enforces them,
which is exactly why the rules below matter.

### Rules

1. **Never run `pnpm db:generate` on a branch that is behind `main`.** Rebase or merge first.
   Snapshots chain: each one is the *complete schema state after its migration*, and
   `db:generate` diffs against the **latest** snapshot in the journal.
2. **If a collision has already happened, regenerate — do not renumber.** Renaming the `.sql`,
   editing `idx` in `_journal.json` and renaming the snapshot produces a tree whose migrations
   apply perfectly *and* whose newest snapshot never saw the other branch's tables. The next
   person's `db:generate` then diffs against that stale snapshot and emits a migration
   **re-creating tables that already exist**. Delete your migration, its snapshot and its journal
   entry; re-run `db:generate` on the merged tree; re-apply any hand-edits.
3. **The `when` timestamp in `_journal.json` must stay monotonic with `idx`.**
4. **Verify on a fresh database**, not on your dev one: `pnpm db:migrate` against an empty
   database is the only check that catches an ordering fault.

> **This has already cost us once.** During OIE Phase 8, migrations 0070 and 0071 landed from
> another track inside a reserved block while the phase branch was open. The recovery was a merge
> plus a full regeneration of both migrations — not a rename.

### What drizzle cannot model — hand-append it, and say so

`db:generate` will silently omit these. Each must be appended to the generated `.sql` with a
comment explaining why, or the model and the database disagree in a way no test notices:

- **`NULLS NOT DISTINCT`** (PG15+) on a unique index whose columns are nullable. Without it, an
  upsert's `ON CONFLICT` target stops matching and the "atomic count increment" silently becomes
  "insert a new row every time".
- **`FORCE ROW LEVEL SECURITY`** and the `REVOKE ALL` grants. drizzle models `ENABLE`; without
  `FORCE` the table **owner bypasses every policy** — and the backend connects as the owner, so
  `ENABLE` alone is decorative on the only connection that reads the table.
- **Index creation order** when swapping a unique index that an `ON CONFLICT` depends on: create
  the new one *before* dropping the old one, or writes fail in the window between.

---

## 2. `packages/event-schema/src/{registry,payloads}.ts`

**Append-only, at the end of the registry object.** Never edit an existing entry: payloads are
versioned and never mutated (CLAUDE.md §3). A consumer reading today's shape must keep working.

- A new event is a new name, not a new field on an old one.
- Every payload is `.strict()`, and carries **ids, enums and counts — never free text**. The test
  suite asserts this by adding the field a well-meaning future change would most plausibly add
  (an utterance, a rejected value, a reason string) and expecting rejection.
- The registry has a **count assertion**. Update it in the same commit; it is the guard that makes
  an accidental addition visible in review.
- One developer per day by announcement. Concurrent additions conflict trivially — both sides
  append — but the count assertion will collide, and **the resolution is arithmetic, not
  "take mine"**: count the registry entries and use the real number.

---

## 3. `packages/ai-contracts/src/**`

**Frozen since OIE Phase 0.** Any change requires a joint PR reviewed by both backend owners, and
must be mirrored in the same commit in:

- `apps/ai-service/app/contracts.py`
- the `__fixtures__/*.keys.json` snapshot

`test_contract_parity.py` turns red if one side moves alone. Additive fields must be `.default()`ed
or the parity test fails for the wrong reason.

---

## 4. `packages/db/src/schema/index.ts` (the barrel)

Append-only exports, alphabetical by module. Conflicts are trivial because each developer only
adds a line — resolve by keeping both.

---

## 5. `packages/profiling-lexicon/`

The data is the source of truth; `apps/ai-service/app/profiling/lexicon_data/` is a **byte-identical
mirror** (the ai-service image is built from its own context, so the package does not exist at
runtime in the container).

- Edit `packages/profiling-lexicon/data/*.json`, then run `pnpm lexicon:sync`.
- `pnpm lexicon:verify` is the gate; CI runs it.
- **Regexes must be written in a JS/Python-common subset — explicit character classes, never
  `\d` or `\w`.** JS's `\d` is ASCII-only; Python's is Unicode-aware. This has bitten this repo
  before (`skills.dto.ts` documents the incident).

---

## 6. Before you call a phase complete

From the sprint-plan gate, and it applies to every plan in `docs/sprint-plans/`:

1. **A merged PR is not proof.** Re-derive completion from the plan document: enumerate every
   bullet in that phase's scope, then read the codebase to confirm each one exists and is
   implemented — not declared, stubbed, or asserted in an "AS BUILT" note.
2. **A green CI run is not proof of completeness.** Both sides of a contract test can be equally
   incomplete and still pass.
3. **Verify on `origin/main`, never on the PR.** `git fetch origin`, then read or grep
   `origin/main` for the actual artefact — the migration file, the changed line, the new test.
   Squash-merge collapses only the commits reachable at merge time; a closed PR never tracks
   commits pushed afterwards.
4. **Never commit to a branch whose PR has already merged.** That branch is dead — cut a new one
   from fresh `main`.
5. **A deferral must be logged with an owner and a reason.** Silently dropping a bullet is the
   failure this gate exists to catch.
