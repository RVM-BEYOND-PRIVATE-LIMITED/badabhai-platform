# Implementation Plan — Payer + Agency to Alpha

**Ship target:** Alpha — real users, mock money.
**Owner:** Prakash (all workstreams, per the 2026-08-11 ruling).
**Architecture:** one role-scoped app (`apps/payer-web`); no split.

> **Phase 0 is not optional.** 10 of 17 audit dimensions did not run. Building on a
> 7-dimension audit means building on unknown security and contract risk. Phase 0 closes the
> audit; Phase 1 acts on rulings; only then does code change.

---

## Dependency order

The order below is derived from the codebase, not from the generic template. Two constraints
drive it:

1. **Tenancy before Team.** `GAP-FE-01` (the `getOrgRole` stub) looks like a one-line fix and is
   not. `PAY-DB-01` means opening the gate yields empty pages. And `GAP-AUTHZ-01` means the
   backend money routes lack an Owner gate — so org tenancy landing *without* that fix converts a
   latent issue into a live P0. These three move together or not at all.
2. **Login before anything verifiable.** `GAP-LOCAL-01` blocks every local E2E. Until a developer
   can log in as a payer, no flow can be checked by anyone.

---

### Phase 0 — Close the audit (blocking)

| Task | Detail | Done when |
|---|---|---|
| **0.1** Resume the audit workflow | Apply the `.catch(() => null)` fix documented in `AUDIT_STATUS.md` first — a verifier failure currently destroys a successful finder's results. Then resume from `wf_4b76d4f5-033`; completed agents replay free | 10 missing dimensions have documents |
| **0.2** Prioritise if budget-constrained | Order: `authz-security` → `business-flows` → Server Action/route detail → `api-contracts` → `state-machines` | — |
| **0.3** Migration reality check | `SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at` per environment | Applied state recorded per env |
| **0.4** Flutter + ops/admin scope | The two explores that died: `apps/payer-app` consumer audit, sole-consumer route audit | Documented |

**Complexity: Medium.** Mostly model spend, little human time.

---

### Phase 1 — Owner rulings (blocking, no code)

Seven decisions from `GAP_REGISTER.md` §Open questions.

| Ruling | Status |
|---|---|
| **Tenant = org or payer?** | ✅ **RULED 2026-08-11 — ORG-AS-TENANT.** Phase 3 proceeds as scoped, gated on Phase 0.1 |
| Agency/employer shared posting surface (`GAP-FE-06`) | ⏸ Deferred this pass |
| Faceless-rails FK posture (`PAY-DB-03`) | ⏸ Deferred this pass |
| One-active-plan-per-posting (`PAY-DB-10`) | ⏸ Deferred this pass |
| Subscription / recurring billing | ⏸ Deferred this pass |
| Notifications · saved searches · analytics · audit history · pipeline scope (`PAY-DB-15/16`) | ⏸ Deferred this pass |

The six deferred rulings block **no** Phase 0/1 work. Re-surface them once `authz-security` and
`business-flows` complete — several may sharpen or resolve themselves once those dimensions run.

**Complexity: Small** (time), **Critical** (impact).

### Migration reconciliation — ✅ RESOLVED 2026-08-11

**Not a hypothetical check any more — it ran, and the answer inverts the assumed risk.**

Tooling: `packages/db/reconcile-migrations.ts` (read-only by construction — SELECTs against
catalog views only, no `--apply` path, no DDL). Target:
`aws-1-ap-south-1.pooler.supabase.com / postgres`.

| | |
|---|---|
| Journal entries (repo) | 74, contiguous `0000–0073`, no gaps |
| Recorded in `drizzle.__drizzle_migrations` | **47** |
| **Unrecorded** | **27** — not 14 |
| ├─ unrecorded but **fully live** (needs adoption) | **27** |
| ├─ genuinely **pending** (objects absent) | **0** |
| └─ **partial** (dangerous mixed state) | **0** |

**Every unrecorded migration is already fully applied.** The database schema is at the repo's
head; it is the *bookkeeping* that is behind, not the schema.

Three of the 27 (`0031`, `0049`, `0059`) are constraint-only and invisible to an object-based
checker; they were verified directly and all pass — `unlocks.worker_id`,
`resume_disclosures.worker_id`, `invites.inviter_worker_id` are all nullable (0031);
`push_deliveries_status_chk` and `posting_boosts_tier_chk` both carry their widened value sets
(0049, 0059).

#### Three consequences

1. **`0062_harsh_stepford_cuckoos` is LIVE.** The `PAY-DB-02` worst case — every payer
   job-posting read 500-ing on a missing `previous_status` column — **is refuted**. Severity
   drops from P1 to P3 (a bookkeeping defect, not a runtime one).
2. **Phase 3's backfill assumption HOLDS.** Eight unrecorded migrations touch `org_id` target
   tables (`0048`, `0050`, `0051`, `0054`, `0058`, `0060`, `0062`, `0068`) — all of them
   complete, none drifted. The `org_id` backfill will not run against a false premise.
3. **`pnpm db:migrate` is nonetheless completely blocked.** It reaches `0048` — the first
   unrecorded migration carrying DDL — and dies on "already exists", so **the `org_id` migration
   cannot be applied at all** until the journal is reconciled. *This*, not drift, is the real
   gate on Phase 3.

#### ✅ Task 0.3 — COMPLETE on production, 2026-08-11

Executed directly against production per owner instruction (the staging-first step was waived).
Sequence actually run, each step verified before the next:

1. **Pre-flight** (`--doctor`, read-only): connection role `postgres`, `bypassrls=true`,
   not superuser; all 7 un-forced tables owned by that same role. This is what made the next step
   provably safe — `FORCE` cannot lock out a `bypassrls` connection.
2. **Completed migration `0048`** (`--force-rls-for 0048_empty_archangel --apply`): applied the
   three `FORCE ROW LEVEL SECURITY` statements that migration declares and had never been
   applied. Scope derived from the `.sql` file itself, so it could not creep — the other 4
   un-forced tables belong to no migration and were deliberately left alone.
   Verified: all three `forced=true`.
3. **Re-verified** all 27 at full depth → **27/27 clean, 0 mismatched**.
4. **Adopted** (`--apply --expect-host …`): 27 journal rows inserted in one transaction.
5. **Verified three ways** — the independent `reconcile-migrations.ts` reports **74/74 recorded,
   0 unrecorded**; the `org_id` target check reports the Phase 3 backfill assumption holds; and a
   sha256 check confirms **74/74 journal hashes match**, so `pnpm db:migrate` will skip every
   migration without attempting DDL.

`GAP-DB-19` is **closed**. `GAP-DB-20` is **partially closed** (3 of 7). The org-as-tenant
migration is no longer blocked.

> **Still owed:** the same reconciliation against **staging**, which has never been checked and
> may be in a different state. Do it before the next deploy.

#### Task 0.3 (original scoping, retained for the record) — adopt the 27

Generalize `adopt-0066.ts` into an all-migrations adopter: for each unrecorded migration, verify
the live schema matches what it would have created (columns **and types**, indexes, RLS —
`adopt-0066.ts`'s depth, not this script's object-presence heuristic), then record the journal row
without re-running the DDL. **Refuse on any mismatch** — adopting a migration whose effects are
only partly present would hide real drift from every future migration, permanently.

**Caveats that must not be lost:**
- This covers **one** environment. The same reconciliation must run against the other before any
  deploy — a different environment may be in a genuinely different state.
- `reconcile-migrations.ts` checks tables, columns and indexes. It does **not** verify
  constraints, RLS, REVOKEs, data backfills or DROPs. "LIVE" means *its objects exist*, not
  *every effect was applied*. The adopter must close that gap per migration.
- A parser bug in the first run produced three false `PARTIAL` verdicts (a non-greedy span
  crossed statement boundaries, pairing one statement's table with a later statement's column).
  Fixed and documented in the script. **The lesson generalizes: a regex over SQL must never cross
  a `;`.**

---

### Phase 2 — Unblock verification

Nothing here changes product behaviour; everything here makes behaviour checkable.

| Task | Detail |
|---|---|
| **2.1** Payer test-login seam | Mirror `apps/api/src/auth/test-login.guard.ts`: neutral-404 unless enabled, HMAC token ≥32 chars, boot-refused in production. **One fix, two problems** — also un-skips the e2e suites |
| **2.2** Verify/wire local email OTP | Confirm `EMAIL_PROVIDER=smtp` ↔ Mailpit (`GAP-LOCAL-01`). Document the real steps |
| **2.3** Un-skip the payer e2e suites | `payer-tenancy`, `phase1-flow`, `payer-capacity`; fix `tests/e2e/helpers/payer-session.ts` (still assumes the removed `dev_otp` echo) |
| **2.4** Seed a usable tenant | A payer + agency + postings + workers + one application, so the portal isn't empty |
| **2.5** Boot-time migration assertion | Read `drizzle.__drizzle_migrations`; fail startup below the required tag. Turns a confusing 500 into a clear message (`PAY-DB-02`) |

**Complexity: Medium.** Highest leverage in the whole plan — every later phase is unverifiable without it.

---

### Phase 3 — Tenancy (P0) — ✅ RULED: ORG-AS-TENANT, gated on Phase 0.1

**Land as one coordinated sequence.** 3.2, 3.3 and 3.4 must ship together — see the
partial-migration hazard in `GAP_REGISTER.md` §Open questions 1.

| Task | Detail |
|---|---|
| **3.1** Red test first | e2e: payer A invites B; B must see A's postings + credits. Land it **failing** — it is the definition of done |
| **3.2** Migration | `org_id uuid REFERENCES payer_orgs(id)` on the 19 business tables + backfill from `root_payer_id` + `(org_id, created_at DESC)` per table |
| **3.3** Predicate rewrite | Every owner-scoped WHERE from `payer_id = $session` → `org_id = $sessionOrg` |
| **3.4** Backend Owner gates | `@OrgRoles("owner")` on `/payer/credits/*` and the spend paths — **in this same change** (`GAP-AUTHZ-01`). Without it the frontend gate is cosmetic and org tenancy makes it exploitable |
| **3.5** Org role on the session | Then remove the `getOrgRole` stub and open `/credits` + `/team` |

**Complexity: Large / Critical.** Multi-PR. **Do not start before Phase 0.1 lands** — owner
sequencing confirmed 2026-08-11. `authz-security` (Phase 0.1) is the dimension that would catch
3.4's Owner gates being scoped wrong, and its prompt now carries the org-as-tenant ruling
explicitly: it will produce the definitive list of routes needing `@OrgRoles`, separated into
**spend** paths (must be Owner) and **read** paths (any active member). Wait for that list before
writing 3.4.

---

### Phase 4 — Alpha shipping blockers (P1)

Independent of Phase 3; can proceed in parallel.

| Task | Gap |
|---|---|
| **4.1** Session refresh + central 401→`/login` | `GAP-PAY-01`, `GAP-FE-04` |
| **4.2** Honest-UI sweep — never render `₹0` where the truth is "not tracked"; fix `/profile`'s hardcoded KYC/bank literals | `GAP-FE-02`, `GAP-XC-04` |
| **4.3** Top-up idempotency | `GAP-FE-07` |
| **4.4** Resolve `…/plan` + `…/boost` — wire or delete | `GAP-PAY-02` |
| **4.5** Role gate per Ruling 2 | `GAP-FE-06` |
| **4.6** Attribution abuse review of the public click sink | `GAP-AGY-02` |
| **4.7** Deployment path for `payer-web` | `GAP-XC-06` — **it is deployed by nothing today** |

**Complexity: Medium.**

---

### Phase 5 — Security hardening (sequenced by Phase 0.1's findings)

Placeholder until `authz-security` runs. Known now:
- Enumerate routes lacking `ZodValidationPipe` (validation is opt-in; `useGlobalPipes` is never called)
- Per-route IDOR verification against `payer-scope.ts`
- `@PayerRoles` coverage sweep (the guard **fails open** without metadata)
- Explicit `requirePayer()` on the 15 ungated Server Actions (`GAP-FE-05`, defence in depth)

**Complexity: unknown until Phase 0.1. Assume Large.**

---

### Phase 6 — Data integrity & performance (P2)

Mostly additive migrations, low risk, high value:

| Task | Gap |
|---|---|
| 6 composite indexes; 3 `LIMIT`s; keyset `descNullsLast` helper + ledger tiebreak | `PAY-DB-05/06/07` |
| 14 CHECK constraints (validate existing data first) | `PAY-DB-08` |
| Applicant-list query rewrite (move the tier CASE into the snapshot) | `PAY-DB-04` |
| Credit reconciliation script + ops surface | `PAY-DB-09` |
| `posting_plans` partial unique index (per Ruling) | `PAY-DB-10` |
| Coupon-cap expression index | `PAY-DB-11` |

**Complexity: Medium.** Each independently shippable and testable.

---

### Phase 7 — Enterprise polish (P2/P3)

UX/a11y audit, per-route loading + error boundaries (`GAP-FE-03`), doc corrections
(`GAP-XC-11`), coverage thresholds for payer-web (`GAP-XC-09`), the design-token upstream
(`GAP-XC-10`), audit columns (`PAY-DB-12`), the remaining P3s.

Shared-package extraction (DS + http client + contracts, currently duplicated three ways) belongs
here as a costed ADR — it is the prerequisite for any future app split.

---

## Definition of Done

A feature is **not** done because the UI exists, the route exists, the API returns 200, or data
appeared once. It is done when **every applicable** link holds:

```
UI → Route → Auth → Authorization → Validation → API → Business Logic → Database
   → External Integration → Error Handling → State Update → Audit/Event → Tests
   → Local E2E Verification → Production Readiness
```

Project-specific additions, from `CLAUDE.md` and this audit:

1. **Event-first** — every important business action emits a validated event.
2. **Server-side authorization** — a frontend gate is never the control. Every gate has a
   backend counterpart, and every mutation table has a **green** row (what it *permits*), not
   only red rows.
3. **Honest UI** — a gated-off surface says "not available", never a fabricated zero or status.
4. **Reproduce from an empty DB** — the feature works after `db:migrate` on a fresh database.
5. **A passing test is evidence only after you have seen it fail.**
6. **Verify on `main`** — `git fetch origin` and read `origin/main` for the artifact. A merged PR
   is not proof.

---

## Complexity summary

| Phase | Complexity |
|---|---|
| 0 — Close the audit | Medium (spend) |
| 1 — Owner rulings | Small time / **Critical** impact |
| 2 — Unblock verification | **Medium — highest leverage** |
| 3 — Tenancy | **Large / Critical** |
| 4 — Alpha blockers | Medium |
| 5 — Security hardening | Unknown → assume Large |
| 6 — Data integrity & perf | Medium |
| 7 — Enterprise polish | Medium |

No time estimates are given. The repository does not carry velocity data from which to derive
them honestly.
