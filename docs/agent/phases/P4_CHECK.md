PHASE-ID: P4
INVARIANT: boost can never move a job out of its relevance bucket.

EXPECTED ARTIFACTS: a changed rank key in match-engine, a property test covering the
boost invariant, and a bumped engine_version.
If these do not exist, VERDICT is FAIL, reason "phase not built". Stop there.

Do these checks and paste raw output for each:
1. Read how the ranking key is built. Confirm boostTier comes after skillMonthsBucket.
   Cite file and line. Any other position is a FAIL.
2. Run the property test. Paste raw output and the number of generated cases.
   Fewer than 1,000 cases: report it as not enough.
3. ADVERSARIAL — spend real effort here. Try to build an input where a boosted job
   beats an unboosted job that sits in a strictly higher skillMonths bucket.
   Try boundary values, equal tiers, null months, maximum boost tier.
   If you succeed, the code is wrong. FAIL it and show the exact input.
4. Run the same feed twice on identical data. The order must be byte-identical.
   Any randomness is a FAIL.
5. Confirm engine_version was bumped and is stamped on new job_reach rows. psql output.
6. git diff the test files. Any test weakened or removed is a FAIL.
