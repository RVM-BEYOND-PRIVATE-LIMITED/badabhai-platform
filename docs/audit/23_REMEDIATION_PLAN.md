# 23 — Remediation Plan

**No implementation has happened under this plan.** This orders the [22_REMEDIATION_BACKLOG.md](22_REMEDIATION_BACKLOG.md)
items into the source audit's Stage A–J shape, scoped to what Batch 1 actually found. Stages
with no Batch-1 items say so explicitly rather than being omitted, so nothing reads as silently
skipped.

## Stage A — Safety (things that must never be changed casually)

No code changes proposed in this stage. Its output is the "what I would not touch" list,
carried in [00_EXECUTIVE_SUMMARY.md](00_EXECUTIVE_SUMMARY.md) — the pseudonymization gateway,
the four auth principals and their guards, RLS/REVOKE posture, the deliberately-duplicated
ops-vs-payer controller pairs (DU-8), and anything currently `ACCEPTED AT LAUNCH` in the risk
register (R30, R32). Nothing in Batch 1's findings suggests any of these need touching — they
are recorded here as the boundary the later stages must respect.

## Stage B — Documentation

Already substantially executed by Batch 1 itself (this document set). Remaining Batch-1-sourced
items:
- BL-4 (`infra/monitoring/README.md` stale re: Langfuse)
- BL-14 (`docs/legal-later` dead reference, R38)
- BL-15 (`db:score:wedge` script alias)

Deferred to Batch 2: `docs/architecture` beyond the route map, `docs/operations`
(`COMMANDS.md`, `ENVIRONMENT_REFERENCE.md`), `docs/architecture/PR_ARCHITECTURE_UPDATE.md`.

## Stage C — Observability

No Batch-1 items — the observability gap analysis (Phase 18 of the source audit) is scoped to
Batch 2 (`16_OBSERVABILITY_AUDIT.md`). BL-4's Langfuse doc-accuracy fix is adjacent but filed
under Documentation (Stage B) since it's a docs correction, not new instrumentation.

## Stage D — Architecture consolidation (duplicate implementations)

In dependency order, smallest/safest first:
1. BL-7 (`WavyText`/`wavyChars()`) — single file, no cross-team dependency
2. BL-9 (`shouldUseSecureCookie()` extraction) — two files, no behavior change
3. BL-8 (shared email/OTP validators) — touches `@badabhai/validators` + two login flows
4. BL-10 (shared ₹ formatter) — touches three apps' display code, real user-visible fix
5. BL-6 (payer-web `/profile` vs `/account`) — needs a product decision first (redirect vs.
   shared component), then a small change

Explicitly **not** in this stage (see Backlog's "Decisions needed" section): DU-6/DU-7 (Flutter
architectural duplication — deferred, not enough consumers yet to justify a shared package),
DU-8/DU-9/DU-10 (deliberate, documented duplication — do not consolidate).

## Stage E — Dead code removal (evidence-backed only)

Only DC-1 (6 Flutter widget files, 95–100% confidence) is ready for removal in Batch 1 without
a further owner decision. Sequence:
1. One PR for the 4 `apps/payer-app` files, one PR for the 2 `apps/worker-app` files (per-app,
   per this repo's ownership split) — small, isolated, each independently revertable.

Everything else dead-code-adjacent (DC-3 through DC-5, DC-7 through DC-9, DC-11, DC-12) is
gated on a named human decision per [22_REMEDIATION_BACKLOG.md](22_REMEDIATION_BACKLOG.md) —
**do not batch these into a single "cleanup" PR**; each has a different decision-owner and a
different reason it isn't yet a clear removal.

## Stage F — CI/CD cleanup

No Batch-1 items — `12_CICD_AUDIT.md` (workflow-by-workflow classification) is scoped to
Batch 2. Nothing in Batch 1's findings suggests a CI workflow is unused or duplicated; that
question wasn't investigated at the individual-workflow level in this batch.

## Stage G — Git cleanup

No Batch-1 items — `13_GITHUB_BRANCH_AUDIT.md` (106 local + 28 remote branches, individually
classified) is scoped to Batch 2. [BRANCH_BASELINE.md](BRANCH_BASELINE.md) records the raw
counts and names the non-topic-looking branches, but performs no merged/stale/safe-to-delete
classification — that requires per-branch investigation this batch didn't do.

## Stage H — Environment cleanup

No Batch-1 items — `10_ENVIRONMENT_AUDIT.md` (variable-by-variable safe-to-remove
classification) is scoped to Batch 2.

## Stage I — Deployment improvements

BL-1 (deployment path unknown for 3 web apps) belongs here but is a question, not a change —
it blocks on an answer from Frontend Platform / DevOps before any deployment work can be
planned. `20_MAINTENANCE_MODE_DESIGN.md` (Phase 17 of the source audit) is explicitly scoped to
Batch 2 and, per the source audit's own instruction, is a design document only — no
implementation — even when reached.

## Stage J — Long-term architecture

No Batch-1 items. The two candidates that would live here — DU-6/DU-7's "extract a shared
Flutter package once a third mobile client exists" and BL-2/BL-3's test-coverage hardening
becoming a standing CI gate — are noted as future triggers, not current work.

## What ships in Batch 1's PR (this branch)

Documentation only: `docs/audit/*` (this full set) and `docs/architecture/API_ROUTE_MAP.{md,mmd}`.
**Zero source files, CI workflows, environment variables, migrations, or branches are touched.**
Every Stage D/E/F/G/H item above is a proposal for a *future*, separately authorized PR — this
plan does not pre-approve any of them.

## Suggested next-batch order (for after Batch 1 review)

1. BL-5 (Flutter dead-code removal) — smallest, safest, immediately actionable
2. BL-2/BL-3 (test-coverage gaps) — pure additions, no behavior risk
3. BL-4/BL-14/BL-15 (documentation fixes) — trivial
4. Stage D items (BL-6 through BL-10) — small, in the dependency order above
5. Batch 2's remaining 12 documents (`02, 05, 08, 09, 10, 11, 12, 13, 14, 16, 20, 21`)

This order is a recommendation, not a commitment — the user authorizes each stage explicitly,
per the source audit's own gate ("STOP... I will explicitly authorize the remediation phase").
