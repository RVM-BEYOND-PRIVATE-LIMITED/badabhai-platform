/**
 * Re-exports the shared ₹ formatter (BL-10 — consolidated to `@badabhai/pricing` so
 * payer-web, admin-web, and apps/web render the same catalog identically instead of each
 * hand-rolling `₹${...}`). See `@badabhai/pricing`'s `formatInr` for the full contract.
 */
export { formatInr } from "@badabhai/pricing";
