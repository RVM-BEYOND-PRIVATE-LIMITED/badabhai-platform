import { AllExceptionsFilter } from "../filters/all-exceptions.filter";

/**
 * Test support for idempotency REPLAY FIDELITY (#2103): what a client actually receives as the
 * `error` member of the response body for a thrown exception, rendered through the REAL global
 * {@link AllExceptionsFilter}. Comparing this for a first attempt and its replay is the honest
 * "identical body" check — it is the wire shape, not an exception class or a message string.
 */
export function renderedError(err: unknown): unknown {
  let sent: { error?: unknown } | undefined;
  const res = {
    status: () => res,
    json: (body: { error?: unknown }) => {
      sent = body;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ requestId: "req-test", url: "/test", method: "POST" }),
    }),
  };
  new AllExceptionsFilter().catch(err, host as never);
  return sent?.error;
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
