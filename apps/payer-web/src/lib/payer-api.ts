import "server-only";
import { requirePayer } from "./auth";
import {
  agencyInviteWireSchema,
  agencyJobListWireSchema,
  agencyJobWireSchema,
  agencyReferralsSummaryWireSchema,
  applicantFeedSchema,
  buyCapacityWireSchema,
  buyPackResultWireSchema,
  capacitySchema,
  creditsWireSchema,
  jobPostingListWireSchema,
  jobPostingWireSchema,
  maskedResumeResultSchema,
  payerCapacityWireSchema,
  payerMeWireSchema,
  postingQuotaResultSchema,
  postingSummarySchema,
  quotaTopUpResultWireSchema,
  reachApplicantListWireSchema,
  topUpResultSchema,
  unlockResultSchema,
  unlockResultWireSchema,
  unlocksListWireSchema,
  type AgencyAccount,
  type AgencyJob,
  type AgencyJobInput,
  type AgencyReferralsSummary,
  type ApplicantFeed,
  type Capacity,
  type CreatePostingInput,
  type CreditBalance,
  type CreditTopUp,
  type Dashboard,
  type FacelessApplicant,
  type MaskedResumeResult,
  type PostingQuotaResult,
  type PostingSummary,
  type RevealResult,
  type TopUpResult,
  type UnlockHistoryItem,
  type UnlockResult,
} from "./contracts";
import { revealResultSchema } from "./contracts";
import { assertNoAgencyPII } from "./assert-no-agency-pii";
import * as store from "./mock-store";
import { payerFetch } from "./payer-http";
import { findCreditPack } from "./pricing-config";

/**
 * The PAYER DATA SEAM (ADR-0019 Phase 1).
 *
 * The SINGLE boundary the pages/actions call. Each function either:
 *  - LIVE: calls a payer-AUTHED backend endpoint via {@link payerFetch} (the payer
 *    JWT carries the tenant identity; NO client `payer_id` is ever sent — XB-A), or
 *  - WAITING (clearly flagged): serves from the mock store because NO payer-authed
 *    endpoint exists yet — see the per-function notes + the REPORT escalation list.
 *
 * Tenancy (XB-A): the payer is ALWAYS the server-held session. LIVE calls derive it
 * from the Bearer token; mock calls pass the session `payerId` (never a client value).
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
  return wire.unlocks.map((u) => ({
    unlockId: u.unlock_id,
    workerId: u.worker_id,
    // The UI history shows granted vs expired; a revealed/revoked grant maps to its
    // nearest user-facing state (no-oracle: cause is never surfaced beyond this).
    status: u.status === "granted" || u.status === "revealed" ? "granted" : "expired",
    createdAt: u.created_at,
    expiresAt: u.expires_at ?? u.created_at,
  }));
}

/**
 * Dashboard = LIVE credits + LIVE unlocks + LIVE postings. ALL three are now payer-authed
 * reads (the job-postings list moved off the mock store onto GET /payer/job-postings), so the
 * dashboard and the /postings list share ONE source of truth — a posting created via the live
 * POST appears on both. Fetched concurrently; each derives the session payer itself (XB-A).
 */
export async function getDashboard(): Promise<Dashboard> {
  const [credits, unlocks, postings] = await Promise.all([getCredits(), getUnlocks(), getPostings()]);
  return { credits, unlocks, postings };
}

/**
 * GET /payer/reach/jobs/:jobId/applicants — the FACELESS ranked candidate list for a
 * job the caller OWNS (LIVE). A job that isn't the payer's returns the SAME neutral
 * 404 as an unknown one (no-oracle) → we map that to `null` and the page renders a
 * neutral not-found. The payer-authed reach projection returns RANKING signals
 * (rank/score/hot/components) PLUS coarse, PII-free banded taxonomy chips
 * (experience/trade/city) which we surface as faceless relevance labels. `skills` is
 * not in the projection yet (stays unset). PII-free either way (XB-C).
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
    if (e instanceof Error && /returned 404/.test(e.message)) return null;
    throw e;
  }
  const applicants: FacelessApplicant[] = wire.applicants.map((a) => ({
    workerId: a.workerId,
    rank: a.rank,
    score: a.score,
    hot: a.hot,
    // Score-component reasons as faceless relevance chips (PII-free). The reach DTO's
    // components are explainable signal reasons; surface only their `reason` strings.
    signals: a.components
      .map((c) =>
        typeof c === "object" && c && "reason" in c
          ? String((c as { reason: unknown }).reason)
          : "",
      )
      .filter((s): s is string => s.length > 0)
      .slice(0, 8),
    // Coarse faceless taxonomy bands (PII-free). Backend may send `null` (no signal);
    // map to `undefined` so the optional UI fields stay clean.
    experienceBand: a.experienceBand ?? undefined,
    tradeLabel: a.tradeLabel ?? undefined,
    cityLabel: a.cityLabel ?? undefined,
  }));
  return applicantFeedSchema.parse({
    postingId: wire.jobId,
    // The reach endpoint does not return a role title; the page falls back to a label.
    roleTitle: "Ranked candidates",
    applicants,
  });
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
 * POST /payer/credits — buy a credit pack for the caller (LIVE). The body carries ONLY
 * `{ pack_code }`; the payer is the session token and the server resolves price +
 * credits from config (XB-A — NO payer_id, NO price, NO credits is ever sent). The
 * backend (`PayerUnlocksController.buyPack`, @HttpCode(201)) returns
 * `{ payer_id, balance, credits, pack_code }`, mapped onto {@link TopUpResult}.
 *
 * MONEY IS MOCK: `realCall` stays false — the backend mock-purchases (real_call:false);
 * there is NO Razorpay anywhere in this app. An UNKNOWN pack is a real backend 404 (a
 * public catalog item, not a tenant oracle) → surfaced as a neutral `null` not-found.
 */
export async function topUp(input: { packCode: string }): Promise<TopUpResult | null> {
  let wire: ReturnType<typeof buyPackResultWireSchema.parse>;
  try {
    wire = await payerFetch("/payer/credits", {
      method: "POST",
      body: { pack_code: input.packCode }, // XB-A: pack CODE ONLY — no payer_id/price/credits.
      schema: buyPackResultWireSchema,
    });
  } catch (e) {
    // An unknown pack returns a real 404 (catalog item, not a per-tenant resource) →
    // a neutral not-found, NOT an error state. Anything else propagates.
    if (e instanceof Error && /returned 404/.test(e.message)) return null;
    throw e;
  }
  // Record the successful (mock) purchase on the caller's OWN mock ledger so the credits
  // page can show a top-up history + a 12-month expiry schedule. The authoritative balance
  // stays the live backend; this is a PII-free local history record. `priceInr` is resolved
  // from the @badabhai/pricing catalog (XT5: server-side amount, never client-supplied).
  const { payerId } = await requirePayer();
  store.recordTopUp(payerId, {
    packCode: wire.pack_code,
    credits: wire.credits,
    priceInr: findCreditPack(wire.pack_code)?.priceInr ?? 0,
  });
  return topUpResultSchema.parse({
    payerId: wire.payer_id,
    balance: wire.balance,
    creditsAdded: wire.credits,
    packCode: wire.pack_code,
    realCall: false, // MOCK money — the backend mock-purchases; there is NO Razorpay.
  });
}

/**
 * The caller's OWN mock-ledger credit top-ups (newest first) — the top-up half of the
 * credit history + the source of the 12-month expiry schedule. Tenancy is the server-held
 * session (XB-A); PII-free (ids/amounts/config pack code only). WAITING-mock: there is no
 * payer-authed credit-ledger endpoint, so this reads the local ledger recorded on top-up.
 */
export async function getCreditTopUps(): Promise<CreditTopUp[]> {
  const { payerId } = await requirePayer();
  return store.getTopUps(payerId);
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
  // The applicant QUOTA lives on the posting's PLAN row (applicantVisibilityQuota + quotaTopupCount),
  // NOT on the job-posting projection — and there is no BULK plan read, so this list-level column
  // shows 0 until a per-plan read exists (ESCALATE: a payer-authed GET /payer/job-postings/:id/plan).
  // The REAL quota IS surfaced on the posting-detail top-up flow (topUpPostingQuota → PostingQuotaResult).
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
 * The body carries ONLY the tier CODE: NEVER a payer_id (XB-A — the session token is the
 * identity) and NEVER a price/amount/quota (XT5 — the server prices it via the pricing
 * engine). The backend RAISES the allowance and auto-resumes paused plans up to it, then
 * returns `{ payer_id, quote, max_active_vacancies, source_tier, expires_at, resumed_plan_ids }`.
 *
 * Mapped onto a typed {@link BuyCapacityResult}: only ids/counts/tier/timestamps are
 * surfaced — the server-priced `quote` is parsed permissively and NEVER echoed (XT5). On any
 * thrown/!ok path a NEUTRAL `{ ok:false }` is returned (no leaked reason). FACELESS by
 * construction: the payload is opaque ids/counts/tier/timestamps only, so this does NOT wrap
 * `assertNoAgencyPII` (capacity is an employer surface) — and it NEVER echoes an un-crossed
 * fetched object.
 */
export async function buyCapacity({ tier }: { tier: string }): Promise<BuyCapacityResult> {
  try {
    const wire = await payerFetch("/payer/capacity", {
      method: "POST",
      body: { tier }, // XB-A: tier CODE ONLY — no payer_id; XT5: no price/amount/quota.
      schema: buyCapacityWireSchema,
    });
    return {
      ok: true,
      allowance: wire.max_active_vacancies,
      sourceTier: wire.source_tier,
      expiresAt: wire.expires_at,
      resumedPlanIds: wire.resumed_plan_ids,
    };
  } catch {
    // Neutral failure — no leaked deny reason / role state (no-oracle); never a fake success.
    return { ok: false, error: "Capacity upgrade failed (service unavailable). Please retry." };
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
 * `posting_plans` WAITING mock below (that stays escalated, untouched).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Map the camelCase UI input to the backend's snake_case agency-job body. */
function toAgencyJobBody(input: AgencyJobInput): Record<string, unknown> {
  return {
    trade_key: input.tradeKey,
    title: input.title,
    city: input.city,
    area: input.area,
    pay_min: input.payMin,
    pay_max: input.payMax,
    min_experience_years: input.minExperienceYears,
    max_experience_years: input.maxExperienceYears,
    needed_by: input.neededBy,
  };
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
    if (e instanceof Error && /returned 404/.test(e.message)) return null;
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
): Promise<AgencyJob | null> {
  try {
    const wire = await payerFetch(`/payer/agency/jobs/${jobId}`, {
      method: "PATCH",
      body: toAgencyJobBody(input),
      schema: agencyJobWireSchema,
    });
    return assertNoAgencyPII(wire, "payer/agency/jobs/:id (update)");
  } catch (e) {
    if (e instanceof Error && /returned 404/.test(e.message)) return null;
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
    if (e instanceof Error && /returned 404/.test(e.message)) return null;
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
    if (e instanceof Error && /returned 404/.test(e.message)) return null;
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
export async function createAgencyInvite(input: {
  campaign?: string;
}): Promise<CreateAgencyInviteResult> {
  const body: Record<string, unknown> = {};
  if (input.campaign) body.campaign = input.campaign;
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
    if (e instanceof Error && /returned 429/.test(e.message)) return { ok: false };
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
 * the backend's IDENTICAL neutral 404 → `null` (no-oracle). The lifecycle PAUSE/RESUME/
 * quota-top-up surfaces stay MOCK below (no payer-authed route yet).
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Map a LIVE job-posting wire row → the faceless {@link PostingSummary} the pages consume.
 * DEFENCE-IN-DEPTH (invariant #2): the wire row carries the payer's OWN `orgLabel`/`description`
 * + `payerId`/`createdBy` (their own ids) — none of which any page needs, so they are DROPPED
 * here and never reach the UI domain object. `applicantCount` is 0 and `applicantQuota` is
 * omitted: NEITHER is in the job-posting projection (the applicant count is the separate faceless
 * reach feed's concern; the quota was a mock-only config stamp). `vacancyBand` is the backend
 * band string, surfaced as-is (postingSummarySchema.vacancyBand is a plain string).
 */
function toPostingSummary(wire: ReturnType<typeof jobPostingWireSchema.parse>): PostingSummary {
  return postingSummarySchema.parse({
    id: wire.id,
    roleTitle: wire.roleTitle,
    locationLabel: wire.locationLabel,
    vacancyBand: wire.vacancyBand,
    status: wire.status,
    applicantCount: 0, // NOT in this projection — the count is the reach feed's, not the row's.
    createdAt: wire.createdAt,
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
 *   - trade/pay/exp are NOT included: `PayerCreateJobPostingSchema` does not accept them yet
 *     (collected for demand parity, validated client+server, withheld until the schema grows).
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
  if (input.locationLabel !== undefined) body.location_label = input.locationLabel;
  if (input.description !== undefined) body.description = input.description;
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
    if (e instanceof Error && /returned 404/.test(e.message)) return null;
    throw e;
  }
}

/**
 * PATCH body for an EMPLOYER posting edit — the faceless demand fields ONLY. UNLIKE create it
 * sends NO `org_label` (the session identity is not edited) and NEVER payer_id/created_by; it
 * sends the RAW `vacancies` count (at most one of vacancy_band|vacancies — the backend derives
 * its band and discards the integer). Pure + exported so the wire contract is unit-pinned, the
 * sibling of {@link toPayerJobPostingBody}. Optional labels are omitted when absent.
 */
export function toPayerJobPostingPatchBody(input: CreatePostingInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    role_title: input.roleTitle,
    vacancies: input.vacancies, // RAW count — the backend derives its own band.
  };
  if (input.locationLabel !== undefined) body.location_label = input.locationLabel;
  if (input.description !== undefined) body.description = input.description;
  return body;
}

/**
 * PATCH /payer/job-postings/:id — edit one of the caller's OWN postings (LIVE). Body is the
 * faceless {@link toPayerJobPostingPatchBody} shape (no org_label, never payer_id/created_by).
 * Unknown/not-owned → neutral 404 → `null`. Mapped to the faceless {@link PostingSummary}.
 */
export async function updatePosting(
  postingId: string,
  input: CreatePostingInput,
): Promise<PostingSummary | null> {
  try {
    const wire = await payerFetch(`/payer/job-postings/${postingId}`, {
      method: "PATCH",
      body: toPayerJobPostingPatchBody(input),
      schema: jobPostingWireSchema,
    });
    return toPostingSummary(wire);
  } catch (e) {
    if (e instanceof Error && /returned 404/.test(e.message)) return null;
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
    if (e instanceof Error && /returned 404/.test(e.message)) return null;
    throw e;
  }
}

/**
 * POST /payer/job-postings/:id/quota-topup — buy additional applicant-visibility views on the
 * caller's OWN active plan for this posting (B2 / #180, LIVE). "View more → pay more": the body
 * carries ONLY `{ tier, coupon? }` (a config'd top-up tier CODE — never a client/hardcoded
 * amount); the posting `:id` rides the PATH and the payer is the SESSION token (XB-A — there is
 * nowhere to put a payer_id; XT5 — the server prices it through the pricing engine).
 *
 * SURFACES THE REAL QUOTA: the response's plan row carries the REAL raised cap
 * (`applicantVisibilityQuota + quotaTopupCount`) + `applicantsViewedCount`, mapped onto the
 * faceless {@link PostingQuotaResult} — the counter the UI shows is the live value, not a mock.
 *
 * Money is MOCK (real_call:false; there is NO Razorpay). A foreign/unknown posting returns the
 * SAME neutral 404 (no-oracle) and a posting with no active plan to top up returns a 409 — BOTH
 * map to a neutral `null` so the UI shows a neutral not-available (never a cross-tenant oracle).
 */
export async function topUpPostingQuota(input: {
  postingId: string;
  tier: string;
  coupon?: string;
}): Promise<PostingQuotaResult | null> {
  const body: Record<string, unknown> = { tier: input.tier }; // XB-A: tier CODE only — no payer_id.
  if (input.coupon) body.coupon = input.coupon; // XT5: server prices it; the client sends no amount.
  let wire: ReturnType<typeof quotaTopUpResultWireSchema.parse>;
  try {
    wire = await payerFetch(`/payer/job-postings/${input.postingId}/quota-topup`, {
      method: "POST",
      body,
      schema: quotaTopUpResultWireSchema,
    });
  } catch (e) {
    // 404 = unknown/foreign posting (no-oracle); 409 = no active plan to top up. BOTH are a
    // neutral "not available" — never a leaked reason / cross-tenant existence oracle.
    if (e instanceof Error && /returned (404|409)/.test(e.message)) return null;
    throw e;
  }
  return postingQuotaResultSchema.parse({
    postingId: wire.plan.jobPostingId,
    planId: wire.plan.id,
    // REAL effective cap = immutable receipt quota + accumulated top-ups (never a mock stamp).
    applicantQuota: wire.plan.applicantVisibilityQuota + wire.plan.quotaTopupCount,
    applicantsUsed: wire.plan.applicantsViewedCount,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * WAITING — clearly-seamed MOCK shims. NO payer-authed endpoint exists yet.
 * ESCALATE to backend (see REPORT). Tenancy still server-held (XB-A). These are the
 * masked-resume disclosure + the posting PAUSE/RESUME lifecycle — kept MOCK on purpose
 * (the backend job-postings lifecycle has no `paused` state; ADR-0016 pause/resume is
 * capacity-driven, not a payer action). (createPosting / getPostings / getPosting /
 * updatePosting / closePosting + topUp + getCapacity + quota-top-up are now LIVE above.)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * WAITING (mock): MASKED resume disclosure. The backend `resume-disclosures` route is
 * InternalServiceGuard (NO payer-authed disclosure endpoint), so this stays a mock
 * shim. The LIVE reveal above already returns the routed CONTACT handle; the masked
 * RESUME is a separate surface. ESCALATE: payer-authed POST /payer/resume-disclosures.
 *
 * The masked initials are MOCK-derived from the opaque worker id (no real name is read
 * anywhere in this app). No phone, no full name in the artifact.
 */
export async function revealMaskedResume(input: {
  unlockId: string;
  workerId: string;
}): Promise<MaskedResumeResult> {
  await requirePayer();
  const initials = mockMaskedInitials(input.workerId);
  return maskedResumeResultSchema.parse({
    ok: true,
    disclosureId: input.unlockId,
    status: "disclosed",
    displayInitials: initials,
    resumeUrl: `https://staging.badabhai.example/masked-resume/${input.unlockId}.pdf`,
    expiresAt: new Date(Date.now() + 14 * 86400_000).toISOString(),
  });
}

/**
 * WAITING (mock): PAUSE one of the payer's OWN postings (open → paused). The LIVE
 * `PATCH /payer/job-postings/:id` only PUBLISHES (draft → open) and the backend lifecycle
 * has NO `paused` state, so there is no live route for this — kept on the mock store.
 * Tenancy (XB-A): the payerId is the SERVER-HELD session, never client input. A posting
 * that isn't the caller's returns null ⇒ a NEUTRAL not-found.
 *
 * // LIVE-SWAP BLOCKED: no payer-authed company pause/resume/quota route yet (ask Divyanshu)
 */
export async function pausePosting(input: { postingId: string }): Promise<PostingSummary | null> {
  const { payerId } = await requirePayer();
  const updated = store.pausePosting(payerId, input.postingId);
  return updated ? postingSummarySchema.parse(updated) : null;
}

/**
 * WAITING (mock): RESUME one of the payer's OWN postings (paused → open). Same missing
 * route as pause (no `paused` state on the backend lifecycle). Tenancy server-held (XB-A);
 * not-owned → null.
 *
 * // LIVE-SWAP BLOCKED: no payer-authed company pause/resume/quota route yet (ask Divyanshu)
 */
export async function resumePosting(input: { postingId: string }): Promise<PostingSummary | null> {
  const { payerId } = await requirePayer();
  const updated = store.resumePosting(payerId, input.postingId);
  return updated ? postingSummarySchema.parse(updated) : null;
}

/**
 * Deterministic PII-FREE mock masked initials from an opaque id ("R***** K.") — never
 * a real name (there is none in this app). Used only by the WAITING masked-resume shim.
 */
function mockMaskedInitials(workerId: string): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const hex = workerId.replace(/-/g, "");
  const first = letters[parseInt(hex.slice(0, 2), 16) % 26]!;
  const last = letters[parseInt(hex.slice(2, 4), 16) % 26]!;
  return `${first}***** ${last}.`;
}
