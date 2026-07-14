# Future Improvements (Phase 2+)

Ideas worth keeping, not yet scheduled. This is a backlog of intent, not a
commitment. The authoritative deferral list is ADR-0001 and the Phase-1 plan;
this expands on them.

## Phase 2 — Monetization & matching (the deferred core)
- **Reach Engine** — the deterministic `reach → rank → pace → protect → learn`
  pipeline. LLMs assist; the engine decides. (`@badabhai/reach-engine` placeholder.)
- **Employer posting + unlock flow** — the revenue path: employers/agencies pay
  to unlock profiled candidates (workers stay free).
- **Payments + payouts + boosts** — gateway integration, agency payouts, paid
  visibility. Real legal/DPDP commercial flows.
- **Advanced matching** — use the already-frozen `embeddings` + `model_training`
  tables for semantic candidate↔role matching.

## AI / data
- **LLM cost-efficiency workstream** (real-mode input spend):
  - **COST-3 — stateless chat turn** ✅ *landed*: the profiling chat turn no longer
    re-sends the transcript each turn (`build_chat_messages` is stateless by
    design), cutting per-interview input from O(n²) → O(n). Extraction keeps full
    context. Owner: ai.
  - **COST-2 — prompt caching (min-threshold guarded)** *(blocked-by COST-3)*: mark
    the static persona system block cacheable via the provider seam, but only when
    it clears the Gemini/Anthropic cache minimum — else log a skip diagnostic.
    Effective only in real mode. Owner: ai.
- **Real NER pseudonymization** replacing the heuristic gateway (pays down TD3).
- **Langfuse** wired for real LLM observability + eval (placeholder today).
- **Self-hosted / fine-tuned model** only if cost/latency/privacy demands it —
  the `model_training` + storage-tier schema keeps the door open (ADR-0001 #4).
- **BullMQ job pipeline** for extraction/transcription/embedding (pays down TD1).

## Platform & ops
- **Finalized RLS** + per-worker isolation (pays down R1/TD4).
- **Disaster-recovery runbook** + tested restore (pays down R5).
- **Secrets manager** + multi-environment promotion (pays down R8 / TD10).
- **Real provider integrations**: OTP, STT (Sarvam), payment gateway.

## Product / reach
- Worker app polish; **multilingual** chat (Hindi + regional) end to end.
- Employer-facing surface (beyond the internal ops console).
- Expansion beyond CNC/VMC to adjacent blue/grey-collar verticals.

## Parked Phase-2 fast-follows (captured 2026-06-17 — ready to schedule, NOT built)

Deliberately deferred (CLAUDE.md §8). Each has a spec stub + an UN-DEFER TRIGGER; **alpha
ships WITHOUT both.**

- **Agency Referral Funnel + Payouts** — agencies refer candidates; a conversion inside a
  **90-day** attribution window earns a payout (**25%** share / **₹500**, **KYC required**).
  New PII surface (agency KYC) + **real outbound money** → human + legal gated. **Depends on**
  the unlock/credit ledger ([ADR-0010](../decisions/0010-contact-unlock-and-reveal.md)),
  real payments ([TD34](./tech-debt-register.md)), and real payer/agency identity
  ([TD33](./tech-debt-register.md)). Stub:
  [phase-2-agency-referral-payouts.md](../sprint-plans/phase-2-agency-referral-payouts.md) ·
  register: [TD39](./tech-debt-register.md).
  **UN-DEFER TRIGGER:** TD34 + TD33 closed · product ratifies the attribution/payout model ·
  legal+DPDP sign-off on KYC · human authorizes real payouts.
- **Seeding / Credit Grants** — grant credits without a purchase (promo/trial/assisted-hiring).
  The `credit_ledger` `grant` reason already exists; the grant **flow/authz/policy/audit** do
  not. **Assisted-hiring is a STUB in alpha** (only the manual ops MOCK top-up, TD34, exists).
  Stub: [phase-2-seeding-credit-grants.md](../sprint-plans/phase-2-seeding-credit-grants.md) ·
  register: [TD40](./tech-debt-register.md).
  **UN-DEFER TRIGGER:** TD33 closed (real grantor identity/authz) · product+security define
  grant policy + abuse/audit controls · a concrete promo/assisted-hiring program is greenlit.

## Worker-app "Desi Vernacular Pop" alpha — deferred follow-ups (captured 2026-06-26)

The Flutter worker-app build kit landed the 4-tab shell + all 17 screens **mock-backed**
(go_router StatefulShell, ADR-0023). These are the explicitly out-of-scope items
(prompt §7); alpha ships WITHOUT them. Each is mock/stub today with the deferral noted at
the mock source.

**Real endpoints + ADRs (the load-bearing deferrals):**
- **Worker-facing job feed/detail PII ruling** — the rich card fields (company name, pay
  band, "spots left") are MOCK-ONLY display data synthesised client-side; employer names
  are PII (CLAUDE.md §2). A real `/feed`/job-detail exposing these needs an **ADR** first.
  The real `FeedItem`/`getFeed` path stays PII-free and unchanged today.
- **Resume safe-fields** — real `GET`/`PATCH` for `{displayName, showPhoto, showPhone,
  nightShiftReady}` + **photo capture/storage** (DPDP/consent implications) — mock only.
- **Interview-kit content source** — per-trade metadata + Q&A (DB vs object-store vs
  bundled); alpha serves a single canned CNC kit + a "coming soon" checklist row.
- **Filtered-feed query + saved filters** — the Filters sheet is session-only with a MOCK
  "Show N jobs" count; no real filtered query or persistence.
- **`GET /my/applications` + employer-viewed/reply signals** — Applied's timeline row 2
  ("Employer ne dekha") is a static "Pending" placeholder.
- **Notifications table/source** — Alerts are canned (`mock-*`); new-job / profile-viewed
  are placeholders for deferred server signals (resume-ready is a local signal).
- **Settings read/write** + **DPDP account-delete + data-export** — rows are inert
  ("Jald aa raha hai"); account-delete is a confirmation-dialog stub (no-op).

**Built-screen parity not in this batch:**
- Splash language picker; OTP segmented cells + resend timer; Resume **Download-PDF** /
  **WhatsApp-share** buttons (only the safe-field edit entry-point shipped); chat
  form-popup (hybrid profiling card); profile-strength on the profiling ProfilePreview;
  `BbButton` 3D-press affordance (skipped to avoid regressing the themed FilledButton).

**Deferred capabilities:** photo capture/storage (PII/consent); real swipe→backend
application events; real resume download. Drop-off analytics (Firebase Crashlytics +
Analytics, requirement #19) is a separate, not-yet-started task.

## Worker-app pending-work batch — follow-ups (captured 2026-06-27)

Landed this batch (all Flutter-side, no missing endpoint): the **inert splash language
picker** (Hindi/Marathi/Bhojpuri/English, visual-only), a **go_router fix** for the
login→OTP nav (a stale `Navigator.pushNamed` that threw under `MaterialApp.router`), and
a headless **full-journey mock-mode e2e** (`test/e2e/app_journey_test.dart`). Deferred,
each with a noted reason:

- **Real localization (i18n).** The splash picker is **inert** — local visual state only,
  no `intl`/l10n package, no persistence, no translated copy, no locale switch. Real
  multilingual support (string registry + translated copy + persisted locale + DI/BLoC
  threading) is a separate workstream. (Cross-ref the existing "multilingual chat" item.)
- **Port origin's richer OTP screen into the clean-arch shell.** The `origin/main`
  merge (`addedfa`) kept the local clean-arch worker-app and dropped origin's
  **flat-structure** auth screens, which carried a real-OTP UI the rebuild had deferred
  (**segmented OTP cells + resend timer**). That impl is NOT lost — it lives in history
  at `00c0c62` ("OTP-4 — de-mock the login OTP surfaces") / `d2f228e` ("real-only OTP").
  To port: `git show 00c0c62:apps/worker-app/lib/features/auth/otp_verify_screen.dart`
  and re-home the segmented-cells + resend-timer UX into
  `features/auth/presentation/otp_verify_screen.dart` (keep the mock seam; real mode
  already drives the now-real OTP API).
- **5-feature client integration + real STT voice note — blocked on missing endpoints**
  (TD54). Interview-kit list/detail, notifications, profile-summary, resume-safe-fields,
  and the record→upload→transcribe→merge voice flow target backend contracts that **do
  not exist yet** (only `GET /interview-kit/:tradeKey/download`, `POST /voice/upload`,
  `POST /voice/transcribe`, `GET /ai-jobs/:id` are built). Left per the "missing endpoint →
  leave it" directive; features stay mock at the repository layer. Voice real STT also
  stays a §7 provider-gate escalation (Sarvam keys/spend) — its ADR-0025 is deferred too.
- **Worker-facing job-detail PII ruling** — ruled on in
  [ADR-0024](../decisions/0024-worker-visible-job-fields-pii.md) (recommend masked employer
  + banded pay, audited precise-reveal); job-detail stays mock-only until built (TD53).
- **`integration_test` package** was intentionally **not** added: it routes `integration_test/`
  to on-device / `flutter drive` runs (needs a connected device), which contradicts the
  headless "Dart-first, no emulator" mock-mode design and the CI `flutter test` gate. The
  equivalent full-journey e2e lives under `test/e2e/` and runs in the existing gate. Revisit
  if/when on-device integration runs are wired into CI.

> When an item here is picked up, move it into a sprint plan / ADR and link back.
