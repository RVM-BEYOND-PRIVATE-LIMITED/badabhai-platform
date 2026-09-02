PHASE P10 — payer-web wizard renders from the server schema.

Work in apps/payer-web. The wizard is drawn ENTIRELY from
GET /payer/job-posting-drafts/schema.

Zero hardcoded step definitions.
Zero hardcoded field lists.
Zero hardcoded role, function, collar tier, shift, or benefit options.
If you type one of the 22 role names into a .tsx file, you have failed this phase.

Every step completion POSTs a checkpoint with expected_version and an Idempotency-Key.
A 409 shows "Updated on another device" with a reload-or-overwrite choice.
Never retry silently.

Resume: on entry, call drafts?status=in_progress and offer
"Resume — Step 4 of 7 (Salary & Shift) — edited on Web, 12 min ago".

Pin schema_version on the draft. If the served schema version is different from the
draft's version, show an explicit "we have updated this form" step.
Never migrate the draft silently.

INVARIANT: no job-posting field, step, or option value is hardcoded in the client.
