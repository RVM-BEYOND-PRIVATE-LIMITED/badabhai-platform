STATUS: CLOSED 2026-09-05 — superseded by the E-chain (docs/decisions/E_CHAIN_DESIGN_2026-09.md).
Do not build from this file without reopening the phase.

WHAT NO E-PHASE COVERS — dropped visibly, not quietly. Each survived an adversarial
refutation pass (already-ships / an-E-phase-covers-it / a-signed-ruling-deleted-it):
  - The in-app-purchase dependency guard test under `apps/payer-app/test`. The invariant
    holds today by convention; nothing enforces it. `kShowBuyCreditsOnWeb = false` is a
    visibility flag, not a dependency gate.

------------------------------------------------------------------------------
STATUS: BLOCKED ON RULING R6 (unsigned). Do not start.
STATUS: ALSO BLOCKED — the "Complete on web" hand-off is a CEO store-policy call, and P8's
        draft routes are not on main.

PHASE P12 — Flutter payer app: draft and resume only.

WHY R6 BLOCKS THIS
docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md:765 and :745 are blank fill-in lines.
`grep -n payer .github/CODEOWNERS` exits 1 on a 76-line file, so apps/payer-app falls to the
catch-all at :24, `*  @prakashkantumutchu @divyuuu` — two owners, not one. BUILD_RULES.md:31
makes settling R1-R7 a full stop. Do NOT write a name into CODEOWNERS or the worksheet. The
owner's name is a PRECONDITION of this phase, never one of its artifacts.

WHY "COMPLETE ON WEB" IS NOT YOURS TO BUILD
The equivalent affordance exists and is deliberately OFF: credits_screen.dart:55
`const bool kShowBuyCreditsOnWeb = false;`, hidden by VISIBILITY ONLY (:207-217) on the Play
anti-steering ground written at :47-50. The hand-off that IS shown (kManagePlanOnWebLabel,
jobs_screen.dart:41) fires only from `open`/`paused` on an ALREADY-PUBLISHED posting (:522,
:539) and opens `$base/jobs/${job.id}` (:333) — no code, no token. No handoff-code mechanism
exists in this repo. Re-enabling that class of surface at draft time is a CEO call.

WHAT ALREADY SHIPS — do not rebuild it. Twelve modules under apps/payer-app/lib/features/;
`flutter analyze` and `flutter test` both BLOCKING (payer-app.yml:41-42, :46-47).
 - Server-side draft, published later: post_job_screen.dart:34, :464.
 - Submit-for-verification, end to end: post_job_screen.dart:834-844, jobs_screen.dart:407-409,
   models.dart:74 / :80 (JobStatus.review -> 'In review').
 - Cross-device RESUME for the ADR-0035 chat session: jobs_screen.dart:53, tested at
   test/features/jobs/jobs_screen_store_policy_test.dart:155-172. Reuse that card.
 - An `idempotency-key` header seam with no caller that generates one: payer_http.dart:165-169.
 - The POSTURE half of the INVARIANT holds: pubspec.yaml declares no payment package
   (dependencies :13-51, dev_dependencies :52-55); AndroidManifest.xml:3-4 declares only
   INTERNET and POST_NOTIFICATIONS; screen guard at jobs_screen_store_policy_test.dart:97.
   The TEST half does NOT hold — nothing fails today if `in_app_purchase` lands in pubspec.

WHAT IS OWED, once R6 is signed
1. The DEPENDENCY guard, in apps/payer-app/test. Shape it on test/no_qr_scanner_test.dart:19-36,
   but anchor on the dependency KEY (`RegExp(r'^\s{2}in_app_purchase\s*:', multiLine: true)`)
   plus an `import 'package:<pkg>'` scan of lib/. A raw substring match is WRONG here: this app
   explains its own absence in prose (credits_screen.dart:54, capacity_screen.dart:23) and a
   guard that trips on a comment gets deleted the first time it blocks real work.
   This is the ONLY artifact not blocked on P8.
2. The schema-driven wizard. GET /payer/job-posting-drafts/schema does not exist
   (`grep -rn job-posting-draft apps packages` finds only a JSON key at
   job_posting_chat_models.dart:456), and P8_BUILD:35-36 sources its chips from
   matching_catalog, which is NOT on main — PR #1387 carried it and is CLOSED UNMERGED
   (2026-09-04); the branch survives at a454fac0. Assert no role
   count. Render what the schema serves and nothing else. HALT if it serves shift or benefit
   chips: P1_BUILD:17-26 lists the catalog's contents and neither is in it.
3. When the wizard replaces the company path, `_trades` (post_job_screen.dart:80-87), `_bands`
   (:90), `_trade` (:99), `_band = '2-5'` (:100) and their uses at :372 and :442 ALL go —
   deleting the two lists alone leaves live references and a hardcoded band value. The same
   five band values are duplicated at edit_company_job_screen.dart:42 (:49, :193): PARK it or
   ask, do not half-do it. LEAVE kAgencyTradeKeys (models.dart:555) — the AGENCY route's typed
   `trade_key` enum, read at post_job_screen.dart:102 and :1016 and at
   features/jobs/presentation/edit_agency_job_screen.dart:52-54, :257. Whether the wizard also
   replaces the agency route is unruled: ASK, do not assume.
4. Offline queue. pubspec.yaml declares no shared_preferences, path_provider, connectivity,
   sqflite/hive/drift or uuid. Adding four packages to an app whose owner R6 has not named
   needs the same sign-off — ask with the R6 answer. Copy the shape of
   apps/worker-app/lib/features/voice_form/data/voice_clip_queue.dart:94-125 (single-worker
   FIFO, JSON array under a prefs key, plus a cursor).
   HALT before writing the flush. P8_BUILD:29-31 makes expected_version mandatory and says
   "Never return 200" on a mismatch, so a queue stamping each item at enqueue time 409s on its
   SECOND item with no other writer at all. P8 owns that contract and is unbuilt. Ask how a
   multi-item flush versions. Do not invent it.

PARK, do not fix: P9_BUILD:26 deletes POST /payer/job-posting-chat/sessions/:id/publish, which
this app calls at core/data/http_payer_api_client.dart:375. app_config.dart:95 still defaults
the payer-web origin to the superseded `https://app.badabhai.in`.

NEVER create an in-app-purchase product or any payment screen here (BUILD_RULES.md:29).

INVARIANT: apps/payer-app declares no payment or in-app-purchase package anywhere in
pubspec.yaml and no file under lib/ imports one, both enforced by a test in apps/payer-app/test
that reads those files and fails when either appears.
