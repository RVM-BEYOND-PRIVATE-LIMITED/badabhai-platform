PHASE-ID: P7
INVARIANT: a posting's approved reach set is widened only through the admin-guarded ops
           route, which records the authenticated admin's own id and an expiry — never by
           a scheduler, a queue processor, or a feature flag.

EXPECTED ARTIFACTS: NONE. Both deliverables were deleted by signed rulings. Do NOT write
FAIL "phase not built" — absence of code IS the expected result. A code change attributable
to P7 is itself a FAIL.

Do these checks and paste raw output for each:
1. INVARIANT test. `pnpm --filter @badabhai/api run test guard-contract`
   FAIL if red, or if apps/api/src/common/guard-contract.test.ts:223 no longer pins
   `widenReach: [A, I]`. Read job-postings.controller.ts:124-133 and :34 — FAIL if
   `@UseGuards(AdminAuthGuard)` (:126) or the class-level `InternalServiceGuard` (:34) is
   gone, or if :133 passes anything other than `admin.id`.
2. No system widen.
   `grep -rn "opsWiden" apps packages --include=*.ts | grep -v "\.test\." | grep -v /dist/`
   Today exactly five lines: job-postings.controller.ts:121 (a doc comment), :133,
   job-postings.service.ts:575 and :581, publish-reach.service.ts:162. FAIL on any new call
   site — a scheduler, a queue processor, a cron, or a re-armed PACE.
3. The widen stays audited and expiring. Read packages/db/src/schema/match.ts:220 — FAIL if
   `opsActorId` loses `.notNull()`. `grep -rn "job_reach_widen" packages/db/migrations/*.sql`
   — today only 0090; FAIL if a later migration ALTERs that column. Read
   packages/match-engine/src/config.ts:72 — FAIL if the 720 default is dropped. Read
   packages/event-schema/src/registry.ts:752 and :943 — FAIL if either widen event is gone.
4. PACE stays off. Read packages/config/src/server.ts:1229 and packages/config/src/shared.ts:7
   — FAIL if the schema default is no longer false. Then
   `grep -rn "PACE_ENABLED" --include=*.yml --include=*.yaml --include=*.example apps packages docker-compose*.yml .github`
   Today one hit: docker-compose.staging.yml:419 `${PACE_ENABLED:-false}`. FAIL if any
   deployed declaration or env file sets it true. Unit fixtures set it true deliberately
   (pace.service.test.ts:14) — that is not a failure.
5. No push floor was added.
   `grep -rniE "score|pushfloor|push_floor|pusheligible|threshold" apps/api/src/push apps/api/src/notifications --include=*.ts | grep -v "\.test\.ts"`
   Zero hits today. FAIL on any hit that is a live code path (prose in a comment is not).
   Read apps/api/src/queue/queue.constants.ts:111-119 — FAIL if `PushJobData` gained a
   score, rank or jobId field.
6. The three replacements still ship. Read match-skills.service.ts:162
   (`zero_reach: reachTotal === 0`) and payer-web postings/new/posting-form.tsx:417 — FAIL
   if the preview stops returning `zero_reach` or the composer stops surfacing it before
   publish. Then
   `pnpm --filter @badabhai/api run test publish-reach.service --reporter=verbose`
   and `grep -n "^describe(" apps/api/src/match/publish-reach.service.test.ts` — FAIL if the
   run is red, or if the suites at :406 (E12/E13 alert), :461 (opsWiden) or :624
   (retractExpiredWidens) are missing from that grep.

Record in "What I could not verify": the PACE retirement acknowledgement ADR-0036:97 asks
for is still open (docs/registers/team-decisions.md:282).
