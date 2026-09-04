PHASE-ID: P9
STATUS: BLOCKED ON AN UNSIGNED OWNER RULING (P9_BUILD, "THE OWNER MUST RULE").
INVARIANT: no plan, payment, or quota is a precondition of ANY transition into status='open'.

EXPECTED ARTIFACT: exactly one — a HALT record naming those rulings. Absent code is NOT "phase
not built" here: the gate design, the ADR-0035 supersede and the draft-store choice are owner
acts, so code under apps/ or packages/ is itself the FAIL. A correct run ends VERDICT PASS,
reason "phase correctly halted".

CONVENTION: every grep below PASSES on zero matches, and grep exits 1 on zero matches. Do not
run them under `set -e`. Paste raw output AND the exit code for each.

1. git diff --stat $(git merge-base origin/main HEAD)..HEAD -- apps/api/src/job-postings
   apps/api/src/posting-plans apps/api/src/match apps/api/src/payer-portal
   packages/db/migrations packages/event-schema. FAIL: any file listed — built through a HALT.
2. The chat publish route survives, and both clients still call it:
   grep -n 'sessions/:id/publish' apps/api/src/payer-portal/job-posting-chat/job-posting-chat.controller.ts (expect 134)
   grep -n 'sessions/${sessionId}/publish' apps/payer-web/src/lib/payer-api.ts (expect 1515)
   grep -n 'sessions/$sessionId/publish' apps/payer-app/lib/core/data/http_payer_api_client.dart (expect 375)
   FAIL: any of the three exits 1 — an ADR-0035 endpoint removed with no superseding ADR. Do NOT
   grep the prefix 'job-posting-chat/sessions': list and messages match it too, so it stays green
   after publish is deleted.
3. INVARIANT, three greps. (i) grep -ni 'plan\|payment\|razorpay\|quota'
   apps/api/src/job-postings/job-postings.service.ts — whole file, zero hits today.
   (ii) grep -n '"open"' apps/api/src/posting-plans/posting-plans.service.ts — zero (control:
   grep -c plan on that file = 85). (iii) grep -n 'this.plans\.'
   apps/api/src/payer-portal/payer-job-postings.controller.ts — exactly :80, :186, :203, :224.
   FAIL: any hit in (i) or (ii), a fifth this.plans. call, or any this.plans. inside the
   @Patch(":id") handler at :125 — money now moves a posting into open.
4. No publish event was added. grep -rn 'job_posting.submitted\|job_posting.published'
   packages/event-schema/src. FAIL: any hit (registry.ts:348-350 refuses it). Control:
   job_posting.verification_updated is at registry.ts:338.
5. No verification gate appeared. grep -rn 'verification_status\|verificationStatus' apps/api/src
   --include=*.ts | grep -v '\.test\.' must return the same 20 lines in the same 6 files as at
   the phase base (admin-entities.{dto,repository,service}.ts, job-postings.repository.ts,
   job-postings.service.ts, match-feed.repository.ts). FAIL: a hit in publish-reach.service.ts,
   reach-widen.repository.ts, reach-widen-expiry-sweep.processor.ts, jobs.repository.ts, or
   inside match-feed's SQL predicate — a ruling settled by default.
6. Against the schema Prakash applied: \d job_reach. Expect exactly job_posting_id, worker_id,
   match_tier, matched_skill_id, computed_at plus job_reach_match_tier_chk IN (1,2). FAIL: any
   sixth column (version, score, role, verification). If psql reports no such relation, this item
   is NOT EXECUTABLE — write that; do not record a PASS.
7. \d job_postings. job_postings_verification_status_chk must exist and admit exactly unverified,
   verified, rejected — psql renders it `= ANY (ARRAY[...])`; that is the same constraint. FAIL:
   missing, or a fourth value ('pending'). Same not-executable rule as 6.
