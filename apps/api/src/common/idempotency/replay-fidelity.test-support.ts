import { AllExceptionsFilter } from "../filters/all-exceptions.filter";

/**
 * Test support for idempotency REPLAY FIDELITY (#2103): what a client actually receives as the
 * `error` member of the response body for a thrown exception, rendered through the REAL global
 * {@link AllExceptionsFilter}. Comparing this for a first attempt and its replay is the honest
 * "identical body" check — it is the wire shape, not an exception class or a message string.
 */
export function renderedError(err: unknown): unknown {
  return renderedBody(err).error;
}

/**
 * The WHOLE response body the global filter sends for a thrown exception — the envelope
 * (`statusCode`, `error`, `requestId`, `path`, `timestamp`) and all. `requestId` is `req-test`
 * and `path` is the `path` given (default `/test`), so an assertion can name them exactly.
 */
export function renderedBody(err: unknown, path = "/test"): Record<string, unknown> {
  let sent: Record<string, unknown> = {};
  const res = {
    status: () => res,
    json: (body: Record<string, unknown>) => {
      sent = body;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ requestId: "req-test", url: path, method: "POST" }),
    }),
  };
  new AllExceptionsFilter().catch(err, host as never);
  return sent;
}

/** Resolve to the error a promise rejects with; fail loudly if it resolves instead. */
export async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}
