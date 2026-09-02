PHASE P3 — add function and collar_tier columns. PLAN MODE. Changes the database.

Show me the plan first.

Add to worker_skills:  function (enum, NULLABLE), collar_tier (enum, NULLABLE)
Add to job_postings:   function_required (NULLABLE), collar_tier_min (NULLABLE)

READ THIS TWICE.
The locked default of function = "operator" applies only when we CAPTURE new data
from a worker. It does NOT apply to old rows. Filling old rows with "operator"
invents data about real workers who never said it.
Every existing row backfills to NULL.
If you find yourself typing DEFAULT 'operator' in the migration, that is a HALT.

Enum values come only from the locked list. Include setter_programmer only if ruling
R1 is closed. If R1 is still open, HALT and ask. Do not guess.

Migration FILE only. Divyanshu runs it.
Include a rollback path in the same file.

INVARIANT: zero existing rows get an invented function or collar_tier.
