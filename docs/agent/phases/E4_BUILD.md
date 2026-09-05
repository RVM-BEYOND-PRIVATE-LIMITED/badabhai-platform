STATUS: SHIPS SECOND, AFTER E0 — then E1, then E2 (owner ruling 2026-09-05, CORRECTING R-E3
of the same day, which put this phase first). WHY IT MOVED: R-E3's reason was that a
visible-by-default worker needs a working exit before a contact channel exists. That premise
is false as this brief was written — `wants` is absent from the unlock ladder, so the exit
built here does not reach a live unlock, and E0-after-E4 would still land messages on workers
who cannot stop them (docs/decisions/E0_RELAY_DECISION_2026-09.md §C finding 3). The exit
R-E3 wanted is now E0's blocking conditions C-2 and C-3; this phase keeps the findability
half. See WHAT THIS EXIT DOES NOT DO below.
ONE MORE THING NOW LANDS WITH THIS PHASE'S NOTICE COPY: a NINTH consent purpose for messaging
(owner ruling 2026-09-05, §A of that note). See item 6. Two items in
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

WHAT THIS EXIT DOES NOT DO, measured 2026-09-05 and added here because this brief implied
otherwise. `wants` appears ZERO times in apps/api/src/unlocks/unlocks.service.ts — it is not
in the fail-closed ladder (`:67-78`). So `setWants(false)`, and the clear-all in item 3, end
FINDABILITY and do not end CONTACT: a payer who already unlocked the worker keeps his
14-day window (packages/db/src/credit-packs.ts:101), and once E0 lands he keeps a live relay
through it. The exit from contact is a per-purpose withdrawal of `employer_sharing`, which
does not exist — `POST /consent/withdraw` is all-or-nothing and also revokes every session
(apps/api/src/consent/consent.service.ts:67-72). That gap is E0's to close, not this phase's:
see docs/decisions/E0_RELAY_DECISION_2026-09.md §C, findings 3-4. Do not widen this phase to
cover it, and do not write copy for the item 5 issue that claims the toggle stops employers
contacting him.

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

  6. THE DPDP NOTICE COPY for `employer_sharing` AND FOR THE NINTH, MESSAGING PURPOSE.
     Neither exists, and a builder cannot write either. The ninth purpose is an owner ruling
     of 2026-09-05 (docs/decisions/E0_RELAY_DECISION_2026-09.md §A): `employer_sharing`
     authorises DISCLOSURE only, messaging gets its own basis, and it lands in THIS notice
     rather than a later one because no worker holds `employer_sharing` today — so the
     re-consent this phase already owes is the only one anybody has to run. A second notice
     later would mean re-consenting a base that had already opted in once, which is the
     `model_training` mistake (packages/types/src/index.ts:23-24) made twice.
     The proposed string is `employer_messaging` and the OWNER mints it; if it is not in
     `CONSENT_PURPOSES` when you build, HALT — adding it yourself is the NEVER-DO
     (docs/agent/BUILD_RULES.md:28), however obviously correct the string looks. The enum's own docblock says so (packages/types/src/index.ts:29-31:
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
member of `CONSENT_PURPOSES` (packages/types/src/index.ts:32). Requesting an existing purpose
from a client is a different act from minting a new one. If you find yourself editing the
array, stop — that IS the NEVER-DO, and it is still the NEVER-DO for the ninth purpose the
owner ruled in: the OWNER mints that string, and your job is to request it from the client
once its copy exists.
COUNT CHECK, CORRECTED 2026-09-05: this brief previously said the array must still hold
EIGHT members when you are done. Under the §A ruling it holds NINE. If it holds eight when
you go to request the messaging purpose, the owner has not minted it yet — HALT.

DO NOT TOUCH: apps/ai-service, the profiling orchestrator, the chat service, the trade form
question flow, `pack_answers`, or anything else on the worker conversational path. `setWants`
is a matching-layer write and lives where the rest of the matching layer lives.

NOTHING HERE CAN BE PROVEN AGAINST REAL SUPPLY. The workers on the live database are
testers (owner ruling R-E4, 2026-09-05) and migrated worker data has not been scoped. Every
check for this phase runs against SEEDED LOCAL DATA and says so in its own text.

INVARIANT: a worker who turns a skill off leaves `job_reach` in the same transaction — no
posting can reach him through a skill he has declined. FALSE AT HEAD, because `setWants`
throws and nothing calls it. Making it true is the phase.
