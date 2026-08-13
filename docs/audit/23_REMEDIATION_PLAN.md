# 23 — Remediation Plan

**No implementation has happened under this plan.** This orders [22_REMEDIATION_BACKLOG.md](22_REMEDIATION_BACKLOG.md)'s
items (now covering both audit batches) into the source audit's Stage A–J shape. Stages with no
items say so explicitly rather than being omitted, so nothing reads as silently skipped.

**Read [BL-16](22_REMEDIATION_BACKLOG.md#bl-16--staging-demand-verifyyml-can-run-migrations-and-a-synthetic-fixture-against-the-production-database-secret-r41)
first.** It's the one P0 item across both batches and sits outside the staged sequence below —
it's a secrets/environment decision for the owner, not a code change any stage here executes.

## Stage A — Safety (things that must never be changed casually)

No code changes proposed in this stage. Its output is the "what I would not touch" list, carried
in [00_EXECUTIVE_SUMMARY.md](00_EXECUTIVE_SUMMARY.md) — the pseudonymization gateway, the four
auth principals and their guards, RLS/REVOKE posture, the deliberately-duplicated ops-vs-payer
controller pairs (DU-8), the four dead-in-application legacy questionnaire tables (self-documented
as deliberately retained), and anything currently `ACCEPTED AT LAUNCH` in the risk register (R30,
R32). Nothing in either batch's findings suggests any of these need touching.

## Stage B — Documentation

Substantially executed by this audit itself (24 of 24 planned documents now shipped across both
batches). Remaining items:
- BL-4 (`infra/monitoring/README.md` stale re: Langfuse)
- BL-14 (`docs/legal-later` dead reference, R39)
- BL-15 (`db:score:wedge` script alias)
- BL-20 (recreate `docs/rollback-guide.md` + 8 sibling runbooks — P1, an active deploy job cites
  the rollback guide today)
- BL-21 (document 5 required-in-production secrets missing from every template; add
  `apps/admin-web/.env.example`)
- BL-26 (add `.enableRLS()` markers to 31 Drizzle models for drift-detection parity — cosmetic,
  RLS itself is not affected)

## Stage C — Observability

- BL-19 (thread request/correlation ids through the apps/api→apps/ai-service seam) — the
  single highest-leverage fix `16_OBSERVABILITY_AUDIT.md` identified; additive, no behavior
  change to success paths
- BL-23 (`ai.cost_recorded` schema widen to include `success`/`error_code`/`failure_reason`) —
  additive-only event-schema change, needs Chief Architect sign-off (owns `packages/event-schema`)

No BullMQ dead-letter/queue-depth visibility work is proposed — `16_OBSERVABILITY_AUDIT.md` §10
flags it as a gap but the other 5 processor types weren't audited deeply enough this pass to
scope a fix; a candidate for a future batch, not blocked on anything above.

## Stage D — Architecture consolidation (duplicate implementations)

In dependency order, smallest/safest first:
1. BL-7 (`WavyText`/`wavyChars()`) — single file, no cross-team dependency
2. BL-9 (`shouldUseSecureCookie()` extraction) — two files, no behavior change
3. BL-8 (shared email/OTP validators) — touches `@badabhai/validators` + two login flows
4. BL-10 (shared ₹ formatter) — touches three apps' display code, real user-visible fix
5. BL-6 (payer-web `/profile` vs `/account`) — needs a product decision first (redirect vs.
   shared component), then a small change

Explicitly **not** in this stage: DU-6/DU-7 (Flutter architectural duplication — deferred, not
enough consumers yet to justify a shared package), DU-8/DU-9/DU-10 (deliberate, documented
duplication — do not consolidate), the three referral-attribution tables (09_DATABASE_AUDIT.md
§5.7 — coexist by design), `jobs` vs `job_postings` (§5.2 — a documented migration bridge, not
duplication).

## Stage E — Dead code removal (evidence-backed only)

Only DC-1 (6 Flutter widget files, 95–100% confidence) is ready for removal without a further
owner decision:
1. One PR for the 4 `apps/payer-app` files, one PR for the 2 `apps/worker-app` files — small,
   isolated, each independently revertable.

Everything else dead-code-adjacent (DC-3 through DC-5, DC-7 through DC-9, DC-11, DC-12, the 4
legacy questionnaire tables, `payerFormDrafts`, `skill_related`) is gated on a named human
decision per the backlog's "Decisions needed" section — **do not batch these into a single
"cleanup" PR**; each has a different decision-owner and a different reason it isn't yet a clear
removal. BL-27 (4 SUSPECTED_UNUSED Flutter deps) is similarly small and isolated once
mobile-engineer confirms.

## Stage F — CI/CD cleanup

No workflow is a DELETE/CONSOLIDATE candidate (`12_CICD_AUDIT.md`'s final classification: 10/10
KEEP). Two platform-configuration actions, not code changes:
1. BL-17 (re-enable `supabase-checks.yml` — one click, Settings → Actions)
2. BL-16/P0 (re-scope `staging-demand-verify.yml`'s secret source — see the P0 note above; this
   is the most urgent item in either backlog)
3. BL-25 (pin `gitleaks` to a digest) — trivial, low-risk, matches the repo's existing convention

BL-22 (compose-guard coverage for 25 currently-unreachable flags) also belongs here — additive,
mechanical, no urgency since all five master real-provider flags read `false` today.

## Stage G — Git cleanup

`13_GITHUB_BRANCH_AUDIT.md` classified all 13 `origin` branches: 1 `KEEP_PROTECTED` (`main`), 2
`KEEP_ACTIVE_PR` (#821 — this audit's own Batch 1 branch — and #823), 10 `SAFE_TO_DELETE` with
verified merged-PR provenance (PR number + `mergedAt` timestamp for each). **Deletion itself is
not proposed by this plan** — per the audit's own protocol, a human should run or explicitly
authorize `git push origin --delete <branch>` for the 10, since branch deletion is a remote
mutation this read-only audit wasn't authorized to perform. The 104 local-only branches on the
auditing workstation are a separate, lower-stakes, single-workstation concern, not classified
individually.

## Stage H — Environment cleanup

No variable is proposed for removal — `10_ENVIRONMENT_AUDIT.md` found no `server.ts` field with
zero consumers (every one of 154 fields is either actively read or carries a safe default). The
environment-cleanup work that *is* proposed is documentation (Stage B, BL-21) and compose
reachability (Stage F, BL-22), not deletion.

## Stage I — Deployment improvements

- BL-1 (deployment path unknown for 3 web apps) — still a question, not a change; blocks on an
  answer from Frontend Platform / DevOps
- `20_MAINTENANCE_MODE_DESIGN.md` is complete as a **design document only** — implementing it
  (the middleware, the compose wiring, the guard test named in its own §10) is explicitly a
  future authorization, not proposed for this plan

## Stage J — Long-term architecture

- DU-6/DU-7's "extract a shared Flutter package once a third mobile client exists" — noted as a
  future trigger, not current work
- BL-2/BL-3's ai-service test-coverage additions becoming a standing CI gate — once landed,
  worth considering whether `/profiling/turn`/`/profiling/extract`-style gaps should be caught
  by a coverage-diff check rather than relying on future audits to find them
- BL-19's correlation-id threading, if it proves valuable, is a natural precursor to eventually
  adopting a real tracing backend (Langfuse is already half-wired per Batch 1) — not proposed
  now, named as the logical next step

## What ships in these PRs

Documentation only, both batches: `docs/audit/*` (this full 24-document set) and
`docs/architecture/{API_ROUTE_MAP,DATABASE_RELATIONSHIP_MAP,PR_ARCHITECTURE_UPDATE}.{md,mmd}`.
**Zero source files, CI workflows, environment variables, migrations, or branches are touched.**
Every Stage D through J item above is a proposal for a *future*, separately authorized PR — this
plan does not pre-approve any of them.

## Suggested execution order (post-review)

1. **BL-16 (P0)** — resolve first; it's a live-if-untouched production-database risk, not a
   code-quality item
2. BL-17 (re-enable `supabase-checks.yml`) — one click, restores a month of lost coverage
   immediately
3. BL-5 (Flutter dead-code removal) — smallest, safest, immediately actionable
4. BL-2/BL-3/BL-19 (test-coverage and observability additions) — pure additions, no behavior risk
5. BL-4/BL-14/BL-15/BL-20/BL-21/BL-26 (documentation fixes) — trivial to small
6. BL-18 (Phase-1 e2e journey rewiring) — medium complexity, needs the TD129 contradiction
   resolved first for the `contact-unlock` suite specifically
7. Stage D items (BL-6 through BL-10) — small, in the dependency order listed above
8. BL-22/BL-23/BL-24/BL-25/BL-27 — small, low-urgency cleanup, any order

This order is a recommendation, not a commitment — the user authorizes each stage explicitly,
per the source audit's own gate ("STOP... I will explicitly authorize the remediation phase").
