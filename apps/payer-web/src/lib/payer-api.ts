import "server-only";
import { requirePayer } from "./auth";
import {
  applicantFeedSchema,
  dashboardSchema,
  maskedResumeResultSchema,
  topUpResultSchema,
  unlockResultSchema,
  type ApplicantFeed,
  type CreatePostingInput,
  type Dashboard,
  type MaskedResumeResult,
  type PostingSummary,
  type TopUpResult,
  type UnlockResult,
} from "./contracts";
import * as store from "./mock-store";
import { findCreditPack } from "./pricing-config";

/**
 * The PAYER DATA SEAM (ADR-0019 Phase 1 — mock + staging-only).
 *
 * Every function here is the SINGLE boundary the pages/actions call. Each one:
 *  1. resolves the payer from the SERVER-HELD session (`requirePayer`) — the
 *     payerId is NEVER a client param (XB-A: an action is bound to the caller's
 *     own payer_id; a payer can never act on another's id);
 *  2. reads/writes only that payer's rows via the mock store's payer-scoped API;
 *  3. validates the result against the Zod contract (invariant #7, no `any`).
 *
 * SWAP TO REAL API: replace each store call with a `PayerAuthGuard`-scoped fetch
 * (Bearer payer JWT). The contract is already the wire shape, so callers don't
 * change. Until then, server-side calls to the existing `InternalServiceGuard`
 * endpoints (if ever used) MUST pass the session payerId, never a client value.
 */

export async function getDashboard(): Promise<Dashboard> {
  const { payerId } = await requirePayer();
  return dashboardSchema.parse({
    credits: store.getBalance(payerId),
    postings: store.getPostings(payerId),
    unlocks: store.getUnlockHistory(payerId),
  });
}

export async function getPostings(): Promise<PostingSummary[]> {
  const { payerId } = await requirePayer();
  return store.getPostings(payerId).map((p) => p);
}

export async function createPosting(input: CreatePostingInput): Promise<PostingSummary> {
  const { payerId } = await requirePayer();
  // Free-through-launch: no charge here (the free flag is surfaced at the page).
  return store.createPosting(payerId, {
    roleTitle: input.roleTitle,
    locationLabel: input.locationLabel,
    vacancyBand: input.vacancyBand,
  });
}

/**
 * Faceless applicant feed for ONE of the payer's own postings. Returns null if the
 * posting is not the payer's — the caller renders a NEUTRAL not-found (no oracle on
 * existence). NO raw worker PII in the result (XB-C / invariant #2).
 */
export async function getApplicantFeed(postingId: string): Promise<ApplicantFeed | null> {
  const { payerId } = await requirePayer();
  const found = store.getApplicants(payerId, postingId);
  if (!found) return null;
  return applicantFeedSchema.parse({
    postingId,
    roleTitle: found.posting.roleTitle,
    applicants: found.applicants,
  });
}

/**
 * Spend a mock credit to unlock a candidate. Returns the granted record OR the
 * single neutral `{ status: "unavailable" }` — every deny cause (no credits,
 * already-unlocked, worker not in the payer's pool) collapses to ONE response
 * (XB-C / no-oracle). The worker must belong to one of the payer's postings; a
 * worker outside the payer's pool yields the SAME neutral body (no cross-tenant
 * existence oracle).
 */
export async function requestUnlock(input: {
  postingId: string;
  workerId: string;
}): Promise<UnlockResult> {
  const { payerId } = await requirePayer();
  // Tenant + pool check folded into the neutral path: not the payer's posting, or
  // the worker isn't in it ⇒ neutral unavailable (no distinguishable branch).
  const feed = store.getApplicants(payerId, input.postingId);
  const inPool = feed?.applicants.some((a) => a.workerId === input.workerId) ?? false;
  if (!feed || !inPool) {
    return unlockResultSchema.parse({ status: "unavailable" });
  }
  const granted = store.trySpendUnlock(payerId, input.workerId);
  if (!granted) return unlockResultSchema.parse({ status: "unavailable" });
  return unlockResultSchema.parse({
    ok: true,
    unlockId: granted.unlockId,
    status: "granted",
    expiresAt: granted.expiresAt,
  });
}

/**
 * Reveal the MASKED employer resume for a granted unlock (resume-disclosure
 * addendum / XB-E). Returns masked initials ("R***** K.") + a short-TTL signed
 * URL to the masked PDF + NO phone, or the single neutral body. The masked
 * initials here are MOCK-derived from the opaque worker id (no real name is ever
 * read client-side or in this app — the real masking happens server-side in the
 * backend `ResumeDisclosureService`, B-G).
 */
export async function revealMaskedResume(input: {
  unlockId: string;
}): Promise<MaskedResumeResult> {
  const { payerId } = await requirePayer();
  const unlock = store.findOwnedUnlock(payerId, input.unlockId);
  if (!unlock || unlock.status !== "granted") {
    return maskedResumeResultSchema.parse({ status: "unavailable" });
  }
  // MOCK masked artifact. Real backend renders the masked PDF from the name-free
  // snapshot; here we synthesise PII-free masked initials from the opaque id.
  const initials = mockMaskedInitials(unlock.workerId);
  return maskedResumeResultSchema.parse({
    ok: true,
    disclosureId: unlock.unlockId,
    status: "disclosed",
    displayInitials: initials,
    // A non-resolvable placeholder masked-PDF URL (mock). No phone, no name in it.
    resumeUrl: `https://staging.badabhai.example/masked-resume/${unlock.unlockId}.pdf`,
    expiresAt: unlock.expiresAt,
  });
}

/**
 * MOCK credit top-up (XT5 / E-R2 — MOCK ledger only, real_call:false). The pack is
 * resolved from CONFIG by code (never a client-supplied amount: server-side amount,
 * XT5); credits granted = the config'd pack's credits. Returns null for an unknown
 * pack (honest error, NOT the unlock no-oracle path).
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
 * Deterministic PII-FREE mock masked initials from an opaque id. Produces a shape
 * like "R***** K." — never a real name (there is none in this app). Used only to
 * demonstrate the masked-reveal surface honestly.
 */
function mockMaskedInitials(workerId: string): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const hex = workerId.replace(/-/g, "");
  const first = letters[parseInt(hex.slice(0, 2), 16) % 26]!;
  const last = letters[parseInt(hex.slice(2, 4), 16) % 26]!;
  return `${first}***** ${last}.`;
}
