import "server-only";
import { requirePayer } from "./auth";
import {
  applicantFeedSchema,
  capacitySchema,
  creditsWireSchema,
  maskedResumeResultSchema,
  postingSummarySchema,
  reachApplicantListWireSchema,
  topUpResultSchema,
  unlockResultSchema,
  unlockResultWireSchema,
  unlocksListWireSchema,
  type ApplicantFeed,
  type Capacity,
  type CreatePostingInput,
  type CreditBalance,
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
import * as store from "./mock-store";
import { payerFetch } from "./payer-http";
import { baselineActiveVacancyAllowance, findCreditPack } from "./pricing-config";

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
 * neutral not-found. The payer-authed reach projection returns RANKING signals only
 * (rank/score/hot/components) — the banded taxonomy labels (trade/city/experience/
 * skills) are NOT yet in this projection (ESCALATE). PII-free either way (XB-C).
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

/* ────────────────────────────────────────────────────────────────────────────
 * WAITING — clearly-seamed MOCK shims. NO payer-authed endpoint exists yet.
 * ESCALATE to backend (see REPORT). Tenancy still server-held (XB-A).
 * ──────────────────────────────────────────────────────────────────────────── */

/** WAITING (mock): payer-authed job-postings list. ESCALATE: GET /payer/job-postings. */
export async function getPostings(): Promise<PostingSummary[]> {
  const { payerId } = await requirePayer();
  return store.getPostings(payerId).map((p) => p);
}

/**
 * WAITING (mock): job CREATE. `posting-plans.controller` is InternalServiceGuard
 * ("No PayerAuthGuard in alpha") — there is NO payer-authed create endpoint.
 * ESCALATE: backend needs payer-authed POST /payer/job-postings.
 */
export async function createPosting(input: CreatePostingInput): Promise<PostingSummary> {
  const { payerId } = await requirePayer();
  return store.createPosting(payerId, {
    roleTitle: input.roleTitle,
    locationLabel: input.locationLabel,
    vacancyBand: input.vacancyBand,
  });
}

/**
 * WAITING (mock): credit pack PURCHASE / top-up. Only `POST /payers/:payerId/credits`
 * (InternalServiceGuard) exists; the payer side has `GET /payer/credits` (read) only.
 * MOCK ledger only (R17 / XT5): the pack is resolved from CONFIG by code (never a
 * client amount); `realCall` is always false; there is NO Razorpay code.
 * ESCALATE: backend needs a payer-authed buy-pack endpoint.
 */
export async function topUp(input: { packCode: string }): Promise<TopUpResult | null> {
  const { payerId } = await requirePayer();
  const pack = findCreditPack(input.packCode);
  if (!pack) return null;
  const balance = store.addCredits(payerId, pack.credits);
  return topUpResultSchema.parse({
    payerId,
    balance,
    creditsAdded: pack.credits,
    packCode: pack.code,
    realCall: false,
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
 * WAITING (mock): the payer's CAPACITY usage (concurrent active-vacancy allowance +
 * per-posting applicant-quota usage). `capacity.controller` is InternalServiceGuard
 * (the `payers/:payerId/capacity` route takes payer_id from the path, not a payer
 * JWT), so there is NO payer-authed capacity endpoint. ESCALATE: backend needs a
 * payer-authed `GET /payer/capacity`.
 *
 * Tenancy (XB-A): derived ONLY from the server-held session's postings. The allowance
 * is config-derived (baseline catalog capacity tier), never a hardcoded headcount. All
 * counts; NO raw worker/payer PII.
 */
export async function getCapacity(): Promise<Capacity> {
  const { payerId } = await requirePayer();
  const postings = store.getPostings(payerId);
  const rows = postings.map((p) => ({
    postingId: p.id,
    roleTitle: p.roleTitle,
    status: p.status,
    vacancyBand: p.vacancyBand,
    applicantsUsed: p.applicantCount,
    applicantQuota: p.applicantQuota ?? 0,
  }));
  const activeVacancies = postings.filter((p) => p.status === "open").length;
  return capacitySchema.parse({
    payerId,
    activeVacancies,
    activeVacancyAllowance: baselineActiveVacancyAllowance() ?? 0,
    applicantQuotaTotal: rows.reduce((sum, r) => sum + r.applicantQuota, 0),
    applicantQuotaUsed: rows.reduce((sum, r) => sum + r.applicantsUsed, 0),
    postings: rows,
  });
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
