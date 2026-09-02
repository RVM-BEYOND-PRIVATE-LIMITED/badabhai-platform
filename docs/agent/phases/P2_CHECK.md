PHASE-ID: P2
INVARIANT: exactly one tier-resolution implementation exists in the whole repo.

EXPECTED ARTIFACTS: a shared resolveMatchTier implementation imported by both
match-engine and reach-engine, plus committed golden fixtures covering all 22 roles.
If these do not exist, VERDICT is FAIL, reason "phase not built". Stop there.

Do these checks and paste raw output for each:
1. grep the entire repo for tier logic: TIER_ORDER, the word tier, and any A/B/C
   comparison against a threshold. Paste every hit. Two implementations is a FAIL.
2. Run the golden fixture suite. Paste the raw output including the pass count.
3. Confirm every threshold and multiplier comes from matching_catalog.
   grep the engine source for the literals 0.85, 0.25, 0.30. Any hardcoded one is a FAIL.
4. Build a worker with function = null against a job that wants function = setter.
   Confirm the worker is scored and carries reason "function_unconfirmed".
   If the worker is excluded, that is a FAIL — it breaks the partial-profiles rule.
5. Confirm reasons[] is filled in for every non-exact match in the golden set.
