# Payer-lifecycle verification sweep — 2026-08-03

**Question asked:** for every business operation, does it check payer existence? Does it check payer *status*? Should it? If not, why — and is that intentional or a bug?

**Method.** Every controller in `apps/api/src` carrying a mutating route (`@Post` / `@Patch` / `@Put` / `@Delete`) was enumerated mechanically together with its guard, then each group was read. Discovery paths were verified by **rendering the SQL** each repository method produces, not by reading the source. Where a row says "verified", it was checked in code at HEAD `420ac20e`; where it says "not verified", it was not, and says so.

**Headline:** **no mutating controller in the API is unguarded.** The enumeration returned a guard for every one. The lifecycle question is therefore not "is anything open" but "which guard, and does that guard know about `payers.status`".

---

## 1. Payer-authenticated writes — 37 routes, all covered by one guard

| Controller prefix | Writes | Guard |
|---|---|---|
| `payer` (×3 controllers) | 11 | `PayerAuthGuard` |
| `payer/job-postings` | 8 | `PayerAuthGuard` |
| `payer/agency` | 3 | `PayerAuthGuard`, `PayerRoleGuard` |
| `payer/agency` (payouts) | 2 | + `AgencyPayoutsEnabledGuard` |
| `payer/agency/jobs` | 4 | `PayerAuthGuard`, `PayerRoleGuard` |
| `payer/job-posting-chat` | 3 | `PayerAuthGuard` |
| `payer/org/members` | 2 | `PayerAuthGuard`, `PayerOrgRoleGuard` |
| `payer/capacity`, `payer/match`, `payer/org/invites`, `payer/resume-disclosures` | 4 | `PayerAuthGuard` |

**Status check: YES, since ADR-0037.** `PayerAuthGuard` reads `{role, status}` per request and 403s anything not `active`. Before that it read the row and discarded the status.

**Should they check? Yes — and centrally, which is what this is.** Pushing the check into 37 handlers would guarantee the 38th forgets.

**Verified.** This is the reason the audit shrank: quota updates, wallet/credit purchases, job posting, pause/resume, unlock/reveal, invoices, company settings and agency operations are all in this set. None of them needed an individual fix.

---

## 2. Discovery reads — 5 paths, verified by rendered SQL

| Path | Method | Excludes suspended |
|---|---|---|
| Worker feed (legacy) | `ApplicationsRepository.findOpenJobs` | ✅ |
| Apply target | `ApplicationsRepository.findJobById` | ✅ |
| Worker job detail | `JobsRepository.findWorkerVisibleJobById` | ✅ |
| Reach candidate set | `ReachRepository.listOpenJobSignalRows` | ✅ |
| Matching-V1 feed | `MatchFeedRepository.listFeed` | ✅ |

**Status check: indirectly, and deliberately so.** None joins `payers`. They exclude a suspended payer's jobs because the suspension cascade (#555) moves the rows out of `status = 'open'`, which all five already filter on.

**Intentional.** A join would sit on the hottest read in the system and would only protect the paths someone remembers to change. Pinned by `payer-suspension-discovery.test.ts`; each of the five was mutation-tested independently.

---

## 3. Paths with **no payer principal** — where the guard cannot help

| # | Operation | Guard | Status check | Verdict |
|---|---|---|---|---|
| 1 | `db:grant:free-tier` runner | none — no request | **YES** (#554) | Fixed. Bulk, unattended, repeatable; the only enforcement point is the query. `pending` still granted deliberately. |
| 2 | Razorpay webhook capture | `RazorpayWebhookGuard` (HMAC) | **Reads, does not block** (#558) | Correct by ruling. Money already taken, no refund path; credits granted but unspendable, Finance alerted. |
| 3 | Ops KYC verify | `InternalServiceGuard` | **YES** (#557) | Fixed. Arms payout eligibility; reject deliberately still allowed. |
| 4 | Admin suspend / reinstate / grant-credits | `AdminAuthGuard` + `AdminRolesGuard` | **YES** (#553/#555) | Fixed. `grantCredits` 409s on a suspended payer; suspend/reinstate cascade the inventory. |
| 5 | Ops `POST /unlocks`, `/unlocks/:id/reveal` | `InternalServiceGuard` | **NO** | **Open — see §4.** `payer_id` from the body. |
| 6 | Ops `POST /payers/:payerId/credits` | `InternalServiceGuard` | **NO** | **Open — see §4.** Payer id from the path; grants real credits. |
| 7 | Ops `POST /job-postings/:id/plan\|boost` | `InternalServiceGuard` | **NO** | **Open — see §4.** `payer_id` in the body (`posting-plans.dto.ts`). |
| 8 | Ops `PUT /pricing/catalog` | `InternalServiceGuard` | n/a (no payer) | Not a lifecycle question. Platform-wide config. |
| 9 | Ops job-posting mutators (6 writes) | `InternalServiceGuard` | **NO** | **Open — see §4.** Not scoped to `payer_id IS NULL`, and the emitted event stamps `actor_id` as the posting's `created_by` — i.e. **the payer's own id for a payer-created posting**, attributing an ops action to the customer. |
| 10 | Ops `workers` (6 writes), `referrals`, `pace`, `actions` | `InternalServiceGuard` | n/a | No payer subject. |
| 11 | `internal/skills` (2 writes) | `SkillsInternalGuard` | n/a | Service-to-service. |

**Not verified in this sweep:** whether `POST /unlocks` reveal enforces the disclosure-consent gate independently of payer status (it is a separate gate with its own tests); and the worker-side controllers (`auth`, `chat`, `consent`, `profile`, `resume`, `voice`, `referrals`) — the worker lifecycle is out of scope here.

---

## 4. The blocker on rows 5–7 and 9

Owner ruling Decision 6: *"Ops endpoints that accept `payer_id` from the request body should be eliminated or refactored… no privileged write where `actor_id` is null unless it is a documented system process."*

**These cannot be moved to an authenticated admin principal yet, because no admin can authenticate.**

Verified in code:

- `AdminOtpService.issueAndSend` **does not send anything.** It reserves the code in Redis and logs `"admin login code issued … (delivery deferred)"`. The code is never returned to the client (correctly — real-only, no echo), so it reaches no human. The class docstring states this outright: *"email DELIVERY is a deferred stream (no real admin-email provider is wired here)."*
- There is **no admin bootstrap path**: `packages/db/src` has seeds for questionnaire, skills, jobs, demand, reach-pool and match-vocabulary — none for `admin_users`. The only way a row appears is `POST /admin/invite`, which itself requires an authenticated `super_admin`. That is a closed loop with no entry point.

So the admin surface built by ADMIN-3a — `AdminAuthGuard`, `AdminRolesGuard`, the capability matrix, `admin.action_performed` — is **complete and unreachable**. Switching the ops routes onto it today would take the ops console offline rather than securing it.

**Dependency order:** admin email delivery + first-admin bootstrap → ops console moves to admin sessions (ADMIN-4..8) → the `InternalServiceGuard` routes above are retired onto the admin principal (Decision 6).

This matches what [CLAUDE.md §8](../../CLAUDE.md) already records — *"retiring it is blocked on ADMIN-4..8"* — and what TD33/TD50 track.

**The bootstrap needs an owner decision, not just code:** which email address is the first `super_admin`.

**The delivery half is a code job and is well-scoped:** ZeptoMail is already implemented **twice** (`payers/zeptomail-email-login-channel.ts`, `payer-portal/member-invite.mailer.ts`, 510 lines between them) with the transport resolution, sandbox handling, opaque-error contract and hash-prefix logging duplicated in both. Extracting a principal-agnostic notification service — as the 2026-08-02 Decision 3 directs — removes that duplication and gives the admin channel a real sender in the same change.

---

## 5. What changed as a result of this sweep

| PR | Change |
|---|---|
| #553 | `PayerAuthGuard` reads status; activation on OTP verify; suspend from `pending`/`active`; reinstate to `previous_status`; session revocation; `grantCredits` refuses a suspended payer |
| #554 | Free-tier runner excludes suspended payers |
| #555 | Inventory cascade — suspended payers' jobs leave the feed; ADR-0037 written |
| #556 | OTP delivery suppressed for suspended accounts (TD130 logged — a **pre-existing** timing oracle this surfaced) |
| #557 | Ops KYC verify refuses a suspended agency |
| #558 | Razorpay capture credits + alerts instead of rejecting |

**Still open:** rows 5, 6, 7, 9 above — all blocked on the admin bootstrap.
