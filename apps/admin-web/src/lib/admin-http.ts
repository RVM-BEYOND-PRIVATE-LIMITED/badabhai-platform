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
 *
 * ── ONE DEV-ONLY CAVEAT, MEASURED ───────────────────────────────────────────────────
 * Under `next dev`, Next serialises fetch `Response` objects into the RSC flight payload
 * for its dev overlay — including the request's `Authorization` header. So the admin JWT
 * and the internal API origin ARE visible in dev-server HTML. Verified against a
 * production build (`next build && next start`): **zero occurrences of either**.
 *
 * Recorded because the difference matters twice over: nobody should panic at a dev
 * screenshot, and — more importantly — nobody should wave away a REAL leak later on the
 * assumption that "it's just the dev thing". Assert against a production build.
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
  /**
   * The raw `error` object from `AllExceptionsFilter`'s envelope, when the body parsed as one.
   * Every existing caller reads only `.message`/`.status`; this is additive for the one route
   * whose 4xx body carries more than a message — the skill-discovery decision conflict, which
   * needs `conflict` / `current_status` / `expected_status` to render the right recovery copy
   * rather than a generic refusal. `undefined` on every degraded body (HTML, empty, non-object),
   * so a caller can never mistake "no body parsed" for "an empty object was returned".
   */
  readonly body?: Record<string, unknown>;
  constructor(status: number, message: string, body?: Record<string, unknown>) {
    super(message);
    this.name = "AdminRequestError";
    this.status = status;
    this.body = body;
  }
}

export function isAdminUnauthorized(err: unknown): err is AdminUnauthorizedError {
  return err instanceof AdminUnauthorizedError;
}

export function isAdminForbidden(err: unknown): err is AdminForbiddenError {
  return err instanceof AdminForbiddenError;
}

/**
 * Narrow to the status-carrying error, so a page can distinguish "no such record" (404,
 * and 400 for a malformed id) from a genuine server fault. Without this every failure is
 * indistinguishable and a mistyped id in a URL renders the error boundary instead of the
 * not-found screen.
 */
export function isAdminRequestError(err: unknown): err is AdminRequestError {
  return err instanceof AdminRequestError;
}

/**
 * The longest backend explanation shown verbatim. Beyond this it is TRUNCATED, never dropped:
 * the first sentence of a refusal is the useful part, and silently swallowing a long message
 * would leave the operator with "the admin API returned 409" and nothing to act on.
 */
const MAX_ERROR_MESSAGE_CHARS = 300;

function capErrorMessage(message: string): string {
  if (message.length <= MAX_ERROR_MESSAGE_CHARS) return message;
  return `${message.slice(0, MAX_ERROR_MESSAGE_CHARS - 1).trimEnd()}…`;
}

/**
 * Pull the backend's own explanation out of `AllExceptionsFilter`'s error envelope
 * (`{ error: { message } }` — see apps/api/src/common/filters/all-exceptions.filter.ts) when
 * there is one to pull. Falls back to the generic status-only text on any shape mismatch or
 * unparseable body, so a change to the filter's envelope degrades to today's copy rather than
 * throwing.
 *
 * This is the ONLY place a response body's text is read for an error case, and it is read,
 * not trusted for display everywhere: the portal's own error boundary
 * (`(portal)/error.tsx`) explicitly never renders `.message`, and the public login flows
 * (`login/actions.ts`) ignore it entirely in favour of their own neutral, oracle-free copy.
 * The governed-mutation Server Actions (companies/agencies, jobs, workers, admins) are the
 * one place that DOES show it, because a 4xx from a route behind
 * `AdminAuthGuard`/`AdminRolesGuard` is the server explaining a REFUSAL to an operator who is
 * already authenticated and capable — not an oracle for an anonymous caller.
 *
 * ── ONE SHAPE IS DELIBERATELY NOT ACCEPTED: `{ "error": "<string>" }` ────────────────────
 * The BadaBhai API cannot produce it. `AllExceptionsFilter` always writes an OBJECT
 * (`error: typeof payload === "string" ? { message: payload } : payload`), so a bare string
 * under `error` can only have come from something that is NOT this platform's API — an
 * ingress, a service mesh, or a gateway error page sitting in front of it. Those are exactly
 * the bodies that carry internal topology ("no healthy upstream for cluster admin-api…",
 * upstream hostnames, pod IPs), and on a 4xx this string was rendered verbatim to the
 * operator. It now falls through to the status-only text: an intermediary's error page is
 * never the server explaining a refusal, so there is nothing there worth showing.
 */
interface ErrorEnvelope {
  message: string;
  /** The `error` object itself, when the body parsed as one — see `AdminRequestError.body`. */
  body: Record<string, unknown> | undefined;
}

async function describeErrorBody(res: Response): Promise<ErrorEnvelope> {
  const fallback = `The admin API returned ${res.status}.`;
  try {
    // A non-JSON body (an HTML 404 from a proxy, an empty body) rejects here → fallback.
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null || !("error" in body)) {
      return { message: fallback, body: undefined };
    }
    const inner = (body as { error: unknown }).error;
    if (typeof inner !== "object" || inner === null) {
      return { message: fallback, body: undefined };
    }
    const record = inner as Record<string, unknown>;
    const message =
      "message" in record &&
      typeof record.message === "string" &&
      record.message.length > 0
        ? capErrorMessage(record.message)
        : fallback;
    return { message, body: record };
  } catch {
    return { message: fallback, body: undefined };
  }
}

interface RequestOptions<T> {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /**
   * Zod schema the response is validated against. Omit for 204-style calls.
   *
   * INPUT IS `unknown`, DELIBERATELY, and it is what makes `T` the schema's OUTPUT type.
   * `z.ZodType<T>` is shorthand for `ZodType<T, ZodTypeDef, T>` — input and output pinned to the
   * same type — so any schema whose parse CHANGES the shape (a `.default()`, a `.catch()`, a
   * `.transform()`) made TypeScript infer `T` from the INPUT side and hand the caller a type with
   * the pre-parse optionality still on it. The value being parsed here is a JSON body, which is
   * `unknown` by definition, so this is also simply the honest signature.
   */
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>;
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
    const { message, body } = await describeErrorBody(res);
    throw new AdminRequestError(res.status, message, body);
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
