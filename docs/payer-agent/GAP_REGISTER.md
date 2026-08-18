# Gap Register — Payer + Agency

**Severity is calibrated to the owner's ruling: _Alpha — real users, mock money._**
`PAYMENTS_ENABLE_REAL` and `AGENCY_PAYOUTS_ENABLED` staying OFF is **intentional**, so
flag-gated surfaces are not defects — but each carries an *honest-UI* obligation.

- **P0** — blocking / security / data integrity / makes a core flow unusable
- **P1** — required before shipping alpha
- **P2** — enterprise-grade improvement
- **P3** — nice-to-have

**Coverage:** the audit COMPLETED on 2026-08-11 — all 10 dimensions ran (see `AUDIT_STATUS.md`).
Security findings are in the `PAY-SEC-*` section below and in `SECURITY_AUDIT.md`.
Still unaudited: the Flutter `apps/payer-app` deep-dive and the `apps/web` / `apps/admin-web`
sole-consumer pass. **Absence from this register is not evidence of absence of defects there.**

---

## Master table

| ID | App | Area | Current state | Missing | Sev | Dependency | Required work | Test required |
|---|---|---|---|---|---|---|---|---|
| **PAY-DB-01** | packages/db | Tenancy | `org_id` on **1 of 20** tables (`payer_members` only); 19 business tables scoped by individual `payer_id`; `root_payer_id` never read as a scope | org-scoped data model | **P0** | Owner ruling on tenancy model | Migration adding `org_id` + backfill + index to 19 tables, then rewrite every owner-scoped predicate. Multi-PR. **Or** park Team behind an off flag | e2e: payer A invites B; B must see A's postings + credits. Today it must fail — land it red |
| **GAP-FE-01** | payer-web | Auth/RBAC | `getOrgRole()` hard-returns `"recruiter"`; `/credits` + `/team` 404 for every real user; nav still links to them | org role on the signed session | **P0** | PAY-DB-01 | Do **not** open the gate first. Settle tenancy → migrate → wire the claim → open | Test that a Recruiter 404s and an Owner does not, on a seeded org |
| **GAP-PAY-03** | apps/api | Org RBAC | Backend org surface correct + guarded; frontend cannot reach it | — | **P0** | GAP-FE-01 | None on the backend. Unblocks with the above | Endpoint test already partly present |
| ~~**GAP-PAY-04**~~ | apps/api | **Money / paywall** | ✅ **FIXED 2026-08-11.** `POST /payer/credits` now 404s when `realPaymentsLive`, mirroring `/credits/order:173`. Mock grant and real checkout are mutually exclusive by construction; neither leaks which mode the deployment is in. Verified: full-depth mutation test (removing the gate fails exactly 1 test), 4052 tests green, typecheck + lint clean | — | ~~P0~~ **DONE** | — | `payer-unlocks.controller.ts:145` + both-rows test | Flag ON ⇒ 404 and grant never attempted; flag OFF ⇒ 201. Both asserted |
| **GAP-PAY-05** | apps/api | **Money / audit trail** | **VERIFIED, and it is NOT the free-credits defect I first recorded.** `:id/plan`, `:id/boost`, `:id/quota-topup` and `POST /payer/capacity` neither debit credits nor charge — they resolve a quote, grant the entitlement, and emit `payment.authorized` + `payment.captured` stamped `real_call: areRealPaymentsEnabled(config)` (`posting-plans.service.ts:186,306,376`). **At the flip they would stamp `real_call:true` on the event spine for money never collected** — false financial records in the system of record, plus free entitlements. There is NO Razorpay path for plans/boosts/capacity, so gating them would DELETE the ability to buy them | a payment mechanism, or an explicit ruling | **P0 (fix-before-flip)** | Blocks enabling real payments | **Not mechanically gateable — needs a product decision.** Deliberately NOT 'fixed' by copying the credits gate: that would remove the purchase path entirely | Assert no `payment.captured` with `real_call:true` is emitted without a settled provider reference |
| **GAP-PAY-01** | payer-web | Session | `POST /payer/refresh` exists, **never called**; 401 caught in only one place | refresh wiring + a global 401→`/login` path | **P1** | — | Call refresh on near-expiry; catch `PayerUnauthorizedError` centrally and `redirect("/login")` | Test: expired cookie on a deep route redirects, not error-boundaries |
| **GAP-FE-04** | payer-web | Session | Expiry mid-session hits the portal error boundary, not `/login` | — | **P1** | GAP-PAY-01 | Same fix | As above |
| **GAP-FE-06** | both | Cross-role | `/payer/job-postings/*` has **no `@PayerRoles`**; `PayerRoleGuard` is a no-op without metadata → an `agent` can drive the employer surface | an owner ruling, then a role gate or an explicit "shared by design" note | **P1** | Owner ruling | If separate: add `@PayerRoles("employer")`. If shared: document it and add a test pinning the intent | Authz test asserting an agent session's outcome on `/payer/job-postings` |
| **GAP-FE-07** | payer-web | Money | `topUpQuotaAction` spends credits with no action-layer idempotency | idempotency key on the top-up path | **P1** | — | Confirm `credit_ledger_idempotency_key_uq` is populated here; add a client-supplied key | Concurrency test: two simultaneous top-ups → one charge |
| **GAP-PAY-02** | both | Revenue | `…/plan` and `…/boost` exist with **no frontend caller**; `/plans` sells nothing | a purchase path, or removal | **P1** | Product ruling | Determine whether plans attach implicitly at creation. Then wire or delete | Flow test from `/plans` to an active plan |
| **PAY-DB-02** | packages/db | Deploy | ✅ **RECONCILED 2026-08-11.** 27 of 74 migrations unrecorded — but **all 27 fully live, 0 pending, 0 partial**. Schema is at head; the *journal* is behind. `0062` is live, so the "every payer posting read 500s" worst case is **refuted** | journal adoption for 27; the boot assertion is still worth having | ~~P1~~ **P3** | — | Generalize `adopt-0066.ts` to adopt all 27 (verify columns+types+indexes+RLS, refuse on mismatch) | Boot test still valid as a future guard |
| ~~**GAP-DB-19**~~ | packages/db | Deploy | ✅ **CLOSED 2026-08-11 on production.** All 27 unrecorded migrations adopted into `drizzle.__drizzle_migrations` after full-depth verification (27/27 clean). Journal now **74/74**, and a hash check confirms `pnpm db:migrate` will skip every migration without attempting DDL. The org-as-tenant migration is no longer blocked | — | ~~P0~~ **DONE** | — | Done via `packages/db/adopt-migrations.ts --apply` | Re-run `--doctor`: expect `74/74 match` |
| **GAP-DB-20** | packages/db | **Security** | **PRODUCTION DRIFT (verified, control group passed):** 7 of 69 public tables have RLS `ENABLE`d but **NOT `FORCE`d** — `agency_kyc`, `agency_payout_accruals`, `agency_payout_requests`, `agency_profiles`, `employer_profiles`, `payer_capabilities`, `payer_member_invites`. The other 62 are correctly ENABLE+FORCE. Migration `0048` **does** contain the three FORCE statements (lines 70,75,80) — they were never applied   ⚠️ **PARTIALLY CLOSED 2026-08-11:** the **3 belonging to migration `0048`** (`agency_kyc`, `agency_payout_accruals`, `agency_payout_requests`) are now FORCEd on production and verified. The remaining **4 are the unmodelled tables of `GAP-DB-21`** and were deliberately NOT touched — they belong to no migration, so forcing them would be the scope creep the owner ruled against, pending a ruling | FORCE on the remaining 4, once ruled | **P1 → P2** | `GAP-DB-21` ruling | `ALTER TABLE … FORCE ROW LEVEL SECURITY` ×7 in staging, then prod. Without FORCE the table **owner** bypasses RLS; with zero policies, ENABLE alone stops only non-owners | Assert all public tables are ENABLE+FORCE; extend the `rls-spine` e2e guard |
| **GAP-DB-21** | packages/db | **Drift** | **4 tables exist in production that appear in NO migration and NO schema file**: `agency_profiles`, `employer_profiles`, `payer_capabilities`, `payer_member_invites`. Production has 69 public tables; the repo models 65. All 4 are among the un-FORCEd 7 | a decision: model, drop, or document | **P1** | Owner ruling | Inventory their contents read-only first. **`payer_member_invites` overlaps `payer_members`** — the exact table Phase 3 re-scopes — so establish whether it holds live invite state **before** Phase 3 | Column-level drift guard extending `PAY-DB-14`'s `payer_type` case |
| **GAP-AGY-02** | both | Attribution | Public unauthenticated `POST /invites/:code/click` is the live sink; the agent-gated twin has no caller | abuse assessment | **P1** | Before payouts flip | Assess inflation risk; consider signing the click or moving to the gated sink | Test: repeated clicks from one IP do not inflate the funnel |
| **PAY-DB-03** | packages/db | Integrity | `payer_id` has **no FK** on 10 money tables while 8 other tables **do** FK to `payers` — split posture | an owner ruling | **P1** | ADR-0010 unavailable on main | Escalate. If retained, add orphan detection; if retrofitted, `ON DELETE RESTRICT` **never** CASCADE | e2e: deleting a payer with credits is refused, or orphans are surfaced |
| **GAP-FE-02** | payer-web | Honesty | `/profile` renders KYC ("PAN & Identity / Pending") and Bank ("Not added") from **hardcoded literals** — never calls `getAgencyKyc()` | real data, or explicit "not tracked yet" | **P1** | — | Replace literals with a real read, or state plainly that KYC is not collected in alpha | SSR test asserting no fabricated status renders |
| **GAP-XC-04** | payer-web | Honesty | Flag-gated surfaces must never render a **zero** where the truth is **unavailable** | audit of every flag-off render path | **P1** | — | Sweep every panel that 404s in alpha; ensure "not available" not "₹0" | SSR test per panel with the flag off |
| **GAP-XC-06** | ci/infra | Deploy | **HOSTING DECIDED + PIPELINE BUILT (2026-08-18, #920) — NOT YET DEPLOYED.** A new container on the SAME Lightsail box that already runs `apps/api`/`apps/ai-service` (owner decision — not Vercel, not static export: `/i/[code]` is `force-dynamic` server-rendered). `apps/payer-web/Dockerfile` (Next `output: standalone`) + `payer-web-image`/`build-and-push-image`/`deploy-lightsail` in `ci.yml` + the `payer-web` block in `docker-compose.staging.yml` all exist and the image builds clean locally (`docker build`, verified — container boots, `/health` returns 200 through the published port). **v1 scope only: IP:port, no TLS, no domain** — deferred until badabhai.ai is provisioned. `staging-cd.yml:172` is unaffected (a separate, still-inert `workflow_dispatch` pipeline for a different persistent host) and still skips the Next apps — that line is now accurate only for that OTHER pipeline. Real deploy is BLOCKED on manual box config, not code — see below | a human to: (1) confirm port **3002** (the default) is free on the box and open in its security group — or set `PAYER_WEB_PORT` as a GitHub "staging" Environment secret to override, (2) add that box's payer-web origin (`http://<box-ip>:<port>`) to the existing `CORS_ALLOWED_ORIGINS` secret, (3) optionally set `PAYER_WEB_NEXT_PUBLIC_API_URL`/`PAYER_WEB_NEXT_PUBLIC_SITE_URL` repo secrets (safe, documented fallbacks apply if left unset — see the Dockerfile header) | **P1** | (1)-(2) block payer-web being REACHABLE and its browser calls succeeding — but neither blocks the deploy job itself. The port is `${PAYER_WEB_PORT:-3002}` (defaulted, NOT fail-loud) specifically so this service can never take the live api/ai-service deploy down with it: compose interpolates the whole staging file before filtering by service, measured, so a fail-loud port here would have failed `$COMPOSE pull api` | Remaining: exercise a real deploy once the box secrets exist; confirm the box's security group actually has the chosen port open; then a browser smoke test against `http://<box-ip>:<port>` | Docker build verified locally (image builds, container boots, `GET /health` 200 through the published port). Real-box smoke test still outstanding — no SSH/box access from this session |
| **GAP-XC-07** | cross | Testing | **Zero** browser/E2E tests repo-wide; 4 payer e2e suites are hard `describe.skip`; `tests/contract` + `tests/security` are empty | a payer test-login seam + real E2E | **P1** | — | Add a payer analogue of `TEST_LOGIN_ENABLED`; un-skip `payer-tenancy`; add Playwright for the core loop | The loop: login → post → applicants → unlock → reveal |
| **GAP-AGY-01** | both | Lifecycle | Agency jobs have **no resume** and **no quota-topup**; employer twin has both | parity or a documented reason | **P2** | Product ruling | Add the routes or document the asymmetry | Lifecycle test per persona |
| **GAP-FE-05** | payer-web | Defence | 15 Server Actions rely on *transitive* auth via the seam's cookie read | local, explicit gates | **P2** | — | `await requirePayer()` at the top of each ungated action | Test each action rejects with no cookie |
| **GAP-FE-03** | payer-web | UX | 1 `loading.tsx` + 1 route `error.tsx` for **25 pages** | per-route boundaries on slow/fallible routes | **P2** | — | Add to `/postings/[id]/applicants`, `/postings/ai/new`, `/dashboard` | Render tests for the fallbacks |
| **PAY-DB-04** | packages/db | Perf | The core employer applicant read cannot use its purpose-built 7-column index (CASE + COALESCE + NULLS mismatch) | matching index or rewritten ORDER BY | **P2** | — | Prefer rewriting the query; move the tier CASE into the snapshot | EXPLAIN assertion: no Sort node |
| **PAY-DB-05** | packages/db | Perf | Keyset indexes declared `DESC NULLS LAST`; drizzle `desc()` emits NULLS FIRST → no pathkey match. Ledger read also lacks an `id` tiebreak | a `descNullsLast` helper | **P2** | — | Add helper, apply at every keyset read, add the tiebreak | Plan-shape tests under `RUN_DB_TESTS` |
| **PAY-DB-06** | packages/db | Perf | 6 owner-scoped list reads sort on an unindexed key; `agency_kyc` has no usable index | 6 composite indexes | **P2** | — | One additive migration, no code change | Plan-shape tests |
| **PAY-DB-07** | packages/db | Perf | 3 agency reads have **no LIMIT** | `OPS_LIST_CAP` | **P2** | — | One-line each | Assert compiled SQL contains LIMIT |
| **PAY-DB-08** | packages/db | Integrity | 14 status/enum columns have **no CHECK**, incl. `payers.role` + `payers.status` — the authz discriminator | CHECK constraints | **P2** | — | Additive migration; validate existing data first | Insert an out-of-union value → expect 23514 |
| **PAY-DB-09** | packages/db | Money | No `balance = SUM(ledger)` invariant; zero triggers repo-wide; ledger append-only by convention only | reconciliation | **P2** | — | `pnpm db:check:credits` + surface on the ops finance page | Diverge them, assert the check flags it |
| **PAY-DB-10** | packages/db | Integrity | `posting_plans` has **no unique constraint**; N active plans per posting possible and each consumes a capacity slot | partial unique index | **P2** | Product ruling | `UNIQUE (job_posting_id) WHERE status='active'` after dedupe | Concurrency test → exactly one plan |
| **PAY-DB-11** | packages/db | Perf | Coupon cap enforced by two COUNTs over the append-only `events` table with JSONB extraction, no expression index | partial expression index | **P2** | — | Additive migration modelled on `ai_jobs_extraction_session_idx` | Plan test: index scan not seq scan |
| **PAY-DB-15** | packages/db | Feature | **No payer notifications at all** — a payer learns of a new applicant only by opening the portal | table or event projection | **P2** | Product ruling | `payers.notifications_read_at` + a payer-scoped projection | Feed returns only own-payer events |
| **PAY-DB-16** | packages/db | Feature | **No table** for saved searches, payer analytics, payer-visible audit history, or applicant pipeline stages (`applications.action` is `applied\|skipped` only) | product ruling | **P2** | Product ruling | Pipeline stages are highest-value/cheapest if in scope | n/a until scoped |
| **GAP-XC-05** | apps/api | Consistency | 5 capabilities exist **twice** (internal twin + payer route); divergence unaudited | parity audit | **P2** | — | Verify both call one service and enforce one state machine | Parity test per pair |
| **GAP-XC-09** | payer-web | Testing | 83 tests but **no coverage threshold**; many assert source text rather than behaviour | a floor | **P2** | — | Add thresholds; never lower them | — |
| **GAP-XC-10** | payer-web | Design | `tokens.css:3` cites `docs/design/BadaBhai Design System/` — **the directory does not exist** | the upstream, or an amended comment | **P2** | — | Restore the source or correct the header | — |
| **GAP-XC-11** | cross | Docs | Stale: root `README` omits payer-web/admin-web, links 2 nonexistent docs, calls reach-engine a placeholder; `apps/payer-web/README` documents deleted mocks + dead `PAYER_AUTH_MODE`; `.env.example` documents 3 dead vars; `globals.css:1905` claims the pause/resume trio is "coming soon" when it ships live | — | **P2** | — | Correct each | — |
| **GAP-XC-08** | cross | Governance | 12 ADRs cited in code have **no file on `main`**; several audit questions cannot be resolved from the repo | the ADRs | **P2** | Owner | Restore or re-ratify | — |
| **PAY-DB-12** | packages/db | Audit | Chat/draft tables lack `created_at`; `jobs` lacks `created_by`; `payer_members` has `invited_by` but no `removed_by` | 4 columns | **P3** | — | Additive migration; stamp `removed_by` from the guard principal | Assert actor comes from the guard, not the body |
| **PAY-DB-13** | packages/db | Correctness | "Deterministic auto-resume order" sorts on nullable `paid_at` with no tiebreak → unstable | tiebreak + NULLS clause | **P3** | — | Add `asc(id)` | Repeated-call stability test |
| **PAY-DB-14** | packages/db | Drift | `payers.payer_type` exists in some live envs, is unmodelled, deliberately not dropped → live ≠ empty-DB rebuild | a decision | **P3** | Owner env inventory | Model it or drop it in a reviewed migration | Column-level drift guard |
| **PAY-DB-17** | packages/db | Hygiene | Pure-search disclosures never collide (NULLS DISTINCT) → unbounded duplicate rows | `NULLS NOT DISTINCT` | **P3** | — | Rebuild index after dedupe | Two pure-search disclosures → intended outcome |
| **PAY-DB-18** | packages/db | Audit | `agency_kyc.verified_by` is never written | admin principal wiring | **P3** | ADR-0025 | Stamp when ops KYC moves onto `AdminAuthGuard` | Assert it equals the authenticated admin id |

**Totals (structural pass):** 36 recorded gaps.

---

## Security & authorization findings (dimension 9 — completed 2026-08-11)

21 findings. Full detail and citations in `SECURITY_AUDIT.md`. The three P0s and the Phase-3
hazards:

| ID | Area | Finding | Sev |
|---|---|---|---|
| **PAY-SEC-01** | Org RBAC | **11 spend routes carry ONLY `PayerAuthGuard`** — `PayerUnlocksController` (`:47`), `PayerCapacityController` (`:23`), `PayerJobPostingsController` (`:66`) declare no `@OrgRoles` and no `PayerRoleGuard`. `@OrgRoles` is applied to **exactly one controller repo-wide**. **This is the route list for Phase 3.4** | **P0** |
| **PAY-SEC-02** | Org RBAC | `getOrgRole()` stub ⇒ `requireOwner()` 404s for every real principal (confirms `GAP-FE-01`) | **P0** |
| **PAY-SEC-03** | Session lifecycle | **A removed teammate keeps working access.** `softRemoveMember` sets `payer_members.status='removed'`, but `PayerAuthGuard` re-reads only `payers.status`, never membership; `revokeAllForPayer` has exactly **one** caller (admin suspend). The removed member's JWT stays valid until expiry, and every route except `/payer/org/members` never consults membership at all | **P0** |
| **PAY-SEC-04** | Org tenancy | **`ensureSoloOrg` runs at signup AND defensively at every login**, so an invited member also owns a solo org ⇒ **two active memberships**. `resolveOrgForPayer` takes `ORDER BY accepted_at DESC LIMIT 1`, so which org you act in is ordering-dependent. **Direct Phase 3 hazard** — the single-membership assumption is already false | **P1** |
| **PAY-SEC-04** *(corrected)* | apps/api | Org tenancy | ⚠️ **VERIFIED WITH A CORRECTION.** The auditor's stated mechanism is **wrong**: `ensureSoloOrg` is NOT called on every login — `payer-auth.service.ts:147-149` guards it with `if (!(await resolveOrgForPayer(id)))`, and the method is idempotent on both inserts (`ON CONFLICT DO NOTHING` on `payer_orgs_root_payer_id_uq` and `(org_id, email_hash)`). It cannot manufacture a second membership. **But the conclusion stands by a different route:** `payer_members` has no unique on `member_payer_id` (only `(org_id, email_hash)`), so a payer who signs up (solo org, owner) and is later invited to another org and accepts holds **two active memberships**. `resolveOrgForPayer` then takes `ORDER BY accepted_at DESC LIMIT 1` — most-recently-accepted wins, documented at `:88-89`, deterministic but invisible | a way for a multi-org payer to choose their acting org | **P1** | **Blocks Phase 3** | Not a bug today — a **product gap**. In Phase 3 every org-scoped read AND write silently binds to the most-recently-accepted org, **including spending that org's credits**. Needs an org-switcher or a ruling that multi-org is unsupported | e2e: payer with 2 active memberships — assert which org their spend lands in, and that it is chosen, not inferred |
| **PAY-SEC-05** | Tenant isolation | `payer-scope.ts` documents itself as "the single place that decides may THIS payer touch THIS row" but has **one importer** (`agency.service.ts`). ~30 hand-rolled payer predicates live across 10 repositories. The chokepoint is aspirational, not real — every one must be rewritten in Phase 3.3 | **P1** |
| **PAY-SEC-07** | Rate limiting | Uncapped: `POST /payer/credits`, `/credits/order`, `/credits/verify`, `/capacity`, `/job-postings` create, `…/{plan,boost,quota-topup}`, and **every `/payer/job-posting-chat` route — each message is a paid LLM call** | **P1** |
| **PAY-SEC-08** | Transport | **No helmet, no security headers** in `apps/api/src/main.ts`; `next.config.mjs` has no `headers()` | **P1** |
| **PAY-SEC-13** | IDOR depth | `buyPlan`/`buyBoost`: the controller checks ownership, the **service does not re-check** and inserts with `payer_id` from the DTO | **P2** |
| **PAY-SEC-16** | Authn | **Payer role is self-elected at signup** from an unauthenticated body — no verification that an account claiming `agent` is a real agency; then immutable and the sole input to `PayerRoleGuard` | **P2** |
| **PAY-SEC-19** | Cross-tenant write | `POST /payer/agency/invites/:code/click` is agent-guarded but **not owner-scoped** — any agent with another agency's code can advance that invite and emit an event carrying the other agency's `inviter_payer_id` | **P3** |

### ✅ Correction — `GAP-XC-03` is RETRACTED

I flagged the absence of a global `ValidationPipe` as a probable validation gap. The completed
audit enumerated **every** `@Body`/`@Query`/`@Param` on the payer + agency surface and found
coverage is **COMPLETE**: every body and query carries a Zod pipe, and all ten bare `@Param`
sites use `ParseUUIDPipe` (`PAY-SEC-10`). The opt-in pattern is fully applied. No action.

---

## Completed work — 2026-08-11 implementation pass

| ID | Outcome |
|---|---|
| **GAP-DB-19** | ✅ **CLOSED on production.** 27 migrations adopted; journal 74/74; hash check confirms `db:migrate` attempts no DDL |
| **GAP-DB-20** | ⚠️ **3 of 7 closed.** Migration `0048`'s three FORCE statements applied + verified. The other 4 belong to no migration (`GAP-DB-21`) and were deliberately left |
| **GAP-DB-21** | ✅ **RESOLVED — all four unmodelled tables are EMPTY (0 rows).** `agency_profiles`, `employer_profiles`, `payer_capabilities`, `payer_member_invites` are dead scaffolding from an abandoned design: `payer_member_invites` FKs to **`auth.users`** (Supabase Auth, which this codebase does not use) and `payer_capabilities` is a per-payer boolean permission matrix superseded by the shipped `org_role` enum. **`payer_member_invites` holds 0 rows against `payer_members`' 11 — no live state, so it does NOT conflict with Phase 3.** Recommend dropping all four in a reviewed migration; they are why 4 tables lack FORCE RLS |
| **GAP-PAY-04** | ✅ **FIXED.** `POST /payer/credits` 404s when `realPaymentsLive` — mock grant and real checkout now mutually exclusive. Mutation-tested |
| **GAP-PAY-05** | 📋 **FILED, not patched.** The four entitlement routes emit `real_call:true` payment events for uncollected money at the flip. Needs a product ruling — gating them would delete the purchase path |
| **PAY-SEC-04** | ✅ **VERIFIED with a correction.** Mechanism claimed by the audit is wrong; conclusion holds by another route. Still blocks Phase 3 as a product gap |
| **PAY-SEC-07** | ⚠️ **Partially closed.** The AI job-posting chat (the paid-LLM spend surface) is now capped per payer per hour via `PAYER_JOB_POSTING_CHAT_PER_HOUR` (default 60). The money-grant routes remain uncapped — folded into the `GAP-PAY-05` ruling |
| **PAY-SEC-08** | ✅ **FIXED.** `securityHeadersMiddleware` on the API (CSP `default-src 'none'`, nosniff, DENY, no-referrer, CORP, no `x-powered-by`); `headers()` + `poweredByHeader:false` on payer-web. **CSP deliberately omitted on payer-web** — the inline no-FOUC theme script needs a nonce/hash and there is no browser test to verify it against (`GAP-XC-07`) |
| **Phase 2.1** | ✅ **BUILT.** Payer test-login seam: `PayerTestLoginGuard` + `POST /payer/test-login` + `payer.test_login` event + boot guard refusing to arm outside dev/test/staging or with a <32-char token. Restricted to the reserved `@e2e.badabhai.invalid` domain so a leaked staging token cannot impersonate a real payer. **Unblocks the 4 hard-skipped e2e suites and `PAY-SEC-09`** |

---

## Open questions requiring an owner ruling

These are **not** engineering tasks. Each is recorded because inventing an answer would be a
business decision the audit has no authority to make.

1. ~~**Is the tenant the org or the individual payer?**~~ ✅ **RULED 2026-08-11: ORG-AS-TENANT.**
   Phase 3 of `IMPLEMENTATION_PLAN.md` proceeds as scoped, gated on Phase 0.1 landing first.
   The partial-migration hazard stands as the governing risk: `org_id` on `job_postings` but not
   on `payer_credits` means a recruiter publishes postings that spend through a `payer_id` path
   resolving to their own empty balance — **silent failed purchases** rather than obviously empty
   pages. 3.2/3.3/3.4 therefore land as **one coordinated change**, never incrementally.
2. **Is the faceless-rails no-FK posture still intended now that `payers` exists?** The ADR it
   cites says *"NO payers table"* — a premise that is now false, and the ADR is not on `main`.
   Do **not** retrofit FKs without the ruling; `ON DELETE CASCADE` would destroy billing history.
3. **Should there be a subscription / recurring-billing model?** Recommended: no for alpha —
   but note `payer_capacity.expires_at` has **no expiry sweep**, so a lapsed allowance never
   lapses and plans that should pause stay active.
4. **Which migrations are actually applied in staging/production?** Not resolvable by reading
   code. Run `SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at` per environment.
   **Prerequisite for any deploy** — if 0062 is unapplied, every payer posting list 500s, and the
   failure reads like an app bug rather than a missing migration.
5. **Do agencies and employers share the job-posting surface?** (`GAP-FE-06`.)
6. **Is one active plan per posting the rule?** (`PAY-DB-10`.)
7. **Are payer notifications, saved searches, analytics, audit history and pipeline stages in
   scope?** (`PAY-DB-15`, `PAY-DB-16`.) None has any table today.
