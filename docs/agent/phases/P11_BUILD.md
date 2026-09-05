STATUS: CLOSED 2026-09-05 — superseded by the E-chain (docs/decisions/E_CHAIN_DESIGN_2026-09.md).
Do not build from this file without reopening the phase.

WHAT NO E-PHASE COVERS — dropped visibly, not quietly. Each survived an adversarial
refutation pass (already-ships / an-E-phase-covers-it / a-signed-ruling-deleted-it):
  - The posting-chat provenance gate and its failing test — every value written into a
    draft must be a literal substring of the pseudonymized message the model saw, and a
    failing delta is dropped before persistence.

------------------------------------------------------------------------------
STATUS: BLOCKED. Do not start. Three things must be settled first.
  1. P8 AND P10 ARE NOT BUILT. job_posting_drafts, job_posting_draft_checkpoints and the
     checkpoint POST are P8's (P8_BUILD.md:16-31); the form half is P10's (P10_BUILD.md:1-12).
     docs/qa/evidence holds only P0 and PX, so P8, P9 and P10 have no VERDICT and
     docs/agent/README.md:47 forbids starting this phase.
  2. OWNER ITEM — REJECT or DROP, and does the filter touch text the PAYER typed? The shipped
     worker-side mechanism DROPS and keeps going (apps/ai-service/app/profiling/
     profile_extractor.py:328 — "A **DROP, never a raise.**"), and it filters by SHAPE, not
     origin (:297), so it would also drop an id-shaped phrase a payer typed himself.
     BUILD_RULES.md:41 routes a spec-versus-code conflict to HALT. Do not pick one.
  3. OWNER ITEM — /job-posting-chat/respond makes ZERO LLM CALLS on every path today
     (apps/ai-service/app/routers/job_posting.py:114, is_mock=True at :130). The payer surface
     ALREADY spends on models: one billable embed per skill phrase at publish
     (apps/api/src/job-postings/job-postings.service.ts:163-166,180). What is NEW is a
     GENERATIVE call on a conversational turn. That is a posture call, not a build detail.

PHASE P11 — the posting chat becomes a parser, not a writer. Build only after all three clear.

Work in apps/ai-service and apps/api.

  payer types something
    -> the turn emits deltas:
       { field_id, value_raw, value_normalized, confidence, evidence_span }
    -> the chat POSTs a checkpoint onto the SHARED draft

field_id is one of the JobPostingDraft field names (apps/ai-service/app/contracts.py:1531-1544).
Do not invent a vocabulary. Draft `confidence` is a DETERMINISTIC coverage ratio, never a model
score (:1545-1547) — do not emit a per-delta model score without a ruling.

THE DELTA DOES NOT FIT P8'S ENDPOINT. P8's checkpoint row is (draft_id, seq, step_id,
payload_delta, client, member_id, idempotency_key), and expected_version is mandatory — "Never
return 200" on a mismatch (P8_BUILD.md:22-31). The delta carries none of those three, and a
free-text turn has no step. Which step_id it maps to is an owner question.

"identical to pack_answers" means AnswerRecordSchema (packages/ai-contracts/src/oie.ts:182):
target_field, value_raw, value_normalized, evidence — `confidence` is NOT on it. The persisted
worker_pack_answer table (packages/db/src/schema/pack-answer.ts:94,100-107) shares no column
with it. Do not reuse that table.

HARD RULES:
  - Ids come from canonicalizeSkills, never from model output. It already runs on BOTH payer
    entry points (apps/api/src/job-postings/job-postings.service.ts:367 and :396) and keeps
    only an id the vector layer returned (:215, SG-3 at :116). REUSE IT.
  - match_skill_ids is CLIENT-SUPPLIED (apps/api/src/job-postings/job-postings.dto.ts:151) and
    checked only for closed-set membership (apps/api/src/match/match-skills.service.ts:191-197),
    so a genuine mskill_* copied out of model output passes. Never source it from a model.
  - There is no posting-side ROLE vocabulary. The draft carries free-text role_title
    (contracts.py:1531). Do not invent one here.
  - Every delta carries an evidence_span, and value_raw must be a literal substring of the
    PSEUDONYMIZED message the model was given (job_posting.py:65) — not the raw text stored at
    apps/api/src/payer-portal/job-posting-chat/job-posting-chat.service.ts:190. This is a NEW
    gate, modelled on check_provenance (apps/ai-service/app/profiling/parse_gates.py:150),
    which checks evidence.quote and never value_raw.

COST: cheap tier — default_cheap_model "gemini-2.5-flash-lite" (apps/ai-service/app/config.py:326).
Register job_posting_chat_turn in _ROUTE_SHAPES first: get_route RAISES on an unknown task type
(model_config.py:127,129), which is exactly why the seam is unwired (job_posting.py:114-121).
THERE IS NO PER-PROFILE CAP. Rs 15/20 are TARGET/ALERT only (config.py:503-507); the hard stops
are ai_max_call_cost_inr 10 (:510), ai_max_user_daily_cost_inr 25 (:533), global 200 (:520).
State which tier you chose and why.

SHIP A TEST THAT FAILS WHEN THE GATE BREAKS — an invariant with no such test is a FAIL
(CHECK_RULES.md). Give it a vacuity guard in the shape of
apps/ai-service/tests/test_parse_gates.py:523-529.

INVARIANT: every value the chat writes into a draft is text the payer typed — value_raw is a
literal substring of the pseudonymized message its evidence_span cites, and a delta failing that
check is dropped before persistence. Canonical ids come only from canonicalizeSkills.
