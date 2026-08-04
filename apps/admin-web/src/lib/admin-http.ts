import "server-only";
import type { z } from "zod";
import { adminServerConfig } from "./server-config";
import { readAdminToken } from "./auth/session-cookie";

/**
 * SERVER-ONLY HTTP transport to the admin-authed NestJS routes (ADR-0025).
 *
 * SECURITY:
 *  - The admin JWT is read from the httpOnly cookie and sent as `Authorization: Bearer`.
 *    It NEVER touches the client bundle — there is no browser-side admin fetch anywhere.
 *  - The identity is the SESSION. This transport never sends a client-supplied admin id;
 *    the backend derives the actor from `req.admin.id` (the "never trust a body id" rule
 *    the payer surface already holds).
 *  - Every response is parsed with a Zod schema, so a shape change surfaces as an honest
 *    error state instead of `undefined` rendering as a blank screen.
 */

/** The session is gone (expired, revoked, or never existed). Callers redirect to /login. */
export class AdminUnauthorizedError extends Error {
  constructor() {
    super("admin session expired or missing");
    this.name = "AdminUnauthorizedError";
  }
}

/** The session is valid but lacks the capability the route requires. */
export class AdminForbiddenError extends Error {
  constructor() {
    super("this admin role may not perform that action");
    this.name = "AdminForbiddenError";
  }
}

/** Anything else: 4xx we don't special-case, 5xx, network, or a schema mismatch. */
export class AdminRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminRequestError";
    this.status = status;
  }
}

export function isAdminUnauthorized(err: unknown): err is AdminUnauthorizedError {
  return err instanceof AdminUnauthorizedError;
}

export function isAdminForbidden(err: unknown): err is AdminForbiddenError {
  return err instanceof AdminForbiddenError;
}

interface RequestOptions<T> {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Zod schema the response is validated against. Omit for 204-style calls. */
  schema?: z.ZodType<T>;
  /** Skip the Authorization header — the three public admin-auth endpoints only. */
  public?: boolean;
  /** Next.js cache behaviour. Admin data is operational: never cache by default. */
  revalidate?: number;
}

/** How long to wait on the API before showing an honest timeout rather than hanging. */
const REQUEST_TIMEOUT_MS = 15_000;

export async function adminFetch<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
  const { apiBaseUrl } = adminServerConfig();
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  if (!opts.public) {
    const token = await readAdminToken();
    // No cookie at all is the ordinary logged-out case, not an error worth a round trip.
    if (!token) throw new AdminUnauthorizedError();
    headers.authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Operational data. A cached suspension state is a wrong answer, not a fast one.
      cache: opts.revalidate === undefined ? "no-store" : undefined,
      next: opts.revalidate === undefined ? undefined : { revalidate: opts.revalidate },
    });
  } catch {
    // Never surface the underlying message: it routinely contains the internal API origin.
    throw new AdminRequestError(0, "The admin API is unreachable.");
  }

  if (res.status === 401) throw new AdminUnauthorizedError();
  if (res.status === 403) throw new AdminForbiddenError();

  if (!res.ok) {
    throw new AdminRequestError(res.status, `The admin API returned ${res.status}.`);
  }

  if (!opts.schema) return undefined as T;

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new AdminRequestError(res.status, "The admin API returned a malformed response.");
  }

  const parsed = opts.schema.safeParse(json);
  if (!parsed.success) {
    // The Zod issue list can quote response values back at us; keep it out of the UI.
    throw new AdminRequestError(res.status, "The admin API returned an unexpected shape.");
  }
  return parsed.data;
}
