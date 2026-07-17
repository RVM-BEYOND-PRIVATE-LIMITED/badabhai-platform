import type { Product } from "@badabhai/pricing";
import type { CreditPack } from "./contracts";
import { VACANCY_BANDS, type VacancyBand } from "./contracts";

/**
 * Pricing sourced FROM CONFIG ONLY (§HARD CONSTRAINTS — no invented/hardcoded
 * prices). Every reader here is a PURE function over the catalog `products` the
 * caller passes in — since D-6 that is the LIVE catalog from the API
 * (`lib/live-catalog.ts` → `GET /payer/pricing/catalog`), with the compile-time
 * `DEFAULT_CATALOG` only as its documented fetch-failure fallback. Nothing is
 * literal'd in this file, and nothing here reads `DEFAULT_CATALOG` directly any
 * more — an ops price edit reaches the portal WITHOUT a rebuild.
 *
 * The real backend still resolves every price server-side at purchase via the
 * pricing engine (`GET /pricing/quote` / the plan-boost stream) — these readers
 * RENDER the offer; the mock top-up still grants by the config'd pack, never a
 * client-supplied amount (XT5: server-side amount).
 */

/** The contact-unlock credit packs OFFERED for purchase — straight from the catalog. */
export function offeredCreditPacks(products: readonly Product[]): CreditPack[] {
  const product = products.find((p) => p.kind === "credit_pack" && p.code === "contact_unlock");
  if (!product || product.kind !== "credit_pack") return [];
  return product.tiers.map((t) => ({
    code: t.code,
    priceInr: t.priceInr,
    credits: t.credits,
  }));
}

/** Resolve one offered pack by code (mock top-up grants by THIS, never a client amount). */
export function findCreditPack(products: readonly Product[], code: string): CreditPack | null {
  return offeredCreditPacks(products).find((p) => p.code === code) ?? null;
}

/**
 * The §3A per-unlock unit price, derived from the smallest offered pack's
 * ₹/credit ratio (config-derived, not hardcoded). Used only for display copy.
 */
export function unlockUnitPriceInr(products: readonly Product[]): number | null {
  const packs = offeredCreditPacks(products);
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

/** The post-launch paid posting tiers (for transparency copy only). Config-sourced. */
export function postingPaidTiers(
  products: readonly Product[],
): { code: string; priceInr: number; validityDays: number }[] {
  const product = products.find((p) => p.kind === "posting" && p.code === "job_posting");
  if (!product || product.kind !== "posting") return [];
  return product.tiers.map((t) => ({
    code: t.code,
    priceInr: t.priceInr,
    validityDays: t.validityDays,
  }));
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
 * the SMALLEST tier, straight from config (no literal code/price/amount here). The
 * LIVE `POST /payer/job-postings/:id/quota-topup` body carries ONLY this tier CODE;
 * the backend re-resolves price + grant through the pricing engine (XT5: the client
 * can never supply an amount). Returns null if the catalog has no top-up tiers.
 */
export function quotaTopUpTier(
  products: readonly Product[],
): { code: string; priceInr: number; additionalViews: number } | null {
  const product = products.find((p) => p.kind === "quota_topup" && p.code === "quota_topup");
  if (!product || product.kind !== "quota_topup") return null;
  const smallest = [...product.tiers].sort(
    (a, b) => a.additionalVisibilityQuota - b.additionalVisibilityQuota,
  )[0];
  return smallest
    ? {
        code: smallest.code,
        priceInr: smallest.priceInr,
        additionalViews: smallest.additionalVisibilityQuota,
      }
    : null;
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

/** The ascending hiring-capacity tiers from the catalog (allowance + price). */
export function hiringCapacityTiers(products: readonly Product[]): {
  code: string;
  priceInr: number;
  maxActiveVacancies: number;
}[] {
  const product = products.find((p) => p.kind === "capacity" && p.code === "hiring_capacity");
  if (!product || product.kind !== "capacity") return [];
  return product.tiers
    .map((t) => ({ code: t.code, priceInr: t.priceInr, maxActiveVacancies: t.maxActiveVacancies }))
    .sort((a, b) => a.maxActiveVacancies - b.maxActiveVacancies);
}

/** The baseline concurrent active-vacancy allowance (smallest capacity tier). */
export function baselineActiveVacancyAllowance(products: readonly Product[]): number | null {
  const tiers = hiringCapacityTiers(products);
  return tiers.length > 0 ? tiers[0]!.maxActiveVacancies : null;
}

/* ── Low-balance nudge threshold (config, never hardcoded in the page) ────────────
 *
 * The credits page shows a proactive "you're running low" nudge when the balance falls
 * BELOW this threshold (credits). It lives HERE (the config module), env-overridable via
 * `PAYER_LOW_BALANCE_THRESHOLD`, exactly like {@link postingIsFreeThroughLaunch} — the page
 * never hardcodes a magic number. The default below is the config default, not a page literal.
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
