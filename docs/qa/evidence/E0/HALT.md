# E0 — HALT

**Session:** build, 2026-09-07. **Base:** `e444030a` (= `origin/main`, no delta).
**Worktree:** cut from `origin/main`. **Outcome:** HALT — BUILD_RULES' third outcome.
**E0 is UNPROVEN.** No relay was built. Nothing resolves a handle at the end of this session
that did not resolve one at the start.

The instruction for this session was: *"MEASURE BEFORE YOU BUILD. Three consecutive sessions
found the brief's premise wrong… If any measurement contradicts E0_BUILD's premises, STOP and
report rather than building around it."* Four measurements ran. Several premises are wrong, and
**two of them are independent HALTs that the owner reserved to himself.** This is the report.

---

## HALT 1 — C-1: the versioning precedent the owner named does not exist

The owner ruled C-1 and closed it with a condition:

> Ruling: make `job_id` OPTIONAL on the payload… **Version the payload rather than mutating it
> in place, following the `profile.form_completed` precedent. If that precedent does not apply,
> HALT and show me why.**

**It does not apply. `profile.form_completed` has no version history.**

```
$ grep -rn "form_completed" packages/event-schema/src/
packages/event-schema/src/registry.ts:982:  "profile.form_completed": {
```

One registry entry, `version: 1`, introduced in a single commit and never amended. No v2, no
superseded payload, so no precedent for an additive versioned change.

**A real precedent exists and was used twice** — but it decides the opposite of what the ruling
assumes:

```
$ grep -rn "_v2\"" packages/event-schema/src/registry.ts
packages/event-schema/src/registry.ts:783:  "feed.shown_v2": {
packages/event-schema/src/registry.ts:915:  "skill.phrase_unresolved_v2": {
```

Both mint a **NEW NAME** with a `_v2` suffix, `version: 2`, and a new `*V2Payload` export, and
both **keep the v1 entry and payload unmodified**. The mechanical reason is `validate.ts:73-82`,
which permits exactly one version per event name.

**Why that is the owner's call and not a builder's.** Both precedents minted a new name because
a bump *"would invalidate every shipped emitter the moment it deployed"*. `profile.viewed` has
**zero emitters, zero stored rows, and zero consumers that read its version** —
`notifications.repository.ts:75-79` selects only `id` / `event_name` / `occurred_at` and never
touches `event_version` or the payload. **The mechanical reason behind the precedent does not
obtain here.** What remains is only the CLAUDE.md §3 rule itself.

That is exactly the distinction between route (ii) *bump in place* and route (iii) *mint a
distinct event*, and neither `E0_BUILD.md` nor `PARKED.md` P-019 draws it. The ruling said
"version it, following a precedent"; the named precedent is empty, and the real one points at a
new name for a reason that does not apply. Settling that by building is what BUILD_RULES:31
forbids.

**The choice, now that the facts are measured:**

- **(ii) bump `ProfileViewedPayload.job_id` to optional in place, keeping `version: 1`.** Breaks
  nothing — no emitters, no rows, no version-reading consumers. Violates CLAUDE.md §3 as written.
- **(ii-v2) mint `profile.viewed_v2` with `job_id` optional**, v1 untouched. Follows the only
  real precedent in the repository. Costs a second name for one signal, and
  `NOTIFICATION_EVENT_NAMES` must gain it — see HALT 2, the allowlist is frozen.
- **(iii) mint a distinct unlock-notification event** with its own template. Mutates nothing,
  costs the most, hits HALT 2 identically.

C-1 is a BLOCKING CONDITION. E0 does not ship without it.

---

## HALT 2 — item 5: the notification allowlist is frozen, and a relay message is barred by a prior scope ruling

This is **not in the brief at all**, and it is independent of C-1.

`apps/api/src/notifications/notifications.service.test.ts:348-361` pins the feed's allowlist to
an EXACT ten-name list. Its docstring states the rule:

> This list is the deliberate-review gate: adding an event to the feed MUST be a conscious edit
> here. Before adding one, check it is the WORKER's own lifecycle or own act — **never something
> an EMPLOYER did (2026-07-17 scope ruling** …).

Item 5 is *"an in-app notification when a message arrives"*. A payer sending a worker a message
is **something an employer did**. Item 5 therefore needs the 2026-07-17 scope ruling amended by
the owner, or it does not ship.

**Good news for C-1:** `profile.viewed` is already in the allowlist, so C-1 itself needs no test
edit. The bar falls on item 5, and on any new `_v2` or distinct event C-1 mints.

A second, narrower gate sits beside it: `notifications.service.test.ts:381` and `:430-439` bar
any allowlisted event whose payload carries a key literally named `payer_id`.
`ProfileViewedPayload` passes **only** because its field is `viewer_payer_id`. Any new relay
event must be named the same way or it fails a passing test.

---

## What else the measurements falsified

None of these halted the phase on its own, but each would have sent a builder the wrong way.
Rows 1–5 are corrected in this same commit.

| # | Brief's premise | Measured |
|---|---|---|
| 1 | `profile.viewed` at `registry.ts:517` | **`:522`.** `:517` is `job.updated`. Inherited from `PARKED.md:752`. |
| 2 | `ProfileViewedPayload` at `payloads.ts:2145-2149` | **`:2169-2173`.** Inherited from `PARKED.md:774`. |
| 3 | "the fail-closed ladder the resolution must reuse: `unlocks.service.ts:67-78`" | `:67-78` is a **DOCBLOCK for `POST /unlocks`** — the GRANT path. The executable **use-time** ladder is `:318-400` and differs by four checks (worker-gone SET-NULL guard, pending-deletion re-read under lock, consent before the lock, live-grant check). Reusing the docblock re-derives the wrong ladder. |
| 4 | reveal attempt cap at `config/src/server.ts:1135` | **`:1151`.** `:1135` is `MESSAGING_ENABLE_REAL`'s docblock. |
| 5 | consent NEVER-DO at `BUILD_RULES.md:28` | **`:89-91`.** `:28` is the PARKED.md entry of the authority list and never carried this rule. The signed decision doc repeats the error at `:30` and `:61`. |
| 6 | "number it after E1's" | `_journal.json` max idx is **0100**; next is **0101**. `E1_BUILD.md:71,:76` says take 0100 — already used by #1426. Read the journal, not E1. |
| 7 | ITEM 0 is owed as an issue | **Already SHIPPED in code.** The false sentence is gone; live copy reads *"The routed channel is not open yet, so there is nothing to dial or message today."* `E0_CHECK` item 1 now passes on its first branch. |
| 8 | "the join you need is already persisted" | True of `unlock_id` **only**. `relay_handle` is `text().notNull()` with **no index and no unique constraint** (`schema/payer.ts:349-370`); the only indexes are `unique(routing_token)` and `index(unlock_id)`. `routing_token` and `relay_handle` are **two different values with different lifetimes** — the token is minted once per GRANT, the handle per REVEAL. A resolution keyed on the handle needs an index the schema does not have. |
| 9 | "no worker holds `employer_sharing` today" | True of app-originated consent only. `seed-demand.ts:107` and `seed-reach-pool.ts:672` both write it, so it is false on any seeded database — which is the database every check for this phase must use. |

---

## What this session DID land

1. **`employer_messaging`**, the ninth consent purpose, minted in `packages/types/src/index.ts`
   under the owner's direct authorisation this session and `BUILD_RULES.md:89-91`'s carve-out.
   `CONSENT_PURPOSES` now holds NINE members. Dormant by design: no client requests it, so it
   fails closed for every worker — the posture `employer_sharing`, `whatsapp_messaging`,
   `agent_activity_visibility` and `voice_processing` already hold.
2. **The citation corrections** in rows 1–5, in `E0_BUILD.md` **and** `PARKED.md` P-019. Both
   needed it: correcting the brief alone leaves the next session re-deriving the same two wrong
   line numbers from `PARKED.md`.
3. **`E0_CHECK.md` repointed** where the signed §A ruling made its prescribed FAIL sentence
   false. It read *"a build that added it ITSELF is a FAIL under the NEVER-DO"* — which would
   have failed this build for doing what the owner authorised. P-016's shape, false-FAIL
   direction.
4. **Two new parks**, P-021 and P-022.

## What this session did NOT do, deliberately

No resolution function, no message table, no migration file, no routes, no events, no
notification. **Nothing was built around a wrong premise.** The invariant — *no message crosses
between a payer and a worker without a live, unexpired, consent-valid unlock joining them* —
remains **vacuously true**, exactly as at base, because no message can cross at all.

## The questions, in the order they block

1. **C-1's route.** (ii), (ii-v2) or (iii)? The named precedent is empty; the real one points at
   a new name for a reason that does not apply here.
2. **Item 5 versus the 2026-07-17 scope ruling.** May a payer-originated signal enter the
   worker's alerts feed, when the docstring bars "something an EMPLOYER did"?
3. **The verification instruction versus BUILD_RULES:21-24.** Proving the handle resolves
   end-to-end needs the new table to exist; BUILD_RULES says write the migration and never apply
   it, "not even to test". Both cannot hold. `E0_CHECK` item 12 already calls this NOT EXECUTABLE.
4. **The carve-out's wording.** `BUILD_RULES.md:89-91` says the ninth purpose is authorised
   "for E4"; this is E0, and `E0_BUILD.md:169` titles the ruling for E0. The owner authorised it
   for this work directly, but the written carve-out still names the wrong phase.
5. **The signed decision doc's four bad citations** (`:30`, `:61`, `:194`, `:199`). Left
   unedited — it is signed, and the precedent set on 2026-09-07 was that dated records stay.
