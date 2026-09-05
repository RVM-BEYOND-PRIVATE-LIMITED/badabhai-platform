STATUS: CLOSED 2026-09-05 — superseded by the E-chain (docs/decisions/E_CHAIN_DESIGN_2026-09.md).
Do not build from this file without reopening the phase.

WHAT NO E-PHASE COVERS — dropped visibly, not quietly. Each survived an adversarial
refutation pass (already-ships / an-E-phase-covers-it / a-signed-ruling-deleted-it):
  - `tier-parity.test.ts` — pinning the THREE SQL writers of `job_reach.match_tier` to the
    reference `matchTierFor`. The duplication is deliberate (rank-parity.test.ts says so);
    what is missing is the test that keeps the copies agreeing. No E-phase adds it.

------------------------------------------------------------------------------
PHASE-ID: P2
INVARIANT: on a posting whose reach_skill_ids is resolveReachSet(match_skill_ids) and
which carries no job_reach_widen grant, every match_tier written to job_reach equals
matchTierFor(wanted, match_skill_ids), and a worker matchTierFor returns null for gets
no row.

EXPECTED ARTIFACTS: apps/api/src/match/tier-parity.test.ts, wired into
.github/workflows/ci.yml. Absent, VERDICT is FAIL, reason "phase not built". Stop there.

P2 adds no migration; it needs the schema rank-parity already needs, which Prakash
applies between the build and check sessions. Run every command under bash — the
VAR=x prefix is a parse error in PowerShell.

Paste raw output for each:
1. RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test tier-parity
   "skipped" for this file is a FAIL (ci.yml:1438 exists for exactly that). The run must
   assert a non-zero expected row count and an explicit worker-id set; an expectation
   over zero rows is a FAIL.
2. Confirm the unmutated run observed at least one job_reach row with match_tier = 2 and
   one with 1. If not, no mutation below can go red — FAIL.
3. Change ELSE 2 to ELSE 1 at apps/api/src/match/worker-skills.repository.ts:360.
   Re-run step 1, paste, revert. Green is a FAIL.
4. Same at worker-skills.repository.ts:280. Green is a FAIL — the test never drives
   reconcileReachForWorker, so half the invariant is unguarded.
5. In packages/match-engine/src/reach.ts make matchTierFor return 1 where it returns 2,
   then `pnpm --filter @badabhai/match-engine build` BEFORE re-running: apps/api resolves
   the package to dist/index.js (package.json exports), so an unbuilt edit is invisible
   and the run stays green for the wrong reason. Revert and rebuild. Green is a FAIL.
6. Change ELSE 2 to ELSE 3 at packages/db/src/materialize-job-reach.ts:158 — whitespace
   or a rename survives the pin's normalization. Re-run, paste, revert. Green means the
   D5 runner is unguarded — FAIL.
7. grep -n "tier-parity" .github/workflows/ci.yml. It must appear at ~:1416 and in the
   `for f in` loop at ~:1430, and the count at ~:1448 must read 10. Any one missing and
   the gate never runs in CI — FAIL.
8. git diff $(git merge-base origin/main HEAD)..HEAD -- '*.ts'. FAIL on any weakened,
   skipped or deleted test; on a new NON-TEST file under packages/match-engine/src; on
   any hit for resolveMatchTier, tradeFactor, functionMultiplier or collarTierBand. Hits
   in docs/agent/phases/ are expected — this brief names them.
9. Every workers row must carry a synthetic marker in phone_e164 and phone_hash (the
   enc:/hash: shape of rank-parity.test.ts:203-207). A real number, a person's name or
   an email anywhere in the fixtures is a FAIL.
