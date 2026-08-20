# Phase 9 — the remaining gates, and exactly who can close each

> **Updated 2026-08-19 (fifth pass).** `0078` **and `0080`** are applied and verified
> object-by-object, so the schema contract reads **`ready for the code on main? = YES`** and
> **S3-C is EXECUTED**. The S3-C read switch is wired end to end (#1024) — every remaining S3-D
> blocker that was engineering work is closed. What remains is two taxonomy judgement calls, one
> product/trainer gap, two host-only actions, and two production writes (adopting the five
> unrecorded journal entries, and the R39 REVOKEs).
>
> Everything read-only was run against production, on cluster `7642734024280108049` — the audit
> prints that id now, because "applied" and "reports missing" can both be true of two different
> databases and nothing in the output used to distinguish them.
>
> The production writes made by the owner — `0078`, `0080`, and stamping 76 `embedding_model`
> values (proven, never assumed) — are recorded below with their evidence.
>
> **Sixth pass, 2026-08-20.** `0081_worker_feedback_screen_context` was merged (`#1036`) and
> applied out of band, which took the migration slot this session was minting into — R39's fix is
> therefore `0082`, and it was **applied on 2026-08-20: 77/77 tables locked, 0 deviating, R39
> closed.** Every open judgement call now has a costed options table in
> **[`phase-9-open-decisions.md`](./phase-9-open-decisions.md)**, re-measured against production
> the same day. The measurement that reframes most of them: **`job_domain_skill` is EMPTY** — 0
> edges against the corpus file's 236 — and the 98-skill Phase-3 corpus those edges point into is
> **0% seeded**. Path A's occupation half is complete (4 071 domains, 9 121 embedded aliases);
> the domain→skill half has never had a row. Production's 51 skills are the wedge corpus (33
> `skill_*` + 18 `mskill_*`, all `active`, no `provisional` rows at all), `worker_skill` holds
> **6 rows** and `job_reach` **4**. Every taxonomy decision below is at its cheapest right now,
> and that window closes at the first seed.

| # | gate | blocked on | state |
|---|---|---|---|
| 0 | `0078` / S3-C | — | ✅ **APPLIED & VERIFIED** — object-by-object, write path exercised |
| 1 | Embedding provenance (76 unstamped rows) | — | ✅ **CLOSED** — proven `gemini-embedding-001`, stamped |
| 2 | `cnc-programming` scope decision | **product / taxonomy owner** | ⏸ **costed, re-measured 2026-08-20** — 11 candidate rows / 4 skills, unchanged. `phase-9-cnc-programming-decision.md` + options table |
| 3 | 11 provider evaluation cases | — | ✅ **EXECUTED**; replay gap closed; harness defect fixed; **US-04 resolved** |
| 4 | 5 TD-01 trainer slots | **trade trainer** | ⏸ worksheet ready. Separately: TD-01's ratified re-point is **corpus-only** — `skill_drawing_reading` is ABSENT from production and `job_domain_skill` has 0 edges, so seeding is its own owner decision (D1/D2/D3) |
| 5 | TD-07 | **product + trainer** | ⏸ **four costed remedies (T1–T4)**; engineering evidence complete. Live blast radius measured: **0 welding rows anywhere** — the fix is free today and acquires a backfill at the first welder |
| 6 | R38 residual | **host-only** | 🔴 open — CD cannot fix it (see below) |
| 7 | Path A miss recording | — | ✅ **CLOSED** (#1024) — `job_domain_id` reaches `unresolved_phrase`; the thresholds' own inputs are now collectable |
| 8 | `0080` applied to production | — | ✅ **APPLIED & VERIFIED** object-by-object, RLS included — see below |
| 9 | **7 tables keep their Data-API grants** (R39) | ~~owner — production write~~ | 🟢 **CLOSED 2026-08-20 — APPLIED.** `0082_rls_lock_seven_tables` (#1037, `cdcf31bd`) went in by hand. `db:audit:rls` now reads **77 tables, 77 locked, 0 DEVIATING**; `db:audit:schema-contract` reads **READY**, all three requirements OK. The gate did its job in both directions — it read **NO** while the fix was merged-but-unapplied, and flipped to YES only when the objects arrived. **One follow-up, hygiene not security:** the apply bypassed `db:migrate`, so `0082` is live and unrecorded — see gate 13 |
| 10 | `EVAL_COVERED` — spec and code disagree | **eval owner** | ⏸ **three costed options (E1/E2/E3)**. The 6 mechanical-only skills are now named and all are ABSENT from production, so the stricter reading blocks **0 live promotions** and costs 6 trainer cases |
| 11 | OIE canonicalization — should the OIE path populate `job_domain_id`? | **product** | ⏸ **three costed options (O1/O2/O3)**. Recommendation on record is the OIE occupation pin; the blocker is that the pin and the canonicalize pass sit on mutually exclusive branches |
| 12 | `#1027` — client-side trade filter reads an internal id as a trade slug | ✅ **routed, and closed the same day** — @RishiBamako, fixed in `54134971` | 🟡 **re-scoped after tracing the render path: NO raw id was rendered anywhere.** `FeedItem.tradeKey` is never displayed; the Applied tab reads a different `trade_key` the API nulls under V1. Backend side complete and pinned. **Two things remain.** (a) `jobMatchesTrades` still matches keywords against an `mskill_*` id's spelling — works by coincidence, untouched by the fix. (b) **#1051:** the fix renders `matched_skill_label`, which `GET /workers/me/applications` does not send, so all **17** live applied-jobs cards lost their trade line — to guard a V1 path holding **0** rows |
| 13 | ~~Five~~ **Six** live migrations unrecorded in the journal (`0076`–`0080`, **and now `0082`**) | **owner — production write** | 🟡 **still not a blocker, and the sixth is the cheap one.** `0081`'s out-of-band apply moved the watermark past the first five, so they are skipped rather than replayed — adoption is their fix, and it is hygiene. `0082` sits **above** the watermark, so `db:migrate` replays it: fifteen permissions statements measured to change nothing (`db:verify:rls-lock` 22/22 PASS against the already-locked production, `nothing-committed` byte-identical), and the journal row lands. Adoption cannot take `0082` — it contains dynamic SQL, which is an unconditional refusal by design |

---

## 8. `0080_worker_feedback` — applied, and verified object-by-object

Applied by the owner on 2026-08-19, out of band like `0076`–`0079`. Verified against the live
database rather than taken on report — `db:audit:schema-contract` now says
**`ready for the code on main? = YES`**, on cluster `7642734024280108049`.

| object | state |
|---|---|
| 6 columns | `id` uuid PK `gen_random_uuid()` · `worker_id` uuid NOT NULL · `category` text NULL · `message` text NOT NULL · `app_build` text NULL · `created_at` timestamptz NOT NULL `now()` |
| `worker_feedback_message_len_chk` | `char_length(message) BETWEEN 1 AND 4000` |
| `worker_feedback_app_build_len_chk` | `app_build IS NULL OR char_length BETWEEN 1 AND 64` |
| `worker_feedback_category_chk` | `category IS NULL OR category IN ('suggestion','problem','other')` |
| FK | `worker_id → workers(id) ON DELETE CASCADE` |
| 3 indexes + PK | `worker_id` · `(created_at DESC, id DESC)` · `(category, created_at DESC, id DESC)` |
| RLS | **enabled + FORCED** |
| REVOKEs | all four confirmed individually — `anon`, `authenticated`, `service_role`, `PUBLIC`. Sole grantee is `postgres` |
| rows | 0 — new table, no backfill, as the migration states |

**The `FORCE`-with-no-policies question, answered.** `FORCE` plus zero policies would deny the
owner too, which would take both surfaces down. It does not, because `postgres` carries
`rolbypassrls = true` — `has_table_privilege` confirms SELECT and INSERT. And this is not a
special case: all five sampled spine tables (`workers`, `worker_profiles`, `chat_messages`,
`unresolved_phrase`, `worker_feedback`) are enabled + forced with **0 policies**, and there are
zero RLS policies anywhere in the schema. "No policies" is the house pattern, not a gap.

**The two keyset indexes match the admin read exactly** — `AdminFeedbackRepository.list` orders
`created_at DESC, id DESC` with an optional `category` equality, which is the first index and
the second respectively.

**The journal is now 5 files behind, all LIVE** (`0076`–`0080`), 0 absent, 0 PARTIAL — confirmed
by `reconcile-migrations.ts`, which depth-checks columns, types, indexes, constraints and RLS
rather than trusting the row count. Nothing is broken by this, and the audit reports it as a
non-fatal note; but **the next new migration will not apply until those five are adopted**, so
adoption is now a prerequisite of any further schema work. Procedure in `MIGRATIONS.md`.

---

## 9. Seven tables keep their Data-API grants — R39 — CLOSED 2026-08-20

**Applied. `db:audit:rls` now reads 77 public tables, 77 fully locked, 0 deviating**, and
`db:audit:schema-contract` reads READY. What follows is the finding as it stood, kept because
the reasoning is what made the fix safe to write.

Found on 2026-08-19 by `db:audit:rls`, a new sweep over **every** public table rather than a
hand-maintained list. 70 of 77 were fully locked; seven were not: `agency_kyc`,
`agency_payout_accruals`, `agency_payout_requests`, `agency_profiles`, `employer_profiles`,
`payer_capabilities`, `payer_member_invites`.

Nothing was watching them: `tests/e2e/rls-spine.e2e.test.ts` is `skipIf`-gated **and** names
none of the seven.

**Not a live leak — all seven are empty, and with zero policies `anon`/`authenticated`
(`rolbypassrls=false`) are denied every row.** The exception is `service_role`, which has
`rolbypassrls = true`: RLS never filters it, so the grant is the only control, and here it is
open where the other 70 revoke it. Latent while the tables are empty; live the moment KYC or
payout rows land.

Full entry, with the per-table remediation, in the risks register as **R39**.

**How it closed, and the one thing it left behind.** The fix is a migration —
`0082_rls_lock_seven_tables` (#1037) — rehearsed against production inside a transaction that
cannot commit (`db:verify:rls-lock`, 22/22 PASS) before it was applied on 2026-08-20. It did
*not* land behind the adoption above, as this section predicted it would: `0081`'s out-of-band
apply had already moved drizzle's watermark past the five unrecorded files, so the ordering
constraint dissolved on its own.

It was applied **by hand rather than through `db:migrate`**, which is the residue. The objects
are live and the journal has no row for them, so `0082` joins `0076`–`0080` as unrecorded — but
unlike those five it sits *above* the watermark, so `db:migrate` replays rather than skips it,
and the replay is measured to change nothing. Tracked as gate 13; hygiene, not security.

A second tool corroborates the lock from the other direction, which is worth more than
re-reading the same catalog twice: `adopt-migrations.ts --only 0082_rls_lock_seven_tables`
reported ten mismatches before the apply, **nine of them the grants**. After it, those nine are
gone and only the dynamic-SQL refusal remains.

---

## 0. `0078` — applied, and verified rather than assumed

The previous pass found `0078` missing while the code that needs it was already deployed. It is
now applied. Verified object-by-object rather than by report:

| object | state |
|---|---|
| `unresolved_phrase.job_domain_id` | `text`, nullable |
| `unresolved_phrase_scope_uq` | `(scope, phrase, domain_id, job_domain_id, lang) **NULLS NOT DISTINCT**` |
| `unresolved_phrase_one_domain_chk` | `CHECK ((domain_id IS NULL) OR (job_domain_id IS NULL))` |
| `unresolved_phrase_job_domain_id_idx` | btree on the FK column |
| FK | `job_domain(job_domain_id)`, `ON DELETE NO ACTION` |
| rows | **9 preserved**, summed `count` 10, `first_seen`/`last_seen` untouched |

`pnpm --filter @badabhai/db db:audit:schema-contract` → **`ready for the code on main? = YES`**.

**The write path was then exercised against the real production schema**, inside a transaction
that was rolled back. Row count and summed `count` were identical before and after, so production
carries nothing from the exercise:

| behaviour | result |
|---|---|
| canonical write (`job_domain_id` set) | upserts — the shape that was impossible before 0078 |
| same phrase, **different** job domain | **distinct row** — the entire point of widening the key |
| repeat of the same (phrase, domain) | dedupes onto one row, `count` increments |
| legacy write (`domain_id` set) | unchanged |
| occupation write (both NULL) | dedupes onto one row — `NULLS NOT DISTINCT` is doing its job |
| both set | refused by `unresolved_phrase_one_domain_chk` |
| bogus `job_domain_id` | refused by the FK |

The 9 rows carry `last_seen` no later than 2026-08-17, which corroborates the previous pass's
finding that nothing was recorded during the window when the column was missing.

---

## 1. Embedding provenance — CLOSED, and stamped

Proven, not assumed: all 76 production texts matched a known-`gemini-embedding-001` reference at
**cosine ≥ 0.999999978**, against an unrelated-pair control of **0.434–0.783**. Applied with
`db:verify:embeddings --apply`, which stamps only rows it proves and refuses wholesale on any
mismatch, mock, or two-model split.

```
PROVEN 76 (gemini-embedding-001) · worst cosine 1.000000000000 (floor 0.99999)
MISMATCH 0 · NO_REFERENCE 0 · PROVEN MOCK 0
stamped 76 row(s). embedded_at left NULL (unknown, and not invented).
```

Evidence: `packages/db/data/taxonomy/replay/phase-9-provenance-stamp.json`.

**Post-stamp state — both vocabularies now pass the corpus gate:**

| | `skill_alias` | `job_domain_alias` |
|---|---|---|
| embedded | 76 | 9,121 |
| stamped | **76** (was 0) | 9,121 |
| unstamped | **0** (was 76) | 0 |
| PROVEN MOCK | 0 | 0 |
| `would --run be allowed?` | **YES** (was NO) | YES |

No vector was touched — 76 embedded before and after, 98 rows before and after. `embedded_at`
stays NULL on all 76 on purpose: nobody knows when they were written, and a fabricated timestamp
would be the same error the whole exercise avoided.

`db:eval:taxonomy --plan` now reports **`would --run be allowed? = YES`**. That refusal had been
standing since the harness was built.

---

## 3. The 11 provider cases — EXECUTED

A real-call environment turned out to be available locally: the provider key was present, and
`apps/ai-service` runs from source. **Nothing in production or GitHub was reconfigured** —
`skill_embedding` was armed only as a process environment variable on a local uvicorn that has
since been stopped.

```
11 provider requests · all NOT_MOCK · dim 768 · |v| 1.0000
cache: 0 hits, 11 provider requests. Flushed.
```

Evidence: `packages/db/data/taxonomy/replay/phase-9-replay-query-vector-provenance.json`.

**Two guards fired on the way, and both were right.**

1. The spend ledger blocked the first attempt (`spend_store_unavailable`, fail-closed) because
   `AI_SPEND_REDIS_URL=redis://localhost:6379` and on Windows `localhost` resolves to `::1` while
   the Docker bind is IPv4-only. Same class as the production `REDIS_URL` incident: a
   structurally wrong value that passes every presence check. Local dev only — no repo file
   changed.
2. The per-request INR ceiling was never the constraint. Projected cost for one text: **₹0.0000625**.

### The replay gap is closed: 127/127, 0 skipped

**And a harness defect was found in the act of reading the result.** The first full-127 run
reported R@1 0.9829 over 117 scored, down from 0.9912 over 113. That drop was **not real**.

`taxonomy-retrieval-eval.ts` defines `COVERAGE_ONLY_CATEGORIES = {"unembedded_shipped"}` and
excludes those cases from Recall/MRR. `taxonomy-alias-experiment.ts` honours it. The fixture says
so per case — US-04's own note reads *"excluded from headline Recall/MRR — reported as its own
category"*. But `path-a-replay.ts`'s `summarizeReplay` split only on `negative` and had **no
notion of coverage-only at all**, so the moment the last four `unembedded_shipped` queries got
vectors they walked into the recall denominator. Three places agreed; the fourth had never been
told.

Fixed (`coverageOnly` threaded from the case category, imported from the one shared set rather
than re-declared) and pinned by 8 tests. Corrected numbers:

| | baseline (116 replayed) | full 127, harness bug | full 127, corrected |
|---|---|---|---|
| cases | 116 | 127 | **127** |
| skipped | 11 | 0 | **0** |
| scored | 113 | 117 | **113** |
| hits | 112 | 115 | **112** |
| **R@1** | 0.9912 | 0.9829 | **0.9912** |
| MRR | 0.9956 | 0.9872 | **0.9956** |
| Path A false positives | 0 | 0 | **0** |
| Path A false negatives | 0 | 1 | **0** |
| coverage reached (Path A) | — | — | **3 / 4** |
| coverage reached (Path B) | — | — | **1 / 4** |

**Retrieval quality did not move.** R@1, MRR and hits are identical to the baseline; the extra 11
cases were never scoring cases. The report now prints `scored` beside R@1, because a recall figure
whose denominator is invisible is exactly how 113 and 117 came to be compared as if they described
the same set.

Corrected report: `phase-9-path-a-replay-FULL-127-COVERAGE-CORRECTED.json`.
The earlier `phase-9-path-a-replay-FULL-127-PRE-PROMOTION.json` is **superseded but retained** —
evidence is not deleted because it turned out to be wrong; it is the record of what the harness
said before the defect was found.

**The three genuine findings from the provider run survive the correction:**

- **Path A's cross-domain isolation holds — 0 false positives across all 10 XD cases**, 7 of
  which had never been scoreable. This is the safety property (a query from a foreign trade must
  return nothing) and it is the strongest single result of the pass.
- **Path B leaks: 2 false positives** on those same cases, where Path A returns nothing. First
  time this has been quantified, and it is an argument for Path A that did not exist before.
- **US-04 — RESOLVED, and it needs no taxonomy ruling after all.** It is not a stale fixture,
  not a wrong TD-02 successor, and not a Path-A scope bug. It is the measurable gap between two
  steps the deployment plan already orders adjacently.

  The chain, each link checked:

  | | evidence |
  |---|---|
  | `skill_dimensional_inspection` holds the alias `"dimensional inspection"` | `SKILL_CORPUS`: aliases `["inspection", "dimensional inspection", "quality check"]` |
  | TD-02 deprecates it into `skill_quality_control` | corpus `status: "deprecated"`, `replacedBy: "skill_quality_control"` |
  | the successor never received the alias | `skill_quality_control` aliases are `["QC", "quality control"]` only |
  | that is BY DESIGN, not an oversight | the TD-02 record: re-homing alias rows is *"the separate, later, explicitly-gated step"* `db:retag:skills` |
  | which the plan already schedules | `phase-9-s3-deployment-plan.md`: step 1 is the 4 deprecations, **step 2 is `db:retag:skills`** |
  | and which has not run anywhere | production has **0** rows with `status='deprecated' AND replaced_by IS NOT NULL` |

  **Production today is unaffected**: `skill_dimensional_inspection` is still `active` with its
  alias embedded, so the query resolves correctly right now. The replay was forecasting the
  window *after* the deprecations land and *before* the retag runs.

  **Now measurable rather than argued.** A fourth replay variant, `aliases_retagged`, applies
  what `db:retag:skills --apply` does — move each deprecated skill's aliases to its terminal,
  resolving chains, excluding dead ends and cycles fail-safe, and dropping a copy the terminal
  already owns (the runner's `ON CONFLICT DO NOTHING`). Result:

  | variant | Path A coverage | R@1 |
  |---|---|---|
  | `as_applied` (deprecations only) | 3 / 4 | 0.9912 |
  | **`aliases_retagged`** (+ step 2) | **4 / 4** | 0.9912 |

  It moves **8** aliases, including `"dimensional inspection" → skill_quality_control`. Recall
  does not move; the coverage gap closes. Forecast:
  `phase-9-path-a-replay-RETAG-FORECAST.json`.

  **The one thing worth an owner's attention** is ordering, not taxonomy: steps 1 and 2 must
  land together. Between them the corpus is in exactly the state the replay showed, and any
  measurement taken in that window will read as a regression that is not one.

---

## 2. `cnc-programming` — quantified, still a taxonomy decision

> **The full package is now `phase-9-cnc-programming-decision.md`** — one page, costed both
> ways, with the measurement that reframes it: **no live caller can scope a query to
> `cnc-programming`.** Every production path hard-codes `cnc-machining` or supplies a `jd_*` id
> that nothing populates, and `SKILL_CANONICALIZE_DEFAULT_DOMAIN` is not bridged into the deploy
> at all. The loss is real in the data and unobservable in traffic. The summary below stands.

Production holds the PRE-merge state (`skill_gdt_reading` and `skill_cad_interpretation` both
`active`; `skill_drawing_reading` does not exist there), so this is a forecast of S3-D measured on
what is deployed.

**Lost under `cnc-programming` at S3-D** — `skill_cad_interpretation`'s 4 aliases: `CAD` (en,
embedded), `technical drawing` (en, embedded), `read engineering drawings` (en, embedded),
`drawing padhna` (**hi, NOT embedded**).

**Surviving** — 3 skills, 10 aliases (8 embedded), none about reading a drawing:
`skill_cam_software`, `skill_cnc_programming`, `skill_program_editing`.

| option | cost | consequence |
|---|---|---|
| **A — accept the loss** | none | A CNC programmer stops matching drawing-reading phrases for the S3-D → S10 window |
| **B — legacy alias row under `cnc-programming`** | one row **+ one embed call** | Closes it. Additive, reversible |
| **C — treat it as moot** | none | Only defensible if S10 is near. **Nobody has dated S10** |

Two corrections still standing from the previous pass: the retrievable loss is **3, not 4**
(`drawing padhna` has no embedding, so Hindi is unserved there today), and **B is not one data
row** — an unembedded alias is not retrievable, so it costs a row *plus* an embedding call.

---

## 4 & 5. TD-01 slots and TD-07 — worksheet ready

**`phase-9-trainer-worksheet.md`** — trade names for all 12 domains, the 8 aliases that must not
be reused, the competitor questions, and TD-07 costed five ways. Every slot deliberately empty.

---

## 6. R38 — the residual is host-only, and CD cannot reach it

Sharpened this pass and it is worse than "recreate the containers": CD runs
`docker compose … --no-deps api`, and `docker-compose.staging.yml` states outright that a bare
`up -d` is what would start the profile-less `postgres`/`adminer`. **No deploy ever starts them,
so no deploy will ever re-create them with the corrected loopback binds.** The merged base-file
fix guards the next bare `up -d`; it is not a remedy for what is running now.

Pinned by `deploy-workflow-taxonomy.guard.test.ts`, which asserts the `--no-deps api` invariant so
this reasoning cannot silently stop being true.

---

## S3-D readiness — what an adversarial sweep found

Four lenses were run over the S3 plan, the harness family, the `cnc-programming` option and the
trainer worksheet, with each serious finding independently refuted-or-confirmed. What survived:

### Closed in this pass

| finding | state |
|---|---|
| `path-a-replay` scored coverage-only cases in Recall | **fixed** — R@1 back to 0.9912 over 113, 8 tests |
| `retag-skills` destroyed paid embeddings on deterministic-id collision | **fixed** — `onConflictDoUpdate` guarded by `isNull(embedding)`, 8 tests |
| **P1 had no runnable implementation** | **built** — `db:verify:path-b-parity`, 17 tests, baseline captured |
| trainer worksheet: 4 factual errors + a DC-18 leak | **fixed** — revision 2 |

**P1 is now an assertion, not a promise.** It was the load-bearing safety property of the whole
S3 sequence — *"Path B's result set before vs after must be unchanged"* — and it was verified by
reading migrations and reasoning about them, which is exactly the check that already failed once
this phase. The verifier digests each legacy slug's candidate set under the exact
`legacyAliasRows` predicate (pinned against the repository source by test), so a match proves
every Path B answer to *every possible query* is unchanged — a stronger statement than replaying
a fixture, and one that needs no provider call.

Pre-S3 baseline captured from production: **10 slugs, 76 candidate rows**,
`phase-9-path-b-parity-BASELINE-PRE-S3.json`. Re-run with `--against=` after any stage.

### Open, and each one blocks or weakens S3-D

| # | finding | why it matters |
|---|---|---|
| 1 | **S3-D has no rollback procedure** beyond four lines of prose — no script, no manifest, no rehearsal | the stage that changes live retrieval is the one with no tested way back |
| 2 | **`--preserve-existing-status` does not exist** in `seed-skills.ts` | S3-A is specified in terms of a flag nobody wrote, so the stage S3-D is gated on cannot be run as designed |
| 3 | **4 of 5 S3-D abort thresholds have no instrument**, and the S3-C dual-read shadow they were to be derived from was never built | the thresholds are inherited numbers with nothing to measure them against |
| 4 | **The worker/profile caller has no read switch** — `apps/ai-service/app/routers/profile.py` is hard-pinned to the legacy anchor slug | S3-D's "everything is tied to the switch" property does not hold for that caller |
| 5 | `db:retag:skills` guards on `NODE_ENV`, not on the database host | the guard that stopped me reading production is the right guard keyed on the wrong thing |

Items 2 and 5 are engineering-safe and small. Item 1 is engineering-safe but not small. Items 3
and 4 need a design decision about what S3-C's shadow actually is before they can be built.

### Harness-family defects, none blocking

`isScoreable` / `pending_review` is honoured by 2 of 5 fixture consumers; `COVERAGE_ONLY_CATEGORIES`
still has a private duplicate in `taxonomy-alias-experiment.ts` and a bare string literal in
`taxonomy-floor-sweep.ts`; `--k` is validated in 1 of 5 harnesses; "which skills the fixture
covers" is computed two incompatible ways; `promote-skills.ts`'s `EVAL_COVERED` gate admits the
39 mechanical cases its own spec excludes. All are the same shape as the coverage-only defect
fixed above — a rule defined in one module and re-implemented or omitted in another — and the
`promote-skills` one makes a live promotion gate **weaker** than specified.

## Flags, unchanged

`DOMAIN_MATCH_ENABLED=false`, `SKILL_CANONICALIZE_ENABLED=false`, `AI_ENABLE_REAL_CALLS=true`,
`AI_REAL_CALL_TASKS=profiling_chat_turn` (compose default; not bridged from GitHub — asserted by
test). No taxonomy seed, no `job_domain_skill` mutation, no edge change, no flag change, no TD-07
decision, no invented trainer ground truth.

## The next gate

With `0078` applied, provenance closed and the replay gap shut, the next Phase-9 activation gate
is **S3-D** — and it is now blocked on exactly two things, both human:

1. the `cnc-programming` A/B/C decision (§2), and
2. a ruling on **US-04** (§3) — whether TD-02's merge target or the fixture is wrong.

Neither is engineering's call. Everything mechanically checkable ahead of S3-D is green.
