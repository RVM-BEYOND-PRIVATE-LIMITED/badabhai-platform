PHASE P4 — feed ranking order, safe boost, exposure balance. This is the TD42 fix.

Work in packages/match-engine. New ranking order:

  tier | functionSatisfied | skillMonthsBucket(6) | boostTier
       | industryMonthsBucket(6) | lastWorked | exposureBalance | lastActive | workerId

boostTier sits AFTER skillMonthsBucket on purpose. Bucketing at TENURE_MONTHS = 6
creates many ties. Boost breaks ties inside one bucket and can never cross a bucket.
That is exactly the locked rule: "boost reorders within relevance, never overrides a
worker's relevance floor."

exposureBalance = show the least-recently-shown candidate first.
It must be deterministic, not random. Random is not testable.

Bump engine_version on job_reach. Every match must be stamped. Locked rule.

THE REAL DELIVERABLE IS THIS TEST, and it becomes a release gate:

  For any boosted job B and any unboosted job U:
    if U.skillMonthsBucket is higher than B.skillMonthsBucket,
    then U must rank above B. Always. No exceptions.

Write it as a property test over generated inputs across all 22 roles.
Three hand-picked examples are not enough.

INVARIANT: boost can never move a job out of its relevance bucket.
