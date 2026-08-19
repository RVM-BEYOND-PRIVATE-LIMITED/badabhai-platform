# Phase 9 — the remaining gates, and exactly who can close each

> **Updated 2026-08-19 (second pass).** Three of the five gates below CLOSED this pass, by
> measurement rather than by argument. One new finding outranks all of them and is stated first
> because it is a live production defect, not a gate.
>
> Everything here was read-only against production. No taxonomy row, edge, embedding, flag or
> schema object was mutated.

| # | gate | blocked on | state |
|---|---|---|---|
| **0** | **`0078` is NOT applied to production, and the code that needs it IS deployed** | **owner — one command** | 🔴 **live defect** |
| 1 | Embedding provenance (the "76 NULL `embedding_model`" rows) | nobody | ✅ **CLOSED — proven `gemini-embedding-001`** |
| 2 | `cnc-programming` scope decision | product / taxonomy owner | ⏸ quantified against production; option costs corrected |
| 3 | 11 provider evaluation cases | you — needs a real-call environment | ⏸ runner verified end-to-end; command ready |
| 4 | 5 TD-01 trainer slots | trade trainer | ⏸ **worksheet ready** — `phase-9-trainer-worksheet.md` |
| 5 | TD-07 | product + trainer | ⏸ **worksheet ready**, five options costed |

---

## 0. Migration `0078` never reached production — and the code did

**The state, measured.** `unresolved_phrase` in production has these columns:

```
id, phrase, lang, domain_id, count, first_seen, last_seen, status, embedding, scope
```

No `job_domain_id`. `unresolved_phrase_scope_uq` is still the **four**-column
`(scope, phrase, domain_id, lang) NULLS NOT DISTINCT`. No `unresolved_phrase_one_domain_chk`.
`0076` and `0077` are both applied; `0078` alone is not.

**The code IS on the box.** `9bb12992` (S3-C) is an ancestor of `63b84fad`, `a14b10d2` and
`43ca4bd7`, all of which deployed successfully on 2026-08-19. `SkillsRepository.recordUnresolved`
names `job_domain_id` in the INSERT column list and the `ON CONFLICT` target **unconditionally**.

**So, right now, in production:**

| path | effect |
|---|---|
| `identify.service.ts:499` — the live worker interview | the write throws; the surrounding try/catch logs *"the interview is unaffected"* and continues. **Growth signal silently lost.** No alert, no error rate, no symptom |
| `POST /skills/unresolved` | **500** (no catch in the controller) |
| `POST /occupation/unresolved` | **500** |

`unresolved_phrase` holds **9 rows** (2 skill-scope, 7 occupation-scope) — the same count as
when 0078 was authored. Nothing has been recorded since.

**This is the exact hazard PR #995 was raised to document**, and the note was right: the
ordering requirement is real. What was missing was any way to *ask a database whether it had
the migration*. `drizzle.__drizzle_migrations` does not answer it usefully — production shows
**76 applied rows against 79 files**, because earlier migrations were baselined, so the count
is alarming and meaningless. Object-level presence is the only reliable question.

**Now mechanically checkable** — `pnpm --filter @badabhai/db db:audit:schema-contract`,
read-only, exits non-zero when the target database is behind the code:

```
MISSING  0078…  column     unresolved_phrase.job_domain_id
MISSING  0078…  index      unresolved_phrase_scope_uq        (still the 4-column shape)
MISSING  0078…  constraint unresolved_phrase_one_domain_chk
ready for the code on main? = NO
```

The index entry checks **shape, not existence**: an index of the right name and the old column
list is the dangerous state, because two canonical misses of the same phrase in different job
domains would merge into one row with a summed count, and nothing would error.

**The remedy is one command** — additive, no rewrite, sub-millisecond on 9 rows:

```bash
pnpm --filter @badabhai/db db:migrate      # against production's DATABASE_URL
pnpm --filter @badabhai/db db:audit:schema-contract   # expect: ready = YES
```

---

## 1. Embedding provenance — CLOSED. The 76 rows are `gemini-embedding-001`, proven

**Mock was already ruled out; foreign-model is now ruled out too.** Read-only audit of
production (`pnpm --filter @badabhai/db db:audit:embeddings`):

| | `skill_alias` | `job_domain_alias` |
|---|---|---|
| rows | 98 | 9,121 |
| embedded | 76 | 9,121 |
| PROVEN MOCK (recompute, 768 dims @ 1e-6) | **0** | **0** |
| stamped | 0 | 9,121 — all `gemini-embedding-001` |
| unstamped | **76** | 0 |
| …of those, `embedded_at` NULL too | **76** | 0 |
| dimensions | 768 (uniform) | 768 (uniform) |
| L2 norm | 1.000000 … 1.000000 | 1.000000 … 1.000000 |

**The cause is documented in the runner itself, not inferred.** `embed-skill-aliases.ts` carries
the comment *"`embedding_model` and `embedded_at` have existed since migration 0076 and this
runner left them NULL"*. Stamping began at `a355a3c8` (#900, 2026-08-17). All 76 rows have
`embedded_at` NULL as well as `embedding_model` NULL — the pre-#900 signature exactly, with no
row showing the mixed state (`embedded_at` set, model NULL) that would need a different story.

**Foreign-model was a live possibility, not a theoretical one.** The ai-service default was
`text-embedding-004` at commit `82352313` and became `gemini-embedding-001` at `327b4a2d` — and
`text-embedding-004` is natively 768-dim while `gemini-embedding-001` is 3072 truncated to 768,
so **dimension does not discriminate between them**. A recompute cannot see this: both are
"not mock".

**What settles it.** `taxonomy-embed-cache.ts` records the measured property that the embedder
is deterministic — *"embedding the text of a stored alias reproduces that alias's stored vector
at cosine 1.0000"*. So a known-model vector for the same text is a proof, not an inference. All
76 production texts were compared against the local dev corpus, where the same 295 rows carry an
explicit `gemini-embedding-001` stamp:

```
overlap by text        76 / 76
cosine >= 0.99999      76        (min 0.999999978788, median 1.000000003642)
unrelated-pair control 0.4340 … 0.7831
```

Six orders of magnitude of separation between the match population and the control. Corroborated
independently inside production itself: `job_domain_alias`, written through the same endpoint by
the sibling runner that always stamped, is uniformly `gemini-embedding-001` at 768 dims and L2 1.

**The plain "stamp backfill" I recommended last pass was the wrong shape, and I was wrong to
recommend it.** Writing a model name that is merely believed converts *unknown* provenance into
*asserted* provenance: `corpusBlockReason` stops asking, and the mixed-corpus failure it exists
to catch becomes permanently invisible. The tool built this pass
(`pnpm --filter @badabhai/db db:verify:embeddings`) stamps **only rows proven against a
known-model reference**, refuses wholesale on any mismatch, any mock, or any two-model split,
and leaves `embedded_at` NULL because nobody knows when these were written and inventing a
timestamp is the same fabrication.

Verified plan against production (nothing written):

```
PROVEN        76  (gemini-embedding-001)
worst cosine  1.000000000000   (floor 0.99999)
MISMATCH 0 · NO_REFERENCE 0 · PROVEN MOCK 0
would --apply be allowed? = YES — it would stamp 76 row(s)
```

**Remaining action: one command, and it is now a formality rather than a judgement call.**

```bash
pnpm --filter @badabhai/db db:verify:embeddings \
  --reference-file=<dump of stamped rows> --apply \
  --json=packages/db/data/taxonomy/replay/phase-9-provenance-stamp.json
```

Re-embedding (`db:embed:skills --reset-embeddings`, 76 provider calls) is **no longer needed**
and is now the worse option: it is destructive, and a partial run would drop production below 76
embedded rows.

---

## 2. `cnc-programming` — quantified against production, and the option costs were wrong

**Still not a canonical domain.** 28 `jd_*` job domains exist; `cnc-programming` is a legacy
`skill.domain_id` slug, so the loss below exists only while Path B serves and ends at S10.

**Production holds the PRE-merge state.** `skill_drawing_reading` does not exist there;
`skill_gdt_reading` (under `cnc-machining`) and `skill_cad_interpretation` (under
`cnc-programming`) are both still `active`. So this is a forecast of S3-D, measured on what is
actually deployed.

**Lost under `cnc-programming` at S3-D** — `skill_cad_interpretation`'s 4 aliases:

| alias | lang | embedded? |
|---|---|---|
| `CAD` | en | yes |
| `technical drawing` | en | yes |
| `read engineering drawings` | en | yes |
| `drawing padhna` | **hi** | **no** |

**Surviving under `cnc-programming`** — 3 skills, 10 aliases (8 embedded), none of which is
about reading a drawing: `skill_cam_software` (CAM software, Fusion 360, Mastercam),
`skill_cnc_programming` (CNC programming, part programming, program banana),
`skill_program_editing` (G-code editing, M-code, program editing, program sudharna). Four
`mskill_*` match-vocabulary rows also sit under the slug with no aliases and are unaffected.

**Two corrections to last pass's table.**

1. The real retrievable loss is **3 aliases, not 4** — `drawing padhna` has no embedding, so a
   Hindi speaker asking about drawing reading under this slug is not served *today* either.
   That is a pre-existing coverage hole, not something S3-D creates.
2. **Option B is not "one additive data row."** An alias with no embedding is not retrievable
   (see `drawing padhna`, immediately above). Closing the gap costs one row **plus one provider
   embedding call** — which currently also requires widening `AI_REAL_CALL_TASKS`, exactly as
   gate 3 does.

| option | cost | consequence |
|---|---|---|
| **A — accept the loss** | none | A CNC programmer stops matching `CAD` / `technical drawing` / `read engineering drawings` for the S3-D → S10 window |
| **B — legacy alias row for `skill_drawing_reading` under `cnc-programming`** | one row **+ one embed call** (was mis-stated as row-only) | Closes it for the window. Additive, reversible |
| **C — treat it as moot** | none | Only defensible if S10 is near. **Nobody has dated S10**, so this remains a bet |

Not decided here: B changes taxonomy data, which engineering does not own (CLAUDE.md §16).

---

## 3. The 11 provider cases — runner verified end-to-end; only the environment is missing

Contract unchanged (`phase-9-provider-run-contract.md`). Re-verified today by running the
runner, not by reading it:

```
fixture cases   127
already cached  116
MISSING          11   (reviewed: 11)
DRY RUN — no provider was called.
```

All 11 are REVIEWED cases: `XD-01` `XD-02` `XD-03` `XD-06` `XD-07` `XD-09` `XD-10` `US-01`
`US-02` `US-03` `US-04`. The embed cache holds 228 vectors, all `gemini-embedding-001`.

Verified this pass, beyond "it prints a plan":

- **guards are real** — the runner classifies every response against the local `_mock_embedding`
  reproduction and aborts on the FIRST mock *before flushing*, so an aborted run caches nothing;
- **evidence is append-only** — `--evidence=` refuses to overwrite an existing path;
- **re-running is a no-op** — the missing set is computed from cache hashes, so a repeat run
  after success reports `nothing to do`;
- **records carry no floats** — dimension, L2 norm and a sha256 per vector only;
- **no database is opened** at any point.

**Environment, checked rather than assumed:** no ai-service on `localhost:8000`, no provider key
here, and `docker-compose.yml` pins `AI_ENABLE_REAL_CALLS: "false"` as a hard literal — correct,
it is the dev-laptop file.

**The gate the contract still under-stresses:** embeddings route under `skill_embedding`, and
`AI_REAL_CALL_TASKS` defaults to `profiling_chat_turn` **only**. `AI_ENABLE_REAL_CALLS=true`
alone returns mock and the runner aborts — the guard working correctly. Now pinned by a test:
`deploy-workflow-taxonomy.guard.test.ts` asserts `AI_REAL_CALL_TASKS` is **not** in the deploy
job's `envs:` bridge, so a GitHub secret cannot widen the real-call surface without a code change.

```bash
# On a real-call-enabled environment, NOT this sandbox:
export AI_REAL_CALL_TASKS=profiling_chat_turn,skill_embedding
pnpm --filter @badabhai/db db:embed:replay-queries --apply \
  --evidence=packages/db/data/taxonomy/replay/phase-9-replay-query-vector-provenance.json
export AI_REAL_CALL_TASKS=profiling_chat_turn
```

Then re-run the replay with a NEW `--report=` path. **Expect R@1 to fall** — 0.9912 is measured
over 113 cases with the 11 hardest absent. A drop is the gap closing, not a regression.

---

## 4 & 5. TD-01 slots and TD-07 — worksheet ready

Both now have a trainer- and product-facing document that needs no engineering knowledge:
**`phase-9-trainer-worksheet.md`**.

What was actually blocking TD-01 was not the pack — it has existed since #900 — but that it
identifies trades as `jd_nco_7223_0701`. Nobody can answer "how would a worker in
`jd_nco_7223_0701` describe this?". The worksheet resolves all 12 domains to their trade names
(Quality Inspector, CNC Programmer, Lathe Machinist, Fitter-Fabrication, …), lists the 8 aliases
that must NOT be reused, and carries the competitor and multi-domain questions inline.

TD-07 is stated with its production behaviour measured — bare `"welding"` matches **no** skill
alias today, so nothing is silently resolving to arc welding — and five costed options (generic
parent / flat generic / route to occupation / ask the worker / leave open). Engineering has no
view on which is right; A needs a parent-child concept the schema lacks, D needs an
interview-flow change, and B/C/E are data-only.

---

## What closed since the last update

- **Gate 1 — CLOSED by proof**, not by argument. See §1.
- **New tooling, all read-only by construction:** `db:audit:embeddings` (forensics across both
  vocabularies), `db:verify:embeddings` (prove-then-stamp, no write without proof),
  `db:audit:schema-contract` (is this database ready for the code on main?).
- **R38 — the residual is now understood exactly, and it is worse than "recreate the
  containers".** CD runs `docker compose … --no-deps api`, and `docker-compose.staging.yml`
  states outright: *"NEVER run this overlay with a bare `up -d`: profile-less services
  (postgres/redis/adminer) would still start alongside the api."* So a deploy **never** starts
  adminer or the compose-internal postgres — which means a deploy will never RE-create them with
  the corrected loopback binds either. The containers on the box came from a bare `up -d` and
  will keep their `0.0.0.0` binds **forever** until removed by hand. The merged base-file fix is
  a guard against the next bare `up`, not a remedy for the current exposure. Pinned by
  `deploy-workflow-taxonomy.guard.test.ts`.
- **CD posture pinned by test.** `deploy-lightsail` runs no migration, seed, embed or promotion
  step; those live in the `e2e` job against ephemeral postgres. The guard asserts both halves,
  so it cannot pass vacuously.

## Flags, unchanged

`DOMAIN_MATCH_ENABLED=false`, `SKILL_CANONICALIZE_ENABLED=false`, `AI_ENABLE_REAL_CALLS=true`,
`AI_REAL_CALL_TASKS=profiling_chat_turn` (compose default; not bridged from GitHub). No taxonomy
seed, migration, embedding, edge mutation or flag change has been made in production.
