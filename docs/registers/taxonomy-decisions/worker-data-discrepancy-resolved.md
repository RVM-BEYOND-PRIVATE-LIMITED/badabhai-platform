# The worker-data discrepancy — resolved, and the reason it was possible

**Measured 2026-08-24 · main `d8d61df0` · read-only · production mutation NONE · AI spend ₹0**

Reproduce: read-only `SELECT`s over `_delete_forensics` on a session where
`default_transaction_read_only = on`, as a role with `rolbypassrls = true`.

---

## 0. The discrepancy

Two committed documents asserted worker-side counts that did not reproduce three days later.

| claim | source | measured 2026-08-21 (later) |
|---|---|---|
| `worker_profiles` — 19 of 44 populated | `d1-runtime-path-trace.md` | **1 row, `job_domain_id` NULL** |
| `worker_skill` — 8 rows, 6 workers | same | **0** |
| `job_reach` — 6 rows, 1 posting | same | **0** |
| "a live worker is currently matched to `jd_nco_8155_0201`" | coverage report §3.4 | **0** |

Both documents were dated 2026-08-21. So was the contradicting measurement.

---

## 1. Resolved — MEASURED

`_delete_forensics` holds **311 rows spanning 2026-08-13 → 2026-08-21**, and every one of them
carries the same origin:

```
app_name = supabase/dashboard        (1 distinct value across all 311 rows)
db_user  = postgres                  (1 distinct value across all 311 rows)
```

Totals by table: **223 `workers`**, **88 `worker_profiles`**.

The relevant window is 24 seconds wide:

```
2026-08-21 10:36:39 UTC  ─┐
                          │  164 rows deleted
2026-08-21 10:37:03 UTC  ─┘   119 workers + 45 worker_profiles
```

**D-1 measured 44 profiles. 45 were deleted at 10:36 UTC that same day.**

**INFERRED — and the only reading the evidence supports:** D-1's measurement was taken *before*
that deletion and the D-5 measurement *after*. **Neither document was wrong.** Both were
accurate at the instant they ran, hours apart on the same date, and the date alone could not
distinguish them.

The deletion was a manual operation through the Supabase dashboard. Nothing in this repository
performed it, and nothing about it looks accidental — 164 rows in 24 seconds is deliberate,
consistent with clearing test accounts.

## 2. A hypothesis the evidence refuted

`47ae5d16 feat(api): QA-only POST /auth/account/delete/immediate (gated, immediate hard-delete)`
landed on `main` inside exactly this window, alongside
`aac2c3c8 feat(config): refuse to boot with the immediate-delete seam armed outside dev/test/staging`.

A QA endpoint performing immediate hard-deletes, merged the same day worker rows disappeared,
is an obvious suspect. **It is not the cause.** All 311 forensics rows carry
`app_name = supabase/dashboard`; an API-originated delete would not present as the dashboard.
The endpoint is also gated against booting outside dev/test/staging.

Recorded because a plausible-and-wrong explanation is worth naming — the next reader will form
the same suspicion from the same commit log.

## 3. Why a correct document became misleading

Neither document carried a **time of measurement** or the **query that produced it**. With only
a date, a reader cannot tell which side of a same-day deletion a number sits on — so counts
that were true when written were quoted as current for three days, including by me.

The fix is not a better proofreading habit:

> **An evidence artifact must be able to say when it was true, what it looked at, and whether
> the reader could see the rows.**

**TESTED.** `evidence-provenance.ts` defines that header and
`evidence-provenance.test.ts` walks `docs/registers/` and fails any `kind`-bearing artifact
missing it. All four committed measurement artifacts now carry:

```json
"measured_at": "2026-08-24T…Z",
"source": "pnpm db:audit:junk-labels",
"target": "SUPABASE (remote)",
"read_only": true,
"role": "postgres",
"bypass_rls": true,
"population_predicate": "job_domain.label_en LIKE '%:' OR label_en ~ '^[a-z]'"
```

A second assertion pairs `role` with `bypass_rls`: a role without `BYPASSRLS` reading a
`FORCE ROW LEVEL SECURITY` table returns zero rows, so a reference count is uninterpretable
without both. That is not hypothetical — it is the trap D-5 had to check for explicitly.

**The sweep earned its keep on its first run.** It failed immediately, on
`9b-inheritance-dry-run.json`: that artifact already used the key `source` for its three row
counts, silently clobbering the provenance field of the same name. The counts were renamed
`source_rows`. A convention would not have caught that; a test did.

## 4. What this does NOT establish

- **Why** the rows were deleted. The forensics record who, when, and through what — not intent.
  Not guessed at here.
- Whether anything of value was lost. `workers` and `worker_profiles` are the only tables in
  the forensics log; whether those accounts mattered is a product question.
- Anything about the taxonomy findings in either document. `job_domain` (4,071) and
  `job_domain_alias` (9,121) are untouched, and every taxonomy conclusion in D-1 and the
  coverage report stands.

## 5. Status of the affected documents

**[REC]** Do not rewrite them. They are accurate records of a state that existed. What they
need is the timestamp they lacked, and a pointer here — a historical measurement is evidence,
and editing it to match today would destroy the very thing that made this resolvable.

Their worker-side counts should be read as **"true at some point on 2026-08-21, before
10:36 UTC"**, and re-measured before they justify anything.

---

## 6. Gates and scope

```
RESOLVABLE_ABOVE_FLOOR    FAIL — 62/96      unchanged
NO_REGRESSION             FAIL              unchanged
PROMOTION CANDIDATES      0                 unchanged
```

No production mutation, no gate, floor or baseline touched, no AI call.
