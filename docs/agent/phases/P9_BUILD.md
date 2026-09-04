STATUS: BLOCKED ON AN UNSIGNED OWNER RULING. Do not start. Six deliverables are deleted
below. What is left — a verification GATE — is a design change, not a bug fix; building it
settles a ruling the owner has not made. BUILD_RULES:41 HALT.

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

THE OWNER MUST RULE, before any of this is buildable:
  a. GATE or BADGE? `grep -rn 'verification_status\|verificationStatus' apps/api/src --include=*.ts
     | grep -v '\.test\.'` returns 20 lines in 6 files — admin-entities.*, the ops verify writer
     (job-postings.service.ts:314-338), the ops/payer read row (job-postings.repository.ts:72),
     and match-feed.repository.ts:24 saying the column is deliberately NOT projected. No reach
     write and no worker read consults it: jobs.repository.ts:176 and :223 and
     match-feed.repository.ts:143 filter on status='open' alone. admin-web jobs/[id]/page.tsx:83-88
     prints "Live but unreviewed. This posting is visible to workers". A gate is a design change.
  b. If a gate, WHERE? Weigh ADR-0037:56, signed: "Moving the row out of `open` means every
     existing discovery query excludes it with no edit at all." That is precedent for a
     status-based placement over discovery predicates. The owner picks; do not infer one.
  c. Retroactive? Every row defaults 'unverified' (job.ts:95-98). A hard gate empties search and
     the feed at once unless the ruling names a backfill.
  d. Who verifies, through what? POST /job-postings/:id/verify (job-postings.controller.ts:81)
     sits behind the class-level InternalServiceGuard (:34); admin-web has no caller.
  e. Publish FROM which draft store? job_posting_drafts does not exist.
     payer_job_posting_chat_sessions.draft has a draft_ready->published lifecycle
     (packages/db/src/schema/payer.ts:687, 710, 713); payer_form_drafts (:775) is unclaimed
     scaffolding whose own note (:765-771) says a claim needs an ADR. P8 is briefed to build a
     third and is itself blocked on PR #1387.
  f. May a LIVE posting be edited in place, or must an edit go through a draft? Today it is in
     place (prepareUpdate, job-postings.service.ts:621-724). The deleted source_posting_id reopen
     assumed otherwise. That is a product call, not a builder's.

INVARIANT (preservation — true at HEAD, so this phase owes no work on it): money and plan state
never control a posting's discoverability. No plan, payment, or quota is a precondition of ANY
transition into status='open' — the draft->open publish (job-postings.service.ts:626-628), the
paused->open resume (:456), or an admin inventory reinstatement (admin-actions.service.ts:199).
