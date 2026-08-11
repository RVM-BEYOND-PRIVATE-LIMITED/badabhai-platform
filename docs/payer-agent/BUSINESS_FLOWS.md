# Business Flow Traces — Payer + Agency

**Status:** COMPLETE (audited 2026-08-11, dimension re-run after the usage-limit interruption).
**Method:** evidence-based static analysis; every claim carries a `file:line` citation.
**Findings feed** `GAP_REGISTER.md`. Coverage caveats: `AUDIT_STATUS.md`.

---

# End-to-end business flow traces (payer + agency), apps/payer-web ↔ apps/api ↔ packages/db

## Executive summary
I traced all 15 flows (P1–P9, A1–A6) hop-by-hop and opened every implementation named in every hop. Result: 4 flows complete end-to-end in the default flag state (P1 signup, P2 up to publish, P8 capacity, A1/A2/A3 partially), 6 flows are broken or dead-ended by a defect rather than a flag (P2's worker-visibility leg, P4 quota top-up, P5 the entire employer unlock/money loop, P6 both purchase paths, P7 team, P9 suspended-payer), and 5 are honestly flag-gated or honestly parked (P3 AI chat, P5 masked resume, A5 payouts, A6 revenue/bulk-upload/outcome). The single most damaging finding is structural and NOT flag-documented: the employer create path writes `job_postings`, but both the worker feed (`ApplicationsRepository.findOpenJobs`, applications.repository.ts:115-153) and the payer applicant feed (`ReachRepository.findOwnedJobSignalRowById`, reach.repository.ts:183-193) read the *different* legacy `jobs` table whenever `MATCH_V1_ENABLED` is off — which is the committed default (packages/config/src/server.ts:780). So an employer who posts a job is routed straight to `/postings/{id}/applicants` (posting-form.tsx:225) and is told "No posting found here… it isn't one of your postings" about the posting they created 200ms earlier, while no worker ever sees the job. Every downstream money hop (unlock → reveal → resume → credit debit) is therefore unreachable for employers, even though each of those hops is individually correct, transactional and well-tested. The agency persona is the mirror image: agency vacancies live in `jobs` so they DO reach workers and DO have an applicant feed, but no agency page links to it (`/agency/jobs/[jobId]/page.tsx` has no applicants link), so it is reachable only by hand-typing `/postings/{jobId}/applicants`. Second: the `getOrgRole` stub (org-roles.ts:38,46-56) hard-returns `recruiter` outside dev, so `/credits` and `/team` `notFound()` for every real user — which kills BOTH credit-purchase paths (mock and Razorpay) and the entire team flow, and turns the `/plans` "Buy" button into a link to a 404 (plans/page.tsx:215). A payer therefore has exactly the 50 free-tier credits granted at signup (free-tier.service.ts:37-67) and no way to ever buy more. Third: `createPostingAction` returns `{ ok:true, published:false }` on a failed publish (postings/new/actions.ts:82-85) and the form ignores the flag entirely (posting-form.tsx:222-227), so a create-succeeded/publish-failed posting is presented to the payer as a live job. Fourth: `POST /payer/job-postings/:id/quota-topup` can only 409 — payer-web never calls `/plan` or `/boost` (grep returns zero callers), so no posting can ever have the active plan `topUpQuotaForPayer` requires (posting-plans.service.ts:381-392), yet the "Top up" button is rendered on every row. Fifth: ADR-0037's deliberate 403-for-suspended (payer-auth.service.ts:160-162) is collapsed back to "Invalid or expired code" by the client (http-provider.ts:105-108), defeating the exact behaviour that ADR's own comment says it was written to guarantee. On the positive side: tenancy is genuinely session-derived everywhere I checked (no route or body accepts a `payer_id`), the unlock chokepoint's credit-precondition → consent → cap → debit+grant ordering is atomic and idempotent under a per-worker advisory lock (unlocks.service.ts:144-303), the no-oracle neutral-404/neutral-body discipline holds at every hop I traced, and the referral chain (mint → `/i/<code>` → click ping → Play referrer → worker consent → `POST /referrals/attribute` → funnel `accepted`) is fully wired on both sides — it just has no deployed host for `/i/<code>` and a placeholder assetlinks fingerprint.

# End-to-End Business Flow Traces — payer-web ↔ apps/api ↔ packages/db

Branch `feat/747a-spoken-digit-redaction` (≡ main). Every claim below was verified by opening the implementation; nothing is inferred from a name.

---

## 0. THE VERDICT LIST (read this first)

| Flow | Today, a real user attempting this will… |
|---|---|
| **P1 Signup → OTP → session → org → free credits → /dashboard** | …succeed **provided a real ZeptoMail/SMTP credential set is configured**, and land on a working dashboard with 50 free credits. Locally with no mail catcher the API **refuses to boot** (`assertPayerAuthConfig`); with credentials pointing at a dead relay they get a cheerful "code sent" screen and a code that never arrives, forever. |
| **P2 Post a job (manual)** | …fill in the form, click "Post job", be routed to the applicants page — and be told **"No posting found here. It may not exist, or it isn't one of your postings"** about the job they just created. **No worker will ever see the job.** Both are caused by the same `jobs` vs `job_postings` table split with `MATCH_V1_ENABLED` off (the default). With the flag ON, both work. |
| **P3 Post a job (AI chat)** | …open the chat, get a blank opener bubble, type a message, and receive **"Could not send that message right now. Please retry."** on every turn — because no environment deploys `apps/ai-service` (staging-cd.yml says so explicitly) and there is no local fallback by design. Their typed message *is* saved. |
| **P4 Job lifecycle** | …successfully pause / resume / close a posting. **"Top up quota" always fails** ("This posting has no active plan yet — buy a plan first") because payer-web has no buy-plan or buy-boost UI at all. Pressing "Pause" on a *draft* row gives a generic retry error. Illegal transitions are correctly rejected server-side (409). |
| **P5 Applicants → unlock → reveal → resume** | …**never reach step one as an employer** (neutral 404, see P2). As an *agency*, they can only reach it by hand-typing the URL — no page links there. If they do get in: unlock and routed-reveal work correctly and atomically; **the masked resume is always "unavailable"** because `RESUME_RENDER_ENABLED` is off by default. |
| **P6 Buy credits** | …**get a 404**. `/credits` is `requireOwner()`-gated and `getOrgRole()` hard-returns `recruiter` outside dev. Both the mock path and the Razorpay path are behind that same 404, and the `/plans` "Buy" button links straight into it. A payer is permanently capped at their 50 signup credits. |
| **P7 Team: invite → email → accept** | …**get a 404 on `/team`**, and a 404 from the invite/remove Server Actions if they replay them. The backend org-member API is fully live and correct; the frontend gate makes 100% of it unreachable. Even if reachable, no invite email is sent (`MEMBER_INVITES_ENABLE_REAL` off ⇒ mock mailer no-ops) so nobody could accept. |
| **P8 Capacity** | …see a live, honest allowance/usage view, buy a tier with mock money, and read an explicit banner that says **"Recorded only — nothing is blocked yet."** This flow is complete and the UI is honest about shadow mode. |
| **P9 Logout / expiry / suspended** | …log out cleanly. An expired session redirects to `/login` correctly. A **suspended payer is bounced to `/login` and told "Invalid or expired code"** — the ADR-0037 403 that exists precisely so they can learn *why* is swallowed by the client. |
| **A1 Agency signup (role='agent')** | …pick the "Agency" tab, sign up, and get a correctly role-stamped agent account. Login is deliberately role-agnostic (no enumeration oracle). This flow is complete. |
| **A2 Post a vacancy as an agency** | …click "Post a vacancy" in the nav and **create the wrong entity**: the nav points at `/postings/new`, which writes a `job_postings` row that never appears in the agency dashboard's vacancy manager (which reads `jobs`). The *correct* agency create form exists but is only reachable inline on `/dashboard`. |
| **A3 Invite workers → link/QR/WhatsApp → install → attribution** | …mint invite codes and share them successfully. **The `/i/<code>` landing page is served by an app no workflow ever deploys**, and `assetlinks.json` still holds the literal placeholder fingerprint, so App Link verification cannot pass. Every hop after "share the link" is code-complete and inert. |
| **A4 Agency worker list** | …see an **empty list, always**. The backend requires an active `agent_activity_visibility` consent; the worker app only ever requests `['profiling','resume_generation']`. The page treats empty as a first-class state, so it is honest — but it will never show a row. |
| **A5 Earnings → KYC → payout** | …see a **"Payouts coming soon"** card. Every route 404s behind `AgencyPayoutsEnabledGuard` while `AGENCY_PAYOUTS_ENABLED` is off (the default). This is an honest, intentional gate. |
| **A6 Revenue / bulk upload / outcome tracking** | …land on honest dead ends. `/agency/revenue` says "Coming soon"; `/agency/bulk-upload` says **"Not available: consent violation… it will not be built"**. These are correct, and `bulk-upload` even redirects the user to the live batch-mint alternative. |

---

## 1. Legend

`LIVE` = wired and reachable · `FLAG-GATED-OFF` = intentionally inert behind a documented env flag · `STUB` = referenced but has no real implementation · `MISSING` = no code exists · `BROKEN` = code exists on both sides but the chain does not connect · `INSECURE` = reachable and unsafe.

---

## 2. PAYER FLOWS

### P1 — Signup → OTP → verify → session → solo org → free credits → /dashboard

| Hop | Artifact | State |
|---|---|---|
| User action | "Create account" tab, org name + email + optional phone | LIVE — `login-form.tsx:184-211` |
| Frontend route | `/login` (outside `(portal)`, no auth) | LIVE — `app/login/page.tsx` |
| Server Action | `signupAction` | LIVE — `login/actions.ts:59-86` (zod: role enum, org 1..200, email ≤254, E.164 phone) |
| payer-api fn | `payerAuth().signup()` | LIVE — `lib/auth/http-provider.ts:68-94` |
| HTTP path | `POST /payer/signup` (`public:true`, no Bearer) | LIVE — `lib/payer-http.ts:48-52` |
| Guard(s) | none (public) + per-IP hourly cap, fail-closed | LIVE — `payer-auth.controller.ts:50,95-101` |
| Controller | `PayerAuthController.signup` @HttpCode(200) | LIVE — `payer-auth.controller.ts:43-52` |
| Service | `PayerAuthService.signup` | LIVE — `payer-auth.service.ts:69-113` |
| Repos/tables | `payers` (createOrGet, email/phone/org **encrypted at rest**), `payer_orgs` + `payer_members` (`ensureSoloOrg`, idempotent), `credit_ledger` + `payer_credits` | LIVE — `payer-orgs.repository.ts:52-84`; `free-tier.service.ts:37-67` |
| Events | `payer.created` (idempotency `payer.created:<id>`), then on verify `payer.activated` + `payer.session_started` | LIVE — `payer-auth.service.ts:78-86,168-190` |
| External | **ZeptoMail/SMTP via `EmailNotificationService`** — REAL-ONLY, no mock channel exists | LIVE-but-credential-dependent — `payer-portal.module.ts:159-174`, `zeptomail-email-login-channel.ts:26-35` |
| Response | `{ status:"code_sent", resend_in_seconds }` — byte-identical for known/unknown/suspended/send-cap-breached | LIVE (no-enumeration) — `payer-auth.service.ts:309-350` |
| Frontend state | shared `code` step → `verifyCodeAction` → `cookies().set('bb_payer_token', …, httpOnly)` | LIVE — `http-provider.ts:110-115`, `session-cookie.ts:39-48` |
| User-visible | `router.replace("/dashboard")` → dashboard renders credits/unlocks/postings | LIVE — `login-form.tsx:238-242`, `dashboard/page.tsx:37-47` |

**Free-tier grant.** `grantQuietly` (free-tier.service.ts:70-85) swallows failures by design; the amount is `match_config.free_unlock_credits`, which **fails closed to the typed default 50** when the row is absent (`match-config.service.ts:33-45`, `packages/match-engine/src/config.ts:59`). So a payer gets 50 credits even on an un-seeded `match_config`.

**Without a mail catcher locally.** `PAYER_LOGIN_METHOD` defaults to `email_otp` (server.ts:429) and `EMAIL_PROVIDER` to `zeptomail` (server.ts:517). `assertPayerAuthConfig` (server.ts:1588-1592) → `emailProviderBlockedReason` (server.ts:1536-1561) **throws at boot** unless `ZEPTOMAIL_API_TOKEN + ZEPTOMAIL_MAIL_AGENT + EMAIL_FROM_ADDRESS` (or the SMTP triple) are all set. There is no "none"/mock email channel. If the creds are *present but wrong*, `issueAndSend` throws 502, which `issueForExistingAccount` **deliberately swallows to the neutral response** (payer-auth.service.ts:279-288) — the user sees "code sent" and receives nothing.

> **Verdict:** Today, a real user attempting this will: succeed, *if* real email credentials are configured — otherwise either the API will not boot at all, or they will be shown a confident "we sent you a code" for a code that was never delivered.

---

### P2 — Post a job (manual)

| Hop | Artifact | State |
|---|---|---|
| User action | fill form, tick ≥1 match skill, "Post job" | LIVE — `postings/new/posting-form.tsx:200-230` |
| Route | `/postings/new` | LIVE — `postings/new/page.tsx:32` |
| Server Action | `createPostingAction` — re-validates demand fields + `looksLikePii` on description; refuses 0 skills | LIVE — `postings/new/actions.ts:32-86` |
| payer-api fn ① | `createPosting` → resolves `org_label` from `GET /payer/me` (never a form field) | LIVE — `payer-api.ts:1004-1012`, `toPayerJobPostingBody:980-992` |
| HTTP ① | `POST /payer/job-postings` @201 | LIVE |
| Guard ① | `PayerAuthGuard` (class-level) | LIVE — `payer-job-postings.controller.ts:65-66` |
| Controller ① | `create` — `payer.id` from `@CurrentPayer`, body carries no payer_id | LIVE — `:87-95` |
| Service ① | `JobPostingsService.createForPayer` → always `status:'draft'` | LIVE — `job-postings.service.ts:234-255,461-491` |
| Table ① | **`job_postings`** | LIVE |
| Event ① | `job_posting.created` (ids/enums only, actor `payer`) | LIVE — `job-postings.service.ts:481-489` |
| payer-api fn ② | `publishPostingWithMatchSkills` → `PATCH` with `{match_skill_ids, unticked_related_ids, status:"open"}` | LIVE — `payer-api.ts:1138-1157` |
| Service ② | `updateForPayer` → `prepareUpdate` (draft→open only) → `materializeIfNeeded` → `PublishReachService.materialize` writes `job_reach` | LIVE — `job-postings.service.ts:268-292,374-446` |
| Event ② | `job_posting.updated`, `job_posting.reach_materialized`, `job_posting.reach_alert` on zero reach | LIVE |
| Frontend state | `router.push('/postings/{id}/applicants')` | LIVE — `posting-form.tsx:225` |
| **Worker feed — MATCH_V1_ENABLED = false (DEFAULT)** | `getFeed` → `ApplicationsRepository.findOpenJobs` → **`FROM jobs`** | **BROKEN** — `applications.service.ts:86-93`, `applications.repository.ts:115-153` |
| **Worker feed — MATCH_V1_ENABLED = true** | `MatchFeedService.getFeed` → `FROM job_reach jr JOIN job_postings jp` | LIVE — `match-feed.repository.ts:140-147` |

**The fork.** `job_postings` and `jobs` are two different tables. The V1 feed joins `job_reach ⋈ job_postings`; the legacy feed scans `jobs`. A payer-created posting only ever lands in `job_postings`. Therefore **with the default flag state an employer's job is invisible to every worker**, and the `job_reach` rows the publish step wrote are read by nobody.

**Publish-failure honesty gap.** The action returns `{ ok:true, postingId, published:false }` on a publish failure (actions.ts:82-85) with an explicit comment about why. **The form never reads `published`** (posting-form.tsx:222-227) — it navigates on `res.ok` alone. A draft that reaches nobody is presented identically to a published job.

> **Verdict:** Today, a real user attempting this will: successfully create and publish a `job_postings` row, be routed to an applicants page that tells them the posting does not exist, and have their job seen by exactly zero workers — unless `MATCH_V1_ENABLED` is flipped on.

---

### P3 — Post a job (AI chat)

| Hop | Artifact | State |
|---|---|---|
| Route | `/postings/ai/new` | LIVE — `postings/ai/new/page.tsx` |
| Actions | `startJobPostingChatAction` / `sendJobPostingChatMessageAction` / `resume…` / `publish…` | LIVE — `ai/new/actions.ts:52-118` |
| payer-api | 5 fns, body is exactly `{}` or `{session_id,text}` — **never** payer_id, **never** org name | LIVE — `payer-api.ts:1351-1439` |
| HTTP | `POST /payer/job-posting-chat/{session,message}`, `GET …/sessions`, `GET …/sessions/:id/messages`, `POST …/sessions/:id/publish` | LIVE |
| Guard | `PayerAuthGuard` class-level | LIVE — `job-posting-chat.controller.ts:38-39` |
| Service | `JobPostingChatService` — stores the payer turn on the spine **before** any AI call | LIVE — `job-posting-chat.service.ts:170-178` |
| Tables | `payer_job_posting_chat_sessions` / `…_messages` | LIVE |
| Events | `job_posting_chat.session_started`, `…message_sent` (payer + ai_service) | LIVE — `:113-121` |
| **External** | `AiService.jobPostingChatRespond` → `POST {AI_SERVICE_URL}/job-posting-chat/respond`, 8 s timeout | **MISSING in every deployed env** |
| Failure behaviour | `post()` returns `null` on any non-2xx/timeout (`ai.service.ts:376-418`); service **throws 503 with NO local fallback, deliberately** (`job-posting-chat.service.ts:206-212`) | LIVE-by-design |
| Response → UI | action collapses to `"Could not send that message right now. Please retry."` | LIVE — `ai/new/actions.ts:75-76` |
| Publish | `JobPostingChatService.publish` → the **same** `JobPostingsService.createForPayer` (org name auto-filled server-side, never crosses the LLM) | LIVE |

**`AI_ENABLE_REAL_CALLS` is not the gate here.** The engine at `apps/ai-service/app/job_posting_chat/` is deterministic (question bank + interview engine, no model on this route). The gate is *reachability*: `staging-cd.yml:32-45` states in terms that this workflow "deploys NO ai-service, by construction", and that a host whose `AI_SERVICE_URL` points at nothing leaves the API degrading to mock with `/health` at 200 (TD81). The chat opener path returns `null` → the turn renders an **empty** `reply_text` (`job-posting-chat.service.ts:124-140`) and the client is expected to render its own constant.

> **Verdict:** Today, a real user attempting this will: open the chat, see no opener, type a sentence that is durably saved, and hit a permanent "please retry" wall — because the deterministic interview engine it depends on is not deployed anywhere.

---

### P4 — Job lifecycle (pause / resume / close / quota top-up / boost)

| Transition | Backend | Exposed in UI | Illegal transition rejected? |
|---|---|---|---|
| draft → open (publish) | `PATCH /payer/job-postings/:id` `{status:"open"}` | Yes (inside create) | Yes — 409 `Cannot transition … to open` (`job-postings.service.ts:504-506`) |
| open → paused | `POST …/:id/pause` | Yes — `postings-manager.tsx:164-173` | Yes — guarded UPDATE on `status='open'`, else 409 (`:311-324`) |
| paused → open | `POST …/:id/resume` (+ **re-materializes `job_reach`**) | Yes — `:152-162` | Yes — 409 (`:331-357`) |
| draft\|open → closed (terminal) | `POST …/:id/close` | Yes, only for draft/open rows — `:185-195` | Yes; `paused` → 409 "Resume before closing"; `suspended` → 409 (`assertCloseable:674-691`) |
| quota top-up | `POST …/:id/quota-topup` | Yes — `:175-184` | **Always 409** in practice, see below |
| buy plan | `POST …/:id/plan` @201 | **MISSING** — zero callers in payer-web | n/a |
| buy boost | `POST …/:id/boost` @201 | **MISSING** — zero callers in payer-web | n/a |

`topUpQuotaForPayer` (`posting-plans.service.ts:381-392`) requires `findActivePlanForPostingAndPayer` to return a row; a plan is only ever created by `buyPlanForPayer` (payer path, **no UI**) or the ops `PostingPlansController` (`InternalServiceGuard`). So the seam's `QuotaTopUpNoPlanError` branch (`payer-api.ts:1298-1300` → `postings/actions.ts:93-95`) is the *only* reachable outcome. The frontend renders the button regardless of state and disables it only for `closed`.

Minor: the manager renders "Pause" for **draft** rows too (`postings-manager.tsx:164-173`), which 409s and surfaces as the generic "Could not pause the posting right now. Please retry."

> **Verdict:** Today, a real user attempting this will: pause, resume and close normally; be shown a "Top up" button that can only ever fail; and find no way at all to buy the plan or boost that two live, correctly-authorized backend endpoints are waiting to sell them.

---

### P5 — Applicants → masked candidate → unlock → reveal → resume (THE MONEY TRACE)

| Hop | Artifact | State |
|---|---|---|
| Route | `/postings/[id]/applicants` | LIVE |
| Page fetch | `getApplicantFeed(id)` + `getDashboard()` (decoupled try/catch) | LIVE — `applicants/page.tsx:26-41` |
| payer-api | `GET /payer/reach/jobs/{jobId}/applicants`; 404 → `null` | LIVE — `payer-api.ts:240-261` |
| Guard | `PayerAuthGuard` + per-payer hourly reach cap, fail-closed | LIVE — `payer-reach.controller.ts:36,69-72` |
| **Controller fork** | flag ON → `jobPostings.getOneForPayer` then `MatchCandidatesService.listForPosting` (reads `applications.job_posting_id`); flag OFF → `ReachService.applicantsForOwnedJob` | `payer-reach.controller.ts:74-84` |
| **Flag OFF source** | `ReachRepository.findOwnedJobSignalRowById` → **`FROM jobs WHERE id=? AND payer_id=?`** → not found → `NotFoundException` | **BROKEN for employers** — `reach.repository.ts:183-193`, `reach.service.ts:108-110` |
| User-visible (employer, flag OFF) | "No posting found here. It may not exist, or it isn't one of your postings." | `applicants/page.tsx:49-52` |

Assuming the feed *does* render (agency job, or employer with the flag on), the money trace is sound:

| Money hop | Detail | State |
|---|---|---|
| Confirm-on-spend | client dialog, first unlock per row only, faceless copy | LIVE — `applicant-actions.tsx:158-177,505-509` |
| Action | `unlockAction` (uuid-validates both ids) | LIVE — `applicants/actions.ts:33-46` |
| payer-api | `POST /payer/unlocks` body = `{worker_id, job_id}` only | LIVE — `payer-api.ts:270-288` |
| Guards | `PayerAuthGuard` + per-payer hourly disclosure cap (XB-G) | LIVE — `payer-unlocks.controller.ts:47,68` |
| **[F-1] balance check** | `getBalance < 1` → **neutral body**, `payment.failed` emitted for ops only, **no worker state read** | LIVE — `unlocks.service.ts:144-152` |
| [1] consent | `employer_sharing` active consent required, read pre-lock | LIVE — `:154-166` |
| [1b] deletion freeze | pending-deletion → neutral, re-checked in-tx | LIVE — `:168-176,222-228` |
| **Transaction boundary** | `withTransaction` + `pg_advisory_xact_lock(worker_id)`; debit + grant + ledger append **in one tx**; events collected as thunks and flushed **post-commit** (documented pool-vs-lock deadlock fix) | LIVE — `:180-302` |
| **Idempotency (double-click)** | `findByPayerWorker` inside the lock returns the existing live grant → **returns it, no second debit** | LIVE — `:196-204` |
| Ledger | `credit_ledger` `delta:-1 reason:'unlock_debit'` in the same tx | LIVE — `:263-269` |
| Events | `payment.authorized` → `payment.captured` → `unlock.granted` (+ `credits_exhausted` on the exact >0→0 transition read from `debit.balanceAfter`) | LIVE — `:271-292` |
| **Insufficient credits UX** | balance 0 ⇒ Unlock button **disabled** + "Top up to unlock" banner linking `/credits` | LIVE — `applicant-actions.tsx:206-216,468-485` — **but `/credits` 404s (P6)** |
| Reveal | `POST /payer/unlocks/:id/reveal` → ownership + consent + deletion + attempt-cap re-checked, phone decrypted **once**, discarded; returns `{relay_handle, channel, expires_at}` — no number anywhere | LIVE — `unlocks.service.ts:305-420`, `payer-api.ts:298-304` |
| Masked resume | `POST /payer/resume-disclosures` → consent → shared cap → grant → **`PdfRenderer.renderHtmlToPdf` returns `null` when `RESUME_RENDER_ENABLED` is false** → `neutralUnavailable()` | **FLAG-GATED-OFF** — `pdf-renderer.service.ts:31-33`, `resume-disclosure.service.ts:238-243` |

No-oracle discipline holds throughout: every deny cause (no credits / no consent / capped / unknown / already-unlocked / another tenant's unlock) returns the byte-identical neutral body, and the client mapper collapses them to one "Currently engaged" state with no branch that infers the cause.

> **Verdict:** Today, a real user attempting this will: as an employer, be told their own posting does not exist and never reach the money at all; as an agency, only get there by typing the URL by hand, after which unlock and routed reveal work correctly and safely — and the masked résumé button will always come back "unavailable".

---

### P6 — Buy credits (mock vs real Razorpay)

| Hop | Mock path | Real path |
|---|---|---|
| Route | `/credits` | `/credits` |
| **Page gate** | **`requireOwner()` → `notFound()` for every non-dev user** — `credits/page.tsx:49` | same |
| Mode selection | server-side `payerServerConfig().paymentsEnableReal`, fail-closed to mock — `server-config.ts:52-55`, page:52 | same |
| Action | `topUpAction` — **`requireOwner()` first** (`credits/actions.ts:42`, with a long comment explaining a Recruiter could otherwise mint credits) | `createOrderAction` / `verifyPaymentAction` — `requireOwner()` first (`:90,126`) |
| payer-api | `POST /payer/credits` `{pack_code}` only | `POST /payer/credits/order` then `/verify` |
| Guard | `PayerAuthGuard` | same **+ `if (!this.unlocks.realPaymentsLive) throw new NotFoundException()`** — `payer-unlocks.controller.ts:164,198` |
| Gate value | `PaymentGateway.realCall = areRealPaymentsEnabled(config)`; `PAYMENTS_ENABLE_REAL` is `booleanFromString`, **default false** — `payment-gateway.ts:91-93`, server.ts:581 | — |
| Service | `purchaseCredits` → `resolvePack` (LIVE catalog, legacy constants as floor) → `purchasePackMock` → `credit_ledger` + `payer_credits`, `price_inr` stamped | `createCreditOrder` → provider order first, then `payment_orders` row; `verifyCheckoutPayment` HMAC-verifies + binds to session payer |
| Events | `payment.authorized` + `payment.captured` with `real_call:false` | `payment.authorized` keyed per **order row**; settle via webhook **or** verify, converging idempotently |
| Browser | none (mock) | `checkout.razorpay.com/v1/checkout.js` injected; only the public `rzp_*` key id ever reaches the browser, and it arrives on the order **response**, not a `NEXT_PUBLIC_*` — `razorpay-checkout.ts:13,132` |
| UX honesty | "Mock top-up — no real payment is taken" | "Pay securely via Razorpay…"; dismissed ≠ failed ≠ unconfirmed, all distinct copy |

**Which one runs with `PAYMENTS_ENABLE_REAL` unset:** the **mock** path (`purchasePackMock`, `real_call:false`, no money). **Is the mock path reachable in production?** Structurally yes — `POST /payer/credits` has no environment gate, only `PayerAuthGuard` — so an authenticated payer could mint free credits in production if `PAYMENTS_ENABLE_REAL` were flipped without also gating the mock route. In practice today **neither path is reachable through the UI at all**, because `/credits` and all three actions `notFound()` for every non-dev user.

`/plans` compounds it: it renders every credit pack with a "Buy" button whose only behaviour is `<Link href="/credits">` (`plans/page.tsx:215-217`) — i.e. a button to a 404.

> **Verdict:** Today, a real user attempting this will: get a 404 — from the nav (the link is hidden), from `/credits` directly, and from the `/plans` "Buy" button — and will remain permanently capped at the 50 credits their signup granted.

---

### P7 — Team: invite → email → accept → active member → Owner-only gates

| Hop | Artifact | State |
|---|---|---|
| Nav link | rendered only when `isOwner` — `portal-nav.tsx:50-54` | **never rendered** (`getOrgRole` ⇒ recruiter) |
| Page | `/team` → **`requireOwner()` → `notFound()`** | **BROKEN** — `team/page.tsx:17` |
| Actions | `inviteMemberAction` / `removeMemberAction` re-assert `requireOwner()` (correct defence-in-depth); `acceptInviteAction` gates on `requirePayer()` only | `team/actions.ts:27,38,48` |
| payer-api | `GET/POST /payer/org/members`, `DELETE /payer/org/members/:id`, `POST /payer/org/invites/accept` | LIVE — `lib/org-members.ts:72-132` |
| Guards | `PayerAuthGuard` + `PayerOrgRoleGuard`; `@OrgRoles("owner")` on the two writes; reads open to any member | LIVE — `payer-org-members.controller.ts:34,46,59`; guard `payer-org-role.guard.ts:71-98` |
| Service | seat cap (`MEMBER_INVITE_MAX_PER_ORG`, default 25), dup-invite 409, single-use token stored **only as keyed HMAC**, email encrypted + returned masked | LIVE — `payer-org-members.service.ts:80-120` |
| Tables | `payer_orgs`, `payer_members` — accept is one guarded UPDATE (no TOCTOU), token consumed to `NULL` | LIVE — `payer-orgs.repository.ts:206-232` |
| Events | `payer_member.invited` (PII-free) | LIVE |
| **Email** | `MEMBER_INVITE_MAILER` factory → **`MockMemberInviteMailer` no-op** unless `MEMBER_INVITES_ENABLE_REAL` (default false) + creds + `MEMBER_INVITE_ACCEPT_URL` | FLAG-GATED-OFF — `payer-portal.module.ts:117-125`, `member-invite.mailer.ts:33-46` |
| Accept page | `/team/accept?token=…` exists and gates on `requirePayer()` | LIVE — `team/accept/page.tsx` |

**Where it dies, precisely:** at the very first hop. `getOrgRole(_session)` ignores its argument and returns `"recruiter"` outside dev (`org-roles.ts:46-56`), so `requireOwner()` (`:64-70`) calls `notFound()`. The backend org API, the guard, the seat cap, the single-use token, the soft-remove and the accept flow are all complete and correct — and 100% unreachable.

> **Verdict:** Today, a real user attempting this will: not see a Team link, get a plain 404 if they type `/team`, and get a 404 from the invite action if they replay it — so no teammate can ever be invited, and even if one were, no email would be sent to accept with.

---

### P8 — Capacity → shadow enforcement

| Hop | Artifact | State |
|---|---|---|
| Routes | `/capacity` and the merged `/plans` — both `requirePayer()` only | LIVE — `capacity/page.tsx:33`, `plans/page.tsx:20` |
| Read | `getCapacity()` = `GET /payer/capacity` ‖ `getPostings()` | LIVE — `payer-api.ts:454-481` |
| Guard | `PayerAuthGuard`; **no `:payerId` param anywhere** | LIVE — `payer-capacity.controller.ts:22-36` |
| Write | `upgradeCapacityAction` → `requirePayer()` → tier code validated against the live catalog → `POST /payer/capacity` `{tier}` only | LIVE — `capacity/actions.ts:29-52` |
| Service | `PostingPlansService.buyCapacity` — mock-pay, raises allowance, auto-resumes paused plans under an advisory lock | LIVE |
| **Enforcement** | `isCapacityEnforcementEnabled(config)` — `CAPACITY_ENFORCEMENT_ENABLED` default **false** ⇒ shadow: computes `wouldPause`, logs a PII-free would-pause line, **emits no `posting_plan.paused`**, never pauses | FLAG-GATED-OFF — `posting-plans.service.ts:188-248`, server.ts:671 |
| **UI honesty** | Explicit toast: *"Recorded only — nothing is blocked yet… the concurrent-vacancy cap is not yet enforced, so it does not pause or block any posting today. Mock payments only."* Present on **both** `/capacity` (`:123-129`) and `/plans` (`:126-132`); `/postings/new` shows a non-blocking at-capacity warning (`postings/new/page.tsx:93-103`) | LIVE and honest |

One residual dishonesty: the at-capacity card says *"new postings **will be paused** until you add capacity"* (`capacity/page.tsx:107-110`) in the same page as the "nothing is blocked yet" toast. The two statements contradict each other.

> **Verdict:** Today, a real user attempting this will: see a truthful live allowance and usage, buy capacity with mock money that is genuinely recorded, and be told plainly that nothing is enforced — with one contradictory "will be paused" line to fix.

---

### P9 — Logout / session expiry / suspended payer

| Case | Chain | State |
|---|---|---|
| Logout | `logoutAction` → `payerAuth().logout()` → best-effort `POST /payer/logout` (revokes the Redis session) → **always** deletes the `bb_payer_token` cookie → `redirect('/login')` | LIVE — `logout-action.ts:7-10`, `http-provider.ts:141-150`, `payer-auth.controller.ts:87-92` |
| Expiry | `PayerAuthGuard` → `validateAndTouch` fails → 401 → `payerFetch` throws `PayerUnauthorizedError` → `currentSession()` → `null` → `requirePayer()` → `redirect('/login')` | LIVE — `payer-http.ts:61`, `http-provider.ts:129-139`, `lib/auth/index.ts:25-29` |
| Rolling token | past the half-life the guard mints a fresh JWT into the `x-session-token` response header | LIVE — `payer-auth.guard.ts:127-133` — **payer-web never reads this header**, so the cookie is never refreshed from it (the session slides server-side in Redis, so this is cosmetic) |
| **Suspended payer** | `PayerAuthGuard` reads `{role,status}` from the row **every request** and throws **403** for anything but `active` (`payer-auth.guard.ts:106-118`). `payerFetch` maps only 401 specially; a 403 becomes a generic `Error` (`payer-http.ts:61-65`), which `currentSession()` catches and returns `null` for (`http-provider.ts:133-138`) ⇒ redirect to `/login`. At `/login`, `verifyLogin` throws `ForbiddenException("Account is suspended")` (`payer-auth.service.ts:160-162`) — which `verifyCode` collapses to `NEUTRAL_LOGIN_ERROR = "Invalid or expired code."` (`http-provider.ts:105-108`). | **BROKEN intent** |

The ADR-0037 comment at `payer-auth.service.ts:151-159` states the 403 is *deliberately* distinct from the 401 "because a suspended payer must be able to learn WHY", and cites TD110 (payer login down and invisible) as the cost of the alternative. The client re-introduces exactly that alternative.

Also verified: suspension revokes live sessions immediately (`AdminActionsService` injects `PayerSessionService` for `revokeAll`) *and* the per-request row read makes the gate hold even if a revoke is missed.

> **Verdict:** Today, a real user attempting this will: log out and time out cleanly; but a suspended payer will be bounced to the login screen and told their code is "invalid or expired", with no way to learn they have been suspended — the precise failure ADR-0037 was written to prevent.

---

## 3. AGENCY FLOWS

### A1 — Agency signup (role='agent') and how the persona is chosen

`apps/payer-web/src/app/login/actions.ts` + `login-form.tsx`:

- The persona is a **signup-time** choice: ARIA `Tabs` (Company | Agency) map through `PAYER_ROLE = { company:"employer", agency:"agent" }` (`login-form.tsx:52`) and are passed to `signupAction({ role, … })` (`:202-207`).
- `signupAction` validates `role` against `z.enum(["employer","agent"])` (`actions.ts:22,65`) and forwards it as the account's stored role.
- **Login is deliberately role-agnostic.** The file header (`login-form.tsx:22-28`) makes this load-bearing: "LOGIN MUST NEVER REJECT OR BRANCH ON THE SELECTED TAB — doing so would leak whether an email is a Company or an Agency (a role-enumeration oracle)." `verifyCodeAction` sends only `{email, code}`; the server resolves the role from the row (`payer-auth.service.ts:182,197`).
- The role is then authoritative from the DB on every request (`payer-auth.guard.ts:120-125`), not from the session claim.

> **Verdict:** Today, a real user attempting this will: pick "Agency", sign up, and get a correctly role-stamped `agent` account that lands on the agency-labelled portal — this flow is complete and its no-enumeration property is genuinely enforced.

---

### A2 — Post a vacancy as an agency

| Hop | Agency path (`jobs` entity) | Employer path (`job_postings` entity) |
|---|---|---|
| Entry | inline form on `/dashboard` → `AgencyJobsManager` | nav "Post a vacancy" → `/postings/new` |
| Action | `createAgencyJobAction` — `requireAgent()` first | `createPostingAction` — no role gate |
| HTTP | `POST /payer/agency/jobs` @201 | `POST /payer/job-postings` @201 |
| Guards | `PayerAuthGuard` + `PayerRoleGuard` + `@PayerRoles("agent")` | `PayerAuthGuard` only |
| Table | **`jobs`** (`payer_id` = session) | **`job_postings`** |
| Event | `job.created` | `job_posting.created` |
| Fields | trade_key, title, city, area, pay band, exp window, needed_by | org_label, role_title, location_label, description, vacancies |
| Reaches workers? | **Yes** (legacy feed scans `jobs`) | **No**, unless `MATCH_V1_ENABLED` |

Sources: `agency/dashboard/jobs-actions.ts:58-71`, `agency-jobs.controller.ts:31-46`, `payer-api.ts:578-585`; vs the P2 chain.

**They do NOT write to the same tables**, and the portal navigation sends an agent to the *wrong* one. `portal-nav.tsx:32-40` renders "Post a vacancy" → `/postings/new` for `isAgency`, and "Manage vacancies" → `/postings` (which reads `job_postings`). Meanwhile `dashboard/agent-sections.tsx:222-231` renders the real agency vacancy manager over `jobs`, and `dashboard/page.tsx:95-105,173` deliberately *omits* the `job_postings`-derived tile and list for agents to avoid a contradiction — which is exactly the contradiction the nav re-creates.

> **Verdict:** Today, a real user attempting this will: click "Post a vacancy" in the nav, fill in the employer form, and create a `job_postings` row that never appears in their agency vacancy list — while the correct agency form sits further down the dashboard with no nav entry of its own.

---

### A3 — Invite workers → link / QR / WhatsApp → `/i/[code]` → click → Play → install → attribution → funnel

| Hop | Artifact | State |
|---|---|---|
| Single mint | `createInviteAction` → `requireAgent()` → PII screen on the campaign tag (`looksLikeActionContextPii`) → `POST /payer/agency/invites` | LIVE — `invite-actions.ts:44-96` |
| Batch mint | `POST /payer/agency/invites/batch` (`count` scalar only, `.strict()`, no array of people) | LIVE — `agency-invites.controller.ts:94-114` |
| Guards | `PayerAuthGuard` + `PayerRoleGuard` + `@PayerRoles("agent")` + per-payer hourly mint cap, fail-closed (cap-hit and Redis-down are the same 429) | LIVE — `:35-36,56-59,101-105` |
| Table / event | `agency_invites`; `agency_invite.created` | LIVE |
| Share | copy link, `wa.me/?text=…` contact picker, printable QR poster | LIVE — `invite-share.ts:105-123`, `agency/qr/qr-invite.tsx`, `invite-panel.tsx` |
| Landing | `/i/[code]` — outside `(portal)`, no auth, zero client JS, **renders identically for valid/invalid/expired codes** (no oracle) | LIVE in code — `app/i/[code]/page.tsx:89-166` |
| **Landing is deployed?** | `apps/payer-web` is built and linted by ci.yml's `node` job but **deployed by no workflow**; `staging-cd.yml` deploys only `@badabhai/api` | **MISSING (deployment)** |
| Click ping | server-side `POST /invites/:code/click`, 1.2 s timeout, every error swallowed | LIVE — `invite-landing.ts:148-164`; endpoint `messaging.controller.ts:79` |
| Play Store | `referrer=bb_code=<code>`; a malformed code deliberately gets the bare listing rather than burning the app's one claim | LIVE — `invite-landing.ts:39-55` |
| App Link | `public/.well-known/assetlinks.json` still contains the literal `REPLACE_WITH_PLAY_APP_SIGNING_SHA256_FINGERPRINT_RELEASE_IS_BLOCKED_UNTIL_THIS_IS_SET` | **STUB** — assetlinks.json:7 |
| `intent://` fallback | leg 2, user-tapped, with the Play URL percent-encoded as `S.browser_fallback_url` | LIVE — `invite-landing.ts:109-115` |
| Install referrer | `InstallReferrerReader` parses `bb_code` once and stores it pending | LIVE — `worker-app/lib/core/referral/install_referrer_reader.dart` |
| Attribution | after consent, fire-and-forget `POST /referrals/attribute` with the code + install source | LIVE — `consent_repository_impl.dart:20-70` |
| Guard | `WorkerAuthGuard` (worker id from the token, never the body) + per-IP hourly cap; response is a constant-time neutral `{ok:true}` | LIVE — `referral-attribution.controller.ts:39-62` |
| Service | consent gate fail-closed → first-touch click claim → worker-invite seam → **agency seam on `unknown_code` only** | LIVE — `referral-attribution.service.ts:73-105` |
| Agency seam | `attributeWorkerToInvite` → re-checks consent → single-winner `markAccepted` → `agency_invite.accepted` + `invite.install` | LIVE — `agency.service.ts:670-725` |
| Funnel | `GET /payer/agency/referrals/summary` — aggregate only, k-anon floor applied **server-side**, `minBucket` echoed so the UI renders "<N" not 0 | LIVE — `agency-invites.controller.ts:137-140`, `agency/referrals/page.tsx:126-163` |

> **Verdict:** Today, a real user attempting this will: mint and share invite links successfully, and see their funnel counts move for `created` — but every link they send points at a page that no deployed environment serves, and even once it is deployed the placeholder assetlinks fingerprint means Android will never verify the App Link, so every install falls back to the Play-referrer leg.

---

### A4 — Agency worker list (faceless)

| Hop | Artifact | State |
|---|---|---|
| Route | `/agency/workers`; nav card on `/dashboard` deliberately shows **no count** (a count would itself be a consent signal) | LIVE — `agent-sections.tsx:186-201` |
| payer-api | `GET /payer/agency/workers`, parsed **loosely first** so a regressed backend key survives to `assertNoAgencyPII` (which throws in dev/test), then re-projected strictly | LIVE — `payer-api.ts:772-803` |
| Guards | `PayerAuthGuard` + `PayerRoleGuard` + `@PayerRoles("agent")` + the shared hourly reach cap (scrape bound) | LIVE — `agency-workers.controller.ts:24-46` |
| Tenancy | `inviter_payer_id` = session; **no parameterised variant exists** | LIVE |
| **Consent** | SQL requires `jsonb_exists(wc.purposes, 'agent_activity_visibility')` | LIVE — `agency-workers.repository.ts:116` |
| **Consent ever granted?** | worker app requests exactly `['profiling','resume_generation']` | **MISSING** — `worker-app/lib/features/consent/presentation/cubit/consent_cubit.dart:48` |
| What an agency can see | a per-agency HMAC pseudonym `ref` (never the worker uuid), `profileComplete`, `appliedCount`, `unlockedCount`, coarse UTC `lastActiveOn` | LIVE — `agency-workers.service.ts:5-20,66-90` |
| What an agency can **do** | **nothing** — read-only, no event, no action, no drill-down; `ref` is a pseudonym precisely so nothing can be joined against it, and the row order is re-derived from `ref` so it leaks no uuid signal | LIVE by design |

The seam's own doc (`payer-api.ts:787-791`) already states this: *"An EMPTY array is therefore the normal answer — today it is the ONLY answer, because no client requests that consent purpose yet."*

> **Verdict:** Today, a real user attempting this will: open the page, see an honest empty state, and never see a single worker — because no client on the platform has ever asked a worker for the consent this view requires.

---

### A5 — Earnings → KYC → payout request

| Hop | Artifact | State |
|---|---|---|
| Route | `/agency/referrals` — `requireAgent()` first | LIVE — `agency/referrals/page.tsx:47` |
| payer-api | `getAgencyEarnings` / `getAgencyKyc` / `submitAgencyKyc` / `listAgencyPayouts` / `requestAgencyPayout` — each maps a 404 to `null` = "not enabled" | LIVE — `payer-api.ts:823-916` |
| Guards | `PayerAuthGuard` + `PayerRoleGuard` `@PayerRoles("agent")` + **`AgencyPayoutsEnabledGuard`** | LIVE — `agency-payouts.controller.ts:21-22` |
| **Gate** | `AGENCY_PAYOUTS_ENABLED` (`booleanFromString`, default false) ⇒ **neutral 404 on every route**, so no financial PII can even be collected | FLAG-GATED-OFF — `agency-payouts-enabled.guard.ts:16-22` |
| UI when off | a "Payouts coming soon" card with copy that keeps the referral link/funnel meaningful; **distinguished from an error state** (`earningsError` renders a separate retry card) | LIVE and honest — `agency/referrals/page.tsx:186-202` |
| If flipped on: accrual | `recomputeAccruals` — `ON CONFLICT (source_unlock_id) DO NOTHING`, so events fire exactly once | LIVE — `agency-payout.service.ts:67-86` |
| Gate 1 | KYC must be `verified` — settable **only** by the ops console (`POST /ops/agency-kyc/:payerId/verify`, `InternalServiceGuard`), whose UI lives in `apps/web/src/app/ops/agency-kyc/` | LIVE (cross-app) |
| Gate 2 | requestable total ≥ ₹ threshold; any refusal emits `agency_payout.blocked` and changes no state | LIVE — `:136-148` |
| Money | MOCK — no real disbursement anywhere on this path | FLAG-GATED-OFF by design |

**Where it dies with the flag unset, precisely:** at `AgencyPayoutsEnabledGuard.canActivate` — before the controller, before any KYC field is read, before any earnings query runs. The seam maps that 404 to `null` and the page shows "coming soon".

> **Verdict:** Today, a real user attempting this will: see a "Payouts coming soon" card and nothing else — no KYC form, no earnings figure, no payout button — which is exactly what the gate is supposed to do.

---

### A6 — Revenue / bulk upload / outcome tracking (parked)

| Surface | Route | Honest? |
|---|---|---|
| Revenue | `/agency/revenue` — `requireAgent()` + portal flag; renders one "Coming soon" card and **reads no session data** | Yes — `agency/revenue/page.tsx:9-33`. Dashboard/nav both link to it and its tile shows "—", not a fabricated number. |
| Bulk upload | `/agency/bulk-upload` — renders **"Not available: consent violation… This is not pending a release — it will not be built"**, then a second card pointing at the live batch mint | Yes, and better than honest — `agency/bulk-upload/page.tsx:33-50`. The dashboard tile is labelled "Not available", never "Coming soon" (`agent-sections.tsx:280-295`). |
| Outcome tracking | `agencyOutcomeTrackingEnabled` — default OFF, drives a parked-module **label only**; `config.ts:44-48` states plainly "there is NO code path that builds those flows… flipping any one of them on ships NOTHING by itself" | Yes — `lib/config.ts:53-98`, `parked-modules.tsx` |

All three are non-clickable/inert cards, not fake flows. `agencyPortalEnabled` defaults ON and fail-closes the whole agency shell to `notFound()` if turned off.

> **Verdict:** Today, a real user attempting this will: land on a card that tells them the truth — "coming soon" for revenue, and a flat, permanent "will not be built" for bulk upload with a pointer to the shipped alternative.

---

## 4. Cross-cutting observations from the traces

1. **Tenancy is genuinely session-derived.** Across every payer/agency route I opened, no controller accepts a `payer_id` from a body, param or query; `payerFetch` structurally cannot send one (`payer-http.ts:33-41` documents it). `PayerAuthGuard` re-reads `{role,status}` from the row on every request rather than trusting the JWT claim.
2. **No-oracle discipline holds end to end.** Unknown-vs-not-owned is the same neutral 404 on job-postings, agency jobs, chat sessions, unlocks and reveals; every unlock/disclosure deny cause returns a byte-identical body; the `/i/<code>` landing renders identically for every code class.
3. **The two "vacancy" entities are the systemic defect.** `jobs` (agency + legacy feed + reach) and `job_postings` (employer + V1 feed + V1 candidates) are joined nowhere. `MATCH_V1_ENABLED` does not migrate between them — it *swaps which persona works*. Off: agencies reach workers, employers do not. On: employers reach workers, agency `jobs` rows lose their applicant feed (the V1 branch resolves ownership via `jobPostings.getOneForPayer`).
4. **`getOrgRole` is a single stub with money-and-people blast radius.** It is the sole reason two complete, well-tested backend subsystems (credits purchase, org members) are 100% unreachable.
5. **Latent schema drift:** `jobPostingWireSchema.status` is `["draft","open","closed","paused"]` (`contracts.ts:780`) but `job_postings.status` can also be `"suspended"` (`job-postings.dto.ts:184`, `admin-actions.repository.ts:166`). Today a suspended posting only exists while its owner is suspended and cannot authenticate — but any partial/ordering failure in the reinstate cascade would make `getPostings()` throw a Zod error and blank `/postings`, `/dashboard`, `/capacity` and `/plans` simultaneously.
6. **Test coverage of these flows is thin exactly where they break.** `tests/e2e/payer-tenancy.e2e.test.ts`, `phase1-flow.e2e.test.ts` and `swipe-to-apply.e2e.test.ts` are hard `describe.skip`, and payer-web has no Playwright/Cypress anywhere — so no test exercises "create a posting, then open its applicants", which is the one assertion that would have caught the `jobs`/`job_postings` split.
