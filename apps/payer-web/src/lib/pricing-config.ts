import type { Product } from "@badabhai/pricing";
import type { CreditPack } from "./contracts";
import { VACANCY_BANDS, type VacancyBand } from "./contracts";

/**
 * Pricing sourced FROM CONFIG ONLY (§HARD CONSTRAINTS — no invented/hardcoded
 * prices). Every reader here is a PURE function over the catalog the caller passes
 * in — since D-6 that is the LIVE catalog from the API (`lib/live-catalog.ts` →
 * `GET /payer/pricing/catalog`), with the compile-time `DEFAULT_CATALOG` only as its
 * documented fetch-failure fallback. Nothing is literal'd in this file, and nothing
 * here reads `DEFAULT_CATALOG` directly any more — an ops price edit reaches the
 * portal WITHOUT a rebuild.
 *
 * SHOWN == CHARGED (#2085). Every price a reader returns is the price a purchase of that
 * tier is CHARGED — the catalog's `prices[]` (computed by the same function every purchase
 * route charges through, so it already carries any active offer). That is the number a tile,
 * a trigger and a confirm show, and the number a purchase sends back as `expected_price_inr`.
 * The server still resolves the charge itself; it uses that number only to refuse a purchase
 * whose price changed since the payer saw it (409 `price_mismatch`).
 */

/** One tier's effective charge price, as `GET /payer/pricing/catalog` reports it (`prices[]`, #2085). */
export interface TierPrice {
  readonly productCode: string;
  readonly tierCode: string;
  /** The catalog list price. */
  readonly basePriceInr: number;
  /** What a purchase of the tier is charged now, without a coupon (after any active offer). */
  readonly priceInr: number;
  readonly discountInr: number;
  /** The automatic offer the charge applies right now, or null. */
  readonly offer: { readonly code: string; readonly endsAt: string } | null;
}

/**
 * The catalog every price reader takes. `prices` null/absent means the API sent no `prices[]`
 * (an API older than #2085, or the cached-pricing fallback): each tier then shows its catalog
 * price, which is what such an API charges.
 */
export interface PricedCatalog {
  readonly products: readonly Product[];
  readonly prices?: readonly TierPrice[] | null;
}

/** A tier's price as the payer sees and confirms it. */
export interface ChargedPrice {
  /** What a purchase is charged — the ONE number shown on a trigger/confirm and sent back. */
  priceInr: number;
  /** The catalog list price, present ONLY when an active offer lowers the charge below it. */
  listPriceInr?: number;
  /**
   * When the offer that lowered the charge ENDS — the row's `offer.ends_at`, present only beside
   * {@link listPriceInr} and only when the API named an offer (#2102).
   *
   * A struck list price says the charge is below the catalog's; this says how long it stays
   * there, so a payer deciding on an offer price is not deciding against an unstated deadline.
   * A row priced below list with NO named `offer` keeps the struck figure and says nothing —
   * an expiry is never guessed, and this is the only date the catalog authorizes (`priced_at`
   * is provenance, not a promise: live-catalog.ts validates it and surfaces nothing).
   */
  offerEndsAt?: string;
}

/**
 * The price a purchase of `tier` is charged. With `prices[]` present the tier's row is the
 * answer, and a tier the API did not price is NOT ON OFFER (null) — the portal never invents a
 * price. With no `prices[]` at all, the tier's catalog price is the answer.
 */
export function chargedPrice(
  catalog: PricedCatalog,
  productCode: string,
  tier: { code: string; priceInr: number },
): ChargedPrice | null {
  const prices = catalog.prices;
  if (prices === undefined || prices === null) return { priceInr: tier.priceInr };
  const row = prices.find((p) => p.productCode === productCode && p.tierCode === tier.code);
  if (!row) return null;
  if (row.priceInr >= row.basePriceInr) return { priceInr: row.priceInr };
  // Below list ⇒ the list price rides along to be struck. The DEADLINE rides along only when the
  // API NAMED the offer (#2102): a discount with no `offer` row has no end date to state, and
  // inventing one would put a date on the tile the charge does not honour.
  return row.offer === null
    ? { priceInr: row.priceInr, listPriceInr: row.basePriceInr }
    : { priceInr: row.priceInr, listPriceInr: row.basePriceInr, offerEndsAt: row.offer.endsAt };
}

/** The contact-unlock credit packs OFFERED for purchase, at the price each is charged. */
export function offeredCreditPacks(catalog: PricedCatalog): CreditPack[] {
  const product = catalog.products.find(
    (p) => p.kind === "credit_pack" && p.code === "contact_unlock",
  );
  if (!product || product.kind !== "credit_pack") return [];
  return product.tiers.flatMap((t) => {
    const price = chargedPrice(catalog, product.code, t);
    return price === null ? [] : [{ code: t.code, ...price, credits: t.credits }];
  });
}

/** Resolve one offered pack by code (mock top-up grants by THIS, never a client amount). */
export function findCreditPack(catalog: PricedCatalog, code: string): CreditPack | null {
  return offeredCreditPacks(catalog).find((p) => p.code === code) ?? null;
}

/**
 * The §3A per-unlock unit price, derived from the smallest offered pack's
 * ₹/credit ratio (config-derived, not hardcoded). Used only for display copy.
 */
export function unlockUnitPriceInr(catalog: PricedCatalog): number | null {
  const packs = offeredCreditPacks(catalog);
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
  const flag = (process.env.PAYER_POSTING_FREE_THROUGH_LAUNCH ?? "true").trim().toLowerCase();
  return flag !== "false";
}

/** The post-launch paid posting tiers (for transparency copy only), at their charge price. */
export function postingPaidTiers(
  catalog: PricedCatalog,
): ({ code: string; validityDays: number } & ChargedPrice)[] {
  const product = catalog.products.find((p) => p.kind === "posting" && p.code === "job_posting");
  if (!product || product.kind !== "posting") return [];
  return product.tiers.flatMap((t) => {
    const price = chargedPrice(catalog, product.code, t);
    return price === null ? [] : [{ code: t.code, ...price, validityDays: t.validityDays }];
  });
}

/* ── Applicant-quota config (job management + capacity) ──────────────────────────
 *
 * Applicant quota per posting is "view more → pay more" (catalog posting tiers'
 * `applicantVisibilityQuota`). The base quota a fresh posting starts with is the
 * SMALLEST posting tier's quota; a TOP-UP raises it by the same config step. The
 * vacancy band only scales the BASE allowance (a bigger hire warrants seeing more
 * candidates) — every number below is read from the catalog, NONE is hardcoded.
 */

/** The ascending applicant-quota steps from the catalog posting tiers (e.g. [10, 30]). */
function applicantQuotaSteps(products: readonly Product[]): number[] {
  const product = products.find((p) => p.kind === "posting" && p.code === "job_posting");
  if (!product || product.kind !== "posting") return [];
  return product.tiers.map((t) => t.applicantVisibilityQuota).sort((a, b) => a - b);
}

/** The smallest config'd applicant-quota step — the increment one TOP-UP grants. */
export function applicantQuotaStep(products: readonly Product[]): number | null {
  const steps = applicantQuotaSteps(products);
  return steps.length > 0 ? steps[0]! : null;
}

/**
 * The catalog `quota_topup` TIER one top-up purchases (B2 "view more → pay more") —
 * the SMALLEST priced tier, straight from config (no literal code/price/amount here),
 * at the price it is charged. The LIVE `POST /payer/job-postings/:id/quota-topup` body
 * carries this tier CODE and the price the payer confirmed; the backend re-resolves
 * price + grant through the pricing engine (XT5) and refuses a changed price (#2085).
 * Returns null if the catalog has no priced top-up tier.
 */
export function quotaTopUpTier(catalog: PricedCatalog): QuotaTopUpTier | null {
  return quotaTopUpTiers(catalog)[0] ?? null;
}

/** One priced quota top-up tier: its code, the slots it adds, and the price it is charged. */
export type QuotaTopUpTier = { code: string; additionalViews: number } & ChargedPrice;

/**
 * The catalog `quota_topup` tier with `code`, at its charge price — or null when it is not on
 * offer (absent, or unpriced in a present `prices[]`). The top-up seam checks the tier the payer
 * CONFIRMED against the live catalog through this, rather than re-picking one (#2085 L1).
 */
export function findQuotaTopUpTier(catalog: PricedCatalog, code: string): QuotaTopUpTier | null {
  return quotaTopUpTiers(catalog).find((t) => t.code === code) ?? null;
}

/** Every priced `quota_topup` tier, smallest grant first. */
function quotaTopUpTiers(catalog: PricedCatalog): QuotaTopUpTier[] {
  const product = catalog.products.find(
    (p) => p.kind === "quota_topup" && p.code === "quota_topup",
  );
  if (!product || product.kind !== "quota_topup") return [];
  return product.tiers
    .flatMap((t) => {
      const price = chargedPrice(catalog, product.code, t);
      return price === null
        ? []
        : [{ code: t.code, ...price, additionalViews: t.additionalVisibilityQuota }];
    })
    .sort((a, b) => a.additionalViews - b.additionalViews);
}

/**
 * The BASE applicant quota a posting in a given vacancy band starts with. Derived
 * from the config quota STEP (the caller resolves it from the live catalog via
 * {@link applicantQuotaStep} — a server page passes it as a prop, so this stays
 * CLIENT-SAFE: no catalog fetch, no catalog import) scaled by the band's index
 * (band 0 → smallest step, higher bands → proportionally more). Config-driven: no
 * literal quota in pages. Returns null when the catalog carried no posting-quota
 * tiers (step null — fail-closed display).
 */
export function baseApplicantQuotaForBand(
  band: VacancyBand,
  quotaStep: number | null,
): number | null {
  if (quotaStep === null) return null;
  const bandIndex = VACANCY_BANDS.indexOf(band);
  const multiplier = bandIndex < 0 ? 1 : bandIndex + 1;
  return quotaStep * multiplier;
}

/**
 * Derive the FRONTEND vacancy band from a raw head count, for LOCAL applicant-quota
 * stamping ONLY (it feeds {@link baseApplicantQuotaForBand}). The frontend band-set
 * (`VACANCY_BANDS` = 1-5 / 6-20 / 21-50 / 50+) is DISTINCT from the backend's
 * (`@badabhai/types`: 1 / 2-5 / 6-10 / 11-25 / 25+), so this band is NEVER sent to the
 * API — the live POST /payer/job-postings receives the raw `vacancies` and derives its
 * OWN band server-side (`bandForCount`). Boundaries: n<=5 → "1-5", n<=20 → "6-20",
 * n<=50 → "21-50", n>50 → "50+". A non-positive-integer fails closed to the smallest band.
 */
export function bandForVacancies(count: number): VacancyBand {
  if (!Number.isInteger(count) || count < 1) return VACANCY_BANDS[0]; // fail-closed to smallest
  if (count <= 5) return "1-5";
  if (count <= 20) return "6-20";
  if (count <= 50) return "21-50";
  return "50+";
}

/* ── Hiring-capacity config (capacity view) ──────────────────────────────────────
 *
 * The per-payer concurrent active-vacancy allowance (ADR-0016 capacity tiers). The
 * BASELINE allowance (with no capacity pack bought) is the smallest tier's
 * `maxActiveVacancies` — config-driven, never a hardcoded headcount.
 */

/** The ascending hiring-capacity tiers on offer (allowance + the price each is charged). */
export function hiringCapacityTiers(
  catalog: PricedCatalog,
): ({ code: string; maxActiveVacancies: number } & ChargedPrice)[] {
  const product = catalog.products.find(
    (p) => p.kind === "capacity" && p.code === "hiring_capacity",
  );
  if (!product || product.kind !== "capacity") return [];
  return product.tiers
    .flatMap((t) => {
      const price = chargedPrice(catalog, product.code, t);
      return price === null
        ? []
        : [{ code: t.code, ...price, maxActiveVacancies: t.maxActiveVacancies }];
    })
    .sort((a, b) => a.maxActiveVacancies - b.maxActiveVacancies);
}

/** The baseline concurrent active-vacancy allowance (smallest capacity tier). */
export function baselineActiveVacancyAllowance(products: readonly Product[]): number | null {
  const product = products.find((p) => p.kind === "capacity" && p.code === "hiring_capacity");
  if (!product || product.kind !== "capacity" || product.tiers.length === 0) return null;
  return Math.min(...product.tiers.map((t) => t.maxActiveVacancies));
}

/* ── Low-balance nudge threshold (config, never hardcoded in the page) ────────────
 *
 * The credits page shows a proactive "you're running low" nudge when the balance falls
 * BELOW this threshold (credits). It lives HERE (the config module), env-overridable via
 * `PAYER_LOW_BALANCE_THRESHOLD`, exactly like {@link postingIsFreeThroughLaunch} — the page
 * never hardcodes a magic number. The default below is the config default, not a page literal.
 * It is the ONE low-balance number: the dashboard's "Only N credits left" item (and its "Buy
 * credits") reads it too, so the two pages never disagree about "low" (N7).
 */
const DEFAULT_LOW_BALANCE_THRESHOLD = 5;

/** The credits-balance threshold below which the low-balance nudge shows (config-driven). */
export function lowBalanceThreshold(): number {
  const raw = (process.env.PAYER_LOW_BALANCE_THRESHOLD ?? "").trim();
  if (raw !== "") {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return DEFAULT_LOW_BALANCE_THRESHOLD;
}

/* ── Credit validity window (config, never hardcoded in the page) ─────────────────
 *
 * How long PURCHASED credits remain spendable after a top-up — the "use them within N
 * months" expiry shown on the credits page. This is DISTINCT from the catalog credit-pack
 * `windowDays` (the per-UNLOCK contact-access window, 14d, types.ts) — that governs how long
 * a granted unlock's routed relay stays valid, NOT how long unused credits last. There is no
 * catalog field for credit validity, so it is a config param here (env-overridable), default
 * 12 months. The page reads it from here — it never hardcodes the number.
 */
const DEFAULT_CREDIT_VALIDITY_MONTHS = 12;

/** Months after purchase that unused credits remain spendable (config-driven, default 12). */
export function creditValidityMonths(): number {
  const raw = (process.env.PAYER_CREDIT_VALIDITY_MONTHS ?? "").trim();
  if (raw !== "") {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_CREDIT_VALIDITY_MONTHS;
}
