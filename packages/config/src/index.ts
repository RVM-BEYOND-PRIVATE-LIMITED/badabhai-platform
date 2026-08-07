/**
 * @badabhai/config — typed environment validation.
 *
 * - Server (secret) config:  import from "@badabhai/config"
 * - Public (browser) config: import from "@badabhai/config/public"
 *
 * The split guarantees the frontend never imports backend secrets and cannot
 * crash because a server-only key is absent.
 */
export * from "./shared";
// Occupation-retrieval tuning: the calibration curve and decision thresholds. NOT env-derived —
// see the file header for why these must not vary per environment.
export * from "./occupation-tuning";
export * from "./server";
// Public config is re-exported for convenience in backend code, but frontends
// should import the dedicated "@badabhai/config/public" entry point.
export { publicEnvSchema, loadPublicConfig, type PublicConfig } from "./public";
