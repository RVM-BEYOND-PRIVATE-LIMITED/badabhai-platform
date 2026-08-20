/**
 * The shared plumbing of a WRITE-SHAPED PROBE — a runner that performs the real statements it is
 * testing inside a transaction that cannot commit, then reports what each one did.
 *
 * ===========================================================================
 * WHY THIS IS ITS OWN MODULE
 * ===========================================================================
 * Extracted from `verify-unresolved-write.ts` when `verify-rls-lock.ts` needed the same four
 * pieces. They are not incidental helpers — each one exists because of a specific way the first
 * probe lied about its own results, and re-deriving them per probe is how a second runner
 * inherits the bugs the first one already paid for:
 *
 *   RollbackSignal   makes the rollback STRUCTURAL. The probe's last act is an unconditional
 *                    throw, so there is no `--apply`, no branch that skips it, and no path that
 *                    reaches COMMIT. A flag would be something an operator could forget.
 *   causeOf          drizzle's error `message` is the SQL TEXT. A constraint violation, a full
 *                    pooler and an aborted transaction all rendered identically until this
 *                    reached for the CAUSE and its SQLSTATE, and two of them were reported as
 *                    schema failures they were not.
 *   scalar           `noUncheckedIndexedAccess` turns an empty result into `undefined`, which
 *                    compares unequal to itself — a counting query that returned nothing became
 *                    a silent "the count changed". Throwing is the honest answer.
 *   formatResults    one aligned line per probe, so a failure is read rather than hunted for.
 *
 * Pure and dependency-free by design: everything here is unit-testable without a database, which
 * is the point — the parts that CAN be tested offline should never need one.
 */

/** One probe's verdict. */
export interface ProbeResult {
  /** Stable id, used in the report and in tests. */
  readonly id: string;
  /** What the probe must observe, in one line. */
  readonly expectation: string;
  readonly passed: boolean;
  /** Only on failure — what actually happened. */
  readonly detail?: string;
}

/**
 * Thrown as a probe transaction's last act to force the ROLLBACK, and caught immediately outside
 * it. Never escapes the runner.
 */
export class RollbackSignal extends Error {
  constructor(script: string) {
    super(`${script} — deliberate rollback`);
    this.name = "RollbackSignal";
  }
}

/**
 * The message that actually says what went wrong.
 *
 * Drizzle wraps every driver error in a `DrizzleQueryError` whose `message` is the SQL TEXT, so
 * reporting `e.message` prints the statement back at the reader and hides the reason. The cause
 * carries the Postgres message and its SQLSTATE.
 */
export function causeOf(e: unknown): string {
  const err = e as { message?: string; cause?: { message?: string; code?: string } };
  const cause = err?.cause?.message;
  if (cause) return err.cause?.code ? `${cause} [${err.cause.code}]` : cause;
  return (err?.message ?? String(e)).split("\n")[0] ?? String(e);
}

/**
 * The single row a scalar query returned.
 *
 * Throws rather than returning `undefined`: a query that yields no row means the probe cannot
 * make its claim, and reporting that as a passed or failed expectation would be a fabrication.
 */
export function scalar<T>(rows: readonly T[], what: string, script: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`[${script}] ${what} returned no row`);
  return row;
}

/** True when every probe passed. Pure, so the exit-code decision is testable. */
export function allPassed(results: readonly ProbeResult[]): boolean {
  return results.length > 0 && results.every((r) => r.passed);
}

/** One line per probe, aligned; a failing probe gets a second line with the reason. Pure. */
export function formatResults(results: readonly ProbeResult[]): string[] {
  const width = Math.max(0, ...results.map((r) => r.id.length));
  return results.flatMap((r) => {
    const head = `  ${r.passed ? "PASS" : "FAIL"}  ${r.id.padEnd(width)}  ${r.expectation}`;
    return r.detail === undefined ? [head] : [head, `        ${" ".repeat(width)}  -> ${r.detail}`];
  });
}
