/**
 * Typed payer-API errors, dependency-free so both the server-only transport and
 * the Server Actions (and their node-env tests) can share them without pulling
 * `server-only` into a test import graph.
 */

/**
 * A non-2xx answer from the payer API, with its HTTP status TYPED (`status`) — the transport's
 * class-only error (`payer-http.ts`). No body is carried: a deny reason is never surfaced
 * (no-oracle / no PII), so the status is all a seam may branch on.
 *
 * The message is the transport's historic `payer API <path> returned <status>` shape, byte for
 * byte, so anything that still reads the message (a log line, an older handler, a page that shows
 * it) is unchanged. A seam reads the status through {@link httpStatusOf} / {@link isPayerStatus},
 * never by matching the message.
 */
export class PayerHttpError extends Error {
  readonly status: number;
  /** The API path the request went to (no origin) — the same text the message names. */
  readonly path: string;

  constructor(path: string, status: number) {
    super(`payer API ${path} returned ${status}`);
    this.name = "PayerHttpError";
    this.path = path;
    this.status = status;
  }
}

/**
 * The transport's message shape, for an error built OUTSIDE it — a test's fake transport, or a
 * module instance other than this one (`instanceof` is per module instance). Anchored at both
 * ends and read from the END, so `returned 4000` is no status and `… returned 400 returned 500`
 * is a 500 — exactly what the old `endsWith(" returned 429")` checks read.
 */
const TRANSPORT_MESSAGE = /^payer API .+ returned (\d{3})$/;

/**
 * The HTTP status of a payer-API failure, or null when `e` is not one (a network error, a parse
 * failure, a {@link PriceMismatchError} — deliberately never read as a bare 409 — or the 401
 * session expiry, which has its own class).
 *
 * Reads a {@link PayerHttpError}'s typed `status`. An `Error` whose message is exactly the
 * transport's `payer API <path> returned <status>` shape counts too, so an error made elsewhere in
 * that shape (a test's fake transport) keeps working; nothing else does.
 */
export function httpStatusOf(e: unknown): number | null {
  if (e instanceof PayerHttpError) return e.status;
  if (!(e instanceof Error)) return null;
  const match = TRANSPORT_MESSAGE.exec(e.message);
  return match ? Number(match[1]) : null;
}

/** Did the payer API answer `status`? (See {@link httpStatusOf} for what counts.) */
export function isPayerStatus(e: unknown, status: number): boolean {
  return httpStatusOf(e) === status;
}

/** One field issue from a validation 400 — `{ path, message }`, never the value. */
export interface ApiFieldIssue {
  /** The offending field path, e.g. `role_title` or `requirements.0`. */
  path: string;
  /** A static, field-naming reason. Never echoes the offending content. */
  message: string;
}

/**
 * A 400 the API refused with per-field `issues`. A {@link PayerHttpError} (status 400, the
 * transport's historic `payer API <path> returned 400` message), so every 400 check still
 * matches it; `issues` is the additive payload a form maps to inline field errors.
 *
 * SAFE TO SURFACE: the backend builds every message from a FIELD NAME and a fixed
 * reason (see `screenWorkerVisibleText`), never from the refused value — so echoing
 * it back to the payer is not the leak the refusal just prevented.
 */
export class PayerValidationError extends PayerHttpError {
  readonly issues: readonly ApiFieldIssue[];

  constructor(path: string, issues: readonly ApiFieldIssue[]) {
    super(path, 400);
    this.name = "PayerValidationError";
    this.issues = issues;
  }
}

export class PayerForbiddenError extends Error {
  constructor(path: string) {
    super(`payer API ${path} returned 403`);
    this.name = "PayerForbiddenError";
  }
}

export function isPayerForbiddenError(e: unknown): e is PayerForbiddenError {
  return e instanceof PayerForbiddenError;
}

export function isPayerValidationError(e: unknown): e is PayerValidationError {
  return e instanceof PayerValidationError;
}

/**
 * A 409 the API refused with, other than a price mismatch. A {@link PayerHttpError} (status 409,
 * the transport's historic `payer API <path> returned 409` message), so every 409 check still
 * matches it. Neither field is ever rendered:
 *  - `reason` is the API's machine-readable reason (#2135: `in_flight` on every purchase route,
 *    `no_active_plan` on the quota top-up), or null when the body names none — every 409 from an
 *    API before #2135. A seam decides on it when present.
 *  - `detail` is the API's own message — the fallback a seam reads to tell two 409s on one route
 *    apart (the quota top-up's in-flight duplicate vs no active plan) when `reason` is null.
 */
export class PayerConflictError extends PayerHttpError {
  readonly detail: string | null;
  readonly reason: string | null;

  constructor(path: string, detail: string | null, reason: string | null = null) {
    super(path, 409);
    this.name = "PayerConflictError";
    this.detail = detail;
    this.reason = reason;
  }
}

/**
 * The catalog option the payer confirmed is gone, or no longer what the dialog described (e.g.
 * ops re-sized or removed the quota top-up tier between the confirm and the submit). Raised
 * BEFORE any purchase request, so nothing was bought. The seam never substitutes another option.
 */
export class PurchaseOptionChangedError extends Error {
  constructor() {
    super("the confirmed purchase option changed");
    this.name = "PurchaseOptionChangedError";
  }
}

/**
 * A 409 `price_mismatch` (#2085): the `expected_price_inr` the payer confirmed is not the price
 * the purchase would be charged, so the API refused BEFORE any write or event. Nothing was bought.
 *
 * Deliberately NOT a {@link PayerHttpError}, and its message is NOT `returned 409`: the purchase
 * seams read a bare 409 as "a duplicate is still in flight" or "no active plan", and a price change
 * must never be mistaken for either — so {@link httpStatusOf} reads no status from it.
 * `currentPriceInr` is the API's current price, or null when the body did not carry a usable one.
 */
export class PriceMismatchError extends Error {
  readonly currentPriceInr: number | null;

  constructor(path: string, currentPriceInr: number | null) {
    super(`payer API ${path} refused the confirmed price (price_mismatch)`);
    this.name = "PriceMismatchError";
    this.currentPriceInr = currentPriceInr;
  }
}

/**
 * A 429 from the payer API: a per-payer hourly cap (the reach bucket, the disclosure bucket …)
 * or the same cap failing closed while Redis is down — one status for both, and no reason in the
 * body (the transport never surfaces one). Read from the transport's typed status
 * ({@link isPayerStatus}), so a page can say "too many requests" instead of "failed".
 */
export function isPayerRateLimited(e: unknown): boolean {
  return isPayerStatus(e, 429);
}

/**
 * A 400 from the payer API — the server refused what the request carried. Both of the
 * transport's 400 shapes count: a {@link PayerValidationError} (the pipe named the field) and a
 * class-only {@link PayerHttpError} 400 (a body with no readable issues). Read from the typed
 * status, as {@link isPayerRateLimited} reads a 429, so a page can tell a refusal apart from an
 * outage: repeating a refused request cannot succeed, so it never offers Retry.
 */
export function isPayerBadRequest(e: unknown): boolean {
  return isPayerStatus(e, 400);
}
