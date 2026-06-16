"use server";

import {
  getPayerCredits,
  purchaseCredits,
  updatePricingCatalog,
  type ActiveCatalog,
  type PricingChange,
} from "@/lib/api";
import { isUuid } from "@/lib/pricing-view";

/**
 * Server Actions for the ops Pricing screen (ADR-0013).
 *
 * SECURITY — two distinct surfaces:
 *  1. Pricing catalog (`PUT /pricing/catalog`) is PUBLIC (no guard, no secret). It
 *     is wired through a server action only for ergonomics (single submit path);
 *     no INTERNAL_SERVICE_TOKEN is involved here.
 *  2. Payer credits (`GET`/`POST /payers/:id/credits`) are behind the API's
 *     `InternalServiceGuard`. The shared `INTERNAL_SERVICE_TOKEN` is attached
 *     server-side by `apiGetInternal` / `apiPostInternal` (read from `process.env`,
 *     NEVER `NEXT_PUBLIC_*`). These actions run ONLY on the server (`"use server"`),
 *     so the secret never reaches the browser bundle. If the token is unset the
 *     guard fails closed (401) and the action returns its honest error state.
 *
 * NO-LOG: nothing in this path logs the payer_id, the balance, the top-up result,
 * or the raw API error — mirrors the PR2 unlock actions exactly.
 */

/** PII-free balance result handed to the client (or an honest error). */
export type CreditsActionResult =
  | { ok: true; balance: number }
  | { ok: false; error: string };

/** Look up a payer's OWN credit balance. */
export async function fetchPayerCreditsAction(
  payerId: string,
): Promise<CreditsActionResult> {
  if (!isUuid(payerId)) {
    return { ok: false, error: "Enter a valid payer id (UUID)." };
  }
  try {
    const credits = await getPayerCredits(payerId.trim());
    return { ok: true, balance: credits.balance };
  } catch {
    // Do NOT surface the raw error (could hint at guard/secret state). Honest,
    // generic message only — and nothing is logged.
    return {
      ok: false,
      error: "Could not load the payer balance (backend or service token).",
    };
  }
}

/** Mock top-up result handed to the client (or an honest error). */
export type TopUpActionResult =
  | { ok: true; balance: number; credits: number; packCode: string }
  | { ok: false; error: string };

/**
 * MOCK credit-pack top-up (ALPHA — NO REAL MONEY). Grants the pack's credits and
 * returns the new balance. An unknown pack_code → an honest error (the API 404s).
 */
export async function topUpCreditsAction(input: {
  payerId: string;
  packCode: string;
}): Promise<TopUpActionResult> {
  if (!isUuid(input.payerId)) {
    return { ok: false, error: "Enter a valid payer id (UUID) first." };
  }
  if (!input.packCode.trim()) {
    return { ok: false, error: "Pick a credit pack." };
  }
  try {
    const result = await purchaseCredits(input.payerId.trim(), input.packCode.trim());
    return {
      ok: true,
      balance: result.balance,
      credits: result.credits,
      packCode: result.pack_code,
    };
  } catch {
    // Generic honest message — covers an unknown pack (404), a missing token (401),
    // or a backend outage. Nothing logged.
    return {
      ok: false,
      error: "Top-up failed (unknown pack, backend unavailable, or service token).",
    };
  }
}

/** Result of a catalog publish — the new active catalog, or the server's message. */
export type UpdateCatalogActionResult =
  | { ok: true; active: ActiveCatalog }
  | { ok: false; error: string };

/**
 * Publish a new catalog revision. The PARSED catalog object is passed straight to
 * the public `PUT /pricing/catalog`. On an invalid catalog the server returns a
 * 400 whose message is surfaced VERBATIM (the invalid catalog is never stored).
 */
export async function updateCatalogAction(input: {
  updatedBy: string;
  catalog: unknown;
  change: PricingChange;
}): Promise<UpdateCatalogActionResult> {
  if (!isUuid(input.updatedBy)) {
    return { ok: false, error: "Enter a valid updated_by ops-actor id (UUID)." };
  }
  try {
    const active = await updatePricingCatalog({
      updated_by: input.updatedBy.trim(),
      catalog: input.catalog,
      change: input.change,
    });
    return { ok: true, active };
  } catch (err) {
    // Surface the server's own validation message (the 400) VERBATIM.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
