PHASE-ID: P5
INVARIANT: a facet never changes which candidates are in the result.

EXPECTED ARTIFACTS: a facet query parameter on the applicants endpoint, a badge count,
and small-pool hot tag suppression.
If these do not exist, VERDICT is FAIL, reason "phase not built". Stop there.

Do these checks and paste raw output for each:
1. Pick a job with at least 30 candidates. Call the endpoint with no facet.
   Record the full list of candidate ids and the count.
   Then call it once for every valid facet value for that role.
   For each call: the count must be identical AND the set of ids must be identical.
   Even one id different is a FAIL. Paste the comparison.
2. Check the badge count against a manual count of the underlying data.
3. Call with an unknown facet key. It must return 400. A 200 is a FAIL.
4. grep the scoring code path for any reference to a facet. Any hit is a FAIL.
5. Seed a job with fewer than 70 candidates. Confirm zero hot tags and
   small_pool: true. Everyone tagged hot is a FAIL.
