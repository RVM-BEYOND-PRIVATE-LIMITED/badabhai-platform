STATUS: PARTLY BUILT. One question is UNSIGNED and is on this line: **does `job_postings`
gain a `trade_key`, or is the posted match skill the role?** This brief is written for the
second answer (ADR-0036 §3 — see THE ROLE QUESTION). If the owner rules the other way, stop
and ask for a rewrite; do not build both. Everything else here is unblocked.

PHASE E1 — the posting form asks once, and every answer reaches the row.

WHAT IS ALREADY BUILT. Do not rebuild any of it.
  - The form collects all nine fields, `tradeKey`, pay and the experience window included:
    apps/payer-web/src/app/(portal)/postings/new/posting-form.tsx:40-49.
  - A server-served closed skill vocabulary already exists: `GET /payer/match/skills` under
    `PayerAuthGuard` (apps/api/src/match/match-skills.controller.ts:29, :34), built at
    apps/api/src/match/match-skills.service.ts:97-106.
  - The related skills already arrive PRE-TICKED with a live reach count
    (apps/payer-web/src/app/(portal)/postings/new/match-skill-picker.tsx:8-33). "The skills
    shown are the ones relevant to the role picked" is HALF SHIPPED — what is missing is the
    scoping of the pick-list itself, not the relation logic.
  - The wider PATCH already accepts `city`, `pay_min`, `pay_max`, `shift`, `needed_by`,
    `match_skill_ids` and `unticked_related_ids`
    (apps/api/src/job-postings/job-postings.dto.ts:122-172).

THE DEFECT, in the code's own words. The action validates `tradeKey`, `payMin`, `payMax`,
`minExperienceYears` and `maxExperienceYears`
(apps/payer-web/src/app/(portal)/postings/new/actions.ts:45-53) and then hands them to a
mapper that builds a body of `org_label` + `role_title` + `vacancies` + two optional labels
(apps/payer-web/src/lib/payer-api.ts:1036-1046). The comment that admits it is at
apps/payer-web/src/lib/payer-api.ts:1029-1033: *"trade/pay/exp are NOT included … Those
three stay collected-for-parity but unsent here … trade/exp are accepted by neither
schema."* Five fields are typed by a payer, validated twice, and dropped.

BUILD THESE FIVE.

  1. WIDEN `PayerCreateJobPostingSchema`
     (apps/api/src/job-postings/job-postings.dto.ts:95-107, seven fields today) to accept
     everything the payer answered: `city`, `pay_min`, `pay_max`, `shift`, `needed_by`,
     `match_skill_ids`, `unticked_related_ids`, `status: "open"`, and the experience window
     from item 3. Every one of those already exists on `UpdateJobPostingSchema` (`:122-172`)
     with a validated shape — REUSE those field definitions rather than re-declaring them.
     Two schemas that disagree about `pay_max >= pay_min` is the defect this creates if you
     hand-copy instead of reuse.

  2. ONE CALL, AND REUSE THE PUBLISH PATH RATHER THAN COPYING IT.
     `createForPayer` (apps/api/src/job-postings/job-postings.service.ts:350-371) inserts and
     stops; every create lands at `draft`
     (apps/api/src/job-postings/job-postings.service.ts:602). Publishing, the `draft → open`
     transition, the reach materialization and the E13 zero-reach alert all live in ONE
     place — `materializeIfNeeded`
     (apps/api/src/job-postings/job-postings.service.ts:497-526), reached from
     `updateForPayer` (`:407`).
     So: when the create body carries `match_skill_ids` and `status: "open"`, insert the
     draft and then run the SAME update path, in one request. Do NOT write a second publish
     that duplicates the transition, the trigger or the E13 refusal — three things currently
     proven in one place, and a second copy is how they drift.
     A FAILURE BETWEEN THE TWO WRITES LEAVES A DRAFT, and that is the correct outcome. The
     client already reports it honestly and must keep doing so
     (apps/payer-web/src/app/(portal)/postings/new/actions.ts:25-26: *"A FAILED PUBLISH IS
     REPORTED AS A DRAFT, NOT AS A FAILURE"*) — claiming the create failed invites a retry
     that creates a second posting.

  3. THE EXPERIENCE WINDOW NEEDS A MIGRATION. `job_postings` has no
     `min_experience_years` / `max_experience_years`; those columns are on the LEGACY `jobs`
     table (packages/db/src/schema/job.ts:429-430, inside `jobs` which opens at `:391`).
     Add them to `job_postings`: nullable integers, additive, plus the two CHECK constraints
     `jobs` already carries and for the same reasons — non-negative
     (packages/db/src/schema/job.ts:469-471) and max-not-below-min (`:473-474`). Copy the
     shape; do not invent a third spelling of the same rule.
     WRITE THE MIGRATION FILE ONLY. `docs/agent/BUILD_RULES.md:21` — no `db:push`, no
     `drizzle-kit migrate`, no psql DDL, not even to test. Prakash applies it between the
     build session and the check session.
     NUMBERING, AND IT IS A LIVE HAZARD RATHER THAN A COLLISION TODAY: `main` stops at
     `packages/db/migrations/0098_worker_qualifications.sql`, so 0099 is technically free.
     It is NOT free in practice — `0099_overrated_fantastic_four.sql` exists on
     `origin/p1-matching-catalog` (still at a454fac0), whose PR **#1387 is CLOSED, not merged**
     (closed 2026-09-04). That branch carries real, finished work the owner may revive, and if
     it is revived after you take 0099 the two collide with no error — the second one is simply
     skipped. Take 0100. It costs nothing and removes the hazard. Do not hand-edit `packages/db/migrations/meta/_journal.json`'s `when` —
     drizzle skips any entry below the recorded maximum, so a hand-set timestamp silently
     strands every later migration.

  4. THE ROLE DROPDOWN BECOMES SERVER-SERVED. `TRADE_KEYS` is fifteen values compiled into
     payer-web (apps/payer-web/src/lib/contracts.ts:70-86); `MATCH_SKILLS` is eighteen and is
     what the backend actually matches on (packages/taxonomy/src/match-skills.ts:68). Two
     lists, neither derived from the other, and only one of them can reach a worker.
     Serve the dropdown from `GET /payer/match/skills` and delete the `TRADE_KEYS` use from
     the posting form. **Do not delete the constant itself**: `tradeKeySchema` is also the
     agency job form's enum, which is a different entity on a different table
     (`toAgencyJobBody`, apps/payer-web/src/lib/payer-api.ts:596-608). Removing it would
     break a surface this phase was not asked to touch.

  5. ROLE-SCOPE THE SKILL PICK-LIST. The picker renders all eighteen today. `MATCH_SKILLS`
     carries a `domainId` (packages/taxonomy/src/match-skills.ts:42-50) that `MatchSkillDto`
     drops (apps/api/src/match/match-skills.service.ts:16-22), so the server cannot currently
     express "these skills belong to that role". Add `domain_id` to the DTO — additive, one
     field, no new source of truth — and scope the pick-list to the chosen role's domain.
     THE RELATED SKILLS ARE NOT SCOPED BY THIS. They come from `RELATED_MATCH_SKILLS`, a
     curated map, and Policy 10 gives the company breadth only WITHIN it. Filtering the
     curated relations by domain would silently narrow a reach set the payer was promised —
     scope the LIST YOU PICK FROM, never the relations a pick brings with it.

  6. THE TEST YOU ARE ABOUT TO TRIP, and it is not a licence to delete it.
     apps/payer-web/src/lib/posting-seam.test.ts is a CONTRACT MIRROR of the two backend
     schemas. It hardcodes the six accepted create keys in `ALLOWED_KEYS` (`:22-30`), asserts
     `"every emitted key is in the PayerCreateJobPostingSchema accepted set"` (`:100`), and —
     the one that will fail first — asserts `"does NOT leak the not-yet-accepted demand
     fields (trade/pay/exp)"` (`:93`). Item 1 makes that test's premise false ON PURPOSE.
     UPDATE it: widen `ALLOWED_KEYS` to the new schema and REWRITE `:93` into its inverse —
     the create body now MUST carry pay and the experience window, and a body that omits them
     is the failure. Keep the test count and keep the file.
     DELETING OR `.skip`-ING EITHER TEST IS THE NEVER-DO at `docs/agent/BUILD_RULES.md:25`,
     and the difference is exactly this: a contract mirror is updated WITH the contract it
     mirrors, and it is never removed so a suite goes green. If you cannot state which
     contract changed and why, you are deleting rather than updating.

THE ROLE QUESTION, and why this brief answers it the way it does.
ADR-0036 §3 (docs/decisions/0036-matching-algorithm-v1.md:65) is explicit: *"V1's 'Skill' is
what a company posts a job for (CNC Turner, VMC Operator) — role-level."* So the posted match
skill IS the role, and adding a `trade_key` column would give one posting TWO role
vocabularies that nothing reconciles — the exact "two sources for one closed set" condition
P1 exists to prevent. This brief therefore sends `match_skill_ids` and does NOT add
`trade_key`. If the owner rules otherwise, the cost is a migration plus a `TRADE_KEYS` (15) →
`MATCH_SKILLS` (18) mapping that nobody has drafted, and this brief needs rewriting rather
than extending.

NEVER DO, and each is a full stop:
  - Run the migration. Write the file (`docs/agent/BUILD_RULES.md:21`).
  - Let anything money-shaped become a precondition of `status='open'`. No plan, payment,
    credit or quota gates any transition into open today — the publish
    (apps/api/src/job-postings/job-postings.service.ts:497-526), the resume (`:478`) and the
    admin reinstatement are all money-blind. Widening the create schema is exactly where a
    paywall gets built by accident.
  - Add a second publish route, or a second writer of `job_posting.created`. The event
    registry refuses a publish event by name and says why
    (packages/event-schema/src/registry.ts:349-350).
  - Touch `POST /payer/job-posting-chat/sessions/:id/publish`. It is an ADR-0035 endpoint
    with two shipped clients; removing it needs a superseding ADR and a mobile issue first.

DO NOT TOUCH: apps/ai-service, the profiling orchestrator, the chat service, the trade form
question flow, `pack_answers`, the worker conversational path. Also out of scope:
`MATCH_V1_ENABLED`, widening `MATCH_SKILLS` past eighteen, and `job_domain_id`'s hardcoded
`"cnc-machining"` anchor (apps/api/src/job-postings/job-postings.service.ts:46) — that one is
real and it is not yours.

NOTHING HERE CAN BE PROVEN AGAINST REAL SUPPLY. The workers on the live database are
testers (owner ruling R-E4, 2026-09-05). A reach count this phase produces is a count over
SEEDED LOCAL DATA and every check says so in its own text.

INVARIANT: every field the posting form collects reaches `job_postings` in the same
submission — nothing is validated and then dropped. FALSE AT HEAD for five fields
(`tradeKey`, `payMin`, `payMax`, `minExperienceYears`, `maxExperienceYears`), by the
admission at apps/payer-web/src/lib/payer-api.ts:1029-1033. Making it true is the phase.
