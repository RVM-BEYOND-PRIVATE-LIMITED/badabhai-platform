PHASE-ID: P10
INVARIANT: no job-posting field, step, or option value is hardcoded in the client.

EXPECTED ARTIFACTS: a schema-driven wizard in apps/payer-web, checkpoint POSTs with
version and idempotency headers, a 409 conflict screen, and draft resume.
If these do not exist, VERDICT is FAIL, reason "phase not built". Stop there.

Do these checks and paste raw output for each:
1. grep apps/payer-web for all 22 role labels, every function value, and every collar
   tier value. Any hit outside a test fixture is a FAIL. Paste the hits.
2. Add a new field to the served schema WITHOUT touching any client code. Reload the
   page. The field must render. If it does not, the wizard is not schema-driven — FAIL.
3. Remove a step from the served schema. The wizard must adapt with no client change.
4. Force a 409: change the draft out of band, then submit a step from a stale client.
   The conflict screen must appear. A silent retry or a lost edit is a FAIL.
5. Bump the served schema_version against an in-flight draft. The explicit update step
   must appear. Silent migration is a FAIL.
