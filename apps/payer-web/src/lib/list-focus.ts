/**
 * AFTER PAGING, FOCUS GOES TO THE LIST'S HEADING (#2588).
 *
 * "Next page" sits under the last card. Once the next page rendered, focus stayed down there (or
 * fell back to the page), so a keyboard or screen-reader user had to find their own way back up to
 * the first new card. Now a pager link, when activated, asks for the move and names the address it
 * opens; the list heading drawn on that address takes it (components/paged-list.tsx). Only on that
 * address: a request whose page drew no list (an outage, the end of the list) never moves focus
 * somewhere else later. One request at a time — the newest wins.
 *
 * Browser-only state: written from a click handler, read from a ref callback, never on the server.
 */

let requested: string | null = null;

/** A pager link was activated: when the list at `href` is drawn, its heading takes focus. */
export function requestListFocus(href: string): void {
  requested = normalAddress(href);
}

/** Does the heading drawn at `address` take focus? True once per request, and only for its address. */
export function takeListFocus(address: string): boolean {
  if (requested === null || requested !== normalAddress(address)) return false;
  requested = null;
  return true;
}

/** Path and query, the query's keys sorted — "?a=1&b=2" and "?b=2&a=1" are one address. */
function normalAddress(href: string): string {
  const url = new URL(href, "http://portal.invalid");
  url.searchParams.sort();
  return `${url.pathname}?${url.searchParams.toString()}`;
}
