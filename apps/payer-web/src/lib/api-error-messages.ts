/**
 * Shared API-error copy (#2688).
 *
 * Every payer-web surface maps an API error CODE or HTTP STATUS to words here — never rendering
 * the server's own message, a status code, an exception string or a stack trace. A screen that
 * receives a code it does not know gets a calm generic line, never the raw input. The domain
 * catalogues (postings, agency, credits, candidates) extend {@link ErrorCatalogue}.
 */

/** The safe line for an unknown code, status or malformed failure. */
export const SAFE_ERROR_MESSAGE = "Something went wrong. Please try again.";

/** A failed call because the browser is offline (or the request never left). */
export const OFFLINE_ERROR_MESSAGE = "You're offline. We'll retry when you're back.";

/** A call that could not reach BadaBhai for any transport reason. */
export const NETWORK_ERROR_MESSAGE = "Couldn't reach BadaBhai. Please retry.";

/** A rate/usage cap — never names the limit or the remaining count. */
export const RATE_LIMITED_ERROR_MESSAGE =
  "Too many attempts. Please wait a moment and try again.";

/** A 5xx — retryable, no internal detail. */
export const SERVER_ERROR_MESSAGE = "The server had a problem. Please try again in a moment.";

/** A 401/expired session. */
export const SESSION_EXPIRED_ERROR_MESSAGE = "Your session expired. Please sign in again.";

/** A 403 — this account may not use the surface; retrying is pointless. */
export const FORBIDDEN_ERROR_MESSAGE = "This isn't available for your account.";

/** A 404 — neutral, no existence oracle. */
export const NOT_FOUND_ERROR_MESSAGE = "We couldn't find that. Please refresh and try again.";

/** A 400/validation refusal whose fields the form already explains. */
export const VALIDATION_ERROR_MESSAGE = "Check the highlighted fields and try again.";

/** A 409 with no more specific meaning. */
export const CONFLICT_ERROR_MESSAGE = "This changed elsewhere. Refresh and try again.";

export interface ErrorCatalogue {
  /** Machine-readable reason/code → human copy. Keys are lower-case (`price_mismatch`). */
  readonly codes: Readonly<Record<string, string>>;
  /** HTTP status → human copy. */
  readonly statuses: Readonly<Record<number, string>>;
  /** The last resort for an unknown code or raw failure. */
  readonly fallback: string;
}

/** Codes that are technically machine identifiers but are part of our own vocabulary. */
function normalizeCode(text: string): string {
  return text.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function statusOf(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (/^[1-5]\d\d$/.test(t)) return Number(t);
  const match = t.match(/^(?:http\s*)?(?:status|error|code)[\s:#-]*([1-5]\d\d)$/);
  return match ? Number(match[1]) : null;
}

/** Anything that looks like a raw server/exception payload rather than a sentence we wrote. */
function looksRaw(text: string): boolean {
  const t = text.trim();
  if (t === "") return true;
  if (/^[{[]/.test(t) || /<\/?[a-z][\s\S]*>/i.test(t)) return true;
  if (/\b(?:TypeError|ReferenceError|SyntaxError|RangeError|Error):/.test(t)) return true;
  if (/^\s*at\s+\S+.*\(.*:\d+:\d+\)\s*$/m.test(t)) return true;
  if (
    /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|INTERNAL SERVER ERROR|STACK TRACE|REQUEST FAILED WITH STATUS)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  // A lone machine token (`PRICE_MISMATCH`, `some_unknown_code`, `500`) is never shown.
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/i.test(t) && !t.includes(" ")) return true;
  return false;
}

function isHumanSentence(text: string): boolean {
  return /\s/.test(text) && /^[A-Z0-9“"'(]/.test(text);
}

/**
 * Resolve an API failure (a code, a status, an exception string, or already-catalogued copy) to a
 * line that is safe to show. Never returns raw server text for an unknown machine code.
 */
export function messageFor(input: unknown, catalogue: ErrorCatalogue): string {
  const fallback = catalogue.fallback || SAFE_ERROR_MESSAGE;

  if (input === null || input === undefined) return fallback;
  if (typeof input === "number") {
    return catalogue.statuses[input] ?? (input >= 500 ? SERVER_ERROR_MESSAGE : fallback);
  }

  const text = String(input).trim();
  if (text === "") return fallback;

  const direct = catalogue.codes[text] ?? catalogue.codes[normalizeCode(text)];
  if (direct !== undefined) return direct;

  const status = statusOf(text);
  if (status !== null) return catalogue.statuses[status] ?? fallback;

  // Copy our own catalogues produce is always safe — including constants that live in a screen.
  if (Object.values(catalogue.codes).includes(text)) return text;
  if (looksRaw(text)) return fallback;
  if (isHumanSentence(text)) return text;
  return fallback;
}

/** Shared status lines every domain starts from. */
export const COMMON_STATUS_MESSAGES: Readonly<Record<number, string>> = {
  0: NETWORK_ERROR_MESSAGE,
  400: VALIDATION_ERROR_MESSAGE,
  401: SESSION_EXPIRED_ERROR_MESSAGE,
  403: FORBIDDEN_ERROR_MESSAGE,
  404: NOT_FOUND_ERROR_MESSAGE,
  409: CONFLICT_ERROR_MESSAGE,
  429: RATE_LIMITED_ERROR_MESSAGE,
  500: SERVER_ERROR_MESSAGE,
  502: SERVER_ERROR_MESSAGE,
  503: SERVER_ERROR_MESSAGE,
  504: SERVER_ERROR_MESSAGE,
};

/** Shared API failure codes every domain understands. */
export const COMMON_CODE_MESSAGES: Readonly<Record<string, string>> = {
  offline: OFFLINE_ERROR_MESSAGE,
  network_error: NETWORK_ERROR_MESSAGE,
  rate_limited: RATE_LIMITED_ERROR_MESSAGE,
  server_error: SERVER_ERROR_MESSAGE,
  internal_error: SERVER_ERROR_MESSAGE,
  unauthorized: SESSION_EXPIRED_ERROR_MESSAGE,
  forbidden: FORBIDDEN_ERROR_MESSAGE,
  not_found: NOT_FOUND_ERROR_MESSAGE,
  validation_failed: VALIDATION_ERROR_MESSAGE,
  bad_request: VALIDATION_ERROR_MESSAGE,
  conflict: CONFLICT_ERROR_MESSAGE,
};

export const withCommon = (
  codes: Readonly<Record<string, string>>,
  statuses: Readonly<Record<number, string>> = {},
  fallback: string = SAFE_ERROR_MESSAGE,
): ErrorCatalogue => ({
  codes: { ...COMMON_CODE_MESSAGES, ...codes },
  statuses: { ...COMMON_STATUS_MESSAGES, ...statuses },
  fallback,
});
