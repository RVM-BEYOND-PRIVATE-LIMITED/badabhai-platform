PHASE-ID: P7
INVARIANT: PACE only ever widens, never narrows.
           The push floor stops notifications, never visibility.

EXPECTED ARTIFACTS: PACE enabled and reading adjacency from matching_catalog, plus a
push floor at 40/100 in the push processor.
If these do not exist, VERDICT is FAIL, reason "phase not built". Stop there.

Do these checks and paste raw output for each:
1. Seed a job with thin supply. Run the PACE waves. After each wave, confirm the
   reach set is a strict superset of the previous wave. If any candidate is removed
   by a wave, that is a FAIL.
2. Confirm PACE pauses at the purchased applicant quota, not at a hardcoded number.
   Paste where the quota value comes from.
3. Confirm the adjacent-trades wave reads matching_catalog adjacency.
   A separate hardcoded adjacency list is a FAIL.
4. Seed a worker scoring 35 out of 100 for a job. Confirm the worker APPEARS in the
   feed and gets NO push. Missing from the feed is a FAIL. Push sent is a FAIL.
5. Seed a worker at exactly 40. Confirm the boundary behaviour is deliberate and
   covered by a test, not accidental.
