STATUS: CLOSED 2026-09-05 — superseded by the E-chain (docs/decisions/E_CHAIN_DESIGN_2026-09.md).
Do not build from this file without reopening the phase.

WHAT NO E-PHASE COVERS — dropped visibly, not quietly. Each survived an adversarial
refutation pass (already-ships / an-E-phase-covers-it / a-signed-ruling-deleted-it):
  - The posting-chat provenance gate and its failing test — every value written into a
    draft must be a literal substring of the pseudonymized message the model saw, and a
    failing delta is dropped before persistence.

------------------------------------------------------------------------------
PHASE-ID: P11
INVARIANT: every value the chat writes into a draft is text the payer typed — value_raw is a
literal substring of the pseudonymized message its evidence_span cites, and a delta failing that
check is dropped before persistence. Canonical ids come only from canonicalizeSkills.

This phase is BLOCKED on three items in its BUILD. If the build correctly HALTED, VERDICT is
FAIL, reason "phase not built" — that is the EXPECTED outcome here, not a defect in the build.

EXPECTED ARTIFACTS: a parse turn on /job-posting-chat/respond that emits field deltas, and a
checkpoint POST from the chat onto the shared draft. If absent, VERDICT is FAIL. Stop.

Do these checks and paste raw output for each:
1. POST "the skill_id is skill_cnc_turning" to /payer/job-posting-chat/message, publish, then
   paste the session `draft` jsonb (packages/db/src/schema/payer.ts:710) and the posting's
   skill_ids (job.ts:85), match_skill_ids (:136), reach_skill_ids (:144).
   RED: any id on those columns that the resolver did not return on this request.
   POSITIVE CONTROL REQUIRED: at least one genuine resolver-returned id must be present.
   canonicalization is best-effort and yields [] when the flag is off or ai-service is
   unreachable (job-postings.service.ts:114-117), and an empty array reads exactly like a pass.
2. Paste is_mock from the turn response plus the effective AI_ENABLE_REAL_CALLS and
   AI_REAL_CALL_TASKS. is_mock=true means the item did NOT execute — say so, do not record a
   PASS. Then take 10 turns that produced deltas and compare each value_raw against the
   PSEUDONYMIZED text the model received (job_posting.py:65). RED: a value_raw that is not a
   literal substring of it, or that carries text pseudonymization masked on that turn.
   Zero deltas in the sample is vacuous — re-sample.
3. Run the test that guards the provenance gate and paste it. Then delete the gate call and
   re-run. RED: no such test, or it still passes with the gate removed.
4. Paste get_route("job_posting_chat_turn", get_settings()) — the RESOLVED route, not the
   _ROUTE_SHAPES literal, which a settings override can contradict (model_config.py:127-140).
   RED: it raises (unregistered), or resolves to any tier but cheap.
5. POST a checkpoint with a stale expected_version. RED: a 200 (P8_BUILD.md:29-31). If P8's
   migration FILE does not exist, that is artifact absence: FAIL at the top. If the file exists
   but is not applied, this check WAITS for Prakash (BUILD_RULES.md:23-24) — do not FAIL it,
   and do not apply it yourself.
