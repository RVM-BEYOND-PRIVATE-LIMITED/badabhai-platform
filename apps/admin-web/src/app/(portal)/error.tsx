"use client";

import { ACTION_ICON, Icon } from "@badabhai/icons";
import { FallbackHeader } from "../../components/fallback-header";

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
 * DS: the shared page header (title, one sentence), then the `.state state--error` block with
 * the recovery action in `.state__actions`, labelled "Retry" like every other retry in the
 * console. The state itself draws no glyph — the recovery action carries its own.
 */
export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="page">
      <FallbackHeader
        title="Something went wrong"
        description="This screen could not be loaded, which usually means the admin API is unreachable or returned an unexpected response."
      />
      {/* The alert region speaks for itself: assistive tech announces its text on its own, so
          it opens with what happened rather than relying on the header above it. */}
      <div className="state state--error" role="alert">
        <p className="state__body">
          This screen failed to load. That does not mean your session ended. Retry; if it keeps
          failing, quote the reference below when you report it.
        </p>
        {error.digest && (
          <p className="field__help">
            Reference: <code>{error.digest}</code>
          </p>
        )}
        <div className="state__actions">
          <button className="btn btn--primary" type="button" onClick={reset}>
            <Icon name={ACTION_ICON.retry} />
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}
