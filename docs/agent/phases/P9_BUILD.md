STATUS: GATE IT — ruled by the owner, 2026-09-04. Verification becomes a hard visibility
gate. Six deliverables are still deleted below; four sub-questions are still open and each
one HALTS the build until answered — see "STILL THE OWNER'S", especially (c), which can
empty the feed on the day it ships.

READ THIS BEFORE YOU WRITE A LINE. **This is a design change, not a bug fix.** Verification
ships today as a BADGE and works correctly as one: the column, the ops verify action and the
worker-visible "Verified job" chip are all live, `job_postings.verification_status`'s own
docblock calls it a badge and "NOT a RANK input", and no read path consults it. You are not
finishing a half-built gate and you are not repairing a bug — you are changing shipped,
working behaviour, on the owner's ruling, because a trust property cannot be retrofitted
after the first bad posting reaches a worker's feed. Anything you find that looks like a
half-finished gate is a badge doing its job. Do not "restore" it.

PHASE P9 — separate publish, verify, and plan.

DELETED. Each line names what removed it.

  verification_status = pending — not a legal value. The DB CHECK
  job_postings_verification_status_chk admits only unverified/verified/rejected
  (packages/db/src/schema/job.ts:271-275, mirroring packages/types/src/index.ts:226).

  emit job_posting.submitted — refused by name at packages/event-schema/src/registry.ts:348-350:
  "There is deliberately NO publish event: publish reuses `job_posting.created` above, emitted by
  the existing `createForPayer` — no second writer." The shipped emitter is job_posting.created
  (registry.ts:312), emitted at job-postings.service.ts:612. Do not add the second writer.

  Razorpay ON WEB -> status = open — posting plans are mock-paid. `grep -rni razorpay
  apps/api/src/posting-plans/` exits 1; `grep -n '"open"' posting-plans.service.ts` exits 1
  against 85 `plan` hits, and :223 reads "Payment is collected (mock) ... the receipt is real".
  Publishing has never been gated on payment. See the INVARIANT.

  applicant_quota stamped at the plan step — shipped under another name.
  posting_plans.applicant_visibility_quota is "the IMMUTABLE original receipt — never mutated
  after purchase" (packages/db/src/schema/payer.ts:444-447), stamped from the catalog quote
  inside buyPlan's one transaction (posting-plans.service.ts:181, 195, 215).

  engine_version stamped at open, and a NEW one per affects_matching edit — deleted by ADR-0036
  §5 (:75). job_reach has five columns and none is a version (packages/db/src/schema/match.ts:141-159).
  engine_version is one GLOBAL match_config value, reserved for a rank-key / bucket / feed-order /
  Related-Skills change with CEO sign-off and its own ADR. What IS stamped per decision is
  applications.engine_version (job.ts:545-547), at apply, frozen.

  affects_matching / source_posting_id as stored fields — the conditional rebuild already ships,
  keyed on the field. job-postings.service.ts:504-506 rebuilds reach on publish or a
  match_skill_ids change and on nothing else. A city edit is accepted (:685-687) and rebuilds
  nothing, because city is a read-time feed filter (match-feed.repository.ts:152-153).

DO NOT DELETE THE CHAT PUBLISH ROUTE. HALT.
  POST /payer/job-posting-chat/sessions/:id/publish is live under PayerAuthGuard
  (job-posting-chat.controller.ts:42, :134), sits in ADR-0035's Accepted endpoint table
  (docs/decisions/0035-ai-job-posting-chat-and-cross-device-drafts.md:3, :205), and both shipped
  clients call it (apps/payer-web/src/lib/payer-api.ts:1515,
  apps/payer-app/lib/core/data/http_payer_api_client.dart:375). Its docblock (:34-36) already
  answers the goal: "It is an INPUT SURFACE, not a second job-creation path" — it calls the same
  createForPayer the manual form uses (job-posting-chat.service.ts:524), and every create lands
  at draft (job-postings.service.ts:601-602). Removal needs, IN ORDER: an ADR superseding
  ADR-0035; a GitHub Issue to the mobile owner (CLAUDE.md §6); both clients shipped off it; then
  the route. The first two are owner acts.

RULED — do not re-open these:
  a. GATE, not badge. Owner ruling 2026-09-04. Where it bites today, so you can find every
     site: `grep -rn 'verification_status\|verificationStatus' apps/api/src --include=*.ts
     | grep -v '\.test\.'` returns 20 lines in 6 files — admin-entities.*, the ops verify writer
     (job-postings.service.ts:314-338), the ops/payer read row (job-postings.repository.ts:72),
     and match-feed.repository.ts:24 saying the column is deliberately NOT projected. No reach
     write and no worker read consults it: jobs.repository.ts:176 and :223 and
     match-feed.repository.ts:143 filter on status='open' alone. admin-web
     jobs/[id]/page.tsx:83-88 prints "Live but unreviewed. This posting is visible to workers"
     — that string becomes false the day the gate lands; raise a Frontend issue, do not edit it
     (CLAUDE.md §6).
  e. The draft store is payer_form_drafts (owner ruling 2026-09-04, ADR-0035 Amendment 1).
     Publish reads from there. P8 builds it; this phase does not.

STILL THE OWNER'S. Each HALTS the build:
  b. WHERE does the gate live? Weigh ADR-0037:56, signed: "Moving the row out of `open` means every
     existing discovery query excludes it with no edit at all." That is precedent for a
     status-based placement over discovery predicates. The owner picks; do not infer one.
  c. Retroactive? Every row defaults 'unverified' (job.ts:95-98). A hard gate empties search and
     the feed at once unless the ruling names a backfill.
  d. Who verifies, through what? POST /job-postings/:id/verify (job-postings.controller.ts:81)
     sits behind the class-level InternalServiceGuard (:34); admin-web has no caller.
  f. May a LIVE posting be edited in place, or must an edit go through a draft? Today it is in
     place (prepareUpdate, job-postings.service.ts:621-724). The deleted source_posting_id reopen
     assumed otherwise. That is a product call, not a builder's.

INVARIANT: an unverified posting is never visible to any worker. Not in the feed, not in
search, not in job_reach, not through a shared link. FALSE AT HEAD — every read filters on
status='open' alone (jobs.repository.ts:176, :223; match-feed.repository.ts:143) and every
row defaults 'unverified' (job.ts:95-98). Making it true is the whole phase.

ALSO PRESERVE (true at HEAD — do not break it while building the gate): money and plan state
never control a posting's discoverability. No plan, payment, or quota is a precondition of ANY
transition into status='open' — the draft->open publish (job-postings.service.ts:626-628), the
paused->open resume (:456), or an admin inventory reinstatement (admin-actions.service.ts:199).
A verification gate is a TRUST gate. If it ends up reachable from a payment state, you have
built a paywall by accident.
