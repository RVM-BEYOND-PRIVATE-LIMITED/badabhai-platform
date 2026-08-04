"use client";

/**
 * Portal error boundary.
 *
 * Shows that something failed and offers a retry — and deliberately does NOT render
 * `error.message`. Errors from the transport layer are already scrubbed
 * (`admin-http.ts` never surfaces the API origin or a provider response), but an
 * unexpected error from anywhere else could carry an internal detail, and this screen is
 * the one place it would be printed verbatim. Next's digest is enough to correlate with
 * the server log.
 */
export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="state" role="alert">
      <h1 className="state__title">Something went wrong</h1>
      <p className="state__body">
        This screen could not be loaded. That usually means the admin API is unreachable or
        returned an unexpected response — it does not mean your session ended.
      </p>
      {error.digest && (
        <p className="field__help">
          Reference: <code>{error.digest}</code>
        </p>
      )}
      <button className="btn btn--primary" type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
