import { DEFAULT_CATALOG } from "@badabhai/pricing";
import type { CreditPack } from "./contracts";

/**
 * Pricing sourced FROM CONFIG ONLY (§HARD CONSTRAINTS — no invented/hardcoded
 * prices). Every figure here is read out of `@badabhai/pricing` `DEFAULT_CATALOG`
 * (the ADR-0013 config source); nothing is literal'd in this file.
 *
 * The real backend resolves price server-side at purchase via the pricing engine
 * (`GET /pricing/quote`). Phase 1 is mock + staging-only, so this reads the same
 * config the engine seeds from to RENDER the offer — the mock top-up still grants
 * by the config'd pack, never a client-supplied amount (XT5: server-side amount).
 */

/** The contact-unlock credit packs OFFERED for purchase — straight from the catalog. */
export function offeredCreditPacks(): CreditPack[] {
  const product = DEFAULT_CATALOG.products.find(
    (p) => p.kind === "credit_pack" && p.code === "contact_unlock",
  );
  if (!product || product.kind !== "credit_pack") return [];
  return product.tiers.map((t) => ({
    code: t.code,
    priceInr: t.priceInr,
    credits: t.credits,
  }));
}

/** Resolve one offered pack by code (mock top-up grants by THIS, never a client amount). */
export function findCreditPack(code: string): CreditPack | null {
  return offeredCreditPacks().find((p) => p.code === code) ?? null;
}

/**
 * The §3A per-unlock unit price, derived from the smallest offered pack's
 * ₹/credit ratio (config-derived, not hardcoded). Used only for display copy.
 */
export function unlockUnitPriceInr(): number | null {
  const packs = offeredCreditPacks();
  if (packs.length === 0) return null;
  const smallest = packs.reduce((a, b) => (a.credits <= b.credits ? a : b));
  return Math.round(smallest.priceInr / smallest.credits);
}

/**
 * Base job posting "free-through-launch" (§3A / ADR-0013 ESCALATION).
 *
 * The catalog cannot model ₹0 — `priceInrSchema = min(1)` rejects it — so "free"
 * is NOT a price. We surface it from THIS config FLAG (default true = free during
 * the launch phase), exactly as the §WHAT-TO-BUILD note requires: do NOT hardcode 0.
 * The paid posting tiers (standard/pro) remain in the catalog for post-launch; we
 * read them for transparency but the surface charges nothing while the flag is on.
 */
export function postingIsFreeThroughLaunch(): boolean {
  const flag = (process.env.PAYER_POSTING_FREE_THROUGH_LAUNCH ?? "true")
    .trim()
    .toLowerCase();
  return flag !== "false";
}

/** The post-launch paid posting tiers (for transparency copy only). Config-sourced. */
export function postingPaidTiers(): { code: string; priceInr: number; validityDays: number }[] {
  const product = DEFAULT_CATALOG.products.find(
    (p) => p.kind === "posting" && p.code === "job_posting",
  );
  if (!product || product.kind !== "posting") return [];
  return product.tiers.map((t) => ({
    code: t.code,
    priceInr: t.priceInr,
    validityDays: t.validityDays,
  }));
}
