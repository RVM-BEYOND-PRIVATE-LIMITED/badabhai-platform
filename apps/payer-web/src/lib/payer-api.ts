import "server-only";
import { z } from "zod";
import {
  agencyEarningsWireSchema,
  agencyInviteBatchWireSchema,
  agencyInviteWireSchema,
  agencyJobListWireSchema,
  agencyJobWireSchema,
  agencyKycWireSchema,
  agencyPayoutListWireSchema,
  agencyPayoutRequestWireSchema,
  agencyReferralsSummaryWireSchema,
  agencyWorkerListWireSchema,
  agencyWorkerWireSchema,
  applicantFeedSchema,
  applicantStageChangeWireSchema,
  buyCapacityWireSchema,
  buyPackResultWireSchema,
  candidateInboxQuerySchema,
  candidateInboxSchema,
  candidateInboxWireSchema,
  capacitySchema,
  creditLedgerWireSchema,
  creditOrderWireSchema,
  creditsWireSchema,
  creditTopUpSchema,
  verifyPaymentWireSchema,
  jobPostingChatPublishWireSchema,
  jobPostingChatSessionListWireSchema,
  jobPostingChatTranscriptWireSchema,
  jobPostingChatTurnWireSchema,
  jobPostingListWireSchema,
  jobPostingWireSchema,
  matchSkillListWireSchema,
  reachPreviewWireSchema,
  maskedResumeResultSchema,
  maskedResumeWireSchema,
  quotaTopUpWireSchema,
  inboxAgencyRowWireSchema,
  inboxCompanyRowWireSchema,
  inboxPostingRefWireSchema,
  payerCapacityWireSchema,
  payerMeWireSchema,
  postingSummarySchema,
  reachApplicantListWireSchema,
  toJobPostingChatSessions,
  toJobPostingChatTranscript,
  toJobPostingChatTurn,
  topUpResultSchema,
  unlockResultSchema,
  unlockResultWireSchema,
  unlocksListWireSchema,
  type AgencyAccount,
  type AgencyEarnings,
  type AgencyJob,
  type AgencyJobInput,
  type AgencyKyc,
  type AgencyKycInput,
  type AgencyPayout,
  type AgencyPayoutRequestWire,
  type AgencyReferralsSummary,
  type AgencyWorker,
  type ApplicantFeed,
  type ApplicantStageChange,
  type CandidateInbox,
  type CandidateInboxQuery,
  type Capacity,
  type CreatePostingInput,
  type CreditBalance,
  type CreditOrder,
  type CreditTopUp,
  type Dashboard,
  type VerifiedPayment,
  type FacelessApplicant,
  type InboxAgencyRowWire,
  type InboxCompanyRowWire,
  type JobPostingChatPublishResult,
  type JobPostingChatSessionSummary,
  type JobPostingChatTranscript,
  type JobPostingChatTurn,
  type MaskedResumeResult,
  type MatchCandidateWire,
  type MatchSelectionInput,
  type MatchSkillWire,
  type ReachApplicantWire,
  type PostingSummary,
  type ReachPreview,
  type RevealResult,
  type TopUpResult,
  type UnlockHistoryItem,
  type UnlockResult,
  type UpdatePostingInput,
} from "./contracts";
import { revealResultSchema } from "./contracts";
import { assertNoAgencyPII } from "./assert-no-agency-pii";
import type { ApplicantStage } from "./applicant-stages";
import { cardFieldsFromPostingWire, type CardFields } from "./job-card-view";
import { payerFetch } from "./payer-http";
import {
  isPayerStatus,
  PayerConflictError,
  PriceMismatchError,
  PurchaseOptionChangedError,
} from "./payer-errors";
import { getLiveCatalog } from "./live-catalog";
// `findCreditPack` is deliberately NOT imported here: the credit HISTORY renders the ₹
// stamped on each ledger row at purchase, never a lookup against the current catalog
// (D-6 — that re-priced the past whenever ops edited a price). The remaining catalog read
// below CHECKS the quota-topup tier the payer confirmed against live config (#2085 L1).
import { findQuotaTopUpTier } from "./pricing-config";

/**
 * The PAYER DATA SEAM (ADR-0019 Phase 1).
 *
 * The SINGLE boundary the pages/actions call. Every function is LIVE: it calls a
 * payer-AUTHED backend endpoint via {@link payerFetch} (the payer JWT carries the
 * tenant identity; NO client `payer_id` is ever sent — XB-A). There is NO mock
 * fallback left in this seam — a backend failure surfaces as an error, never as
 * fake data (the mock store is deleted).
 *
 * Tenancy (XB-A): the payer is ALWAYS the server-held session, derived from the
 * Bearer token — never a client value.
 * PII (invariant #2): no raw worker/payer PII crosses this boundary; reveal returns a
 * ROUTED handle only (never a phone), and applicants are faceless.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * LIVE — payer-authed endpoints (mock path REMOVED for these surfaces).
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * GET /payer/me — the caller's OWN account (LIVE). Returns ONLY the agency's own
 * non-PII identity: role, account status, and the agency's own org label. There is
 * NO worker PII here — this is the payer's own data (the org label they registered),
 * never a worker name/phone. Bearer-only (XB-A): the session token is the identity.
 */
export async function getAgencyAccount(): Promise<AgencyAccount> {
  const me = await payerFetch("/payer/me", { schema: payerMeWireSchema });
  return { role: me.role, status: me.status, displayLabel: orgDisplayLabel(me) };
}

/**
 * The caller's OWN non-PII org display label, with a role-aware fallback when the registered
 * org name is blank. Shared by {@link getAgencyAccount} (header identity card) and {@link
 * sessionOrgLabel} (the `org_label` stamped on a create) so the two never drift.
 */
function orgDisplayLabel(me: { orgName: string; role: "employer" | "agent" }): string {
  return me.orgName.trim() || (me.role === "agent" ? "Your agency" : "Your company");
}

/**
 * GET /payer/me → the caller's OWN org label (the SESSION identity), used to stamp `org_label`
 * on a posting create. The org label is the payer's OWN registered org — NEVER a form field and
 * NEVER eventized (XB-A / privacy); resolving it server-side from the session (not the client)
 * is exactly the contract {@link toPayerJobPostingBody} documents. The session `displayLabel`
 * is NOT used here: it may carry a "(mock)" decoration; `/payer/me`'s `orgName` is authoritative.
 */
async function sessionOrgLabel(): Promise<string> {
  const me = await payerFetch("/payer/me", { schema: payerMeWireSchema });
  return orgDisplayLabel(me);
}

/** GET /payer/credits — the caller's OWN balance (the one knowable signal). */
export async function getCredits(): Promise<CreditBalance> {
  const wire = await payerFetch("/payer/credits", { schema: creditsWireSchema });
  return { payerId: wire.payer_id, balance: wire.balance };
}

/** GET /payer/unlocks — the caller's OWN unlock history (PII-free projection). */
export async function getUnlocks(): Promise<UnlockHistoryItem[]> {
  const wire = await payerFetch("/payer/unlocks", { schema: unlocksListWireSchema });
  return wire.unlocks
    // A DSAR-deleted worker SET-NULLs the identity join (ADR-0026 Phase 5): the row
    // stays for audit, but there is no candidate to show — skip it in the UI history.
    .filter((u) => u.worker_id !== null)
    .map((u) => ({
      unlockId: u.unlock_id,
      workerId: u.worker_id!,
      // The UI history shows granted vs expired: a revealed grant is still granted, and the
      // server-derived `expired` (#2033) and `revoked` are both ended access (no-oracle: the
      // cause is never surfaced beyond this). Only granted/revealed can ever read live.
      status: u.status === "granted" || u.status === "revealed" ? "granted" : "expired",
      createdAt: u.created_at,
      expiresAt: u.expires_at ?? u.created_at,
      // The current grant's time (a re-grant moves it; created_at does not): the day a Recent
      // unlocks row prints and is ordered by.
      grantedAt: u.granted_at,
      // #2033's company-posting context; absent (a pre-#2033 API) and null both mean none.
      jobPostingId: u.job_posting_id ?? null,
    }));
}

/**
 * Dashboard = LIVE credits + LIVE unlocks + (optionally) LIVE company postings. All are
 * payer-authed reads (the job-postings list is GET /payer/job-postings), so the dashboard and
 * the /postings list share ONE source of truth — a posting created via the live POST appears on
 * both. Fetched concurrently; each derives the session payer itself (XB-A).
 *
 * `withPostings` is REQUIRED, so every caller decides: the company postings list belongs to the
 * COMPANY surface, and an AGENCY session never reads it (owner ruling 2026-10-01 — agencies post
 * agency jobs; the backend role gate for that list is #1885, after which an agent's read would
 * fail). With `withPostings: false` no job-postings request is made and `postings` is `[]` —
 * a statement about what was READ, not about what exists; callers that skip it never show it.
 */
export async function getDashboard({ withPostings }: { withPostings: boolean }): Promise<Dashboard> {
  const [credits, unlocks, postings] = await Promise.all([
    getCredits(),
    getUnlocks(),
    withPostings ? getPostings() : Promise.resolve<PostingSummary[]>([]),
  ]);
  return { credits, unlocks, postings };
}

/** LEGACY (weighted reach engine): score/hot/components → faceless relevance chips. */
function toWeightedApplicant(a: ReachApplicantWire): FacelessApplicant {
  return {
    workerId: a.workerId,
    rank: a.rank,
    score: a.score,
    hot: a.hot,
    // Score-component reasons as faceless relevance chips (PII-free). The reach DTO's
    // components are explainable signal reasons; surface only their `reason` strings.
    signals: a.components
      .map((c) =>
        typeof c === "object" && c && "reason" in c ? String((c as { reason: unknown }).reason) : "",
      )
      .filter((s): s is string => s.length > 0)
      .slice(0, 8),
    // Coarse faceless taxonomy bands (PII-free). Backend may send `null` (no signal);
    // map to `undefined` so the optional UI fields stay clean.
    experienceBand: a.experienceBand ?? undefined,
    tradeLabel: a.tradeLabel ?? undefined,
    cityLabel: a.cityLabel ?? undefined,
    ...savedStage(a),
  };
}

/**
 * MATCHING V1 (ADR-0036 moment ⑥) → the same faceless row.
 *
 * `score: 0` and `hot: false` are STRUCTURAL PLACEHOLDERS, not values: V1 has no score
 * and no hot flag, and the shared `FacelessApplicant` still requires both. They are
 * pinned to constants precisely so nothing can render them as a meaningful number — the
 * UI reads `matchTier`/`skillMonths` on this path, and a fabricated score would be the
 * one number on the page that means nothing while looking like it means something.
 *
 * `signals` is left EMPTY rather than back-filled with invented reasons. V1's
 * explanation is the tier badge plus the months, which the card renders directly.
 */
function toMatchCandidate(a: MatchCandidateWire): FacelessApplicant {
  return {
    workerId: a.workerId,
    rank: a.rank,
    score: 0,
    hot: false,
    signals: [],
    matchTier: a.matchTier ?? undefined,
    effectiveTier: a.effectiveTier ?? undefined,
    matchedSkillLabel: a.matchedSkillLabel ?? undefined,
    skillMonths: a.skillMonths ?? undefined,
    industryMonths: a.industryMonths ?? undefined,
    ...savedStage(a),
  };
}

/**
 * The row's SAVED stage (owner ruling 2026-10-07), carried across only when the wire row has one:
 * a row from a server that does not save stages maps to a row with NO `stage` key at all, exactly
 * as before — `hasSavedStages` reads that absence as "keep the local board".
 */
function savedStage(a: { stage?: ApplicantStage }): { stage?: ApplicantStage } {
  return a.stage !== undefined ? { stage: a.stage } : {};
}

/**
 * GET /payer/reach/jobs/:jobId/applicants — the FACELESS ranked applicant list for a
 * job the caller OWNS (LIVE). A job that isn't the payer's returns the SAME neutral
 * 404 as an unknown one (no-oracle) → we map that to `null` and the page renders a
 * neutral not-found. Both personas read it: a company's `job_postings` feed
 * (`/postings/<id>/applicants`) and, since #1955 made the route serve an agency's own `jobs` rows
 * (only the workers who applied), the agency feed (`/agency/jobs/<id>/applicants`, #1956).
 *
 * TWO SERVER IMPLEMENTATIONS, ONE CLIENT. Behind `MATCH_V1_ENABLED` the route returns
 * the posting's ACTUAL APPLICANTS ordered by the frozen ADR-0036 rank snapshot; with the
 * flag off it returns the weighted reach engine's scored pool. The wire schema is a
 * union of both and the mapper branches on shape, so flipping the flag — and rolling it
 * back — is invisible here. PII-free either way (XB-C).
 */
export async function getApplicantFeed(jobId: string): Promise<ApplicantFeed | null> {
  let wire: ReturnType<typeof reachApplicantListWireSchema.parse>;
  try {
    wire = await payerFetch(`/payer/reach/jobs/${jobId}/applicants`, {
      schema: reachApplicantListWireSchema,
    });
  } catch (e) {
    // A neutral 404 (unknown OR not-owned job) is the no-oracle not-found, NOT an
    // error state. The backend returns 404 for both, so treat 404 as null.
    if (isPayerStatus(e, 404)) return null;
    throw e;
  }
  const applicants: FacelessApplicant[] = wire.applicants.map((a) =>
    "matchTier" in a ? toMatchCandidate(a) : toWeightedApplicant(a),
  );
  return applicantFeedSchema.parse({
    postingId: wire.jobId,
    // The reach endpoint does not return a role title. Nothing renders this placeholder: the
    // applicants page names its posting from the payer's own postings read.
    roleTitle: "Applicants",
    applicants,
  });
}

/**
 * TRANSPORT schema for the Candidates inbox — the contract's row union, but LENIENT (each row and
 * its `posting` pass unknown keys through), for the reason the referred-worker list gives: a plain
 * `z.object` STRIPS unknown keys, so a regressed payload carrying a worker name would be swallowed
 * before {@link assertNoAgencyPII} could see it. The strict {@link candidateInboxWireSchema} is
 * re-applied after the guard as the final projection.
 */
const candidateInboxTransportSchema = z
  .object({
    applicants: z.array(
      z.union([
        inboxAgencyRowWireSchema
          .extend({ posting: inboxPostingRefWireSchema("agency_job").passthrough() })
          .passthrough(),
        inboxCompanyRowWireSchema
          .extend({ posting: inboxPostingRefWireSchema("company_posting").passthrough() })
          .passthrough(),
      ]),
    ),
    nextCursor: z.string().nullable(),
  })
  .passthrough();

/** The row's own kind decides its mapper — the kind and the shape are paired by the schema. */
function isAgencyInboxRow(row: InboxAgencyRowWire | InboxCompanyRowWire): row is InboxAgencyRowWire {
  return row.posting.kind === "agency_job";
}

/**
 * GET /payer/reach/applicants — EVERY applicant to every posting the SESSION payer owns, newest
 * application first (the "Candidates" tab). Both personas; payer-scoped by the Bearer (XB-A — the
 * query has no slot for a payer id, and the server's `.strict()` query refuses one).
 *
 * Each row is the per-posting feed's row for that applicant, so it maps through the SAME two
 * mappers {@link getApplicantFeed} uses — weighted on an agency job, Matching V1 on a company
 * posting — plus its `posting` ref, untouched. `rank`/`hot` stay posting-relative.
 *
 *  - `postingId` narrows to one posting; an unknown or another payer's id is the SAME empty page
 *    as an owned posting with no applicants (no 404, no existence oracle).
 *  - `cursor` is the previous page's `nextCursor`, passed back verbatim (never built here).
 *  - `stage` narrows to one stage of the SAVED board — sent only when the caller names one. The API
 *    answers it with a 400 while it does not save stages, which this seam throws like any 400
 *    (`isPayerBadRequest`); the page decides what that means. Each row's own `stage` (present only
 *    while stages are saved) is carried through the mappers untouched.
 *  - FACELESS, ENFORCED: the response crosses {@link assertNoAgencyPII} like every agency read —
 *    through a lenient transport, so a forbidden key is SEEN (throws in dev/test, stripped in prod).
 *  - SCRAPE BOUND: one page costs one unit of the per-payer hourly reach cap it shares with the
 *    per-posting feed, so it can answer 429 (`isPayerRateLimited`). Any failure throws — the page
 *    renders its own state; nothing here fabricates a row.
 */
export async function getCandidateInbox(query: CandidateInboxQuery = {}): Promise<CandidateInbox> {
  const q = candidateInboxQuerySchema.parse(query);
  const params = new URLSearchParams();
  if (q.postingId !== undefined) params.set("postingId", q.postingId);
  if (q.cursor !== undefined) params.set("cursor", q.cursor);
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  if (q.stage !== undefined) params.set("stage", q.stage);
  const search = params.toString();
  const wire = await payerFetch(`/payer/reach/applicants${search ? `?${search}` : ""}`, {
    schema: candidateInboxTransportSchema,
  });
  const safe = candidateInboxWireSchema.parse(assertNoAgencyPII(wire, "payer/reach/applicants"));
  return candidateInboxSchema.parse({
    applicants: safe.applicants.map((row) => ({
      ...(isAgencyInboxRow(row) ? toWeightedApplicant(row) : toMatchCandidate(row)),
      posting: row.posting,
    })),
    nextCursor: safe.nextCursor,
  });
}

/**
 * PUT /payer/reach/jobs/:jobId/applicants/:workerId/stage — move one applicant on a posting's SAVED
 * New / Shortlist / Passed board (owner ruling 2026-10-07; API #2137). Either persona: the board is
 * governed by posting OWNERSHIP, which the server checks against the session (XB-A — the body is
 * `{ stage }` and nothing else; there is no slot for a payer id, a posting kind or a note).
 *
 *  - `jobId` is the id the per-posting feed takes — a company posting's or an agency job's; the
 *    server resolves which. Only ever called for a row whose feed carried a `stage` (the server
 *    saves stages); with none the board is local and never reaches here.
 *  - IDEMPOTENT: the same body twice is `changed: false` the second time, the same answer
 *    otherwise — a retry is safe.
 *  - NEUTRAL 404 → `null`: not the payer's posting, the worker no longer on its feed, or the server
 *    no longer saving stages — one body for all three (no existence oracle), so nothing here tells
 *    them apart. The caller re-reads the list.
 *  - The answer must be about the row that asked: a response naming another posting or worker is
 *    not reconciled into the board — it throws (fail closed; the caller rolls back).
 *  - A 429 (the stage route's own hourly bucket, or Redis down) throws for `isPayerRateLimited`;
 *    anything else throws too. No credit moves.
 */
export async function setApplicantStage(input: {
  jobId: string;
  workerId: string;
  stage: ApplicantStage;
}): Promise<ApplicantStageChange | null> {
  const path = `/payer/reach/jobs/${input.jobId}/applicants/${input.workerId}/stage`;
  let wire: ApplicantStageChange;
  try {
    wire = await payerFetch(path, {
      method: "PUT",
      body: { stage: input.stage },
      schema: applicantStageChangeWireSchema,
    });
  } catch (e) {
    if (isPayerStatus(e, 404)) return null;
    throw e;
  }
  if (wire.postingId !== input.jobId || wire.workerId !== input.workerId) {
    throw new Error(`payer API ${path} answered for another row`);
  }
  return wire;
}

/**
 * POST /payer/unlocks — spend a credit to unlock a candidate (LIVE). The body carries
 * ONLY `worker_id` (+ optional `job_id`); the payer is the session token (XB-A — there
 * is nowhere to put a payer_id). Every deny cause (no credits / no consent / capped /
 * already-unlocked) returns the SAME neutral body (no-oracle, F-3) → mapped to the one
 * neutral UnlockResult.
 */
export async function requestUnlock(input: {
  postingId: string;
  workerId: string;
}): Promise<UnlockResult> {
  const wire = await payerFetch("/payer/unlocks", {
    method: "POST",
    body: { worker_id: input.workerId, job_id: input.postingId },
    schema: unlockResultWireSchema,
  });
  if ("ok" in wire && wire.ok) {
    return unlockResultSchema.parse({
      ok: true,
      unlockId: wire.unlock_id,
      status: "granted",
      expiresAt: wire.expires_at,
    });
  }
  return unlockResultSchema.parse({ status: "unavailable" });
}

/**
 * POST /payer/unlocks/:unlockId/reveal — reveal a granted unlock the caller OWNS (LIVE).
 *
 * Returns a ROUTED contact handle ONLY: `{ relay_handle, channel, expires_at }` — an
 * opaque, non-reversible, expiring relay. There is NO phone/number anywhere in this
 * path (ADR-0010 F-4 / the pinned contract). A not-owned / unknown / expired / capped
 * unlock returns the IDENTICAL neutral body (no-oracle) → mapped to one neutral result.
 */
export async function reveal(input: { unlockId: string }): Promise<RevealResult> {
  return payerFetch(`/payer/unlocks/${input.unlockId}/reveal`, {
    method: "POST",
    body: {},
    schema: revealResultSchema,
  });
}

/**
 * The optional `expected_price_inr` body field (#2085): the ₹ the payer confirmed, sent ONLY
 * when the caller has one. It is a guard the API compares to the price it is about to charge
 * (409 `price_mismatch` → {@link PriceMismatchError}, nothing bought) — never a charged amount.
 */
function confirmedPrice(expectedPriceInr: number | undefined): { expected_price_inr?: number } {
  return expectedPriceInr === undefined ? {} : { expected_price_inr: expectedPriceInr };
}

/**
 * POST /payer/credits — buy a credit pack for the caller (LIVE). The body carries the
 * `pack_code` and, when the payer confirmed one, `expected_price_inr` (#2085 — a guard, never
 * the charge); the payer is the session token and the server resolves price + credits from
 * config (XB-A — NO payer_id, NO credits is ever sent). The
 * backend (`PayerUnlocksController.buyPack`, @HttpCode(201)) returns
 * `{ payer_id, balance, credits, pack_code }`, mapped onto {@link TopUpResult}.
 * A changed price throws {@link PriceMismatchError} (it is not a 404 or an in-flight 409).
 *
 * MONEY IS MOCK: `realCall` stays false — the backend mock-purchases (real_call:false);
 * there is NO Razorpay anywhere in this app. An UNKNOWN pack is a real backend 404 (a
 * public catalog item, not a tenant oracle) → surfaced as a neutral `null` not-found.
 */
export async function topUp(input: {
  packCode: string;
  /**
   * Optional per-purchase idempotency key (#1046). The SAME key across a re-tap of ONE
   * purchase makes the backend charge once and replay the first result; a duplicate landing
   * while the first is still in flight answers 409 → surfaced as {@link PurchaseConflictError}.
   * A 409 means the first attempt is STILL running (uncommitted, may still throw), NOT that it
   * completed (#1185) — the caller treats it as pending and may re-read the CURRENT balance for
   * display, but never re-posts, never guesses a number, and never claims the purchase is done.
   */
  idempotencyKey?: string;
  /** The ₹ the payer confirmed for this pack (#2085). */
  expectedPriceInr?: number;
}): Promise<TopUpResult | null> {
  let wire: ReturnType<typeof buyPackResultWireSchema.parse>;
  try {
    wire = await payerFetch("/payer/credits", {
      method: "POST",
      // XB-A: pack CODE (+ the confirmed price guard) — no payer_id, no credits.
      body: { pack_code: input.packCode, ...confirmedPrice(input.expectedPriceInr) },
      idempotencyKey: input.idempotencyKey,
      schema: buyPackResultWireSchema,
    });
  } catch (e) {
    // An unknown pack returns a real 404 (catalog item, not a per-tenant resource) →
    // a neutral not-found, NOT an error state.
    if (isPayerStatus(e, 404)) return null;
    // A 409 is a DUPLICATE of THIS purchase landing while the first is still in flight — the
    // body carries NO renderable balance (asserted server-side), so this is NOT a failure to
    // retry: the caller must RE-READ the real balance. Distinct typed error (never re-post).
    if (isInFlightPurchase(e)) throw new PurchaseConflictError();
    // A 403 is the API refusing this account (see PurchaseForbiddenError) — typed, never retried.
    if (isPayerStatus(e, 403)) throw new PurchaseForbiddenError();
    // Anything else propagates.
    throw e;
  }
  // The purchase is recorded server-side on the authoritative credit_ledger (the same
  // ledger `GET /payer/credits/ledger` reads) — no client-side history record anymore.
  return topUpResultSchema.parse({
    payerId: wire.payer_id,
    balance: wire.balance,
    creditsAdded: wire.credits,
    packCode: wire.pack_code,
    realCall: false, // MOCK money — the backend mock-purchases; there is NO Razorpay.
  });
}

/**
 * POST /payer/credits/order — create a REAL Razorpay order (real-payments stream).
 *
 * The body carries `{ pack_code }` plus, when the payer confirmed one, `expected_price_inr`
 * (XB-A/XT5: no payer_id, no amount, no currency) — the server resolves the ₹ from the same
 * pricing catalog the page advertised, so a tampered client cannot name its own price; the
 * confirmed price only lets it REFUSE a changed one ({@link PriceMismatchError}, #2085).
 *
 * The response's `key_id` is the PUBLIC `rzp_*` key id; it comes from the API on this
 * response rather than from a `NEXT_PUBLIC_*` build value, which keeps the key rotatable
 * without a rebuild and keeps the key SECRET out of this app entirely.
 *
 * Returns null when the route 404s: either an unknown pack, or real payments are OFF (the
 * launch gate answers a NEUTRAL 404 — indistinguishable by design). The caller shows a
 * generic "cannot start checkout" rather than guessing which.
 */
export async function createCreditOrder(input: {
  packCode: string;
  /** The ₹ the payer saw on the pack they chose (#2085). */
  expectedPriceInr?: number;
}): Promise<CreditOrder | null> {
  try {
    return await payerFetch("/payer/credits/order", {
      method: "POST",
      // pack CODE (+ the confirmed price guard) — never an amount to charge
      body: { pack_code: input.packCode, ...confirmedPrice(input.expectedPriceInr) },
      schema: creditOrderWireSchema,
    });
  } catch (e) {
    if (isPayerStatus(e, 404)) return null;
    // The API refused this account: no order was created, so no money moved.
    if (isPayerStatus(e, 403)) throw new PurchaseForbiddenError();
    throw e;
  }
}

/**
 * POST /payer/credits/verify — confirm a completed checkout and read back the balance.
 *
 * The three values are exactly what Razorpay Checkout handed the browser. They are
 * UNTRUSTED: the API verifies the signature against the key secret and binds the order to
 * the session payer. Returns null on a 404, which the API uses for every refusal (forged
 * signature / unknown order / another tenant's order) — one neutral answer, no oracle.
 *
 * A `credits: 0` result is still a SUCCESS: it means the webhook already granted, and
 * `balance` is authoritative. The UI must never read `credits === 0` as a failure.
 */
export async function verifyCreditPayment(input: {
  orderId: string;
  paymentId: string;
  signature: string;
}): Promise<VerifiedPayment | null> {
  try {
    return await payerFetch("/payer/credits/verify", {
      method: "POST",
      body: {
        razorpay_order_id: input.orderId,
        razorpay_payment_id: input.paymentId,
        razorpay_signature: input.signature,
      },
      schema: verifyPaymentWireSchema,
    });
  } catch (e) {
    if (isPayerStatus(e, 404)) return null;
    // The API refused the CONFIRM call — the checkout may still have charged; the webhook
    // settles independently of this route.
    if (isPayerStatus(e, 403)) throw new PurchaseForbiddenError();
    throw e;
  }
}

/**
 * GET /payer/credits/ledger — the caller's OWN credit top-ups (newest first), the top-up
 * half of the credit history + the source of the 12-month expiry schedule (LIVE; XB-A:
 * Bearer only, the ledger is payer-scoped server-side). The AUTHORITATIVE `credit_ledger`
 * rows replace the old client-recorded mock history: positive pack movements (delta > 0
 * with a pack_code) ARE the top-ups. PII-free (ids/amounts/config pack code only).
 *
 * PRICE (D-6): `priceInr` is the amount STAMPED on the ledger row at purchase time — what
 * the payer ACTUALLY paid. It is deliberately NOT resolved from the current catalog: doing
 * that let an ops price edit retroactively rewrite what past purchases appear to have cost
 * (history is a record, not a quote). A legacy row predating the stamp has no amount → the
 * field is omitted and the page renders a dash, never a fabricated one.
 */
export async function getCreditTopUps(): Promise<CreditTopUp[]> {
  const wire = await payerFetch("/payer/credits/ledger?limit=50", {
    schema: creditLedgerWireSchema,
  });
  // KNOWN CAP: the read is the newest 50 MOVEMENTS (the server's max page; no cursor
  // exists on PayerLedgerQuerySchema yet), so a very active payer's oldest top-ups age
  // out of this view. A cursor-paged ledger read is a small backend follow-up.
  return wire.ledger
    .filter((row) => row.delta > 0 && row.pack_code !== null)
    .map((row) =>
      creditTopUpSchema.parse({
        topUpId: row.id,
        packCode: row.pack_code,
        credits: row.delta,
        // The STAMPED charge only. Null/absent (legacy row) ⇒ omit ⇒ the page shows "—".
        ...(row.price_inr !== null && row.price_inr !== undefined
          ? { priceInr: row.price_inr }
          : {}),
        createdAt: row.created_at,
      }),
    );
}

/**
 * GET /payer/capacity — the caller's OWN concurrent active-vacancy ALLOWANCE (LIVE,
 * Bearer only — XB-A: no payer_id, no :payerId param). The backend
 * (`PayerCapacityController`) returns `{ payer_id, max_active_vacancies,
 * active_plan_count, source_tier, expires_at }`; `max_active_vacancies` is the
 * authoritative, config-resolved allowance and `active_plan_count` is the REAL, derived
 * live count of active plans from the enforcement engine.
 *
 * `activeVacancies` is the REAL `active_plan_count` (the enforcement engine's count), NOT a
 * count off the posting list — so the at-capacity signal (activeVacancies >= allowance) is
 * faithful. The per-posting applicant-quota ROWS are now the LIVE postings (GET
 * /payer/job-postings) — DISPLAY-only and they do NOT drive the count (the capacity page note
 * says so). The live posting row has no applicant count / quota in its projection, so those
 * columns read 0 (the count is the separate faceless reach feed's concern, not this row's).
 * All counts/codes; NO raw worker/payer PII (the seam mapper drops org_label/description).
 */
export async function getCapacity(): Promise<Capacity> {
  // Capacity allowance + the per-posting display rows are both payer-authed reads (XB-A: each
  // derives the session payer itself) — fetched concurrently.
  const [wire, postings] = await Promise.all([
    payerFetch("/payer/capacity", { schema: payerCapacityWireSchema }),
    getPostings(),
  ]);

  // LIVE postings as DISPLAY-only rows; they do NOT drive `activeVacancies` (the REAL count below).
  const rows = postings.map((p) => ({
    postingId: p.id,
    roleTitle: p.roleTitle,
    status: p.status,
    vacancyBand: p.vacancyBand,
    applicantsUsed: p.applicantCount,
    applicantQuota: p.applicantQuota ?? 0,
  }));
  return capacitySchema.parse({
    payerId: wire.payer_id,
    // LIVE, REAL active-plan count from the enforcement engine (NOT the mock store filter).
    activeVacancies: wire.active_plan_count,
    // LIVE allowance from the payer-authed capacity endpoint (config-resolved server-side).
    activeVacancyAllowance: wire.max_active_vacancies,
    applicantQuotaTotal: rows.reduce((sum, r) => sum + r.applicantQuota, 0),
    applicantQuotaUsed: rows.reduce((sum, r) => sum + r.applicantsUsed, 0),
    postings: rows,
  });
}

/** The seam result of a capacity buy/upgrade — a typed success or a NEUTRAL failure. */
export type BuyCapacityResult =
  | {
      ok: true;
      /** The allowance after this purchase (the raised catalog grant). */
      allowance: number;
      sourceTier: string | null;
      expiresAt: string | null;
      /** Opaque plan ids auto-resumed paused→active under the new allowance. */
      resumedPlanIds: string[];
    }
  | { ok: false; error: string };

/**
 * POST /payer/capacity — buy/upgrade the caller's OWN hiring capacity (LIVE, Bearer only).
 *
 * The body carries the tier CODE and, when the payer confirmed one, `expected_price_inr`
 * (#2085): NEVER a payer_id (XB-A — the session token is the identity) and NEVER an amount to
 * charge or a quota (XT5 — the server prices it via the pricing engine; the confirmed price is
 * only a guard it refuses a changed price with, {@link PriceMismatchError}). The backend RAISES
 * the allowance and auto-resumes paused plans up to it, then
 * returns `{ payer_id, quote, max_active_vacancies, source_tier, expires_at, resumed_plan_ids }`.
 *
 * Mapped onto a typed {@link BuyCapacityResult}: only ids/counts/tier/timestamps are
 * surfaced — the server-priced `quote` is parsed permissively and NEVER echoed (XT5). On any
 * thrown/!ok path a NEUTRAL `{ ok:false }` is returned (no leaked reason). FACELESS by
 * construction: the payload is opaque ids/counts/tier/timestamps only, so this does NOT wrap
 * `assertNoAgencyPII` (capacity is an employer surface) — and it NEVER echoes an un-crossed
 * fetched object.
 */
export async function buyCapacity({
  tier,
  idempotencyKey,
  expectedPriceInr,
}: {
  tier: string;
  /** The ₹ the payer confirmed for this tier (#2085). */
  expectedPriceInr?: number;
  /**
   * Optional per-purchase idempotency key (#1148). A duplicate capacity purchase is WORSE than a
   * duplicate credit pack — `greatest()` grants NO extra allowance but re-fires the payment +
   * capacity spine events (and burns a coupon redemption). The SAME key across a re-tap dedupes
   * to a replay; a duplicate in flight answers 409 → {@link PurchaseConflictError} so the caller
   * RE-READS the real allowance rather than re-posting or rendering a guessed figure.
   */
  idempotencyKey?: string;
}): Promise<BuyCapacityResult> {
  try {
    const wire = await payerFetch("/payer/capacity", {
      method: "POST",
      // XB-A: tier CODE (+ the confirmed price guard) — no payer_id; XT5: no amount/quota.
      body: { tier, ...confirmedPrice(expectedPriceInr) },
      idempotencyKey,
      schema: buyCapacityWireSchema,
    });
    return {
      ok: true,
      allowance: wire.max_active_vacancies,
      sourceTier: wire.source_tier,
      expiresAt: wire.expires_at,
      resumedPlanIds: wire.resumed_plan_ids,
    };
  } catch (e) {
    // A 409 is a DUPLICATE of THIS purchase in flight (no renderable allowance in the body) —
    // NOT a neutral failure. Surface it distinctly so the caller RE-READS the real allowance
    // (never re-posts, never guesses). This must be checked BEFORE the neutral collapse below,
    // or a double-charge-prevention 409 would masquerade as a generic "retry" (a re-tap = a
    // second purchase attempt the server already deduped).
    if (isInFlightPurchase(e)) throw new PurchaseConflictError();
    // A refused confirmed price (#2085) is not a retryable failure either: nothing was bought,
    // and the payer must see the new price and confirm again — never a "retry" at the old one.
    if (e instanceof PriceMismatchError) throw e;
    // Neutral failure — no leaked deny reason / role state (no-oracle); never a fake success.
    return { ok: false, error: "Capacity upgrade failed (service unavailable). Please retry." };
  }
}

/**
 * A 409 from a PURCHASE (`POST /payer/credits` #1046, `POST /payer/capacity` #1148, or the
 * quota top-up #2085): a DUPLICATE landed while the first request carrying the same
 * `Idempotency-Key` was still in flight. The 409 body carries NO renderable
 * balance/allowance by design (asserted server-side) — inventing a figure would be worse than
 * the double-charge it prevents. The ONLY correct response is to RE-READ the real figure
 * (`GET /payer/credits` / `GET /payer/capacity` / the posting): never re-POST, never render a
 * guessed number. Thrown by {@link topUp}, {@link buyCapacity} and {@link topUpPostingQuota}
 * so the action can distinguish this from every other failure.
 */
export class PurchaseConflictError extends Error {
  constructor() {
    super("duplicate purchase in flight");
    this.name = "PurchaseConflictError";
  }
}

/** The 409 `reason` a purchase route names for its in-flight duplicate (#2135, all five routes). */
const IN_FLIGHT_REASON = "in_flight";

/**
 * Is `e` a purchase's in-flight duplicate (→ {@link PurchaseConflictError})? On the credit-pack
 * and capacity routes (#2111):
 *  - the API NAMES it (#2135): `reason: "in_flight"`. A 409 naming any OTHER reason is not one —
 *    it is never guessed into "still processing";
 *  - an API from before #2135 names no reason, and on these routes its only 409 (other than a
 *    price mismatch, which is never a {@link PayerConflictError}) was the in-flight duplicate —
 *    so a bare 409 still reads as one. payer-web may deploy ahead of the API.
 */
function isInFlightPurchase(e: unknown): boolean {
  if (e instanceof PayerConflictError && e.reason !== null) return e.reason === IN_FLIGHT_REASON;
  return isPayerStatus(e, 409);
}

/**
 * A 403 on a credit PURCHASE route (`POST /payer/credits`, `/payer/credits/order`,
 * `/payer/credits/verify`): the API refused THIS account. #2098 (#2079) put an owner-only
 * `PayerOrgRoleGuard` on these routes; the 2026-10-07 owner ruling opens buying to every member
 * and the backend is lifting that guard, but until it deploys a Recruiter this app admits gets a
 * 403 here. Typed so the action can answer it neutrally and WITHOUT inviting a retry (a retry is
 * the same 403); it is neither a transport blip nor the 404 → null "unknown pack / payments off"
 * path. Carries no deny reason from the body (no-oracle).
 */
export class PurchaseForbiddenError extends Error {
  constructor() {
    super("purchase refused for this account");
    this.name = "PurchaseForbiddenError";
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * LIVE — Agency Supply Portal DEMAND (ADR-0022, #127). All are payer-authed +
 * role-gated server-side (`PayerAuthGuard` + `PayerRoleGuard @PayerRoles('agent')`);
 * the role VIEW is additionally gated in the page (`requireAgent()`). Tenancy is the
 * SESSION (XB-A): the agency NEVER sends a payer_id — the JWT carries it. Every payload
 * is faceless/coarse and crosses {@link assertNoAgencyPII} (defence-in-depth) before it
 * reaches a page. Unknown-or-not-owned → the backend's IDENTICAL neutral 404 → `null`
 * (no-oracle). These are the AGENCY `jobs.payer_id` entity — distinct from the EMPLOYER
 * job-postings surface below (also fully LIVE).
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The clearable agency-job fields — MIRRORED from the backend `CLEARABLE_AGENCY_JOB_FIELDS`
 * (agency.dto.ts). SHORTER than the posting list by exactly three names: `trade_key`, `title` and
 * `city` are NOT NULL on `jobs`, so they have no name here and a `clear` can never reach them.
 */
const CLEARABLE_AGENCY_JOB_FIELDS = [
  ["area", "area"],
  ["pay_min", "payMin"],
  ["pay_max", "payMax"],
  ["pay_type", "payType"],
  ["min_experience_years", "minExperienceYears"],
  ["max_experience_years", "maxExperienceYears"],
  ["needed_by", "neededBy"],
  ["description", "description"],
  ["shift", "shift"],
  ["benefits", "benefits"],
  ["requirements", "requirements"],
  ["role_kind", "roleKind"],
  // `match_skill_ids` is DELIBERATELY ABSENT, though the backend's own list does hold it. An
  // omitted `match_skill_ids` means UNCHANGED (ADR-0050 §6.1 step 2) and the form omits it on
  // every edit that did not touch the pick — a name here would turn each of those into a `clear`
  // and wipe a pick nobody edited. The form requires a pick (Q9), so it never needs to clear one.
] as const;

/**
 * Map the camelCase UI input to the backend's snake_case agency-job body. PR-B carries the full
 * card content (role_kind + shift/pay_type/description/requirements/benefits) so an agency job
 * traces to a card exactly like a company posting. On EDIT, `initial` drives the `clear` diff —
 * a field the payer BLANKED (had a value, now absent) is unset; `trade_key`/`title`/`city` are
 * NOT NULL and never clearable. `role_kind` is required, so it is always set (never cleared).
 */
function toAgencyJobBody(input: AgencyJobInput, initial?: AgencyJob | null): Record<string, unknown> {
  const body: Record<string, unknown> = {
    trade_key: input.tradeKey,
    role_kind: input.roleKind,
    title: input.title,
    city: input.city,
  };
  if (input.area !== undefined) body.area = input.area;
  if (input.payMin !== undefined) body.pay_min = input.payMin;
  if (input.payMax !== undefined) body.pay_max = input.payMax;
  if (input.payType !== undefined) body.pay_type = input.payType;
  if (input.minExperienceYears !== undefined) body.min_experience_years = input.minExperienceYears;
  if (input.maxExperienceYears !== undefined) body.max_experience_years = input.maxExperienceYears;
  if (input.shift !== undefined) body.shift = input.shift;
  if (input.neededBy !== undefined) body.needed_by = input.neededBy;
  if (input.description !== undefined) body.description = input.description;
  if (input.requirements !== undefined) body.requirements = input.requirements;
  if (input.benefits !== undefined) body.benefits = input.benefits;
  // ADR-0050 §6.1 step 2 — the explicit match pick, the only matching input (`trade_key` is never
  // read for it). Sent when the caller supplies it; OMITTED otherwise, which the backend reads as
  // `[]` on create and UNCHANGED on edit — so the form sends it on every create and only on an
  // edit that changed it, and a client older than this never disturbs a stored pick.
  if (input.matchSkillIds !== undefined) body.match_skill_ids = input.matchSkillIds;
  if (initial) {
    const clear: string[] = [];
    for (const [snake, camel] of CLEARABLE_AGENCY_JOB_FIELDS) {
      const setNow = (input as unknown as Record<string, unknown>)[camel] !== undefined;
      if (!setNow && initialPresent((initial as unknown as Record<string, unknown>)[camel])) clear.push(snake);
    }
    if (clear.length > 0) body.clear = clear; // `.min(1)` server-side — omit an empty list.
  }
  return body;
}

/** GET /payer/agency/jobs — the caller's OWN jobs (faceless: ids/status/counts/bands). */
export async function listAgencyJobs(): Promise<AgencyJob[]> {
  const wire = await payerFetch("/payer/agency/jobs", { schema: agencyJobListWireSchema });
  return assertNoAgencyPII(wire, "payer/agency/jobs");
}

/**
 * GET /payer/agency/jobs/:jobId — one OWN job. An unknown-or-not-owned job returns the
 * SAME neutral 404 (no-oracle) → mapped to `null` so the page renders a neutral not-found.
 */
export async function getAgencyJob(jobId: string): Promise<AgencyJob | null> {
  try {
    const wire = await payerFetch(`/payer/agency/jobs/${jobId}`, { schema: agencyJobWireSchema });
    return assertNoAgencyPII(wire, "payer/agency/jobs/:id");
  } catch (e) {
    if (isPayerStatus(e, 404)) return null;
    throw e;
  }
}

/** POST /payer/agency/jobs — create an OWNED job (payer_id = session, status='open'). */
export async function createAgencyJob(input: AgencyJobInput): Promise<AgencyJob> {
  const wire = await payerFetch("/payer/agency/jobs", {
    method: "POST",
    body: toAgencyJobBody(input),
    schema: agencyJobWireSchema,
  });
  return assertNoAgencyPII(wire, "payer/agency/jobs (create)");
}

/** PATCH /payer/agency/jobs/:jobId — edit an OWNED job. Neutral 404 → null. */
export async function updateAgencyJob(
  jobId: string,
  input: AgencyJobInput,
  initial?: AgencyJob | null,
): Promise<AgencyJob | null> {
  try {
    const wire = await payerFetch(`/payer/agency/jobs/${jobId}`, {
      method: "PATCH",
      body: toAgencyJobBody(input, initial),
      schema: agencyJobWireSchema,
    });
    return assertNoAgencyPII(wire, "payer/agency/jobs/:id (update)");
  } catch (e) {
    if (isPayerStatus(e, 404)) return null;
    throw e;
  }
}

/** POST /payer/agency/jobs/:jobId/pause — pause an OWN job (== close in Phase 1). Neutral 404 → null. */
export async function pauseAgencyJob(jobId: string): Promise<AgencyJob | null> {
  try {
    const wire = await payerFetch(`/payer/agency/jobs/${jobId}/pause`, {
      method: "POST",
      body: {},
      schema: agencyJobWireSchema,
    });
    return assertNoAgencyPII(wire, "payer/agency/jobs/:id/pause");
  } catch (e) {
    if (isPayerStatus(e, 404)) return null;
    throw e;
  }
}

/**
 * POST /payer/agency/jobs/:jobId/resume — resume an OWN paused job (`paused` -> `open`, #1202).
 * The other half of a reversible pause. Only a `paused` job resumes: `suspended` is SYSTEM-owned
 * (ADR-0037) and 409s here (propagated). Neutral 404 (unknown/not-owned) → null.
 */
export async function resumeAgencyJob(jobId: string): Promise<AgencyJob | null> {
  try {
    const wire = await payerFetch(`/payer/agency/jobs/${jobId}/resume`, {
      method: "POST",
      body: {},
      schema: agencyJobWireSchema,
    });
    return assertNoAgencyPII(wire, "payer/agency/jobs/:id/resume");
  } catch (e) {
    if (isPayerStatus(e, 404)) return null;
    throw e;
  }
}

/** POST /payer/agency/jobs/:jobId/close — close an OWN job (terminal). Neutral 404 → null. */
export async function closeAgencyJob(jobId: string): Promise<AgencyJob | null> {
  try {
    const wire = await payerFetch(`/payer/agency/jobs/${jobId}/close`, {
      method: "POST",
      body: {},
      schema: agencyJobWireSchema,
    });
    return assertNoAgencyPII(wire, "payer/agency/jobs/:id/close");
  } catch (e) {
    if (isPayerStatus(e, 404)) return null;
    throw e;
  }
}

/**
 * GET /payer/agency/referrals/summary — the agency's OWN funnel, AGGREGATE-ONLY with the
 * k-anon floor ALREADY applied server-side. Rendered as-is; `minBucket` is echoed so the
 * UI can show a suppressed 0 as "<minBucket" (not literally zero) — no single-invitee
 * oracle. NEVER reconstruct per-invitee data from these counts.
 */
export async function getAgencyReferralsSummary(): Promise<AgencyReferralsSummary> {
  const wire = await payerFetch("/payer/agency/referrals/summary", {
    schema: agencyReferralsSummaryWireSchema,
  });
  return assertNoAgencyPII(wire, "payer/agency/referrals/summary");
}

/**
 * The optional W1 LINK METADATA both mint routes accept — the attribution `medium` and the
 * closed non-PII deep-link `context`.
 *
 * REFERENT-FREE BY CONSTRUCTION, which is the only reason an agency-facing endpoint may
 * write into `agency_invites.payload` at all: `medium` describes the CHANNEL a link travels
 * on and `context` describes the JOB SHAPE it advertises. Neither can denote a person. The
 * backend `InviteContextSchema` is `.strict()` with exactly these two keys, so an extra key
 * is a loud 400 rather than a silently stored one — this type mirrors that closed shape
 * instead of widening it to `Record<string, string>`.
 */
export interface AgencyInviteMetaInput {
  medium?: "organic" | "paid";
  context?: { role?: string; city?: string };
}

/**
 * Copy the metadata onto a mint body, omitting anything empty.
 *
 * An absent key and an empty one are NOT the same to the backend: `context: {}` would pass
 * `.strict()` and write an empty object over the column default for no reason. Only
 * genuinely-present values are sent, so an agent who fills in nothing produces the exact
 * body this endpoint accepted before W1.
 */
function applyInviteMeta(body: Record<string, unknown>, input: AgencyInviteMetaInput): void {
  if (input.medium) body.medium = input.medium;
  const context: Record<string, string> = {};
  if (input.context?.role) context.role = input.context.role;
  if (input.context?.city) context.city = input.context.city;
  if (Object.keys(context).length > 0) body.context = context;
}

/** The seam result of an invite mint — an opaque code on success, or a NEUTRAL failure. */
export type CreateAgencyInviteResult =
  | { ok: true; code: string; link: string }
  | { ok: false };

/**
 * POST /payer/agency/invites — mint an OWNED opaque invite code. FACELESS: the body
 * carries NO phone/name/email/worker-id — only an optional non-PII campaign tag; the
 * response is an OPAQUE code/link only. The per-payer hourly mint cap AND a Redis outage
 * BOTH return the SAME backend 429 (fail-closed, no leaked reason) → surfaced as a single
 * NEUTRAL failure (`{ ok: false }`), never a fake success. Other transient failures
 * propagate to the caller's action, which also neutralizes them.
 */
export async function createAgencyInvite(
  input: {
    campaign?: string;
  } & AgencyInviteMetaInput,
): Promise<CreateAgencyInviteResult> {
  const body: Record<string, unknown> = {};
  if (input.campaign) body.campaign = input.campaign;
  applyInviteMeta(body, input);
  try {
    const wire = assertNoAgencyPII(
      await payerFetch("/payer/agency/invites", {
        method: "POST",
        body,
        schema: agencyInviteWireSchema,
      }),
      "payer/agency/invites",
    );
    return { ok: true, code: wire.code, link: wire.link };
  } catch (e) {
    // 429 = mint cap reached OR Redis fail-closed (identical 429, no leaked reason).
    if (isPayerStatus(e, 429)) return { ok: false };
    throw e;
  }
}

/** The seam result of a BATCH mint — N opaque codes on success, or a NEUTRAL failure. */
export type CreateAgencyInviteBatchResult =
  | { ok: true; invites: { code: string; link: string }[] }
  | { ok: false };

/**
 * POST /payer/agency/invites/batch — mint N OWNED opaque invite codes in one call.
 *
 * The privacy shape is IDENTICAL to the singular {@link createAgencyInvite}: the body carries
 * only `count` plus the same optional non-PII `campaign` tag — no phone/name/email/worker-id,
 * and no payer_id (XB-A: the session token is the identity). The response is opaque codes/links
 * only, which still cross {@link assertNoAgencyPII} (defence-in-depth).
 *
 * The per-payer mint cap AND a Redis outage BOTH return the SAME backend 429 (fail-closed, no
 * leaked reason) → one NEUTRAL `{ ok: false }`, never a fake success and never a partial list
 * presented as complete. Other transient failures propagate to the caller's action, which
 * neutralizes them the same way the singular mint's action does.
 */
export async function createAgencyInviteBatch(
  input: {
    count: number;
    campaign?: string;
  } & AgencyInviteMetaInput,
): Promise<CreateAgencyInviteBatchResult> {
  const body: Record<string, unknown> = { count: input.count };
  if (input.campaign) body.campaign = input.campaign;
  applyInviteMeta(body, input);
  try {
    const wire = assertNoAgencyPII(
      await payerFetch("/payer/agency/invites/batch", {
        method: "POST",
        body,
        schema: agencyInviteBatchWireSchema,
      }),
      "payer/agency/invites/batch",
    );
    return { ok: true, invites: wire.invites.map((i) => ({ code: i.code, link: i.link })) };
  } catch (e) {
    // 429 = mint cap reached OR Redis fail-closed (identical 429, no leaked reason).
    if (isPayerStatus(e, 429)) return { ok: false };
    throw e;
  }
}

/**
 * TRANSPORT schema for the referred-worker list — the contract shape, but LENIENT.
 *
 * A plain `z.object` STRIPS unknown keys, which would silently swallow a regressed backend
 * payload carrying a worker name before {@link assertNoAgencyPII} ever saw it — the guard
 * would be decorative on this route. Parsing loosely here means a forbidden key SURVIVES to
 * the guard, which THROWS in dev/test (a loud CI failure) and strips + warns in prod. The
 * strict {@link agencyWorkerListWireSchema} is then re-applied below as the final projection,
 * so only the five contract fields can ever reach the page.
 */
const agencyWorkerListTransportSchema = z
  .object({ workers: z.array(agencyWorkerWireSchema.passthrough()) })
  .passthrough();

/**
 * GET /payer/agency/workers — the ENGAGEMENT view of the workers THIS agency referred
 * (LIVE, agent-role-gated + payer-authed; the `inviter_payer_id` is the SESSION and appears
 * in no route/query/body — XB-A, there is no parameterised variant to abuse).
 *
 * FACELESS: opaque per-agency `ref` handles, booleans, counts and a coarse UTC day only —
 * never a name/phone/employer, never WHICH job or WHO unlocked. Do not add a client-side
 * join, lookup or drill-down on `ref`: it is a pseudonym precisely so nothing can be
 * reconstructed from it.
 *
 * CONSENT (invariant #6): the backend selects ONLY workers carrying an active
 * `agent_activity_visibility` consent, and a non-consenting worker is absent identically to
 * a never-referred one (no consent oracle). An EMPTY array is therefore the normal answer —
 * today it is the ONLY answer, because no client requests that consent purpose yet. The page
 * must treat empty as a first-class state, never as an error.
 *
 * SCRAPE BOUND: this read rides the payer hourly reach cap server-side, so it can answer 429.
 * That is a transport error like any other and propagates — the page degrades to its neutral
 * retry card rather than rendering a half-list or a fabricated one.
 */
export async function listAgencyWorkers(): Promise<AgencyWorker[]> {
  const wire = await payerFetch("/payer/agency/workers", {
    schema: agencyWorkerListTransportSchema,
  });
  const safe = assertNoAgencyPII(wire, "payer/agency/workers");
  // Final strict projection: exactly the five contract fields reach the UI, nothing else.
  return agencyWorkerListWireSchema.parse(safe).workers;
}

/* ────────────────────────────────────────────────────────────────────────────
 * LIVE — Agency SUPPLY money (ADR-0022 Amendment 2): earnings / KYC / payout.
 * All are payer-authed + agent-role-gated server-side; the SESSION is the identity
 * (XB-A — NO body payer_id) and money is MOCK (no real disbursement).
 *
 * GATE (fail-closed): while `AGENCY_PAYOUTS_ENABLED` is OFF (the default) every one of
 * these routes returns 404. That 404 is NOT an error — it means "supply payouts not yet
 * enabled". Each read maps it to `null` (the "not enabled" signal) so the page can render
 * a graceful "coming soon" inert state; any OTHER failure throws (honest error/degrade).
 * The referral link + funnel (invites/summary above) are NOT gated and stay live.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * True when a payer-http error is the gated-route 404 ("supply payouts not enabled").
 * These routes have no per-resource 404 (they return the caller's OWN aggregate/status),
 * so a 404 unambiguously means the feature flag is off — a graceful inert state, not an
 * error. Reused by every gated agency-money seam fn.
 */
function isPayoutsDisabled(e: unknown): boolean {
  return isPayerStatus(e, 404);
}

/**
 * GET /payer/agency/earnings — the caller's OWN referral-earnings summary (LIVE, gated).
 * `null` = supply payouts not enabled (404). PII-free (amounts/counts/config + a status
 * enum). Crosses {@link assertNoAgencyPII} (defence-in-depth).
 */
export async function getAgencyEarnings(): Promise<AgencyEarnings | null> {
  try {
    const wire = await payerFetch("/payer/agency/earnings", { schema: agencyEarningsWireSchema });
    return assertNoAgencyPII(wire, "payer/agency/earnings");
  } catch (e) {
    if (isPayoutsDisabled(e)) return null;
    throw e;
  }
}

/**
 * GET /payer/agency/kyc — the caller's OWN KYC status (LIVE, gated). MASKED-only: the
 * response carries `panLast4` / `bankLast4` (display last-4), NEVER the raw PAN/bank.
 * `null` = supply payouts not enabled (404). Crosses {@link assertNoAgencyPII} — the
 * masked last-4 keys are explicitly allow-listed there; a raw `pan`/`bank`/`ifsc` key
 * would still throw (faceless boundary).
 */
export async function getAgencyKyc(): Promise<AgencyKyc | null> {
  try {
    const wire = await payerFetch("/payer/agency/kyc", { schema: agencyKycWireSchema });
    return assertNoAgencyPII(wire, "payer/agency/kyc");
  } catch (e) {
    if (isPayoutsDisabled(e)) return null;
    throw e;
  }
}

/**
 * POST /payer/agency/kyc — submit the caller's OWN KYC (LIVE, gated). The raw PAN / bank /
 * IFSC / holder name ride the BODY only (write-only, snake_case) — the server re-validates
 * + uppercases and stores them encrypted; the RESPONSE is the masked status. XB-A: the
 * session is the identity (no body payer_id). `null` = supply payouts not enabled (404).
 */
export async function submitAgencyKyc(input: AgencyKycInput): Promise<AgencyKyc | null> {
  try {
    const wire = await payerFetch("/payer/agency/kyc", {
      method: "POST",
      body: {
        pan: input.pan,
        bank_account: input.bankAccount,
        ifsc: input.ifsc,
        account_holder_name: input.accountHolderName,
      },
      schema: agencyKycWireSchema,
    });
    return assertNoAgencyPII(wire, "payer/agency/kyc (submit)");
  } catch (e) {
    if (isPayoutsDisabled(e)) return null;
    throw e;
  }
}

/**
 * GET /payer/agency/payouts — the caller's OWN payout-request history (LIVE, gated),
 * PII-free (ids / ₹ amounts / status / timestamps). `null` = supply payouts not enabled
 * (404). Crosses {@link assertNoAgencyPII} like every other agency read (defence-in-depth) —
 * it was the one read on /agency/referrals that did not.
 */
export async function listAgencyPayouts(): Promise<AgencyPayout[] | null> {
  try {
    const wire = await payerFetch("/payer/agency/payouts", {
      schema: agencyPayoutListWireSchema,
    });
    return assertNoAgencyPII(wire, "payer/agency/payouts");
  } catch (e) {
    if (isPayoutsDisabled(e)) return null;
    throw e;
  }
}

/**
 * POST /payer/agency/payouts — request a payout of the requestable balance (LIVE, gated).
 * The session is the identity (XB-A); the body is empty (the server computes the amount +
 * re-checks the gate). The 2xx body is the discriminated union `{ ok:true, … }` (created)
 * OR `{ ok:false, blocked:true, reason }` (server refused) — both returned as-is. `null` =
 * supply payouts not enabled (404). MOCK money (no real disbursement).
 */
export async function requestAgencyPayout(): Promise<AgencyPayoutRequestWire | null> {
  try {
    return await payerFetch("/payer/agency/payouts", {
      method: "POST",
      body: {},
      schema: agencyPayoutRequestWireSchema,
    });
  } catch (e) {
    if (isPayoutsDisabled(e)) return null;
    throw e;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * LIVE — EMPLOYER job postings (payer-authed `/payer/job-postings`, PayerAuthGuard).
 *
 * The company posting READ/WRITE path moved off the mock store onto the payer-authed
 * endpoints (the sibling of credits/unlocks/capacity). Tenancy is the SESSION (XB-A):
 * the JWT carries the payer; the body NEVER carries payer_id/created_by (the backend
 * stamps them from `@CurrentPayer`). Every payload is PII-free — the wire row carries
 * the payer's OWN org_label/description, which {@link toPostingSummary} DROPS so only the
 * faceless {@link postingSummarySchema} fields reach the UI. Unknown-or-not-owned →
 * the backend's IDENTICAL neutral 404 → `null` (no-oracle). The lifecycle
 * PAUSE/RESUME/quota-top-up surfaces are LIVE below too (#178/#180).
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Map a LIVE job-posting wire row → the faceless {@link PostingSummary} the pages consume.
 *
 * The wire row is the backend's SNAKE_CASE `JobPostingApi` projection
 * (`apps/api/src/job-postings/job-postings.repository.ts` → `toJobPostingApi`); this is the
 * PURE wire→domain mapper for it. The wire schema itself stays a plain Zod object with NO
 * `.transform` — `payerFetch`'s `schema: z.ZodType<T>` bound requires input === output, so a
 * transforming schema cannot be handed to the transport.
 *
 * DEFENCE-IN-DEPTH (invariant #2): the wire row carries the payer's OWN `org_label`/`description`
 * + `payer_id`/`created_by` (their own ids) — none of which any page needs, so they are DROPPED
 * here and never reach the UI domain object. `applicantCount` is 0 and `applicantQuota` is
 * omitted: NEITHER is in the job-posting projection (the applicant count is the separate faceless
 * reach feed's concern; the quota was a mock-only config stamp). `vacancyBand` is the backend
 * band string, surfaced as-is (postingSummarySchema.vacancyBand is a plain string).
 */
function toPostingSummary(wire: ReturnType<typeof jobPostingWireSchema.parse>): PostingSummary {
  return postingSummarySchema.parse({
    id: wire.id,
    roleTitle: wire.role_title,
    locationLabel: wire.location_label,
    vacancyBand: wire.vacancy_band,
    status: wire.status,
    applicantCount: 0, // NOT in this projection — the count is the reach feed's, not the row's.
    createdAt: wire.created_at,
    // applicantQuota intentionally omitted (not a live-row concept) → the page renders "—".
  });
}

/** GET /payer/job-postings — the caller's OWN postings (LIVE), newest first; faceless rows. */
export async function getPostings(): Promise<PostingSummary[]> {
  const wire = await payerFetch("/payer/job-postings", { schema: jobPostingListWireSchema });
  return wire.map(toPostingSummary);
}

/**
 * Map the EMPLOYER posting input to the LIVE `POST /payer/job-postings` body — exactly the
 * backend `PayerCreateJobPostingSchema` shape. Pure + exported so the wire contract is
 * unit-pinned NOW (see posting-seam.test.ts), the forward-compat sibling of
 * {@link toAgencyJobBody}:
 *   - `org_label` is the payer's OWN org — the SESSION identity (resolved by the caller from
 *     GET /payer/me at the live swap), NEVER a form field, NEVER eventized (XB-A / privacy).
 *   - sends the RAW `vacancies` count and NO `vacancy_band` ⇒ EXACTLY ONE of the two (the
 *     backend derives its OWN band — the frontend/backend band-sets differ).
 *   - NEVER `payer_id` / `created_by` (the verified session is owner+creator).
 *   - trade/pay/exp are NOT included: the CREATE schema `PayerCreateJobPostingSchema` accepts
 *     only org_label/role_title/location_label?/description?/vacancy(_band|ies)/skills?. Those
 *     three stay collected-for-parity but unsent here. NOTE: pay/city/shift/needed_by ARE
 *     accepted by the WIDER UPDATE schema, so a payer sets them via the edit PATCH
 *     ({@link toPayerJobPostingPatchBody}); trade/exp are accepted by neither schema.
 * Optional labels are omitted when absent so the body carries only meaningful keys.
 */
export function toPayerJobPostingBody(
  input: CreatePostingInput,
  orgLabel: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    org_label: orgLabel,
    role_title: input.roleTitle,
    vacancies: input.vacancies, // EXACTLY ONE of vacancy_band|vacancies — the RAW count.
  };
  // PR-B: the posting form is the traceable SOURCE of every card field, and the backend
  // `PayerCreateJobPostingSchema` spreads `postingContentFields` (#1645/#1646/#1648) — so create
  // carries them all (role_kind + the worker-visible card content), not just the description. Every
  // key is sent only when defined, so a minimal posting still carries only meaningful keys.
  if (input.locationLabel !== undefined) body.location_label = input.locationLabel;
  if (input.description !== undefined) body.description = input.description;
  if (input.roleKind !== undefined) body.role_kind = input.roleKind;
  if (input.city !== undefined) body.city = input.city;
  if (input.area !== undefined) body.area = input.area;
  if (input.payMin !== undefined) body.pay_min = input.payMin;
  if (input.payMax !== undefined) body.pay_max = input.payMax;
  if (input.payType !== undefined) body.pay_type = input.payType;
  if (input.minExperienceYears !== undefined) body.min_experience_years = input.minExperienceYears;
  if (input.maxExperienceYears !== undefined) body.max_experience_years = input.maxExperienceYears;
  if (input.shift !== undefined) body.shift = input.shift;
  if (input.neededBy !== undefined) body.needed_by = input.neededBy;
  if (input.requirements !== undefined) body.requirements = input.requirements;
  if (input.benefits !== undefined) body.benefits = input.benefits;
  return body;
}

/**
 * POST /payer/job-postings — create a posting OWNED by the caller (LIVE). The body is the
 * pinned {@link toPayerJobPostingBody} shape: `org_label` is the SESSION org (resolved from
 * GET /payer/me, NEVER a form field), it sends the RAW `vacancies` count (exactly one of
 * vacancy_band|vacancies — the backend derives its OWN band), and it NEVER carries
 * payer_id/created_by (XB-A — the backend stamps both from `@CurrentPayer`). The created row
 * comes back as `status:"draft"` (publish is a separate PATCH) and is mapped to the faceless
 * {@link PostingSummary} (org_label/description dropped). Price/quota are NOT in the body —
 * posting is free-through-launch and the quota stays config-sourced server-side (XT5).
 */
export async function createPosting(input: CreatePostingInput): Promise<PostingSummary> {
  const orgLabel = await sessionOrgLabel(); // SESSION identity (XB-A) — never a client field.
  const wire = await payerFetch("/payer/job-postings", {
    method: "POST",
    body: toPayerJobPostingBody(input, orgLabel),
    schema: jobPostingWireSchema,
  });
  return toPostingSummary(wire);
}

/**
 * GET /payer/job-postings/:id — the caller's OWN posting as an EDIT DRAFT (LIVE): the
 * faceless summary PLUS the payer's OWN editable fields (their registered description +
 * the coarse worker-visible city/pay/shift/needed_by), needed to PREFILL the edit form —
 * all the caller's own data, the sibling of GET /payer/me. Same neutral 404 → `null`
 * contract as {@link getPosting}. Still NO worker PII by design (these are the posting's
 * own coarse, PII-free fields). `shift`/`neededBy` are surfaced as the raw wire strings;
 * the edit form only seeds a `<select>` from them when they match the closed enum.
 */
export interface PostingDetail {
  summary: PostingSummary;
  /** The traceable card fields — the ONE contract Create/Edit/View/Card/Agency all share. */
  card: CardFields;
  /** The payer's OWN free-text description (not a card field; prefilled + shown separately). */
  description: string | null;
  /** The ADR-0030 descriptive skill phrases the posting carries (display list). */
  skills: string[];
  /** The MATCHABLE half echoed back, so the edit skill picker prefills what was published. */
  matchSkillIds: string[];
  untickedRelatedIds: string[];
  /**
   * The saved revision (`updated_at`). The edit page keys its form on it, so a form seeded from
   * an older revision remounts instead of keeping stale values (and a stale `clear` diff).
   */
  updatedAt: string;
}

/**
 * GET /payer/job-postings/:id — the caller's OWN posting as a full DETAIL read (LIVE): the
 * faceless summary + the CardFields (the traceable lineage the preview renders) + the payer's OWN
 * description + skills + the match selection for the edit picker. Used by BOTH the detail page and
 * the edit page (one read, one contract). `org_label` and any verified/trust flag are DROPPED —
 * they are not card fields and never reach the UI. Same neutral 404 → `null` contract as
 * {@link getPosting}. Replaces the old `getPostingDraft` (which returned an ad-hoc field bag).
 */
export async function getPostingDetail(postingId: string): Promise<PostingDetail | null> {
  try {
    const wire = await payerFetch(`/payer/job-postings/${postingId}`, {
      schema: jobPostingWireSchema,
    });
    return {
      summary: toPostingSummary(wire),
      card: cardFieldsFromPostingWire(wire),
      description: wire.description,
      skills: wire.skill_phrases,
      matchSkillIds: wire.match_skill_ids ?? [],
      untickedRelatedIds: wire.unticked_related_ids ?? [],
      updatedAt: wire.updated_at,
    };
  } catch (e) {
    if (isPayerStatus(e, 404)) return null;
    throw e;
  }
}

/**
 * GET /payer/job-postings/:id — one of the caller's OWN postings (LIVE). An unknown OR
 * not-owned id returns the SAME neutral 404 (no-oracle) → mapped to `null` so a manage page
 * renders a neutral not-found. Faceless mapping (org_label/description dropped).
 */
export async function getPosting(postingId: string): Promise<PostingSummary | null> {
  try {
    const wire = await payerFetch(`/payer/job-postings/${postingId}`, {
      schema: jobPostingWireSchema,
    });
    return toPostingSummary(wire);
  } catch (e) {
    if (isPayerStatus(e, 404)) return null;
    throw e;
  }
}

/**
 * PATCH body for an EMPLOYER posting edit — the faceless demand fields ONLY. UNLIKE create it
 * sends NO `org_label` (the session identity is not edited) and NEVER payer_id/created_by; it
 * sends the RAW `vacancies` count (at most one of vacancy_band|vacancies — the backend derives
 * its band and discards the integer). Pure + exported so the wire contract is unit-pinned, the
 * sibling of {@link toPayerJobPostingBody}.
 *
 * The UPDATE schema `UpdateJobPostingSchema` is WIDER than create: it accepts the worker-visible
 * display fields `city / pay_min / pay_max / shift / needed_by` (migration 0054), so those are
 * mapped through HERE when the form set them — the ONLY self-serve way a payer edits them. Pay is
 * passed STRAIGHT THROUGH from validated form state; this never computes or defaults a price.
 * Fields the update schema does NOT accept (trade/exp) are never mapped. Every optional key is
 * omitted when absent, so the body carries only meaningful keys and an untouched field is left
 * server-side. Accepts the {@link UpdatePostingInput} subset (a CreatePostingInput satisfies it).
 */
/**
 * The prior values of a posting's editable + clearable fields — the `initial` the edit form was
 * seeded with. Used ONLY to compute the `clear` diff: a field the payer BLANKED (had a value,
 * now empty) is added to `clear` so the backend unsets the column (#1652). A field the payer left
 * untouched is simply omitted. camelCase to match the form/`UpdatePostingInput`.
 */
export interface PostingEditInitial {
  locationLabel: string | null;
  description: string | null;
  roleKind: string | null;
  city: string | null;
  area: string | null;
  payMin: number | null;
  payMax: number | null;
  payType: string | null;
  minExperienceYears: number | null;
  maxExperienceYears: number | null;
  shift: string | null;
  neededBy: string | null;
  requirements: string[] | null;
  benefits: string[] | null;
}

/** The MATCHABLE half added on the publish variant (draft → open in the SAME patch). */
export interface PostingPublishSelection {
  matchSkillIds: string[];
  untickedRelatedIds: string[];
}

/**
 * The clearable posting fields — MIRRORED from the backend `CLEARABLE_POSTING_FIELDS`
 * (job-postings.dto.ts). Each entry maps the snake_case column to the camelCase key on the
 * form/`UpdatePostingInput` + the seeded `initial`. Every name here is a NULLABLE column, so a
 * `clear` can never reach a NOT NULL one (`role_title`/`vacancy_band`/`status` are absent).
 */
const CLEARABLE_POSTING_FIELDS = [
  ["location_label", "locationLabel"],
  ["description", "description"],
  ["city", "city"],
  ["area", "area"],
  ["pay_min", "payMin"],
  ["pay_max", "payMax"],
  ["pay_type", "payType"],
  ["min_experience_years", "minExperienceYears"],
  ["max_experience_years", "maxExperienceYears"],
  ["shift", "shift"],
  ["needed_by", "neededBy"],
  ["benefits", "benefits"],
  ["requirements", "requirements"],
  ["role_kind", "roleKind"],
] as const;

/** Whether a seeded initial value counts as "present" (so blanking it is a real clear). */
function initialPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * PATCH body for an EMPLOYER posting edit AND/OR publish. Sends the SET fields the payer changed
 * (RAW `vacancies` count, never a band), computes the `clear` array from the diff against
 * `initial` (a field that HAD a value and is now blank), and — on the publish variant — attaches
 * `match_skill_ids` + `unticked_related_ids` + `status:"open"` in the SAME patch so create→publish
 * and edit→publish are one round-trip. NEVER `org_label`/`payer_id`/`created_by` (XB-A). A SET and
 * a CLEAR of the same field can never both happen (a field is cleared ONLY when it is not set).
 */
export function toPayerJobPostingPatchBody(
  input: UpdatePostingInput,
  initial?: PostingEditInitial | null,
  publish?: PostingPublishSelection,
): Record<string, unknown> {
  const body: Record<string, unknown> = { role_title: input.roleTitle };
  if (input.vacancies !== undefined) body.vacancies = input.vacancies; // RAW count — backend re-bands.
  if (input.locationLabel !== undefined) body.location_label = input.locationLabel;
  if (input.description !== undefined) body.description = input.description;
  if (input.roleKind !== undefined) body.role_kind = input.roleKind;
  if (input.city !== undefined) body.city = input.city;
  if (input.area !== undefined) body.area = input.area;
  if (input.payMin !== undefined) body.pay_min = input.payMin;
  if (input.payMax !== undefined) body.pay_max = input.payMax;
  if (input.payType !== undefined) body.pay_type = input.payType;
  if (input.minExperienceYears !== undefined) body.min_experience_years = input.minExperienceYears;
  if (input.maxExperienceYears !== undefined) body.max_experience_years = input.maxExperienceYears;
  if (input.shift !== undefined) body.shift = input.shift;
  if (input.neededBy !== undefined) body.needed_by = input.neededBy;
  if (input.requirements !== undefined) body.requirements = input.requirements;
  if (input.benefits !== undefined) body.benefits = input.benefits;

  // The clear diff: a field the payer BLANKED (present in `initial`, absent from `input`).
  if (initial) {
    const clear: string[] = [];
    for (const [snake, camel] of CLEARABLE_POSTING_FIELDS) {
      const setNow = (input as unknown as Record<string, unknown>)[camel] !== undefined;
      if (!setNow && initialPresent((initial as unknown as Record<string, unknown>)[camel])) clear.push(snake);
    }
    if (clear.length > 0) body.clear = clear; // `.min(1)` server-side — omit an empty list.
  }

  // Publish: the matchable half + the draft→open transition, in ONE patch (Policy 10: NEVER a
  // client `reach_skill_ids` — the server resolves the reach set from these two inputs).
  if (publish) {
    body.match_skill_ids = publish.matchSkillIds;
    body.unticked_related_ids = publish.untickedRelatedIds;
    body.status = "open";
  }
  return body;
}

/**
 * PATCH /payer/job-postings/:id — edit one of the caller's OWN postings (LIVE). Body is the
 * faceless {@link toPayerJobPostingPatchBody} shape (no org_label, never payer_id/created_by).
 * Unknown/not-owned → neutral 404 → `null`. Mapped to the faceless {@link PostingSummary}.
 */
export async function updatePosting(
  postingId: string,
  input: UpdatePostingInput,
  options?: { initial?: PostingEditInitial | null; publish?: PostingPublishSelection },
): Promise<PostingSummary | null> {
  try {
    const wire = await payerFetch(`/payer/job-postings/${postingId}`, {
      method: "PATCH",
      body: toPayerJobPostingPatchBody(input, options?.initial ?? null, options?.publish),
      schema: jobPostingWireSchema,
    });
    return toPostingSummary(wire);
  } catch (e) {
    if (isPayerStatus(e, 404)) return null;
    throw e;
  }
}

/* ── Matching V1 — the posting form's skill surface (ADR-0036) ───────────────── */

/**
 * GET /payer/match/skills — the closed match vocabulary + the curated relation map.
 *
 * PayerAuthGuard-protected but NOT payer-scoped: the vocabulary is the same for every
 * company. It is behind auth because the trade taxonomy and the supply it implies are
 * commercial information about the platform, not public data.
 */
export async function listMatchSkills(): Promise<MatchSkillWire[]> {
  const wire = await payerFetch("/payer/match/skills", { schema: matchSkillListWireSchema });
  return wire.skills;
}

/**
 * POST /payer/match/reach-preview — the live "this posting reaches N workers" figure,
 * shown BEFORE the payer commits (E13: never take money for a posting into a void).
 *
 * A POST that writes nothing: the skill list is a body because it would be an unbounded
 * query string as a GET. It emits no event by design — the decision is evented at
 * publish, by `job_posting.reach_materialized`, with the unticks that were honoured.
 *
 * Reach is a property of WORKER SUPPLY, identical for every payer, so no payer id is
 * sent or needed and there is no tenancy surface here to get wrong.
 */
export async function previewReach(input: MatchSelectionInput): Promise<ReachPreview> {
  return payerFetch("/payer/match/reach-preview", {
    method: "POST",
    body: {
      match_skill_ids: input.matchSkillIds,
      unticked_related_ids: input.untickedRelatedIds,
    },
    schema: reachPreviewWireSchema,
  });
}

/**
 * PATCH /payer/job-postings/:id — attach the match skills and PUBLISH (draft → open).
 *
 * This is the moment ③ trigger: the backend resolves `reach_skill_ids` from the posted
 * skills + the honoured unticks and materializes `job_reach` in one INSERT..SELECT.
 *
 * It sends `match_skill_ids` and `unticked_related_ids` and NEVER a `reach_skill_ids` —
 * the backend has no such input, so a payer cannot widen past the curated relations
 * (Policy 10). Unknown/not-owned → the same neutral 404 → `null`, so publishing another
 * tenant's posting is indistinguishable from publishing one that never existed.
 */
export async function publishPostingWithMatchSkills(
  postingId: string,
  selection: MatchSelectionInput,
): Promise<PostingSummary | null> {
  try {
    const wire = await payerFetch(`/payer/job-postings/${postingId}`, {
      method: "PATCH",
      body: {
        match_skill_ids: selection.matchSkillIds,
        unticked_related_ids: selection.untickedRelatedIds,
        status: "open",
      },
      schema: jobPostingWireSchema,
    });
    return toPostingSummary(wire);
  } catch (e) {
    if (isPayerStatus(e, 404)) return null;
    throw e;
  }
}

/**
 * POST /payer/job-postings/:id/close — close one of the caller's OWN postings (LIVE, terminal:
 * draft|open → closed). The session is the identity (XB-A); the body is empty. Unknown/not-owned
 * → neutral 404 → `null`. Mapped to the faceless {@link PostingSummary}.
 */
export async function closePosting(postingId: string): Promise<PostingSummary | null> {
  try {
    const wire = await payerFetch(`/payer/job-postings/${postingId}/close`, {
      method: "POST",
      body: {},
      schema: jobPostingWireSchema,
    });
    return toPostingSummary(wire);
  } catch (e) {
    if (isPayerStatus(e, 404)) return null;
    throw e;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * LIVE — the FINAL mock seams swapped onto their payer-authed endpoints:
 * masked-resume disclosure (POST /payer/resume-disclosures) + the posting
 * PAUSE/RESUME/quota-top-up lifecycle (#178/#180). The mock store is GONE from
 * this seam — a backend error surfaces as an error, never as fake data.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * POST /payer/resume-disclosures — the identity-MASKED resume for one worker the caller
 * is entitled to (LIVE; resume-disclosure addendum B-C/XB-E). The body carries ONLY
 * `{ worker_id, job_posting_id }` — the payer is the SESSION (XB-A), never a body value.
 * EVERY deny cause (no consent / capped / unknown / no resume / render-unavailable)
 * returns the SAME neutral `{ status: "unavailable" }` (no-oracle); success carries an
 * opaque disclosure id + a short-TTL signed URL to the MASKED PDF. There is NO initials
 * field on the live wire (masking lives inside the artifact) — the card renders a
 * neutral label. No phone, no full name, no deny reason anywhere.
 */
export async function revealMaskedResume(input: {
  unlockId: string;
  workerId: string;
  /** The posting context for the disclosure audit row (optional — null is valid). */
  postingId?: string;
}): Promise<MaskedResumeResult> {
  const wire = await payerFetch("/payer/resume-disclosures", {
    method: "POST",
    body: { worker_id: input.workerId, job_posting_id: input.postingId ?? null },
    schema: maskedResumeWireSchema,
  });
  if ("ok" in wire && wire.ok === true) {
    return maskedResumeResultSchema.parse({
      ok: true,
      disclosureId: wire.disclosure_id,
      status: "disclosed",
      resumeUrl: wire.resume_url,
      expiresAt: wire.expires_at,
    });
  }
  return maskedResumeResultSchema.parse({ status: "unavailable" });
}

/**
 * POST /payer/job-postings/:id/pause — pause one of the caller's OWN LIVE postings
 * (open → paused; LIVE, #178). Session identity only (XB-A); empty body. Unknown OR
 * not-owned → the SAME neutral 404 (no-oracle) → `null`. A 409 (not in `open`)
 * propagates — the action maps it to a retryable error message.
 */
export async function pausePosting(input: { postingId: string }): Promise<PostingSummary | null> {
  try {
    const wire = await payerFetch(`/payer/job-postings/${input.postingId}/pause`, {
      method: "POST",
      body: {},
      schema: jobPostingWireSchema,
    });
    return toPostingSummary(wire);
  } catch (e) {
    if (isPayerStatus(e, 404)) return null;
    throw e;
  }
}

/**
 * POST /payer/job-postings/:id/resume — resume one of the caller's OWN paused postings
 * (paused → open; LIVE, #178). Same neutral-404 → `null` + 409-propagates contract as
 * {@link pausePosting}.
 */
export async function resumePosting(input: { postingId: string }): Promise<PostingSummary | null> {
  try {
    const wire = await payerFetch(`/payer/job-postings/${input.postingId}/resume`, {
      method: "POST",
      body: {},
      schema: jobPostingWireSchema,
    });
    return toPostingSummary(wire);
  } catch (e) {
    if (isPayerStatus(e, 404)) return null;
    throw e;
  }
}

/**
 * POST /payer/job-postings/:id/quota-topup — top up applicant-visibility quota on the
 * caller's OWN ACTIVE PLAN for this posting (LIVE, B2 #180 — "view more → pay more").
 * The body carries the catalog tier CODE the payer CONFIRMED (XT5: the backend re-resolves
 * price + grant through the pricing engine; the client never sends an amount to charge) and,
 * when the payer confirmed one, `expected_price_inr` (#2085). Session identity only (XB-A).
 * Unknown/not-owned → neutral 404 → `null`.
 *
 * THE CONFIRMED OPTION, OR NOTHING (#2085 L1). This seam used to RE-PICK the tier from a fresh
 * catalog at submit, so an ops edit between the dialog and the confirm (a re-sized `topup_10`, or
 * a new same-price tier that became the smallest) bought something other than what the dialog
 * described — and `expected_price_inr` cannot catch a same-price swap. Now the dialog's tier is
 * checked against the live catalog ({@link findQuotaTopUpTier}): if it is gone, unpriced, or no
 * longer adds the slots the payer saw, {@link PurchaseOptionChangedError} is thrown BEFORE any
 * request. Another tier is never substituted.
 *
 * THREE 409s, three answers — told apart by the API's `reason` (#2135), or, from an API before
 * #2135 (no `reason`), by its documented message:
 *  - `price_mismatch` → {@link PriceMismatchError} (nothing bought; the payer re-confirms);
 *  - the in-flight duplicate of an `Idempotency-Key` (#2085, the same seam as capacity) —
 *    `reason: "in_flight"` → {@link PurchaseConflictError} (still processing, outcome unknown —
 *    never re-post);
 *  - no ACTIVE PLAN to top up — `reason: "no_active_plan"` → `QuotaTopUpNoPlanError`, so the
 *    action can say "buy a plan first" without weakening the not-found neutrality.
 * A `reason` outside those is neither: it propagates (the action's retryable failure), never
 * guessed into one of them.
 * The wire returns the topped-up plan `{ plan, quote }`; the fresh posting row is re-read
 * so the action keeps its PostingSummary contract.
 */
export interface QuotaTopUpOutcome {
  /**
   * The fresh posting row when the post-charge re-read succeeded; null when that
   * re-read failed. Either way the top-up itself IS applied — the caller must never
   * message a null posting as a retryable failure (that invites a double purchase).
   */
  posting: PostingSummary | null;
  /** The config'd views this top-up added (catalog tier — display copy only, XT5). */
  addedViews: number;
}

export async function topUpPostingQuota(input: {
  postingId: string;
  /** The tier the payer confirmed: its catalog code and the slots the dialog said it adds. */
  tier: { code: string; additionalViews: number };
  /** The ₹ the payer confirmed for one top-up (#2085). */
  expectedPriceInr?: number;
  /**
   * Optional per-purchase idempotency key (#2085, the capacity seam's semantics): the SAME key
   * across a retry of ONE confirmed top-up makes the backend charge once and replay the first
   * result. Without it a retry after a timeout bought a second top-up.
   */
  idempotencyKey?: string;
}): Promise<QuotaTopUpOutcome | null> {
  // The LIVE catalog (D-6), falling open to the compile-time defaults on fetch failure. It is
  // read only to CHECK the confirmed tier, never to choose one: gone / unpriced / re-sized ⇒
  // refused before any request (nothing bought). The price itself is the API's to check
  // (`expected_price_inr` ⇒ 409 price_mismatch).
  const tier = findQuotaTopUpTier(await getLiveCatalog(), input.tier.code);
  if (tier === null || tier.additionalViews !== input.tier.additionalViews) {
    throw new PurchaseOptionChangedError();
  }
  try {
    await payerFetch(`/payer/job-postings/${input.postingId}/quota-topup`, {
      method: "POST",
      body: { tier: tier.code, ...confirmedPrice(input.expectedPriceInr) },
      idempotencyKey: input.idempotencyKey,
      schema: quotaTopUpWireSchema,
    });
  } catch (e) {
    if (isPayerStatus(e, 404)) return null;
    // The API names the 409 (#2135): the in-flight duplicate vs no active plan.
    if (e instanceof PayerConflictError && e.reason !== null) {
      if (e.reason === IN_FLIGHT_REASON) throw new PurchaseConflictError();
      if (e.reason === QUOTA_TOPUP_NO_PLAN_REASON) throw new QuotaTopUpNoPlanError();
      throw e; // a reason this seam does not know — never guessed into either answer.
    }
    // An API before #2135 names no reason: the in-flight duplicate is told apart from "no active
    // plan" by its documented message (payer-agency-api-reference.md).
    if (e instanceof PayerConflictError && QUOTA_TOPUP_IN_FLIGHT.test(e.detail ?? "")) {
      throw new PurchaseConflictError();
    }
    if (isPayerStatus(e, 409)) {
      throw new QuotaTopUpNoPlanError();
    }
    throw e; // incl. PriceMismatchError — the action tells the payer the new price.
  }
  // The charge is COMMITTED past this line (payment + quota events emitted server-side).
  // A transient failure on the fresh-row re-read must NOT propagate as an error — the
  // action would say "retry" and a retry would buy a SECOND top-up. Degrade to null.
  try {
    return { posting: await getPosting(input.postingId), addedViews: tier.additionalViews };
  } catch {
    return { posting: null, addedViews: tier.additionalViews };
  }
}

/**
 * The quota top-up's in-flight 409 message (#2085): "This quota top-up is already being
 * processed; check the posting before trying again". The FALLBACK for an API before #2135, whose
 * 409 names no `reason`: matched on its stable phrase; a reworded message degrades to the
 * no-active-plan answer, which is what every 409 here meant before.
 */
const QUOTA_TOPUP_IN_FLIGHT = /already being processed/i;

/** The quota top-up's "no active plan" 409 `reason` (#2135). */
const QUOTA_TOPUP_NO_PLAN_REASON = "no_active_plan";

/** 409 from quota-topup: the posting has no ACTIVE PLAN to top up (buy a plan first). */
export class QuotaTopUpNoPlanError extends Error {
  constructor() {
    super("no active plan to top up");
    this.name = "QuotaTopUpNoPlanError";
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * LIVE — AI JOB-POSTING CHAT (ADR-0035), the five payer-authed endpoints.
 *
 * A conversational FRONT DOOR onto the UNCHANGED job-posting create path: the chat
 * builds a `JobPostingDraft`, and publish validates it against the same
 * `PayerCreateJobPostingSchema` the manual form uses and calls the same
 * `JobPostingsService.createForPayer` (which already emits `job_posting.created`).
 *
 * TENANCY (XB-A): every call rides `payerFetch` → the httpOnly-cookie Bearer. NO request
 * body here carries a `payer_id`; the message body is EXACTLY `{ session_id, text }`, and
 * session-start / publish send `{}`. The token never reaches client JS (server-only module).
 *
 * ORG NAME (ADR-0035 §Decision 3 / rule A): this seam NEVER sends the payer's company/org
 * name — unlike {@link createPosting}, publish sends NO `org_label`. The server auto-fills it
 * from `payers.orgNameEnc` post-hoc, so it never crosses the LLM boundary.
 *
 * NEUTRALITY: an unknown OR not-owned session id returns the SAME neutral 404 (the #349
 * no-oracle transcript-hydration pattern) → mapped to `null`, exactly like {@link getPosting}.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Map the shared neutral-404 contract to `null` (no cross-tenant existence oracle). */
function nullOnNeutral404<T>(e: unknown): T | null {
  if (isPayerStatus(e, 404)) return null;
  throw e;
}

/**
 * POST /payer/job-posting-chat/session — start a chat for the SESSION payer (XB-A).
 * The body is empty: there is no payer id and no org name to send (rule A).
 */
export async function startJobPostingChatSession(): Promise<JobPostingChatTurn> {
  const wire = await payerFetch("/payer/job-posting-chat/session", {
    method: "POST",
    body: {},
    schema: jobPostingChatTurnWireSchema,
  });
  return toJobPostingChatTurn(wire);
}

/**
 * POST /payer/job-posting-chat/message — one payer turn → the next engine turn.
 * The body is EXACTLY `{ session_id, text }` (the frozen contract) — never a payer id,
 * never an org label. An unknown/not-owned session → neutral 404 → `null`.
 */
export async function sendJobPostingChatMessage(input: {
  sessionId: string;
  text: string;
}): Promise<JobPostingChatTurn | null> {
  try {
    const wire = await payerFetch("/payer/job-posting-chat/message", {
      method: "POST",
      body: { session_id: input.sessionId, text: input.text },
      schema: jobPostingChatTurnWireSchema,
    });
    return toJobPostingChatTurn(wire);
  } catch (e) {
    return nullOnNeutral404<JobPostingChatTurn>(e);
  }
}

/**
 * GET /payer/job-posting-chat/sessions — the caller's OWN chat sessions (LIVE).
 *
 * The CROSS-DEVICE pickup point: because ownership is the payer ACCOUNT (not a device or
 * browser session), a chat started in the Flutter payer app appears here on the web and
 * can be resumed by hydrating its transcript. Newest activity first.
 */
export async function getJobPostingChatSessions(): Promise<JobPostingChatSessionSummary[]> {
  const wire = await payerFetch("/payer/job-posting-chat/sessions", {
    schema: jobPostingChatSessionListWireSchema,
  });
  const sessions = toJobPostingChatSessions(wire);
  return sessions.sort((a, b) => {
    const at = a.lastMessageAt ?? a.startedAt;
    const bt = b.lastMessageAt ?? b.startedAt;
    return bt.localeCompare(at);
  });
}

/**
 * GET /payer/job-posting-chat/sessions/:id/messages — hydrate one session's full transcript
 * (the resume path). Unknown OR not-owned → the SAME neutral 404 → `null`.
 */
export async function getJobPostingChatTranscript(
  sessionId: string,
): Promise<JobPostingChatTranscript | null> {
  try {
    const wire = await payerFetch(`/payer/job-posting-chat/sessions/${sessionId}/messages`, {
      schema: jobPostingChatTranscriptWireSchema,
    });
    return toJobPostingChatTranscript(wire);
  } catch (e) {
    return nullOnNeutral404<JobPostingChatTranscript>(e);
  }
}

/**
 * POST /payer/job-posting-chat/sessions/:id/publish — turn the session's draft into the REAL
 * job posting. The body is EMPTY: the draft already lives server-side on the session row, the
 * payer is the session (XB-A), and the org name is auto-filled server-side (rule A). Returns
 * the created posting's id so the caller routes to its EXISTING detail page.
 *
 * A 409 (draft not ready / already published) surfaces as a thrown error the action turns into
 * retryable copy; unknown/not-owned stays the neutral 404 → `null`.
 */
export async function publishJobPostingChatSession(
  sessionId: string,
): Promise<JobPostingChatPublishResult | null> {
  try {
    const wire = await payerFetch(`/payer/job-posting-chat/sessions/${sessionId}/publish`, {
      method: "POST",
      body: {},
      schema: jobPostingChatPublishWireSchema,
    });
    return {
      jobPostingId: wire.job_posting_id,
      // #1727 — pass both gap reports through. They died here before: the
      // mapper returned the id alone, so the server's honesty about what the
      // posting is missing never reached a screen.
      unsetCardFields: wire.unset_card_fields ?? [],
      unmappedFields: wire.unmapped_fields ?? [],
    };
  } catch (e) {
    return nullOnNeutral404<JobPostingChatPublishResult>(e);
  }
}
