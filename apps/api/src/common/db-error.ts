/**
 * Strip bound parameters off a Drizzle query error before it can reach a log.
 *
 * THE HAZARD, VERBATIM FROM THE DRIVER. `drizzle-orm`'s `DrizzleQueryError` builds its message as
 * `` `Failed query: ${query}\nparams: ${params}` `` (drizzle-orm/errors: the constructor
 * stringifies the whole params array). Bound parameters ARE the row being written, so any driver
 * rejection on an insert — pool exhaustion, a statement timeout, a deadlock, a constraint, or the
 * apply-before-deploy window where the table does not exist yet — produces an Error whose
 * `.message`, and therefore whose `.stack`, contains the values verbatim. `AllExceptionsFilter`
 * logs `exception.stack` for every 5xx. Nothing between the two redacts anything.
 *
 * For most tables that is merely noisy. For `worker_feedback.message` it is a §3 Privacy First
 * violation on the one column the platform deliberately allows to hold a worker's own PII: their
 * name, their phone number, their employer, in their own words, landing in the log aggregator
 * outside the RLS lockout and outside the audited admin surface — and in the unmigrated-deploy
 * case, for every submission from every worker.
 *
 * WHAT SURVIVES: the SQL text, the driver's own error `code` (23505, 42P01, 22P02 …) and the
 * cause chain. That is what an operator actually debugs with; the parameter VALUES are the part
 * they must not have. Nothing here changes control flow — the call still fails, with the same
 * shape, at the same place.
 *
 * DUCK-TYPED, NOT `instanceof`. `DrizzleQueryError` is not on drizzle's public export surface, so
 * matching the shape keeps this working across a version bump instead of silently falling through
 * to the un-redacted path — which would fail open, in a redaction helper.
 */
export class RedactedQueryError extends Error {
  /** The driver's SQLSTATE where the underlying error carried one, for the log line. */
  readonly code?: string;

  constructor(operation: string, query: string, code: string | undefined, cause: unknown) {
    super(
      `Failed query during ${operation}` +
        `${code ? ` (code ${code})` : ""}: ${query}; ` +
        `bound parameters redacted — they carry row data`,
    );
    this.name = "RedactedQueryError";
    this.code = code;
    this.cause = cause;
  }
}

/** A Drizzle query error, matched structurally rather than by class identity. */
function isQueryError(err: unknown): err is Error & { query: string; params: unknown[] } {
  return (
    err instanceof Error &&
    typeof (err as { query?: unknown }).query === "string" &&
    Array.isArray((err as { params?: unknown }).params)
  );
}

/**
 * Return `err` with any bound parameters removed. Anything that is not a parameter-carrying query
 * error is returned UNCHANGED — a `NotFoundException` or a programming error must keep its own
 * message and its own HTTP mapping, so this never blanket-wraps.
 *
 * `operation` is a short, PII-free label for the log ("worker feedback insert").
 */
export function redactQueryParams(err: unknown, operation: string): unknown {
  if (!isQueryError(err)) return err;
  const cause = (err as { cause?: unknown }).cause;
  const code =
    cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
      ? (cause as { code: string }).code
      : undefined;
  // The cause is kept for its code and its own stack; a postgres-js error does not embed the
  // parameter values in its message the way the drizzle wrapper does.
  return new RedactedQueryError(operation, err.query, code, cause);
}
