import { loadPublicConfig } from "@badabhai/config/public";

/**
 * Browser-safe config for the external payer portal.
 *
 * SECURITY: uses ONLY the public (`NEXT_PUBLIC_*`) entry point, so the client
 * bundle never depends on a backend secret. Server-only config (the payer-auth
 * mode flag, the API base URL used server-side, the interim internal-service
 * token) is read straight from `process.env` inside Server Components / Route
 * Handlers / Server Actions — NEVER from this module.
 *
 * XB self-check: no server secret is exported here; the payer-auth seam config
 * (`server-config.ts`) is the only place `process.env` server-only keys are read.
 */
export const publicConfig = loadPublicConfig();
