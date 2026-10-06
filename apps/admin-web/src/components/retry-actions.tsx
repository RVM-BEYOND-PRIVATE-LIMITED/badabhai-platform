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
 * outage can look the same. A page that does tell a 400 apart shows {@link FirstPageAction}
 * alone in its refusal state: repeating a request the server has refused cannot succeed.
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
      {cursor ? <FirstPageLink href={href} /> : null}
    </div>
  );
}

/**
 * "Back to the first page", alone — for a REFUSED read (a 400), and for a page past the first
 * that came back empty. Rendered only when there is a cursor to drop; with none, the address
 * already IS the first page and the link would go nowhere.
 *
 * `href` is the current query without the cursor, so every filter is kept: going back widens
 * nothing. `cursor` is required (it may be undefined) so a caller cannot forget to pass it.
 */
export function FirstPageAction({ href, cursor }: { href: string; cursor: string | undefined }) {
  if (!cursor) return null;
  return (
    <div className="state__actions">
      <FirstPageLink href={href} />
    </div>
  );
}

/**
 * The bare "Back to the first page" link, for a state that lays it out beside an action of its
 * own. Prefer {@link FirstPageAction}, which also decides whether there is a page to go back from.
 */
export function FirstPageLink({ href }: { href: string }) {
  return (
    <Link className="btn btn--ghost" href={href}>
      <Icon name="arrow-line-left" />
      Back to the first page
    </Link>
  );
}

/**
 * A refused read of an UNFILTERED list: the page cursor is the only thing in the address to
 * refuse, so the copy names it rather than telling the operator to fix filters that are not
 * set. Shared by the lists whose refusal copy otherwise talks about their own filter values.
 */
export const CURSOR_REFUSAL = {
  title: "The server rejected this page",
  body: "Nothing was fetched. A page cursor is an opaque value from the server — it cannot be hand-edited, and one copied from another list or an older read is not accepted — so start again from the first page.",
} as const;
