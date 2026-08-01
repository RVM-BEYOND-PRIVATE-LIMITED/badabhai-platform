# Migration-readiness fix pass — 2026-08-01

Documentation + verification-tooling fixes for the Matching V1 train, from the readiness
audit. **Uncommitted working-tree changes** — 5 files, +394/−45.

## Confirmations

- **No migration was applied to any database.** Nothing was executed against Postgres at all:
  no `db:migrate`, no `psql`, no `drizzle-kit`. Docker is not running locally and the root
  `DATABASE_URL` (which points at the real Supabase project) was never read or used.
- **No production config touched.** `MATCH_V1_ENABLED`, `AI_ENABLE_REAL_CALLS`, `packages/config`,
  every `.github/workflows/*`, and all docker/compose/deploy files are untouched — verified by
  `git diff --name-only`.
- **No DDL logic or intent changed.** All three migration edits are comment-only. Verified
  mechanically: `git diff` filtered to non-comment lines returns empty for 0053, 0056 and 0059,
  and `statement-breakpoint` counts are unchanged (18 / 13 / 1).
- **The P0-9 rehearsal was not attempted.**

## Gates

| Gate | Result |
|---|---|
| `tsc -p tsconfig.json --noEmit` (`@badabhai/db`) | **pass** (exit 0) |
| `eslint packages/db/src/verify-match-v1.ts` | **pass** (exit 0) |
| `vitest run` (`@badabhai/db`) | **pass** — 5 files, 61 tests |
| New boost predicate, simulated against real deparse forms | **4/4 correct** (see Fix 1) |

---

## Fix 1 — 0059's verify false-negatives a correct migration

**Premise confirmed:** `grep -niE 'boost|pg_constraint' packages/db/src/verify-match-v1.ts`
returned nothing — the script had zero coverage of the boost tables.

- [matching-v1-migration-runbook.md:445-476](../ops/matching-v1-migration-runbook.md) — replaced the
  expectation. It previously told the operator to expect
  `CHECK ((tier IN ('all_candidates','boost_7','boost_15','boost_30')))`. Because `tier` is `text`,
  the parser rewrites the `IN` list into a `ScalarArrayOpExpr` and `pg_get_constraintdef` deparses
  it as `= ANY (ARRAY['all_candidates'::text, …])`. There is no deparse path that re-emits `IN`, so
  **a correctly-applied 0059 could never match the documented string.** The section now states the
  real literal, explains why, and supplies a formatting-independent `all_four_codes_present`
  assertion instead of an eyeball comparison.
- [verify-match-v1.ts:357-396](../../packages/db/src/verify-match-v1.ts) — new section
  **`I. boost tier CHECK (migration 0059)`**. Queries `pg_constraint` for
  `posting_boosts_tier_chk` on `public.posting_boosts`; fails loudly if the constraint is absent
  (0059 not applied → every boost purchase will violate it once the flag is on), and fails naming
  the specific missing codes if it finds the pre-0059 narrow form. Asserts on content, not text.

**Verification of the predicate** (it cannot be run against a DB here — see Residual): simulated
against four constraint-definition forms — post-0059 real deparse → PASS; pre-0059 narrow → FAIL
listing `boost_7, boost_15, boost_30`; hypothetical `IN` form → PASS; partial widening missing
`boost_30` → FAIL naming it. 4/4 as intended, including both failure directions.

## Fix 2 — 0053's rollback destroyed data the doc called safe

**Premise corrected — worth reading.** The brief states "the live path writes `source='interview'`
rows directly (see `worker-skills.service.ts:138`)". Line 138 is inside a doc comment; the method
itself is [`setWants` at :142](../../apps/api/src/match/worker-skills.service.ts), an **unwired seam
that throws** ("the wants-toggle endpoint is out of scope"). A repo-wide grep for writers of
`source` finds only `derived_coarse` (`worker-skills.repository.ts:116`, `backfill-worker-skills.ts:192`).
**So no code writes `interview` or `ops` today** — the hazard is real but *latent*, arriving the day
the wants-toggle ships. That makes a scoped-safe rollback achievable rather than impossible, which
is the outcome the brief hoped for.

- [matching-v1-migration-runbook.md:216-256](../ops/matching-v1-migration-runbook.md) — 0053's rollback
  is now **check-first and conditional** (same shape as 0056/0059): run
  `SELECT count(*) FROM worker_skill WHERE source <> 'derived_coarse';` first. At `0` the unscoped
  `DROP TABLE` is genuinely free. Above `0` it destroys unrebuildable data, and the scoped form
  (`DELETE … WHERE source = 'derived_coarse'` + `TRUNCATE worker_industry_tenure`) is given instead,
  with an export path and an explicit statement that reversing the DDL is no longer available.
  A callout records *why* the count is zero today and what changes it.
- [0053_worker_skills_and_tenure.sql:21-46](../../packages/db/migrations/0053_worker_skills_and_tenure.sql) —
  header rewritten to the same conditional form (was: "fully reversible — the data is 100%
  re-derivable by re-running D2").
- §6 row for D2 and §7 item 5 corrected — see Fix 6.

## Fix 3 — D4's verify had nothing to compare against

- [matching-v1-migration-runbook.md:30](../ops/matching-v1-migration-runbook.md) — new pre-flight row
  **0.9**: capture `count(*) FROM applications WHERE job_id IS NOT NULL` and write it down.
- [matching-v1-migration-runbook.md:735-780](../ops/matching-v1-migration-runbook.md) — D4 now repeats the
  capture instruction (for operators who skipped 0.9), and its expectation reads
  "`legacy_apps_intact` = the `legacy_apps_baseline` you wrote down — byte for byte, not 'about the
  same'". Also added **`repointed_rows`** (`job_id IS NOT NULL AND job_posting_id IS NOT NULL`), which
  asserts the same "coexist, never repoint" guarantee **without needing a baseline**, so the check
  still works if the capture was missed. The doc is explicit that this is the weaker of the two
  (it catches repointing but not deletion) and that both should be run.

**On the "harder than described" clause:** it wasn't, but I made a deliberate choice worth stating.
The brief allowed "a file, a temp table, whatever fits this project's existing pattern". A temp table
does not survive across `psql` sessions, and a real table would be a schema change — i.e. another
migration — for a value that lives one maintenance window. This runbook's existing pattern for
cross-step state is operator-held paper (the 0.1 restore-point timestamp, the 0056 rollback window),
so I followed it and said so in the doc rather than inventing durable state.

## Fix 4 — D6 verify + conditional irreversibility

- [matching-v1-migration-runbook.md:852-899](../ops/matching-v1-migration-runbook.md) — verify gains
  **`granted_total`** vs **`granted_total_expected`** (total credit value written = 50 × payers; a
  count alone cannot catch a wrong-but-uniform `delta`) and **`payers_without_grant`** (`grants = payers`
  is satisfiable by two grants to one payer and none to another; this pins it per-payer). Existing
  `balance_divergence` retained as the balance-reflects-ledger check. Notes to substitute the real
  `free_unlock_credits` if D1 seeded something other than 50.
- Rollback re-headed **CONDITIONAL**, with the spend check moved *above* the SQL block (it was a
  trailing footnote after it), plus "reconcile forward instead" guidance for the non-zero case. The
  now-duplicated trailing check was removed. Added to §7 as item 9.

## Fix 5 — D3's rollback discards human work

- [matching-v1-migration-runbook.md:690-724](../ops/matching-v1-migration-runbook.md) — rollback re-headed
  **LOSSY**, stating plainly that re-running D3 does not restore hand-resolved worklist entries —
  *the same `WHERE` guard that makes it safe to re-run is what makes it unable to repair* — so the
  ops hours are gone permanently even though the mechanical half is reproducible. Adds an `at_risk`
  query to size the loss before acting, and a time-scoped rollback form.
- **A trap I introduced and then fixed:** the scoped form filters on `updated_at <= '<T_after_D3>'`.
  I verified `job_postings.updated_at` exists (it does — in the original `CREATE TABLE`) *and* that
  it is actually maintained: D3 stamps it on both its writes (`backfill-job-postings-v1.ts:107,159`)
  and the app's update paths set it. But because D3 stamps rows *as it writes*, a **start**-of-run
  timestamp puts D3's own rows on the wrong side and the rollback matches nothing. The doc now
  carries an explicit warning that `<T_after_D3>` is the time taken *after* the run exits.

## Fix 6 — §7 rewritten as a complete inventory

[matching-v1-migration-runbook.md:955-1041](../ops/matching-v1-migration-runbook.md). The "exactly three"
framing is gone, replaced by a split between **unconditional** doors (already shut once the API ships)
and **conditional** ones (open now, shut when a named row appears) — the distinction that actually
matters, since the check telling you which side you are on takes a second and the recovery does not
exist. Ten items, each with mechanism-level detail matching the depth the `job_id` case already had:

1. `applications.job_id` NOT NULL — now explains *why backfilling is not an escape hatch* (natively
   created postings have no `jobs` row; `applications_worker_job_uq` collides on converted ones), the
   load-bearing fact the old text omitted.
2. The snapshot itself — names all three disposable sources, and notes the hazard opens by *delaying*
   0056, not applying it.
3. **New** — dropping the snapshot columns during 0056's own rollback (see Fix 7).
4. **New** — the `ON DELETE CASCADE`, as a *live-operations* hazard: deleting any posting destroys its
   applications, with no prompt and no event. "Close a posting; never delete it."
5. **New** — `worker_skill` rebuildable only for `derived_coarse` (Fix 2).
6. **New** — D3's human-resolved edits, explicitly categorised as *lossy* rather than
   destructive-of-referenced-data (per the brief's own framing).
7. **New** — 0059, conditional on no row using a new tier.
8. **New** — 0058's payment tables, once real orders exist.
9. **New** — D6, once any granted credit is spent.
10. D4's `jobs → closed`, now cross-referenced to the item-4 cascade.

Every conditional item carries its one-line check query. The closing "genuinely rebuildable" list now
explicitly names what was **removed** from it (`worker_skill`, the human-resolved portion of
`match_skill_ids`), so a reader of the old version sees the change rather than skimming past it.
[§6:939-940](../ops/matching-v1-migration-runbook.md) — the D2 and D3 rows now distinguish "safe to
re-run" from "its output is the whole table" / "re-running restores a rollback", which is the exact
conflation that made the old §7 wrong.

## Fix 7 — 0056 header guard scope + cascade

[0056_applications_v1_snapshot.sql:23-44 and :64-90](../../packages/db/migrations/0056_applications_v1_snapshot.sql).

- Deleted the false sentence "Everything else in this migration (the columns, the indexes, the checks)
  drops cleanly at any time" and replaced it with an explanation of why that is true structurally and
  false about the data. The rollback list is now headed **"GATE 0 FIRST. THE GATE APPLIES TO EVERY
  STATEMENT IN THIS LIST"**, is segmented (structurally-reversible statements first, then the five
  snapshot `DROP COLUMN`s, then `job_posting_id`, then the `SET NOT NULL`), and each destructive
  segment carries its own inline `⚠️ GATE 0 APPLIES` marker. The final line is annotated as "the only
  statement that FAILS LOUDLY on its own — by which point everything above has already been destroyed",
  which is precisely the trap the old layout set. Added: "Do not start the list 'to see how far it
  gets': the destructive statements are the ones that SUCCEED."
- Added an `ON DELETE CASCADE` block to the header as a live-operations hazard, matching §7 item 4.

## Fix 8 — pre-flight §0.4 and the numbering off-by-one

- [matching-v1-migration-runbook.md:76-93](../ops/matching-v1-migration-runbook.md) — §1.1 now returns the
  **head**, not a count: `select id, created_at … order by created_at desc limit 1`, with the expected
  value `1785312915314` (= `0051_mighty_jigsaw`) stated inline. Explains that
  `drizzle.__drizzle_migrations` has no `tag` column, so `created_at` *is* the identifier, and why a
  count cannot distinguish a correct chain from one that skipped a migration and applied an extra.
  The count is retained as a secondary check.
- [matching-v1-migration-runbook.md:118](../ops/matching-v1-migration-runbook.md) — `0051_mighty_jigsaw |
  1785312915314` added to the `created_at` mapping table (value read from `_journal.json` idx 51), so
  the head check resolves without opening the journal by hand.
- **Numbering reconciled in the runbook, not by renumbering seven files.** The brief offered either
  option; editing 0052/0054/0055/0057/0058 headers would have gone outside the stated file scope
  (0053, 0056, 0059 only), so I took the documentation route:
  [matching-v1-migration-runbook.md:62-71](../ops/matching-v1-migration-runbook.md) adds a §1 note
  explaining that 0059 is an addendum outside the original 7-step numbering, and
  [0059_boost_tiers_widened.sql:3-8](../../packages/db/migrations/0059_boost_tiers_widened.sql) — which *is*
  in scope — now says so in its own header.

---

## Residual — read before the rehearsal

1. **The new `I.boost_tier_chk` has never executed against a database.** Its predicate is proven
   against the real deparse forms and it type-checks and lints, but the SQL round-trip is unexercised:
   `db:verify:match-v1` is **not wired into any CI workflow** (grep over `.github/workflows/` returns
   nothing), Docker is unavailable locally, and the only real DB is the production Supabase project.
   Its first real execution will be when an operator runs it. Wiring `db:verify:match-v1` into the CI
   e2e job — which already builds a fully migrated ephemeral Postgres — would close this cheaply, but
   that is a workflow change and therefore outside this pass's scope.
2. **Editing these files changes their sha256.** Harmless now (nothing persistent has applied them, and
   Drizzle computes the hash at apply time), but it is exactly why this had to happen before the first
   real apply. The Path-B bookkeeping snippet computes the hash from the file at run time, so it stays
   correct. **After this pass, treat 0052–0059 as frozen.**
3. **Unchanged and still true:** §9's "NOT verified" block — D1–D4 have never been executed, 0059 has
   never been applied anywhere (§9 still says the chain "0001 → 0058" applied cleanly), and no duration
   in the document is a measured number. This pass fixed the *instructions*; it did not add rehearsal
   data, which is what P0-9 is for.
