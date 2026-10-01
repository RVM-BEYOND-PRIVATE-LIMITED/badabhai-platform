import Link from "next/link";
import { ACTION_ICON, Icon } from "@badabhai/icons";

/**
 * The way out of a failed read of an UNFILTERED list (a filtered one offers the results head's
 * "Clear filters" instead).
 *
 * One rule for the two recoveries, everywhere in the console (docs/design/NAVIGATION.md):
 *   - "Retry" repeats EXACTLY the current query, its page cursor included — the operator lands
 *     back where the read failed, not on a page one that looks like a successful reload;
 *   - "Back to the first page" drops the cursor, and is offered only when there is one. A
 *     hand-edited or stale cursor is a failure "Retry" would only repeat.
 *
 * These pages cannot tell a refused cursor from an outage (the read's error is not
 * distinguished), so with a cursor present both are offered.
 */
export function RetryActions({ basePath, cursor }: { basePath: string; cursor?: string }) {
  const retryHref = cursor ? `${basePath}?cursor=${encodeURIComponent(cursor)}` : basePath;
  return (
    <div className="state__actions">
      <Link className="btn btn--ghost" href={retryHref}>
        <Icon name={ACTION_ICON.retry} />
        Retry
      </Link>
      {cursor ? (
        <Link className="btn btn--ghost" href={basePath}>
          <Icon name="arrow-line-left" />
          Back to the first page
        </Link>
      ) : null}
    </div>
  );
}
