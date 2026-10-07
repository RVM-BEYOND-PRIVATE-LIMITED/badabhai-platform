/**
 * Typed payer-API errors, dependency-free so both the server-only transport and
 * the Server Actions (and their node-env tests) can share them without pulling
 * `server-only` into a test import graph.
 */

/** One field issue from a validation 400 — `{ path, message }`, never the value. */
export interface ApiFieldIssue {
  /** The offending field path, e.g. `role_title` or `requirements.0`. */
  path: string;
  /** A static, field-naming reason. Never echoes the offending content. */
  message: string;
}

/**
 * A 400 the API refused with per-field `issues`. The message keeps the transport's
 * historic `payer API <path> returned 400` shape so existing `/returned 400/`
 * handlers still match; `issues` is the new, additive payload a form maps to
 * inline field errors.
 *
 * SAFE TO SURFACE: the backend builds every message from a FIELD NAME and a fixed
 * reason (see `screenWorkerVisibleText`), never from the refused value — so echoing
 * it back to the payer is not the leak the refusal just prevented.
 */
export class PayerValidationError extends Error {
  readonly issues: readonly ApiFieldIssue[];

  constructor(path: string, issues: readonly ApiFieldIssue[]) {
    super(`payer API ${path} returned 400`);
    this.name = "PayerValidationError";
    this.issues = issues;
  }
}

export function isPayerValidationError(e: unknown): e is PayerValidationError {
  return e instanceof PayerValidationError;
}

/**
 * A 409 the API refused with, other than a price mismatch. The message keeps the transport's
 * historic `payer API <path> returned 409` shape, so every existing `/returned 409/` handler
 * still matches. `detail` is the API's own message, kept so a seam can tell two 409s on one
 * route apart (the quota top-up's in-flight duplicate vs no active plan). It is never rendered.
 */
export class PayerConflictError extends Error {
  readonly detail: string | null;

  constructor(path: string, detail: string | null) {
    super(`payer API ${path} returned 409`);
    this.name = "PayerConflictError";
    this.detail = detail;
  }
}

/**
 * A 409 `price_mismatch` (#2085): the `expected_price_inr` the payer confirmed is not the price
 * the purchase would be charged, so the API refused BEFORE any write or event. Nothing was bought.
 *
 * Its message is deliberately NOT `returned 409`: the purchase seams already read a bare 409 as
 * "a duplicate is still in flight" or "no active plan", and a price change must never be mistaken
 * for either. `currentPriceInr` is the API's current price, or null when the body did not carry
 * a usable one.
 */
export class PriceMismatchError extends Error {
  readonly currentPriceInr: number | null;

  constructor(path: string, currentPriceInr: number | null) {
    super(`payer API ${path} refused the confirmed price (price_mismatch)`);
    this.name = "PriceMismatchError";
    this.currentPriceInr = currentPriceInr;
  }
}
