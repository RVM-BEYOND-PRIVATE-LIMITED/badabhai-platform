/**
 * @badabhai/pricing — the config-driven Pricing Engine (ADR-0013 Decision A).
 *
 * The SINGLE source of truth for every price/tier/quota/window/discount/coupon.
 * Ops edit the catalog VALUES (DB rows, validated here); this package owns the
 * typed SHAPE + the deterministic, fail-closed resolve math. Pure, PII-free, no
 * LLM — the @badabhai/reach-engine discipline applied to money.
 *
 * Resume download is FREE and is NOT priced here (ADR-0013 §SIGN-OFF C).
 */
export * from "./types";
export { safeParseCatalog, parseCatalog, type CatalogLoadResult } from "./catalog";
export { DEFAULT_CATALOG } from "./defaults";
export {
  resolvePrice,
  type Quote,
  type Grants,
  type CouponUsage,
  type ResolveRequest,
  type ResolveResult,
} from "./resolve";
