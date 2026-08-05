import "server-only";

/**
 * SERVER-side config for the admin portal.
 *
 * `apiBaseUrl` is deliberately NOT a `NEXT_PUBLIC_*` value: the browser must never learn
 * the internal API origin, and no admin request is ever made from the client — every call
 * goes through a server action or a server component using {@link adminFetch}.
 */
export interface AdminServerConfig {
  apiBaseUrl: string;
  environment: string;
}

export function adminServerConfig(): AdminServerConfig {
  const apiBaseUrl = (process.env.ADMIN_API_BASE_URL ?? "http://localhost:3001").replace(
    /\/+$/,
    "",
  );
  return {
    apiBaseUrl,
    environment: (process.env.NEXT_PUBLIC_ENVIRONMENT ?? process.env.NODE_ENV ?? "development")
      .trim()
      .toLowerCase(),
  };
}
