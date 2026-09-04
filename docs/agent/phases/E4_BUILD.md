STATUS: SHIPS FIRST — before E1, E2 and E3 (owner ruling R-E3, 2026-09-05). Two items in
this brief are BLOCKED and neither is engineering work: the DPDP notice copy for
`employer_sharing`, and the `CURRENT_CONSENT_VERSION` bump that must land with it. Build
items 1-4, raise item 5's issue, and HALT on items 6-7. Do NOT request the purpose from a
client until the copy exists — see THE ORDER THAT MATTERS.

PHASE E4 — a worker can turn work off, and leaving is as easy as arriving.

WHY THIS RUNS FIRST. `wants` defaults TRUE (packages/db/src/schema/match.ts:59) and is half
the visibility rule (docs/decisions/0036-matching-algorithm-v1.md:27). E2 will put a
worker's supply in front of paying employers. Today the method that turns a skill off
THROWS (apps/api/src/match/worker-skills.service.ts:157-165), so a worker made visible has
no exit but account deletion. That is the owner's stated reason for the order and it is a
property of the design, not of the schedule.

ALREADY TRUE AT HEAD — do not rebuild these, and do not break them:
  - `wants boolean NOT NULL DEFAULT true` (packages/db/src/schema/match.ts:59). R-E2 is the
    SHIPPED default. This phase has nothing to build for R-E2; it has something not to break.
  - The reach driver index is already partial on it — `index("worker_skill_reach_idx")
    .on(t.skillId).where(sql`${t.wants}`)` (packages/db/src/schema/match.ts:79-81). Turning
    `wants` off removes the row from the index, which is what makes the toggle cheap.
  - `employer_sharing` is a real purpose with a real fail-closed gate
    (packages/types/src/index.ts:32; enforced at apps/api/src/unlocks/unlocks.service.ts:71).
    You are NOT creating it.

BUILD THESE FOUR.

  1. IMPLEMENT `setWants`. Replace the throw at
     apps/api/src/match/worker-skills.service.ts:157-165. Its own docblock (`:141-156`)
     already specifies the hard part and it is not the UPDATE:
       (a) the write must reconcile `job_reach` IN THE SAME TRANSACTION as the `wants` flip.
           `reconcileReachForWorker` already exists and is called by the rebuild
           (apps/api/src/match/worker-skills.service.ts:125-126 reads the wanted set back
           from the DB and only then reconciles — do the same here rather than assuming the
           set from the flip you just made).
       (b) the row must be stamped `source='interview'`. That is the one source the coarse
           re-derivation is forbidden to overwrite (packages/db/src/schema/match.ts:26-30) —
           so a worker who says "not this work" is not silently re-proposed by the next
           extraction. Writing `derived_coarse` here would make the toggle undo itself.

  2. A WORKER-AUTHED ENDPOINT + DTO. `WorkerAuthGuard` + `ConsentGuard`, the pair every
     other worker write uses. Register the controller in
     apps/api/src/common/guard-contract.test.ts, which imports every controller in
     `apps/api` and asserts its guard chain — an unregistered controller is not merely
     untested, it is invisible to the one test that proves the guard is on.

  3. A CLEAR-ALL AFFORDANCE, and it is not optional garnish. R-E3's stated reason is that a
     visible worker with no exit has only account deletion. Per-skill toggles do not answer
     that on their own: a worker with eight derived rows would tap eight times, and a
     partial failure leaves him half-visible with no way to tell. ONE call clears every
     `worker_skill` row for the worker and reconciles `job_reach` once. The exit has to be as
     easy as the entry was.

  4. THE EVENT. A visibility change is a business action; `docs/agent/BUILD_RULES.md` and
     CLAUDE.md §3 both make that an event. PII-FREE: an opaque worker id, a closed-set skill
     id and a boolean — never a name, never a phone, never a count of who could see him.
     Reuse the existing spine shape; `worker.match_skills_rebuilt` is the sibling to copy
     (apps/api/src/match/worker-skills.service.ts:207-221).

  5. RAISE A GITHUB ISSUE FOR THE FLUTTER UI, AND STOP. The worker-app screen is
     `apps/worker-app` and CLAUDE.md §6 makes it the mobile owner's work, not yours. Write
     the issue (route, request/response shape, the copy the screen needs) and do not open a
     `.dart` file. Mixing the layers here is the failure §6 exists to prevent.

HALT ON THESE TWO. Collect them and ask; do not choose a sensible-looking default.

  6. THE DPDP NOTICE COPY for `employer_sharing`. It does not exist, and a builder cannot
     write it. The enum's own docblock says so (packages/types/src/index.ts:29-31:
     "Production DPDP notice copy + lawful-basis wording remain a human/legal launch gate"),
     and the consent-version policy says why it matters
     (packages/types/src/index.ts:83-96): "Bumping the version while the app shows the old
     words would record, on every consent row, a claim about what the worker read that is
     simply false."

  7. THE `CURRENT_CONSENT_VERSION` BUMP that must land WITH that copy. It is
     "2026-08-28" today (packages/types/src/index.ts:96). Bumping it without the copy, or
     shipping the copy without bumping it, are both defects and in opposite directions.

THE ORDER THAT MATTERS, and getting it wrong is the whole risk of this phase.
The worker app requests exactly three purposes today — `profiling`, `resume_generation`,
`voice_processing`
(apps/worker-app/lib/features/consent/presentation/cubit/consent_cubit.dart:52-56). The
precedent for adding a fourth is written into that same file at `:49-51`:
`voice_processing` was "added 2026-08-28 (#1270, approved in #1269) ALONGSIDE the DPDP voice
notice copy landing in `consent_screen.dart` — the purpose is only requested once the worker
has actually been shown what it means."

Follow it exactly: **copy first, version bump with it, purpose requested last.** Requesting
`employer_sharing` before the copy ships would record a consent to a sentence no worker was
shown. That is worse than the gap it closes, and it is not undoable — consent rows are
append-only.

THIS IS NOT A NEVER-DO. `docs/agent/BUILD_RULES.md:28` forbids adding anything to
`consent.purposes[]`. You are NOT adding a purpose: `employer_sharing` is already the fifth
member of `CONSENT_PURPOSES` (packages/types/src/index.ts:32), and the array must still hold
exactly EIGHT members when you are done. Requesting an existing purpose from a client is a
different act from minting a new one. If you find yourself editing the array, stop — that IS
the NEVER-DO.

DO NOT TOUCH: apps/ai-service, the profiling orchestrator, the chat service, the trade form
question flow, `pack_answers`, or anything else on the worker conversational path. `setWants`
is a matching-layer write and lives where the rest of the matching layer lives.

NOTHING HERE CAN BE PROVEN AGAINST REAL SUPPLY. The workers on the live database are
testers (owner ruling R-E4, 2026-09-05) and migrated worker data has not been scoped. Every
check for this phase runs against SEEDED LOCAL DATA and says so in its own text.

INVARIANT: a worker who turns a skill off leaves `job_reach` in the same transaction — no
posting can reach him through a skill he has declined. FALSE AT HEAD, because `setWants`
throws and nothing calls it. Making it true is the phase.
