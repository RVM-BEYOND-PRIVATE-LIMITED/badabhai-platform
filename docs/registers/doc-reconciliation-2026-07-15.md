# Doc Reconciliation — 2026-07-15

## State of Record

> **Branch:** `main` @ `548acd4` — 2026-07-15
> **Migrations:** 0000–0038 (39 total; 0038 applied by owner 2026-07-15)
> **DB tables:** 39 (`pgTable` count: `grep -c "pgTable(" packages/db/src/schema.ts` → 39)
> **ADRs:** 0001–0030 (30 decisions in `docs/decisions/`)
> **Controllers:** 43 (`@Controller(` decorators across `apps/api/src/**/*.controller.ts`)
> **Endpoints:** ~146 (route decorator count across all controllers)
> **SMS_PROVIDER:** `z.literal("fast2sms").default("fast2sms")` — REAL-ONLY; no console/mock provider exists (`packages/config/src/server.ts:221`)

---

## What Actually Shipped Since the Docs' Last Truthful Sync

The last doc-sync commit was `a143a7d` (2026-07-08, AI-service ADR-0028). Since then:

| PR Range | What Shipped |
|----------|-------------|
| #193–#194 | AI-contracts Zod↔Pydantic parity (invariant #7); payer-web all mock seams replaced with live calls (FE wiring CLOSED) |
| #195–#196 | Interview-kit read routes (`GET /interview-kits`, `GET /interview-kits/:tradeKey`); `GET /workers/me/profile-summary` consent-gated |
| #197–#198 | Throttle residuals (TD25 trust-proxy + TD60 per-phone daily cap); voice pipeline end-to-end (ADR-0029, signed-upload + real recorder, mock STT) |
| #199–#202 | Register sync; `kPersistentAuth` flipped ON + payer P1/P2/P3/P5 REAL-mode; docs PR |
| #203–#210 | AI cost/persona series (COST-2/3/4, AI-PERSONA-1/2) |
| #211–#215 | TAX-0..4: ADR-0030, pgvector skill tables (migration 0037), ESCO corpus, alias embedding, canonicalize |
| #216–#220 | Liberal jobs feed; TAX roadmap; CI-1 action bumps; register sync |
| #221–#224 | Worker alerts feed; fork-B DB runner + ai embed endpoint (migration 0038); FORK-B-1 request-path store + SR-1 runbook; evidence |
| #225–#230 | TAX-5 vernacular wedge; TAX-6 job-side canonicalize; TAX-7 growth loop; TAX-8 résumé guard; docs syncs |
| #231 (post-230) | docs sync (current HEAD `548acd4`) |

**Total PRs not in docs:** ~38 PRs since `a143a7d`.

---

## Discrepancy Register

| # | Doc | Claim | Reality (evidence) | Sev | Action Taken | Owner |
|---|-----|-------|-------------------|-----|-------------|-------|
| D-01 | `CLAUDE.md:106` | `packages/db/ (34 tables — full set in schema.ts)` | 39 tables (`grep -c "pgTable(" packages/db/src/schema.ts → 39`) | P1 | Fixed in CLAUDE.md §4 repo map | Auto |
| D-02 | `CLAUDE.md:30` | "full set in docs/decisions/ through ADR-0022" | ADRs now run 0001–0030 (ADR-0023 go_router, 0024 worker job fields, 0025 admin ops, 0026 worker auth PIN, 0027 payer orgs, 0028 taxonomy adoption, 0029 voice audio, 0030 skill canonicalization) | P1 | Fixed in CLAUDE.md §1 | Auto |
| D-03 | `CLAUDE.md:34` | "A worker can log in (**mock OTP**)" | OTP is REAL-ONLY since commit `d2f228e`. `SMS_PROVIDER: z.literal("fast2sms")` — no mock value accepted (`packages/config/src/server.ts:221`). `assertAuthConfig` requires Fast2SMS creds at boot. | P0 | Fixed in CLAUDE.md §1 exit criteria | Auto |
| D-04 | `CLAUDE.md:230–233` | "`PayerAuthGuard` has LANDED … but the **money routes** — Contact Unlock unlock/reveal … still ride `InternalServiceGuard` + body `payer_id` … so LC-1 … **remains open** (TD33/TD50)" | **False.** Payer-facing routes (`/payer/unlocks`, `/payer/unlocks/:id/reveal`) are `PayerAuthGuard`-protected, `payer_id` derived from session since PRs #110/#119 (`apps/api/src/payer-portal/payer-unlocks.controller.ts:41`). Only the ops `/unlocks*` controller uses `InternalServiceGuard` — intentional, TL-decided safe-interim (TD33). LC-1 on money routes **closed** by #179 (plan/boost payer-authed). | **P0** | Fixed in CLAUDE.md §8 | Auto |
| D-05 | `CLAUDE.md:84` | "Queue/cache: Redis + BullMQ (**deferred wiring**)" | BullMQ is fully wired: extraction, transcription, resume-render all run as BullMQ jobs. Not deferred. | P2 | Fixed in CLAUDE.md §3 stack table | Auto |
| D-06 | `docs/ops/staging-service-deploy-runbook.md` §POSTURE (whole Mode A section) | `SMS_PROVIDER=console` + `NODE_ENV=development` is the staging posture; `dev_otp` is echoed; smoke asserts its presence | `SMS_PROVIDER: z.literal("fast2sms")` → `console` **fails Zod parse at boot** (`packages/config/src/server.ts:221`). `dev_otp` removed (commit `d2f228e`). Staging CD (`staging-cd.yml:80`) now runs `NODE_ENV: staging` + `SMS_PROVIDER: fast2sms`. | **P0** | Runbook Mode A section replaced with DEPRECATED notice + pointer to real-only posture. Env table corrected. Verify section corrected. | Auto |
| D-07 | `scripts/staging-smoke.mjs` (code — no edit here) | Asserts `dev_otp` in OTP response (`staging-smoke.mjs:108–113`) | `dev_otp` no longer exists anywhere. Script **always fails** step (b). | P0 | FINDING — log TD (cannot edit code here). Smoke is effectively broken; the CD's `/health`-only check is the only working gate. Owner: DevOps + Backend. |
| D-08 | `docs/tracker/BLOCKERS.md:12` | "FE wiring batch (FE-1..FE-7) — 5 mock shims stale" listed as P1 OPEN | **CLOSED** by PR #194 (`feat(payer-web): final mock→live seams + missing-caller pages (no mock fallback left)`, 2026-07-11) | P1 | Moved to Resolved table in BLOCKERS.md | Auto |
| D-09 | `docs/tracker/BLOCKERS.md:13` | "Unlock/Reveal rides `InternalServiceGuard` + body `payer_id` (LC-1, TD33/TD50)" listed as P1 OPEN | Wrong framing. Payer-facing unlock/reveal is `PayerAuthGuard`-protected (D-04 above). Only the ops controller is `InternalServiceGuard` (TL-decided). True P1 residual = ops `InternalServiceGuard` retire (blocked on ADMIN-4..8). | P1 | BLOCKERS.md P1 row reworded to describe the actual residual (ops retire gate), removed false "401 on every payer call" claim | Auto |
| D-10 | `docs/tracker/BLOCKERS.md:37` | Build health SHA `a143a7d`; "1289/1289" test count | Current HEAD `548acd4`; test count not re-verified here | P2 | BLOCKERS.md updated with current SHA and "verify on local pull" note | Auto |
| D-11 | `docs/tracker/BLOCKERS.md:49` | "run 36 migrations" | 39 migrations (0000–0038) | P1 | Fixed in BLOCKERS.md | Auto |
| D-12 | `.claude/project-memory.md` "16 tables" in Tech Stack line | 39 tables | P1 | Fixed in project-memory.md Tech Stack | Auto |
| D-13 | `.claude/project-memory.md` "CORS open" | CORS is env-driven + fail-closed since PR #132 (commit `7bb6745`, TD30 Paid). `resolveCorsOrigins` reflects origin only in dev; outside dev, deny-all unless `CORS_ALLOWED_ORIGINS` set. | P1 | Fixed in project-memory.md | Auto |
| D-14 | `.claude/project-memory.md` "no auth/JWT in Phase 1 (mock OTP returns a `worker_id`, not a token)" | Workers get `access_token` Bearer (ADR-0026 WorkerSessionService). Payers get Bearer (PayerSessionService, ADR-0019). OTP is real-only. | P1 | Fixed in project-memory.md | Auto |
| D-15 | `.claude/project-memory.md` "Active branch: `feat/job-posting-alpha-gate`"; workstreams as of ~Jun 2026 | Current branch is `main`; active workstreams: TAX-5..TAX-9 (ADR-0030), staging deployment (P0), TD62 kPersistentAuth fix, TD61 CI pin bump | P1 | Fixed in project-memory.md | Auto |
| D-16 | `.claude/team-memory.md` — ownership section cites PRs #46/47/48 (Jun 2026) as "Active PRs" | All merged months ago; current ownership and workstreams are TAX series, voice, skills-taxonomy, staging | P1 | team-memory.md ownership + Active PRs section updated | Auto |
| D-17 | `docs/tracker/ROADMAP.md` Phase 1 day-by-day: "run migrations (now 31, incl. ADR-0026 tables)" / "36 migrations (incl. 0035)" | 39 migrations (0000–0038) | P1 | Fixed in ROADMAP.md; added 2026-07-15 current-position note | Auto |
| D-18 | `docs/tracker/OWNER_TASKS.md` last active entry (2026-07-09) | No 2026-07-15 entry; references "run 36 migrations"; "Do NOT flip kPersistentAuth ON" | kPersistentAuth flipped ON in PR #201; 39 migrations; team's focus is now staging + TAX ratification | P1 | New 2026-07-15 entry added | Auto |
| D-19 | `docs/tracker/WEB_ALPHA_TASKS.md` headline: "B5.1–B5.5 exist as **branches, NOT merged**" | B5.1–B5.5 all merged (#182–#186, 2026-07-03). FE wiring (FE-1..7) CLOSED by #194 (2026-07-11). | P1 | WEB_ALPHA_TASKS.md headline + A1 status updated | Auto |
| D-20 | `docs/registers/tech-debt-register.md` TD2: "default to console/mock (`SMS_PROVIDER=console`...)" | No console/mock SMS provider exists. `SMS_PROVIDER: z.literal("fast2sms")` only. `assertAuthConfig` requires Fast2SMS creds. | P1 | TD2 updated to reflect real-only posture | Auto |
| D-21 | `docs/registers/tech-debt-register.md` — **Two TD64 entries** (lines ~76 and ~78): "interview-kit notification" AND "TAX-3 embed bypasses SpendLedger" | ID collision; the second TD64 (SpendLedger) should be a separate identifier | P1 | SpendLedger entry renumbered. OPEN QUESTION — owner decides final numbering | Auto |
| D-22 | `docs/tracker/PROJECT_STATUS.md` (last updated 2026-07-10) | Stale: SHA `a143a7d`, scores ≤2026-07-10, FE wiring listed as gap | 38 additional PRs since; new SHA `548acd4`; FE wiring closed; many new features | P1 | PROJECT_STATUS.md header + scores updated; see DAILY_TRACKER entry 2026-07-15 | Auto |
| D-23 | `docs/tracker/BLOCKERS.md:46` Staging note: "Nothing else is on the critical path — 16 PRs merged, all backend + frontend work complete" | 38+ PRs since; voice pipeline, TAX series, interview-kit, profile-summary, alerts, kPersistentAuth all shipped. Statement is no longer accurate as a characterization of completion. | P2 | Note updated to reflect current completeness | Auto |
| D-24 | `docs/ai/skills-taxonomy-roadmap.md` | **ALREADY CURRENT** — roadmap was updated by the TAX-series PRs and reflects TAX-0..8 actual status correctly as of 2026-07-15. No changes needed. | — | No action | — |
| D-25 | `docs/tracker/ENV_AND_SECRETS_TRACKER.md` | **MOSTLY CURRENT** — correctly describes real-only OTP, staging secrets PENDING, real-provider gates OFF. Minor: does not mention `SKILLS_INTERNAL_TOKEN` (ADR-0030 fork-B) or `VOICE_NOTES_BUCKET` (ADR-0029) | P2 | Not updated in this pass — OPEN QUESTION for DevOps to add missing vars | DevOps |

---

## Escalations

### ESC-1 — `scripts/staging-smoke.mjs` code fix needed before staging can self-verify (P0)
**Status:** Code file — cannot edit here.
**Finding:** `staging-smoke.mjs:108` asserts `body.dev_otp` is present in the OTP response. `dev_otp` was removed with commit `d2f228e` (real-only OTP). This assertion **always fails**, making the smoke script permanently broken and the CD's self-test gate permanently failing.
**Options:**
- (A) Rewrite smoke to use a real test-phone OTP flow — requires a Fast2SMS key and a real send; unsuitable for CI without spend.
- (B) Replace the `dev_otp`-assertion step with a `/health` + `POST /auth/otp/request → 200` (no `dev_otp` assertion) + manual OTP for the human staging verify. Smoke proves DB+Redis up and the OTP route accepts the format; the login round-trip is verified by hand during OTP-7.
- **(C) [RECOMMENDED] Add a staging-only `STAGING_OTP_BYPASS_TOKEN`** — a random token the API echoes in the OTP response ONLY when `NODE_ENV=staging` AND the phone matches a synthetic-reserved phone AND the token matches — never a real code path, never broad. Smoke presents it. Resolves TD52 cleanly without a mock-SMS-provider.
**Impact if delayed:** CD smoke gate permanently stuck; staging CD cannot self-verify; Prakash must manually confirm `/health` each time.
**Owner:** DevOps + Backend. Recommend option C as a clean TD52 resolution.

### ESC-2 — TD64 ID collision (P1)
The tech-debt register has two entries labelled TD64. One covers "interview-kit worker notification" (no `worker_id` on the event), the other covers "TAX-3 real embed bypasses SpendLedger (review F3)". A register with duplicate IDs is unreliable as an agent-input document.
**Options:** Renumber the SpendLedger entry to TD68 (next free after TD67).
**Owner:** Prakash (TL) + Divyanshu. Recommend TD68 for SpendLedger item.

### ESC-3 — `kPersistentAuth` is ON but TD62 consent-routing fix is still open (P1, HIGH)
PR #201 flipped `kPersistentAuth=true` in `app_config.dart`. TD62 documents that a never-onboarded worker (set PIN → abandoned before `consent.accepted`) will route to the profiling shell instead of `/consent`. **Hard §6 holds** server-side (ConsentGuard blocks), but the UX is broken for this edge case. This was owner-approved merge-as-is; fix must precede GA.
**Options:** Add a `consent_accepted` or `onboarding_complete` boolean to `GET /workers/me` response (or a new endpoint); gate the PIN-unlock routing on it in `router.dart`.
**Impact if delayed:** Real workers who start onboarding + PIN setup + abandon will see a broken resume flow.
**Owner:** Mobile (Rishi) + Backend (Divyanshu). Needs backend API surface decision first.

### ESC-4 — Staging requires REAL Fast2SMS creds, not a mock — Rishi cannot do B1 without them (P0)
With the `SMS_PROVIDER=console` mock path eliminated, standing up staging requires Fast2SMS + ZeptoMail creds (OTP-7 gate). Rishi cannot complete B1 without a working OTP. The `STAGING_API_BASE_URL` alone is not enough — the login step will fail unless either (a) OTP-7 is activated with real creds + team allowlist, or (b) ESC-1 option C is built first.
**Owner:** Prakash (procure Fast2SMS staging creds + activate OTP-7). Decision not needed — execution missing.

### ESC-5 — `ENV_AND_SECRETS_TRACKER.md` missing two new vars (P2)
`SKILLS_INTERNAL_TOKEN` (ADR-0030 FORK-B-1, `SkillsInternalGuard`) and `VOICE_NOTES_BUCKET` (ADR-0029) are not in the env tracker. Both are required for their respective features to activate.
**Owner:** DevOps. No product decision needed — purely additive doc entries.

---

## What Is Genuinely Left

| Category | Status | Evidence |
|----------|--------|----------|
| **Staging deployment** | NOT DONE — P0 CRITICAL | No `/health` proof; 11+ days past deadline |
| **B1 handset run** | BLOCKED on staging | No staging URL |
| **TD62 kPersistentAuth consent fix** | OPEN, HIGH | PR #201 note; TD62 in register |
| **TD61 CI Flutter pin bump** | OPEN | `worker-app.yml` still pins 3.27.4; payer-app has no CI gate |
| **TAX-9 versioning/re-tag** | P3, unblocked | skills-taxonomy-roadmap.md |
| **RVM vernacular ratification** | HUMAN GATE | packet in docs/registers/skill-vernacular-ratification-packet.md |
| **Ops unlock surface retire** | Blocked ADMIN-4..8 | TD33, TD50 |
| **TD49 drizzle-orm bump** | OPEN | GHSA-gpj5-g38j-94v9 |
| **TD64 (SpendLedger)** | OPEN | renumber to TD68 |
| **TD67 ai-service auth** | OPEN | all routes unauthenticated on internal network |

---

## What Is Gated (§2 privacy / §7 human / legal)

| Item | Gate | Owner |
|------|------|-------|
| Real AI calls (LLM profiling) | `AI_ENABLE_REAL_CALLS=true` + key + staging-first + human sign-off | Divyanshu |
| Real Fast2SMS OTP (OTP-7) | Human-gated, team allowlist only | Prakash |
| Real ZeptoMail payer OTP | Human-gated | Prakash |
| Real payments (Razorpay) | `PAYMENTS_ENABLE_REAL=true` + key + human | TD34, §7 |
| Real WhatsApp messaging | `MESSAGING_ENABLE_REAL=true` + keys + human | §7 |
| Voice audio at-rest (Sarvam) | `VOICE_NOTES_BUCKET` provisioned + real STT gate | ADR-0029, §7 |
| Resume PDF on staging | `RESUME_RENDER_ENABLED=true` + WeasyPrint binary on host | D5, Prakash |
| TAX-5 vernacular aliases | RVM domain owner ratification | skill-vernacular-ratification-packet.md |
| Admin PII reveal (ADMIN-3b) | Weekly review cadence operational | D4, Prakash |
| Production DPDP legal copy | Legal track | §8 |

---

## Honest Completion % (caps applied)

| Area | % | Cap Reason |
|------|---|-----------|
| **Overall Project** | ~77% | No staging/handset proof → ≤85% cap |
| **Alpha Readiness** | ~58% | P0 staging not deployed → ≤60% cap |
| **Release Readiness** | ~29% | RLS not finalized, real providers off, no DR doc |
| Payer Web | ~83% | FE wiring CLOSED (#194); remaining: account-edit, disclosure shape mismatch (D-04) |
| Backend/API | ~86% | TD54 interview-kit + profile-summary shipped; LC-1 ops retire still open |
| Worker App | ~70% | TD62 kPersistentAuth consent gap open; profile-tab mock still mock (endpoint exists, not wired) |
| AI Service | ~80% | TAX series shipped (flag-gated); no real-call staging verify yet |
| Infra/Staging | ~45% | P0 — unchanged, no staging proof |
| Docs/Process | ~88% | This reconciliation pass closes most stale entries |

---

## Top 5 Blockers (ranked)

1. **P0 — Staging not deployed (11+ days overdue)** — Prakash owns provisioning. Nothing below can unblock without a staging URL. Execution, not a decision.
2. **P0 — Smoke script broken; staging login requires real OTP creds** — `dev_otp` gone; OTP-7 Fast2SMS creds needed before any team member can log in on staging. ESC-1 (option C) or OTP-7 activation must precede B1.
3. **P1 HIGH — TD62: `kPersistentAuth` ON, but never-onboarded workers route to shell not `/consent`** — must be fixed before GA (hard §6 holds server-side, but UX is broken for this real edge case).
4. **P1 — Ops unlock surface retire blocked on ADMIN-4..8** — the ops `InternalServiceGuard` `/unlocks*` routes cannot be retired until admin auth for the ops console is built. Not a crisis (payer-facing is correctly guarded), but a known residual (TD33/TD50).
5. **P1 — TD61 CI pin mismatch** — `worker-app.yml` pins Flutter 3.27.4; payer-app uses 3.35.7 APIs; no payer-app CI gate. A payer-app regression will be invisible in CI.
