PHASE-ID: P12
INVARIANT: apps/payer-app declares no payment or in-app-purchase package anywhere in
pubspec.yaml and no file under lib/ imports one, both enforced by a test in apps/payer-app/test
that reads those files and fails when either appears.

PRECONDITIONS, before artifacts. CHECK_RULES.md:43 admits only PASS or FAIL — use FAIL.
- R6 signed: RVM_TAXONOMY_WORKSHEET_2026-09.md:743 and :745 both filled in. Blank means the
  build correctly stopped: FAIL, reason "blocked on unsigned R6 — build halted", NOT "phase not
  built". Naming the owner was never this phase's job (BUILD_RULES.md:31). Whether CHECK_RULES
  should gain a BLOCKED verdict is an owner question, not yours to settle.
- FAIL if the diff flips kShowBuyCreditsOnWeb (credits_screen.dart:55) to true, or adds any
  draft-time web-purchase affordance, with no signed owner decision under docs/decisions/.

EXPECTED ARTIFACT, unconditional: the dependency guard test under apps/payer-app/test. Absent =
FAIL "phase not built". The wizard and queue are CONDITIONAL: if
`git grep -n "job-posting-drafts/schema" origin/main -- apps packages` is empty, P8's routes are
not on main and both are correctly DEFERRED — paste that grep and judge the guard alone.

Do these and paste raw output for each:
1. `grep -nE '^ {2}(in_app_purchase|flutter_inapp_purchase|purchases_flutter|razorpay_flutter|google_play_billing):' apps/payer-app/pubspec.yaml`, and the same over pubspec.lock. Both empty at HEAD (deps :13-51, dev_deps :52-55). Any hit is a FAIL.
2. `grep -rn "InAppPurchase\|ProductDetails\|BillingClient\|StoreKit\|SKPayment\|com.android.vending.BILLING" apps/payer-app` — ZERO hits at HEAD, verified. Any hit is a FAIL. Do NOT add bare `billing` or `Razorpay`: credits_screen.dart:54, capacity_screen.dart:23 and test/widget_test.dart:138 are two comments and a negative assertion, and would fail the check before a builder touched anything.
3. MUTATE the guard, with the pinned toolchain C:/Users/Prakash/bbwt/flutter-3.35.7/bin/flutter. Paste, in order: `pub get` SUCCESS; the guard test GREEN; then add `  in_app_purchase: ^3.0.0` under dependencies, `pub get`, re-run, paste the ASSERTION failure; revert and paste `git status --porcelain apps/payer-app/pubspec.yaml` EMPTY. RED = the guard still passes with the package declared, or a `pub get` error standing in for an assertion.
4. What it PERMITS: add `  # deliberately NO in_app_purchase here` as a pubspec COMMENT and re-run. It must stay GREEN. RED = a guard that blocks legitimate work and will be deleted.
5. `grep -rn "'2-5'\|'11-25'\|'Quality Inspector'\|'CNC Setter'" apps/payer-app/lib`. If the wizard replaced the company path, post_job_screen.dart must not appear (was :80-87, :90, :100); edit_company_job_screen.dart:42 may appear only with a recorded PARK. models.dart:555 kAgencyTradeKeys must be UNCHANGED — deleting it is a FAIL, it belongs to the agency route.
6. In the wizard's own files under lib/: no literal role, function, collar-tier, shift or benefit string. A schema FIXTURE under test/ is expected and is NOT a violation.
7. OFFLINE, with request logging on: network off mid-wizard, two steps, network on. Expect two checkpoint rows, consecutive seq, no repeated idempotency_key, and item 2's expected_version equal to the version item 1's response returned (P8_BUILD:29-31). RED: three rows, one row, a duplicate key, or item 2 sent with the version captured at enqueue.
8. CONFLICT: with two items queued, curl a checkpoint to the same draft as a second member, then flush. Expect 409 on the FIRST flushed item and ZERO new rows; then resolve and re-flush and expect both items to land under their ORIGINAL idempotency keys. RED: a 200, a silent retry, or an item lost.
9. CROSS-DEVICE: one draft row, payload replayable from its checkpoints, 409 on the stale client. payer-web has NO draft surface (`grep -rln job-posting-draft apps/payer-web/src` is empty), so use a second API client until P10 ships.

Items 7-9 need P8's routes on main AND its migration applied by Prakash. If either is absent,
record NOT VERIFIABLE YET with the grep that shows it, and do not count them either way.
