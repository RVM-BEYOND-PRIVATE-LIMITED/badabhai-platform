import Link from "next/link";
import { ACTION_ICON, Icon } from "@badabhai/icons";

/**
 * The way out of a failed read of a PAGED list — every one in the console renders this.
 *
 * One rule for the two recoveries, everywhere (docs/design/NAVIGATION.md):
 *   - "Retry" repeats EXACTLY the current query, its page cursor included — the operator lands
 *     back where the read failed, not on a page one that looks like a successful reload;
 *   - "Back to the first page" is the same query WITHOUT the cursor, offered only when there is
 *     one: a stale or hand-edited cursor is a failure "Retry" would only repeat.
 *
 * With a cursor present both are offered, because from a failed read a refused cursor and an
 * outage can look the same. (A page that does tell a 400 apart — AI calls, Feedback — shows
 * only "Back to the first page" in its refusal state.)
 *
 * `href` is the current query without the cursor; `cursor` is the page cursor, if any.
 */
export function RetryActions({ href, cursor }: { href: string; cursor?: string }) {
  const retryHref = cursor
    ? `${href}${href.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`
    : href;
  return (
    <div className="state__actions">
      <Link className="btn btn--ghost" href={retryHref}>
        <Icon name={ACTION_ICON.retry} />
        Retry
      </Link>
      {cursor ? (
        <Link className="btn btn--ghost" href={href}>
          <Icon name="arrow-line-left" />
          Back to the first page
        </Link>
      ) : null}
    </div>
  );
}
