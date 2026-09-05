STATUS: CLOSED 2026-09-05 — superseded by the E-chain (docs/decisions/E_CHAIN_DESIGN_2026-09.md).
Do not build from this file without reopening the phase.

NOTHING SURVIVES THIS CLOSURE. Every deliverable is either shipped, deleted by a signed
ruling, or carried by an E-phase. Checked adversarially, not assumed.

------------------------------------------------------------------------------
STATUS: CLOSED — both deliverables are deleted by signed rulings. Nothing to build.
Do not open a branch. ONE OPEN ITEM, and it is a signature, not a build: ADR-0036:97 flags
the PACE retirement "for explicit owner acknowledgement", still open at
docs/registers/team-decisions.md:282.

PHASE P7 — closed.

1. "Turn on PACE" — DELETED by ADR-0036 (Accepted 2026-07-31, unsuperseded).
   docs/decisions/0036-matching-algorithm-v1.md:97 — PACE retires with the weighted engine:
   its supply measure is the `hot` count (apps/api/src/pace/pace.service.ts:195) and `hot`
   does not exist in V1, and its auto-widening contradicts V1's frozen-reach rule. The code
   already records this at apps/api/src/pace/pace.controller.ts:32-34.
   PACE_ENABLED ships default false — packages/config/src/server.ts:1229 (`booleanFromString`,
   `.default(false)` at packages/config/src/shared.ts:7), read at server.ts:1750-1751.
   One deployed declaration only: docker-compose.staging.yml:419 `${PACE_ENABLED:-false}`.

   ADR-0036:97 names three replacements. ALL THREE SHIP:
   - E13 pre-pay zero-reach warning — POST /payer/match/reach-preview
     (apps/api/src/match/match-skills.controller.ts:43) → match-skills.service.ts:162
     `zero_reach: reachTotal === 0`, surfaced BEFORE publish at payer-web
     postings/new/posting-form.tsx:417 and match-skill-picker.tsx:221, and payer-app
     match_skill_picker.dart:156.
   - E12/E13 ops alert — apps/api/src/match/publish-reach.service.ts:391-421
     `emitAlertIfShort`, emitting `job_posting.reach_alert` with reason
     `zero_reach` | `no_tier1_reach`, idempotent per (posting, reason). Payload at
     packages/event-schema/src/payloads.ts:3043-3052.
   - The audited, expiring ops-widen — POST /job-postings/:id/reach/widen at
     apps/api/src/job-postings/job-postings.controller.ts:124. `@UseGuards(AdminAuthGuard)`
     (:126) sits ON TOP OF the class-level `InternalServiceGuard` (:34) — BOTH are required,
     pinned as `widenReach: [A, I]` at apps/api/src/common/guard-contract.test.ts:223. The
     route passes `admin.id` at :133. Provenance table `job_reach_widen` with
     `ops_actor_id` NOT NULL (packages/db/src/schema/match.ts:220, migration
     packages/db/migrations/0090_chemical_sersi.sql:32). Expiry from
     `match_config.widen_expiry_hours`, default 720 (packages/match-engine/src/config.ts:72),
     swept by apps/api/src/match/reach-widen-expiry-sweep.processor.ts. Events
     packages/event-schema/src/registry.ts:752 and :943.
   That reach is audited and it expires. PACE's was neither. There is nothing to turn on.

2. "Push floor 40 out of 100" — DELETED TWICE. The 2026-07-31 owner ruling retires
   `pushFloor` with the ledger and `hot` (docs/registers/team-decisions.md:249-251).
   ADR-0034:16-17 rules push scope SECURITY ALERTS ONLY, so `job.available` is
   `push: false, // deferred` (apps/api/src/notifications/notifications.dto.ts:159) — there
   is no job push for a floor to gate. Do not wire it, do not port it.
   DO NOT ADD A FLOOR TO THE PUSH PROCESSOR. `PushJobData` carries workerId, sourceEventId,
   eventName, deviceIds — no score, no job (apps/api/src/queue/queue.constants.ts:111-119) —
   and queue.constants.ts:106 puts targeting with the producer.

P5/P7 COLLISION — DISSOLVED. It rested on PACE's `hot` supply count; ADR-0036 retires both.

NOT THIS PHASE: deleting apps/api/src/pace/. ADR-0036 defers the old engine's removal to a
separate retirement change after the cutover. PaceModule is still in the live graph
(apps/api/src/app.module.ts:102), inert on two default-false flags.

INVARIANT: a posting's approved reach set is widened only through the admin-guarded ops
           route, which records the authenticated admin's own id and an expiry — never by
           a scheduler, a queue processor, or a feature flag.
