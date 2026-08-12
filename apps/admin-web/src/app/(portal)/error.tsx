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
 *
 * The digest is NOT a backend string: it is the opaque hash Next mints for this render, so
 * printing it hands an operator a correlation key without handing them the failure text.
 *
 * DS: the shared `.state state--error` block with the recovery action in `.state__actions`.
 * No icon — admin-web ships no icon font, so the title and body carry the whole meaning.
 */
export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="state state--error" role="alert">
      <h1 className="state__title">Something went wrong</h1>
      <p className="state__body">
        This screen could not be loaded. That usually means the admin API is unreachable or
        returned an unexpected response — it does not mean your session ended. Retry; if it
        keeps failing, quote the reference below when you report it.
      </p>
      {error.digest && (
        <p className="field__help">
          Reference: <code>{error.digest}</code>
        </p>
      )}
      <div className="state__actions">
        <button className="btn btn--primary" type="button" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
