STATUS: REOPENED 2026-09-05 — owner ruling. NOT closed with P0-P12, and NOT part of the
E-chain. This phase runs STANDALONE, sequenced AFTER E4.

WHY IT WAS NOT CLOSED. Closing it would have dropped a trust property by filing error — it
was swept up because no E-phase covers it, which is a fact about the E-chain and not a
judgement about this phase. The ruling here is already SIGNED: verification is a GATE (owner,
2026-09-04). The gate is unbuilt. And an unverified posting is visible to every worker today
— every read filters on `status='open'` alone (apps/api/src/jobs/jobs.repository.ts:176,
:223; apps/api/src/match/match-feed.repository.ts:143) and every row defaults 'unverified'
(packages/db/src/schema/job.ts:95-98).

It does not compete with the E-chain for scope. It competes for SEQUENCE, and it comes after
E4.

STILL BLOCKED ON FOUR OWNER SUB-RULINGS — "STILL THE OWNER'S" below, (b), (c), (d) and (f).
Each halts the build. (c) is the one that can empty the feed and search on the day it ships.

The rest of this file stands as written.

------------------------------------------------------------------------------
PHASE-ID: P9
STATUS: gate-or-badge is RULED (GATE, 2026-09-04) and the draft store is RULED
(payer_form_drafts). FOUR sub-rulings remain open — P9_BUILD "STILL THE OWNER'S" (b), (c),
(d), (f) — and each one halts the build, so a session run today still ends in a HALT.
INVARIANT: an unverified posting is never visible to any worker. It is FALSE at HEAD; making
it true is the phase. Until (b)-(f) are answered, nothing may be built toward it.

EXPECTED ARTIFACT: exactly one — a HALT record naming the four open sub-rulings. Absent code
is NOT "phase not built" here: where the gate lives, whether it is retroactive, who verifies,
and whether a live posting is edited in place are owner acts, so code under apps/ or packages/
is itself the FAIL. A correct run ends VERDICT PASS, reason "phase correctly halted".

0. THE RETROACTIVE TRAP, and it is the one that matters. Every job_postings row defaults
   'unverified' (packages/db/src/schema/job.ts:95-98). Confirm the build did NOT ship a gate
   without a backfill ruling: `psql -c "SELECT verification_status, count(*) FROM job_postings
   GROUP BY 1"`. If a gate is live and the unverified count is non-zero, the feed and search
   are empty for every worker — report it as a production incident, not a FAIL.

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
