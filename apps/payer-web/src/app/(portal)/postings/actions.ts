"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import {
  closePosting,
  pausePosting,
  resumePosting,
  topUpPostingQuota,
  PurchaseConflictError,
  QuotaTopUpNoPlanError,
} from "../../../lib/payer-api";
import { PriceMismatchError, PurchaseOptionChangedError } from "../../../lib/payer-errors";
import {
  PRICE_UNREADABLE_MESSAGE,
  readExpectedPrice,
  type PriceChangedResult,
} from "../../../lib/price-confirmation";
import type { PostingSummary } from "../../../lib/contracts";

/**
 * Job-management Server Actions (ADR-0019 Phase 1 — LIVE).
 *
 * Every action binds to the SERVER-HELD session payer (XB-A) inside the data seam —
 * the client supplies the posting id (and, for the top-up purchase, the price the payer
 * confirmed and the purchase's idempotency key — #2085), never a payer id. All four lifecycle routes
 * are the payer-authed `POST /payer/job-postings/:id/{pause|resume|quota-topup|close}`
 * (#178/#180): a posting that isn't the caller's returns the SAME neutral not-found
 * (no cross-tenant existence oracle), and a backend failure surfaces as an error —
 * never as fake data (the mock store is gone from this surface).
 */

export type PostingActionResult =
  | { ok: true; posting: PostingSummary }
  | { ok: false; error: string };

const postingIdSchema = z.string().uuid();

function parseId(postingId: string): { ok: true } | { ok: false; error: string } {
  return postingIdSchema.safeParse(postingId).success
    ? { ok: true }
    : { ok: false, error: "That posting could not be found." };
}

export async function pausePostingAction(input: {
  postingId: string;
}): Promise<PostingActionResult> {
  const valid = parseId(input.postingId);
  if (!valid.ok) return valid;
  try {
    const posting = await pausePosting({ postingId: input.postingId });
    if (!posting) return { ok: false, error: "That posting could not be found." };
    revalidatePath("/postings");
    return { ok: true, posting };
  } catch {
    // 409 (not open) and every transport failure collapse to ONE retryable message.
    return { ok: false, error: "Could not pause the posting right now. Please retry." };
  }
}

export async function resumePostingAction(input: {
  postingId: string;
}): Promise<PostingActionResult> {
  const valid = parseId(input.postingId);
  if (!valid.ok) return valid;
  try {
    const posting = await resumePosting({ postingId: input.postingId });
    if (!posting) return { ok: false, error: "That posting could not be found." };
    revalidatePath("/postings");
    return { ok: true, posting };
  } catch {
    return { ok: false, error: "Could not resume the posting right now. Please retry." };
  }
}

/** Quota top-up result: success carries a NOTICE (the paid effect is otherwise invisible
 * on the faceless row) and the fresh posting when the re-read succeeded. */
export type TopUpQuotaActionResult =
  | { ok: true; posting: PostingSummary | null; notice: string }
  // A 409 DUPLICATE-IN-FLIGHT of this purchase's Idempotency-Key (#2085, as capacity #1185):
  // the first attempt is still running and may still throw — NOT done, NOT failed. Non-terminal.
  | { ok: false; pending: true }
  // A 409 `price_mismatch` (#2085): the confirmed price is not the price now — nothing bought.
  | PriceChangedResult
  // The confirmed tier is gone or no longer what the dialog described (#2085 L1) — nothing bought.
  | { ok: false; optionChanged: true }
  | { ok: false; error: string };

/**
 * The tier the payer confirmed (#2085 L1): its catalog code and the slots the dialog said it adds.
 * Required — the seam checks it against the live catalog and never picks one itself.
 */
const confirmedTierSchema = z.object({
  code: z.string().min(1).max(64),
  additionalViews: z.number().int().positive(),
});

/**
 * The per-purchase idempotency key (#2085) — a client-minted `crypto.randomUUID()`, validated
 * here (invariant #7) exactly as the capacity and credits actions do: a malformed key is
 * DROPPED (the call degrades to the no-key behaviour) rather than forwarded as a junk header.
 */
const idempotencyKeySchema = z.string().uuid();

/**
 * Add applicant slots to one of the caller's OWN postings — a purchase (#180). The client sends
 * the posting id, the tier and price the payer confirmed in the dialog (#2085) and the purchase's
 * idempotency key; the seam buys THAT tier or nothing, and the server prices it (XT5).
 */
export async function topUpQuotaAction(input: {
  postingId: string;
  /** The tier the payer confirmed in the dialog (#2085 L1). */
  tier: { code: string; additionalViews: number };
  /** The ₹ the payer confirmed in the dialog (#2085). */
  expectedPriceInr?: number;
  /** One key per confirmed purchase, reused by its retries (#2085). */
  idempotencyKey?: string;
}): Promise<TopUpQuotaActionResult> {
  const valid = parseId(input.postingId);
  if (!valid.ok) return valid;
  // A missing or malformed tier is refused like a changed one: never sent, never guessed.
  const tier = confirmedTierSchema.safeParse(input.tier);
  if (!tier.success) return { ok: false, optionChanged: true };
  const confirmed = readExpectedPrice(input.expectedPriceInr);
  if (!confirmed.ok) return { ok: false, error: PRICE_UNREADABLE_MESSAGE };
  const idempotencyKey =
    input.idempotencyKey && idempotencyKeySchema.safeParse(input.idempotencyKey).success
      ? input.idempotencyKey
      : undefined;
  try {
    const outcome = await topUpPostingQuota({
      postingId: input.postingId,
      tier: tier.data,
      expectedPriceInr: confirmed.value,
      idempotencyKey,
    });
    if (!outcome) return { ok: false, error: "That posting could not be found." };
    revalidatePath("/postings");
    // The charge is committed — say what it bought. A failed fresh-row re-read is NOT a
    // failure (never invite a retry that would double-purchase); tell the user to refresh.
    const notice =
      outcome.posting !== null
        ? `Applicant slots added — ${outcome.addedViews} more applicant views.`
        : `Applicant slots added (${outcome.addedViews} more applicant views) — refresh to see it.`;
    return { ok: true, posting: outcome.posting, notice };
  } catch (e) {
    // #2085 — the price changed since the payer confirmed it. Nothing was bought. Re-render the
    // page so the new price is what the row's button and dialog show; never retried here.
    if (e instanceof PriceMismatchError) {
      revalidatePath("/postings");
      return { ok: false, priceChanged: true, currentPriceInr: e.currentPriceInr };
    }
    // #2085 L1 — the confirmed tier changed under the payer. Nothing was sent; re-render so the
    // current option is what the row offers, and let the payer confirm THAT.
    if (e instanceof PurchaseOptionChangedError) {
      revalidatePath("/postings");
      return { ok: false, optionChanged: true };
    }
    // The same confirmed purchase is still in flight: never re-post, never claim it is done.
    if (e instanceof PurchaseConflictError) {
      revalidatePath("/postings");
      return { ok: false, pending: true };
    }
    // The ONE distinguishable business deny (409, no active plan): actionable copy.
    // Not an existence oracle — the neutral not-found above already covered ownership.
    if (e instanceof QuotaTopUpNoPlanError) {
      return { ok: false, error: "This posting has no active plan yet — buy a plan first." };
    }
    return { ok: false, error: "Could not add applicant slots right now. Please retry." };
  }
}

/** Close one of the caller's OWN postings (terminal; LIVE). Same neutrality contract. */
export async function closePostingAction(input: {
  postingId: string;
}): Promise<PostingActionResult> {
  const valid = parseId(input.postingId);
  if (!valid.ok) return valid;
  try {
    const posting = await closePosting(input.postingId);
    if (!posting) return { ok: false, error: "That posting could not be found." };
    revalidatePath("/postings");
    return { ok: true, posting };
  } catch {
    return { ok: false, error: "Could not close the posting right now. Please retry." };
  }
}
