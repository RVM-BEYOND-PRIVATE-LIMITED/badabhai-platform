PHASE-ID: E0
STATUS: TWO QUESTIONS ARE UNSIGNED and each HALTs the build — the free-text question
(E0_BUILD §THE LEAK THIS CHANNEL HAS BY CONSTRUCTION) and the consent question (E0_BUILD
item 3). Both are written up and costed in docs/decisions/E0_RELAY_DECISION_2026-09.md
(§A, §B), whose signature block is BLANK — that file being unsigned IS the halt condition,
and a check session should read it rather than re-derive the questions. Its §C carries a
third unsigned condition (what the worker experiences) with three recommended additions.
A correct session run TODAY ends VERDICT PASS, reason "phase correctly halted", with a HALT
record naming all three sections. ITEM 0 IS ALREADY DONE — raised as issue #1430 on
2026-09-05, before any of the rulings; item 1 below now checks that issue, not the work.

INVARIANT: no message crosses between a payer and a worker without a live, unexpired,
consent-valid unlock joining them — re-checked at send time, not merely at grant time.

R-E4 APPLIES TO THIS WHOLE FILE, AND IT IS NOT A FOOTNOTE. The workers on the live database
are testers (owner ruling, 2026-09-05), `employer_sharing` is requested by no client, and no
worker has ever received a relayed message. **Every item below runs against SEEDED LOCAL DATA
against a schema Prakash has applied.** Nothing here is evidence that the relay works for a
real worker. An item needing rows nobody has seeded is recorded NOT EXECUTABLE, never a PASS.

EXPECTED ARTIFACTS: the corrected copy (or a Frontend issue carrying it), a resolution
function, one migration FILE, two controllers with a boot test and `guard-contract.test.ts`
registrations, two events, and an in-app notification. NO `.dart` file may change.

HOW TO READ THE LABELS.
  [GUARD]       — must be GREEN at the phase base. Each was run against `f72a7a79` while this
                  brief was written and its base result is recorded. A GUARD red at base
                  cannot distinguish this build from the world: report it as a broken check,
                  never as a FAIL.
  [DELIVERABLE] — must be RED at the phase base.

CONVENTION: grep exits 1 on zero matches. Do not run under `set -e`. Paste raw output AND the
exit code for every item.

1. [DELIVERABLE · base: RED, one hit at :31] ITEM 0 — the false promise is gone.
   grep -n "Use it in-app to reach the candidate" apps/payer-web/src/components/unlock/routed-contact-card.tsx
   Base: one hit at :31. The issue IS RAISED (#1430, 2026-09-05, carrying the exact
   replacement copy) — payer-web is the frontend owner's layer (CLAUDE.md §6), so a backend
   session owes the issue and not the edit.
   gh issue view 1430 --json state,title
   PASS on either: the grep exits 1 (Frontend shipped it), or #1430 is still open. FAIL only
   if #1430 is CLOSED and the string survives — that is a fix reported as done and not done,
   which is the one state nobody would re-check.
   PRESCRIBED FAIL SHAPE: say that a PAYING surface still instructs an action the platform
   cannot perform. Do not write "copy not updated" — that reads as a polish task and will be
   deferred again.

2. [DELIVERABLE · base: RED] The handle resolves, and only through the handle.
   Find the resolution function and read it. It must take the `relay_handle` and NOTHING
   ELSE — no `worker_id` in, no `worker_id` out.
   FAIL if the route accepts a worker id: the payer does not hold one, so a route that takes
   one is a route that can be probed with ids the payer was never given.
   Confirm it re-checks AT USE TIME: unlock status, `expires_at`, caller ownership,
   `employer_sharing` unrevoked, and the ADR-0031 pending-deletion freeze. A grant-time-only
   check means a worker who revokes consent keeps receiving messages.
   THEN MUTATE AND WATCH IT GO RED. Delete the expiry re-check, run the suite, and confirm a
   test fails. A green suite after that means the invariant has no guard and this PASS
   certifies nothing — report that, do not record a PASS.

3. [GUARD · base: GREEN, exactly one hit at :878] The phone is still decrypted once.
   grep -n "pii.decrypt" apps/api/src/unlocks/unlocks.service.ts
   Base: exactly one hit, `:878`, inside `wireInAppRelay`. Expect exactly one.
   A SECOND DECRYPT ON THIS PATH IS THE FAIL, and the fail sentence must say why rather than
   count: if the resolution needed the phone, what was built is `proxy_number` — the
   production telephony channel, human-gated on a real key and real spend — and not the
   in-app relay. That is a different product with a different ruling, shipped by accident.

4. [GUARD · base: GREEN] The handle is still not derived from the phone.
   Read `wireInAppRelay` (apps/api/src/unlocks/unlocks.service.ts:873-886). The returned
   handle must remain a fresh random uuid bound to the unlock. FAIL on any handle computed
   from, hashed from, or seeded by the phone — that would make it reversible, which is the
   one property F-4 exists to hold.

5. [GUARD · base: GREEN, exit 1] No deny-reason oracle appeared.
   Read the resolution and the send route. Every failure must return the SAME neutral body at
   a constant status, via `neutralUnavailable()`
   (apps/api/src/unlocks/unlock-response.ts:38-41).
   grep -n "reason" <the new controller/service files> — any field named `reason`,
   `deny_reason` or `error_code` on a payer-facing response is a FAIL. The unlock path spent
   real effort making a leak a compile error (unlock-response.ts:8-11); a new route beside it
   that explains itself undoes that in one field.

6. [GUARD · base: GREEN, exit 1] No import of `UnlocksRepository` outside `apps/api/src/unlocks/`.
   grep -rn "UnlocksRepository" apps/api/src --include=*.ts | grep -v "^apps/api/src/unlocks/" | grep -E "^[^:]*:[0-9]+:import"
   Base: exit 1. DO NOT DROP the trailing `grep -E "import"` — three files outside that
   directory MENTION the name in comments (admin-dashboard.repository.ts:444,
   resume-disclosure.repository.ts:65, referral-link.repository.ts:64), so the bare name-grep
   is red at base and points at innocent docblocks.

7. [GUARD · base: GREEN] No push, and no `proxy_number`.
   grep -rn "push" <the new module directory> — expected exit 1. ADR-0034 scopes push to
   SECURITY ALERTS ONLY (docs/decisions/0034-worker-push-notifications.md:16-18); item 5 is
   the IN-APP notification list, a different surface.
   grep -rn "proxy_number" apps/api/src --include=*.ts | grep -v "\.test\."
   Base: exactly one hit — the type union at apps/api/src/unlocks/unlock-response.ts:55.
   Expect exactly one. A second hit means a code path now selects it.

8. [GUARD · base: GREEN, empty] No credit was charged to send or resolve.
   git diff $(git merge-base origin/main HEAD)..HEAD -- apps/api/src/unlocks/unlocks.service.ts
   Read any change. FAIL on a new `debitOneCreditWithinTx` call site, or any write to
   `credit_ledger` from this phase. What a credit buys is DEFERRED
   (docs/decisions/RESUME_DISCLOSURE_DECISION_2026-09.md) and this phase must not settle it
   by shipping a price.

9. [GUARD · base: GREEN, empty] No Flutter file changed.
   git diff --stat $(git merge-base origin/main HEAD)..HEAD -- apps/worker-app apps/payer-app
   git status --porcelain --untracked-files=all -- apps/worker-app apps/payer-app
   Both expected EMPTY. Any `.dart` change is a FAIL under CLAUDE.md §6 regardless of
   correctness. The GitHub issue number belongs in the build report instead.

10. [GUARD] The migration was WRITTEN and NOT APPLIED, and does not collide.
    Read packages/db/migrations/meta/_journal.json. The new entry's `when` must be the
    largest in the file; a hand-set timestamp below the current maximum makes drizzle skip it
    AND every migration after it, silently.
    Base: main's journal ends at `0098_worker_qualifications`. E1 takes 0100 (0099 is burned
    on the closed-unmerged PR #1387's surviving branch), so E0's number depends on merge
    order — read the journal, do not assume.
    THIS ITEM CANNOT CONFIRM THE MIGRATION WAS NOT RUN against a database. The repository
    does not record that. Say so; do not claim it.

11. [DELIVERABLE] The message row carries no identity.
    Read the new table. FAIL on any column holding a phone, a name, an employer name, or a
    worker id that is not the existing opaque uuid. The body column is the exception being
    ruled on, not an exemption — if the free-text question is still unsigned, a shipped
    free-text body column IS the FAIL, because it settles an open ruling by building.

12. NOT EXECUTABLE WITHOUT SEEDED ROWS AND AN APPLIED SCHEMA. The end-to-end proof — a seeded
    payer with a live unlock sends a message, the seeded worker reads it, and a second seeded
    payer holding no unlock is refused with the identical neutral body — needs both. If either
    is missing, write "NOT EXECUTABLE: <which>" and do NOT record a PASS. Item 2's mutation is
    the unit-level evidence; this is the integration-level evidence; neither substitutes for
    the other.

RECORD IN THE VERDICT, do not check. All three are owner acts, and all three are costed in
docs/decisions/E0_RELAY_DECISION_2026-09.md — cite its signature block, which is BLANK:
  - §A — whether `employer_sharing` authorises messaging or only disclosure.
  - §B — which of the three free-text shapes was chosen.
  - §C — whether E0 ships without a worker-side notification, a per-purpose exit, and a
    `wants`-aware use-time check. §C finding 3 is the load-bearing one and it is NOT in
    E4_BUILD.md: `wants` appears zero times in apps/api/src/unlocks/unlocks.service.ts, so
    E4's opt-out does not close a live unlock's relay access.
  - That the résumé/credit pricing question stays deferred until this phase lands.
