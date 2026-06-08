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
export * from "./server";
// Public config is re-exported for convenience in backend code, but frontends
// should import the dedicated "@badabhai/config/public" entry point.
export { publicEnvSchema, loadPublicConfig, type PublicConfig } from "./public";
