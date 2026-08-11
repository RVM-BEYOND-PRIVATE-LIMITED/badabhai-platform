# API Contract Parity — payer-web ⇄ apps/api (+ Flutter cross-check)

**Status:** COMPLETE (audited 2026-08-11, dimension re-run after the usage-limit interruption).
**Method:** evidence-based static analysis; every claim carries a `file:line` citation.
**Findings feed** `GAP_REGISTER.md`. Coverage caveats: `AUDIT_STATUS.md`.

---

# Frontend↔Backend API Contract Parity (apps/payer-web ⇄ apps/api /payer/*, plus apps/payer-app cross-check)

## Executive summary
I traced all 43 distinct `/payer/*` paths that `apps/payer-web/src/lib/payer-api.ts` + `auth/http-provider.ts` + `org-members.ts` + `live-catalog.ts` reach through `payerFetch`, and opened the producing controller, service, repository and DTO for each. Of ~44 response schemas in `apps/payer-web/src/lib/contracts.ts` and its siblings, 31 are field-for-field MATCH, 2 are hard DRIFT that throw at parse time, 8 are silent-degradation DRIFT (a `.optional()` or a plain `z.object()` strip hides a field the backend genuinely sends), and 2 are latent DRIFT held shut only by an auth guard rather than by the contract. The single worst defect is `unlockProjectionWireSchema.status` (contracts.ts:575) accepting `granted|revealed|expired|revoked` while `packages/db/src/schema/payer.ts:188` defines `requested|granted|revealed|expired|denied` — `unlocks.repository.ts:244` writes `'denied'` on every no-consent/capped unlock attempt and `listByPayer` (unlocks.repository.ts:601-609) applies no status filter, so the first denied unlock a payer ever makes permanently breaks `GET /payer/unlocks`, and via `Promise.all` in `getDashboard` (payer-api.ts:174) the entire dashboard. `revoked` is in the frontend enum and exists nowhere in the backend. The second-worst is silent, not loud: `PayerJobPostingsController` enriches every posting row with real `applicant_visibility_quota` / `applicants_viewed_count` / `boosted` / `disclosures_count` (payer-job-postings.controller.ts:23,74-84,111), and `jobPostingWireSchema` — a plain `z.object` — strips all of them, after which `toPostingSummary` (payer-api.ts:947-958) hardcodes `applicantCount: 0` and omits `applicantQuota` on a comment that is now false; the /capacity page consequently sums 0 and 0 for every payer (payer-api.ts:477-478), making the paid "view more → pay more" loop unreadable. The AI job-posting chat has a straight field-name mismatch: the backend draft field is `skills` (packages/ai-contracts/src/job-posting.ts:86) and there is deliberately no `trade_key`, while contracts.ts:1158-1159 reads `trade_key` and `skill_phrases`, so `draft-preview.tsx:117,123` renders "Trade: —" and an empty skills row on every turn. The backend's honest `unmapped_fields` gap report on publish (job-posting-chat.dto.ts:186-193) is likewise stripped and never shown. On error handling, `payer-http.ts:62-65` throws away the body of every non-2xx, discarding the `{statusCode, error:{message, issues:[{path,message}]}}` envelope that `zod-validation.pipe.ts:17-24` and `all-exceptions.filter.ts:31-39` construct — every field-level 400 reaches the user as "payer API /path returned 400". Pagination is inconsistent across five conventions (bare array, `{unlocks}`, `{ledger}`, `{workers}`, `{sessions}`, `{skills}`, `{applicants}`, `{revision,source,products}`) with no cursor and no total anywhere and a silent `OPS_LIST_CAP = 500` truncation on unlocks; that inconsistency has already bitten the Flutter payer app, whose `fetchJobs` reads `res.body['items'] ?? res.body['data']` against an endpoint that returns a bare array (http_payer_api_client.dart:58-68), so its company job list is permanently and silently empty. Money units are the one dimension that is clean: `packages/pricing/src/types.ts:12,30` pins whole-integer ₹, `razorpay.client.ts:50-57` is the single paise conversion at the provider boundary, and `format.ts:21-26` throws on a non-integer — no unit mismatch exists, though `dashboard/page.tsx:85` hardcodes `formatInr(40)` instead of the catalog-derived `unlockUnitPriceInr`. Finally, none of the 83 payer-web tests exercise a real backend shape; `payer-api.test.ts` builds every fixture by hand, which is exactly why the `denied` status and the enriched posting fields were never caught.

# Frontend ⇄ Backend Contract Parity Register — payer-web ⇄ apps/api

Scope: every Zod schema in `apps/payer-web/src/lib/contracts.ts` (plus the auth schemas in `apps/payer-web/src/lib/auth/http-provider.ts`, the org schemas in `apps/payer-web/src/lib/org-members.ts`, and the catalog schema in `apps/payer-web/src/lib/live-catalog.ts`), diffed field-by-field against the NestJS controller + service + DTO that produces it.

## 0. Why drift here is P0-class

`apps/payer-web/src/lib/payer-http.ts:44-72` is the *only* path from payer-web to the API. Every response is `opts.schema.parse(json)` (line 71). Zod `z.object()` is **strip**, not passthrough — so:

- a **missing/extra-typed required field** ⇒ `ZodError` thrown ⇒ the page renders its error state (LOUD, P0-class);
- an **extra field the schema does not model** ⇒ silently dropped (QUIET, silent-degradation class);
- an **`.optional()` on a field the backend renamed** ⇒ silently `undefined` forever (QUIET, worst class — looks shipped, is dead).

Both failure modes are represented below.

---

## 1. Master parity table

Legend — **MATCH** = verified identical; **DRIFT-HARD** = throws at parse; **DRIFT-SILENT** = parses but loses/fabricates data; **DRIFT-LATENT** = would throw, currently unreachable only because of a guard.

| # | Schema (frontend) | FE file:line | Backend producer | Field | FE expects | BE sends | Verdict | Consequence |
|---|---|---|---|---|---|---|---|---|
| 1 | `unlockProjectionWireSchema` | contracts.ts:567-580 | `unlocks.repository.ts:601-609` → `project()` :618-629 | `status` | `"granted"\|"revealed"\|"expired"\|"revoked"` (:575) | `UnlockStatus` = `"requested"\|"granted"\|"revealed"\|"expired"\|"denied"` (`packages/db/src/schema/payer.ts:188`) | **DRIFT-HARD** | `'denied'` is written by `recordDeny` (`unlocks.repository.ts:244`) on every no-consent / capped unlock; `listByPayer` has **no status filter**. One denied unlock permanently breaks `GET /payer/unlocks` → `getUnlocks()` (payer-api.ts:151) throws → `getDashboard()` `Promise.all` (payer-api.ts:174) throws → dashboard + unlock history dead. |
| 2 | same | contracts.ts:575 | — | `status` | includes `"revoked"` | backend has no `revoked` value anywhere | **DRIFT-SILENT (dead value)** | Dead enum member; `getUnlocks` maps it to `"expired"` (payer-api.ts:161) and it can never occur. Misleads the next reader. |
| 3 | `jobPostingWireSchema` | contracts.ts:771-786 | `payer-job-postings.controller.ts:105-112` returns `PayerJobPostingView[]` = `JobPostingApi & PostingStats & {disclosures_count}` (:23) | `applicant_visibility_quota`, `applicants_viewed_count`, `boosted`, `plan_tier`, `disclosures_count` | **not modelled** | real values from `PostingPlansService.getPostingStats` (`posting-plans.service.ts:130-135,159-175`) | **DRIFT-SILENT** | `z.object` strips all 5. `toPostingSummary` (payer-api.ts:947-958) then hardcodes `applicantCount: 0` and omits `applicantQuota` on a comment ("NOT in this projection") that the enriched controller made **false**. Capacity page sums 0/0 (payer-api.ts:477-478). The paid quota loop is unreadable. |
| 4 | `jobPostingWireSchema` | contracts.ts:780 | `packages/db/src/schema/job.ts:176-181` CHECK `('draft','open','paused','suspended','closed')`; written by `admin-actions.repository.ts:166` | `status` | 4 values, no `suspended` | can be `suspended` | **DRIFT-LATENT** | Held shut ONLY by `PayerAuthGuard` 403-ing a non-`active` payer (`payer-auth.guard.ts:116-118`) — the cascade suspends payer + postings in one tx (`admin-actions.service.ts:122-125`). If per-posting suspension is ever added, or the guard relaxed, **every** payer posting read hard-fails (`z.array` → whole list). |
| 5 | `agencyJobWireSchema` | contracts.ts:812-827 | `agency.service.ts:782-799` `toJobView`; `AgencyJobView.status = Job["status"]` (:22) | `status` | `"open"\|"closed"` (:814) | `JobStatus = "open"\|"closed"\|"suspended"` (`job.ts:268`); written by `admin-actions.repository.ts:177` | **DRIFT-LATENT** | Same guard-only protection as #4, for the agency demand list. |
| 6 | `jobPostingChatDraftWireSchema` | contracts.ts:1156-1171 | `JobPostingDraftSchema`, `packages/ai-contracts/src/job-posting.ts:83-109` | `skill_phrases` (:1159) | `z.array(z.string()).optional()` | backend field is **`skills`** (:86) | **DRIFT-SILENT** | `toJobPostingDraft` (contracts.ts:1197) always yields `skillPhrases: []`. `draft-preview.tsx:123` `<TagRow label="Skills" values={draft.skillPhrases}/>` is permanently empty. |
| 7 | same | contracts.ts:1158 | same | `trade_key` | `z.string().nullable().optional()` | **field does not exist** on `JobPostingDraftSchema` | **DRIFT-SILENT** | `draft.tradeKey` is always `null` → `draft-preview.tsx:117` renders "Trade: —" on every turn of the AI posting chat. |
| 8 | `jobPostingChatPublishWireSchema` | contracts.ts:1348-1352 | `PublishJobPostingChatResponseSchema`, `job-posting-chat.dto.ts:186-193` | `unmapped_fields` | **not modelled** | `z.array(z.enum(UNMAPPED_DRAFT_FIELDS))` — pay_min/pay_max/shift/benefits/requirements | **DRIFT-SILENT** | Stripped; `publishJobPostingChatSession` returns only `{jobPostingId}` (payer-api.ts:1435). The backend built this deliberately ("reported back BY NAME so the client can tell the payer what did not make it onto the posting", dto:172-175) and the web client throws it away. The payer is never told their pay range / shift / benefits were dropped. |
| 9 | `jobPostingChatTranscriptWireSchema` | contracts.ts:1311-1318 | `JobPostingChatMessagesResponseSchema`, `job-posting-chat.dto.ts:150-158` | `suggested_replies` | `.optional()` (:1316) | **not in the response** | **DRIFT-SILENT** | `toJobPostingChatTranscript` always sets `suggestedReplies: []` (contracts.ts:1337). Resuming a chat cross-device loses the answer chips — the exact feature the endpoint exists for. |
| 10 | same | contracts.ts:1311-1318 | dto:155 | `published_job_posting_id` | not modelled | sent | **DRIFT-SILENT** | Stripped; a resumed already-published session cannot link to its posting. |
| 11 | `jobPostingChatTurnWireSchema` | contracts.ts:1217-1227 | `JobPostingChatTurnResponseSchema`, `job-posting-chat.dto.ts:111-127` | `is_mock` (:121), `asked_question_id` (:122), `started_at` (:126) | not modelled | sent (`is_mock` defaults **true**) | **DRIFT-SILENT** | The client can never surface that the chat is running on mocked AI. |
| 12 | `jobPostingChatSessionWireSchema` | contracts.ts:1261-1270 | `JobPostingChatSessionSummarySchema`, dto:74-85 | `location_label`, `vacancy_band` | not modelled | sent (:80-81) | **DRIFT-SILENT** | Resume cards show only the role title. |
| 13 | `jobPostingChatSessionListWireSchema` | contracts.ts:1297-1300 | dto:88-92 | envelope | union `[]` \| `{sessions:[]}` | **always** `{sessions:[]}` | MATCH (over-tolerant) | The bare-array branch is dead code; the comment "both list conventions ship in-repo" is true of the API overall but not of this route. |
| 14 | `payerMeWireSchema` | contracts.ts:538-545 | `PayerMeSchema`, `payer-account.dto.ts:17-30` | all 6 | `email`/`phoneLast4` `.optional()` | always sent | MATCH (tolerant) | — |
| 15 | `creditsWireSchema` | contracts.ts:561-564 | `unlocks.service.ts:485` | `payer_id`,`balance` | uuid, int≥0 | same | **MATCH** | — |
| 16 | `creditLedgerWireSchema` / `…EntryWireSchema` | contracts.ts:457-476 | `CreditLedgerItem`, `unlocks.repository.ts:44-59`; `unlocks.service.ts:505-508` | all 8 | `created_at: z.string()`; `price_inr: .nullish().default(null)` | `created_at: Date` → ISO on JSON; `price_inr: number\|null` | **MATCH** | `price_inr` nullish is a deliberate, correct forward/back-compat tolerance (migration 0043). |
| 17 | `unlockGrantedWireSchema` | contracts.ts:586-591 | `UnlockGrantedResponse`, `unlock-response.ts:45-50`; `grantedResponse` `unlocks.service.ts:889-891` | all 4 | `expires_at: z.string()` | `.toISOString()` | **MATCH** | — |
| 18 | `neutralWireSchema` / `revealNeutralSchema` / `maskedResumeNeutralSchema` | contracts.ts:592, :349, :377 | `neutralUnavailable()`, `unlock-response.ts:38-42` | `status` | `"unavailable"` | same | **MATCH** | The no-oracle body is correctly pinned on both sides. |
| 19 | `revealRoutedSchema` | contracts.ts:342-346 | `ContactRevealedResponse`, `unlock-response.ts:53-57` | 3 | identical incl. `channel` enum | identical | **MATCH** | No phone field exists on either side — the ADR-0010 F-4 property is structural. |
| 20 | `maskedResumeWireSchema` | contracts.ts:389-406 | `DisclosureGrantedResponse`, `resume-disclosure.service.ts:22-29` | 5 | + an https/localhost `.refine` | plain string | **MATCH** (FE stricter) | FE-only hardening; a non-https signed URL fails closed. Correct. |
| 21 | `buyPackResultWireSchema` | contracts.ts:603-608 | `unlocks.service.ts:515-538`, return at :537 | 4 | int≥0 / int>0 | same | **MATCH** | HTTP 201 (`payer-unlocks.controller.ts:130`) — irrelevant, `payerFetch` gates on `res.ok`. |
| 22 | `creditOrderWireSchema` | contracts.ts:621-631 | `payer-unlocks.controller.ts:168-176` | `amount` (paise) + `amount_inr` (₹) | both int>0 | `order.amountPaise` / `order.amountInr` | **MATCH** | Unit split is explicit and correct on both sides. |
| 23 | `verifyPaymentWireSchema` | contracts.ts:640-645 | `payer-unlocks.controller.ts:211-216` | 4 | `credits: int≥0` | same | **MATCH** | The `credits: 0` = still-success semantics are documented on both sides. |
| 24 | `payerCapacityWireSchema` | contracts.ts:657-664 | `CapacityView`, `posting-plans.service.ts:67-74`; impl :502-522 | 5 | `expires_at: z.string().nullable()` | `.toISOString()` or null | **MATCH** | — |
| 25 | `buyCapacityWireSchema` | contracts.ts:678-687 | `BuyCapacityResult`, `posting-plans.service.ts:76-85` | `source_tier` | `z.string().nullable()` | `string` (non-null) | **MATCH** (FE wider) | Safe widening. |
| 26 | `reachApplicantWireSchema` | contracts.ts:700-710 | `ApplicantRowDto`, `reach.dto.ts:30-46`; `reach.service.ts:141` | 9 | `experienceBand`… `.nullable().optional()` | `string\|null` | **MATCH** | — |
| 27 | `matchCandidateWireSchema` | contracts.ts:723-734 | `match-candidates.service.ts:70-97` | 9 | all present | all present | **MATCH** | The `z.union` ordering is safe: a V1 row lacks `score`/`hot`/`pushEligible`/`components` so it can never satisfy branch 1. |
| 28 | `reachApplicantListWireSchema` | contracts.ts:748-751 | both producers | `{jobId, applicants}` | — | — | **MATCH** | — |
| 29 | `matchSkillWireSchema` / `…ListWireSchema` | contracts.ts:201-207 | `match-skills.service.ts:97-109` | 4 | `industry_id: z.string()` | `?? ""` | **MATCH** | Empty-string industry is accepted. |
| 30 | `reachPreviewWireSchema` | contracts.ts:226-241 | `match-skills.service.ts:118-166` | 7 | — | identical keys | **MATCH** | — |
| 31 | `agencyReferralsSummaryWireSchema` | contracts.ts:871-876 | `AgencyReferralsSummary`, `agency.service.ts:38-44` | 4 incl. `minBucket` | int | int | **MATCH** | — |
| 32 | `agencyInviteWireSchema` | contracts.ts:884-888 | `agency.service.ts:56-58`, :484 | 3 | `link: z.string()` | relative `/i/<code>` | **MATCH** | — |
| 33 | `agencyInviteBatchWireSchema` | contracts.ts:899-901 | batch mint | `{invites:[]}` | — | — | **MATCH** | — |
| 34 | `agencyWorkerWireSchema` / list | contracts.ts:921-930 | `agency-workers.service.ts:16-21,68-76`; controller returns `{workers}` (`agency-workers.controller.ts:42`) | 5 | — | identical | **MATCH** | The deliberate loose transport schema (payer-api.ts:772-774) + `assertNoAgencyPII` is a correct pattern, not drift. |
| 35 | `agencyKycWireSchema` | contracts.ts:962-968 | `AgencyKycView`, `agency-kyc.service.ts:17-23` | 5 | `status` 4 values | `AgencyKycStatus` (`pending\|verified\|rejected`) + `"not_submitted"` | **MATCH** | `packages/db/src/schema/referral.ts:184` confirms the DB set. |
| 36 | `agencyEarningsWireSchema` | contracts.ts:1019-1033 | `AgencyEarningsView`, `agency-payout.service.ts:18-28`; agg `agency-payout.repository.ts:108-144` | 13 | all int | Drizzle `sum()` results coerced via `n(v) = Number(v ?? 0)` (:130) | **MATCH** | Verified explicitly: Drizzle `sum()` returns a **string**; the repo coerces at :130, :137-143. Had it not, every earnings read would `ZodError`. |
| 37 | `agencyPayoutWireSchema` / list | contracts.ts:1042-1050 | `agency-payouts.controller.ts:66-74` (bare array) | 5 | `status` 3 values | `AgencyPayoutRequestStatus` = `requested\|paid\|rejected` (`referral.ts:225`) | **MATCH** | — |
| 38 | `agencyPayoutRequestWireSchema` | contracts.ts:1059-1071 | `PayoutRequestOutcome`, `agency-payout.service.ts:31-33` | union | `reason: z.string()` (loose) | closed `BlockedReason` | **MATCH** (FE wider, deliberate) | — |
| 39 | `orgMemberWireSchema` | org-members.ts:23-30 | `OrgMemberView`, `payer-org-members.service.ts:30-37, 236-244` | 6 | `org_role` `owner\|recruiter`; `status` `invited\|active\|removed` | `OrgRole` + `PayerMemberStatus` (`packages/db/src/schema/payer.ts:127-128`) | **MATCH** | Exact enum parity. |
| 40 | `payerCatalogWireSchema` | live-catalog.ts:47-51 | `PayerCatalogView`, `payer-pricing.controller.ts:16-20, 46-50` | 3 | reuses `@badabhai/pricing` `productSchema` | same package | **MATCH** | Sharing the schema package is the right pattern — this one *cannot* drift. |
| 41 | `requestCodeWireSchema` | http-provider.ts:34-37 | `PayerAuthCodeResponse`, `payer-auth.dto.ts:42-45` | 2 | — | — | **MATCH** | |
| 42 | `verifyWireSchema` | http-provider.ts:40-47 | `PayerSessionResponse`, `payer-auth.dto.ts:48-55` | 6 | — | — | **MATCH** | |
| 43 | logout | http-provider.ts:144 | `payer-auth.controller.ts:87-90` `@HttpCode(204)` | body | `z.unknown()`; 204 → `parse({})` (payer-http.ts:68) | empty | **MATCH** | The 204 branch is correctly handled. |
| 44 | `quotaTopUpWireSchema` | contracts.ts:483-486 | `posting-plans.service.topUpQuotaForPayer` | `{plan, quote}` | `z.record(z.string(), z.unknown())` ×2 | object | **MATCH** (deliberately opaque) | Documented as "parsed loosely — the seam only needs the call to succeed". Acceptable, but see §5. |

---

## 2. (a) Enum parity — full audit

| Enum | Frontend | Canonical backend source | Verdict |
|---|---|---|---|
| `TRADE_KEYS` | contracts.ts:70-86 (15 keys) | `packages/taxonomy/src/enums.ts:16-32` (15) **and** `apps/api/src/resume/trade-content.ts:609-625` (15) **and** `agency.dto.ts:47` `z.enum(REQUIRED_TRADE_KEYS)` | **MATCH** — all three lists are byte-identical and in the same order. Note this is a *fourth* hand-copy; nothing enforces the parity mechanically. |
| `VACANCY_BANDS` (frontend, quota-only) | contracts.ts:104 `["1-5","6-20","21-50","50+"]` | *no backend counterpart* — deliberately local to `pricing-config.bandForVacancies` | **MATCH by design** — documented at contracts.ts:99-103. Never sent on the wire (`toPayerJobPostingBody` sends the raw `vacancies` count, payer-api.ts:987). |
| `POSTING_VACANCY_BANDS` (backend bands) | contracts.ts:1103 `["1","2-5","6-10","11-25","25+"]` | `packages/types/src/index.ts:191`; DB CHECK `job.ts:171-174`; `packages/ai-contracts/src/job-posting.ts:21` | **MATCH** — all four agree exactly. |
| `postingSummarySchema.status` / `jobPostingWireSchema.status` | contracts.ts:25, :780 `draft\|open\|closed\|paused` | `JOB_POSTING_STATUSES` `packages/types/src/index.ts:205` = `draft\|open\|paused\|suspended\|closed`; DB CHECK `job.ts:176-181` | **DRIFT-LATENT** (finding PAY-CP-08) — `suspended` missing on the FE. |
| `JOB_STATUSES` (agency-summary) | `agency-summary.ts:12` `draft\|open\|closed\|paused` | mirrors the contract enum; used as an object index at :33 `summary[p.status] += 1` | Consistent with the contract, therefore inherits the same latent gap. A `suspended` row would already have failed Zod upstream, so no `undefined` index today. |
| `agencyJobWireSchema.status` | contracts.ts:814 `open\|closed` | `JobStatus` `job.ts:268` = `open\|closed\|suspended` | **DRIFT-LATENT** (PAY-CP-08). |
| `NEEDED_BY` | contracts.ts:802 | `agency.dto.ts:123`; `JobNeededBy` `job.ts:274`; DB CHECK `job.ts:389-392` | **MATCH** (4-way). |
| unlock `status` | contracts.ts:575 | `UnlockStatus` `payer.ts:188` | **DRIFT-HARD** (PAY-CP-01). |
| `AGENCY_KYC_STATUSES` | contracts.ts:951 | `referral.ts:184` + the service's `"not_submitted"` | **MATCH**. |
| `AGENCY_PAYOUT_STATUSES` | contracts.ts:1037 | `referral.ts:225` | **MATCH**. |
| `AGENCY_PAYOUT_BLOCKED_REASONS` | contracts.ts:1005-1009 | `agency-payout.service.ts:113-116` | **MATCH**. |
| `JOB_POSTING_CHAT_STATUSES` | contracts.ts:1108-1113 | `job-posting-chat.dto.ts:55-60` | **MATCH**. |
| chat `direction` / `message_type` | contracts.ts:1124-1125 | `MESSAGE_DIRECTIONS` / `MESSAGE_TYPES`, `packages/types/src/index.ts:102-106` | **MATCH**. |
| payer `role` / `status` | contracts.ts:539-540 | `payer-account.dto.ts:21-23` | **MATCH**. |
| org `role` / member `status` | org-members.ts:19-20 | `packages/db/src/schema/payer.ts:127-128` | **MATCH**. |
| `channel` (reveal) | contracts.ts:344 | `unlock-response.ts:55` | **MATCH**. |

**Net: 2 hard/latent enum drifts (`unlocks.status`, `job(_postings).status`), 13 clean.**

---

## 3. (b) Pagination shape consistency — **there is no convention**

| Route | Envelope | Bound | Cursor? | Total? |
|---|---|---|---|---|
| `GET /payer/job-postings` | **bare array** (`payer-job-postings.controller.ts:105-112`) | none | no | no |
| `GET /payer/unlocks` | `{unlocks:[]}` (`unlocks.service.ts:477-479`) | **silent `OPS_LIST_CAP = 500`** (`unlocks.repository.ts:607`; `common/pagination.ts:16`) | no | no |
| `GET /payer/credits/ledger` | `{payer_id, ledger:[]}` (`unlocks.service.ts:505-508`) | `?limit=` 1..50; FE hardcodes 50 (payer-api.ts:416) | no | no |
| `GET /payer/match/skills` | `{skills:[]}` (`match-skills.service.ts:108`) | none | no | no |
| `GET /payer/reach/jobs/:id/applicants` | `{jobId, applicants:[]}` (`reach.service.ts:141`; `match-candidates.service.ts:74`) | `OPS_LIST_CAP` on the V1 path (`match-candidates.service.ts:72`) | no | no |
| `GET /payer/agency/jobs` | **bare array** (`agency-jobs.controller.ts:49-52`) | none | no | no |
| `GET /payer/agency/workers` | `{workers:[]}` (`agency-workers.controller.ts:39-47`) | none | no | no |
| `GET /payer/agency/payouts` | **bare array** (`agency-payouts.controller.ts:66-74`) | none | no | no |
| `GET /payer/org/members` | **bare array** (`payer-org-members.controller.ts:39`) | none | no | no |
| `GET /payer/job-posting-chat/sessions` | `{sessions:[]}` (`job-posting-chat.dto.ts:88-92`) | none | no | no |
| `GET /payer/pricing/catalog` | `{revision, source, products:[]}` | none | no | no |

**Five distinct envelope conventions.** Neither `{items,next_cursor}` nor `{data,total}` exists anywhere. Two independent, undocumented silent truncations (`OPS_LIST_CAP=500` on unlocks; `limit=50` on the ledger — the frontend even documents the resulting data loss at payer-api.ts:419-421 and ships it). This inconsistency has **already caused a production-class bug in the Flutter client** — see §6.

---

## 4. (c) Error envelope — proven loss

Backend produces, for every non-2xx:

```
// apps/api/src/common/filters/all-exceptions.filter.ts:31-39
{ statusCode, error: (typeof payload === "string" ? {message: payload} : payload), requestId, path, timestamp }
```

and for a 400 the `payload` is field-level:

```
// apps/api/src/common/pipes/zod-validation.pipe.ts:17-24
{ message: "Validation failed", issues: [{ path, message }] }
```

Frontend consumes **none of it**:

```ts
// apps/payer-web/src/lib/payer-http.ts:61-65
if (res.status === 401) throw new PayerUnauthorizedError();
if (!res.ok) {
  // Body may carry a deny reason — do NOT surface it (no-oracle / no PII). Class only.
  throw new Error(`payer API ${path} returned ${res.status}`);
}
```

The body is never read. **Every** `pay_max must be >= pay_min`, `provide at most one of vacancy_band or vacancies` (`job-postings.dto.ts:170-178`), `orgName must be 2 to 120 characters` (`payer-account.dto.ts:57`), and every `issues[]` path is discarded. The seam then pattern-matches on the *string it just built* to recover the status (`/returned 404/` at payer-api.ts:249, 328, 365, 397, 572, 600, 1029, 1046, 1086, 1154, 1173, 1297; `/returned 409/` at :1298; `/returned 429/` at :713, 757) — the status code round-trips through a formatted message, which is brittle but functional.

**Assessment:** the no-oracle rationale is legitimate for `/payer/unlocks`, `/payer/resume-disclosures` and the ownership-404 routes. It is **not** legitimate for 400s on `POST/PATCH /payer/job-postings`, `POST /payer/agency/jobs`, `POST /payer/agency/kyc` or `PATCH /payer/me`, where the payer typed the bad value and the server knows exactly which field. P1 UX defect. The fix is a status-aware branch (surface `issues[]` on 400 only, keep the neutral class for 401/403/404/409/429), not a blanket removal.

**Related:** `payer-http.ts` special-cases only 401. A 403 from the ADR-0037 lifecycle gate (`payer-auth.guard.ts:116-118`) is an ordinary throw. On the session read it degrades correctly — `currentSession` catches everything and returns `null` → `/login` (`http-provider.ts:133-138`) — but on a Server Action mutation a suspended payer gets a generic failure with no explanation.

---

## 5. (d) Date/time and currency units — **clean**

**Currency.** One unit end-to-end, verified at every layer:

- `packages/pricing/src/types.ts:12` — "Money is WHOLE INDIAN RUPEES (₹), integer — never paise, never float"; `:30` `priceInrSchema = z.number().int().min(1)`.
- API surfaces are all `…Inr` integers: `CreditLedgerItem.price_inr` (`unlocks.repository.ts:57`), `AgencyEarningsAgg` (`agency-payout.repository.ts:23-29`), `agencyPayoutRequests.amountInr`, `jobs.pay_min/pay_max` (`job.ts:337-338`, documented "whole rupees — never paise").
- **The only paise conversion in the repo** is at the Razorpay boundary: `razorpay.client.ts:50-57` `inrToPaise`, with the comment "ONE conversion, at the provider boundary, nowhere else". Verified — a repo-wide grep for `* 100` / `/ 100` finds no other money conversion (the only other hit is a percent discount at `packages/pricing/src/resolve.ts:72`).
- `payer-unlocks.controller.ts:171-172` returns **both** units under distinct names (`amount` = paise, `amount_inr` = ₹); `contracts.ts:625-628` models both with the units in the doc comments; `credits/actions.ts:104` and `credits-panel.tsx:94` pass `order.amount` (paise) straight to Razorpay Checkout, and every `formatInr` call site takes an `…Inr`/`priceInr` field.
- `format.ts:21-26` throws `RangeError` on a non-integer or negative input — a paise value would render wrong but not throw, so this is not a full guard; nonetheless **no mismatched call site exists**.

**Verdict: no money-unit bug.** One low-severity defect: `dashboard/page.tsx:85` renders `formatInr(40)` — a hardcoded ₹40/unlock — while `pricing-config.ts:40-44` `unlockUnitPriceInr(products)` derives it from the live catalog and `credits/page.tsx:87,128` uses that. An ops price edit desynchronises the dashboard tile. Display-only (the charge is always server-resolved, XT5), so P2, but it violates the no-hardcoded-values rule.

**Dates.** Uniform: every backend `Date` (`UnlockProjection.granted_at/expires_at/created_at`, `CreditLedgerItem.created_at`, `AgencyJobView.createdAt/updatedAt`, `AgencyKycView.updatedAt`, payout `createdAt`) serialises to an ISO string through `JSON.stringify`, and every corresponding FE field is `z.string()`. Where the backend stringifies explicitly it uses `.toISOString()` (`posting-plans.service.ts:520`, `unlocks.service.ts:890`, `payer-org-members.service.ts:242`). `agencyWorkerWireSchema.lastActiveOn` is a coarse `YYYY-MM-DD` day on both sides. **No Date/string drift found.** One brittleness: `getJobPostingChatSessions` sorts with `bt.localeCompare(at)` (payer-api.ts:1396) — correct only because the values are ISO-8601; a format change silently mis-sorts.

---

## 6. (e) `.optional()` / `.passthrough()` masking register

Schemas where a tolerance hides a missing/renamed backend field rather than failing:

| Location | Tolerance | Currently masking something real? |
|---|---|---|
| contracts.ts:1159 `skill_phrases` | `.optional()` | **YES** — backend field is `skills`. PAY-CP-03. |
| contracts.ts:1158 `trade_key` | `.nullable().optional()` | **YES** — no such backend field. PAY-CP-03. |
| contracts.ts:1316 `suggested_replies` (transcript) | `.optional()` | **YES** — absent from the transcript response. PAY-CP-09. |
| contracts.ts:1219, :1221, :1223, :1224, :1226 (turn) | `.optional()` + `??` defaults | No — backend sends all, with its own defaults. Redundant but harmless. |
| contracts.ts:1264-1269 (session summary) | `.optional()` | No — backend sends all. |
| contracts.ts:1350-1351 (publish) | `.optional()` | No — but the *unmodelled* `unmapped_fields` is stripped. PAY-CP-04. |
| contracts.ts:32 `applicantQuota` | `.optional()` | **YES, indirectly** — the field the backend now sends is `applicant_visibility_quota`, unmodelled and stripped. PAY-CP-02. |
| contracts.ts:289-292, :302-307 (`FacelessApplicant` bands / V1 fields) | `.optional()` | No — genuinely absent on one of the two server implementations; this is the correct use of the tolerance. |
| contracts.ts:470 `price_inr` | `.nullish().default(null)` | No — deliberate migration-0043 forward-compat, documented. Correct. |
| contracts.ts:543-544 `email`/`phoneLast4` | `.optional()` | No — rollout tolerance; backend always sends. Now vestigial. |
| contracts.ts:707-709 reach bands | `.nullable().optional()` | No — correct. |
| contracts.ts:964-967 KYC | `.nullish()` | No — correct. |
| contracts.ts:483-486 `quotaTopUpWireSchema` | `z.record(z.string(), z.unknown())` ×2 | **Structurally blind** — accepts literally any object for `plan`/`quote`. Deliberate, but a total change of the top-up response shape is undetectable on a path that commits money. |
| contracts.ts:681 `quote: z.unknown()` | — | Deliberate (XT5 — never echoed). Correct. |
| payer-api.ts:772-774 `agencyWorkerListTransportSchema` | `.passthrough()` ×2 | **Intentional inversion** — loose parse so a regressed PII key survives to `assertNoAgencyPII`, then re-projected strictly at payer-api.ts:802. This is the *good* pattern and should be the model for the others. |
| contracts.ts:23, :497 `vacancyBand: z.string()` | plain string | Inconsistent strictness: `status` beside it is a narrow enum. Not a defect; an asymmetry worth noting. |

---

## 7. (f) Flutter payer app cross-check (`apps/payer-app/lib/**`) — brief

The Flutter client consumes 24 of the same `/payer/*` routes (`http_payer_api_client.dart`, `payer_auth_api.dart`). It uses hand-rolled `Map<String,dynamic>` decoding, not a schema, so a mismatch degrades silently instead of throwing.

**One confirmed hard divergence:**

```dart
// apps/payer-app/lib/core/data/http_payer_api_client.dart:58-64
// The list endpoint returns rows under a wrapping key when the transport can
// surface them; a top-level bare array is not decodable through [PayerHttp]
// (which yields a Map body) — see the note on [_asList].
final List<dynamic> rows = res.body['items'] is List<dynamic>
    ? res.body['items'] as List<dynamic>
    : _asList(res.body['data']) ?? const <dynamic>[];
```

`GET /payer/job-postings` returns a **bare array** (`payer-job-postings.controller.ts:105-112`). Neither `items` nor `data` exists, so `fetchJobs` always resolves to the empty fallback. The status check at :58 passes (200), so the app renders a legitimate-looking "no jobs" empty state. **The Flutter payer app's company job list is permanently, silently empty.** The comment shows the author knew `PayerHttp` cannot decode a bare array and guessed at the envelope rather than reading the controller.

Other notes (brief, as instructed): `fetchLedger` (`:39-48`) reads `/payer/unlocks` and correctly unwraps `body['unlocks']` — but it inherits **the same `denied`-status exposure as PAY-CP-01**; being schema-less it will not throw, it will map an unknown status through `_ledgerFromUnlock`. `fetchCredits` (`:30-35`) correctly throws on non-2xx rather than fabricating a 0 balance. `createCompanyJob` (`:88-115`) correctly enforces exactly-one-of `vacancy_band|vacancies`, matching `job-postings.dto.ts:170-173`. The chat routes are consumed at `:301-375`; the same `skills`/`skill_phrases` question applies there and was not audited in depth (web is the priority).

---

## 8. Test-coverage gap that let all of this through

`apps/payer-web/src/lib/payer-api.test.ts` builds every fixture by hand (`jsonResponse(...)` at :48-50, `jobPostingRow(...)` at :81, and again at :404, :545, :773). No fixture contains `status: "denied"`, none contains `applicant_visibility_quota`, no chat fixture contains `skills`. There is no test anywhere that imports a backend DTO/schema and asserts the frontend schema accepts everything it can produce. `tests/contract/` contains only a README. This is the "a mock that returns whatever you told it cannot catch a schema mismatch" failure mode; the correct fix is a parity suite modelled on the existing `packages/ai-contracts` golden-fixture test (`ai-contracts.test.ts:505-519`), feeding `packages/db` enum constants and the API DTO key sets into the payer-web Zod schemas.
