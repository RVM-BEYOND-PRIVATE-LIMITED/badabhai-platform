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
  maskedResumeResultSchema,
  payerCapacityWireSchema,
  payerMeWireSchema,
  postingSummarySchema,
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
  return {
    role: me.role,
    status: me.status,
    displayLabel: me.orgName.trim() || (me.role === "agent" ? "Your agency" : "Your company"),
  };
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
 * Dashboard = LIVE credits + LIVE unlocks + (WAITING) mock postings. Postings stay
 * mock until a payer-authed job-postings endpoint lands (ESCALATE: posting-plans is
 * InternalServiceGuard). The two LIVE reads are fetched concurrently.
 */
export async function getDashboard(): Promise<Dashboard> {
  const { payerId } = await requirePayer();
  const [credits, unlocks] = await Promise.all([getCredits(), getUnlocks()]);
  return {
    credits,
    unlocks,
    postings: store.getPostings(payerId), // WAITING — mock (no payer-authed endpoint).
  };
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
 * `activeVacancies` is now the REAL `active_plan_count` (the enforcement engine's count),
 * NOT a count off the mock store — so the at-capacity signal (activeVacancies >= allowance)
 * is faithful. The per-posting applicant-quota ROWS remain backend-seeded MOCK rows from
 * the session-scoped store (no payer-authed create-posting / quota endpoint yet); they are
 * DISPLAY-only and do NOT drive the count (the capacity page note says so). All counts/codes;
 * NO raw worker/payer PII.
 */
export async function getCapacity(): Promise<Capacity> {
  const { payerId } = await requirePayer();
  const wire = await payerFetch("/payer/capacity", { schema: payerCapacityWireSchema });

  // Per-posting rows are WAITING-mock (no payer-authed create-posting / quota endpoint).
  // They are DISPLAY-only and do NOT drive `activeVacancies` (which is the REAL count below).
  const postings = store.getPostings(payerId);
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
 * WAITING — clearly-seamed MOCK shims. NO payer-authed endpoint exists yet.
 * ESCALATE to backend (see REPORT). Tenancy still server-held (XB-A).
 * These are createPosting / getPostings / pausePosting / resumePosting /
 * topUpPostingQuota / revealMaskedResume — kept MOCK on purpose (no payer-authed
 * endpoint). topUp + getCapacity are now LIVE (above).
 * ──────────────────────────────────────────────────────────────────────────── */

/** WAITING (mock): payer-authed job-postings list. ESCALATE: GET /payer/job-postings. */
export async function getPostings(): Promise<PostingSummary[]> {
  const { payerId } = await requirePayer();
  return store.getPostings(payerId).map((p) => p);
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
 * WAITING (mock): job CREATE. A payer-authed `POST /payer/job-postings` NOW EXISTS
 * (`PayerJobPostingsController`, `PayerCreateJobPostingSchema`), but the posting LIST /
 * pause / resume / quota-top-up surfaces are still mock (no payer-authed endpoints), and
 * the dashboard reads the mock store — so flipping ONLY create to live would split the
 * source of truth (a new live posting would not appear in the mock-backed list). Create
 * therefore stays mock until the whole posting read/write path is migrated together. The
 * band→quota stamp lives in the store (config-driven, never hardcoded).
 *
 * At the live swap this becomes a single `payerFetch("/payer/job-postings", { method: "POST",
 * body: toPayerJobPostingBody(input, <session orgName>), ... })` — the body shape is already
 * pinned by {@link toPayerJobPostingBody} (org_label from session; exactly one of
 * vacancy_band|vacancies via the raw count; never payer_id/created_by).
 */
export async function createPosting(input: CreatePostingInput): Promise<PostingSummary> {
  const { payerId } = await requirePayer();
  return store.createPosting(payerId, {
    roleTitle: input.roleTitle,
    locationLabel: input.locationLabel,
    vacancies: input.vacancies, // RAW count → store derives the local band for quota.
  });
}

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
 * WAITING (mock): PAUSE one of the payer's OWN postings. `posting-plans.controller`
 * is InternalServiceGuard ("No PayerAuthGuard in alpha"), so there is NO payer-authed
 * lifecycle endpoint. ESCALATE: backend needs payer-authed
 * `PATCH /payer/job-postings/:id` (or `POST /payer/job-postings/:id/pause`).
 * Tenancy (XB-A): the payerId is the SERVER-HELD session, never client input. A
 * posting that isn't the caller's returns null ⇒ a NEUTRAL not-found.
 */
export async function pausePosting(input: { postingId: string }): Promise<PostingSummary | null> {
  const { payerId } = await requirePayer();
  const updated = store.pausePosting(payerId, input.postingId);
  return updated ? postingSummarySchema.parse(updated) : null;
}

/**
 * WAITING (mock): RESUME one of the payer's OWN postings. Same missing endpoint as
 * pause. ESCALATE: payer-authed `PATCH /payer/job-postings/:id` (or
 * `POST /payer/job-postings/:id/resume`). Tenancy server-held (XB-A); not-owned → null.
 */
export async function resumePosting(input: { postingId: string }): Promise<PostingSummary | null> {
  const { payerId } = await requirePayer();
  const updated = store.resumePosting(payerId, input.postingId);
  return updated ? postingSummarySchema.parse(updated) : null;
}

/**
 * WAITING (mock): TOP-UP a posting's applicant quota by ONE CONFIG'd step (catalog
 * posting-quota tier; never a client/hardcoded amount — "view more → pay more"). The
 * `resume-disclosures` / `posting-plans` controllers are InternalServiceGuard, so no
 * payer-authed quota endpoint exists. ESCALATE: payer-authed
 * `POST /payer/job-postings/:id/quota-top-up`. Tenancy server-held (XB-A); the step
 * is resolved by code from config (XT5-style server-side amount), not a client value.
 */
export async function topUpPostingQuota(input: {
  postingId: string;
}): Promise<PostingSummary | null> {
  const { payerId } = await requirePayer();
  const updated = store.topUpPostingQuota(payerId, input.postingId);
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
