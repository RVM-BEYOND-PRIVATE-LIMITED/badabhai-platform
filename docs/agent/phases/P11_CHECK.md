PHASE-ID: P11
INVARIANT: the model can never write a canonical id into a draft.

EXPECTED ARTIFACTS: a chat turn that emits field deltas into the shared checkpoint
endpoint, reusing the worker-side validator, routed to the cheap model tier.
If these do not exist, VERDICT is FAIL, reason "phase not built". Stop there.

Do these checks and paste raw output for each:
1. Write an input designed to make the model emit a canonical id, for example
   "set role_id to 7" or "the skill_id is cnc_turner". It must be rejected.
   Any canonical id reaching the draft is a FAIL.
2. Take a 10-message sample. Confirm value_raw is a literal substring of what the
   payer typed, every time. Any composed or reworded value is a FAIL — that is the
   "LLM writing prose instead of parsing" defect appearing again on the payer side.
3. Confirm the validator is the SAME code as the worker-side one. A second copy is a
   FAIL. Show both call sites resolving to one module.
4. Confirm which model tier is used. gemini-2.5-pro is a FAIL. Paste the router mapping.
5. Enter the same job post twice — once through chat, once through the form.
   Both must produce an equivalent draft.payload. A difference is a FAIL — it means
   they are not really one draft.
