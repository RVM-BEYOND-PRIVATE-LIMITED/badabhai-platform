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
