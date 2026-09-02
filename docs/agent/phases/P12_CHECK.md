PHASE-ID: P12
INVARIANT: the Flutter payer app contains no payment surface at all.

EXPECTED ARTIFACTS: a schema-driven draft wizard in apps/payer-app with offline
checkpoint queueing, and a named owner recorded for that app.
If these do not exist, VERDICT is FAIL, reason "phase not built". Stop there.

Do these checks and paste raw output for each:
1. grep apps/payer-app for in_app_purchase, billing, StoreKit, ProductDetails, and
   any payment SDK. Any hit is a FAIL.
2. Confirm no IAP product is declared in any manifest, plist, or store config file.
3. Confirm R6 is closed and an owner is named in the repo. No named owner is a FAIL.
4. grep for hardcoded role labels or function values in Dart. Any hit is a FAIL.
5. OFFLINE: turn off the network mid-wizard. Complete two steps. Turn it back on.
   Both checkpoints must flush in seq order and exactly two rows must appear on the
   server. Duplicates or lost steps are a FAIL.
6. CROSS-DEVICE: start a draft on Flutter, resume it on payer-web, then submit a step
   from each. There must be one draft, a correct folded payload, and a 409 on the
   stale client.
