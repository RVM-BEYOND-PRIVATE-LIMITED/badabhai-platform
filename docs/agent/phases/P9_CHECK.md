PHASE-ID: P9
INVARIANT: an unverified posting is never visible to any worker.

EXPECTED ARTIFACTS: a single publish endpoint on the draft, a verification gate before
job_reach, a separate plan step stamping applicant_quota, and the removal of the chat
publish route.
If these do not exist, VERDICT is FAIL, reason "phase not built". Stop there.

Do these checks and paste raw output for each:
1. Publish a draft. Before verification, look at the worker feed as a worker who is a
   perfect match. The posting must be ABSENT. Present is a FAIL — this is a trust
   incident, not a bug.
2. Confirm the posting is absent from job_reach. Paste psql output.
3. Simulate a payment failure during the plan step. Confirm the draft content is fully
   intact and the posting still exists at status = draft. Any content loss is a FAIL.
4. Stamp a quota, then change the pricing tier. Confirm the live job's applicant_quota
   is UNCHANGED. If it changed, that is a FAIL — it breaks the locked
   stamped-at-purchase rule.
5. grep for the deleted chat publish route. Still present is a FAIL — two publish paths.
6. Edit a published posting's benefits text (affects_matching = false). Confirm
   engine_version did NOT change and job_reach was NOT rebuilt.
7. Edit its city (affects_matching = true). Confirm engine_version DID change,
   job_reach WAS rebuilt, and existing application rank snapshots are byte-identical
   to before. Any snapshot change is a FAIL.
