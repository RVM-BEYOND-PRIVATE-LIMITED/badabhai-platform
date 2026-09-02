PHASE P2 — one shared tier resolver.

Move tier resolution into ONE shared implementation used by both
packages/match-engine and packages/reach-engine.

  resolveMatchTier(worker, job, catalog) -> { tier, tradeFactor, reasons[] }

  tradeFactor = adjacency(role_worker -> role_job)
              x functionMultiplier(function_worker -> function_job)
              x collarTierBand(tier_worker, tier_job)
              capped at 1.00

  tier A = 0.85 and above
  tier B = 0.30 to 0.84
  tier C = 0.15 to 0.29
  tier D = different industry

All three tables are read from the active matching_catalog. No numbers in code.

Handling missing data. "Partial profiles work" is a locked rule:
  unknown function    -> score 0.85, reason "function_unconfirmed"
  unknown collar tier -> neutral band, reason "tier_unconfirmed"
  Never score zero. Never exclude the worker.

reasons[] will be shown to users. Every factor that changed the score must appear in it.

Golden fixtures: all 22 roles, crossed with job types (same role, same family,
adjacent domain, distant domain, different industry), crossed with function cases
(match, one level up, one level down, unknown). Save expected tier, tradeFactor and
reasons as committed data.

Delete the old tier logic from both engines. Do not leave a second copy anywhere.

INVARIANT: exactly one tier-resolution implementation exists in the whole repo.
