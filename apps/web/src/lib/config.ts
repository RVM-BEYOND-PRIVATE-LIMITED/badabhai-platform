import { loadPublicConfig } from "@badabhai/config/public";

/**
 * Browser-safe config. Uses ONLY the public (`NEXT_PUBLIC_*`) env entry point,
 * so the web app never depends on — and can never crash because of — a missing
 * backend secret.
 */
export const publicConfig = loadPublicConfig();
